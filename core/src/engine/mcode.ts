// Extracted from engine.ts: MCode CLI task binding, the verified
// same-session continuation gate, and dead-controller supervision.
import {
  type Data,
  type Envelope,
  type Operation,
  type ProviderResult,
  type Task,
  TERMINAL_STATES,
  integer,
  object,
  string,
} from "../contracts.js";
import { AgentLordError } from "../errors.js";
import { withAsyncLock } from "../state.js";
import { leaseId } from "../workspace.js";
import { recoverMcode } from "../providers/mcode-cli.js";
import {
  groupAlive,
  pidAlive,
  processIdentityMatches,
  terminateProcess,
} from "../process.js";
import type { AgentLord } from "../engine.js";

export class McodeFlows {
  constructor(private readonly engine: AgentLord) {}
  ensureMcodeTask(id: string, endpoint: string): Task {
    const op = this.engine.store.operation(id);
    let task: Task;
    if (this.engine.store.hasTask(op.task_id))
      task = this.engine.store.task(op.task_id);
    else {
      try {
        return this.engine.store.createTask(
          this.engine.ops.taskRecord(op, endpoint, null),
        );
      } catch (error) {
        if (
          !(error instanceof AgentLordError) ||
          error.code !== "IDENTITY_CONFLICT"
        )
          throw error;
        task = this.engine.store.task(op.task_id);
      }
    }
    if (task.endpoint_id !== endpoint || task.last_operation_id !== id)
      throw new AgentLordError(
        "IDENTITY_CONFLICT",
        "existing task handle does not match the observed MCode Session",
        {
          details: {
            task_id: op.task_id,
            expected_endpoint_id: endpoint,
            observed_endpoint_id: task.endpoint_id,
          },
        },
      );
    return task;
  }
  mcodeContinuation(op: Operation, error: AgentLordError): Data | null {
    const d = error.details;
    const providerError = object(d.provider_error);
    const limit = op.expected.continuation_limit ?? 0;
    const chain = op.continuation ?? {};
    const used = chain.attempt ?? 0;
    if (
      op.provider !== "mcode-cli" ||
      error.code !== "PROVIDER_FAILED" ||
      error.requires_authorization ||
      !["failed", "timeout"].includes(String(d.provider_status)) ||
      providerError.retryable !== true ||
      providerError.category !== "runtime" ||
      d.model_verified !== true ||
      d.return_code !== 4 ||
      op.provider_return_code !== 4 ||
      !op.endpoint_id ||
      d.session_id !== op.endpoint_id ||
      !integer(limit) ||
      limit <= 0 ||
      limit > 5 ||
      !integer(used) ||
      used < 0 ||
      used >= limit
    )
      return null;
    const attempt = op.active_attempt || object(op.last_attempt);
    const pid = attempt.pid || op.pid;
    if (!integer(pid) || pid <= 0 || groupAlive(pid, attempt.process_group_id))
      return null;
    return {
      kind: "continue_same_session",
      task_id: op.task_id,
      operation_id: op.operation_id,
      root_operation_id: chain.root_operation_id ?? op.operation_id,
      attempt: used + 1,
      limit,
    };
  }
  async superviseMcode(initial: Operation): Promise<Envelope | null> {
    if (pidAlive(initial.controller_pid)) return null;
    const id = initial.operation_id;
    try {
      return await withAsyncLock(
        "operation-control",
        leaseId("control", id),
        this.engine.root,
        async () => {
          const op = this.engine.store.operation(id);
          if (TERMINAL_STATES.has(op.status)) return this.engine.envelope(op);
          if (pidAlive(op.controller_pid)) return null;
          const a = object(op.active_attempt);
          const pid = a.pid || op.pid;
          const group = a.process_group_id;
          const fail = (error: AgentLordError) =>
            this.engine.envelope(this.engine.ops.fail(op, error));
          if (op.status === "preparing" && !op.provider_command)
            return fail(
              new AgentLordError(
                "PROCESS_EXITED_WITHOUT_RESULT",
                "MCode controller exited before its provider attempt was prepared",
                {
                  retryable: true,
                  safe_recovery: "RETRY_SAME_COMMAND",
                  details: { operation_id: id },
                },
              ),
            );
          if (op.status === "preparing" && !integer(pid))
            return fail(
              new AgentLordError(
                "DELIVERY_UNKNOWN",
                "MCode controller exited while launching its provider attempt and no operation process can be fenced",
                {
                  requires_authorization: true,
                  details: {
                    operation_id: id,
                    prompt_delivery: a.prompt_delivery,
                  },
                },
              ),
            );
          if (integer(pid) && groupAlive(pid, group)) {
            if (
              !processIdentityMatches(
                pid,
                group,
                a.result_path || op.result_path,
              )
            )
              return fail(
                new AgentLordError(
                  "PROCESS_FENCE_FAILED",
                  "MCode operation process identity cannot be bound to this journal before fencing",
                  { details: { pid, process_group_id: group } },
                ),
              );
            try {
              await terminateProcess(
                pid,
                group,
                this.engine.control.mcode_terminate_grace_seconds,
              );
            } catch (error) {
              if (error instanceof AgentLordError) return fail(error);
              throw error;
            }
          }
          let result: ProviderResult;
          try {
            result = recoverMcode(op);
          } catch (error) {
            if (!(error instanceof AgentLordError)) throw error;
            let failure = error;
            const current = this.engine.store.operation(id);
            if (current.endpoint_id)
              this.ensureMcodeTask(id, current.endpoint_id);
            if (
              error.code === "RESULT_INVALID" &&
              (error.message.includes("exactly one final exec.completed") ||
                error.message === "MCode stream is empty")
            ) {
              if (this.engine.ops.resultGrace(current)) return null;
              failure = new AgentLordError(
                "DELIVERY_UNKNOWN",
                "MCode operation ended without a complete terminal record; the prompt will not be resent",
                {
                  requires_authorization: true,
                  details: {
                    operation_id: id,
                    endpoint_id: current.endpoint_id ?? null,
                    provider_error: error.asRecord(),
                  },
                },
              );
            }
            return this.engine.envelope(
              this.engine.ops.terminalize(current, failure)[0],
            );
          }
          if (!result.endpoint_id)
            return fail(
              new AgentLordError(
                "RESULT_INVALID",
                "recovered MCode result lacks Session identity",
              ),
            );
          this.ensureMcodeTask(id, result.endpoint_id);
          return this.engine.ops.publish(op, result, op.kind === "turn");
        },
      );
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "STATE_BUSY")
        return null;
      throw error;
    }
  }
}
