import type { TaskMeta } from "../../shared/types";

export interface ScheduledModelSummary {
  /** Final model-name segment, e.g. `claude-opus-5`; null when nothing was recorded. */
  name: string | null;
  /** Full recorded route, kept for tooltip/copy so the header never loses evidence. */
  full: string | null;
  /** Requested reasoning strength (MCode variant or Claude/Codex effort); null when unspecified. */
  strength: string | null;
  /** Where the strength came from, so the UI never implies a verified runtime value. */
  strengthSource: "variant" | "effort" | null;
}

/** Split a recorded model route into its final name segment and inline `#variant`.
 * Purely textual: it never infers a runtime-reported value. */
export function parseModelRoute(raw: string | null | undefined): { name: string | null; variant: string | null } {
  const value = raw?.trim();
  if (!value) return { name: null, variant: null };
  const hash = value.indexOf("#");
  const route = hash >= 0 ? value.slice(0, hash) : value;
  const variant = hash >= 0 ? value.slice(hash + 1).trim() || null : null;
  const segments = route.split(/[/:]/).filter((segment) => segment.length > 0);
  return { name: segments.length ? segments[segments.length - 1] : null, variant };
}

/** Summarize the scheduled (requested) model for the always-visible task header.
 * Requested values only — an unverified runtime model or effort is never invented. */
export function summarizeScheduledModel(meta: Pick<TaskMeta, "provider" | "model" | "effort" | "execution"> | null | undefined): ScheduledModelSummary {
  if (!meta) return { name: null, full: null, strength: null, strengthSource: null };
  const execution = meta.execution;
  const full = execution?.requestedModel ?? meta.model ?? null;
  const { name, variant } = parseModelRoute(full);
  const mcode = meta.provider === "mcode-cli";
  const requestedVariant = execution?.requestedVariant ?? variant;
  const requestedEffort = execution?.requestedEffort ?? meta.effort ?? null;
  const order: Array<["variant" | "effort", string | null]> = mcode
    ? [["variant", requestedVariant], ["effort", requestedEffort]]
    : [["effort", requestedEffort], ["variant", requestedVariant]];
  const picked = order.find(([, value]) => Boolean(value));
  return { name, full, strength: picked?.[1] ?? null, strengthSource: picked?.[0] ?? null };
}
