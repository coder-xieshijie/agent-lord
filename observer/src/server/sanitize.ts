/** Sanitization helpers: clip free text, extract only whitelisted fields.
 * Unknown payloads are never passed through verbatim. */

export const MESSAGE_CLIP = 16_000;
export const TOOL_TEXT_CLIP = 4_000;
export const TITLE_CLIP = 200;

export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）`;
}

export function clipTitle(text: string, limit = TITLE_CLIP): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}

/** One-line human summary for a tool input object. */
export function toolTitle(input: unknown): string | undefined {
  if (typeof input === "string") return clipTitle(input);
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of [
    "command",
    "cmd",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value) return clipTitle(value);
  }
  const keys = Object.keys(record);
  return keys.length ? clipTitle(keys.map((k) => `${k}=${previewValue(record[k])}`).join(" ")) : undefined;
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : "{…}";
  return String(value);
}

/** Pretty input for the collapsed details block. */
export function toolInputText(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") return clip(input, TOOL_TEXT_CLIP);
  try {
    return clip(JSON.stringify(input, null, 2), TOOL_TEXT_CLIP);
  } catch {
    return undefined;
  }
}

/** Extract readable text from a tool result shaped as content[].text / stdout /
 * plain string. Structured leftovers are summarized, never dumped raw. */
export function toolOutputText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return clip(output, TOOL_TEXT_CLIP);
  if (Array.isArray(output)) {
    const text = output
      .map((entry) => (typeof entry === "string" ? entry : extractContentText(entry)))
      .filter((part): part is string => Boolean(part))
      .join("\n");
    return text ? clip(text, TOOL_TEXT_CLIP) : `（结构化结果，共 ${output.length} 项）`;
  }
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    const fromContent = extractContentText(record);
    if (fromContent) return clip(fromContent, TOOL_TEXT_CLIP);
    for (const key of ["stdout", "text", "message", "result", "output"]) {
      const value = record[key];
      if (typeof value === "string" && value) return clip(value, TOOL_TEXT_CLIP);
    }
    const keys = Object.keys(record);
    return keys.length ? `（结构化结果：${keys.slice(0, 8).join(", ")}）` : undefined;
  }
  return String(output);
}

function extractContentText(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block) =>
        block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
          ? ((block as Record<string, unknown>).text as string)
          : undefined,
      )
      .filter((part): part is string => Boolean(part));
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

/** Wrap a value for safe copy-paste into a POSIX shell. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._\/:@%+=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
