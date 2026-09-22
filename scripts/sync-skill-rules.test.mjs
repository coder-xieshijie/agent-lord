import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

test("exports a commit snapshot, detects local drift, and explicitly updates the snapshot", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "lord-skill-rules-"));
  try {
    const source = path.join(temp, "source");
    const target = path.join(temp, "target");
    mkdirSync(source);
    mkdirSync(path.join(target, "scripts"), { recursive: true });
    const script = path.join(target, "scripts/sync-skill-rules.mjs");
    copyFileSync(new URL("./sync-skill-rules.mjs", import.meta.url), script);
    const git = (...args) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    git(
      "remote",
      "add",
      "origin",
      "https://github.com/coder-xieshijie/dev-skills.git",
    );
    const names = ["explain-as-fool", "review-rules", "plan-for-agents"];
    for (const name of names) {
      const dir = path.join(source, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: test\n---\n\n保留原始规则。\n`,
      );
    }
    const commit = () => {
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "rules",
      );
      return git("rev-parse", "HEAD");
    };
    const original = commit();
    const changedSource = path.join(source, "skills/review-rules/SKILL.md");
    writeFileSync(
      changedSource,
      readFileSync(changedSource, "utf8").replace("原始", "新版"),
    );
    const run = (...args) =>
      spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(run("--source", source, "--revision", original).status, 0);
    const rules = path.join(target, "references/review-rules.md");
    const published = readFileSync(rules, "utf8");
    assert.ok(published.includes("保留原始规则。"));
    assert.ok(!published.includes("新版")); // Uncommitted edits are not exported.
    assert.ok(!published.includes("description: test")); // No invocation metadata.
    assert.equal(run("--check").status, 0);
    writeFileSync(rules, published + "manual edit\n");
    assert.notEqual(run("--check").status, 0);
    assert.equal(run("--source", source, "--revision", original).status, 0);
    const updated = commit();
    assert.equal(run("--source", source, "--revision", updated).status, 0);
    assert.ok(readFileSync(rules, "utf8").includes("保留新版规则。"));
    const manifest = path.join(target, "references/skill-rules.json");
    const before = readFileSync(manifest, "utf8");
    assert.equal(JSON.parse(before).revision, updated);
    assert.equal(run("--check").status, 0);
    assert.notEqual(
      run("--source", source, "--revision", "missing-revision").status,
      0,
    );
    assert.equal(readFileSync(manifest, "utf8"), before);
    git("remote", "set-url", "origin", "https://example.invalid/other.git");
    assert.notEqual(run("--source", source, "--revision", updated).status, 0);
    assert.equal(readFileSync(manifest, "utf8"), before);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
