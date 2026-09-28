import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eventPath } from "../src/state.js";
import { harness } from "./helpers.js";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

function commitLockfile(script: string): string {
  const file = path.join(h.base, "providers.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.workspace_setup = [
    { when: "deps.lock", command: ["bash", "-c", script] },
  ];
  writeFileSync(file, JSON.stringify(config));
  h.initGit();
  writeFileSync(path.join(h.target, ".gitignore"), "deps/\n");
  writeFileSync(path.join(h.target, "deps.lock"), "");
  h.git(["add", "."]);
  h.git(["commit", "-qm", "add lockfile"]);
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

describe("workspace setup", () => {
  it("runs before a new endpoint starts and not on later turns", async () => {
    const head = commitLockfile(
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
  it("a failing command stops the start before the provider launches", async () => {
    const head = commitLockfile("echo broken >&2\nexit 3\n");
    await expect(start("task", head)).rejects.toMatchObject({
      code: "SETUP_FAILED",
      details: { exit_code: 3 },
    });
    expect(h.lord.store.operations("task")[0]!.status).toBe("failed");
    expect(h.calls()).toHaveLength(0);
  });
  it("the same start can be retried after the setup problem is fixed", async () => {
    const head = commitLockfile("test -f deps/ready || exit 4\n");
    await expect(start("task", head)).rejects.toMatchObject({
      code: "SETUP_FAILED",
    });
    const target = h.lord.store.operations("task")[0]!.target;
    mkdirSync(path.join(target, "deps"));
    writeFileSync(path.join(target, "deps/ready"), "");
    expect((await start("task", head)).status).toBe("SUCCEEDED");
    expect(h.calls()).toHaveLength(1);
  });
  it("a command that changes files Git reports stops the start", async () => {
    const head = commitLockfile("echo changed > tracked.txt\n");
    await expect(start("task", head)).rejects.toMatchObject({
      code: "SETUP_FAILED",
    });
    expect(h.calls()).toHaveLength(0);
  });
  it("a repository without a matching file starts unchanged", async () => {
    const head = h.initGit();
    expect((await start("task", head)).status).toBe("SUCCEEDED");
    expect(h.calls()).toHaveLength(1);
  });
  it("a caller-provided target is left alone", async () => {
    const head = commitLockfile("exit 5\n");
    const result = await h.lord.start("task", "codex", h.target, "work", {
      head_sha: head,
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(h.calls()).toHaveLength(1);
  });
});
