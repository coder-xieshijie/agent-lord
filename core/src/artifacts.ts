import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type Artifact,
  type Data,
  isObject,
  object,
  string,
} from "./contracts.js";
import { AgentLordError, errorMessage, usageError } from "./errors.js";
import { parseJson, sha256 } from "./json.js";
import { atomicWrite, ensureLayout, validateIdentifier } from "./state.js";
export function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((v) =>
      typeof v === "string"
        ? [v]
        : isObject(v) &&
            ["text", "output_text", "input_text"].includes(String(v.type)) &&
            typeof v.text === "string"
          ? [v.text]
          : [],
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}
export function* walk(value: unknown): Generator<Data> {
  if (isObject(value)) {
    yield value;
    for (const child of Object.values(value)) yield* walk(child);
  } else if (Array.isArray(value))
    for (const child of value) yield* walk(child);
}
export function extractClaudeResult(result: Data): string {
  if (string(result.result)?.trim()) return (result.result as string).trim();
  for (const key of ["message", "content", "response"]) {
    const text = contentText(result[key]);
    if (text) return text;
  }
  throw new AgentLordError(
    "RESULT_INVALID",
    "Claude result contains no final assistant text",
  );
}
export function extractCodexResult(value: unknown, marker?: string): string {
  let seen = !marker;
  let result = "";
  for (const item of walk(value)) {
    const text = contentText(item.content) || string(item.text)?.trim() || "";
    if (marker && text.includes(marker)) {
      seen = true;
      continue;
    }
    if (
      seen &&
      text &&
      (item.role === "assistant" ||
        ["agent_message", "assistantMessage"].includes(String(item.type)))
    )
      result = text;
  }
  if (!result)
    throw new AgentLordError(
      "RESULT_NOT_READY",
      "Codex result has no assistant response after this operation",
      { retryable: true },
    );
  return result;
}
export function jsonLines(text: string): Data[] {
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      const value = parseJson(line);
      return isObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}
/** Read JSON objects even when the CLI prints diagnostic prose before its result. */
export function jsonObjects(text: string): Data[] {
  const result: Data[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{", cursor);
    if (start < 0) break;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end > 0) {
      try {
        const value = parseJson(text.slice(start, end));
        if (isObject(value)) result.push(value);
        cursor = end;
        continue;
      } catch {
        /* try the next object start */
      }
    }
    cursor = start + 1;
  }
  return result;
}
export function extractJsonlWithMetadata(
  file: string,
  format: string,
  marker?: string,
  session?: string,
): { text: string; observed: Data } {
  if (session !== undefined && format !== "claude-jsonl")
    throw usageError(
      "session binding is only defined for claude-jsonl sources",
      { source_format: format },
    );
  if (!["claude-jsonl", "codex-jsonl"].includes(format))
    throw usageError("unsupported artifact source format", {
      source_format: format,
    });
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new AgentLordError("RESULT_INVALID", "cannot read artifact source", {
      details: { path: file, error: errorMessage(error) },
    });
  }
  let candidates: string[] = [];
  let models: string[] = [];
  let efforts: string[] = [];
  let markerSeen = !marker;
  let sessionSeen = session === undefined;
  let currentModel: string | null = null;
  let currentEffort: string | null = null;
  const recordContract = () => {
    if (currentModel) models.push(currentModel);
    if (currentEffort) efforts.push(currentEffort);
  };
  for (const item of jsonLines(raw)) {
    let text = "";
    if (format === "claude-jsonl") {
      if (
        item.type !== "assistant" ||
        (session !== undefined &&
          (item.sessionId ?? item.session_id) !== session)
      )
        continue;
      sessionSeen = true;
      const message = object(item.message);
      if (message.role !== "assistant") continue;
      if (string(message.model)) models.push(message.model as string);
      const effort = string(item.effort) || string(item.reasoning_effort);
      if (effort) efforts.push(effort);
      text = contentText(message.content);
    } else {
      const payload = object(item.payload);
      if (item.type === "turn_context") {
        currentModel = string(payload.model) || currentModel;
        currentEffort =
          string(payload.effort) ||
          string(payload.reasoning_effort) ||
          currentEffort;
        if (markerSeen) recordContract();
        continue;
      }
      if (item.type !== "response_item" || payload.type !== "message") continue;
      text = contentText(payload.content);
      if (marker && payload.role === "user" && text.includes(marker)) {
        markerSeen = true;
        candidates = [];
        models = [];
        efforts = [];
        recordContract();
        continue;
      }
      if (payload.role !== "assistant" || !markerSeen) continue;
    }
    if (text) candidates.push(text);
  }
  if (!markerSeen)
    throw new AgentLordError(
      "RESULT_INVALID",
      "artifact source does not contain the requested operation marker",
      { details: { path: file } },
    );
  if (!sessionSeen)
    throw new AgentLordError(
      "RESULT_INVALID",
      "artifact source contains no assistant record for the requested session",
      { details: { path: file, session_id: session } },
    );
  if (!candidates.length)
    throw new AgentLordError(
      "RESULT_INVALID",
      "artifact source contains no final assistant message",
      { details: { path: file } },
    );
  return {
    text: candidates.at(-1)!,
    observed: {
      models: models.length ? [models.at(-1)] : [],
      effort: efforts.at(-1) ?? null,
      effort_verification: efforts.length ? "provider-metadata" : "unavailable",
    },
  };
}
export function writeArtifact(
  taskId: string,
  operationId: string,
  text: string,
  root: string,
  suffix = ".md",
): Artifact {
  ensureLayout(root);
  validateIdentifier("task_id", taskId);
  validateIdentifier("operation_id", operationId);
  const file = path.join(root, "artifacts", taskId, operationId + suffix);
  const content = suffix === ".md" ? `${text.trimEnd()}\n` : text;
  atomicWrite(file, content);
  return {
    path: file,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
  };
}
