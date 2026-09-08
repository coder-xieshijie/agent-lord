import {
  type Data,
  type Operation,
  type ProviderResult,
  isObject,
  object,
  string,
} from "../contracts.js";
import { parseMcodeModel, permissionModePolicy } from "../config.js";
import { AgentLordError, errorMessage } from "../errors.js";
import { equal, parseJson } from "../json.js";
const EVENT_TYPES = [
  "exec.started",
  "session.started",
  "session.resumed",
  "turn.started",
  "item.started",
  "item.updated",
  "item.completed",
  "turn.completed",
  "turn.failed",
  "exec.completed",
];
const STATUSES = [
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "limit_exceeded",
];
const invalid = (message: string, details: Data = {}) =>
  new AgentLordError("RESULT_INVALID", message, { details });
function eventIdentity(value: Data): [string, string, string] {
  const values = [value.runId, value.sessionId, value.turnId];
  if (!values.every((v) => typeof v === "string" && v))
    throw invalid("MCode stream event lacks Run, Session, or Turn identity");
  return values as [string, string, string];
}
export class McodeStream {
  identity: [string, string, string] | null = null;
  sequence = 0;
  events: Data[] = [];
  sessionObserved = false;
  completed = false;
  constructor(
    readonly resume: boolean,
    readonly endpoint: string | null,
  ) {}
  feed(line: string): Data {
    let raw: unknown;
    try {
      raw = parseJson(line);
    } catch (error) {
      throw invalid("MCode stream contains a non-JSON record", {
        line: this.events.length + 1,
        error: errorMessage(error),
      });
    }
    if (!isObject(raw) || raw.schemaVersion !== 1)
      throw invalid("MCode stream record is not a schemaVersion 1 object");
    const event = raw;
    const type = String(event.type);
    if (!EVENT_TYPES.includes(type))
      throw invalid("MCode stream contains an unsupported event type", {
        type: event.type,
      });
    if (event.sequence !== this.sequence + 1)
      throw invalid("MCode stream sequence is not contiguous", {
        expected: this.sequence + 1,
        observed: event.sequence,
      });
    if (
      typeof event.timestampMs !== "number" ||
      !Number.isFinite(event.timestampMs)
    )
      throw invalid("MCode stream event has an invalid timestamp");
    const identity = eventIdentity(event);
    if (!this.identity) this.identity = identity;
    else if (!equal(identity, this.identity))
      throw new AgentLordError(
        "ENDPOINT_MISMATCH",
        "MCode stream crosses Run, Session, or Turn identity",
        { details: { expected: this.identity, observed: identity } },
      );
    if (this.endpoint !== null && identity[1] !== this.endpoint)
      throw new AgentLordError(
        "ENDPOINT_MISMATCH",
        "MCode result belongs to a different Session",
        { details: { expected: this.endpoint, observed: identity[1] } },
      );
    if (this.completed)
      throw invalid("MCode stream contains events after exec.completed");
    this.sequence++;
    this.events.push(event);
    if (["session.started", "session.resumed"].includes(type)) {
      const expected = this.resume ? "session.resumed" : "session.started";
      if (this.sessionObserved || type !== expected)
        throw invalid("MCode stream has an invalid Session lifecycle event", {
          expected,
          observed: type,
        });
      this.sessionObserved = true;
    }
    if (type.startsWith("item.") && !isObject(event.item))
      throw invalid("MCode item event lacks an item object");
    if (type === "exec.completed") this.completed = true;
    return event;
  }
}
function modelFromResult(value: unknown): {
  provider_id: string;
  model_id: string;
  variant: string | null;
} {
  if (!isObject(value))
    throw new AgentLordError(
      "MODEL_UNVERIFIED",
      "MCode terminal result contains no model metadata",
    );
  const provider = string(value.providerId);
  const model = string(value.modelId);
  const variant = value.variant ?? null;
  if (!provider || !model || (variant !== null && !string(variant)))
    throw new AgentLordError(
      "MODEL_UNVERIFIED",
      "MCode terminal result has invalid model metadata",
    );
  return {
    provider_id: provider,
    model_id: model,
    variant: variant as string | null,
  };
}
function modelLiteral(value: ReturnType<typeof modelFromResult>): string {
  return `${value.provider_id}/${value.model_id}${value.variant ? `#${value.variant}` : ""}`;
}
export function validateMcodeOutput(
  stdout: string,
  stderr: string,
  final: string,
  mtime: bigint | null,
  op: Operation,
): ProviderResult {
  const stream = new McodeStream(Boolean(op.resume), op.endpoint_id ?? null);
  for (const [index, line] of stdout.split(/\r?\n/).entries())
    if (line) {
      try {
        stream.feed(line);
      } catch (error) {
        if (error instanceof AgentLordError) error.details.line ??= index + 1;
        throw error;
      }
    }
  if (!stream.events.length)
    throw invalid("MCode stream is empty", { stderr_tail: stderr.slice(-500) });
  const lifecycle = stream.events.map((v) => v.type);
  const prefix = [
    "exec.started",
    op.resume ? "session.resumed" : "session.started",
    "turn.started",
  ];
  if (!equal(lifecycle.slice(0, 3), prefix) || !stream.sessionObserved)
    throw invalid(
      "MCode stream has an incomplete or reordered start lifecycle",
      { expected_prefix: prefix, observed_prefix: lifecycle.slice(0, 3) },
    );
  if (prefix.some((type) => lifecycle.filter((v) => v === type).length !== 1))
    throw invalid(
      "MCode stream contains duplicate or missing lifecycle events",
    );
  const terminals = stream.events.filter((v) => v.type === "exec.completed");
  if (terminals.length !== 1 || lifecycle.at(-1) !== "exec.completed")
    throw invalid(
      "MCode stream must contain exactly one final exec.completed event",
      { terminal_count: terminals.length },
    );
  const result = object(terminals[0].result);
  if (result.schemaVersion !== 1 || result.type !== "exec.result")
    throw invalid(
      "MCode exec.completed contains no schemaVersion 1 exec.result",
    );
  const identity = stream.identity!;
  for (const [key, index, label] of [
    ["run_id", 0, "Run"],
    ["turn_id", 2, "Turn"],
  ] as const)
    if (op[key] != null && op[key] !== identity[index])
      throw new AgentLordError(
        "ENDPOINT_MISMATCH",
        `MCode stream ${label} does not belong to the journaled operation`,
        { details: { expected: op[key], observed: identity[index] } },
      );
  const terminalIdentity = [result.runId, result.sessionId, result.turnId];
  if (!equal(terminalIdentity, identity))
    throw new AgentLordError(
      "ENDPOINT_MISMATCH",
      "MCode terminal result crosses Run, Session, or Turn identity",
      { details: { expected: identity, observed: terminalIdentity } },
    );
  const status = String(result.status);
  if (!STATUSES.includes(status))
    throw invalid("MCode terminal result has an unsupported status", {
      status,
      allowed: [...STATUSES].sort(),
    });
  if (
    typeof result.durationMs !== "number" ||
    !Number.isFinite(result.durationMs)
  )
    throw invalid("MCode terminal result has an invalid duration");
  if (status !== "succeeded" && "output" in result)
    throw invalid(
      "MCode non-success terminal result unexpectedly contains output",
    );
  const completed = stream.events.filter((v) => v.type === "turn.completed");
  const failed = stream.events.filter((v) => v.type === "turn.failed");
  if (
    status === "succeeded"
      ? completed.length !== 1 || failed.length > 0
      : failed.length !== 1 ||
        completed.length > 0 ||
        failed[0].status !== status
  )
    throw invalid(
      status === "succeeded"
        ? "MCode successful result has an inconsistent Turn terminal event"
        : "MCode unsuccessful result has an inconsistent Turn terminal event",
    );
  const expected = parseMcodeModel(op.expected.model);
  const observed = "model" in result ? modelFromResult(result.model) : null;
  if (observed) {
    if (
      expected.provider_id !== observed.provider_id ||
      expected.model_id !== observed.model_id
    )
      throw new AgentLordError(
        "MODEL_MISMATCH",
        "MCode terminal model does not satisfy the frozen model contract",
        {
          details: {
            expected: op.expected.model,
            observed: modelLiteral(observed),
          },
        },
      );
    if (expected.variant !== null && expected.variant !== observed.variant)
      throw new AgentLordError(
        "MODEL_MISMATCH",
        "MCode terminal variant does not satisfy the frozen model contract",
        {
          details: {
            expected: op.expected.model,
            observed: modelLiteral(observed),
          },
        },
      );
    for (const event of [...completed, ...failed])
      if ("model" in event && !equal(modelFromResult(event.model), observed))
        throw new AgentLordError(
          "MODEL_MISMATCH",
          "MCode Turn and Exec terminal model metadata disagree",
        );
  } else if (status === "succeeded")
    throw new AgentLordError(
      "MODEL_UNVERIFIED",
      "MCode successful terminal result contains no model metadata",
    );
  if (op.provider_return_code == null)
    throw new AgentLordError(
      "DELIVERY_UNKNOWN",
      "MCode terminal result has no durable process exit code",
      {
        requires_authorization: true,
        details: {
          run_id: identity[0],
          session_id: identity[1],
          turn_id: identity[2],
        },
      },
    );
  if (status !== "succeeded")
    throw new AgentLordError(
      "PROVIDER_FAILED",
      "MCode operation ended with a non-success status",
      {
        details: {
          provider_status: status,
          return_code: op.provider_return_code,
          provider_error: result.error,
          model_verified: observed !== null,
          run_id: identity[0],
          session_id: identity[1],
          turn_id: identity[2],
          stderr_tail: stderr.slice(-500),
        },
      },
    );
  if (op.provider_return_code !== 0)
    throw new AgentLordError(
      "PROVIDER_FAILED",
      "MCode reported success but exited non-zero",
      {
        details: {
          return_code: op.provider_return_code,
          session_id: identity[1],
        },
      },
    );
  const reset =
    object(op.active_attempt).result_reset_at_ns ?? op.result_reset_at_ns;
  if (
    (typeof reset !== "bigint" && typeof reset !== "number") ||
    mtime === null ||
    mtime < BigInt(reset)
  )
    throw invalid(
      "MCode final-message file is missing or predates this operation",
      { reset_at_ns: reset, mtime_ns: mtime },
    );
  if (!("output" in result))
    throw invalid("MCode successful terminal result contains no output");
  if (!final) throw invalid("MCode produced no final assistant message");
  if (typeof result.output === "string") {
    if (result.output !== final)
      throw invalid(
        "MCode terminal output does not match its final-message file",
      );
  } else {
    let parsed: unknown;
    try {
      parsed = parseJson(final);
    } catch {
      throw invalid(
        "MCode structured terminal output does not match a JSON final-message file",
      );
    }
    if (!equal(parsed, result.output))
      throw invalid(
        "MCode structured terminal output does not match its final-message file",
      );
  }
  const permission = permissionModePolicy(
    "mcode-cli",
    op.expected.permission_mode,
  );
  return {
    endpoint_id: identity[1],
    assistant_text: final,
    model: op.expected.model,
    effort: null,
    observed: {
      models: [modelLiteral(observed!)],
      model: `${observed!.provider_id}/${observed!.model_id}`,
      model_verification: "provider-metadata",
      variant: observed!.variant,
      variant_verification:
        expected.variant !== null ? "provider-metadata" : "not-requested",
      effort: null,
      effort_verification: "not-supported",
      permission_mode: permission.mode,
      permission_enforcement: permission.enforcement,
      run_id: identity[0],
      session_id: identity[1],
      turn_id: identity[2],
      terminal_status: status,
      progress_seq: stream.sequence,
    },
  };
}
export class McodeProgress {
  private tools = new Map<string, string>();
  private lastTool: string | null = null;
  observe(event: Data): Data {
    const kind = String(event.type);
    const item = object(event.item);
    if (item.type === "tool_call") {
      const tool = object(item.toolCall);
      const id = string(tool.id) || string(item.id);
      const raw = string(tool.name);
      const name =
        raw && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(raw) ? raw : "tool";
      this.lastTool = name;
      if (id) {
        if (kind === "item.completed" || tool.status === 2 || tool.status === 3)
          this.tools.delete(id);
        else this.tools.set(id, name);
      }
    }
    let state = this.tools.size ? "tool_wait" : "progressing";
    if (
      [
        "exec.started",
        "session.started",
        "session.resumed",
        "turn.started",
      ].includes(kind)
    )
      state = "provider_wait";
    if (["turn.completed", "turn.failed", "exec.completed"].includes(kind)) {
      this.tools.clear();
      state = kind === "turn.failed" ? "provider_failed" : "progressing";
      if (kind === "exec.completed")
        state =
          object(event.result).status === "succeeded"
            ? "succeeded"
            : "provider_failed";
    }
    return {
      state,
      last_event_type: kind,
      active_tool_count: this.tools.size,
      active_tools: [...new Set(this.tools.values())].sort().slice(0, 5),
      last_tool: this.lastTool,
    };
  }
}
