// Extracted from engine.ts: the operation-record kernel shared by every
// provider flow. Owns journal creation, status transitions, terminal
// failure shaping, and the finalize/publish path that turns a provider
// result into a succeeded operation bound to its task handle.
import { randomUUID } from "node:crypto";
import {
  type Data,
  type Envelope,
  type Expected,
  type Operation,
  type OperationStatus,
  type Provider,
  type ProviderResult,
  type RetryStage,
  type Source,
  type StartOptions,
  type Task,
  type Workspace,
  TERMINAL_STATES,
  integer,
  object,
  string,
} from "../contracts.js";
import {
  permissionModePolicy,
  permissionPolicy,
  providerConfig,
  resolveRetryPlan,
} from "../config.js";
import { AgentLordError, usageError } from "../errors.js";
import { equal, sha256 } from "../json.js";
import { utcNow } from "../state.js";
import { acquireLease, leaseId } from "../workspace.js";
import { sameInputs } from "../inputs.js";
import { sameDeliveryRequest, verifyDelivery } from "../delivery.js";
import { writeArtifact } from "../artifacts.js";
import type { AgentLord } from "../engine.js";

export class OperationKernel {
  constructor(private readonly engine: AgentLord) {}
  operationId(taskId: string, kind: string): string {
    return `${taskId.slice(0, 105)}-${kind}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }
  activeOperation(taskId: string): Operation | undefined {
    const active = this.engine.store
      .operations(taskId)
      .filter((op) => !TERMINAL_STATES.has(op.status));
    if (active.length > 1)
      throw new AgentLordError(
        "STATE_CORRUPT",
        "task has more than one in-flight operation",
        {
          details: {
            task_id: taskId,
            operation_ids: active.map((v) => v.operation_id),
          },
        },
      );
    return active[0];
  }
  expected(
    provider: Provider,
    model: string | null,
    effort: string | null,
    readOnly: boolean,
    retryPlan?: RetryStage[],
    mode?: string | null,
    continuationLimit?: number,
  ): Expected {
    const permission = mode
      ? permissionModePolicy(provider, mode)
      : permissionPolicy(provider, readOnly);
    if (readOnly !== (permission.mode === "read_only"))
      throw new AgentLordError(
        "STATE_CORRUPT",
        "saved permission mode contradicts the read-only contract",
        {
          details: {
            provider,
            permission_mode: permission.mode,
            read_only: readOnly,
          },
        },
      );
    const result: Expected = {
      model,
      effort,
      permission_mode: permission.mode,
      permission_enforcement: permission.enforcement,
      retry_plan: retryPlan ?? resolveRetryPlan(provider, model),
    };
    if (provider === "mcode-cli") {
      const limit =
        continuationLimit ??
        providerConfig(provider).same_session_continuations ??
        0;
      if (!integer(limit) || limit < 0 || limit > 5)
        throw usageError("MCode continuation limit must be between 0 and 5");
      result.continuation_limit = limit;
    }
    return result;
  }
  newOperation(
    taskId: string,
    provider: Provider,
    kind: string,
    target: string,
    message: string,
    expected: Expected,
    source: Source,
    readOnly: boolean,
    workspace?: Workspace,
    extra: Partial<Operation> = {},
  ): Operation {
    const now = utcNow();
    const op: Operation = {
      version: 1,
      operation_id: this.operationId(taskId, kind),
      task_id: taskId,
      provider,
      kind,
      target,
      status: "preparing",
      message,
      message_sha256: sha256(message),
      expected,
      observed: {},
      source,
      read_only: readOnly,
      ...(workspace ? { workspace } : {}),
      parallel_plan: {},
      artifact: null,
      error: null,
      created_at: now,
      updated_at: now,
      ...extra,
    };
    if (op.delivery_requirements == null) delete op.delivery_requirements;
    this.engine.store.createOperation(op);
    this.engine.store.event(
      taskId,
      "operation-created",
      { kind, provider },
      op.operation_id,
    );
    return op;
  }
  setStatus(
    id: string,
    status: OperationStatus,
    fields: Partial<Operation> = {},
  ): Operation {
    return this.engine.store.updateOperation(id, (value) => ({
      ...value,
      status,
      ...fields,
      ...(TERMINAL_STATES.has(status) ? { completed_at: utcNow() } : {}),
    }));
  }
  taskRecord(op: Operation, endpoint: string, host: string | null): Task {
    const now = utcNow();
    const task: Task = {
      version: 2,
      task_id: op.task_id,
      provider: op.provider,
      endpoint_id: endpoint,
      target: op.target,
      route: {
        host_id: host,
        resolved_at: now,
        history: host
          ? [{ host_id: host, observed_at: now, reason: "endpoint-created" }]
          : [],
      },
      contract: {
        model: op.expected.model,
        effort: op.expected.effort,
        read_only: op.read_only,
        permission_mode: op.expected.permission_mode,
        source: op.source,
        retry_plan: op.expected.retry_plan,
        ...(op.workspace ? { workspace: op.workspace } : {}),
        parallel_plan: op.parallel_plan ?? {},
        ...(op.expected.continuation_limit !== undefined
          ? { continuation_limit: op.expected.continuation_limit }
          : {}),
      },
      created_at: now,
      updated_at: now,
      last_operation_id: op.operation_id,
    };
    if (op.kind === "handoff" && op.handoff) {
      const source = object(op.handoff.source_session);
      task.lineage = {
        kind: "handoff",
        handoff_id: op.handoff.handoff_id,
        handoff_operation_id: op.operation_id,
        packet_sha256: object(op.handoff.packet).sha256,
        source_session_kind: source.kind,
        source_session_id: source.opaque_id,
        source_session_identity: source.identity_assurance,
        relationship: "continues_user_task",
      };
    }
    return task;
  }
  setLast(taskId: string, id: string): Task {
    return this.engine.store.updateTask(taskId, (value) => ({
      ...value,
      last_operation_id: id,
    }));
  }
  fail(op: Operation, error: AgentLordError): Operation {
    const updated = this.engine.store.updateOperation(
      op.operation_id,
      (value) => {
        value.status = error.requires_authorization
          ? "needs_decision"
          : "failed";
        value.error = error.asRecord();
        value.completed_at = utcNow();
        if (value.provider === "mcode-cli") {
          if (value.active_attempt) value.last_attempt = value.active_attempt;
          value.active_attempt = null;
          value.observed = {
            ...value.observed,
            supervision: {
              ...object(value.observed.supervision),
              state: "provider_failed",
              active_tool_count: 0,
              active_tools: [],
            },
          };
        }
        if (value.artifact) {
          value.invalidated_artifact = value.artifact;
          value.artifact = null;
        }
        return value;
      },
    );
    this.engine.store.event(
      op.task_id,
      "operation-failed",
      error.asRecord() as unknown as Data,
      op.operation_id,
    );
    return updated;
  }
  terminalize(
    op: Operation,
    error: AgentLordError,
    exhausted = false,
  ): [Operation, AgentLordError] {
    const recovery =
      op.provider === "mcode-cli"
        ? this.engine.mcode.mcodeContinuation(op, error)
        : null;
    const terminal = new AgentLordError(error.code, error.message, {
      retryable: exhausted ? false : recovery !== null || error.retryable,
      safe_recovery: exhausted
        ? undefined
        : recovery
          ? "CONTINUE_SAME_SESSION"
          : error.safe_recovery,
      requires_authorization: error.requires_authorization,
      details: {
        ...error.details,
        ...(recovery ? { recovery } : {}),
        attempts: op.attempt_history ?? [],
        retry_exhausted: exhausted,
      },
      exit_code: error.exit_code,
    });
    return [this.fail(op, terminal), terminal];
  }
  raiseFailure(op: Operation, error: AgentLordError, exhausted = false): never {
    const [failed, terminal] = this.terminalize(op, error, exhausted);
    throw new AgentLordError(terminal.code, terminal.message, {
      ...terminal,
      details: {
        ...terminal.details,
        operation_id: failed.operation_id,
        task_id: failed.task_id,
      },
    });
  }
  sameStart(
    op: Operation,
    kind: string,
    provider: Provider,
    target: string,
    message: string,
    expected: Expected,
    source: Source,
    readOnly: boolean,
    workspace: Workspace | undefined,
    plan: Data,
    opts: StartOptions,
    handoff?: Data,
  ): boolean {
    return (
      op.kind === kind &&
      op.provider === provider &&
      op.target === target &&
      op.message_sha256 === sha256(message) &&
      equal(op.expected, expected) &&
      equal(op.source, source) &&
      op.read_only === readOnly &&
      (object(op.workflow).run_id ?? undefined) === opts.workflow_run_id &&
      equal(op.workspace ?? {}, workspace ?? {}) &&
      (handoff
        ? object(op.handoff).handoff_id === handoff.handoff_id &&
          object(object(op.handoff).packet).sha256 ===
            object(handoff.packet).sha256
        : equal(op.parallel_plan ?? {}, plan) &&
          sameInputs(op, opts.required_inputs) &&
          sameDeliveryRequest(
            op,
            opts.required_files,
            Boolean(opts.require_commit),
          ))
    );
  }
  async publish(
    op: Operation,
    result: ProviderResult,
    resume: boolean,
  ): Promise<Envelope> {
    const lease = await acquireLease(
      "finalize",
      leaseId("finalize", op.operation_id),
      this.engine.root,
      this.engine.control,
      "another process is finalizing this operation",
    );
    try {
      const current = this.engine.store.operation(op.operation_id);
      if (current.status === "succeeded") return this.engine.envelope(current);
      if (TERMINAL_STATES.has(current.status))
        throw new AgentLordError(
          "STATE_CONFLICT",
          "CLI operation was finalized with a different terminal result",
          {
            details: { operation_id: op.operation_id, status: current.status },
          },
        );
      const artifact = writeArtifact(
        op.task_id,
        op.operation_id,
        result.assistant_text,
        this.engine.root,
      );
      if (!resume) {
        if (this.engine.store.hasTask(op.task_id)) {
          const task = this.engine.store.task(op.task_id);
          if (
            task.endpoint_id !== result.endpoint_id ||
            task.last_operation_id !== op.operation_id
          )
            throw new AgentLordError(
              "IDENTITY_CONFLICT",
              "existing task handle does not match the recovered CLI start",
            );
        } else
          this.engine.store.createTask(
            this.taskRecord(current, result.endpoint_id, null),
          );
      } else this.setLast(op.task_id, op.operation_id);
      const updated = this.setStatus(op.operation_id, "succeeded", {
        delivery: verifyDelivery(current),
        observed: object(result.observed),
        artifact,
        error: null,
        provider_command: result.command,
        stdout_path: result.stdout_path,
        stderr_path: result.stderr_path,
        endpoint_id: result.endpoint_id,
        active_attempt: null,
        ...(result.result_path ? { result_path: result.result_path } : {}),
      });
      this.engine.store.event(
        op.task_id,
        "operation-succeeded",
        { artifact },
        op.operation_id,
      );
      return this.engine.envelope(updated);
    } finally {
      lease.release();
    }
  }
  resultGrace(op: Operation): boolean {
    const seen = op.dead_process_observed_at_ms;
    if (!integer(seen)) {
      this.setStatus(op.operation_id, op.status, {
        dead_process_observed_at_ms: Date.now(),
      });
      return true;
    }
    return (
      Date.now() - seen <
      this.engine.control.dead_process_result_grace_seconds * 1000
    );
  }
}
