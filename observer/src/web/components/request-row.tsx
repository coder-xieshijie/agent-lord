import type { RequestItem } from "../../shared/types";
import { CopyButton } from "./copy-button";

export function requestLabel(item: RequestItem): string {
  if (item.role === "user") return "用户原始请求";
  if (item.trigger === "recovery") return "同会话恢复请求";
  if (item.trigger === "caller_followup") return `${item.caller?.kind === "codex" ? "Codex" : "调度方"} 补充请求`;
  return "实际派发请求";
}

export function RequestRow({ item, open = false, onOpenChange }: { item: RequestItem; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const long = item.text.length > 800 || item.text.split("\n").length > 12;
  return <section className="my-3 min-w-0 rounded-lg border bg-muted/30 p-3" aria-label={requestLabel(item)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{requestLabel(item)}</span>
      <CopyButton text={item.text} label="复制请求" />
    </div>
    <p className="mt-1 break-all text-xs text-muted-foreground">操作：{item.opId}</p>
    {item.role === "caller" && <p className="mt-1 break-all text-xs text-muted-foreground">调度 Session：{item.caller?.session_id ?? "未记录"}</p>}
    {item.reason && <p className="mt-2 whitespace-pre-wrap break-words text-sm">补充原因：{item.reason}</p>}
    {item.role === "caller" && !item.originalRecorded && <p className="mt-1 text-xs text-muted-foreground">用户原始请求未单独记录；以下为实际派发内容。</p>}
    {long ? <details className="mt-2" open={open} onToggle={(event) => onOpenChange?.(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">{open ? "收起" : "展开"}请求全文（{item.text.length} 字符）</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-6">{item.text}</pre>
    </details> : <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-6">{item.text}</pre>}
  </section>;
}
