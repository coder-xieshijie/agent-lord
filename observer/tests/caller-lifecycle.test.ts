import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import { CallerLifecycleReader } from "../src/server/caller-lifecycle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const line = (type: string, payload: unknown, timestamp = "2026-09-09T04:20:00Z") => JSON.stringify({ type, payload, timestamp }) + "\n";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "fixture-caller-")); roots.push(root);
  const dir = path.join(root, "sessions", "2026", "09", "09"); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-fixture-session.jsonl");
  const caller: CallerIdentity = { kind: "codex", session_id: "fixture-session", turn_id: null, identity_source: "caller-declared", data_root: root };
  writeFileSync(file, line("session_meta", { id: caller.session_id }) + line("event_msg", { type: "task_started", turn_id: "fixture-turn" }));
  return { file, caller, reader: new CallerLifecycleReader() };
}
const created = "2026-09-09T04:20:44Z";

describe("bound Codex caller lifecycle", () => {
  it("keeps execution and caller completion separate and only exposes matching turn metadata", () => {
    const { file, caller, reader } = fixture();
    const first = reader.observe(caller, "fixture-operation", created, null);
    expect(first.status).toBe("running");
    appendFileSync(file, line("response_item", { type: "reasoning", content: "PRIVATE_REASONING" }));
    const ready = Date.parse("2026-09-09T04:32:42Z");
    const received = "2026-09-09T04:32:43Z";
    appendFileSync(file, line("response_item", { type: "custom_tool_call_output", output: JSON.stringify([{ type: "input_text", text: JSON.stringify({ value: { output: JSON.stringify({ status: "CHECKPOINT_ACTIONABLE", actionable: [{ status: "SUCCEEDED", operation_id: "fixture-operation", response: { text: "PRIVATE_FINAL_TEXT" } }] }) } }) }]) }, received));
    expect(reader.observe(caller, "fixture-operation", created, ready)).toMatchObject({ status: "running", receivedAtMs: Date.parse(received), completedAtMs: null });
    appendFileSync(file, line("event_msg", { type: "task_complete", turn_id: "fixture-turn", last_agent_message: "PRIVATE_REPLY" }, "2026-09-09T04:33:32Z"));
    appendFileSync(file, line("event_msg", { type: "task_started", turn_id: "later-turn" }, "2026-09-09T04:40:00Z"));
    appendFileSync(file, line("event_msg", { type: "task_started", turn_id: "fixture-turn" }));
    const result = reader.observe(caller, "fixture-operation", created, ready);
    expect(result).toMatchObject({ status: "completed", turnId: "fixture-turn", completedAtMs: Date.parse("2026-09-09T04:33:32Z") });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(reader.observe({ ...caller, turn_id: "later-turn" }, "fixture-operation", created, ready).status).toBe("unknown");
  });

  it("never fabricates a finished state from a later turn or an unrelated completion", () => {
    const { file, caller, reader } = fixture();
    appendFileSync(file, line("event_msg", { type: "task_complete", turn_id: "unrelated" }, "2026-09-09T04:30:00Z"));
    expect(reader.observe(caller, "fixture-operation", created, null).status).toBe("running");
    appendFileSync(file, line("event_msg", { type: "task_started", turn_id: "later" }, "2026-09-09T04:40:00Z"));
    expect(reader.observe(caller, "fixture-operation", created, null).status).toBe("unknown");
  });

  it("checks session identity, tolerates partial appends and resets truncated files", () => {
    const { file, caller, reader } = fixture();
    const terminal = line("event_msg", { type: "task_aborted", turn_id: "fixture-turn" }, "2026-09-09T04:30:00Z");
    appendFileSync(file, terminal.slice(0, -1));
    expect(reader.observe(caller, "fixture-operation", created, null).status).toBe("unknown");
    appendFileSync(file, "\n");
    expect(reader.observe(caller, "fixture-operation", created, null).status).toBe("aborted");
    writeFileSync(file, line("session_meta", { id: "wrong-session" }));
    expect(reader.observe(caller, "fixture-operation", created, null).status).toBe("unknown");
    expect(reader.observe(undefined, "fixture-operation", created, null).status).toBe("unknown");
  });
});
