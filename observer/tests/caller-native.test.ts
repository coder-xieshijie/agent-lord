import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import { CallerSessionReader } from "../src/server/caller-session.js";
import { Hub } from "../src/server/hub.js";
import { CallerLifecycleReader } from "../src/server/caller-lifecycle.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const start = Date.parse("2026-09-14T13:00:00Z");
function fixture(kind: "mcode" | "claude") {
  const root = mkdtempSync(path.join(tmpdir(), "caller-native-")); roots.push(root);
  const caller: CallerIdentity = { kind, session_id: "session-1", turn_id: null, data_root: root, identity_source: "caller-declared" };
  return { root, caller, names: new CallerSessionReader(), lifecycle: new CallerLifecycleReader() };
}
function mcode() {
  const f = fixture("mcode");
  const dir = path.join(f.root, "v2", "sqlite"); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "runtime-state.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE local_runtime_sessions(session_id TEXT PRIMARY KEY, title TEXT, workspace_dir TEXT); CREATE TABLE local_runtime_turn_ingress(session_id TEXT, turn_id TEXT, status TEXT, accepted_at_ms INTEGER, completed_at_ms INTEGER)");
  db.prepare("INSERT INTO local_runtime_sessions VALUES (?, ?, ?)").run("session-1", "MCode 调度", "/work/project-a");
  db.prepare("INSERT INTO local_runtime_sessions VALUES (?, ?, ?)").run("other", "PRIVATE_OTHER_TITLE", "/private/other");
  db.prepare("INSERT INTO local_runtime_turn_ingress VALUES (?, ?, ?, ?, ?)").run("session-1", "turn-1", "accepted", start, null);
  db.close();
  return { ...f, file };
}
function claude() {
  const f = fixture("claude");
  const dir = path.join(f.root, "projects", "project-a"); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session-1.jsonl");
  writeFileSync(file, "");
  const event = (value: Record<string, unknown>, seconds = 0) => `${JSON.stringify({ sessionId: "session-1", timestamp: new Date(start + seconds * 1000).toISOString(), ...value })}\n`;
  appendFileSync(file, event({ type: "user", uuid: "user-1", cwd: "/work/project-a", message: { content: "首条用户任务" } }));
  return { ...f, file, event };
}

