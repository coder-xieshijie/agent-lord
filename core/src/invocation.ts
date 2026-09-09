import { homedir } from "node:os";
import path from "node:path";
import { isObject, type CallerIdentity, type Invocation } from "./contracts.js";
import { usageError } from "./errors.js";

function optionalText(
  value: unknown,
  name: string,
  limit: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw usageError(
      `invocation.${name} must be non-empty text up to ${limit} characters`,
    );
  return value;
}

function id(value: unknown, name: string): string | null {
  const text = optionalText(value, name, 160);
  if (text !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text))
    throw usageError(`invocation.${name} is not a valid opaque id`);
  return text;
}

/** Capture once at dispatch; retries and reads never replace the original caller. */
export function resolveInvocation(
  value: unknown,
  recovery = false,
  env: NodeJS.ProcessEnv = process.env,
): Invocation {
  if (value !== undefined && !isObject(value))
    throw usageError("invocation must be an object");
  const raw = isObject(value) ? value : {};
  const allowed = new Set(["caller", "trigger", "user_request", "reason"]);
  if (Object.keys(raw).some((key) => !allowed.has(key)))
    throw usageError("unknown invocation field");
  let caller: CallerIdentity;
  if (raw.caller !== undefined) {
    if (!isObject(raw.caller))
      throw usageError("invocation.caller must be an object");
    const c = raw.caller;
    if (
      Object.keys(c).some(
        (key) => !["kind", "session_id", "turn_id", "data_root"].includes(key),
      )
    )
      throw usageError("unknown invocation.caller field");
    const kind = id(c.kind, "caller.kind");
    if (!kind) throw usageError("invocation.caller.kind is required");
    const session = id(c.session_id, "caller.session_id");
    const turn = id(c.turn_id, "caller.turn_id");
    if (turn && !session)
      throw usageError("invocation.caller.turn_id requires a session_id");
    const root = optionalText(c.data_root, "caller.data_root", 4096);
    if (root && !path.isAbsolute(root))
      throw usageError("invocation.caller.data_root must be absolute");
    caller = {
      kind,
      session_id: session,
      turn_id: turn,
      identity_source: session ? "caller-declared" : "unavailable",
    };
    if (kind === "codex" && root) caller.data_root = path.resolve(root);
  } else {
    const session = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
    caller =
      session && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(session)
        ? {
            kind: "codex",
            session_id: session,
            turn_id:
              env.CODEX_TURN_ID &&
              /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(env.CODEX_TURN_ID)
                ? env.CODEX_TURN_ID
                : null,
            identity_source: "runtime-env",
            data_root: path.resolve(
              env.CODEX_HOME || path.join(homedir(), ".codex"),
            ),
          }
        : {
            kind: "unknown",
            session_id: null,
            turn_id: null,
            identity_source: "unavailable",
          };
  }
  const request = optionalText(raw.user_request, "user_request", 1_000_000);
  const trigger = raw.trigger ?? (request ? "user_request" : "unspecified");
  if (
    !["user_request", "caller_followup", "recovery", "unspecified"].includes(
      String(trigger),
    )
  )
    throw usageError("invalid invocation.trigger");
  return {
    caller,
    trigger: recovery ? "recovery" : (trigger as Invocation["trigger"]),
    user_request: request,
    reason: optionalText(raw.reason, "reason", 16_000),
  };
}
