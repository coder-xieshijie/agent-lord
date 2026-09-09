/** Shared display-event contract between the TS observer server and the web UI. */

export type { Provider as ProviderId } from "@agent-lord/core/contracts";
import type { Provider as ProviderId } from "@agent-lord/core/contracts";
import type { CallerIdentity, Invocation } from "@agent-lord/core/contracts";

export type CallerDisplay = Omit<CallerIdentity, "data_root">;
export interface CallerLifecycle {
  status: "running" | "completed" | "aborted" | "unknown";
  turnId: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  receivedAtMs: number | null;
  observedAtMs: number | null;
  note: string;
}
export interface ExecutionModel {
  requestedModel: string | null;
  requestedEffort: string | null;
  requestedVariant: string | null;
  actualModel: string | null;
  actualEffort: string | null;
  actualVariant: string | null;
  modelVerification: string | null;
  effortVerification: string | null;
  variantVerification: string | null;
}
export interface RequestItem {
  id: string;
  kind: "request";
  role: "user" | "caller";
  text: string;
  trigger: Invocation["trigger"];
  reason: string | null;
  caller: CallerDisplay | null;
  originalRecorded: boolean;
  opId: string;
  ord: number;
  tsMs?: number;
}

export type ToolState = "running" | "completed" | "error";

export interface FontCatalog {
  families: string[];
  available: boolean;
  message?: string;
}

export interface MessageItem {
  id: string;
  kind: "message";
  role: "assistant";
  /** Merged markdown text (deltas coalesced; full message replaces stream). */
  text: string;
  streaming: boolean;
  opId?: string;
  ord: number;
  tsMs?: number;
}

export interface ToolItem {
  id: string;
  kind: "tool";
  name: string;
  state: ToolState;
  /** Human-readable one-line summary of the call (command/path/pattern…). */
  title?: string;
  /** Pretty-printed input, shown collapsed. */
  inputText?: string;
  /** Extracted readable output (content[].text / stdout), clipped. */
  outputText?: string;
  errorText?: string;
  exitCode?: number;
  opId?: string;
  ord: number;
  tsMs?: number;
}

export interface LifecycleItem {
  id: string;
  kind: "lifecycle";
  name: string;
  label: string;
  opId?: string;
  ord: number;
  tsMs?: number;
}

export interface JournalItem {
  id: string;
  kind: "journal";
  name: string;
  label: string;
  detail?: string;
  level: "info" | "success" | "error";
  opId?: string;
  ord: number;
  ts?: string;
}

export interface NoticeItem {
  id: string;
  kind: "notice";
  text: string;
  ord: number;
}

export interface FinalItem {
  id: string;
  kind: "final";
  ok: boolean;
  summary?: string;
  durationMs?: number;
  opId?: string;
  ord: number;
}

/** Aggregated marker for provider events we deliberately do not render
 * (reasoning omitted, unknown types). Keeps the timeline honest without
 * flooding it. */
export interface OmittedItem {
  id: string;
  kind: "omitted";
  name: string;
  count: number;
  opId?: string;
  ord: number;
}

export type TimelineItem =
  | MessageItem
  | RequestItem
  | ToolItem
  | LifecycleItem
  | JournalItem
  | NoticeItem
  | FinalItem
  | OmittedItem;

export interface ResumeInfo {
  sessionId: string | null;
  /** Where the session id was read from (evidence, not a guarantee). */
  sessionSource: string | null;
  workdir: string | null;
  dataRootNote: string | null;
  command: string | null;
  resumable: boolean;
  note: string;
}

export interface TaskMeta {
  taskId: string;
  title: string;
  available: boolean;
  /** Task record missing but operations exist (first turn before the
   * scheduler creates the task file). */
  provisional: boolean;
  provider: ProviderId | null;
  providerLabel: string;
  model: string | null;
  effort: string | null;
  execution?: ExecutionModel;
  caller?: { initial: CallerDisplay | null; current: CallerDisplay | null; lifecycle: CallerLifecycle };
  timing?: { providerCompletedAtMs: number | null; artifactReadyAtMs: number | null; callerReceivedAtMs: number | null; callerCompletedAtMs: number | null };
  artifact?: { operationId: string; path: string; bytes: number; sha256: string };
  permissionMode: string | null;
  target: string | null;
  status: string;
  statusKind: "running" | "succeeded" | "failed" | "needs_decision" | "unknown" | "empty";
  running: boolean;
  pidAlive: boolean | null;
  operations: number;
  lastOperationId: string | null;
  lastActivityMs: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  capability: string;
  granularity: string;
  resume: ResumeInfo;
  error?: string;
  activity?: {
    lastEventType: string | null;
    lastTool: string | null;
    activeToolCount: number;
    activeTools: string[];
    lastProgressMs: number | null;
  };
  delivery?: {
    status: "verified" | "incomplete" | "unverified";
    checks: Array<{ label: string; ok: boolean }>;
    commitSha: string | null;
  };
  recovery?: { attempt: number; limit: number; available: boolean };
}

export interface Patch {
  seq: number;
  type: "upsert";
  item: TimelineItem;
}

export interface SnapshotResponse {
  generation: string;
  cursor: string;
  task: TaskMeta;
  items: TimelineItem[];
  /** True when older items were dropped from the retained window. */
  truncatedHistory: boolean;
}

export interface DeltaResponse {
  cursor: string;
  patches: Patch[];
  task?: TaskMeta;
}

export interface ResetResponse {
  reset: true;
  reason: string;
}

export interface OverviewResponse {
  tasks: TaskMeta[];
  generation: string;
}
