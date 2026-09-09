import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import { CallerSessionReader } from "../src/server/caller-session.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

type TitleColumn = "name" | "preview" | "title";
function database(caller: CallerIdentity, row: Partial<Record<TitleColumn, string | null>> & { id?: string },
  file = "state_5.sqlite", columns: TitleColumn[] = ["name", "preview", "title"]) {
  const filename = path.join(caller.data_root!, file);
  const db = new DatabaseSync(filename);
  try {
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, ${columns.map((column) => `${column} TEXT`).join(", ")})`);
    db.prepare(`INSERT INTO threads (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`)
      .run(row.id ?? caller.session_id!, ...columns.map((column) => row[column] ?? null));
  } finally { db.close(); }
  return filename;
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

  it("uses the Desktop request preview when the session has no name or index entry", () => {
    const { caller, reader } = fixture();
    const file = database(caller, { name: null, preview: "  规划调度\n时间线  ", title: "旧标题" });
    const before = readFileSync(file);
    expect(reader.read(caller)).toEqual({ name: "规划调度 时间线", projectName: "fixture-project" });
    expect(readFileSync(file)).toEqual(before);
  });

  it.each([
    { name: "当前正式名称", expected: "当前正式名称" },
    { name: null, expected: "索引名称" },
    { name: " \n ", expected: "索引名称" },
  ])("prefers explicit names over previews ($name)", ({ name, expected }) => {
    const { caller, reader } = fixture({ indexLines: [{ id: "fixture-session", thread_name: "索引名称" }] });
    database(caller, { name, preview: "首条请求", title: "旧标题" });
    expect(reader.read(caller).name).toBe(expected);
  });

  it("supports older databases that only have the title column", () => {
    const { caller, reader } = fixture();
    database(caller, { title: "旧版会话标题" }, "state_4.sqlite", ["title"]);
    expect(reader.read(caller).name).toBe("旧版会话标题");
  });

  it.each([
    { id: "fixture-session", expected: "新数据库预览" },
    { id: "fixture-other", expected: null },
  ])("reads only the bound session in the newest database ($id)", ({ id, expected }) => {
    const { caller, reader } = fixture();
    database(caller, { name: "过期名称" }, "state_9.sqlite");
    database(caller, { id, preview: "新数据库预览" }, "state_10.sqlite");
    expect(reader.read(caller).name).toBe(expected);
  });

  it("keeps title lookups and cached results inside each caller's data root", () => {
    const first = fixture();
    const second = fixture();
    database(first.caller, { preview: "项目一的会话" });
    database(second.caller, { preview: "项目二的会话" });
    expect(first.reader.read(first.caller).name).toBe("项目一的会话");
    expect(first.reader.read(second.caller).name).toBe("项目二的会话");
  });

  it("refreshes a preview to a renamed title even when only the SQLite WAL changes", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const { caller, reader } = fixture();
    const file = database(caller, { preview: "首条请求" });
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      expect(reader.read(caller).name).toBe("首条请求");
      writer.prepare("UPDATE threads SET name = ? WHERE id = ?").run("重命名后的会话", caller.session_id!);
      expect(reader.read(caller).name).toBe("首条请求");
      now.mockReturnValue(106_000);
      expect(reader.read(caller).name).toBe("重命名后的会话");
    } finally { writer.close(); }
  });

  it("retries missing metadata without creating a database", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const { caller, reader } = fixture();
    const before = readdirSync(caller.data_root!);
    expect(reader.read(caller).name).toBeNull();
    expect(readdirSync(caller.data_root!)).toEqual(before);
    database(caller, { preview: "稍后写入的预览" });
    now.mockReturnValue(106_000);
    expect(reader.read(caller).name).toBe("稍后写入的预览");
  });

  it("preserves the index fallback when the database is unreadable", () => {
    const { caller, reader } = fixture({ indexLines: [{ id: "fixture-session", thread_name: "索引名称" }] });
    const file = path.join(caller.data_root!, "state_5.sqlite");
    writeFileSync(file, "fixture-corrupt-database");
    expect(reader.read(caller).name).toBe("索引名称");
    expect(readFileSync(file, "utf8")).toBe("fixture-corrupt-database");
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