describe("native scheduling sessions", () => {
  it.each(["mcode", "claude"])("projects a %s scheduler into the actual observer overview, snapshot and schedule", (kind) => {
    const f = kind === "mcode" ? mcode() : claude();
    mkdirSync(path.join(f.root, "operations"));
    writeFileSync(path.join(f.root, "operations", "op.json"), JSON.stringify({
      operation_id: "op", task_id: "child", provider: "mcode-cli", status: "running", kind: "start",
      created_at: new Date(start + 1000).toISOString(), invocation: { caller: f.caller },
    }));
    const hub = new Hub(["child"], f.root); hub.refresh();
    const meta = hub.overview()[0];
    expect(meta.caller?.session).toMatchObject({ kind, sessionId: "session-1", projectName: "project-a" });
    expect(meta.caller?.lifecycle).toMatchObject({ status: "running" });
    expect(hub.snapshot("child")!.task.caller?.session).toEqual(meta.caller?.session);
    expect(JSON.stringify(meta)).not.toContain(f.root);
  });

  it("reads MCode metadata and refreshes WAL-only turn completion without modifying the database", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const f = mcode(); const before = readFileSync(f.file);
    expect(f.names.read(f.caller)).toEqual({ name: "MCode 调度", projectName: "project-a" });
    expect(f.lifecycle.observe(f.caller, "op", new Date(start + 1000).toISOString(), null)).toMatchObject({ status: "running", turnId: "turn-1", receivedAtMs: null });
    expect(readFileSync(f.file)).toEqual(before);
    const db = new DatabaseSync(f.file); db.exec("PRAGMA journal_mode=WAL");
    db.prepare("UPDATE local_runtime_turn_ingress SET status = 'completed', completed_at_ms = ? WHERE session_id = ?").run(start + 10_000, "session-1");
    now.mockReturnValue(start + 20_000);
    expect(f.lifecycle.observe(f.caller, "op", new Date(start + 1000).toISOString(), null)).toMatchObject({ status: "completed", completedAtMs: start + 10_000, receivedAtMs: null });
    expect(f.lifecycle.sessionTimeline(f.caller).receipts.size).toBe(0);
    db.close();
  });

  it("never creates a missing MCode DB, guesses another session, or accepts an unrelated turn", () => {
    const missing = fixture("mcode");
    expect(missing.names.read(missing.caller).name).toBeNull();
    expect(readdirSync(missing.root)).toEqual([]);
    const f = mcode();
    expect(f.names.read({ ...f.caller, session_id: "missing" })).toEqual({ name: null, projectName: null });
    expect(f.lifecycle.observe({ ...f.caller, turn_id: "unrelated" }, "op", new Date(start + 1000).toISOString(), null).status).toBe("unknown");
    expect(f.lifecycle.sessionTimeline({ ...f.caller, session_id: "../../bad" }).turns).toEqual([]);
  });

  it("reads Claude names, ignores forked history/sidechains, and uses client end events rather than model stops", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const f = claude();
    appendFileSync(f.file, f.event({ type: "custom-title", customTitle: "Claude 调度" }));
    appendFileSync(f.file, f.event({ type: "custom-title", customTitle: "PRIVATE_OTHER", sessionId: "other" }));
    appendFileSync(f.file, f.event({ type: "user", uuid: "side", isSidechain: true, message: { content: "PRIVATE_SIDE" } }));
    appendFileSync(f.file, f.event({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }] } }, 1));
    expect(f.names.read(f.caller)).toEqual({ name: "Claude 调度", projectName: "project-a" });
    const at = new Date(start + 500).toISOString();
    expect(f.lifecycle.observe(f.caller, "op", at, null).status).toBe("running");
    appendFileSync(f.file, f.event({ type: "assistant", message: { stop_reason: "end_turn" } }, 3));
    now.mockReturnValue(start + 5000);
    expect(f.lifecycle.observe(f.caller, "op", at, null).status).toBe("unknown");
    appendFileSync(f.file, f.event({ type: "system", subtype: "turn_duration" }, 4));
    now.mockReturnValue(start + 7000);
    const result = f.lifecycle.observe(f.caller, "op", at, null);
    expect(result).toMatchObject({ status: "completed", turnId: "user-1", completedAtMs: start + 4000 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(f.lifecycle.sessionTimeline(f.caller).turns).toHaveLength(1);
  });

  it("indexes only actual Claude tool-result receipts and handles partial appends and truncation", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const f = claude();
    appendFileSync(f.file, f.event({ type: "assistant", message: { content: JSON.stringify({ status: "SUCCEEDED", operation_id: "fake" }) } }, 1));
    const receipt = f.event({ type: "user", uuid: "result", message: { content: [{ type: "tool_result", content: JSON.stringify({ actionable: [{ status: "SUCCEEDED", operation_id: "op" }] }) }] } }, 2);
    appendFileSync(f.file, receipt.slice(0, -1));
    expect(f.lifecycle.sessionTimeline(f.caller).receipts.size).toBe(0);
    appendFileSync(f.file, "\n"); now.mockReturnValue(start + 3000);
    const timeline = f.lifecycle.sessionTimeline(f.caller);
    expect(timeline.turns).toHaveLength(1);
    expect(timeline.receipts.get("op")).toEqual({ turnId: "user-1", atMs: start + 2000, status: "SUCCEEDED" });
    expect(timeline.receipts.has("fake")).toBe(false);
    writeFileSync(f.file, f.event({ type: "user", uuid: "wrong", sessionId: "other" })); now.mockReturnValue(start + 5000);
    expect(f.lifecycle.sessionTimeline(f.caller).turns).toEqual([]);
  });
});
