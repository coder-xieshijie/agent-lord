import type { TimelineItem, ToolItem } from "../../shared/types";

export interface ToolGroup {
  kind: "tool-group";
  id: string;
  tools: ToolItem[];
}

export function isExecutionDetail(item: TimelineItem): boolean {
  return item.kind === "lifecycle" || item.kind === "omitted"
    || (item.kind === "journal" && item.level !== "error")
    || (item.kind === "final" && item.ok);
}

/** Group only consecutive successful tools in one known operation.
 * Hidden events remain boundaries; projection never discards or mutates source items. */
export function presentTimeline(items: TimelineItem[]): {
  rows: Array<TimelineItem | ToolGroup>;
  details: TimelineItem[];
} {
  const rows: Array<TimelineItem | ToolGroup> = [];
  const details: TimelineItem[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= 3) rows.push({ kind: "tool-group", id: `group:${run[0].id}`, tools: run });
    else rows.push(...run);
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && item.state === "completed" && item.opId) {
      if (run.length && run[0].opId !== item.opId) flush();
      run.push(item);
    } else {
      flush();
      if (isExecutionDetail(item)) details.push(item);
      else rows.push(item);
    }
  }
  flush();
  return { rows, details };
}

export function toolSummary(tools: ToolItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(" · ");
}
