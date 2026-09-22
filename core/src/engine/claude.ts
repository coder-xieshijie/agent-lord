// Extracted from engine.ts: Claude CLI attempt bookkeeping, model-fallback
// retry, deterministic recovery controllers, and dead-controller
// supervision.
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  type Data,
  type Envelope,
  type Operation,
  type ProviderResult,
  TERMINAL_STATES,
  integer,
  object,
  records,
  string,
} from "../contracts.js";
import { AgentLordError } from "../errors.js";
import { type Lease, validateIdentifier, withAsyncLock } from "../state.js";
import { acquireLease, leaseId } from "../workspace.js";
import {
  claudeOutputActivityMs,
  claudeSessionObserved,
  recoverClaude,
  runClaude,
} from "../providers/claude-cli.js";
import { pidAlive, terminateProcess } from "../process.js";
import type { AgentLord } from "../engine.js";

export class ClaudeFlows {
  constructor(private readonly engine: AgentLord) {}
  private retryModels(op: Operation): string[] {
    return op.expected.retry_plan.flatMap((stage) =>
      stage.model ? Array<string>(stage.attempts).fill(stage.model) : [],
    );
  }
  private claudeDeliveryRequiresContinuation(op: Operation): boolean {
    return [...(op.attempt_history ?? []), object(op.active_attempt)].some(
      (attempt) =>
        ["delivery-unknown", "stdin-attached"].includes(
          String(attempt.prompt_delivery),
        ),
    );
  }
  private recordClaudeAttempt(
    op: Operation,
    number: number,
    model: string,
    status: string,
    opts: {
      error?: AgentLordError;
      sessionObserved?: boolean;
      retrying?: boolean;
      claim?: boolean;
      warnings?: Data[];
    } = {},
  ): Operation {
    const warnings = (opts.warnings ?? []).map((v) =>
      Object.fromEntries(
        ["code", "source", "model"].filter((k) => k in v).map((k) => [k, v[k]]),
      ),
    );
    const updated = this.engine.store.updateOperation(
      op.operation_id,
      (value) => {
        const active = object(value.active_attempt);
        const entry: Data = { number, model, status };
        for (const key of [
          "attempt_id",
          "prompt_kind",
          "recovery_marker",
          "prompt_delivery",
          "prompt_delivered_at_ms",
          "progress_seq",
        ])
          if (active[key] != null) entry[key] = active[key];
        if (opts.error) entry.error = opts.error.asRecord();
        if (opts.sessionObserved !== undefined)
          entry.session_observed = opts.sessionObserved;
        if (warnings.length) entry.warnings = warnings;
        value.attempt_history = [...(value.attempt_history ?? []), entry];
        if (status === "failed") {
          value.active_attempt = null;
          if (opts.retrying) {
            value.status = "recovering";
            value.controller_pid = value.recovery_controller_pid =
              opts.claim === false ? null : process.pid;
          }
          value.observed = {
            ...value.observed,
            supervision: {
              state: opts.retrying
                ? "recovering"
                : opts.error?.code !== "PROVIDER_STALLED"
                  ? "provider_failed"
                  : "suspected_stall",
              attempt: number,
              error_code: opts.error?.code ?? null,
            },
          };
        }
        return value;
      },
    );
    this.engine.store.event(
      op.task_id,
      `provider-attempt-${status}`,
      { attempt: number, model, error: opts.error?.asRecord() ?? null },
      op.operation_id,
    );
    for (const warning of warnings)
      this.engine.store.event(
        op.task_id,
        "provider-attempt-warning",
        { attempt: number, ...warning },
        op.operation_id,
      );
    return updated;
  }
  async finishClaude(op: Operation, resume: boolean): Promise<Envelope> {
    const models = this.retryModels(op);
    if (!models.length)
      throw new AgentLordError(
        "STATE_CORRUPT",
        "Claude operation has no retry plan",
      );
    let current = this.engine.store.operation(op.operation_id);
    const start = (current.attempt_history ?? []).length;
    let attemptResume =
      resume ||
      (start > 0 && claudeSessionObserved(current)) ||
      this.claudeDeliveryRequiresContinuation(current);
    let reason =
      string(object(current.attempt_history?.at(-1)?.error).code) ||
      "PROVIDER_FAILED";
    for (let index = start; index < models.length; index++) {
      const model = models[index];
      let prompt = op.message;
      let kind = "original";
      let marker: string | null = null;
      if (index > 0 && attemptResume) {
        marker = `agent-lord-recovery:${op.operation_id}:${index + 1}`;
        kind = "continuation";
        prompt = `[${marker}]\nContinue the same task in this existing Claude session after the previous provider attempt ended with ${reason}. Inspect the conversation and current worktree first, do not repeat work that is already complete, then finish the original request and return its final answer.\n`;
        current = this.engine.ops.setStatus(op.operation_id, "recovering", {
          recovery_controller_pid: process.pid,
          observed: {
            ...current.observed,
            supervision: {
              state: "recovering",
              attempt: index + 1,
              reason,
              recovery_marker: marker,
            },
          },
        });
        this.engine.store.event(
          op.task_id,
          "provider-recovery-query-prepared",
          { attempt: index + 1, reason, recovery_marker: marker },
          op.operation_id,
        );
      }
      let result: ProviderResult;
      try {
        result = await runClaude(
          this.engine.store,
          op,
          this.engine.control,
          model,
          index + 1,
          attemptResume,
          prompt,
          kind,
          marker,
        );
      } catch (error) {
        if (!(error instanceof AgentLordError) || error.code === "STATE_BUSY")
          throw error;
        current = this.engine.store.operation(op.operation_id);
        const sessionObserved = claudeSessionObserved(current);
        attemptResume ||=
          sessionObserved || this.claudeDeliveryRequiresContinuation(current);
        const retrying = error.retryable && index + 1 < models.length;
        current = this.recordClaudeAttempt(
          current,
          index + 1,
          model,
          "failed",
          { error, sessionObserved, retrying },
        );
        reason = error.code;
        if (!retrying)
          return this.engine.ops.raiseFailure(current, error, error.retryable);
        continue;
      }
      current = this.recordClaudeAttempt(op, index + 1, model, "succeeded", {
        warnings: records(object(result.observed).warnings),
      });
      result.observed = {
        ...object(result.observed),
        attempts: current.attempt_history!.length,
        attempt_history: current.attempt_history,
        requested_model: op.expected.model,
        fallback_used: model !== op.expected.model,
      };
      return this.engine.ops.publish(current, result, resume);
    }
    throw new AgentLordError(
      "STATE_CORRUPT",
      "Claude retry plan was exhausted without a terminal result",
    );
  }
  // Checkpoint takes over only after the original controller has released its lease.
  claudeController(op: Operation): unknown {
    return (
      object(op.active_attempt).controller_pid ||
      op.recovery_controller_pid ||
      op.controller_pid
    );
  }
  private retryOrTerminalizeClaude(
    op: Operation,
    error: AgentLordError,
    sessionObserved: boolean,
  ): [Operation | null, Envelope | null] {
    const active = object(op.active_attempt);
    const models = this.retryModels(op);
    if (!integer(active.number) || !string(active.model))
      return [
        null,
        this.engine.envelope(this.engine.ops.terminalize(op, error)[0]),
      ];
    const retrying =
      error.retryable && (op.attempt_history ?? []).length + 1 < models.length;
    const updated = this.recordClaudeAttempt(
      op,
      active.number,
      String(active.model),
      "failed",
      { error, sessionObserved, retrying, claim: false },
    );
    return retrying
      ? [updated, null]
      : [
          null,
          this.engine.envelope(
            this.engine.ops.terminalize(updated, error, error.retryable)[0],
          ),
        ];
  }
  async recoverClaudeOperation(operationId: string): Promise<Envelope> {
    validateIdentifier("operation_id", operationId);
    const lease = await acquireLease(
      "controller-lease",
      leaseId("controller", operationId),
      this.engine.root,
      this.engine.control,
      "another controller owns this recovery",
    );
    try {
      let op = this.engine.store.operation(operationId);
      if (TERMINAL_STATES.has(op.status)) return this.engine.envelope(op);
      if (op.provider !== "claude-cli" || op.status !== "recovering")
        throw new AgentLordError(
          "STATE_CONFLICT",
          "operation is not awaiting Claude recovery",
          { details: { operation_id: operationId, status: op.status } },
        );
      if (op.recovery_controller_pid !== process.pid) {
        if (pidAlive(op.recovery_controller_pid))
          return this.engine.envelope(op);
        op = this.engine.ops.setStatus(operationId, "recovering", {
          recovery_controller_pid: process.pid,
          controller_pid: process.pid,
        });
      }
      let writes: Lease | undefined;
      try {
        writes = this.engine.workspaces.writeLeases(
          op.target,
          op.read_only,
          op.workspace ?? { policy: "exact-target" },
          operationId,
          op.task_id,
        );
        return await this.finishClaude(op, op.kind === "turn");
      } catch (error) {
        const current = this.engine.store.operation(operationId);
        if (TERMINAL_STATES.has(current.status))
          return this.engine.envelope(current);
        if (
          error instanceof AgentLordError &&
          [
            "STATE_BUSY",
            "WORKSPACE_WRITE_CONFLICT",
            "BRANCH_WRITE_CONFLICT",
          ].includes(error.code)
        )
          return this.engine.envelope(current);
        throw error;
      } finally {
        writes?.release();
      }
    } finally {
      lease.release();
    }
  }
  private async launchClaudeRecovery(
    operationId: string,
  ): Promise<Envelope | null> {
    try {
      return await withAsyncLock(
        "controller-lease",
        leaseId("controller", operationId),
        this.engine.root,
        async () => {
          const op = this.engine.store.operation(operationId);
          if (TERMINAL_STATES.has(op.status)) return this.engine.envelope(op);
          if (
            op.provider !== "claude-cli" ||
            op.status !== "recovering" ||
            pidAlive(op.recovery_controller_pid)
          )
            return null;
          const budget = this.retryModels(op).length;
          const attempts = (op.attempt_history ?? []).length;
          const launches =
            integer(op.recovery_controller_launches) &&
            op.recovery_controller_launches >= 0
              ? op.recovery_controller_launches
              : 0;
          if (attempts >= budget || launches >= Math.max(1, budget))
            return this.engine.envelope(
              this.engine.ops.terminalize(
                op,
                new AgentLordError(
                  "PROVIDER_FAILED",
                  "Claude recovery budget is exhausted",
                  {
                    details: {
                      attempts,
                      retry_budget: budget,
                      controller_launches: launches,
                    },
                  },
                ),
                true,
              )[0],
            );
          if (!op.endpoint_id)
            return this.engine.envelope(
              this.engine.ops.terminalize(
                op,
                new AgentLordError(
                  "PROCESS_EXITED_WITHOUT_RESULT",
                  "Claude recovery cannot continue without the original session identity",
                  { details: { operation_id: operationId } },
                ),
              )[0],
            );
          const source = import.meta.url.endsWith(".ts");
          // This module lives in engine/, one level below the worker script.
          const worker = fileURLToPath(
            new URL(
              source ? "../recovery-worker.ts" : "../recovery-worker.js",
              import.meta.url,
            ),
          );
          // Resolve the development loader before changing the worker's working directory.
          const args = [
            ...(source
              ? ["--import", createRequire(import.meta.url).resolve("tsx")]
              : []),
            worker,
            "--state-dir",
            this.engine.root,
            "--operation-id",
            operationId,
          ];
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(process.execPath, args, {
              stdio: "ignore",
              detached: process.platform !== "win32",
              windowsHide: true,
            });
            await new Promise<void>((resolve, reject) => {
              child.once("spawn", resolve);
              child.once("error", reject);
            });
          } catch (error) {
            return this.engine.envelope(
              this.engine.ops.terminalize(
                op,
                new AgentLordError(
                  "PROVIDER_UNAVAILABLE",
                  "cannot launch the deterministic Claude recovery controller",
                  { details: { error: String(error) } },
                ),
              )[0],
            );
          }
          this.engine.ops.setStatus(operationId, "recovering", {
            recovery_controller_pid: child.pid!,
            controller_pid: child.pid!,
            recovery_controller_launches: launches + 1,
          });
          this.engine.store.event(
            op.task_id,
            "provider-recovery-controller-launched",
            { controller_pid: child.pid, launch: launches + 1 },
            operationId,
          );
          child.unref();
          return null;
        },
      );
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "STATE_BUSY")
        return null;
      throw error;
    }
  }
  async superviseClaude(initial: Operation): Promise<Envelope | null> {
    const id = initial.operation_id;
    if (initial.status === "recovering" && !initial.active_attempt)
      return this.launchClaudeRecovery(id);
    if (pidAlive(this.claudeController(initial))) return null;
    let recovery: Operation | null = null;
    try {
      const envelope = await withAsyncLock(
        "controller-lease",
        leaseId("controller", id),
        this.engine.root,
        async (): Promise<Envelope | null> => {
          let op = this.engine.store.operation(id);
          if (TERMINAL_STATES.has(op.status)) return this.engine.envelope(op);
          if (pidAlive(this.claudeController(op))) return null;
          const active = object(op.active_attempt);
          const pid = active.pid || op.pid;
          let failure: AgentLordError | null = null;
          const terminal = (error: AgentLordError) =>
            this.engine.envelope(this.engine.ops.terminalize(op, error)[0]);
          const fence = () =>
            terminateProcess(
              pid,
              active.process_group_id,
              this.engine.control.claude_terminate_grace_seconds,
            );
          if (op.status === "preparing") {
            const delivery = active.prompt_delivery;
            if (
              ["delivery-unknown", "stdin-attached"].includes(
                String(delivery),
              ) &&
              !integer(pid)
            )
              return terminal(
                new AgentLordError(
                  "DELIVERY_UNKNOWN",
                  "Claude may have received the prompt but its provider process cannot be fenced",
                  { details: { operation_id: id, prompt_delivery: delivery } },
                ),
              );
            try {
              if (integer(pid) && pidAlive(pid)) await fence();
            } catch (error) {
              if (error instanceof AgentLordError) return terminal(error);
              throw error;
            }
            if (Object.keys(active).length)
              failure = new AgentLordError(
                "CONTROLLER_EXITED_DURING_DELIVERY",
                "Claude controller exited before attempt delivery was resolved",
                {
                  retryable: true,
                  safe_recovery:
                    delivery === "not-delivered"
                      ? "RETRY_ORIGINAL_PROMPT"
                      : "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                  details: { prompt_delivery: delivery },
                },
              );
            else if (this.retryModels(op).length && op.endpoint_id) {
              recovery = this.engine.ops.setStatus(id, "recovering", {
                controller_pid: null,
                recovery_controller_pid: null,
              });
              return null;
            } else
              return terminal(
                new AgentLordError(
                  "PROCESS_EXITED_WITHOUT_RESULT",
                  "Claude controller exited before a recoverable attempt was prepared",
                ),
              );
          } else if (pidAlive(pid)) {
            const activity = claudeOutputActivityMs(op);
            const stall =
              active.progress_state === "tool_wait"
                ? this.engine.control.claude_tool_stall_seconds
                : this.engine.control.claude_stall_seconds;
            if (activity === null || Date.now() - activity < stall * 1000)
              return null;
            this.engine.ops.setStatus(id, op.status, {
              observed: {
                ...op.observed,
                supervision: {
                  state: "suspected_stall",
                  attempt: active.number,
                  last_progress_at_ms: activity,
                  controller_state: "dead",
                },
              },
            });
            try {
              await fence();
            } catch (error) {
              if (error instanceof AgentLordError) return terminal(error);
              throw error;
            }
            failure = new AgentLordError(
              "PROVIDER_STALLED",
              "Claude controller disappeared and the live provider attempt stopped making progress",
              {
                retryable: true,
                safe_recovery: "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                details: { provider_pid: pid },
              },
            );
          } else {
            try {
              if (integer(pid)) await fence();
            } catch (error) {
              if (error instanceof AgentLordError) return terminal(error);
              throw error;
            }
            let result: ProviderResult | undefined;
            try {
              result = recoverClaude(op);
            } catch (error) {
              if (!(error instanceof AgentLordError)) throw error;
              failure = error;
              if (error.code === "RESULT_INVALID") {
                if (this.engine.ops.resultGrace(op)) return null;
                failure = new AgentLordError(
                  "PROCESS_EXITED_WITHOUT_RESULT",
                  "Claude process exited without publishing a recoverable terminal result",
                  {
                    retryable: true,
                    safe_recovery:
                      "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                    details: { provider_error: error.asRecord() },
                  },
                );
              }
            }
            if (result) {
              if (!result.endpoint_id)
                return terminal(
                  new AgentLordError(
                    "RESULT_INVALID",
                    "recovered Claude result lacks endpoint identity",
                  ),
                );
              if (integer(active.number) && string(active.model))
                op = this.recordClaudeAttempt(
                  op,
                  active.number,
                  String(active.model),
                  "succeeded",
                  { warnings: records(object(result.observed).warnings) },
                );
              result.observed = {
                ...object(result.observed),
                attempts: (op.attempt_history ?? []).length,
                attempt_history: op.attempt_history ?? [],
                requested_model: op.expected.model,
                fallback_used:
                  !!string(active.model) && active.model !== op.expected.model,
              };
              return this.engine.ops.publish(op, result, op.kind === "turn");
            }
          }
          const [claim, terminalEnvelope] = this.retryOrTerminalizeClaude(
            op,
            failure!,
            claudeSessionObserved(op),
          );
          recovery = claim;
          return terminalEnvelope;
        },
      );
      if (envelope) return envelope;
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "STATE_BUSY")
        return null;
      throw error;
    }
    return recovery ? this.launchClaudeRecovery(id) : null;
  }
}
