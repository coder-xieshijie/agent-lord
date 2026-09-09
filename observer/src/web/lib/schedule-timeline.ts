/** Pure layout logic for the scheduling timeline.
 *
 * Everything here maps evidence-only Schedule data onto fractional [0,1]
 * coordinates for one selected time range. No DOM, no fetch — fully testable.
 *
 * Honesty rules mirrored from the server (docs/scheduling-timeline.md):
 * - a Turn range never truncates children still running past the Turn's end;
 * - segments without completion evidence stay open-ended (drawn to range end);
 * - clock anomalies are flagged, never silently reordered;
 * - relation edges (dispatch / receipt) are computed only for the selection.
 */

import type {
  ScheduleGroup,
  ScheduleOperation,
  ScheduleTask,
  ScheduleTurn,
} from "../../shared/types";

export interface TimelineRange {
  key: string;
  label: string;
  kind: "turn" | "session";
  turnId: string | null;
  startMs: number;
  endMs: number;
}

export interface SegmentMarker {
  kind: "dispatch" | "executor-start" | "completed" | "artifact" | "receipt";
  atMs: number;
  frac: number;
  /** artifact time approximated by completed_at (no artifact-exported event). */
  approx: boolean;
}

export interface LayoutSegment {
  taskId: string;
  operationId: string;
  op: ScheduleOperation;
  startFrac: number;
  endFrac: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** No completion evidence: drawn to the range end, not a real end time. */
  openEnd: boolean;
  markers: SegmentMarker[];
}

export interface LayoutLane {
  task: ScheduleTask;
  segments: LayoutSegment[];
}

export interface MainSegment {
  turn: ScheduleTurn;
  startFrac: number;
  endFrac: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Turn end not yet observed. */
  open: boolean;
}

export interface ScheduleLayout {
  range: TimelineRange;
  turnSegments: MainSegment[];
  lanes: LayoutLane[];
}

export interface Edge {
  kind: "dispatch" | "receipt";
  /** Fraction on the main (scheduler) lane. */
  mainFrac: number;
  /** Fraction on the operation's lane. */
  laneFrac: number;
  laneIndex: number;
  outOfRange: boolean;
}

const HOUR = 3_600_000;

function opEndMs(op: ScheduleOperation, nowMs: number): number {
  if (op.completedAtMs !== null) return Math.max(op.completedAtMs, op.createdAtMs ?? op.completedAtMs);
  if (op.running) return nowMs;
  // Terminal-but-unrecorded end: fall back to the latest recorded evidence.
  return Math.max(
    op.createdAtMs ?? 0,
    op.executorStartedAtMs ?? 0,
    op.artifactExportedAtMs ?? 0,
    op.receipt?.atMs ?? 0,
  );
}

function opsOfTurn(group: ScheduleGroup, turn: ScheduleTurn): ScheduleOperation[] {
  const result: ScheduleOperation[] = [];
  for (const task of group.tasks) {
    for (const op of task.operations) {
      const inWindow = op.createdAtMs !== null
        && op.createdAtMs >= turn.startedAtMs
        && (turn.completedAtMs === null || op.createdAtMs <= turn.completedAtMs);
      if (op.dispatchTurnId === turn.turnId || inWindow) result.push(op);
    }
  }
  return result;
}

/** Range options: one per verified Turn (oldest first) plus the whole session.
 * A Turn range extends past the Turn's end to cover children it dispatched
 * that are still running or finished later. */
export function rangeOptions(group: ScheduleGroup, nowMs: number): TimelineRange[] {
  const options: TimelineRange[] = [];
  group.turns.forEach((turn, index) => {
    let end = turn.completedAtMs ?? nowMs;
    for (const op of opsOfTurn(group, turn)) end = Math.max(end, opEndMs(op, nowMs));
    options.push({
      key: `turn:${turn.turnId}`,
      label: `Turn ${index + 1}${turn.completedAtMs === null ? "（进行中）" : turn.aborted ? "（已中止）" : ""}`,
      kind: "turn",
      turnId: turn.turnId,
      startMs: turn.startedAtMs,
      endMs: Math.max(end, turn.startedAtMs + 1),
    });
  });
  const points: number[] = [];
  for (const turn of group.turns) {
    points.push(turn.startedAtMs);
    if (turn.completedAtMs !== null) points.push(turn.completedAtMs);
  }
  let running = false;
  for (const task of group.tasks) {
    for (const op of task.operations) {
      if (op.createdAtMs !== null) points.push(op.createdAtMs);
      points.push(opEndMs(op, nowMs));
      if (op.receipt) points.push(op.receipt.atMs);
      if (op.running) running = true;
    }
  }
  if (running || group.turns.some((turn) => turn.completedAtMs === null)) points.push(nowMs);
  if (points.length) {
    const start = Math.min(...points);
    options.push({
      key: "session",
      label: "整个会话",
      kind: "session",
      turnId: null,
      startMs: start,
      endMs: Math.max(Math.max(...points), start + 1),
    });
  }
  return options;
}

