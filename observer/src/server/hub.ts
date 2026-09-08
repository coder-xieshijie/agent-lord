/** Observation hub: aggregates read-only state for an explicit task
 * allowlist and broadcasts timeline patches to SSE listeners.
 *
 * Refresh ordering per cycle (fixes the round-1 mis-ordering where
 * operation-succeeded journal entries appeared before the turn's stream):
 *   1. journal "pre" events (operation-created, turn dispatch, …)
 *   2. each operation's native stdout stream (complete lines only)
 *   3. journal "post" events (operation-succeeded/failed, artifacts, …)
 */

import path from "node:path";
import { randomBytes } from "node:crypto";
import type { DeltaResponse, Patch, ProviderId, TaskMeta } from "../shared/types.js";
import {
  defaultStateDir,
  fileMtimeMs,
  journalPath,
  listOperations,
  pidAlive,
  readCompleteLines,
  readTaskRecord,
  validStdoutPath,
  type OperationRecord,
} from "./scan.js";
import { Timeline } from "./timeline.js";
import {
  buildResume,
  CAPABILITY,
  deriveStatus,
  GRANULARITY,
  humanTitle,
  PROVIDER_LABELS,
  sessionEvidence,
} from "./meta.js";
import type { OpProjector } from "./projector/common.js";
import { McodeProjector } from "./projector/mcode.js";
import { CodexProjector } from "./projector/codex.js";
import { ClaudeProjector } from "./projector/claude.js";
import { clip, clipTitle, TOOL_TEXT_CLIP } from "./sanitize.js";

/** Journal event types that must sort after the operation's stream output. */
const POST_JOURNAL_TYPES = new Set([
  "operation-succeeded",
  "operation-failed",
  "operation-needs-decision",
  "operation-completed",
  "artifact-exported",
  "task-succeeded",
  "task-failed",
  "checkpoint-recorded",
]);

const JOURNAL_LABELS: Record<string, string> = {
  "task-created": "任务已创建",
  "operation-created": "操作已创建",
  "operation-started": "操作已启动",
  "operation-continued": "同会话续做已启动",
  "operation-succeeded": "操作成功",
  "operation-failed": "操作失败",
  "operation-needs-decision": "操作待决策",
  "artifact-exported": "产物已导出",
  "checkpoint-recorded": "已记录 checkpoint",
};

interface JournalEvent {
  lineNo: number;
  type: string;
  opId?: string;
  ts?: string;
  detail?: string;
  level: "info" | "success" | "error";
}

function parseJournalLine(line: string, lineNo: number): JournalEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  const data = (record.data ?? {}) as Record<string, unknown>;
  let detail: string | undefined;
  for (const key of ["message", "error", "reason", "artifact_path", "status"]) {
    const raw = data[key];
    if (typeof raw === "string" && raw) {
      detail = clip(raw, TOOL_TEXT_CLIP);
      break;
    }
    if (raw && typeof raw === "object") {
      const inner = (raw as Record<string, unknown>).message;
      if (typeof inner === "string" && inner) {
        detail = clip(inner, TOOL_TEXT_CLIP);
        break;
      }
    }
  }
  const level = type.endsWith("-failed")
    ? "error"
    : type.endsWith("-succeeded")
      ? "success"
      : "info";
  return {
    lineNo,
    type,
    opId: typeof record.operation_id === "string" ? record.operation_id : undefined,
    ts: typeof record.timestamp === "string" ? record.timestamp : undefined,
    detail,
    level,
  };
}

interface OpReader {
  file: string;
  offset: number;
  projector: OpProjector | null;
}

export interface HubListener {
  seq: number;
  send(payload: DeltaResponse | { reset: true; reason: string }): void;
}

interface TaskState {
  taskId: string;
  timeline: Timeline;
  journalOffset: number;
  journalLineNo: number;
  readers: Map<string, OpReader>;
  streamSessionId: string | null;
  meta: TaskMeta;
  metaJson: string;
  metaDirty: boolean;
  listeners: Set<HubListener>;
}

function makeProjector(
  provider: string | null,
  timeline: Timeline,
  scope: string,
): OpProjector | null {
  switch (provider) {
    case "mcode-cli":
      return new McodeProjector(timeline, scope);
    case "codex-cli":
      return new CodexProjector(timeline, scope);
    case "claude-cli":
      return new ClaudeProjector(timeline, scope);
    default:
      return null; // codex-app and unknown providers: status only.
  }
}

