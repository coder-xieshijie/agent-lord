import { readFileSync } from "node:fs";
import path from "node:path";
import { IDENTIFIER_PATTERN } from "./scan.js";

/** Only explicitly subscribed runs expand visibility; never discover unrelated tasks. */
export function runTasks(root: string, runId: string): string[] {
  if (!IDENTIFIER_PATTERN.test(runId)) throw new Error("非法 run id");
  const record = JSON.parse(readFileSync(path.join(root, "task-sets", `${runId}.json`), "utf8"));
  if (record.version !== 1 || record.run_id !== runId || !Array.isArray(record.task_ids) || !record.task_ids.length ||
      record.task_ids.some((id: unknown) => typeof id !== "string" || !IDENTIFIER_PATTERN.test(id)))
    throw new Error(`run ${runId} 的任务集合无效`);
  return [...new Set<string>(record.task_ids)].sort();
}