/** Latest (current) Turn by default; whole session when no Turn evidence. */
export function defaultRangeKey(options: TimelineRange[]): string | null {
  const turns = options.filter((option) => option.kind === "turn");
  return (turns.at(-1) ?? options.at(-1))?.key ?? null;
}

function frac(range: TimelineRange, atMs: number): number {
  return (atMs - range.startMs) / (range.endMs - range.startMs);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function segmentFor(taskId: string, op: ScheduleOperation, range: TimelineRange, nowMs: number): LayoutSegment | null {
  const startMs = op.createdAtMs;
  if (startMs === null) return null; // no dispatch evidence → no position on the axis
  const endMs = Math.max(opEndMs(op, nowMs), startMs);
  if (endMs < range.startMs || startMs > range.endMs) return null;
  const markers: SegmentMarker[] = [];
  const push = (kind: SegmentMarker["kind"], atMs: number | null, approx = false): void => {
    if (atMs === null || atMs < range.startMs || atMs > range.endMs) return;
    markers.push({ kind, atMs, frac: clamp01(frac(range, atMs)), approx });
  };
  push("dispatch", startMs);
  push("executor-start", op.executorStartedAtMs);
  push("completed", op.completedAtMs);
  if (op.hasArtifact) push("artifact", op.artifactExportedAtMs ?? op.completedAtMs, op.artifactReadyApprox);
  push("receipt", op.receipt?.atMs ?? null);
  return {
    taskId,
    operationId: op.operationId,
    op,
    startFrac: clamp01(frac(range, startMs)),
    endFrac: clamp01(frac(range, endMs)),
    clippedStart: startMs < range.startMs,
    clippedEnd: endMs > range.endMs,
    openEnd: op.completedAtMs === null,
    markers,
  };
}

/** Lanes keep the group's stable order (first dispatch, then taskId, computed
 * server-side); a lane appears when at least one segment overlaps the range. */
export function layoutSchedule(group: ScheduleGroup, range: TimelineRange, nowMs: number): ScheduleLayout {
  const turnSegments: MainSegment[] = [];
  for (const turn of group.turns) {
    const endMs = turn.completedAtMs ?? Math.max(nowMs, turn.startedAtMs);
    if (endMs < range.startMs || turn.startedAtMs > range.endMs) continue;
    turnSegments.push({
      turn,
      startFrac: clamp01(frac(range, turn.startedAtMs)),
      endFrac: clamp01(frac(range, endMs)),
      clippedStart: turn.startedAtMs < range.startMs,
      clippedEnd: endMs > range.endMs,
      open: turn.completedAtMs === null,
    });
  }
  const lanes: LayoutLane[] = [];
  for (const task of group.tasks) {
    const segments = task.operations
      .map((op) => segmentFor(task.taskId, op, range, nowMs))
      .filter((segment): segment is LayoutSegment => segment !== null);
    if (segments.length) lanes.push({ task, segments });
  }
  return { range, turnSegments, lanes };
}

/** Relation edges for one selected operation only (anti-clutter):
 * - dispatch: initiating Turn (main lane, at dispatch time) → segment start;
 * - receipt: segment end → receiving Turn (main lane, at receipt time).
 * Cross-turn receipts naturally land on a different main-lane position. */
export function edgesForSelection(
  layout: ScheduleLayout,
  selection: { taskId: string; operationId: string } | null,
): Edge[] {
  if (!selection) return [];
  const laneIndex = layout.lanes.findIndex((lane) => lane.task.taskId === selection.taskId);
  if (laneIndex < 0) return [];
  const segment = layout.lanes[laneIndex].segments.find((item) => item.operationId === selection.operationId);
  if (!segment) return [];
  const edges: Edge[] = [];
  const { op } = segment;
  if (op.dispatchTurnId !== null && op.createdAtMs !== null) {
    edges.push({
      kind: "dispatch",
      mainFrac: clamp01(frac(layout.range, op.createdAtMs)),
      laneFrac: segment.startFrac,
      laneIndex,
      outOfRange: op.createdAtMs < layout.range.startMs || op.createdAtMs > layout.range.endMs,
    });
  }
  if (op.receipt) {
    edges.push({
      kind: "receipt",
      mainFrac: clamp01(frac(layout.range, op.receipt.atMs)),
      laneFrac: segment.clippedEnd ? 1 : segment.endFrac,
      laneIndex,
      outOfRange: op.receipt.atMs < layout.range.startMs || op.receipt.atMs > layout.range.endMs,
    });
  }
  return edges;
}

/** Human timestamp for the crosshair; shows date only when the range is long. */
export function crosshairLabel(range: TimelineRange, fraction: number): string {
  const atMs = range.startMs + clamp01(fraction) * (range.endMs - range.startMs);
  const date = new Date(atMs);
  const time = date.toLocaleTimeString("zh-CN", { hour12: false });
  return range.endMs - range.startMs > 24 * HOUR
    ? `${date.toLocaleDateString("zh-CN")} ${time}`
    : time;
}
