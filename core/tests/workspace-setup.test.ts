import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eventPath } from "../src/state.js";
import { SETUP_SCRIPT } from "../src/workspace.js";
import { harness } from "./helpers.js";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

function commitSetup(script: string): string {
  h.initGit();
  mkdirSync(path.join(h.target, ".agent-lord"));
  writeFileSync(path.join(h.target, ".gitignore"), "deps/\n");
  writeFileSync(path.join(h.target, SETUP_SCRIPT), script);
  h.git(["add", "."]);
  h.git(["commit", "-qm", "add setup"]);
  return h.git(["rev-parse", "HEAD"]);
}
const start = (taskId: string, head: string) =>
  h.lord.start(taskId, "codex", null, "work", {
    repository: h.target,
    source_branch: "feat/source",
    head_sha: head,
    workspace_policy: "isolated",
    workspace_branch: `codex/${taskId}`,
  });

describe("repository setup script", () => {
  it("runs before a new endpoint starts and not on later turns", async () => {
    const head = commitSetup(
      "mkdir -p deps\necho run >> deps/runs\necho installed\n",
    );
    expect((await start("task", head)).status).toBe("SUCCEEDED");
    const op = h.lord.store.operations("task")[0]!;
    const log = path.join(h.root, "logs", `${op.operation_id}.setup.log`);
    expect(readFileSync(log, "utf8")).toContain("installed");
    expect(readFileSync(eventPath("task", h.root), "utf8")).toContain(
      '"type":"workspace-setup"',
    );
    await h.lord.turn("task", "next");
    expect(readFileSync(path.join(op.target, "deps/runs"), "utf8")).toBe(
      "run\n",
    );
    expect(h.calls()).toHaveLength(2);
  });
  it("a failing script stops the start before the provider launches", async () => {
    const head = commitSetup("echo broken >&2\nexit 3\n");
    await expect(start("task", head)).rejects.toMatchObject({
      code: "SETUP_FAILED",
      details: { exit_code: 3 },
    });
    expect(h.lord.store.operations("task")[0]!.status).toBe("failed");
    expect(h.calls()).toHaveLength(0);
  });
  it("the same start can be retried after the setup problem is fixed", async () => {
    const head = commitSetup("test -f deps/ready || exit 4\n");
    await expect(start("task", head)).rejects.toMatchObject({
      code: "SETUP_FAILED",
    });
    const target = h.lord.store.operations("task")[0]!.target;
    mkdirSync(path.join(target, "deps"));
    writeFileSync(path.join(target, "deps/ready"), "");
    expect((await start("task", head)).status).toBe("SUCCEEDED");
    expect(h.calls()).toHaveLength(1);
  });
  it("a script that changes files Git reports stops the start", async () => {
    const head = commitSetup("echo changed > tracked.txt\n");
    await expect(start("task", head)).rejects.toMatchObject({
      code: "SETUP_FAILED",
    });
    expect(h.calls()).toHaveLength(0);
  });
  it("a repository without the script starts unchanged", async () => {
    const head = h.initGit();
    expect((await start("task", head)).status).toBe("SUCCEEDED");
    expect(h.calls()).toHaveLength(1);
  });
});
