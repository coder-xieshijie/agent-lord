/** Observed MCode schema-v1 states. Unknown values stay nonterminal. */
export type McodeToolPhase =
  | "preparing"
  | "ready"
  | "executing"
  | "completed"
  | "failed"
  | "unknown";
export function mcodeToolPhase(
  status: unknown,
  event: string,
  error?: unknown,
): McodeToolPhase {
  if ((error !== undefined && error !== null) || status === 3) return "failed";
  if (status === 2) return "completed";
  if (event === "item.completed") return "unknown";
  if (status === 4) return "preparing";
  if (status === 5) return "ready";
  if (status === 1) return "executing";
  return "unknown";
}
export class McodeToolTiming {
  private first?: number;
  private executing?: number;
  private done?: number;
  observe(
    phase: McodeToolPhase,
    timestamp: unknown,
  ): { preparationMs?: number; executionMs?: number } {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return {};
    if (phase === "preparing" && this.first === undefined)
      this.first = timestamp;
    if (phase === "executing" && this.executing === undefined)
      this.executing = timestamp;
    if (
      (phase === "completed" || phase === "failed") &&
      this.done === undefined
    )
      this.done = timestamp;
    const result: { preparationMs?: number; executionMs?: number } = {};
    if (
      this.first !== undefined &&
      this.executing !== undefined &&
      this.executing >= this.first
    )
      result.preparationMs = this.executing - this.first;
    if (
      this.executing !== undefined &&
      this.done !== undefined &&
      this.done >= this.executing
    )
      result.executionMs = this.done - this.executing;
    return result;
  }
}
