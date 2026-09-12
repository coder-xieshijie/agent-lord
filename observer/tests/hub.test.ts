import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    expect(snapshot.task.resume.resumable).toBe(true);
    expect(snapshot.task.resume.note).toContain("原执行会继续");
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
  it("projects the initial caller's Desktop preview into overview and snapshot without an index", () => {
    const root = makeRoot();
    const callerRoot = makeRoot();
    const db = new DatabaseSync(path.join(callerRoot, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, preview TEXT, title TEXT)");
      const insert = db.prepare("INSERT INTO threads (id, preview) VALUES (?, ?)");
      insert.run("fixture-initial-caller", "规划调度时间线");
      insert.run("fixture-current-caller", "后续调用者的请求");
    } finally { db.close(); }
    const taskId = "fixture-desktop-caller";
    for (const [index, session] of ["fixture-initial-caller", "fixture-current-caller"].entries()) {
      writeOperation(root, taskId, `fixture-desktop-op-${index}`, "mcode-cli", {
        created_at: `2026-09-09T1${index}:00:00Z`,
        invocation: { caller: { kind: "codex", session_id: session, turn_id: null, identity_source: "runtime-env", data_root: callerRoot } },
      });
    }
    const hub = new Hub([taskId], root);
    hub.refresh();
    const expected = { sessionId: "fixture-initial-caller", name: "规划调度时间线", projectName: null };
    expect(hub.overview()[0].caller?.session).toEqual(expected);
    expect(hub.snapshot(taskId)!.task.caller?.session).toEqual(expected);
    expect(JSON.stringify(hub.overview())).not.toContain(callerRoot);
    expect(JSON.stringify(hub.overview())).not.toContain("后续调用者的请求");
  });

  it("replays two complete request/response rounds in order and keeps original and current callers separate", () => {
    const root = makeRoot();
    const taskId = "fixture-request-task";
    const write = (id: string, hour: string, caller: string, text: string, user_request: string | null) => {
      const stdout = writeOperation(root, taskId, id, "mcode-cli", {
        status: "succeeded", created_at: `2026-09-09T${hour}:00:00Z`, completed_at: `2026-09-09T${hour}:01:00Z`, message: text,
        expected: { model: "test/fable#xhigh", effort: null },
        observed: { model: "test/fable", variant: "xhigh", model_verification: "provider-metadata", variant_verification: "provider-metadata", effort_verification: "not-supported" },
        invocation: { caller: { kind: "codex", session_id: caller, turn_id: null, identity_source: "caller-declared", data_root: "/private/not-for-web" }, trigger: user_request ? "user_request" : "caller_followup", user_request, reason: user_request ? null : "旧 deny 处理缺失" },
      });
      appendFileSync(stdout, j({ type: "item.completed", item: { id: "reply", type: "agent_message", content: `reply-${id}` } }) + "\n");
    };
    write("fixture-first", "10", "caller-first", "dispatch first", "用户原话\n不能改写");
    write("fixture-second", "11", "caller-second", "dispatch follow-up", null);
    const hub = new Hub([taskId], root);
    hub.refresh();
    const snapshot = hub.snapshot(taskId)!;
    expect(snapshot.items.filter((item) => item.kind === "request" || item.kind === "message").map((item) => "text" in item ? item.text : "")).toEqual(["用户原话\n不能改写", "dispatch first", "reply-fixture-first", "dispatch follow-up", "reply-fixture-second"]);
    expect(snapshot.task.caller?.initial?.session_id).toBe("caller-first");
    expect(snapshot.task.caller?.current?.session_id).toBe("caller-second");
    // Attribution: the scheduling session that originally launched the task
    // (first operation's caller) owns it; a later follow-up from another
    // session never moves it. Unverifiable metadata stays an honest null and
    // no data_root leaks.
    expect(snapshot.task.caller?.session).toEqual({ sessionId: "caller-first", name: null, projectName: null });
    expect(snapshot.task.execution).toMatchObject({ requestedModel: "test/fable#xhigh", actualModel: "test/fable", requestedVariant: "xhigh", actualVariant: "xhigh", actualEffort: null });
    expect(JSON.stringify(snapshot)).not.toContain("/private/not-for-web");
    const ids = snapshot.items.map((item) => item.id);
    hub.refresh();
    expect(hub.snapshot(taskId)!.items.map((item) => item.id)).toEqual(ids);
    const replay = new Hub([taskId], root); replay.refresh();
    expect(replay.snapshot(taskId)!.items.map((item) => item.id)).toEqual(ids);
  });

  it("never infers the original launcher from later operations when the first one recorded no caller", () => {
    const root = makeRoot();
    const taskId = "fixture-late-caller";
    writeOperation(root, taskId, "fixture-late-first", "mcode-cli", { created_at: "2026-09-09T10:00:00Z", message: "legacy start" });
    writeOperation(root, taskId, "fixture-late-second", "mcode-cli", {
      created_at: "2026-09-09T11:00:00Z", message: "follow-up",
      invocation: { caller: { kind: "codex", session_id: "late-caller", turn_id: null, identity_source: "caller-declared" }, trigger: "caller_followup", user_request: null, reason: null },
    });
    const hub = new Hub([taskId], root);
    hub.refresh();
    const meta = hub.snapshot(taskId)!.task;
    expect(meta.caller?.initial).toBeNull();
    expect(meta.caller?.current?.session_id).toBe("late-caller"); // current round's caller still visible
    expect(meta.caller?.session).toBeNull(); // stays in the unattributed group
  });

  it("shows a Claude fallback as the actual model and does not treat argument-only Codex metadata as a runtime report", () => {
    const root = makeRoot();
    writeOperation(root, "fixture-claude-model", "fixture-claude-model-op", "claude-cli", { expected: { model: "claude-fable-5", effort: "xhigh" }, observed: { main_model: "claude-opus-5", main_model_verified: true, models: ["claude-opus-5"], effort: "xhigh", effort_verification: "argument-enforced" } });
    writeOperation(root, "fixture-codex-model", "fixture-codex-model-op", "codex-cli", { expected: { model: "gpt-fixture", effort: "high" }, observed: { models: ["gpt-fixture"], model_verification: "argument-enforced" }, message: "legacy dispatch" });
    const hub = new Hub(["fixture-claude-model", "fixture-codex-model"], root); hub.refresh();
    expect(hub.snapshot("fixture-claude-model")!.task.execution).toMatchObject({ requestedModel: "claude-fable-5", actualModel: "claude-opus-5", modelVerification: "provider-metadata" });
    const old = hub.snapshot("fixture-codex-model")!;
    expect(old.task.execution?.actualModel).toBeNull();
    expect(old.task.caller?.current).toBeNull();
    expect(old.task.caller?.session).toBeNull(); // historical task without any caller record stays reachable, unattributed
    expect(old.items.find((item) => item.kind === "request")).toMatchObject({ text: "legacy dispatch", role: "caller", originalRecorded: false });
  });
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
    expect(meta.status).toBe("本轮执行完成");
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
