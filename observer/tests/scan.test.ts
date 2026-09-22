import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_READ_BYTES,
  listOperations,
  listOperationsByTask,
  readCompleteLines,
} from "../src/server/scan.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "observer-scan-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("readCompleteLines", () => {
  it("consumes complete lines and picks up the tail once terminated", () => {
    const root = makeRoot();
    const file = path.join(root, "plain.log");
    writeFileSync(file, "a\nb\nc");
    const first = readCompleteLines(file, 0);
    expect(first.lines).toEqual(["a", "b"]);
    expect(first.offset).toBe(4);
    expect(first.truncated).toBe(false);
    expect(first.skippedOversized).toBeFalsy();
    appendFileSync(file, "\n");
    const second = readCompleteLines(file, first.offset);
    expect(second.lines).toEqual(["c"]);
    expect(second.offset).toBe(6);
  });

  it("does not advance past a half-written trailing line", () => {
    const root = makeRoot();
    const file = path.join(root, "half.log");
    writeFileSync(file, "partial without newline");
    const tail = readCompleteLines(file, 0);
    expect(tail.lines).toEqual([]);
    expect(tail.offset).toBe(0);
    expect(tail.skippedOversized).toBeFalsy();
  });

  it("skips an oversized terminated line and resumes at the next line", () => {
    const root = makeRoot();
    const file = path.join(root, "oversized.log");
    const oversized = "x".repeat(MAX_READ_BYTES + 1024);
    writeFileSync(file, `${oversized}\nnext-line\n`);
    const first = readCompleteLines(file, 0);
    expect(first.lines).toEqual([]);
    expect(first.skippedOversized).toBe(true);
    expect(first.offset).toBe(oversized.length + 1);
    const second = readCompleteLines(file, first.offset);
    expect(second.lines).toEqual(["next-line"]);
    expect(second.skippedOversized).toBeFalsy();
    expect(second.offset).toBe(oversized.length + 1 + "next-line\n".length);
  });

  it("keeps advancing over an unterminated oversized line instead of stalling", () => {
    const root = makeRoot();
    const file = path.join(root, "unterminated.log");
    const oversized = "y".repeat(MAX_READ_BYTES + 10);
    writeFileSync(file, oversized);
    const tail = readCompleteLines(file, 0);
    expect(tail.lines).toEqual([]);
    expect(tail.skippedOversized).toBe(true);
    expect(tail.offset).toBe(oversized.length); // scanned bytes stay consumed
  });
});

describe("listOperationsByTask", () => {
  it("groups a single directory scan by task_id, sorted by created_at", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "operations"), { recursive: true });
    const write = (opId: string, taskId: string, createdAt: string) =>
      writeFileSync(
        path.join(root, "operations", `${opId}.json`),
        JSON.stringify({
          operation_id: opId,
          task_id: taskId,
          provider: "codex-cli",
          status: "running",
          created_at: createdAt,
        }),
      );
    write("scan-op-a2", "scan-task-a", "2026-09-08T11:00:00Z");
    write("scan-op-a1", "scan-task-a", "2026-09-08T10:00:00Z");
    write("scan-op-b1", "scan-task-b", "2026-09-08T09:00:00Z");
    const groups = listOperationsByTask(root);
    expect([...groups.keys()].sort()).toEqual(["scan-task-a", "scan-task-b"]);
    expect(groups.get("scan-task-a")!.map((op) => op.operationId)).toEqual([
      "scan-op-a1",
      "scan-op-a2",
    ]);
    expect(groups.get("scan-task-b")!.map((op) => op.operationId)).toEqual([
      "scan-op-b1",
    ]);
    // Per-task wrapper stays consistent with the grouped scan.
    expect(listOperations(root, "scan-task-a")).toEqual(
      groups.get("scan-task-a"),
    );
    expect(listOperations(root, "scan-task-none")).toEqual([]);
  });
});
