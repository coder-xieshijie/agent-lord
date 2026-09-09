/** Scripted Claude `RESULT_INVALID` retry (SKILL.md "Claude RESULT_INVALID retry").
 *
 * One persistent ledger lives on the lineage-root operation record and is the
 * single source of truth for the shared three-retry budget, the stable
 * code+message fingerprint streak, and the cross-session `replacement_for`
 * lineage. Every retry operation is stamped with its root so a later
 * invocation against any failed member of the chain finds the same ledger.
 * Same-session retries replay through `turn` on the saved task; only after two
 * consecutive identical fingerprints does the next retry start a new
 * task/session with the frozen contract. When the original failure never
 * published a durable task the same-session path is unavailable, and the
 * command refuses with a structured decision unless the caller explicitly
 * authorizes a replacement via `--replacement-task-id`. The `task_id` of the
 * failed chain is never rebound.
 */
import {
  type Data,
  type Envelope,
  type ErrorRecord,
  type Operation,
  type RetryStage,
  type StartOptions,
  type Task,
  TERMINAL_STATES,
  integer,
  object,
  records,
  string,
} from "./contracts.js";
import { AgentLordError, usageError } from "./errors.js";
import { sha256 } from "./json.js";
import { pidAlive } from "./process.js";
import { StateStore, utcNow, validateIdentifier } from "./state.js";

export const INVALID_RETRY_POLICY = "claude-result-invalid";
export const INVALID_RETRY_BUDGET = 3;

/** The engine capabilities this module needs; `AgentLord` satisfies it. */
export interface RetryHost {
  store: StateStore;
  turn(
    taskId: string,
    message: string,
    opts?: Pick<StartOptions, "required_files" | "require_commit" | "invocation">,
  ): Promise<Envelope>;
  start(
    taskId: string,
    provider: string,
    target: string | null,
    message: string,
    opts?: StartOptions,
  ): Promise<Envelope>;
  envelope(op: Operation): Envelope;
}
export interface InvalidRetryOptions {
  replacement_task_id?: string;
  invocation?: unknown;
}
interface LedgerFailure extends Data {
  operation_id: string;
  fingerprint: string;
  observed_at: string;
}
interface LedgerAttempt extends Data {
  attempt: number;
  mode: "same-session" | "new-session";
  task_id: string;
  after_failure_operation_id: string;
  message_sha256: string;
  controller_pid: number;
  dispatched_at: string;
  operation_id: string | null;
  replacement_for?: string;
  forced_new_session?: boolean;
  parallel_role?: string;
}
interface Ledger extends Data {
  policy: typeof INVALID_RETRY_POLICY;
  budget: number;
  failures: LedgerFailure[];
  attempts: LedgerAttempt[];
}
/** Stable across attempts: the error's `code` plus `message` and nothing else. */
export function invalidFingerprint(error: ErrorRecord): string {
  return sha256(`${error.code}\0${error.message}`);
}
export function invalidRetryMessage(rootId: string, attempt: number, original: string): string {
  return `[agent-lord-invalid-retry:${rootId}:${attempt}]\n${original}`;
}
function ledgerOf(value: Operation): Ledger {
  const raw = object(value.invalid_retry_ledger);
  return {
    policy: INVALID_RETRY_POLICY,
    budget: integer(raw.budget) && raw.budget > 0 ? raw.budget : INVALID_RETRY_BUDGET,
    failures: records(raw.failures) as LedgerFailure[],
    attempts: records(raw.attempts) as LedgerAttempt[],
  };
}
function trailingStreak(failures: LedgerFailure[]): number {
  if (!failures.length) return 0;
  const last = failures.at(-1)!.fingerprint;
  let run = 0;
  for (let i = failures.length - 1; i >= 0 && failures[i].fingerprint === last; i--) run++;
  return run;
}
function requireInvalidFailure(op: Operation): ErrorRecord {
  if (op.provider !== "claude-cli")
    throw usageError("invalid-retry applies only to claude-cli operations", {
      operation_id: op.operation_id,
      provider: op.provider,
    });
  if (op.status !== "failed" || op.error?.code !== "RESULT_INVALID")
    throw new AgentLordError(
      "STATE_CONFLICT",
      "operation is not a terminal claude-cli RESULT_INVALID failure",
      {
        details: { operation_id: op.operation_id, status: op.status, error_code: op.error?.code ?? null },
        exit_code: 2,
      },
    );
  return op.error;
}
function frozenContract(task: Task | null, root: Operation): Data {
  const model = task ? task.contract.model : root.expected.model;
  const effort = task ? task.contract.effort : root.expected.effort;
  const readOnly = task ? task.contract.read_only : root.read_only;
  const source = object(task ? task.contract.source : root.source);
  const workspace = object(task ? task.contract.workspace : root.workspace);
  const retryPlan = task ? task.contract.retry_plan : root.expected.retry_plan;
  return { model, effort, read_only: readOnly, source, workspace, retry_plan: retryPlan };
}
function attachInfo(envelope: Envelope, info: Data): Envelope {
  return { ...envelope, invalid_retry: info };
}
type Decision =
  | { kind: "existing"; operationId: string }
  | { kind: "dispatch"; attempt: LedgerAttempt };
