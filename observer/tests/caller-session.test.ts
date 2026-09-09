import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import { CallerSessionReader } from "../src/server/caller-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function fixture(options: { indexLines?: unknown[]; metaId?: string; cwd?: string; rollout?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "fixture-caller-session-"));
  roots.push(root);
  const caller: CallerIdentity = { kind: "codex", session_id: "fixture-session", turn_id: null, identity_source: "caller-declared", data_root: root };
  if (options.indexLines) writeFileSync(path.join(root, "session_index.jsonl"), options.indexLines.map(line).join(""));
  if (options.rollout !== false) {
    const dir = path.join(root, "sessions", "2026", "09", "09");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "rollout-2026-09-09-fixture-session.jsonl"),
      line({ type: "session_meta", payload: { id: options.metaId ?? "fixture-session", cwd: options.cwd ?? "/fixture/projects/fixture-project" } }),
    );
  }
  return { caller, reader: new CallerSessionReader() };
}

describe("caller session metadata (thread name + project)", () => {
  it("reads the latest index entry and the caller session's own project basename", () => {
    const { caller, reader } = fixture({
      indexLines: [
        { id: "fixture-session", thread_name: "旧名字", updated_at: "t1" },
        { id: "fixture-other", thread_name: "别的会话", updated_at: "t2" },
        { id: "fixture-session", thread_name: "审查调度实现", updated_at: "t3" },
      ],
    });
    expect(reader.read(caller)).toEqual({ name: "审查调度实现", projectName: "fixture-project" });
  });

  it("falls back honestly when index or rollout metadata is missing", () => {
    const { caller, reader } = fixture({ rollout: false });
    expect(reader.read(caller)).toEqual({ name: null, projectName: null });
    const named = fixture({ indexLines: [{ id: "fixture-session", thread_name: "只有名字" }], rollout: false });
    expect(named.reader.read(named.caller)).toEqual({ name: "只有名字", projectName: null });
  });

  it("never labels the group with another session's project on identity mismatch", () => {
    const { caller, reader } = fixture({ metaId: "someone-else", cwd: "/fixture/projects/foreign" });
    expect(reader.read(caller).projectName).toBeNull();
  });

  it("rejects unverifiable callers instead of guessing", () => {
    const { reader } = fixture({ rollout: false });
    expect(reader.read(undefined)).toEqual({ name: null, projectName: null });
    expect(reader.read({ kind: "unknown", session_id: "s", turn_id: null, identity_source: "unavailable", data_root: "/tmp" })).toEqual({ name: null, projectName: null });
    expect(reader.read({ kind: "codex", session_id: "s", turn_id: null, identity_source: "caller-declared", data_root: "relative/root" })).toEqual({ name: null, projectName: null });
    expect(reader.read({ kind: "codex", session_id: null, turn_id: null, identity_source: "caller-declared", data_root: "/tmp" })).toEqual({ name: null, projectName: null });
  });

  it("skips half-written index lines and tolerates an unreadable index", () => {
    const { caller, reader } = fixture({ rollout: false });
    writeFileSync(path.join(caller.data_root!, "session_index.jsonl"), `${JSON.stringify({ id: "fixture-session", thread_name: "完整行" })}\n{"id":"fixture-session","thread_na`);
    expect(reader.read(caller).name).toBe("完整行");
  });
});
