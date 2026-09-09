import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import { buildSchedule, type ScheduleTaskInput } from "../src/server/schedule.js";
import type { CallerLifecycleReader, SessionTimeline } from "../src/server/caller-lifecycle.js";
import type { CallerSessionReader } from "../src/server/caller-session.js";
import type { OperationRecord } from "../src/server/scan.js";
import type { ScheduleReceipt, TaskMeta } from "../src/shared/types.js";
import { Hub } from "../src/server/hub.js";

const T = (offsetSec: number): string => new Date(Date.UTC(2026, 8, 9, 4, 0, offsetSec)).toISOString();
const Tms = (offsetSec: number): number => Date.parse(T(offsetSec));

function caller(sessionId: string | null, turnId: string | null = null): CallerIdentity {
  return { kind: "codex", session_id: sessionId, turn_id: turnId, identity_source: "caller-declared", data_root: "/tmp/fixture-root" };
}

function op(taskId: string, operationId: string, extra: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operationId, taskId, provider: "codex-cli", kind: "turn", status: "succeeded", pid: null,
    createdAt: T(10), completedAt: T(20), stdoutPath: null, endpointId: null, observedSessionId: null,
    target: null, model: null, message: null,
    execution: { requestedModel: null, requestedEffort: null, requestedVariant: null, actualModel: null, actualEffort: null, actualVariant: null, modelVerification: null, effortVerification: null, variantVerification: null },
    providerCompletedAtMs: null, errorCode: null, errorMessage: null,
    ...extra,
  };
}

function meta(taskId: string): TaskMeta {
  return {
    taskId, title: taskId, available: true, provisional: false, provider: "codex-cli", providerLabel: "Codex CLI",
    model: null, effort: null, permissionMode: null, target: null, status: "已成功", statusKind: "succeeded",
    running: false, pidAlive: null, operations: 1, lastOperationId: null, lastActivityMs: null,
    createdAt: null, updatedAt: null, capability: "未知", granularity: "未知",
    resume: { sessionId: null, sessionSource: null, workdir: null, dataRootNote: null, command: null, resumable: false, note: "" },
  };
}

function input(taskId: string, operations: OperationRecord[], opTimes: ScheduleTaskInput["opTimes"] = new Map()): ScheduleTaskInput {
  return { meta: meta(taskId), operations, opTimes };
}

function stubLifecycle(timelines: Record<string, SessionTimeline>): CallerLifecycleReader {
  return {
    sessionTimeline: (identity: CallerIdentity | undefined) =>
      (identity?.session_id && timelines[identity.session_id])
        ?? { turns: [], receipts: new Map(), note: "无法定位调度会话" },
  } as unknown as CallerLifecycleReader;
}

const stubSessions = { read: () => ({ name: "调度会话名", projectName: "fixture-project" }) } as unknown as CallerSessionReader;