function emptyMeta(taskId: string): TaskMeta {
  return {
    taskId,
    title: humanTitle(taskId),
    available: false,
    provisional: false,
    provider: null,
    providerLabel: "未知",
    model: null,
    effort: null,
    permissionMode: null,
    target: null,
    status: "尚无记录",
    statusKind: "empty",
    running: false,
    pidAlive: null,
    operations: 0,
    lastOperationId: null,
    lastActivityMs: null,
    createdAt: null,
    updatedAt: null,
    capability: "未知",
    granularity: "未知",
    resume: {
      sessionId: null,
      sessionSource: null,
      workdir: null,
      dataRootNote: null,
      command: null,
      resumable: false,
      note: "尚无任务或操作记录",
    },
  };
}

export class Hub {
  readonly generation: string;
  private readonly root: string;
  private readonly tasks = new Map<string, TaskState>();
  private refreshing = false;

  constructor(taskIds: string[], stateDir?: string) {
    this.root = stateDir ? path.resolve(stateDir) : defaultStateDir();
    this.generation = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    for (const taskId of taskIds) {
      this.tasks.set(taskId, {
        taskId,
        timeline: new Timeline(),
        journalOffset: 0,
        journalLineNo: 0,
        readers: new Map(),
        streamSessionId: null,
        meta: emptyMeta(taskId),
        metaJson: "",
        metaDirty: false,
        listeners: new Set(),
      });
    }
  }

  get stateDir(): string {
    return this.root;
  }

