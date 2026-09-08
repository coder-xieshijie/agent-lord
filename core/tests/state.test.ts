import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parseJson, stringifyJson } from "../src/json.js";
import { recordLock, writeJson, readJson, ensureLayout } from "../src/state.js";
const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "agent-lord-ts-state-"));
  roots.push(value);
  return ensureLayout(value);
}
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});
describe("durable state", () => {
  it("round trips legacy nanosecond integer tokens without changing their JSON type", () => {
    const input =
      '{"result_reset_at_ns":1788820000000000001,"nested":[1788820000000000002]}';
    const value = parseJson(input) as {
      result_reset_at_ns: bigint;
      nested: bigint[];
    };
    expect(value.result_reset_at_ns).toBe(1788820000000000001n);
    expect(parseJson(stringifyJson(value))).toEqual(value);
    expect(stringifyJson(value)).toContain(":1788820000000000001");
  });
  it("matches Python code-point key ordering and canonical UTF-8", () => {
    expect(stringifyJson({ "😀": "中文\n", "\ue000": 1, a: true })).toBe(
      '{"a":true,"":1,"😀":"中文\\n"}',
    );
  });
  it("creates records exclusively and leaves private, complete JSON after replacement", () => {
    const file = path.join(root(), "test.json");
    writeJson(file, { x: 1 }, true);
    expect(() => writeJson(file, { x: 2 }, true)).toThrowError(
      "state record already exists",
    );
    expect(readJson(file, "missing", "missing")).toEqual({ x: 1 });
    writeJson(file, { x: 1788820000000000001n });
    expect(readFileSync(file, "utf8")).toContain("1788820000000000001");
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("excludes a second writer, permits shared readers, and releases explicitly", () => {
    const directory = root();
    const first = recordLock("task", "fixture-lock", directory);
    try {
      expect(() => recordLock("task", "fixture-lock", directory)).toThrowError(
        "another process",
      );
    } finally {
      first.release();
    }
    const reader = recordLock("task", "fixture-lock", directory, true);
    try {
      if (process.platform !== "win32")
        recordLock("task", "fixture-lock", directory, true).release();
      expect(() => recordLock("task", "fixture-lock", directory)).toThrowError(
        "another process",
      );
    } finally {
      reader.release();
    }
    recordLock("task", "fixture-lock", directory).release();
  });
  it("releases the kernel lease when its owner is killed", async () => {
    const directory = root();
    const source = fileURLToPath(new URL("../src/state.ts", import.meta.url));
    const script = `import {recordLock} from ${JSON.stringify(source)}; recordLock('task','fixture-killed',process.argv[1]); console.log('locked'); setInterval(()=>{},1000);`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, directory],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout!, "data");
      expect(() =>
        recordLock("task", "fixture-killed", directory),
      ).toThrowError("another process");
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      recordLock("task", "fixture-killed", directory).release();
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  }, 10000);
});
