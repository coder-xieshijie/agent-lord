import {
  type Data,
  type Envelope,
  type RequestIntent,
  type RequestRecord,
  type StartOptions,
  IDENTIFIER_PATTERN,
  isObject,
  object,
  string,
} from "./contracts.js";
import { AgentLordError, usageError } from "./errors.js";
import { sha256, stringifyJson } from "./json.js";
import type { AgentLord } from "./engine.js";
import {
  utcNow,
  validateIdentifier,
  withAsyncLock,
  withLock,
} from "./state.js";

/** Dispatch options frozen at registration; the same names `start` accepts. */
const START_OPTION_KEYS = [
  "model",
  "effort",
  "retry_attempts",
  "read_only",
  "head_sha",
  "base_sha",
  "source_branch",
  "workspace_policy",
  "workspace_branch",
  "worktree_root",
  "parallel_group",
  "integration_role",
  "integration_target_branch",
  "integrator_task_id",
  "integration_order",
  "integration_workers",
  "codex_environment",
  "starting_branch",
  "required_files",
  "require_commit",
] as const;
const TURN_OPTION_KEYS = ["required_files", "require_commit"] as const;
const STATUSES = ["pending", "dispatched", "cancelled"] as const;
/**
 * Only contention keeps a consumed request pending. Every other failure is a
 * real contract or provider error and is reported as one.
 */
const PENDING_CODES = new Set(["OPERATION_IN_FLIGHT", "STATE_BUSY"]);
const PREVIEW_LIMIT = 200;

export interface RegisterInput {
  request_id: string;
  intent: string;
  task_id: string;
  message: string;
  user_request?: string | null;
  source?: {
    kind?: string | null;
    session_id?: string | null;
    note?: string | null;
  };
  provider?: string | null;
  target?: string | null;
  repository?: string | null;
  options?: Data;
}
export interface ListFilter {
  status?: string;
  intent?: string;
  task_id?: string;
  source_kind?: string;
  source_session_id?: string;
}

function corrupt(message: string, requestId: string): never {
  throw new AgentLordError("STATE_CORRUPT", message, {
    details: { request_id: requestId },
  });
}
function text(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}
function optional(value: unknown, name: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw usageError(
      `${name} must be non-empty text up to ${limit} characters`,
    );
  if (value.includes("\0")) throw usageError(`${name} must not contain NUL`);
  return value;
}
/** The stable identity of what this request asks for. */
export function intentDigest(
  intent: RequestIntent,
  messageSha: string,
  userRequest: string | null,
): string {
  return sha256(
    stringifyJson({
      kind: intent.kind,
      task_id: intent.task_id,
      provider: intent.provider,
      target: intent.target,
      repository: intent.repository,
      options: intent.options,
      message_sha256: messageSha,
      user_request: userRequest,
    }),
  );
}
export function normalizeRequest(raw: unknown): RequestRecord {
  if (!isObject(raw))
    throw new AgentLordError(
      "STATE_CORRUPT",
      "request record is not a JSON object",
    );
  const id = string(raw.request_id) ?? "";
  if (!IDENTIFIER_PATTERN.test(id))
    corrupt("request record has an invalid request_id", id);
  if (raw.version !== 1)
    corrupt("request record has an unsupported version", id);
  if (!STATUSES.includes(raw.status as (typeof STATUSES)[number]))
    corrupt("request record has an unsupported status", id);
  const intent = object(raw.intent);
  if (
    !["start", "turn"].includes(String(intent.kind)) ||
    !text(intent.task_id) ||
    !IDENTIFIER_PATTERN.test(intent.task_id) ||
    !isObject(intent.options) ||
    (intent.provider !== null && !text(intent.provider)) ||
    (intent.target !== null && !text(intent.target)) ||
    (intent.repository !== null && !text(intent.repository))
  )
    corrupt("request record has an invalid intent", id);
  if (!text(raw.message) || !raw.message)
    corrupt("request record has an invalid message", id);
  if (
    typeof raw.message_sha256 !== "string" ||
    raw.message_sha256 !== sha256(raw.message as string)
  )
    corrupt("request record message does not match its digest", id);
  if (raw.user_request !== null && !text(raw.user_request))
    corrupt("request record has an invalid user_request", id);
  const source = object(raw.source);
  for (const key of ["kind", "session_id", "note"])
    if (source[key] !== null && !text(source[key]))
      corrupt("request record has an invalid source", id);
  if (
    raw.operation_id !== null &&
    (!text(raw.operation_id) ||
      !IDENTIFIER_PATTERN.test(raw.operation_id as string))
  )
    corrupt("request record has an invalid operation_id", id);
  if (
    raw.intent_sha256 !==
    intentDigest(
      intent as unknown as RequestIntent,
      raw.message_sha256 as string,
      raw.user_request as string | null,
    )
  )
    corrupt("request record intent does not match its digest", id);
  if ((raw.status === "dispatched") !== (raw.operation_id !== null))
    corrupt("request record status contradicts its operation binding", id);
  return raw as unknown as RequestRecord;
}

