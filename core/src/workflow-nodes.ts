import { isObject } from "./contracts.js";
import { usageError } from "./errors.js";
import { validateIdentifier } from "./state.js";

export interface WorkflowNode {
  role: string;
  source: {
    kind: "user_request" | "pipeline" | "replacement";
    reference: string;
    task_id?: string;
  };
}

/** Caller-declared provenance, not proof that a natural-language request authorizes a role. */
export function workflowNodes(value: unknown): Record<string, WorkflowNode> {
  if (!isObject(value) || !Object.keys(value).length)
    throw usageError("nodes-file must be a non-empty object keyed by task_id");
  const result: Record<string, WorkflowNode> = Object.create(null);
  for (const [id, raw] of Object.entries(value)) {
    validateIdentifier("task_id", id);
    if (
      !isObject(raw) ||
      Object.keys(raw).some((k) => !["role", "source"].includes(k)) ||
      typeof raw.role !== "string" ||
      !raw.role.trim() ||
      raw.role.length > 160 ||
      !isObject(raw.source)
    )
      throw usageError(`node ${id} requires role and source`);
    const source = raw.source;
    if (
      Object.keys(source).some(
        (k) => !["kind", "reference", "task_id"].includes(k),
      ) ||
      !["user_request", "pipeline", "replacement"].includes(
        String(source.kind),
      ) ||
      typeof source.reference !== "string" ||
      !source.reference.trim() ||
      source.reference.length > 16_000
    )
      throw usageError(
        `node ${id} requires an explicit source kind and reference`,
      );
    if (
      source.kind === "pipeline" &&
      !["cross-review", "plan-to-implement", "handoff"].includes(
        source.reference,
      )
    )
      throw usageError(`node ${id} names an unknown pipeline`);
    if (source.kind === "replacement") {
      if (typeof source.task_id !== "string" || source.task_id === id)
        throw usageError(
          `node ${id} requires a different replacement source task_id`,
        );
      validateIdentifier("replacement task_id", source.task_id);
    } else if (source.task_id !== undefined)
      throw usageError("source.task_id is only for replacements");
    result[id] = {
      role: raw.role,
      source: {
        kind: source.kind as WorkflowNode["source"]["kind"],
        reference: source.reference,
        ...(typeof source.task_id === "string"
          ? { task_id: source.task_id }
          : {}),
      },
    };
  }
  return result;
}

export function mergeWorkflowNodes(
  ids: string[],
  existing: Record<string, WorkflowNode> | undefined,
  added: Record<string, WorkflowNode> | undefined,
): Record<string, WorkflowNode> | undefined {
  if (!existing && !added) return undefined; // legacy task sets remain usable
  for (const [id, node] of Object.entries(added ?? {})) {
    if (!ids.includes(id))
      throw usageError(`node ${id} is not a member of this run`);
    if (
      existing &&
      Object.hasOwn(existing, id) &&
      JSON.stringify(existing[id]) !== JSON.stringify(node)
    )
      throw usageError(`node ${id} provenance is frozen`);
  }
  const merged: Record<string, WorkflowNode> = Object.assign(
    Object.create(null),
    existing,
    added,
  );
  for (const id of ids) {
    const node = merged[id];
    if (!node)
      throw usageError(`node ${id} requires provenance before registration`);
    if (node.source.kind === "replacement") {
      const previous = merged[node.source.task_id!];
      if (!previous || previous.role !== node.role)
        throw usageError(`replacement ${id} must preserve an existing role`);
      const seen = new Set([id]);
      let next: WorkflowNode | undefined = node;
      while (next?.source.kind === "replacement") {
        const old: string = next.source.task_id!;
        if (seen.has(old))
          throw usageError("replacement provenance contains a cycle");
        seen.add(old);
        next = merged[old];
      }
    }
  }
  return merged;
}
