import {
  openSync,
  statSync,
  fstatSync,
  readFileSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { InputEvidence, Operation } from "./contracts.js";
import { AgentLordError, usageError } from "./errors.js";
import { resolvePath, within } from "./paths.js";

export function inputPaths(files: string[] = []): string[] {
  if (
    !Array.isArray(files) ||
    files.some(
      (name) =>
        typeof name !== "string" ||
        !name ||
        name.includes("\0") ||
        name.includes("\\") ||
        path.isAbsolute(name) ||
        name.split("/").includes(".."),
    )
  )
    throw usageError("required inputs must be relative workspace file paths");
  return [...new Set(files.map((name) => path.posix.normalize(name)))].sort();
}
export function sameInputs(op: Operation, files?: string[]): boolean {
  return (
    JSON.stringify(op.input_evidence?.map((v) => v.path) ?? []) ===
    JSON.stringify(inputPaths(files))
  );
}
/** A dispatch-time receipt, not a constraint on the CLI's later edits or reasoning. */
export function inspectInputs(
  target: string,
  files?: string[],
): InputEvidence[] {
  const base = resolvePath(target);
  const evidence: InputEvidence[] = [];
  const issues: { path: string; reason: string }[] = [];
  for (const name of inputPaths(files)) {
    let fd: number | undefined;
    try {
      const file = resolvePath(path.join(base, name));
      if (!within(base, file)) {
        issues.push({ path: name, reason: "outside workspace" });
        continue;
      }
      if (!statSync(file).isFile()) {
        issues.push({ path: name, reason: "not a regular file" });
        continue;
      }
      fd = openSync(file, "r");
      if (!fstatSync(fd).isFile()) {
        issues.push({ path: name, reason: "not a regular file" });
        continue;
      }
      const content = readFileSync(fd);
      if (!content.length) {
        issues.push({ path: name, reason: "empty file" });
        continue;
      }
      evidence.push({
        path: name,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } catch {
      issues.push({ path: name, reason: "missing or unreadable" });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (issues.length)
    throw new AgentLordError(
      "INPUT_INCOMPLETE",
      "Declared task inputs are not ready; no endpoint was launched",
      { details: { issues }, exit_code: 2 },
    );
  return evidence;
}
