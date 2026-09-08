import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  Loader2,
  Moon,
  RadioTower,
  Sun,
  XCircle,
} from "lucide-react";
import type {
  FinalItem,
  JournalItem,
  LifecycleItem,
  MessageItem,
  NoticeItem,
  OmittedItem,
  TaskMeta,
  TimelineItem,
  ToolItem,
} from "../shared/types";
import { applyItem, fetchOverview, fetchSnapshot, openStream } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

type ConnState = "connecting" | "live" | "reconnecting";

function relativeTime(ms: number | null): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 15_000) return "刚刚";
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function StatusDot({ meta }: { meta: TaskMeta }) {
  if (meta.statusKind === "running")
    return <span className="inline-block size-2 animate-pulse rounded-full bg-emerald-500" />;
  if (meta.statusKind === "succeeded")
    return <span className="inline-block size-2 rounded-full bg-emerald-600" />;
  if (meta.statusKind === "failed")
    return <span className="inline-block size-2 rounded-full bg-red-500" />;
  if (meta.statusKind === "needs_decision")
    return <span className="inline-block size-2 rounded-full bg-amber-500" />;
  return <span className="inline-block size-2 rounded-full bg-muted-foreground/50" />;
}

function ConnBadge({ state }: { state: ConnState }) {
  const label = state === "live" ? "实时连接" : state === "connecting" ? "连接中" : "重连中";
  return (
    <Badge
      className={cn(
        "gap-1.5 rounded-full font-normal text-xs",
        state === "live" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
      )}
      variant="outline"
    >
      {state === "live" ? <RadioTower className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
      {label}
    </Badge>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <Button className="h-7 gap-1.5 px-2 text-xs" onClick={onCopy} size="sm" variant="outline">
      <Copy className="size-3" />
      {copied ? "已复制" : label}
    </Button>
  );
}

function DetailRow({ name, value, mono = true }: { name: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className="shrink-0 text-muted-foreground text-xs sm:w-24">{name}</span>
      <span className={cn("min-w-0 break-all text-xs", mono && "font-mono")}>{value}</span>
    </div>
  );
}

const TOOL_STATE = {
  running: "input-available",
  completed: "output-available",
  error: "output-error",
} as const;

function ToolCard({ item }: { item: ToolItem }) {
  let parsedInput: unknown = item.inputText;
  if (item.inputText) {
    try {
      parsedInput = JSON.parse(item.inputText);
    } catch {
      parsedInput = item.inputText;
    }
  }
  return (
    <Tool className="mb-0" defaultOpen={item.state === "error"}>
      <ToolHeader
        state={TOOL_STATE[item.state]}
        title={item.title ? `${item.name} · ${item.title}` : item.name}
        type={`tool-${item.name}` as `tool-${string}`}
      />
      <ToolContent>
        {item.inputText ? (
          <div className="space-y-2 overflow-hidden">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">参数</h4>
            <div className="rounded-md bg-muted/50">
              <CodeBlock
                code={typeof parsedInput === "string" ? parsedInput : JSON.stringify(parsedInput, null, 2)}
                language={typeof parsedInput === "string" ? "shellscript" : "json"}
              />
            </div>
          </div>
        ) : null}
        <ToolOutput errorText={item.errorText} output={item.outputText} />
        {item.exitCode !== undefined && item.exitCode !== 0 ? (
          <p className="text-destructive text-xs">退出码 {item.exitCode}</p>
        ) : null}
      </ToolContent>
    </Tool>
  );
}

function MarkerRow({ item }: { item: LifecycleItem | JournalItem }) {
  const level = item.kind === "journal" ? item.level : "info";
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs",
        level === "error" ? "text-destructive" : level === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
      )}
    >
      <Circle className="size-1.5 fill-current" />
      <span>{item.label}</span>
      {item.kind === "journal" && item.detail ? (
        <span className="min-w-0 truncate text-muted-foreground">· {item.detail}</span>
      ) : null}
    </div>
  );
}

