// Extracted from engine.ts: the Codex App action accept state machine
// plus Codex CLI dead-controller supervision.
import {
  type Action,
  type Data,
  type Envelope,
  type Operation,
  type ProviderResult,
  type Task,
  object,
  string,
} from "../contracts.js";
import { AgentLordError } from "../errors.js";
import { sha256, stringifyJson } from "../json.js";
import { utcNow, withAsyncLock, withLock } from "../state.js";
import { leaseId } from "../workspace.js";
import { extractCodexResult, writeArtifact } from "../artifacts.js";
import {
  ROUTE_STALE_FRAGMENT,
  appError,
  endpointIdentity,
  findThread,
  operationMarker,
  threadStatus,
  unwrapResult,
} from "../providers/codex-app.js";
import { recoverCodex } from "../providers/codex-cli.js";
import { pidAlive } from "../process.js";
import type { AgentLord } from "../engine.js";

export class CodexAppFlows {
  constructor(private readonly engine: AgentLord) {}
  private appObservation(op: Operation, fields: Data): Data {
    return {
      execution_contract: "model-effort-tool-arguments",
      permission_mode: op.expected.permission_mode,
      permission_enforcement: op.expected.permission_enforcement,
      ...fields,
    };
  }
  private markAction(
    id: string,
    status: Action["status"],
    result: unknown = null,
    error: AgentLordError | null = null,
  ): Action {
    return this.engine.store.updateAction(id, (value) => ({
      ...value,
      status,
      result_sha256: result === null ? null : sha256(stringifyJson(result)),
      error: error?.asRecord() ?? null,
      completed_at: utcNow(),
    }));
  }
  private rebindTask(id: string, host: string, reason: string): Task {
    return this.engine.store.updateTask(id, (value) => {
      const route = value.route;
      if (route.host_id !== host)
        route.history.push({
          host_id: host,
          observed_at: utcNow(),
          reason,
          previous_host_id: route.host_id,
        });
      route.host_id = host;
      route.resolved_at = utcNow();
      return value;
    });
  }
  accept(actionId: string, raw: unknown, autoRead = false): Envelope {
    const initial = this.engine.store.action(actionId);
    return withLock(
      "operation-control",
      leaseId("control", initial.operation_id),
      this.engine.root,
      () => {
        const action = this.engine.store.action(actionId);
        const op = this.engine.store.operation(action.operation_id);
        if (action.status !== "pending") return this.engine.envelope(op);
        const result = unwrapResult(raw);
        const providerError = appError(result);
        const failed = (error: AgentLordError, accepted = false): Envelope => {
          const updated = this.engine.ops.fail(op, error);
          this.markAction(
            actionId,
            accepted ? "accepted" : "failed",
            accepted ? result : null,
            error,
          );
          return this.engine.envelope(updated);
        };
        const follow = (
          next: Action,
          error: AgentLordError | null = null,
        ): Envelope =>
          this.engine.envelope(
            this.engine.ops.setStatus(op.operation_id, "awaiting_action", {
              action_id: next.action_id,
              error: error?.asRecord() ?? null,
            }),
            next,
          );
        if (providerError) {
          if (
            providerError.includes(ROUTE_STALE_FRAGMENT) &&
            ["codex.send", "codex.read"].includes(action.kind)
          ) {
            const error = new AgentLordError(
              "ENDPOINT_ROUTE_STALE",
              "Codex endpoint route is stale; resolving the same thread before retry",
              {
                retryable: true,
                safe_recovery: "RESOLVE_SAME_ENDPOINT_AND_RETRY",
                details: { provider_error: providerError },
              },
            );
            this.markAction(actionId, "failed", null, error);
            const envelope = follow(
              this.engine.app.list(op, actionId, action.kind),
              error,
            );
            this.engine.store.event(
              op.task_id,
              "route-stale",
              object(error.asRecord()),
              op.operation_id,
            );
            return envelope;
          }
          if (action.kind === "codex.send") {
            const error = new AgentLordError(
              "DELIVERY_UNKNOWN",
              "Codex send failed without a trustworthy delivery receipt",
              {
                retryable: true,
                safe_recovery: "CHECK_SAME_ENDPOINT_BEFORE_RESEND",
                details: { provider_error: providerError },
              },
            );
            this.markAction(actionId, "uncertain", null, error);
            return follow(
              this.engine.app.read(op, this.engine.store.task(op.task_id)),
              error,
            );
          }
          if (action.kind === "codex.list" && string(action.resume_action_id)) {
            const attempts = this.engine.store
              .actions(op.operation_id)
              .filter(
                (v) => v.kind === "codex.list" && v.status === "failed",
              ).length;
            if (attempts + 1 < 3) {
              const error = new AgentLordError(
                "PROVIDER_FAILED",
                "Codex thread listing failed transiently; retrying the same route recovery",
                {
                  retryable: true,
                  safe_recovery: "RETRY_SAME_HOST_TOOL_ACTION",
                  details: {
                    provider_error: providerError,
                    list_attempt: attempts + 1,
                  },
                },
              );
              this.markAction(actionId, "failed", null, error);
              const envelope = follow(
                this.engine.app.list(
                  op,
                  String(action.resume_action_id),
                  String(action.resume_kind),
                ),
                error,
              );
              this.engine.store.event(
                op.task_id,
                "route-list-retry",
                object(error.asRecord()),
                op.operation_id,
              );
              return envelope;
            }
          }
          return failed(
            new AgentLordError(
              "PROVIDER_FAILED",
              "Codex host tool returned an error",
              {
                retryable: action.kind === "codex.read",
                safe_recovery:
                  action.kind === "codex.read"
                    ? "RETRY_CHECK_SAME_ENDPOINT"
                    : undefined,
                details: { provider_error: providerError },
              },
            ),
          );
        }
        if (action.kind === "codex.create") {
          const [endpoint, host] = endpointIdentity(result);
          if (!endpoint || !host)
            return failed(
              new AgentLordError(
                "RESULT_INVALID",
                "Codex create result lacks a real threadId and hostId",
              ),
            );
          const task = this.engine.store.createTask(
            this.engine.ops.taskRecord(op, endpoint, host),
          );
          this.markAction(actionId, "accepted", result);
          const next = autoRead ? this.engine.app.read(op, task) : undefined;
          const updated = this.engine.ops.setStatus(
            op.operation_id,
            next ? "awaiting_action" : "submitted",
            {
              endpoint_id: endpoint,
              observed: this.appObservation(op, { host_id: host }),
              error: null,
              ...(next ? { action_id: next.action_id } : {}),
            },
          );
          this.engine.store.event(
            op.task_id,
            "endpoint-created",
            { endpoint_id: endpoint, host_id: host },
            op.operation_id,
          );
          return this.engine.envelope(updated, next);
        }
        let task = this.engine.store.task(op.task_id);
        if (action.kind === "codex.send") {
          const [endpoint, host] = endpointIdentity(result);
          if (endpoint && endpoint !== task.endpoint_id)
            return failed(
              new AgentLordError(
                "ENDPOINT_MISMATCH",
                "Codex send receipt belongs to a different thread",
                { details: { expected: task.endpoint_id, observed: endpoint } },
              ),
            );
          if (host) task = this.rebindTask(task.task_id, host, "send-receipt");
          this.markAction(actionId, "accepted", result);
          const next = autoRead ? this.engine.app.read(op, task) : undefined;
          const updated = this.engine.ops.setStatus(
            op.operation_id,
            next ? "awaiting_action" : "submitted",
            {
              observed: this.appObservation(op, {
                host_id: task.route.host_id,
              }),
              error: null,
              ...(next ? { action_id: next.action_id } : {}),
            },
          );
          this.engine.store.event(
            op.task_id,
            "message-accepted",
            { action_id: actionId },
            op.operation_id,
          );
          return this.engine.envelope(updated, next);
        }
        if (action.kind === "codex.list") {
          const host = string(findThread(result, task.endpoint_id)?.hostId);
          if (!host)
            return failed(
              new AgentLordError(
                "ENDPOINT_GONE",
                "the original Codex thread was not found on any current host",
                {
                  requires_authorization: true,
                  details: { endpoint_id: task.endpoint_id },
                },
              ),
              true,
            );
          task = this.rebindTask(task.task_id, host, "host-rediscovery");
          this.markAction(actionId, "accepted", result);
          const prior = this.engine.store.action(
            String(action.resume_action_id),
          );
          const next =
            action.resume_kind === "codex.send"
              ? this.engine.app.send(op, task, String(prior.arguments.prompt))
              : this.engine.app.read(op, task);
          const envelope = follow(next);
          this.engine.store.event(
            op.task_id,
            "route-rebound",
            { host_id: host },
            op.operation_id,
          );
          return envelope;
        }
        if (action.kind === "codex.read") {
          this.markAction(actionId, "accepted", result);
          const marker = operationMarker(op.operation_id);
          let text = "";
          try {
            text = extractCodexResult(result, marker);
          } catch (error) {
            if (!(error instanceof AgentLordError)) throw error;
          }
          const observed = this.appObservation(op, {
            thread_status: threadStatus(result, task.endpoint_id),
          });
          if (text) {
            const artifact = writeArtifact(
              op.task_id,
              op.operation_id,
              text,
              this.engine.root,
            );
            const updated = this.engine.ops.setStatus(
              op.operation_id,
              "succeeded",
              {
                artifact,
                observed,
                error: null,
              },
            );
            this.engine.store.event(
              op.task_id,
              "operation-succeeded",
              { artifact },
              op.operation_id,
            );
            return this.engine.envelope(updated);
          }
          if (
            op.error?.code === "DELIVERY_UNKNOWN" &&
            !stringifyJson(result).includes(marker)
          )
            return this.engine.envelope(
              this.engine.ops.fail(
                op,
                new AgentLordError(
                  "DELIVERY_UNKNOWN",
                  "the operation marker is absent from the bounded transcript; resend requires an explicit decision",
                  {
                    requires_authorization: true,
                    details: { operation_id: op.operation_id },
                  },
                ),
              ),
            );
          const next = autoRead ? this.engine.app.read(op, task) : undefined;
          return this.engine.envelope(
            this.engine.ops.setStatus(
              op.operation_id,
              next ? "awaiting_action" : "submitted",
              { observed, ...(next ? { action_id: next.action_id } : {}) },
            ),
            next,
          );
        }
        return this.engine.envelope(
          this.engine.ops.fail(
            op,
            new AgentLordError("RESULT_INVALID", "unknown Codex action kind", {
              details: { kind: action.kind },
            }),
          ),
        );
      },
    );
  }
  async superviseCodex(initial: Operation): Promise<Envelope | null> {
    if (
      initial.status === "preparing"
        ? pidAlive(initial.controller_pid)
        : pidAlive(initial.pid)
    )
      return null;
    const id = initial.operation_id;
    try {
      return await withAsyncLock(
        "operation-control",
        leaseId("control", id),
        this.engine.root,
        async () => {
          const op = this.engine.store.operation(id);
          const fail = (error: AgentLordError) =>
            this.engine.envelope(this.engine.ops.fail(op, error));
          if (op.status === "preparing") {
            if (pidAlive(op.controller_pid) || pidAlive(op.pid)) return null;
            return fail(
              op.provider_command
                ? new AgentLordError(
                    "DELIVERY_UNKNOWN",
                    "Codex CLI controller exited while launching its provider attempt",
                    {
                      requires_authorization: true,
                      details: { operation_id: id },
                    },
                  )
                : new AgentLordError(
                    "PROCESS_EXITED_WITHOUT_RESULT",
                    "Codex CLI controller exited before its provider attempt was launched",
                    {
                      retryable: true,
                      safe_recovery: "RETRY_SAME_COMMAND",
                      details: { operation_id: id },
                    },
                  ),
            );
          }
          if (op.status !== "running" || pidAlive(op.pid)) return null;
          let result: ProviderResult;
          try {
            result = recoverCodex(op);
          } catch (error) {
            if (!(error instanceof AgentLordError)) throw error;
            let failure = error;
            if (error.code === "RESULT_INVALID") {
              if (this.engine.ops.resultGrace(op)) return null;
              failure = new AgentLordError(
                "PROCESS_EXITED_WITHOUT_RESULT",
                "Codex CLI process exited without publishing a recoverable terminal result",
                {
                  retryable: true,
                  safe_recovery: "INSPECT_LOGS_THEN_RETRY_SAME_ENDPOINT",
                  details: { provider_error: error.asRecord() },
                },
              );
            }
            return fail(failure);
          }
          if (!result.endpoint_id)
            return fail(
              new AgentLordError(
                "RESULT_INVALID",
                "recovered Codex CLI result lacks endpoint identity",
              ),
            );
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
