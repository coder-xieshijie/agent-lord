import { describe, expect, it } from "vitest";
import type { CallerSessionMeta, TaskMeta } from "../src/shared/types.js";
import {
  groupKeyForTask,
  groupTasksByCaller,
  sortTasksByActivity,
  UNATTRIBUTED_GROUP_KEY,
} from "../src/web/lib/session-views.js";

function task(taskId: string, lastActivityMs: number | null, session: CallerSessionMeta | null | undefined = undefined): TaskMeta {
  return {
    taskId,
    title: taskId,
    available: true,
    provisional: false,
    provider: null,
    providerLabel: "未知",
    model: null,
    effort: null,
    permissionMode: null,
    target: null,
    status: "运行中",
    statusKind: "running",
    running: true,
    pidAlive: null,
    operations: 1,
    lastOperationId: null,
    lastActivityMs,
    createdAt: null,
    updatedAt: null,
    capability: "未知",
    granularity: "未知",
    resume: { sessionId: null, sessionSource: null, workdir: null, dataRootNote: null, command: null, resumable: false, note: "" },
    ...(session === undefined
      ? {}
      : {
          caller: {
            initial: null,
            current: null,
            lifecycle: { status: "unknown", turnId: null, startedAtMs: null, completedAtMs: null, receivedAtMs: null, observedAtMs: null, note: "" },
            session,
          },
        }),
  };
}

const session = (sessionId: string, name: string | null = null, projectName: string | null = null): CallerSessionMeta => ({ sessionId, name, projectName });

describe("sortTasksByActivity", () => {
  it("orders newest first, sinks missing timestamps and stays deterministic on ties", () => {
    const tasks = [task("b-old", 100), task("a-null", null), task("c-new", 300), task("d-tie", 200), task("a-tie", 200), task("b-null", null)];
    expect(sortTasksByActivity(tasks).map((item) => item.taskId)).toEqual(["c-new", "a-tie", "d-tie", "b-old", "a-null", "b-null"]);
    // Input order is never mutated.
    expect(tasks[0].taskId).toBe("b-old");
  });
});

describe("groupTasksByCaller", () => {
  it("groups by scheduling session, orders groups and children newest first and keeps unattributed history reachable", () => {
    const groups = groupTasksByCaller([
      task("old-a", 10, session("sess-a", "调度 A", "project-a")),
      task("legacy", 50, null),
      task("new-a", 400, session("sess-a", "调度 A", "project-a")),
      task("only-b", 300, session("sess-b", "调度 B", "project-b")),
      task("no-caller-field", 5),
      task("mid-a", 200, session("sess-a", "调度 A", "project-a")),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["caller:sess-a", "caller:sess-b", UNATTRIBUTED_GROUP_KEY]);
    expect(groups[0]).toMatchObject({ sessionId: "sess-a", name: "调度 A", projectName: "project-a", lastActivityMs: 400 });
    expect(groups[0].tasks.map((item) => item.taskId)).toEqual(["new-a", "mid-a", "old-a"]);
    expect(groups[2]).toMatchObject({ sessionId: null, name: null, projectName: null });
    expect(groups[2].tasks.map((item) => item.taskId)).toEqual(["legacy", "no-caller-field"]);
  });

  it("prefers the freshest recorded metadata and never invents a name or project", () => {
    const groups = groupTasksByCaller([
      task("older-knows", 100, session("sess-a", "记录的名字", "real-project")),
      task("newer-missing", 200, session("sess-a", null, null)),
      task("all-unknown", 300, session("sess-b", null, null)),
    ]);
    expect(groups[1]).toMatchObject({ key: "caller:sess-a", name: "记录的名字", projectName: "real-project" });
    expect(groups[0]).toMatchObject({ key: "caller:sess-b", name: null, projectName: null });
  });

  it("sorts all-missing-activity groups last but keeps them accessible", () => {
    const groups = groupTasksByCaller([task("no-time", null, session("sess-quiet")), task("active", 100, session("sess-live"))]);
    expect(groups.map((group) => group.key)).toEqual(["caller:sess-live", "caller:sess-quiet"]);
    expect(groups[1].lastActivityMs).toBeNull();
  });
});

describe("groupKeyForTask", () => {
  it("locates the group holding the current selection so view switches keep focus", () => {
    const groups = groupTasksByCaller([task("in-a", 100, session("sess-a")), task("legacy", 50, null)]);
    expect(groupKeyForTask(groups, "in-a")).toBe("caller:sess-a");
    expect(groupKeyForTask(groups, "legacy")).toBe(UNATTRIBUTED_GROUP_KEY);
    expect(groupKeyForTask(groups, "absent")).toBeNull();
    expect(groupKeyForTask(groups, null)).toBeNull();
  });
});