export async function retryResultInvalid(
  host: RetryHost,
  taskId: string,
  operationId: string,
  opts: InvalidRetryOptions = {},
): Promise<Envelope> {
  validateIdentifier("task_id", taskId);
  validateIdentifier("operation_id", operationId);
  const store = host.store;
  const failed = store.operation(operationId);
  if (failed.task_id !== taskId)
    throw new AgentLordError("ENDPOINT_MISMATCH", "operation does not belong to task_id", {
      details: { task_id: taskId, operation_id: operationId },
      exit_code: 2,
    });
  const failure = requireInvalidFailure(failed);
  const rootId = string(object(failed.invalid_retry).root_operation_id) ?? operationId;
  const root = rootId === operationId ? failed : store.operation(rootId);
  if (root.provider !== "claude-cli")
    throw new AgentLordError("STATE_CORRUPT", "invalid-retry lineage root is not a claude-cli operation", {
      details: { root_operation_id: rootId },
    });
  const fingerprint = invalidFingerprint(failure);
  let decision: Decision | undefined;
  let terminalInfo: Data | undefined;
  let refusal: AgentLordError | undefined;
  store.updateOperation(rootId, (value) => {
    const ledger = ledgerOf(value);
    // 1. Register this failure once, in invocation order.
    if (!ledger.failures.some((f) => f.operation_id === operationId))
      ledger.failures.push({ operation_id: operationId, fingerprint, observed_at: utcNow() });
    // 2. Success anywhere in the chain permanently stops the policy.
    for (const attempt of ledger.attempts)
      if (attempt.operation_id) {
        const op = store.operation(attempt.operation_id);
        if (op.status === "succeeded") {
          decision = { kind: "existing", operationId: op.operation_id };
          terminalInfo = { root_operation_id: rootId, outcome: "already-succeeded", attempt: attempt.attempt };
        }
      }
    if (decision) {
      value.invalid_retry_ledger = ledger;
      return value;
    }
    // 3. Idempotent replay: this failure already has a dispatched retry.
    const prior = ledger.attempts.find((a) => a.after_failure_operation_id === operationId);
    if (prior?.operation_id) {
      decision = { kind: "existing", operationId: prior.operation_id };
      terminalInfo = { root_operation_id: rootId, outcome: "already-dispatched", attempt: prior.attempt };
      value.invalid_retry_ledger = ledger;
      return value;
    }
    // 4. Re-entry after an interrupted dispatch: adopt the operation by its
    // deterministic marked-message sha, or take over a dead dispatcher.
    const last = ledger.attempts.at(-1);
    if (last && last.operation_id === null) {
      const candidate = store
        .operations(last.task_id)
        .find((op) => op.message_sha256 === last.message_sha256);
      if (candidate) {
        last.operation_id = candidate.operation_id;
        decision = { kind: "existing", operationId: candidate.operation_id };
        terminalInfo = { root_operation_id: rootId, outcome: "adopted", attempt: last.attempt };
      } else if (last.controller_pid !== process.pid && pidAlive(last.controller_pid)) {
        refusal = new AgentLordError("STATE_BUSY", "another invalid-retry dispatch for this lineage is in progress", {
          retryable: true,
          details: { root_operation_id: rootId, controller_pid: last.controller_pid },
        });
      } else {
        // Crashed before the operation existed: reuse the same budget slot.
        last.controller_pid = process.pid;
        last.dispatched_at = utcNow();
        decision = { kind: "dispatch", attempt: last };
      }
      value.invalid_retry_ledger = ledger;
      return value;
    }
    // 5. An unfinished retry operation is simply returned for supervision.
    if (last?.operation_id) {
      const op = store.operation(last.operation_id);
      if (!TERMINAL_STATES.has(op.status)) {
        decision = { kind: "existing", operationId: op.operation_id };
        terminalInfo = { root_operation_id: rootId, outcome: "in-flight", attempt: last.attempt };
        value.invalid_retry_ledger = ledger;
        return value;
      }
    }
    // 6. Budget: three retries after the original failure, shared across sessions.
    if (ledger.attempts.length >= ledger.budget) {
      refusal = new AgentLordError(
        "RETRY_BUDGET_EXHAUSTED",
        "the shared claude RESULT_INVALID retry budget is spent for this logical operation",
        {
          details: {
            root_operation_id: rootId,
            budget: ledger.budget,
            attempts: ledger.attempts.map((a) => ({
              attempt: a.attempt,
              mode: a.mode,
              task_id: a.task_id,
              operation_id: a.operation_id,
            })),
          },
          exit_code: 2,
        },
      );
      value.invalid_retry_ledger = ledger;
      return value;
    }
    // 7. Route: same saved task/session first; only after two consecutive
    // identical fingerprints does the next retry run in a new session/task.
    // A replacement session resets the identical-result streak (SKILL.md
    // "Replacement trigger"), so only failures observed in the session of the
    // failure being retried count toward the next replacement decision.
    const chainTask = failed.task_id;
    const attemptTaskOf = new Map(
      ledger.attempts
        .filter((a) => a.operation_id)
        .map((a) => [a.operation_id!, a.task_id]),
    );
    const streak = trailingStreak(
      ledger.failures.filter(
        (f) =>
          (attemptTaskOf.get(f.operation_id) ??
            store.operation(f.operation_id).task_id) === chainTask,
      ),
    );
    const durable = store.hasTask(chainTask);
    let mode: LedgerAttempt["mode"] = streak >= 2 ? "new-session" : "same-session";
    let forced = false;
    if (mode === "same-session" && !durable) {
      // A failed Claude start never published a durable task handle, so the
      // saved-session replay path cannot be used and the session identity
      // cannot be trusted for a same-endpoint retry. Missing identity is not
      // a silent replacement trigger: report the missing decision and let the
      // caller authorize the replacement session explicitly.
      if (opts.replacement_task_id) {
        mode = "new-session";
        forced = true;
      } else {
        refusal = new AgentLordError(
          "RECOVERY_UNAVAILABLE",
          "the failed operation has no durable task, so a same-session retry cannot be replayed; pass --replacement-task-id to explicitly authorize a replacement session",
          {
            requires_authorization: true,
            details: { root_operation_id: rootId, task_id: chainTask, streak },
          },
        );
        value.invalid_retry_ledger = ledger;
        return value;
      }
    }
    const number = ledger.attempts.length + 1;
    let attemptTask = chainTask;
    const parallelRole =
      string(object(failed.parallel_plan).role) ??
      string(object(root.parallel_plan).role);
    if (mode === "new-session") {
      attemptTask = opts.replacement_task_id ?? `${chainTask}-r${number}`;
      validateIdentifier("task_id", attemptTask);
      if (store.hasTask(attemptTask)) {
        refusal = usageError("replacement task_id already exists; pass a fresh --replacement-task-id", {
          replacement_task_id: attemptTask,
        });
        value.invalid_retry_ledger = ledger;
        return value;
      }
    }
    const attempt: LedgerAttempt = {
      attempt: number,
      mode,
      task_id: attemptTask,
      after_failure_operation_id: operationId,
      message_sha256: sha256(invalidRetryMessage(rootId, number, root.message)),
      controller_pid: process.pid,
      dispatched_at: utcNow(),
      operation_id: null,
      ...(mode === "new-session" ? { replacement_for: chainTask } : {}),
      ...(forced ? { forced_new_session: true } : {}),
      ...(parallelRole ? { parallel_role: parallelRole } : {}),
    };
    ledger.attempts.push(attempt);
    decision = { kind: "dispatch", attempt };
    value.invalid_retry_ledger = ledger;
    return value;
  });
  if (refusal) throw refusal;
  if (!decision) throw new AgentLordError("STATE_CORRUPT", "invalid-retry produced no decision");
  if (decision.kind === "existing") {
    // Crash window: the retry operation may exist (adopted, or dispatched just
    // before a controller death) without its `invalid_retry` root stamp. Every
    // operation on the chain must resolve back to the shared ledger
    // (protocol.md "Scripted Claude RESULT_INVALID retry"), so backfill it here.
    const existingId = decision.operationId;
    const existing = store.operation(existingId);
    if (!string(object(existing.invalid_retry).root_operation_id)) {
      const entry = ledgerOf(store.operation(rootId)).attempts.find(
        (a) => a.operation_id === existingId,
      );
      if (entry)
        store.updateOperation(existingId, (value) => ({
          ...value,
          invalid_retry: {
            root_operation_id: rootId,
            attempt: entry.attempt,
            mode: entry.mode,
            after_failure_operation_id: entry.after_failure_operation_id,
            ...(entry.replacement_for ? { replacement_for: entry.replacement_for } : {}),
          },
        }));
    }
    return attachInfo(host.envelope(store.operation(decision.operationId)), terminalInfo!);
  }
  const attempt = decision.attempt;
  const message = invalidRetryMessage(rootId, attempt.attempt, root.message);
  const chainTask = failed.task_id;
  const task = store.hasTask(chainTask) ? store.task(chainTask) : null;
  const delivery = root.delivery_requirements ?? null;
  const shared: Pick<StartOptions, "required_files" | "require_commit" | "invocation"> = {
    ...(delivery?.files?.length ? { required_files: delivery.files } : {}),
    ...(delivery?.require_commit ? { require_commit: true } : {}),
    ...(opts.invocation !== undefined ? { invocation: opts.invocation } : {}),
  };
  let envelope: Envelope;
  try {
    if (attempt.mode === "same-session") {
      envelope = await host.turn(chainTask, message, shared);
    } else {
      const contract = frozenContract(task, root);
      const workspace = object(contract.workspace);
      const source = object(contract.source);
      const startOpts: StartOptions = {
        ...shared,
        model: string(contract.model),
        effort: string(contract.effort),
        retry_plan: contract.retry_plan as RetryStage[],
        ...(contract.read_only ? { read_only: true } : {}),
        ...(string(source.head_sha) ? { head_sha: String(source.head_sha) } : {}),
        ...(string(source.base_sha) ? { base_sha: String(source.base_sha) } : {}),
      };
      let target: string | null = task?.target ?? root.target;
      if (workspace.policy && workspace.policy !== "exact-target") {
        target = null;
        startOpts.repository = String(workspace.repository);
        startOpts.source_branch = String(workspace.source_branch);
        startOpts.workspace_policy = workspace.policy as StartOptions["workspace_policy"];
        if (string(workspace.workspace_branch))
          startOpts.workspace_branch = String(workspace.workspace_branch);
      }
      envelope = await host.start(attempt.task_id, "claude-cli", target, message, startOpts);
    }
  } catch (error) {
    // A dispatched retry that ran and failed consumed the budget; only a
    // synchronous failure before any operation existed rolls the slot back.
    const created = store
      .operations(attempt.task_id)
      .find((op) => op.message_sha256 === attempt.message_sha256);
    store.updateOperation(rootId, (value) => {
      const ledger = ledgerOf(value);
      const index = ledger.attempts.findIndex(
        (a) => a.attempt === attempt.attempt && a.operation_id === null,
      );
      if (index >= 0) {
        if (created) {
          const entry = ledger.attempts[index];
          entry.operation_id = created.operation_id;
          if (
            created.status === "failed" &&
            created.error?.code === "RESULT_INVALID" &&
            !ledger.failures.some((f) => f.operation_id === created.operation_id)
          )
            ledger.failures.push({
              operation_id: created.operation_id,
              fingerprint: invalidFingerprint(created.error),
              observed_at: utcNow(),
            });
        } else ledger.attempts.splice(index, 1);
      }
      value.invalid_retry_ledger = ledger;
      return value;
    });
    if (created)
      store.updateOperation(created.operation_id, (value) => ({
        ...value,
        invalid_retry: {
          root_operation_id: rootId,
          attempt: attempt.attempt,
          mode: attempt.mode,
          after_failure_operation_id: operationId,
          ...(attempt.replacement_for ? { replacement_for: attempt.replacement_for } : {}),
        },
      }));
    throw error;
  }
  const retryOpId = string(envelope.operation_id);
  store.updateOperation(rootId, (value) => {
    const ledger = ledgerOf(value);
    const entry = ledger.attempts.find((a) => a.attempt === attempt.attempt);
    if (entry) entry.operation_id = retryOpId;
    if (retryOpId && envelope.status === "ERROR" && envelope.error?.code === "RESULT_INVALID")
      if (!ledger.failures.some((f) => f.operation_id === retryOpId))
        ledger.failures.push({
          operation_id: retryOpId,
          fingerprint: invalidFingerprint(envelope.error),
          observed_at: utcNow(),
        });
    value.invalid_retry_ledger = ledger;
    return value;
  });
  if (retryOpId)
    store.updateOperation(retryOpId, (value) => ({
      ...value,
      invalid_retry: {
        root_operation_id: rootId,
        attempt: attempt.attempt,
        mode: attempt.mode,
        after_failure_operation_id: operationId,
        ...(attempt.replacement_for ? { replacement_for: attempt.replacement_for } : {}),
      },
    }));
  const original = root.expected;
  const observed = object(envelope.expected as Data | undefined);
  const mismatched = ["model", "effort", "permission_mode", "permission_enforcement"].filter(
    (key) => original[key as keyof typeof original] !== observed[key],
  );
  store.event(
    attempt.task_id,
    "invalid-retry-dispatched",
    {
      root_operation_id: rootId,
      attempt: attempt.attempt,
      mode: attempt.mode,
      after_failure_operation_id: operationId,
      fingerprint,
      ...(attempt.replacement_for ? { replacement_for: attempt.replacement_for } : {}),
      ...(attempt.parallel_role ? { parallel_role: attempt.parallel_role } : {}),
    },
    retryOpId ?? undefined,
  );
  return attachInfo(envelope, {
    root_operation_id: rootId,
    attempt: attempt.attempt,
    mode: attempt.mode,
    budget: INVALID_RETRY_BUDGET,
    budget_remaining: INVALID_RETRY_BUDGET - attempt.attempt,
    ...(attempt.replacement_for ? { replacement_for: attempt.replacement_for } : {}),
    ...(attempt.forced_new_session ? { forced_new_session: true } : {}),
    ...(attempt.parallel_role ? { parallel_role: attempt.parallel_role } : {}),
    ...(mismatched.length ? { contract_mismatch: mismatched } : {}),
  });
}