  taskIds(): string[] {
    return [...this.tasks.keys()];
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  cursor(state: TaskState): string {
    return `${this.generation}:${state.timeline.lastSeq}`;
  }

  parseCursor(raw: string | null): number | null {
    if (!raw) return null;
    const idx = raw.lastIndexOf(":");
    if (idx <= 0) return null;
    if (raw.slice(0, idx) !== this.generation) return null;
    const seq = Number(raw.slice(idx + 1));
    return Number.isInteger(seq) && seq >= 0 ? seq : null;
  }

  overview(): TaskMeta[] {
    return [...this.tasks.values()].map((state) => state.meta);
  }

  snapshot(taskId: string): { cursor: string; task: TaskMeta; items: ReturnType<Timeline["snapshotItems"]>; truncatedHistory: boolean } | null {
    const state = this.tasks.get(taskId);
    if (!state) return null;
    return {
      cursor: this.cursor(state),
      task: state.meta,
      items: state.timeline.snapshotItems(),
      truncatedHistory: state.timeline.truncatedHistory,
    };
  }

  delta(taskId: string, afterSeq: number): { cursor: string; patches: Patch[]; task: TaskMeta } | null {
    const state = this.tasks.get(taskId);
    if (!state) return null;
    const patches = state.timeline.patchesAfter(afterSeq);
    if (patches === null) return null;
    return { cursor: this.cursor(state), patches, task: state.meta };
  }

  subscribe(taskId: string, listener: HubListener): (() => void) | null {
    const state = this.tasks.get(taskId);
    if (!state) return null;
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  /** One polling cycle over every allow-listed task. Never throws. */
  refresh(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const state of this.tasks.values()) {
        try {
          this.refreshTask(state);
        } catch {
          // A single broken task must not stall the others.
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private refreshTask(state: TaskState): void {
    const task = readTaskRecord(this.root, state.taskId);
    const operations = listOperations(this.root, state.taskId);

    // 1. Journal: read new complete lines, split pre/post.
    const journal = journalPath(this.root, state.taskId);
    const tail = readCompleteLines(journal, state.journalOffset);
    if (tail.truncated) {
      state.journalOffset = tail.offset;
      state.timeline.upsert({
        id: `journal/notice/truncated/${state.journalLineNo}`,
        kind: "notice",
        text: "控制平面 journal 被截断或轮换，已从当前位置继续观察",
        ord: 0,
      });
    } else {
      state.journalOffset = tail.offset;
    }
    const pre: JournalEvent[] = [];
    const post: JournalEvent[] = [];
    for (const line of tail.lines) {
      state.journalLineNo += 1;
      const event = parseJournalLine(line, state.journalLineNo);
      if (!event) continue;
      (POST_JOURNAL_TYPES.has(event.type) ? post : pre).push(event);
    }
    const emitJournal = (event: JournalEvent): void => {
      state.timeline.upsert({
        id: `journal/${event.lineNo}`,
        kind: "journal",
        name: event.type,
        label: JOURNAL_LABELS[event.type] ?? event.type,
        detail: event.detail,
        level: event.level,
        opId: event.opId,
        ord: 0,
        ts: event.ts,
      });
    };
    for (const event of pre) emitJournal(event);

    // 2. Native exec streams for each operation, oldest first.
    for (const operation of operations) {
      this.pumpOperation(state, operation);
    }

    // 3. Post journal events (terminal states, artifacts) after stream output.
    for (const event of post) emitJournal(event);

    // 4. Metadata.
    this.rebuildMeta(state, task, operations);

    // 5. Broadcast to listeners.
    this.broadcast(state);
  }

  private pumpOperation(state: TaskState, operation: OperationRecord): void {
    const file = validStdoutPath(this.root, operation.operationId, operation.stdoutPath);
    if (!file) return;
    let reader = state.readers.get(operation.operationId);
    if (reader && reader.file !== file) {
      // Retry produced a new attempt stream; observe it from the start under
      // a distinct id scope so both attempts stay visible and stable.
      state.timeline.upsert({
        id: `notice/attempt/${operation.operationId}/${path.basename(file)}`,
        kind: "notice",
        text: `操作 ${clipTitle(operation.operationId)} 切换到新的输出流（重试）：${path.basename(file)}`,
        ord: 0,
      });
      reader = undefined;
    }
    if (!reader) {
      const base = path.basename(file);
      const isPrimary = base === `${operation.operationId}.stdout`;
      const scope = isPrimary ? operation.operationId : `${operation.operationId}@${base}`;
      reader = {
        file,
        offset: 0,
        projector: makeProjector(operation.provider, state.timeline, scope),
      };
      state.readers.set(operation.operationId, reader);
    }
    if (!reader.projector) return;
    const tail = readCompleteLines(reader.file, reader.offset);
    if (tail.truncated) {
      state.timeline.upsert({
        id: `notice/shrunk/${operation.operationId}/${tail.offset}`,
        kind: "notice",
        text: `操作 ${clipTitle(operation.operationId)} 的输出文件被截断，已从当前位置继续`,
        ord: 0,
      });
    }
    reader.offset = tail.offset;
    for (const line of tail.lines) reader.projector.handleLine(line);
    if (reader.projector.observedSessionId) {
      state.streamSessionId = reader.projector.observedSessionId;
    }
  }

  private rebuildMeta(state: TaskState, task: ReturnType<typeof readTaskRecord>, operations: OperationRecord[]): void {
    const lastOp = operations[operations.length - 1] ?? null;
    const providerRaw = task?.provider ?? lastOp?.provider ?? null;
    const provider = (providerRaw && providerRaw in PROVIDER_LABELS ? providerRaw : null) as ProviderId | null;
    const target = task?.target ?? lastOp?.target ?? null;
    const { status, statusKind, running, pidAlive: alive } = deriveStatus(operations, pidAlive);
    const evidence = sessionEvidence(task, operations, state.streamSessionId);
    const activityCandidates = [
      fileMtimeMs(journalPath(this.root, state.taskId)),
      ...(lastOp
        ? [fileMtimeMs(validStdoutPath(this.root, lastOp.operationId, lastOp.stdoutPath) ?? "")]
        : []),
    ].filter((value): value is number => typeof value === "number");
    const meta: TaskMeta = {
      taskId: state.taskId,
      title: humanTitle(state.taskId),
      available: Boolean(task) || operations.length > 0,
      provisional: !task && operations.length > 0,
      provider,
      providerLabel: provider ? PROVIDER_LABELS[provider] : (providerRaw ?? "未知"),
      model: task?.model ?? lastOp?.model ?? null,
      effort: task?.effort ?? null,
      permissionMode: task?.permissionMode ?? null,
      target,
      status,
      statusKind,
      running,
      pidAlive: alive,
      operations: operations.length,
      lastOperationId: lastOp?.operationId ?? null,
      lastActivityMs: activityCandidates.length ? Math.max(...activityCandidates) : null,
      createdAt: task?.createdAt ?? (operations[0]?.createdAt || null),
      updatedAt: task?.updatedAt ?? lastOp?.completedAt ?? null,
      capability: provider ? CAPABILITY[provider] : "未知",
      granularity: provider ? GRANULARITY[provider] : "未知",
      resume: buildResume(provider, evidence, target, running),
      error: lastOp?.errorMessage ? clip(lastOp.errorMessage, TOOL_TEXT_CLIP) : undefined,
      activity: lastOp?.activity,
      delivery: lastOp?.delivery,
      recovery: lastOp?.recovery,
    };
    const metaJson = JSON.stringify(meta);
    state.meta = meta;
    if (metaJson !== state.metaJson) {
      state.metaJson = metaJson;
      state.metaDirty = true;
    }
  }

  private broadcast(state: TaskState): void {
    const metaChanged = state.metaDirty;
    state.metaDirty = false;
    if (!state.listeners.size) return;
    for (const listener of state.listeners) {
      const patches = state.timeline.patchesAfter(listener.seq);
      if (patches === null) {
        listener.send({ reset: true, reason: "cursor 已超出保留窗口，请重新获取快照" });
        continue;
      }
      if (!patches.length && !metaChanged) continue;
      listener.seq = state.timeline.lastSeq;
      listener.send({ cursor: this.cursor(state), patches, task: state.meta });
    }
  }
}
