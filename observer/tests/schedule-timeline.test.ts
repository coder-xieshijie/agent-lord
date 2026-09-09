import { describe, expect, it } from "vitest";
import type { ScheduleGroup, ScheduleOperation, ScheduleTask } from "../src/shared/types.js";
import {
  defaultRangeKey,
  edgesForSelection,
  layoutSchedule,
  rangeOptions,
} from "../src/web/lib/schedule-timeline.js";

const BASE = Date.UTC(2026, 8, 9, 4, 0, 0);
const at = (sec: number): number => BASE + sec * 1000;

function op(operationId: string, extra: Partial<ScheduleOperation> = {}): ScheduleOperation {
  return {
    operationId, kind: "turn", status: "succeeded", trigger: "user_request", callerSessionId: "sess-main",
    dispatchTurnId: null, dispatchBinding: "none", createdAtMs: null, executorStartedAtMs: null,
    completedAtMs: null, providerCompletedAtMs: null, artifactExportedAtMs: null, artifactReadyApprox: false,
    hasArtifact: false, receipt: null, deliveryStatus: null, attempt: null, errorCode: null,
    clockAnomaly: false, running: false,
    ...extra,
  };
}

function task(taskId: string, operations: ScheduleOperation[]): ScheduleTask {
  const dispatches = operations.map((operation) => operation.createdAtMs).filter((value): value is number => value !== null);
  return { taskId, title: taskId, providerLabel: "Codex CLI", statusKind: "running", firstDispatchMs: dispatches.length ? Math.min(...dispatches) : null, parallel: null, operations };
}

// Scheduler finishes Turn 1 at t=50 while child op-a keeps running until t=200;
// Turn 2 is still open; op-b is dispatched in Turn 2 and still running.
const opA = op("op-a", {
  dispatchTurnId: "turn-1", dispatchBinding: "recorded",
  createdAtMs: at(10), executorStartedAtMs: at(12), completedAtMs: at(200),
  hasArtifact: true, artifactExportedAtMs: at(199),
  receipt: { turnId: "turn-2", atMs: at(210), status: "SUCCEEDED" },
});
const opB = op("op-b", { dispatchTurnId: "turn-2", dispatchBinding: "inferred-by-create-time", createdAtMs: at(110), status: "running", running: true });
const opNoTime = op("op-ghost", { createdAtMs: null, status: "running", running: true });

const group: ScheduleGroup = {
  sessionId: "sess-main", name: "调度", projectName: null,
  turns: [
    { turnId: "turn-1", startedAtMs: at(0), completedAtMs: at(50), aborted: false },
    { turnId: "turn-2", startedAtMs: at(100), completedAtMs: null, aborted: false },
  ],
  turnsNote: "",
  tasks: [task("task-a", [opA]), task("task-b", [opB, opNoTime])],
};
const NOW = at(300);

describe("rangeOptions / defaultRangeKey", () => {
  it("never truncates children running past the scheduler's turn end", () => {
    const options = rangeOptions(group, NOW);
    const turn1 = options.find((option) => option.key === "turn:turn-1")!;
    // Turn 1 ended at t=50 but its child op-a ran until t=200.
    expect(turn1.startMs).toBe(at(0));
    expect(turn1.endMs).toBeGreaterThanOrEqual(at(200));
    const turn2 = options.find((option) => option.key === "turn:turn-2")!;
    expect(turn2.label).toContain("进行中");
    expect(turn2.endMs).toBe(NOW); // open turn + running child extend to now
    const session = options.find((option) => option.key === "session")!;
    expect(session.startMs).toBe(at(0));
    expect(session.endMs).toBe(NOW);
    // Latest turn is the default; whole session only without turn evidence.
    expect(defaultRangeKey(options)).toBe("turn:turn-2");
    const bare = rangeOptions({ ...group, turns: [] }, NOW);
    expect(defaultRangeKey(bare)).toBe("session");
  });
});