describe("buildSchedule", () => {
  it("attributes by the first operation, keeps lanes stable, binds turns honestly and joins cross-turn receipts", () => {
    const receipts = new Map<string, ScheduleReceipt>([
      ["op-a1", { turnId: "turn-2", atMs: Tms(120), status: "SUCCEEDED" }],
      ["op-c2", { turnId: "turn-2", atMs: Tms(130), status: "ERROR" }],
    ]);
    const timeline: SessionTimeline = {
      turns: [
        { turnId: "turn-1", startedAtMs: Tms(1), completedAtMs: Tms(50), aborted: false },
        { turnId: "turn-2", startedAtMs: Tms(100), completedAtMs: null, aborted: false },
      ],
      receipts,
      note: "",
    };
    const result = buildSchedule({
      generation: "g1",
      now: Tms(200),
      tasks: [
        // Task A: recorded turn binding, artifact without journal export time.
        input("task-a", [op("task-a", "op-a1", {
          invocation: { caller: caller("sess-main", "turn-1"), trigger: "user_request", user_request: null, reason: null },
          createdAt: T(10), completedAt: T(20),
          artifact: { operationId: "op-a1", path: "/x", sha256: "0".repeat(64), bytes: 1 },
        })]),
        // Task B: inferred binding by create time, still running, parallel plan (latest wins).
        input("task-b", [
          op("task-b", "op-b1", {
            invocation: { caller: caller("sess-main"), trigger: "user_request", user_request: null, reason: null },
            createdAt: T(12), completedAt: T(30),
            parallel: { group: "old", role: "worker", integratorTaskId: "task-x", workers: [] },
          }),
          op("task-b", "op-b2", {
            status: "running", createdAt: T(110), completedAt: null,
            invocation: { caller: caller("sess-main"), trigger: "caller_followup", user_request: null, reason: null },
            recovery: { attempt: 1, limit: 3, available: false },
            parallel: { group: "grp", role: "integrator", integratorTaskId: null, workers: ["task-a"] },
          }),
        ], new Map([["op-b2", { startedAtMs: Tms(111), artifactExportedAtMs: null }]])),
        // Task C: earliest dispatch outside any turn (binding none, clock anomaly),
        // second round continued by a DIFFERENT caller session.
        input("task-c", [
          op("task-c", "op-c1", {
            invocation: { caller: caller("sess-main"), trigger: "user_request", user_request: null, reason: null },
            createdAt: T(0), completedAt: new Date(Tms(0) - 5000).toISOString(), status: "failed", errorCode: "E_FAIL",
          }),
          op("task-c", "op-c2", {
            invocation: { caller: caller("sess-other"), trigger: "caller_followup", user_request: null, reason: null },
            createdAt: T(115), completedAt: T(125),
          }),
        ]),
        // Task D: no caller on the first operation → unattributed group.
        input("task-d", [op("task-d", "op-d1", { createdAt: T(5), completedAt: null, status: "running" })]),
      ],
      lifecycle: stubLifecycle({ "sess-main": timeline }),
      sessions: stubSessions,
    });

    expect(result.groups.map((group) => group.sessionId)).toEqual(["sess-main", null]);
    const main = result.groups[0];
    expect(main).toMatchObject({ name: "调度会话名", projectName: "fixture-project", turnsNote: "" });
    expect(main.turns).toHaveLength(2);
    // Stable lane order: first dispatch time then taskId.
    expect(main.tasks.map((task) => task.taskId)).toEqual(["task-c", "task-a", "task-b"]);

    const a1 = main.tasks[1].operations[0];
    expect(a1).toMatchObject({ dispatchTurnId: "turn-1", dispatchBinding: "recorded", hasArtifact: true, artifactReadyApprox: true, running: false });
    // Cross-turn receipt: dispatched in turn-1, received in turn-2.
    expect(a1.receipt).toEqual({ turnId: "turn-2", atMs: Tms(120), status: "SUCCEEDED" });

    const [b1, b2] = main.tasks[2].operations;
    expect(b1).toMatchObject({ dispatchTurnId: "turn-1", dispatchBinding: "inferred-by-create-time", receipt: null });
    expect(b2).toMatchObject({ dispatchTurnId: "turn-2", dispatchBinding: "inferred-by-create-time", running: true, completedAtMs: null, executorStartedAtMs: Tms(111), attempt: 1 });
    // Latest recorded parallel plan wins.
    expect(main.tasks[2].parallel).toEqual({ group: "grp", role: "integrator", integratorTaskId: null, workers: ["task-a"] });

    const [c1, c2] = main.tasks[0].operations;
    expect(c1).toMatchObject({ dispatchTurnId: null, dispatchBinding: "none", clockAnomaly: true, errorCode: "E_FAIL", status: "failed" });
    // Later round by another caller stays in the original group but reports the real caller.
    expect(c2).toMatchObject({ callerSessionId: "sess-other", receipt: { status: "ERROR", turnId: "turn-2" } });

    const unattributed = result.groups[1];
    expect(unattributed.sessionId).toBeNull();
    expect(unattributed.turns).toEqual([]);
    expect(unattributed.turnsNote).not.toBe("");
    expect(unattributed.tasks[0].operations[0]).toMatchObject({ executorStartedAtMs: null, receipt: null, running: true });
  });

  it("keeps missing evidence null instead of inventing times", () => {
    const result = buildSchedule({
      generation: "g", now: Tms(10),
      tasks: [input("task-x", [op("task-x", "op-x", { createdAt: "", completedAt: null, status: "running" })])],
      lifecycle: stubLifecycle({}),
      sessions: stubSessions,
    });
    const operation = result.groups[0].tasks[0].operations[0];
    expect(operation).toMatchObject({ createdAtMs: null, completedAtMs: null, executorStartedAtMs: null, dispatchBinding: "none", clockAnomaly: false });
    expect(result.groups[0].tasks[0].firstDispatchMs).toBeNull();
  });
});

describe("Hub schedule integration (journal evidence + restart replay)", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function fixtureRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "fixture-schedule-"));
    roots.push(root);
    for (const dir of ["operations", "logs", "events"]) mkdirSync(path.join(root, dir), { recursive: true });
    return root;
  }

  it("aggregates every operation with journal timestamps and rebuilds them after a restart", () => {
    const root = fixtureRoot();
    const taskId = "fixture-task-sched";
    const write = (opId: string, extra: Record<string, unknown>): void => {
      const stdout = path.join(root, "logs", `${opId}.stdout`);
      writeFileSync(stdout, "");
      writeFileSync(path.join(root, "operations", `${opId}.json`), JSON.stringify({
        operation_id: opId, task_id: taskId, provider: "codex-cli", kind: "turn", pid: null,
        stdout_path: stdout, ...extra,
      }));
    };
    write("fixture-op-1", { status: "succeeded", created_at: T(0), completed_at: T(20) });
    write("fixture-op-2", { status: "running", created_at: T(30) });
    const journal = path.join(root, "events", `${taskId}.jsonl`);
    writeFileSync(journal, "");
    for (const event of [
      { type: "operation-started", operation_id: "fixture-op-1", timestamp: T(2) },
      { type: "artifact-exported", operation_id: "fixture-op-1", timestamp: T(19) },
      { type: "operation-started", operation_id: "fixture-op-2", timestamp: T(31) },
    ]) appendFileSync(journal, `${JSON.stringify(event)}\n`);

    const hub = new Hub([taskId], root);
    hub.refresh();
    const first = hub.schedule();
    expect(first.groups).toHaveLength(1);
    const ops = first.groups[0].tasks[0].operations;
    // Both operations aggregated — never lastOperation only.
    expect(ops.map((operation) => operation.operationId)).toEqual(["fixture-op-1", "fixture-op-2"]);
    expect(ops[0]).toMatchObject({ executorStartedAtMs: Tms(2), artifactExportedAtMs: Tms(19) });
    expect(ops[1]).toMatchObject({ executorStartedAtMs: Tms(31), completedAtMs: null, running: true });

    // Restart: a brand-new Hub replays the journal from offset 0.
    const restarted = new Hub([taskId], root);
    restarted.refresh();
    const again = restarted.schedule().groups[0].tasks[0].operations;
    expect(again[0]).toMatchObject({ executorStartedAtMs: Tms(2), artifactExportedAtMs: Tms(19) });
    expect(again[1]).toMatchObject({ executorStartedAtMs: Tms(31) });
    // No data_root or absolute path ever ships in the aggregate.
    expect(JSON.stringify(first)).not.toContain(root);
  });
});
