/** Scheduling-timeline panel: scheduler Turns on the first lane, every child
 * execution session below on the same time axis. Read-only projection of
 * /api/schedule; selection drives relation edges and detail locating. */

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ScheduleGroup, ScheduleOperation } from "../../shared/types";
import { fetchSchedule } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  crosshairLabel,
  defaultRangeKey,
  edgesForSelection,
  layoutSchedule,
  rangeOptions,
  type ScheduleLayout,
} from "@/lib/schedule-timeline";

const ROW_H = 32;
const ROW_GAP = 4;

function rowCenterY(rowIndex: number): number {
  return rowIndex * (ROW_H + ROW_GAP) + ROW_H / 2;
}

function statusColor(op: ScheduleOperation): string {
  if (op.running) return "bg-emerald-500/70 animate-pulse";
  if (op.status === "succeeded") return "bg-emerald-600/80";
  if (op.status === "failed") return "bg-red-500/80";
  if (op.status === "needs_decision") return "bg-amber-500/80";
  return "bg-muted-foreground/50";
}

const MARKER_STYLE: Record<string, { className: string; label: string }> = {
  dispatch: { className: "bg-foreground/70", label: "派发" },
  "executor-start": { className: "bg-sky-500", label: "执行端开始" },
  completed: { className: "bg-foreground", label: "执行结束" },
  artifact: { className: "bg-violet-500", label: "产物可用" },
  receipt: { className: "bg-amber-500", label: "调度收到回执" },
};