describe("layoutSchedule", () => {
  it("lays out turns and lanes with honest open ends, clipping and in-range markers only", () => {
    const options = rangeOptions(group, NOW);
    const session = options.find((option) => option.key === "session")!;
    const layout = layoutSchedule(group, session, NOW);
    expect(layout.turnSegments).toHaveLength(2);
    expect(layout.turnSegments[1]).toMatchObject({ open: true, clippedEnd: false });
    // Lane order preserved; the no-evidence op gets no segment.
    expect(layout.lanes.map((lane) => lane.task.taskId)).toEqual(["task-a", "task-b"]);
    expect(layout.lanes[1].segments.map((segment) => segment.operationId)).toEqual(["op-b"]);
    const segmentA = layout.lanes[0].segments[0];
    expect(segmentA.openEnd).toBe(false);
    expect(segmentA.markers.map((marker) => marker.kind)).toEqual(["dispatch", "executor-start", "completed", "artifact", "receipt"]);
    expect(segmentA.markers.every((marker) => !marker.approx)).toBe(true);
    // Running op-b is drawn to "now" but flagged as an open end, not a real end.
    const segmentB = layout.lanes[1].segments[0];
    expect(segmentB.openEnd).toBe(true);
    expect(segmentB.endFrac).toBe(1);

    // Turn-1 range: op-a's receipt (t=210) falls outside → marker omitted, not clamped in.
    // op-b (dispatched t=110) overlaps the extended window and stays visible.
    const turn1 = options.find((option) => option.key === "turn:turn-1")!;
    const clipped = layoutSchedule(group, turn1, NOW);
    expect(clipped.lanes.map((lane) => lane.task.taskId)).toEqual(["task-a", "task-b"]);
    expect(clipped.lanes[0].segments[0].markers.map((marker) => marker.kind)).not.toContain("receipt");

    // Turn-2 range starts at t=100: op-a began earlier → clippedStart at frac 0.
    const turn2 = options.find((option) => option.key === "turn:turn-2")!;
    const later = layoutSchedule(group, turn2, NOW);
    const lateA = later.lanes.find((lane) => lane.task.taskId === "task-a")!.segments[0];
    expect(lateA).toMatchObject({ clippedStart: true, startFrac: 0 });
  });

  it("flags approximate artifact times instead of hiding the approximation", () => {
    const approx = op("op-approx", { createdAtMs: at(0), completedAtMs: at(5), hasArtifact: true, artifactExportedAtMs: null, artifactReadyApprox: true });
    const g: ScheduleGroup = { ...group, turns: [], tasks: [task("task-x", [approx])] };
    const range = rangeOptions(g, NOW).find((option) => option.key === "session")!;
    const marker = layoutSchedule(g, range, NOW).lanes[0].segments[0].markers.find((item) => item.kind === "artifact")!;
    expect(marker).toMatchObject({ atMs: at(5), approx: true });
  });
});

describe("edgesForSelection", () => {
  it("draws dispatch and cross-turn receipt edges only for the selection", () => {
    const session = rangeOptions(group, NOW).find((option) => option.key === "session")!;
    const layout = layoutSchedule(group, session, NOW);
    expect(edgesForSelection(layout, null)).toEqual([]);
    const edges = edgesForSelection(layout, { taskId: "task-a", operationId: "op-a" });
    expect(edges.map((edge) => edge.kind)).toEqual(["dispatch", "receipt"]);
    expect(edges[0]).toMatchObject({ laneIndex: 0, outOfRange: false });
    // Receipt edge points at the receiving moment on the main lane (t=210).
    expect(edges[1].mainFrac).toBeCloseTo((at(210) - session.startMs) / (session.endMs - session.startMs), 6);
    // Turn-1 range: the receipt arrived after the range → flagged out-of-range.
    const turn1 = rangeOptions(group, NOW).find((option) => option.key === "turn:turn-1")!;
    const clippedEdges = edgesForSelection(layoutSchedule(group, turn1, NOW), { taskId: "task-a", operationId: "op-a" });
    expect(clippedEdges.find((edge) => edge.kind === "receipt")).toMatchObject({ outOfRange: true });
    expect(edgesForSelection(layout, { taskId: "task-b", operationId: "op-ghost" })).toEqual([]);
  });
});
