import { type Data, isObject } from "./contracts.js";
import { sha256 } from "./json.js";

export interface ReportState {
  [taskId: string]: string;
}

/** Liveness counters and tool names are intentionally absent from notification identity. */
export function reportChanges(tasks: Data[], previous: ReportState) {
  const next = { ...previous };
  const events: Data[] = [];
  for (const task of tasks) {
    const id = String(task.task_id);
    const phase = ["preparing", "running", "recovering", "submitted"].includes(
      String(task.status),
    )
      ? "active"
      : task.status;
    const key = sha256(
      JSON.stringify([
        task.operation_id,
        phase,
        task.delivery,
        task.result_key ?? null,
        task.action_id ?? null,
        task.error_code ?? null,
      ]),
    );
    if (previous[id] === key) continue;
    next[id] = key;
    // Registration and lack of observations are state, not execution progress.
    if (task.status === "not_observed") continue;
    const node = isObject(task.node) ? task.node : {};
    const source = isObject(node.source) ? node.source : {};
    events.push({
      task_id: id,
      operation_id: task.operation_id,
      status: task.status,
      kind:
        phase === "active"
          ? source.kind === "replacement"
            ? "replacement_started"
            : "operation_started"
          : task.status === "succeeded"
            ? "completed"
            : task.status === "failed"
              ? "failed"
              : "action_required",
      delivery_scope: "declared-files-and-commit",
      delivery_status: task.delivery,
    });
  }
  return {
    next,
    reporting: {
      should_notify: events.length > 0,
      events,
      basis: "operation-state-and-declared-delivery",
      liveness_is_not_a_milestone: true,
    },
  };
}