function fmt(ms: number | null): string {
  return ms === null ? "未记录" : new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function OperationDetail({ group, op, taskId }: { group: ScheduleGroup; op: ScheduleOperation; taskId: string }) {
  const task = group.tasks.find((item) => item.taskId === taskId);
  const foreignCaller = op.callerSessionId && group.sessionId && op.callerSessionId !== group.sessionId;
  const rows: Array<[string, string]> = [
    ["派发（操作创建）", fmt(op.createdAtMs)],
    ["执行端开始", op.executorStartedAtMs === null ? "无 journal 证据" : fmt(op.executorStartedAtMs)],
    ["执行结束", fmt(op.completedAtMs)],
    ["产物可用", op.hasArtifact
      ? `${fmt(op.artifactExportedAtMs ?? op.completedAtMs)}${op.artifactReadyApprox ? "（以执行结束时间近似）" : ""}`
      : "无产物"],
    ["调度收到回执", op.receipt
      ? `${fmt(op.receipt.atMs)} · ${op.receipt.status} · Turn ${op.receipt.turnId ?? "未记录"}`
      : "未观测到结构化回执"],
    ["交付核验", op.deliveryStatus === "verified" ? "声明的交付项已核验（无独立时间戳）" : op.deliveryStatus === "incomplete" ? "交付项未齐" : op.deliveryStatus === "unverified" ? "未核验" : "未声明"],
  ];
  return (
    <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-3 text-xs">
      <p className="break-all font-medium">{task?.title ?? taskId} · 操作 {op.operationId}</p>
      <p className="text-muted-foreground">
        触发：{op.trigger} · 派发 Turn：{op.dispatchTurnId ?? "未绑定"}
        {op.dispatchBinding === "inferred-by-create-time" ? "（按创建时间推断）" : op.dispatchBinding === "recorded" ? "（记录）" : ""}
        {op.attempt ? ` · 同会话续做第 ${op.attempt} 次` : ""}
      </p>
      {foreignCaller ? (
        <p className="text-amber-600 dark:text-amber-400">本轮实际调用者是其他会话：{op.callerSessionId}（归属仍按最初拉起的调度会话）</p>
      ) : null}
      {op.clockAnomaly ? <p className="text-destructive">时间顺序异常：记录的结束时间早于创建时间，按原始证据展示</p> : null}
      {task?.parallel ? (
        <p className="text-muted-foreground">
          并行组 {task.parallel.group} · {task.parallel.role === "integrator"
            ? `integrator，等待全部 workers：${task.parallel.workers.join("、")}`
            : `worker → integrator 任务 ${task.parallel.integratorTaskId}`}
        </p>
      ) : null}
      {rows.map(([name, value]) => (
        <p className="break-all" key={name}><span className="text-muted-foreground">{name}：</span>{value}</p>
      ))}
      {op.errorCode ? <p className="text-destructive">错误码：{op.errorCode}</p> : null}
      <p className="text-muted-foreground">收到回执仅表示调度会话已接收结构化结果，不代表已分析；主调度 Turn 结束是另一独立事实。</p>
    </div>
  );
}

export function ScheduleTimelinePanel({
  sessionId,
  groupLabel,
  onLocateOperation,
  onClose,
}: {
  sessionId: string | null;
  groupLabel: string;
  onLocateOperation: (taskId: string, operationId: string) => void;
  onClose: () => void;
}) {
  const [group, setGroup] = useState<ScheduleGroup | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [rangeKey, setRangeKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ taskId: string; operationId: string } | null>(null);
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const schedule = await fetchSchedule();
        if (cancelled) return;
        setGroup(schedule.groups.find((item) => item.sessionId === sessionId) ?? null);
        setNow(schedule.now);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  const options = useMemo(() => (group ? rangeOptions(group, now) : []), [group, now]);
  const activeKey = options.some((option) => option.key === rangeKey) ? rangeKey : defaultRangeKey(options);
  const range = options.find((option) => option.key === activeKey) ?? null;
  const layout: ScheduleLayout | null = useMemo(
    () => (group && range ? layoutSchedule(group, range, now) : null),
    [group, range, now],
  );
  const edges = useMemo(() => (layout ? edgesForSelection(layout, selection) : []), [layout, selection]);
  const selectedOp = useMemo(() => {
    if (!group || !selection) return null;
    const op = group.tasks.find((task) => task.taskId === selection.taskId)
      ?.operations.find((item) => item.operationId === selection.operationId);
    return op ?? null;
  }, [group, selection]);

  const rowCount = (layout?.lanes.length ?? 0) + 1;
  const trackHeight = rowCount * ROW_H + (rowCount - 1) * ROW_GAP;

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setHoverFrac(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
  };

  return (
    <section aria-label="调度时间线" className="max-h-[55vh] shrink-0 overflow-y-auto border-b px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-sm">调度时间线</h2>
        <span className="min-w-0 truncate text-muted-foreground text-xs" title={sessionId ?? undefined}>{groupLabel}</span>
        {options.length ? (
          <select
            aria-label="时间范围"
            className="h-7 rounded-md border bg-background px-2 text-xs"
            onChange={(event) => setRangeKey(event.target.value)}
            value={activeKey ?? ""}
          >
            {options.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        ) : null}
        <button aria-label="关闭时间线" className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} type="button">
          <X className="size-4" />
        </button>
      </div>
      {error ? <p className="mt-2 text-destructive text-xs">无法读取调度聚合：{error}</p> : null}
      {group && group.turnsNote ? (
        <p className="mt-2 text-muted-foreground text-xs">Turn 证据不可用：{group.turnsNote}；仅按绝对时间展示子任务。</p>
      ) : null}
      {!group && !error ? <p className="mt-2 text-muted-foreground text-xs">正在加载调度聚合…</p> : null}
      {group && !layout ? <p className="mt-2 text-muted-foreground text-xs">该分组还没有任何带时间证据的操作。</p> : null}

      {layout && range ? (
        <div className="mt-3 flex gap-2">
          {/* Lane labels */}
          <div className="w-40 shrink-0 space-y-1">
            <div className="flex h-8 items-center truncate font-medium text-xs" style={{ height: ROW_H }}>主调度会话</div>
            {layout.lanes.map((lane) => (
              <div className="flex flex-col justify-center truncate" key={lane.task.taskId} style={{ height: ROW_H }}>
                <span className="truncate text-xs">{lane.task.title}</span>
                <span className="truncate text-[10px] text-muted-foreground">{lane.task.providerLabel}</span>
              </div>
            ))}
          </div>
          {/* Track area */}
          <div
            className="relative min-w-0 flex-1"
            onMouseLeave={() => setHoverFrac(null)}
            onMouseMove={handleMove}
            ref={trackRef}
            style={{ height: trackHeight }}
          >
            {/* Main scheduler lane */}
            <div className="absolute inset-x-0 rounded-md bg-muted/30" style={{ top: 0, height: ROW_H }}>
              {layout.turnSegments.map((segment) => (
                <div
                  className={cn(
                    "absolute top-1 bottom-1 rounded-sm border border-primary/40 bg-primary/15",
                    segment.open && "border-dashed",
                  )}
                  key={segment.turn.turnId}
                  style={{ left: `${segment.startFrac * 100}%`, width: `${Math.max((segment.endFrac - segment.startFrac) * 100, 0.4)}%` }}
                  title={`Turn ${segment.turn.turnId} · ${fmt(segment.turn.startedAtMs)} → ${segment.open ? "进行中（结束未观测）" : `${fmt(segment.turn.completedAtMs)}${segment.turn.aborted ? "（中止）" : ""}`}${segment.clippedStart || segment.clippedEnd ? " · 超出当前范围已裁剪" : ""}`}
                >
                  {segment.clippedStart ? <span className="absolute top-0 left-0 text-[9px] text-muted-foreground">…</span> : null}
                  {segment.clippedEnd ? <span className="absolute top-0 right-0 text-[9px] text-muted-foreground">…</span> : null}
                </div>
              ))}
            </div>
            {/* Child lanes */}
            {layout.lanes.map((lane, laneIndex) => (
              <div className="absolute inset-x-0 rounded-md bg-muted/20" key={lane.task.taskId} style={{ top: (laneIndex + 1) * (ROW_H + ROW_GAP), height: ROW_H }}>
                {lane.segments.map((segment) => {
                  const selected = selection?.taskId === segment.taskId && selection.operationId === segment.operationId;
                  return (
                    <button
                      aria-pressed={selected}
                      className={cn(
                        "absolute top-1.5 bottom-1.5 rounded-sm transition-shadow",
                        statusColor(segment.op),
                        segment.openEnd && "opacity-80",
                        selected && "ring-2 ring-primary",
                        segment.op.clockAnomaly && "outline-1 outline-dashed outline-destructive",
                      )}
                      key={segment.operationId}
                      onClick={() => {
                        setSelection(selected ? null : { taskId: segment.taskId, operationId: segment.operationId });
                        if (!selected) onLocateOperation(segment.taskId, segment.operationId);
                      }}
                      style={{ left: `${segment.startFrac * 100}%`, width: `${Math.max((segment.endFrac - segment.startFrac) * 100, 0.6)}%` }}
                      title={`操作 ${segment.operationId} · ${segment.op.status ?? "未知"}${segment.openEnd ? " · 结束时间未记录" : ""}${segment.clippedStart || segment.clippedEnd ? " · 超出当前范围已裁剪" : ""}`}
                      type="button"
                    />
                  );
                })}
                {lane.segments.flatMap((segment) =>
                  segment.markers.filter((marker) => marker.kind !== "dispatch").map((marker) => (
                    <span
                      className={cn("pointer-events-none absolute top-0.5 h-1.5 w-0.5 rounded-full", MARKER_STYLE[marker.kind].className)}
                      key={`${segment.operationId}/${marker.kind}/${marker.atMs}`}
                      style={{ left: `${marker.frac * 100}%` }}
                      title={`${MARKER_STYLE[marker.kind].label}${marker.approx ? "（近似）" : ""}`}
                    />
                  )))}
              </div>
            ))}
            {/* Relation edges for the selection only */}
            {edges.length ? (
              <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
                {edges.map((edge) => (
                  <line
                    key={`${edge.kind}/${edge.laneIndex}`}
                    stroke={edge.kind === "dispatch" ? "currentColor" : "#f59e0b"}
                    strokeDasharray={edge.outOfRange ? "2 3" : "4 3"}
                    strokeWidth={1.5}
                    x1={`${edge.mainFrac * 100}%`}
                    x2={`${edge.laneFrac * 100}%`}
                    y1={rowCenterY(0)}
                    y2={rowCenterY(edge.laneIndex + 1)}
                  />
                ))}
              </svg>
            ) : null}
            {/* Same-moment crosshair */}
            {hoverFrac !== null ? (
              <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `${hoverFrac * 100}%` }}>
                <div className="h-full w-px bg-foreground/40" />
                <span className="absolute -top-1 left-1 whitespace-nowrap rounded bg-background/90 px-1 font-mono text-[10px] text-muted-foreground">
                  {crosshairLabel(range, hoverFrac)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {layout && range ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[10.5rem] font-mono text-[10px] text-muted-foreground">
          <span>{fmt(range.startMs)}</span>
          <span className="ml-auto">{fmt(range.endMs)}</span>
        </div>
      ) : null}
      {layout ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          标记：<span className="text-sky-600 dark:text-sky-400">执行端开始</span> ·
          <span> 执行结束</span> · <span className="text-violet-600 dark:text-violet-400">产物可用</span> ·
          <span className="text-amber-600 dark:text-amber-400"> 调度收到回执</span>；缺失的时间点不显示，虚线段表示尚未观测到结束。点击执行段查看关联与详情。
        </p>
      ) : null}
      {group && selection && selectedOp ? <OperationDetail group={group} op={selectedOp} taskId={selection.taskId} /> : null}
    </section>
  );
}
