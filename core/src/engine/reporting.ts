// Extracted from engine.ts: public envelope shaping, task status checks,
// artifact export with contract verification, and final-response binding.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  type Action,
  type Data,
  type Envelope,
  type Operation,
  TERMINAL_STATES,
  object,
  records,
  string,
  strings,
} from "../contracts.js";
import { expectedModelMatches } from "../config.js";
import { AgentLordError, usageError } from "../errors.js";
import { sha256 } from "../json.js";
import { withLock } from "../state.js";
import { leaseId } from "../workspace.js";
import { resolvePath } from "../paths.js";
import { extractJsonlWithMetadata, writeArtifact } from "../artifacts.js";
import { actionPublic, operationMarker } from "../providers/codex-app.js";
import { pidAlive } from "../process.js";
import type { AgentLord } from "../engine.js";

export class Reporting {
  constructor(private readonly engine: AgentLord) {}
  check(taskId: string): Envelope {
    const task = this.engine.store.task(taskId);
    const id = task.last_operation_id;
    if (!id)
      return {
        version: 1,
        status: "IDLE",
        task_id: taskId,
        provider: task.provider,
        endpoint_id: task.endpoint_id,
      };
    return withLock(
      "operation-control",
      leaseId("control", id),
      this.engine.root,
      () => {
        const op = this.engine.store.operation(id);
        const action = this.engine.store.pendingAction(id);
        if (action || TERMINAL_STATES.has(op.status))
          return this.envelope(op, action);
        if (task.provider === "codex-app") {
          const next = this.engine.app.read(op, task);
          return this.envelope(
            this.engine.ops.setStatus(id, "awaiting_action", {
              action_id: next.action_id,
            }),
            next,
          );
        }
        const result = this.envelope(op);
        const pid =
          task.provider === "claude-cli"
            ? this.engine.claude.claudeController(op)
            : op.controller_pid;
        if (pid != null && !pidAlive(pid))
          result.observed = {
            ...op.observed,
            supervision: {
              ...object(op.observed.supervision),
              controller_state: "exited",
              recovery_command: "checkpoint",
            },
          };
        return result;
      },
    );
  }
  exportArtifact(
    taskId: string,
    operationId: string,
    sourceFile: string,
    format: string,
  ): Envelope {
    const op = this.engine.store.operation(operationId);
    if (op.task_id !== taskId)
      throw new AgentLordError(
        "ENDPOINT_MISMATCH",
        "operation does not belong to task_id",
      );
    if (op.provider === "mcode-cli")
      throw usageError(
        "mcode-stream-json does not contain a verifiable Agent Lord operation marker; auxiliary MCode import is refused",
        { source_format: format, operation_id: operationId },
      );
    if (op.provider === "claude-cli") {
      if (format !== "claude-jsonl")
        throw usageError(
          "a claude-cli operation can only be proven by its own claude-jsonl session log",
          { source_format: format },
        );
      if (!op.endpoint_id)
        throw new AgentLordError(
          "ENDPOINT_MISMATCH",
          "cannot bind a Claude transcript without the saved session identity",
          { details: { operation_id: operationId } },
        );
    }
    const extracted = extractJsonlWithMetadata(
      resolvePath(sourceFile),
      format,
      op.provider === "claude-cli" ? undefined : operationMarker(operationId),
      op.provider === "claude-cli" ? op.endpoint_id! : undefined,
    );
    const observed = extracted.observed;
    const models = strings(observed.models);
    const model = op.expected.model;
    const effort = op.expected.effort;
    const reject = (code: string, message: string, details: Data): never => {
      const error = new AgentLordError(code, message, {
        retryable: true,
        safe_recovery: "RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
        details,
      });
      if (!TERMINAL_STATES.has(op.status)) this.engine.ops.fail(op, error);
      throw error;
    };
    if (
      model &&
      (!models.length ||
        !models.every((v) =>
          op.provider === "claude-cli"
            ? expectedModelMatches(model, v)
            : model.toLowerCase() === v.toLowerCase(),
        ))
    )
      reject(
        models.length ? "MODEL_MISMATCH" : "MODEL_UNVERIFIED",
        "provider log does not satisfy the saved model contract",
        { expected: model, observed: models },
      );
    if (effort) {
      if (observed.effort && observed.effort !== effort)
        reject(
          "EFFORT_MISMATCH",
          "provider log does not satisfy the saved reasoning-effort contract",
          { expected: effort, observed: observed.effort },
        );
      if (!observed.effort) {
        if (format !== "claude-jsonl")
          reject(
            "EFFORT_UNVERIFIED",
            "provider log does not satisfy the saved reasoning-effort contract",
            { expected: effort, observed: observed.effort ?? null },
          );
        observed.warnings = [
          ...records(observed.warnings),
          {
            code: "EFFORT_UNVERIFIABLE_FORMAT",
            source_format: format,
            expected_effort: effort,
          },
        ];
      }
    }
    const artifact = writeArtifact(
      taskId,
      operationId,
      extracted.text,
      this.engine.root,
    );
    const updated = this.engine.ops.setStatus(operationId, op.status, {
      artifact,
      observed,
    });
    this.engine.store.event(taskId, "artifact-exported", artifact, operationId);
    return this.envelope(updated);
  }
  envelope(op: Operation, supplied?: Action, resolveAction = true): Envelope {
    const action =
      supplied ??
      (resolveAction
        ? this.engine.store.pendingAction(op.operation_id)
        : undefined);
    const status: Envelope["status"] =
      op.status === "succeeded"
        ? "SUCCEEDED"
        : op.status === "failed"
          ? "ERROR"
          : op.status === "needs_decision"
            ? "NEEDS_DECISION"
            : op.status === "awaiting_action" && action
              ? "ACTION_REQUIRED"
              : "RUNNING";
    const result: Envelope = {
      version: 1,
      status,
      task_id: op.task_id,
      operation_id: op.operation_id,
      provider: op.provider,
      operation_status: op.status,
      expected: op.expected,
      observed: op.observed,
      source: op.source,
      workspace: op.workspace ?? {},
      parallel_plan: op.parallel_plan ?? {},
      ...(op.invocation ? { invocation: op.invocation } : {}),
      ...(op.workflow ? { workflow: op.workflow } : {}),
      provider_return_code:
        typeof op.provider_return_code === "number"
          ? op.provider_return_code
          : null,
      timing: {
        created_at_ms: Date.parse(op.created_at),
        completed_at_ms:
          typeof op.completed_at === "string"
            ? Date.parse(op.completed_at)
            : null,
      },
    };
    if (op.handoff) {
      const h = op.handoff;
      result.handoff = {
        schema: h.schema,
        handoff_id: h.handoff_id,
        relationship: h.relationship,
        source_session: h.source_session,
        packet_sha256: object(h.packet).sha256,
        packet_bytes: object(h.packet).bytes,
        workspace_snapshot: h.workspace_snapshot,
      };
    }
    if (this.engine.store.hasTask(op.task_id)) {
      const task = this.engine.store.task(op.task_id);
      result.endpoint_id = task.endpoint_id;
      result.route = task.route;
      result.target = task.target;
    }
    if (op.artifact) result.artifact = op.artifact;
    if (op.status === "succeeded")
      result.delivery = op.delivery ?? {
        status: "unverified",
        scope: "declared-files-and-commit",
        checks: [],
      };
    if (op.continuation) result.continuation = op.continuation;
    if (op.input_evidence?.length) result.input_evidence = op.input_evidence;
    if (op.error) result.error = op.error;
    if (records(op.observed.warnings).length)
      result.warnings = op.observed.warnings;
    if (action) result.action = actionPublic(action);
    return result;
  }
  /** Opt-in, operation-bound final text; no provider calls or additional status transitions. */
  withResponse(envelope: Envelope): Envelope {
    if (envelope.actionable)
      return {
        ...envelope,
        actionable: envelope.actionable.map((item) => this.withResponse(item)),
      };
    if (envelope.status !== "SUCCEEDED" || !envelope.operation_id)
      return envelope;
    const op = this.engine.store.operation(envelope.operation_id);
    if (
      op.task_id !== envelope.task_id ||
      op.status !== "succeeded" ||
      !op.artifact
    )
      throw usageError("final response is not bound to a succeeded operation");
    let text: string;
    try {
      const expected = path.join(
        realpathSync(this.engine.root),
        "artifacts",
        op.task_id,
        `${op.operation_id}.md`,
      );
      if (
        realpathSync(op.artifact.path) !== expected ||
        realpathSync(expected) !== expected
      )
        throw new Error("artifact path mismatch");
      const bytes = readFileSync(expected);
      if (
        bytes.length !== op.artifact.bytes ||
        sha256(bytes) !== op.artifact.sha256
      )
        throw new Error("artifact integrity mismatch");
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new AgentLordError(
        "ARTIFACT_INVALID",
        "cannot read the canonical final response",
        {
          details: {
            operation_id: op.operation_id,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    return { ...envelope, response: { text, read_at_ms: Date.now() } };
  }
}
