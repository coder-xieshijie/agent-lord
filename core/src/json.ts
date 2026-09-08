import { createHash } from "node:crypto";
/** Node 24's reviver source preserves integer tokens before Number rounding. */
export function parseJson(text: string): unknown {
  const parse = JSON.parse as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string },
    ) => unknown,
  ) => unknown;
  return parse(text, (_key, value, context) => {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      context?.source &&
      /^-?\d+$/.test(context.source)
    )
      return BigInt(context.source);
    return value;
  });
}
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
/** Stable UTF-8 JSON, Python's sort_keys ordering, and lossless legacy integer tokens. */
export function stringifyJson(value: unknown, indent = 0): string {
  const encode = (item: unknown, level: number): string => {
    if (typeof item === "bigint") return item.toString();
    if (item === null || typeof item !== "object") {
      if (typeof item === "number" && !Number.isFinite(item))
        throw new TypeError("non-finite JSON number");
      return JSON.stringify(item) ?? "null";
    }
    const array = Array.isArray(item);
    const values = array
      ? item.map((v) => encode(v, level + 1))
      : Object.keys(item)
          .filter((k) => (item as Record<string, unknown>)[k] !== undefined)
          .sort(compareCodePoints)
          .map(
            (k) =>
              `${JSON.stringify(k)}:${indent ? " " : ""}${encode((item as Record<string, unknown>)[k], level + 1)}`,
          );
    const open = array ? "[" : "{";
    const close = array ? "]" : "}";
    return !values.length
      ? open + close
      : indent
        ? `${open}\n${" ".repeat((level + 1) * indent)}${values.join(`,\n${" ".repeat((level + 1) * indent)}`)}\n${" ".repeat(level * indent)}${close}`
        : open + values.join(",") + close;
  };
  return encode(value, 0);
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function equal(a: unknown, b: unknown): boolean {
  return stringifyJson(a) === stringifyJson(b);
}
