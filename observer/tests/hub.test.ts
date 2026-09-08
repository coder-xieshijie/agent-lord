import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../src/server/hub.js";
import { validStdoutPath } from "../src/server/scan.js";
import type { DeltaResponse } from "../src/shared/types.js";

const j = (value: unknown): string => JSON.stringify(value);
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "observer-fixture-"));
  mkdirSync(path.join(root, "operations"), { recursive: true });
  mkdirSync(path.join(root, "logs"), { recursive: true });
  mkdirSync(path.join(root, "events"), { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function writeOperation(
  root: string,
  taskId: string,
  opId: string,
  provider: string,
  extra: Record<string, unknown> = {},
): string {
  const stdout = path.join(root, "logs", `${opId}.stdout`);
  writeFileSync(stdout, "");
  writeFileSync(
    path.join(root, "operations", `${opId}.json`),
    j({
      operation_id: opId,
      task_id: taskId,
      provider,
      kind: "turn",
      status: "running",
      pid: null,
      created_at: extra.created_at ?? "2026-09-08T10:00:00Z",
      stdout_path: stdout,
      ...extra,
    }),
  );
  return stdout;
}

describe("Hub first-turn gap (no task record yet)", () => {
  it("observes a claude operation before the task file exists", () => {
    const root = makeRoot();
    const taskId = "fixture-task-claude";
    const stdout = writeOperation(root, taskId, "fixture-op-1", "claude-cli");
    appendFileSync(
      stdout,
      `${j({ type: "system", subtype: "init", session_id: "sess-first-turn" })}\n${j({
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "text", text: "首轮输出" }] },
      })}\n`,
    );

    const hub = new Hub([taskId], root);
    hub.refresh();
    const snapshot = hub.snapshot(taskId)!;
    expect(snapshot.task.provisional).toBe(true);
    expect(snapshot.task.provider).toBe("claude-cli");
    expect(snapshot.task.resume.sessionId).toBe("sess-first-turn");
    const message = snapshot.items.find((item) => item.kind === "message");
    expect(message).toBeDefined();
    expect((message as { text: string }).text).toBe("首轮输出");
  });

  it("upgrades to the task record once it appears, keeping items stable", () => {
    const root = makeRoot();
    const taskId = "fixture-task-codex";
    const stdout = writeOperation(root, taskId, "fixture-op-2", "codex-cli");
    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hi" } })}\n`);
    const hub = new Hub([taskId], root);
    hub.refresh();
    expect(hub.snapshot(taskId)!.task.provisional).toBe(true);

    writeFileSync(
      path.join(root, `${taskId}.json`),
      j({ task_id: taskId, provider: "codex-cli", endpoint_id: "thread_fixture", contract: { model: "gpt-fixture" } }),
    );
    const before = hub.snapshot(taskId)!.items.map((item) => item.id);
    hub.refresh();
    const snapshot = hub.snapshot(taskId)!;
    expect(snapshot.task.provisional).toBe(false);
    expect(snapshot.task.model).toBe("gpt-fixture");
    expect(snapshot.items.map((item) => item.id)).toEqual(before);
  });
});

describe("Hub ordering and incremental refresh", () => {
  it("separates execution success, delivery evidence and recovery activity", () => {
    const root = makeRoot();
    const taskId = "fixture-task-evidence";
    writeOperation(root, taskId, "fixture-evidence-op", "mcode-cli", {
      status: "succeeded",
      observed: { supervision: { last_event_type: "item.completed", last_tool: "Bash", active_tool_count: 7, active_tools: ["Bash"], input: "private prompt" } },
      continuation: { attempt: 1, limit: 2 },
      delivery: { status: "incomplete", scope: "declared-files-and-commit", checks: [{ kind: "file", path: "LICENSE", ok: false }] },
    });
    const hub = new Hub([taskId], root);
    hub.refresh();
    const meta = hub.snapshot(taskId)!.task;
    expect(meta.status).toBe("执行成功");
    expect(meta.delivery?.status).toBe("incomplete");
    expect(meta.delivery?.checks).toEqual([{ label: "LICENSE", ok: false }]);
    expect(meta.activity?.activeToolCount).toBe(0);
    expect(meta.activity?.activeTools).toEqual([]);
    expect(meta.recovery).toEqual({ attempt: 1, limit: 2, available: false });
    expect(JSON.stringify(meta)).not.toContain("private prompt");
    writeOperation(root, taskId, "fixture-evidence-op", "mcode-cli", { status: "succeeded" });
    hub.refresh();
    expect(hub.snapshot(taskId)!.task.delivery?.status).toBe("unverified");
  });
  it("orders journal pre → stream → journal post within a cycle", () => {
    const root = makeRoot();
    const taskId = "fixture-task-order";
    const stdout = writeOperation(root, taskId, "fixture-op-3", "codex-cli", { status: "succeeded" });
    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "正文" } })}\n`);
    writeFileSync(
      path.join(root, "events", `${taskId}.jsonl`),
      `${j({ type: "operation-created", task_id: taskId, operation_id: "fixture-op-3", timestamp: "t1" })}\n${j({
        type: "operation-succeeded",
        task_id: taskId,
        operation_id: "fixture-op-3",
        timestamp: "t2",
      })}\n`,
    );
    const hub = new Hub([taskId], root);
    hub.refresh();
    const kindsInOrder = hub
      .snapshot(taskId)!
      .items.map((item) => (item.kind === "journal" ? (item as { name: string }).name : item.kind));
    expect(kindsInOrder.indexOf("operation-created")).toBeLessThan(kindsInOrder.indexOf("message"));
    expect(kindsInOrder.indexOf("message")).toBeLessThan(kindsInOrder.indexOf("operation-succeeded"));
  });

  it("picks up a new operation on the same task and half lines wait", () => {
    const root = makeRoot();
    const taskId = "fixture-task-multi-op";
    const stdout1 = writeOperation(root, taskId, "fixture-op-4", "codex-cli", { created_at: "2026-09-08T10:00:00Z" });
    appendFileSync(stdout1, `${j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "第一轮" } })}\n`);
    const hub = new Hub([taskId], root);
    hub.refresh();
    expect(hub.snapshot(taskId)!.items.filter((item) => item.kind === "message")).toHaveLength(1);

    const stdout2 = writeOperation(root, taskId, "fixture-op-5", "codex-cli", { created_at: "2026-09-08T11:00:00Z" });
    appendFileSync(stdout2, j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "第二轮" } })); // no trailing \n yet
    hub.refresh();
    expect(hub.snapshot(taskId)!.items.filter((item) => item.kind === "message")).toHaveLength(1); // half line not consumed

    appendFileSync(stdout2, "\n");
    hub.refresh();
    const messages = hub.snapshot(taskId)!.items.filter((item) => item.kind === "message");
    expect(messages).toHaveLength(2);
    expect((messages[1] as { text: string }).text).toBe("第二轮");
    expect(hub.snapshot(taskId)!.task.operations).toBe(2);
  });

  it("notices an attempt switch and reads the new stream from the start", () => {
    const root = makeRoot();
    const taskId = "fixture-task-retry";
    const stdout1 = writeOperation(root, taskId, "fixture-op-6", "claude-cli");
    appendFileSync(stdout1, `${j({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "尝试一" }] } })}\n`);
    const hub = new Hub([taskId], root);
    hub.refresh();

    const attempt = path.join(root, "logs", "fixture-op-6.attempt-2.stdout");
    writeFileSync(attempt, `${j({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "尝试二" }] } })}\n`);
    writeFileSync(
      path.join(root, "operations", "fixture-op-6.json"),
      j({
        operation_id: "fixture-op-6",
        task_id: taskId,
        provider: "claude-cli",
        status: "running",
        created_at: "2026-09-08T10:00:00Z",
        stdout_path: attempt,
      }),
    );
    hub.refresh();
    const items = hub.snapshot(taskId)!.items;
    expect(items.some((item) => item.kind === "notice" && (item as { text: string }).text.includes("重试"))).toBe(true);
    const texts = items.filter((item) => item.kind === "message").map((item) => (item as { text: string }).text);
    expect(texts).toEqual(["尝试一", "尝试二"]);
  });
});

describe("Hub cursor + listeners", () => {
  it("serves deltas per cursor and rejects foreign-generation cursors", () => {
    const root = makeRoot();
    const taskId = "fixture-task-cursor";
    const stdout = writeOperation(root, taskId, "fixture-op-7", "codex-cli");
    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "a" } })}\n`);
    const hub = new Hub([taskId], root);
    hub.refresh();
    const snapshot = hub.snapshot(taskId)!;

    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "b" } })}\n`);
    hub.refresh();
    const afterSeq = hub.parseCursor(snapshot.cursor)!;
    const delta = hub.delta(taskId, afterSeq)!;
    expect(delta.patches.length).toBeGreaterThan(0);
    expect(hub.parseCursor(`other-generation:${afterSeq}`)).toBeNull();
    expect(hub.parseCursor("garbage")).toBeNull();
  });

  it("broadcasts new patches to every subscribed listener independently", () => {
    const root = makeRoot();
    const taskId = "fixture-task-listeners";
    const stdout = writeOperation(root, taskId, "fixture-op-8", "codex-cli");
    const hub = new Hub([taskId], root);
    hub.refresh();
    const seq = hub.snapshot(taskId)!;
    const got: Record<string, DeltaResponse[]> = { a: [], b: [] };
    hub.subscribe(taskId, {
      seq: hub.parseCursor(seq.cursor)!,
      send: (payload) => {
        if (!("reset" in payload)) got.a.push(payload);
      },
    });
    hub.subscribe(taskId, {
      seq: hub.parseCursor(seq.cursor)!,
      send: (payload) => {
        if (!("reset" in payload)) got.b.push(payload);
      },
    });
    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "推送" } })}\n`);
    hub.refresh();
    for (const key of ["a", "b"] as const) {
      const patches = got[key].flatMap((delta) => delta.patches);
      expect(patches.some((patch) => patch.item.kind === "message")).toBe(true);
    }
  });
});

describe("Read-only access scope", () => {
  it("never accepts stdout paths outside <root>/logs or foreign prefixes", () => {
    const root = makeRoot();
    expect(validStdoutPath(root, "op-1", "/etc/passwd")).toBeNull();
    expect(validStdoutPath(root, "op-1", path.join(root, "logs", "other-op.stdout"))).toBeNull();
    expect(validStdoutPath(root, "op-1", path.join(root, "logs", "sub", "op-1.stdout"))).toBeNull();
    expect(validStdoutPath(root, "op-1", path.join(root, "logs", "op-1.stdout"))).toBe(
      path.join(root, "logs", "op-1.stdout"),
    );
  });

  it("only exposes allow-listed tasks", () => {
    const root = makeRoot();
    writeOperation(root, "fixture-task-private", "fixture-op-9", "codex-cli");
    const hub = new Hub(["fixture-task-allowed"], root);
    hub.refresh();
    expect(hub.snapshot("fixture-task-private")).toBeNull();
    expect(hub.has("fixture-task-private")).toBe(false);
    expect(hub.overview().map((meta) => meta.taskId)).toEqual(["fixture-task-allowed"]);
  });
});
