import type { TaskMeta } from "../../shared/types";
import { summarizeScheduledModel } from "@/lib/model-summary";
import { Badge } from "./ui/badge";

/** Always-visible header summary of the scheduled model and its requested
 * reasoning strength. Only the final model-name segment is shown so a long
 * provider route never dominates the header; the full route stays in the
 * tooltip and in the 模型与调度信息 panel. */
export function ScheduledModel({ meta }: { meta: Pick<TaskMeta, "provider" | "model" | "effort" | "execution"> }) {
  const { name, full, strength, strengthSource } = summarizeScheduledModel(meta);
  if (!name) return null;
  const strengthTitle = strengthSource === "variant" ? "请求推理档位（MCode variant）" : "请求 Effort";
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="max-w-40 truncate font-mono text-muted-foreground text-xs" title={full ?? name}>{name}</span>
      {strength ? (
        <Badge className="rounded-full font-normal text-[10px]" title={strengthTitle} variant="outline">{strength}</Badge>
      ) : null}
    </span>
  );
}