/**
 * A passive inbox for instructions the scheduler is not ready to dispatch.
 * Registering never starts work: only an explicit `dispatch` turns a request
 * into an operation, and only the scheduler decides when that happens.
 */
export class RequestInbox {
  constructor(private readonly lord: AgentLord) {}
  private get root(): string {
    return this.lord.root;
  }
  private read(id: string): RequestRecord {
    const value = normalizeRequest(this.lord.store.requestRecord(id));
    if (value.request_id !== id)
      corrupt("request record identity does not match its filename", id);
    return value;
  }
  /**
   * Rebuild the request status from the operation log, which is the only
   * record written atomically with the dispatch itself.
   */
  private reconcile(record: RequestRecord): RequestRecord {
    if (record.status === "cancelled") return record;
    const bound = this.lord.store.operationForRequest(record.request_id);
    if (!bound || bound.operation_id === record.operation_id) return record;
    return {
      ...record,
      status: "dispatched",
      operation_id: bound.operation_id,
      dispatched_at: record.dispatched_at ?? bound.created_at,
    };
  }
  private persist(record: RequestRecord): RequestRecord {
    const value = { ...record, updated_at: utcNow() };
    normalizeRequest(value);
    this.lord.store.writeRequest(value);
    return value;
  }
  private bind(
    record: RequestRecord,
    operationId: string,
    at: string,
  ): RequestRecord {
    if (record.status === "dispatched" && record.operation_id === operationId)
      return record;
    return this.persist({
      ...record,
      status: "dispatched",
      operation_id: operationId,
      dispatched_at: record.dispatched_at ?? at,
    });
  }
  private record(record: RequestRecord): Envelope {
    return { version: 1, status: "REQUEST_RECORD", request: { ...record } };
  }
  register(input: RegisterInput): Envelope {
    const requestId = validateIdentifier("request_id", input.request_id);
    const kind = input.intent;
    if (!["start", "turn"].includes(kind))
      throw usageError("intent must be start or turn");
    const taskId = validateIdentifier("task_id", input.task_id);
    if (typeof input.message !== "string" || !input.message)
      throw usageError("message must be non-empty");
    if (input.message.includes("\0"))
      throw usageError("message must not contain NUL");
    const userRequest = optional(input.user_request, "user_request", 1_000_000);
    const allowed: readonly string[] =
      kind === "start" ? START_OPTION_KEYS : TURN_OPTION_KEYS;
    const options = object(input.options);
    const unknown = Object.keys(options).filter((k) => !allowed.includes(k));
    if (unknown.length)
      throw usageError(
        `these dispatch options are not accepted for a ${kind} request`,
        { options: unknown },
      );
    const provider = input.provider ?? null;
    const target = input.target ?? null;
    const repository = input.repository ?? null;
    if (kind === "start") {
      if (!provider) throw usageError("a start request requires --provider");
      if (Boolean(target) === Boolean(repository))
        throw usageError(
          "a start request requires exactly one of --target or --repo",
        );
    } else if (provider || target || repository)
      throw usageError(
        "a turn request continues the saved endpoint, so it takes no provider, target, or repo",
      );
    const intent: RequestIntent = {
      kind: kind as RequestIntent["kind"],
      task_id: taskId,
      provider,
      target,
      repository,
      options,
    };
    const messageSha = sha256(input.message);
    const digest = intentDigest(intent, messageSha, userRequest);
    const now = utcNow();
    const fresh: RequestRecord = {
      version: 1,
      request_id: requestId,
      status: "pending",
      intent,
      intent_sha256: digest,
      message: input.message,
      message_sha256: messageSha,
      user_request: userRequest,
      source: {
        kind: optional(input.source?.kind, "source.kind", 160),
        session_id: optional(
          input.source?.session_id,
          "source.session_id",
          160,
        ),
        note: optional(input.source?.note, "source.note", 4_000),
      },
      operation_id: null,
      created_at: now,
      updated_at: now,
      dispatched_at: null,
      cancelled_at: null,
      cancel_reason: null,
    };
    normalizeRequest(fresh);
    return withLock("request", requestId, this.root, () => {
      if (this.lord.store.hasRequest(requestId)) {
        const existing = this.read(requestId);
        // Re-entrant registration of the same intent returns the original
        // record; the same id asking for something else is never silently
        // replaced. Descriptive source metadata is not part of the intent.
        if (existing.intent_sha256 !== digest)
          throw new AgentLordError(
            "REQUEST_CONFLICT",
            "request_id is already registered with a different intent",
            {
              details: {
                request_id: requestId,
                registered_intent_sha256: existing.intent_sha256,
                submitted_intent_sha256: digest,
              },
              exit_code: 2,
            },
          );
        return this.record(this.reconcile(existing));
      }
      this.lord.store.writeRequest(fresh, true);
      return this.record(fresh);
    });
  }
  get(id: string): Envelope {
    validateIdentifier("request_id", id);
    return withLock("request", id, this.root, () => {
      const current = this.read(id);
      const reconciled = this.reconcile(current);
      return this.record(
        reconciled === current ? current : this.persist(reconciled),
      );
    });
  }
  /** Caller metadata filters what is listed; it never grants or limits access. */
  list(filter: ListFilter = {}): Envelope {
    if (filter.status && !STATUSES.includes(filter.status as "pending"))
      throw usageError(`status must be one of: ${STATUSES.join(", ")}`);
    if (filter.intent && !["start", "turn"].includes(filter.intent))
      throw usageError("intent must be start or turn");
    const requests = this.lord.store
      .requestRecords()
      .map((raw) => this.reconcile(normalizeRequest(raw)))
      .filter(
        (v) =>
          (!filter.status || v.status === filter.status) &&
          (!filter.intent || v.intent.kind === filter.intent) &&
          (!filter.task_id || v.intent.task_id === filter.task_id) &&
          (!filter.source_kind || v.source.kind === filter.source_kind) &&
          (!filter.source_session_id ||
            v.source.session_id === filter.source_session_id),
      )
      .sort((a, b) =>
        `${a.created_at}\0${a.request_id}`.localeCompare(
          `${b.created_at}\0${b.request_id}`,
        ),
      );
    const counts: Data = {};
    for (const status of STATUSES)
      counts[status] = requests.filter((v) => v.status === status).length;
    return {
      version: 1,
      status: "REQUEST_LIST",
      counts,
      // Listing stays compact on purpose; `request-get` returns the full text.
      requests: requests.map(({ message, user_request, ...rest }) => ({
        ...rest,
        message_bytes: Buffer.byteLength(message),
        message_preview: message.slice(0, PREVIEW_LIMIT),
        has_user_request: user_request !== null,
      })),
    };
  }
  cancel(id: string, reason?: string | null): Envelope {
    validateIdentifier("request_id", id);
    const note = optional(reason, "reason", 4_000);
    return withLock("request", id, this.root, () => {
      const before = this.read(id);
      const current = this.reconcile(before);
      if (current.status === "dispatched") {
        // The dispatch already journaled its operation, so cancellation loses
        // the race deterministically instead of orphaning the operation.
        const stored = current === before ? current : this.persist(current);
        throw new AgentLordError(
          "REQUEST_CONFLICT",
          "request was already dispatched and cannot be cancelled",
          {
            details: {
              request_id: id,
              operation_id: stored.operation_id,
            },
            exit_code: 2,
          },
        );
      }
      if (current.status === "cancelled") return this.record(current);
      return this.record(
        this.persist({
          ...current,
          status: "cancelled",
          cancelled_at: utcNow(),
          cancel_reason: note,
        }),
      );
    });
  }
  /**
   * Consume one request. Holding the request lease for the whole dispatch is
   * what makes a concurrent second consume deterministic instead of racing
   * into a second operation.
   */
  async dispatch(
    id: string,
    opts: { invocation?: unknown } = {},
  ): Promise<Envelope> {
    validateIdentifier("request_id", id);
    return withAsyncLock("request", id, this.root, async () => {
      let current = this.read(id);
      if (current.status === "cancelled")
        throw new AgentLordError(
          "REQUEST_CANCELLED",
          "request was cancelled before it was dispatched",
          {
            details: { request_id: id, cancelled_at: current.cancelled_at },
            exit_code: 2,
          },
        );
      const bound = this.lord.store.operationForRequest(id);
      if (bound)
        return this.result(
          this.bind(current, bound.operation_id, bound.created_at),
          this.lord.envelope(bound),
        );
      if (current.operation_id) {
        try {
          const existing = this.lord.store.operation(current.operation_id);
          return this.result(current, this.lord.envelope(existing));
        } catch (error) {
          if (
            !(error instanceof AgentLordError) ||
            error.code !== "OPERATION_UNKNOWN"
          )
            throw error;
        }
      }
      const intent = current.intent;
      const invocation =
        opts.invocation ??
        (current.user_request
          ? { trigger: "user_request", user_request: current.user_request }
          : undefined);
      const dispatchOptions = {
        ...intent.options,
        ...(intent.repository ? { repository: intent.repository } : {}),
        ...(invocation !== undefined ? { invocation } : {}),
        request_id: id,
      } as StartOptions;
      let envelope: Envelope;
      try {
        envelope =
          intent.kind === "start"
            ? await this.lord.start(
                intent.task_id,
                intent.provider!,
                intent.target,
                current.message,
                dispatchOptions,
              )
            : await this.lord.turn(
                intent.task_id,
                current.message,
                dispatchOptions,
              );
      } catch (error) {
        // A dispatch that already journaled its operation stays bound to it,
        // even when the provider then failed: a retry must not open a new turn.
        const created = this.lord.store.operationForRequest(id);
        if (created)
          this.bind(current, created.operation_id, created.created_at);
        if (
          !created &&
          error instanceof AgentLordError &&
          PENDING_CODES.has(error.code)
        )
          return {
            version: 1,
            status: "REQUEST_PENDING",
            request: { ...current },
            pending_reason: error.asRecord(),
          };
        throw error;
      }
      if (!envelope.operation_id)
        throw new AgentLordError(
          "STATE_CORRUPT",
          "dispatched request produced no operation identity",
          { details: { request_id: id } },
        );
      current = this.bind(current, envelope.operation_id, utcNow());
      return this.result(current, envelope);
    });
  }
  /**
   * `request.status` reports registration and operation binding only. Whether
   * the provider received or completed the message is the envelope's own
   * status, artifact and delivery evidence.
   */
  private result(record: RequestRecord, envelope: Envelope): Envelope {
    return {
      ...envelope,
      request: {
        request_id: record.request_id,
        status: record.status,
        intent: record.intent.kind,
        task_id: record.intent.task_id,
        operation_id: record.operation_id,
        dispatched_at: record.dispatched_at,
      },
    };
  }
}
