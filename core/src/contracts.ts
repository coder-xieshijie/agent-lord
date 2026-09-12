/** Persisted names deliberately match task-v2 / operation-v1 and the CLI protocol. */
export const PROVIDERS = [
  "claude-cli",
  "codex-cli",
  "mcode-cli",
  "codex-app",
] as const;
export type Provider = (typeof PROVIDERS)[number];
export type CliProvider = Exclude<Provider, "codex-app">;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
export const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "needs_decision",
]);
export type OperationStatus =
  | "preparing"
  | "running"
  | "recovering"
  | "submitted"
  | "awaiting_action"
  | "succeeded"
  | "failed"
  | "needs_decision";
export type Data = Record<string, unknown>;
export interface Source {
  head_sha?: string;
  base_sha?: string;
  verified_head_sha?: string;
}
export interface RetryStage {
  model: string | null;
  attempts: number;
}
export interface Workspace {
  policy: "exact-target" | "reuse-or-create" | "shared-readonly" | "isolated";
  repository?: string;
  source_branch?: string;
  workspace_branch?: string;
}
export type ParallelPlan = {
  group: string;
  integration_target_branch: string;
} & (
  | { role: "worker"; integrator_task_id: string; integration_order: number }
  | { role: "integrator"; integration_workers: string[] }
);
export interface Contract {
  model: string | null;
  effort: string | null;
  read_only: boolean;
  permission_mode: string | null;
  source: Source;
  retry_plan: RetryStage[];
  workspace?: Workspace;
  parallel_plan?: ParallelPlan | Data;
  continuation_limit?: number;
}
export interface Expected {
  model: string | null;
  effort: string | null;
  permission_mode: string;
  permission_enforcement: string;
  retry_plan: RetryStage[];
  continuation_limit?: number;
}
export interface Route {
  host_id: string | null;
  resolved_at: string;
  history: Data[];
}
export interface Task {
  version: 2;
  task_id: string;
  provider: Provider;
  endpoint_id: string;
  target: string;
  route: Route;
  contract: Contract;
  created_at: string;
  updated_at: string;
  last_operation_id: string | null;
  lineage?: Data;
  legacy_version?: 1;
}
export interface ErrorRecord {
  code: string;
  message: string;
  retryable: boolean;
  requires_authorization: boolean;
  safe_recovery?: string;
  details?: Data;
}
export interface DeliveryRequirements {
  files: string[];
  require_commit: boolean;
  base_head: string | null;
}
export interface Delivery {
  status: "unverified" | "verified" | "incomplete";
  scope: "declared-files-and-commit";
  checks: Array<{
    kind: "file" | "commit";
    path?: string;
    ok: boolean;
    clean?: boolean;
  }>;
  commit_sha?: string | null;
}
export interface Artifact {
  path: string;
  sha256: string;
  bytes: number;
  [key: string]: unknown;
}
/** Invocation metadata describes the caller, never the provider endpoint or its frozen contract. */
export interface CallerIdentity {
  kind: string;
  session_id: string | null;
  turn_id: string | null;
  identity_source: "runtime-env" | "caller-declared" | "unavailable";
  /** Local Codex data root, used only for a session-bound lifecycle read. */
  data_root?: string;
}
export interface Invocation {
  caller: CallerIdentity;
  trigger: "user_request" | "caller_followup" | "recovery" | "unspecified";
  user_request: string | null;
  reason: string | null;
}
export interface Operation extends Data {
  version: 1;
  operation_id: string;
  task_id: string;
  provider: Provider;
  kind: string;
  target: string;
  status: OperationStatus;
  message: string;
  message_sha256: string;
  expected: Expected;
  observed: Data;
  source: Source;
  read_only: boolean;
  artifact: Artifact | null;
  error: ErrorRecord | null;
  created_at: string;
  updated_at: string;
  endpoint_id?: string | null;
  workspace?: Workspace;
  parallel_plan?: ParallelPlan | Data;
  pid?: number | null;
  controller_pid?: number | null;
  recovery_controller_pid?: number | null;
  active_attempt?: Data | null;
  attempt_history?: Data[];
  delivery_requirements?: DeliveryRequirements | null;
  delivery?: Delivery;
  continuation?: Data;
  handoff?: Data;
  resume?: boolean;
  invocation?: Invocation;
  /**
   * Inbox request consumed by this dispatch. Written in the same atomic
   * operation record, so the request-to-operation association survives a
   * consumer crash without a second file having to commit with it.
   */
  request_id?: string;
}
/** A registered but not yet dispatched instruction. Never an authorization. */
export interface RequestIntent {
  kind: "start" | "turn";
  task_id: string;
  provider: string | null;
  target: string | null;
  repository: string | null;
  options: Data;
}
export interface RequestSource {
  kind: string | null;
  session_id: string | null;
  note: string | null;
}
export interface RequestRecord extends Data {
  version: 1;
  request_id: string;
  status: "pending" | "dispatched" | "cancelled";
  intent: RequestIntent;
  intent_sha256: string;
  message: string;
  message_sha256: string;
  user_request: string | null;
  source: RequestSource;
  operation_id: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}
export interface Action extends Data {
  version: 1;
  action_id: string;
  operation_id: string;
  task_id: string;
  provider: "codex-app";
  kind: string;
  tool: string;
  arguments: Data;
  status: "pending" | "accepted" | "failed" | "uncertain";
  created_at: string;
  updated_at: string;
}
export interface Envelope extends Data {
  version: 1;
  status:
    | "IDLE"
    | "ACTION_REQUIRED"
    | "RUNNING"
    | "SUCCEEDED"
    | "ERROR"
    | "NEEDS_DECISION"
    | "CHECKPOINT_ACTIONABLE"
    | "CHECKPOINT_QUIET"
    | "REQUEST_RECORD"
    | "REQUEST_LIST"
    | "REQUEST_PENDING";
  task_id?: string;
  operation_id?: string;
  error?: ErrorRecord;
  artifact?: Artifact | null;
  invocation?: Invocation;
  response?: { text: string; read_at_ms: number };
  provider_return_code?: number | null;
  timing?: { created_at_ms: number; completed_at_ms: number | null };
  action?: Data;
  actionable?: Envelope[];
  active?: Data[];
  /** Per-id observation of every `--starting-task-id` in this checkpoint. */
  starting?: Data[];
  request?: Data;
  requests?: Data[];
  /** Why a consumed request stayed pending instead of becoming an operation. */
  pending_reason?: ErrorRecord;
}
export interface ProviderResult extends Data {
  endpoint_id: string;
  assistant_text: string;
  model: string | null;
  effort: string | null;
}
export interface StartOptions {
  invocation?: unknown;
  model?: string | null;
  effort?: string | null;
  retry_attempts?: number;
  /** Replay an already-frozen plan verbatim (scripted retry); wins over `retry_attempts`. */
  retry_plan?: RetryStage[];
  read_only?: boolean;
  head_sha?: string;
  base_sha?: string;
  repository?: string;
  source_branch?: string;
  workspace_policy?: Workspace["policy"];
  workspace_branch?: string;
  worktree_root?: string;
  parallel_group?: string;
  integration_role?: "worker" | "integrator";
  integration_target_branch?: string;
  integrator_task_id?: string;
  integration_order?: number;
  integration_workers?: string[];
  codex_environment?: "local" | "worktree";
  starting_branch?: string;
  required_files?: string[];
  require_commit?: boolean;
  /** Set only by the request inbox, so the operation carries its origin. */
  request_id?: string;
}
export function object(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}
export function isObject(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}
export function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
export function records(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}
