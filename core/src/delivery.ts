import { statSync } from "node:fs";
import path from "node:path";
import {
  type Delivery,
  type DeliveryRequirements,
  type Operation,
} from "./contracts.js";
import { usageError } from "./errors.js";
import { resolvePath, within } from "./paths.js";
import { git } from "./workspace.js";
function output(target: string, args: string[]): string | null {
  const result = git(target, args, false);
  return result.status === 0 ? result.stdout.trim() : null;
}
function normalizedFiles(files: string[] = []): string[] {
  return [...new Set(files.map((name) => path.posix.normalize(name)))].sort();
}
export function sameDeliveryRequest(
  op: Operation,
  files?: string[],
  commit = false,
): boolean {
  return (
    JSON.stringify(op.delivery_requirements?.files ?? []) ===
      JSON.stringify(normalizedFiles(files)) &&
    Boolean(op.delivery_requirements?.require_commit) === commit
  );
}
export function deliveryRequirements(
  target: string,
  files?: string[],
  commit = false,
): DeliveryRequirements | null {
  if (!files?.length && !commit) return null;
  const base = resolvePath(target);
  for (const name of files ?? []) {
    if (
      !name ||
      name.includes("\0") ||
      name.includes("\\") ||
      path.isAbsolute(name) ||
      name.split("/").includes("..")
    )
      throw usageError("required files must be relative workspace paths");
    try {
      if (!within(base, resolvePath(path.join(base, name))))
        throw new Error("escape");
    } catch {
      throw usageError("required file escapes the workspace");
    }
  }
  const head = commit
    ? output(target, ["rev-parse", "--verify", "HEAD"])
    : null;
  if (commit && !head)
    throw usageError("--require-commit needs an existing Git HEAD");
  return {
    files: normalizedFiles(files),
    require_commit: commit,
    base_head: head,
  };
}
export function verifyDelivery(op: Operation): Delivery {
  const spec = op.delivery_requirements;
  const result: Delivery = {
    status: "unverified",
    scope: "declared-files-and-commit",
    checks: [],
  };
  if (!spec) return result;
  const base = resolvePath(op.target);
  for (const name of spec.files) {
    let ok = false;
    try {
      const file = resolvePath(path.join(base, name));
      const stat = statSync(file);
      ok = within(base, file) && stat.isFile() && stat.size > 0;
    } catch {
      /* report absent evidence */
    }
    result.checks.push({ kind: "file", path: name, ok });
  }
  if (spec.require_commit) {
    const head = output(base, ["rev-parse", "--verify", "HEAD"]);
    const clean = output(base, ["status", "--porcelain"]) === "";
    const descendant =
      output(base, [
        "merge-base",
        "--is-ancestor",
        spec.base_head!,
        head ?? "HEAD",
      ]) !== null;
    result.commit_sha = head;
    result.checks.push({
      kind: "commit",
      ok: Boolean(head && head !== spec.base_head && clean && descendant),
      clean,
    });
  }
  result.status = result.checks.every((v) => v.ok) ? "verified" : "incomplete";
  return result;
}
