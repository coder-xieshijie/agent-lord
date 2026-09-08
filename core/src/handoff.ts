import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  type Data,
  type Expected,
  IDENTIFIER_PATTERN,
  isObject,
  object,
  records,
  string,
  strings,
} from "./contracts.js";
import { AgentLordError, errorMessage, usageError } from "./errors.js";
import { parseJson, sha256, stringifyJson } from "./json.js";
import { resolvePath } from "./paths.js";
import { git } from "./workspace.js";
export const HANDOFF_PROVIDERS = ["claude-cli", "codex-cli", "mcode-cli"];
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
function packetError(message: string, details: Data = {}): AgentLordError {
  return new AgentLordError("HANDOFF_PACKET_INVALID", message, {
    details,
    exit_code: 2,
  });
}
export function handoffConflict(
  message: string,
  details: Data = {},
): AgentLordError {
  return new AgentLordError("HANDOFF_CONFLICT", message, {
    details,
    exit_code: 2,
  });
}
export function canonicalPacketBytes(value: Data): Buffer {
  return Buffer.from(`${stringifyJson(value)}\n`, "utf8");
}
function requireString(field: string, value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value.trim())
    throw packetError("packet field must be a non-empty string", { field });
  if ([...value].length > max)
    throw packetError("packet string exceeds the size bound", {
      field,
      max_length: max,
    });
  if (value.includes("\0"))
    throw packetError("packet string contains NUL", { field });
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    throw packetError("packet string contains invalid Unicode", { field });
  return value;
}
function requireList(field: string, value: unknown): void {
  if (!Array.isArray(value) || value.length > 64)
    throw packetError("packet field must be a bounded list", {
      field,
      max_items: 64,
    });
  value.forEach((item, index) => requireString(`${field}[${index}]`, item));
}
function requireObject(
  field: string,
  value: unknown,
  required: string[],
  optional: string[] = [],
): Data {
  if (!isObject(value))
    throw packetError("packet field must be an object", { field });
  const missing = required.filter((k) => !(k in value));
  const unknown = Object.keys(value)
    .filter((k) => !required.includes(k) && !optional.includes(k))
    .sort();
  if (missing.length || unknown.length)
    throw packetError("packet object has missing or unknown fields", {
      field,
      missing,
      unknown,
    });
  return value;
}
function requireId(field: string, value: unknown): void {
  const text = requireString(field, value, 160);
  if (!IDENTIFIER_PATTERN.test(text) || text.endsWith("\n"))
    throw packetError("packet identifier has an invalid shape", { field });
}
function scanStrings(value: unknown, field: string): void {
  if (typeof value === "string")
    for (const pattern of SECRETS) {
      if (pattern.test(value))
        throw packetError(
          "packet string matches a high-confidence secret pattern",
          { field, pattern: pattern.source },
        );
    }
  else if (Array.isArray(value))
    value.forEach((v, i) => scanStrings(v, `${field}[${i}]`));
  else if (isObject(value))
    for (const [key, child] of Object.entries(value))
      scanStrings(child, `${field}.${key}`);
}
export function loadHandoffPacket(input: string): Data {
  const file = resolvePath(input);
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (error) {
    throw packetError("cannot read handoff packet file", {
      path: file,
      error: errorMessage(error),
    });
  }
  if (raw.length > 256 * 1024)
    throw packetError("handoff packet file exceeds the size bound", {
      path: file,
      max_bytes: 256 * 1024,
    });
  let value: unknown;
  try {
    value = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch (error) {
    throw packetError("handoff packet is not UTF-8 JSON", {
      path: file,
      error: errorMessage(error),
    });
  }
  if (!isObject(value))
    throw packetError("handoff packet must be a JSON object", { path: file });
  return value;
}
export function validateHandoffPacket(packet: Data): {
  canonical_bytes: Buffer;
  sha256: string;
  bytes: number;
} {
  requireObject(
    "packet",
    packet,
    [
      "schema",
      "handoff_id",
      "created_at",
      "source_session",
      "continuation",
      "authorization",
      "objective",
      "completed_work",
      "remaining_work",
      "constraints",
      "acceptance_criteria",
      "evidence",
      "sanitization",
      "integrity",
    ],
    ["key_decisions", "open_questions", "suggested_skills", "contract_request"],
  );
  if (packet.schema !== "handoff-v1")
    throw packetError("unsupported handoff packet schema", {
      field: "schema",
      observed: packet.schema,
      expected: "handoff-v1",
    });
  requireId("handoff_id", packet.handoff_id);
  const created = requireString("created_at", packet.created_at, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
      created,
    ) ||
    !Number.isFinite(Date.parse(created))
  )
    throw packetError("created_at must be an ISO-8601 timestamp", {
      field: "created_at",
    });
  const source = requireObject(
    "source_session",
    packet.source_session,
    ["kind"],
    ["opaque_id"],
  );
  const kind = requireString("source_session.kind", source.kind, 64);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(kind))
    throw packetError("source_session.kind has an invalid shape", {
      field: "source_session.kind",
    });
  if (source.opaque_id != null)
    requireString("source_session.opaque_id", source.opaque_id, 256);
  requireId(
    "continuation.task_id",
    requireObject("continuation", packet.continuation, ["task_id"]).task_id,
  );
  const auth = requireObject("authorization", packet.authorization, [
    "task",
    "workspace_writes",
    "external_writes",
  ]);
  requireString("authorization.task", auth.task);
  for (const key of ["workspace_writes", "external_writes"])
    if (typeof auth[key] !== "boolean")
      throw packetError("authorization flag must be a boolean", {
        field: `authorization.${key}`,
      });
  requireString("objective", packet.objective);
  for (const key of [
    "completed_work",
    "remaining_work",
    "constraints",
    "acceptance_criteria",
  ])
    requireList(key, packet[key]);
  for (const key of ["key_decisions", "open_questions", "suggested_skills"])
    if (key in packet) requireList(key, packet[key]);
  if (!Array.isArray(packet.evidence) || packet.evidence.length > 64)
    throw packetError("evidence must be a bounded list", {
      field: "evidence",
      max_items: 64,
    });
  packet.evidence.forEach((value, i) => {
    const field = `evidence[${i}]`;
    const item = requireObject(field, value, ["path"], ["note", "sha256"]);
    const name = requireString(`${field}.path`, item.path, 1024);
    if (
      path.isAbsolute(name) ||
      name.startsWith("~") ||
      name.split("/").includes("..") ||
      name.includes("\\")
    )
      throw packetError(
        "evidence path must stay relative to the target workspace",
        { field: `${field}.path`, path: name },
      );
    if ("note" in item) requireString(`${field}.note`, item.note);
    if (
      "sha256" in item &&
      (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))
    )
      throw packetError("evidence sha256 must be 64 lowercase hex characters", {
        field: `${field}.sha256`,
      });
  });
  const sanitization = requireObject("sanitization", packet.sanitization, [
    "raw_provider_logs",
    "hidden_reasoning",
    "secrets",
  ]);
  for (const key of Object.keys(sanitization))
    if (sanitization[key] !== false)
      throw packetError(
        "sanitization attestation must declare the packet free of this content",
        { field: `sanitization.${key}` },
      );
  if ("contract_request" in packet) {
    const request = requireObject(
      "contract_request",
      packet.contract_request,
      [],
      ["provider", "model", "effort"],
    );
    if (
      "provider" in request &&
      !HANDOFF_PROVIDERS.includes(String(request.provider))
    )
      throw packetError(
        "contract_request.provider must be a local CLI provider",
        { field: "contract_request.provider", allowed: HANDOFF_PROVIDERS },
      );
    for (const key of ["model", "effort"])
      if (key in request)
        requireString(`contract_request.${key}`, request[key], 256);
  }
  const integrity = requireObject("integrity", packet.integrity, ["sha256"]);
  const declared = integrity.sha256;
  if (typeof declared !== "string" || !/^[0-9a-f]{64}$/.test(declared))
    throw packetError("integrity.sha256 must be 64 lowercase hex characters", {
      field: "integrity.sha256",
    });
  const { integrity: _integrity, ...body } = packet;
  const computed = sha256(canonicalPacketBytes(body));
  if (computed !== declared)
    throw packetError(
      "packet content does not match its declared integrity digest",
      { field: "integrity.sha256", declared, computed },
    );
  scanStrings(packet, "packet");
  const canonical = canonicalPacketBytes(packet);
  if (canonical.length > 64 * 1024)
    throw packetError("canonical handoff packet exceeds the size bound", {
      bytes: canonical.length,
      max_bytes: 64 * 1024,
    });
  return {
    canonical_bytes: canonical,
    sha256: sha256(canonical),
    bytes: canonical.length,
  };
}
export function sourceSessionRecord(packet: Data): Data {
  const source = object(packet.source_session);
  const id = string(source.opaque_id);
  return {
    kind: source.kind,
    opaque_id: id,
    identity_assurance: id ? "caller-declared" : "unavailable",
  };
}
export function resolveContractRequest(
  packet: Data,
  provider?: string,
  model?: string | null,
  effort?: string | null,
): [string, string | null, string | null] {
  const request = object(packet.contract_request);
  const resolved = [
    ["provider", provider],
    ["model", model],
    ["effort", effort],
  ].map(([field, argument]) => {
    const requested = request[field!];
    if (argument != null && requested != null && argument !== requested)
      throw handoffConflict(
        "handoff arguments contradict the packet contract request",
        { field, argument, requested },
      );
    return argument ?? string(requested);
  });
  if (!resolved[0])
    throw usageError(
      "handoff requires a provider from the command or the packet contract request",
    );
  return [resolved[0], resolved[1] ?? null, resolved[2] ?? null];
}
export function snapshotExactTarget(target: string): Data {
  const head = git(target, ["rev-parse", "HEAD"]).stdout.trim().toLowerCase();
  const entries = git(target, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ])
    .stdout.split("\0")
    .filter(Boolean);
  const digest = createHash("sha256").update(head);
  let count = 0;
  let origin = false;
  for (const entry of entries) {
    digest.update("\0").update(entry);
    if (origin) {
      origin = false;
      continue;
    }
    if (entry.length < 4 || entry[2] !== " ") continue;
    if (["R", "C"].includes(entry[0])) origin = true;
    count++;
    let bytes = Buffer.alloc(0);
    try {
      bytes = readFileSync(path.join(target, entry.slice(3)));
    } catch {
      /* removed or unreadable file */
    }
    digest.update(createHash("sha256").update(bytes).digest());
  }
  return {
    head_sha: head,
    dirty: count > 0,
    changed_path_count: count,
    sha256: digest.digest("hex"),
  };
}
export function renderHandoffPrompt(
  packet: Data,
  digest: string,
  expected: Expected,
): string {
  const auth = object(packet.authorization);
  const source = sourceSessionRecord(packet);
  const lines = [
    "[agent-lord handoff-v1]",
    `packet_sha256: ${digest}`,
    `handoff_id: ${packet.handoff_id}`,
    `continuation_task_id: ${object(packet.continuation).task_id}`,
    "relationship: continues_user_task (you are a new endpoint; this is a sanitized context transfer, not a session migration, and no prior transcript is available)",
    `source_session: kind=${source.kind} identity=${source.identity_assurance}`,
    "",
    "## Authorized task",
    String(auth.task),
    "",
    "## Objective",
    String(packet.objective),
    "",
  ];
  const section = (title: string, items: string[]) =>
    lines.push(
      `## ${title}`,
      ...(items.length ? items.map((v) => `- ${v}`) : ["- (none declared)"]),
      "",
    );
  section("Completed work (do not redo)", strings(packet.completed_work));
  section("Remaining work", strings(packet.remaining_work));
  if (strings(packet.key_decisions).length)
    section("Key decisions", strings(packet.key_decisions));
  section("Constraints (binding)", strings(packet.constraints));
  section("Acceptance criteria", strings(packet.acceptance_criteria));
  section(
    "Evidence (workspace-relative paths)",
    records(packet.evidence).map(
      (v) => `${v.path}${v.note ? ` — ${v.note}` : ""}`,
    ),
  );
  section("Suggested skills", strings(packet.suggested_skills));
  if (strings(packet.open_questions).length)
    section("Open questions", strings(packet.open_questions));
  lines.push(
    "## Execution contract",
    `- model: ${expected.model || "provider-default"}`,
    `- effort: ${expected.effort || "provider-default"}`,
    `- permission_mode: ${expected.permission_mode}`,
    `- workspace_writes: ${auth.workspace_writes ? "allowed" : "forbidden"}`,
    `- external_writes: ${auth.external_writes ? "allowed" : "forbidden — do not push, publish, message, or call any write API"}`,
    "",
    "Work only within the authorized task and constraints above. Verify the listed evidence in the workspace before acting on it. Return one final answer.",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
