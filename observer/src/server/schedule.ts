/** Scheduling-timeline aggregation: one scheduling (caller) session and the
 * execution sessions it launched, on one shared time axis.
 *
 * Pure projection over data the hub already scans read-only:
 *   - every operation record of every allow-listed task (never lastOp only);
 *   - per-operation journal timestamps (operation-started / artifact-exported);
 *   - the caller session's verified lifecycle (turns + cross-turn receipts).
 *
 * Honesty rules (see docs/scheduling-timeline.md):
 *   - every time point is recorded evidence in Unix ms; missing stays null;
 *   - dispatch-turn binding is labelled recorded / inferred-by-create-time / none;
 *   - clock anomalies are flagged, never silently reordered;
 *   - attribution follows the FIRST operation's caller; later callers are
 *     reported per operation, they never move the task between groups.
 */

import type { CallerIdentity } from "@agent-lord/core/contracts";
import type {
  ScheduleGroup,
  ScheduleOperation,
  ScheduleResponse,
  ScheduleTask,
  ScheduleTurn,
  TaskMeta,
} from "../shared/types.js";
import type { OperationRecord } from "./scan.js";
import type { CallerLifecycleReader, SessionTimeline } from "./caller-lifecycle.js";
import type { CallerSessionReader } from "./caller-session.js";

/** Journal-observed per-operation timestamps (control-plane evidence). */
export interface OpJournalTimes {
  startedAtMs: number | null;
  artifactExportedAtMs: number | null;
}

export interface ScheduleTaskInput {
  meta: TaskMeta;
  operations: OperationRecord[];
  opTimes: Map<string, OpJournalTimes>;
}

const TERMINAL = new Set(["succeeded", "failed", "needs_decision"]);

function ms(value: string | null | undefined): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function bindDispatchTurn(
  recordedTurnId: string | null,
  createdAtMs: number | null,
  turns: ScheduleTurn[],
): Pick<ScheduleOperation, "dispatchTurnId" | "dispatchBinding"> {
  if (recordedTurnId) return { dispatchTurnId: recordedTurnId, dispatchBinding: "recorded" };
  if (createdAtMs !== null) {
    const candidate = turns
      .filter((turn) => turn.startedAtMs <= createdAtMs && (turn.completedAtMs === null || createdAtMs <= turn.completedAtMs))
      .at(-1);
    if (candidate) return { dispatchTurnId: candidate.turnId, dispatchBinding: "inferred-by-create-time" };
  }
  return { dispatchTurnId: null, dispatchBinding: "none" };
}

function projectOperation(
  operation: OperationRecord,
  times: OpJournalTimes | undefined,
  session: SessionTimeline,
): ScheduleOperation {
  const createdAtMs = ms(operation.createdAt);
  const completedAtMs = ms(operation.completedAt);
  const artifactExportedAtMs = times?.artifactExportedAtMs ?? null;
  const hasArtifact = Boolean(operation.artifact);
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    trigger: operation.invocation?.trigger ?? "unspecified",
    callerSessionId: operation.invocation?.caller.session_id ?? null,
    ...bindDispatchTurn(operation.invocation?.caller.turn_id ?? null, createdAtMs, session.turns),
    createdAtMs,
    executorStartedAtMs: times?.startedAtMs ?? null,
    completedAtMs,
    providerCompletedAtMs: operation.providerCompletedAtMs,
    artifactExportedAtMs,
    artifactReadyApprox: hasArtifact && artifactExportedAtMs === null,
    hasArtifact,
    receipt: session.receipts.get(operation.operationId) ?? null,
    deliveryStatus: operation.delivery?.status ?? null,
    attempt: operation.recovery?.attempt ?? null,
    errorCode: operation.errorCode,
    clockAnomaly: createdAtMs !== null && completedAtMs !== null && completedAtMs < createdAtMs,
    running: !TERMINAL.has(operation.status ?? ""),
  };
}

const EMPTY_SESSION: SessionTimeline = { turns: [], receipts: new Map(), note: "该分组没有记录调度会话，无 Turn 证据" };

export function buildSchedule(args: {
  generation: string;
  now: number;
  tasks: ScheduleTaskInput[];
  lifecycle: CallerLifecycleReader;
  sessions: CallerSessionReader;
}): ScheduleResponse {
  interface GroupState {
    sessionId: string | null;
    /** Full identity used only server-side for the lifecycle read. */
    identity: CallerIdentity | undefined;
    inputs: ScheduleTaskInput[];
  }
  const groups = new Map<string, GroupState>();
  for (const input of args.tasks) {
    const first = input.operations[0]?.invocation?.caller;
    const sessionId = first?.session_id ?? null;
    const key = sessionId ?? "\0unattributed";
    let group = groups.get(key);
    if (!group) {
      group = { sessionId, identity: undefined, inputs: [] };
      groups.set(key, group);
    }
    // The lifecycle read needs a data_root; take it from any attributed task.
    if (sessionId && !group.identity?.data_root && first) group.identity = first;
    group.inputs.push(input);
  }

  const built: ScheduleGroup[] = [];
  for (const group of groups.values()) {
    const session = group.sessionId ? args.lifecycle.sessionTimeline(group.identity) : EMPTY_SESSION;
    const namemeta = group.sessionId ? args.sessions.read(group.identity) : { name: null, projectName: null };
    const tasks: ScheduleTask[] = group.inputs.map((input) => {
      const operations = input.operations.map((operation) =>
        projectOperation(operation, input.opTimes.get(operation.operationId), session));
      const dispatches = operations.map((operation) => operation.createdAtMs).filter((value): value is number => value !== null);
      // Latest recorded plan wins; contracts may be refined across rounds.
      const parallel = [...input.operations].reverse().find((operation) => operation.parallel)?.parallel ?? null;
      return {
        taskId: input.meta.taskId,
        title: input.meta.title,
        providerLabel: input.meta.providerLabel,
        statusKind: input.meta.statusKind,
        firstDispatchMs: dispatches.length ? Math.min(...dispatches) : null,
        parallel,
        operations,
      };
    });
    // Stable lane order: first dispatch time, then taskId.
    tasks.sort((a, b) => {
      const av = a.firstDispatchMs ?? Number.POSITIVE_INFINITY;
      const bv = b.firstDispatchMs ?? Number.POSITIVE_INFINITY;
      return av !== bv ? av - bv : a.taskId.localeCompare(b.taskId);
    });
    built.push({
      sessionId: group.sessionId,
      name: namemeta.name,
      projectName: namemeta.projectName,
      turns: session.turns,
      turnsNote: session.note,
      tasks,
    });
  }
  // Deterministic group order: earliest first dispatch, unattributed last.
  built.sort((a, b) => {
    if ((a.sessionId === null) !== (b.sessionId === null)) return a.sessionId === null ? 1 : -1;
    const av = Math.min(...a.tasks.map((task) => task.firstDispatchMs ?? Number.POSITIVE_INFINITY));
    const bv = Math.min(...b.tasks.map((task) => task.firstDispatchMs ?? Number.POSITIVE_INFINITY));
    return av !== bv ? av - bv : String(a.sessionId).localeCompare(String(b.sessionId));
  });
  return { generation: args.generation, now: args.now, groups: built };
}
