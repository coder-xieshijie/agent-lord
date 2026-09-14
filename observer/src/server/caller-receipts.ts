import type { ScheduleReceipt } from "../shared/types.js";
const RECEIPT_STATUSES = new Set(["SUCCEEDED", "ERROR", "NEEDS_DECISION"]);
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Unwrap host transport containers only, retaining an operation id and receipt time. */
export function collectReceipts(value: unknown, turn: { receipts: Map<string, { atMs: number; status: ScheduleReceipt["status"] }> }, ts: number, depth = 0): void {
  if (depth > 12) return;
  if (typeof value === "string") {
    if (value.length > 4 * 1024 * 1024) return;
    try { collectReceipts(JSON.parse(value), turn, ts, depth + 1); } catch { /* not structured transport */ }
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 1000)) collectReceipts(item, turn, ts, depth + 1);
  } else {
    const item = object(value);
    if (typeof item.status === "string" && RECEIPT_STATUSES.has(item.status)
      && typeof item.operation_id === "string" && !turn.receipts.has(item.operation_id)) {
      turn.receipts.set(item.operation_id, { atMs: ts, status: item.status as ScheduleReceipt["status"] });
      if (turn.receipts.size > 1000) turn.receipts.delete(turn.receipts.keys().next().value!);
    }
    for (const key of ["output", "text", "content", "value", "result", "actionable"]) if (key in item) collectReceipts(item[key], turn, ts, depth + 1);
  }
}