function NoticeRow({ item }: { item: NoticeItem }) {
  return (
    <div className="rounded-md border border-amber-300/50 bg-amber-50 px-3 py-1.5 text-amber-800 text-xs dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-300">
      {item.text}
    </div>
  );
}

function OmittedRow({ item }: { item: OmittedItem }) {
  return (
    <div className="text-muted-foreground/70 text-xs">
      已省略 {item.count} 条 {item.name} 事件
    </div>
  );
}

function FinalRow({ item }: { item: FinalItem }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        item.ok
          ? "border-emerald-300/50 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-red-300/50 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300",
      )}
    >
      {item.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0">
        <span>
          {item.ok ? "本轮执行结束" : "本轮执行失败"}
          {item.durationMs ? `（耗时 ${(item.durationMs / 1000).toFixed(1)} 秒）` : ""}
        </span>
        {item.summary ? <p className="mt-1 whitespace-pre-wrap break-words text-xs">{item.summary}</p> : null}
      </div>
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "message": {
      const message = item as MessageItem;
      return (
        <Message from="assistant">
          <MessageContent>
            <MessageResponse isAnimating={message.streaming}>{message.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    }
    case "tool":
      return <ToolCard item={item as ToolItem} />;
    case "lifecycle":
    case "journal":
      return <MarkerRow item={item as LifecycleItem | JournalItem} />;
    case "notice":
      return <NoticeRow item={item as NoticeItem} />;
    case "omitted":
      return <OmittedRow item={item as OmittedItem} />;
    case "final":
      return <FinalRow item={item as FinalItem} />;
    default:
      return null;
  }
}

function TaskListEntry({ meta, selected, onSelect }: { meta: TaskMeta; selected: boolean; onSelect: () => void }) {
  return (
    <button
      className={cn(
        "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected ? "border-primary/40 bg-accent" : "border-transparent hover:bg-accent/60",
      )}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-center gap-2">
        <StatusDot meta={meta} />
        <span className="min-w-0 truncate font-medium text-sm">{meta.title}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-muted-foreground text-xs">
        <span>{meta.providerLabel}</span>
        <span>·</span>
        <span>{meta.status}</span>
        <span className="ml-auto">{relativeTime(meta.lastActivityMs)}</span>
      </div>
    </button>
  );
}

export default function App() {
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem("observer-theme") === "dark" ||
      (localStorage.getItem("observer-theme") === null &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("observer-theme", dark ? "dark" : "light");
  }, [dark]);

  const [tasks, setTasks] = useState<TaskMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [meta, setMeta] = useState<TaskMeta | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const streamCloser = useRef<(() => void) | null>(null);
  const syncEpoch = useRef(0);

  // Overview poll (2.5s) keeps the task list & statuses fresh.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const overview = await fetchOverview();
        if (cancelled) return;
        setTasks(overview.tasks);
        setSelectedId((current) => {
          if (current) return current;
          const running = overview.tasks.find((task) => task.running);
          return (running ?? overview.tasks[0])?.taskId ?? null;
        });
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(String(error instanceof Error ? error.message : error));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Snapshot + SSE per selected task, with reset-driven resync.
  const sync = useCallback((taskId: string) => {
    const epoch = ++syncEpoch.current;
    streamCloser.current?.();
    streamCloser.current = null;
    setConn("connecting");
    void fetchSnapshot(taskId)
      .then((snapshot) => {
        if (syncEpoch.current !== epoch) return;
        setItems(snapshot.items);
        setMeta(snapshot.task);
        setTruncated(snapshot.truncatedHistory);
        setConn("live");
        streamCloser.current = openStream(taskId, snapshot.cursor, {
          onDelta(delta) {
            if (syncEpoch.current !== epoch) return;
            setItems((current) => {
              let next = current;
              for (const patch of delta.patches) next = applyItem(next, patch.item);
              return next;
            });
            if (delta.task) setMeta(delta.task);
          },
          onReset() {
            if (syncEpoch.current !== epoch) return;
            setConn("reconnecting");
            setTimeout(() => {
              if (syncEpoch.current === epoch) sync(taskId);
            }, 1200);
          },
          onStateChange(state) {
            if (syncEpoch.current === epoch) setConn(state);
          },
        });
      })
      .catch(() => {
        if (syncEpoch.current !== epoch) return;
        setConn("reconnecting");
        setTimeout(() => {
          if (syncEpoch.current === epoch) sync(taskId);
        }, 2000);
      });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setItems([]);
    setMeta(null);
    sync(selectedId);
    return () => {
      syncEpoch.current += 1;
      streamCloser.current?.();
      streamCloser.current = null;
    };
  }, [selectedId, sync]);

  const activeMeta = meta ?? tasks.find((task) => task.taskId === selectedId) ?? null;
  const visibleItems = useMemo(() => items, [items]);

  return (
    <div className="flex h-full">
      {/* Wide layout: sidebar task list */}
      <aside className="hidden w-72 shrink-0 flex-col border-r bg-card/50 lg:flex">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h1 className="font-semibold text-sm">Agent Lord 实时观察</h1>
          <Button
            aria-label="切换主题"
            className="size-7"
            onClick={() => setDark((value) => !value)}
            size="icon"
            variant="ghost"
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
        <p className="px-4 pb-3 text-muted-foreground text-xs">只读观察 · 不发送、不干预</p>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {tasks.map((task) => (
            <TaskListEntry
              key={task.taskId}
              meta={task}
              onSelect={() => setSelectedId(task.taskId)}
              selected={task.taskId === selectedId}
            />
          ))}
          {!tasks.length && !loadError ? (
            <p className="px-2 text-muted-foreground text-xs">正在加载任务…</p>
          ) : null}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Narrow layout: compact switcher */}
        <div className="flex items-center gap-2 border-b px-3 py-2 lg:hidden">
          <select
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            onChange={(event) => setSelectedId(event.target.value)}
            value={selectedId ?? ""}
          >
            {tasks.map((task) => (
              <option key={task.taskId} value={task.taskId}>
                {task.title} · {task.status}
              </option>
            ))}
          </select>
          <Button
            aria-label="切换主题"
            className="size-8 shrink-0"
            onClick={() => setDark((value) => !value)}
            size="icon"
            variant="ghost"
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>

        {activeMeta ? (
          <header className="border-b px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <StatusDot meta={activeMeta} />
              <h2 className="min-w-0 truncate font-semibold text-base">{activeMeta.title}</h2>
              <Badge className="rounded-full font-normal text-xs" variant="secondary">
                {activeMeta.providerLabel}
              </Badge>
              {activeMeta.model ? (
                <span className="max-w-56 truncate font-mono text-muted-foreground text-xs">{activeMeta.model}</span>
              ) : null}
              <span className="text-muted-foreground text-xs">{activeMeta.status}</span>
              {activeMeta.delivery ? (
                <Badge className={cn("rounded-full font-normal text-xs", activeMeta.delivery.status === "incomplete" && "text-amber-600 dark:text-amber-400")} variant="outline">
                  {activeMeta.delivery.status === "verified" ? "声明的交付项已核验" : activeMeta.delivery.status === "incomplete" ? "交付项未齐" : "交付未核验"}
                </Badge>
              ) : null}
              {activeMeta.recovery ? (
                <span className="text-muted-foreground text-xs">同会话续做 {activeMeta.recovery.attempt}/{activeMeta.recovery.limit}{activeMeta.recovery.available ? " · 可继续" : ""}</span>
              ) : null}
              {activeMeta.provisional ? (
                <Badge className="rounded-full font-normal text-xs" variant="outline">
                  任务记录尚未建立（据操作记录观察）
                </Badge>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <ConnBadge state={conn} />
              </div>
            </div>
            {activeMeta.error ? (
              <p className="mt-1.5 break-words text-destructive text-xs">{activeMeta.error}</p>
            ) : null}
            {activeMeta.running && activeMeta.activity ? (
              <p className="mt-2 text-muted-foreground text-xs" aria-live="polite">
                {activeMeta.activity.activeToolCount > 0
                  ? `正在执行 ${activeMeta.activity.activeTools.join("、") || "工具"}（${activeMeta.activity.activeToolCount} 项）`
                  : activeMeta.activity.lastTool ? `${activeMeta.activity.lastTool} 已结束，等待后续事件` : "等待输出"}
                {activeMeta.activity.lastProgressMs ? ` · 最近事件 ${relativeTime(activeMeta.activity.lastProgressMs)}` : ""}
              </p>
            ) : null}
            <Collapsible>
              <CollapsibleTrigger className="mt-2 flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
                <ChevronDown className="size-3 transition-transform data-[state=open]:rotate-180" />
                详情与续聊
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-1.5 rounded-md bg-muted/40 p-3">
                <DetailRow name="任务 ID" value={activeMeta.taskId} />
                <DetailRow name="最近操作" value={activeMeta.lastOperationId} />
                {activeMeta.delivery ? (
                  <div className="space-y-1 border-b pb-2">
                    <p className="text-muted-foreground text-xs">交付核验仅检查声明的非空文件和提交；测试结果与页面效果需单独验收。</p>
                    {activeMeta.delivery.checks.map((check, index) => (
                      <p className={cn("break-all text-xs", !check.ok && "text-amber-600 dark:text-amber-400")} key={index}>
                        {check.ok ? "✓" : "待完成"} {check.label}
                      </p>
                    ))}
                    <DetailRow name="交付提交" value={activeMeta.delivery.commitSha} />
                  </div>
                ) : null}
                <DetailRow name="工作目录" value={activeMeta.target} />
                <DetailRow name="Session" value={activeMeta.resume.sessionId} />
                <DetailRow mono={false} name="ID 来源" value={activeMeta.resume.sessionSource} />
                <DetailRow mono={false} name="能力" value={activeMeta.capability} />
                <DetailRow mono={false} name="事件粒度" value={activeMeta.granularity} />
                <DetailRow mono={false} name="数据根" value={activeMeta.resume.dataRootNote} />
                {activeMeta.effort ? <DetailRow mono={false} name="Effort" value={activeMeta.effort} /> : null}
                {activeMeta.permissionMode ? (
                  <DetailRow mono={false} name="权限模式" value={activeMeta.permissionMode} />
                ) : null}
                {activeMeta.resume.command ? (
                  <div className="flex flex-col gap-1.5 pt-1">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">原生续聊命令</span>
                      <CopyButton label="复制命令" text={activeMeta.resume.command} />
                    </div>
                    <code className="break-all rounded bg-background px-2 py-1.5 font-mono text-xs">
                      {activeMeta.resume.command}
                    </code>
                    <p className="text-muted-foreground text-xs">{activeMeta.resume.note}</p>
                  </div>
                ) : (
                  <p className="pt-1 text-muted-foreground text-xs">{activeMeta.resume.note}</p>
                )}
              </CollapsibleContent>
            </Collapsible>
          </header>
        ) : null}

        {loadError ? (
          <div className="border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
            无法连接观察服务：{loadError}
          </div>
        ) : null}
        {truncated ? (
          <div className="border-b bg-amber-50 px-4 py-1.5 text-amber-800 text-xs dark:bg-amber-950/40 dark:text-amber-300">
            较早的时间线条目已超出保留窗口，仅显示最近部分
          </div>
        ) : null}

        <Conversation className="flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-3 px-4 py-5">
            {visibleItems.map((item) => (
              <TimelineRow item={item} key={item.id} />
            ))}
            {!visibleItems.length ? (
              <ConversationEmptyState
                description="等待该任务产生可展示的输出"
                title="暂无时间线内容"
              />
            ) : null}
          </ConversationContent>
          <ConversationScrollButton aria-label="回到最新" />
        </Conversation>
      </main>
    </div>
  );
}
