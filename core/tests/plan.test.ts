import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { main } from "../src/cli.js";
import { harness, operation } from "./helpers.js";
import { deliveryRequirements, verifyDelivery } from "../src/delivery.js";
import type { Data, Operation } from "../src/contracts.js";
import { permissionPolicy, resolveRetryPlan } from "../src/config.js";
import { utcNow } from "../src/state.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
function run(repo: string, args: string[]): string {
  const result = spawnSync(
    "git",
    ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
/** A real local repository with one commit, used as a plan repository. */
function repository(name: string): { repo: string; head: string } {
  const repo = path.join(h.base, name);
  mkdirSync(repo, { recursive: true });
  run(repo, ["init", "-q", "-b", "main"]);
  run(repo, ["config", "user.name", "Plan Test"]);
  run(repo, ["config", "user.email", "plan@example.invalid"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repo, "README.md"), "source\n");
  run(repo, ["add", "README.md"]);
  run(repo, ["commit", "-qm", "initial"]);
  return { repo, head: run(repo, ["rev-parse", "HEAD"]) };
}
function commitInto(target: string, file: string, body: string): string {
  writeFileSync(path.join(target, file), body);
  run(target, ["add", file]);
  run(target, ["commit", "-qm", `add ${file}`]);
  return run(target, ["rev-parse", "HEAD"]);
}
/**
 * A durable endpoint whose delivery the runtime itself verified: real git
 * state, real delivery requirements, real verifyDelivery output.
 */
function endpoint(
  taskId: string,
  target: string,
  options: {
    files?: string[];
    requireCommit?: boolean;
    status?: Operation["status"];
    repository?: string;
    branch?: string;
    write?: () => void;
  } = {},
): Operation {
  const requirements = deliveryRequirements(
    target,
    options.files,
    options.requireCommit ?? false,
  );
  options.write?.();
  const op = operation("mcode-cli", {
    task_id: taskId,
    operation_id: `${taskId}-op`,
    target,
    status: options.status ?? "succeeded",
  });
  op.delivery_requirements = requirements;
  if (options.repository)
    op.workspace = {
      policy: "isolated",
      repository: options.repository,
      source_branch: "main",
      workspace_branch: options.branch,
    };
  op.delivery = verifyDelivery(op);
  h.lord.store.createOperation(op);
  const policy = permissionPolicy("mcode-cli", false);
  h.lord.store.createTask({
    version: 2,
    task_id: taskId,
    provider: "mcode-cli",
    endpoint_id: `${taskId}-session`,
    target,
    route: { host_id: null, resolved_at: utcNow(), history: [] },
    contract: {
      model: "test/model#deep",
      effort: null,
      read_only: false,
      permission_mode: policy.mode,
      source: {},
      retry_plan: resolveRetryPlan("mcode-cli", "test/model#deep"),
      ...(op.workspace ? { workspace: op.workspace } : {}),
    },
    created_at: utcNow(),
    updated_at: utcNow(),
    last_operation_id: op.operation_id,
  });
  return op;
}
/** A planner endpoint that really produced the plan file it declares. */
function planner(taskId: string, plan: Data, name = "plan.json"): string {
  const workspace = path.join(h.base, `${taskId}-workspace`);
  mkdirSync(workspace, { recursive: true });
  endpoint(taskId, workspace, {
    files: [name],
    write: () =>
      writeFileSync(path.join(workspace, name), JSON.stringify(plan)),
  });
  return path.join(workspace, name);
}
async function cli(argv: string[]): Promise<{ code: number; body: Data }> {
  let out = "";
  const code = await main(argv, (value) => {
    out += value;
  });
  return { code, body: JSON.parse(out) as Data };
}
function record(body: Data): Data {
  return body.plan_run as Data;
}
function modules(body: Data): Data[] {
  return record(body).modules as Data[];
}
function moduleState(body: Data, id: string): string {
  return modules(body).find((m) => m.module_id === id)!.state as string;
}
function integration(body: Data): Data {
  return record(body).integration as Data;
}
function moduleNode(id: string, repo: string, overrides: Data = {}): Data {
  return {
    module_id: id,
    repository: repo,
    responsibility: `implement the ${id} subsystem`,
    acceptance: [`${id} behaves as specified`],
    depends_on: [],
    owned_paths: [`src/${id}`],
    verification: ["pnpm test"],
    ...overrides,
  };
}
function planDocument(repo: string, head: string, overrides: Data = {}): Data {
  return {
    version: 1,
    plan_id: "demo",
    goal: "deliver the feature across modules",
    repositories: [
      {
        repository: repo,
        source_branch: "main",
        head_sha: head,
        delivery_branch: "feature/delivery",
      },
    ],
    modules: [moduleNode("alpha", repo), moduleNode("beta", repo)],
    ...overrides,
  };
}
/** A module worker with a real isolated worktree and a real delivery commit. */
function worker(
  taskId: string,
  repo: string,
  head: string,
  branch: string,
  options: { status?: Operation["status"]; requireCommit?: boolean } = {},
): string {
  const target = path.join(h.base, `wt-${taskId}`);
  run(repo, ["worktree", "add", "-q", "-b", branch, target, head]);
  endpoint(taskId, target, {
    requireCommit: options.requireCommit ?? true,
    status: options.status,
    repository: repo,
    branch,
    write: () => commitInto(target, `${taskId}.txt`, "module work\n"),
  });
  return target;
}
describe("plan provenance", () => {
  it("accepts a plan only from a verified planner endpoint", async () => {
    const { repo, head } = repository("repo-a");
    const file = planner("t-planner", planDocument(repo, head));
    const created = await cli([
      "plan-create",
      "--run-id",
      "run-1",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-planner",
    ]);
    expect(created.code).toBe(0);
    const planner_ = record(created.body).planner as Data;
    expect(planner_.task_id).toBe("t-planner");
    expect(planner_.operation_id).toBe("t-planner-op");
    expect(planner_.provider).toBe("mcode-cli");
    const bound = await cli(["run-status", "--run-id", "run-1"]);
    expect((bound.body.run as Data).task_ids).toContain("t-planner");
  });
  it("rejects a plan file that no planner endpoint produced", async () => {
    const { repo, head } = repository("repo-a");
    planner("t-planner", planDocument(repo, head));
    const loose = path.join(h.base, "loose-plan.json");
    writeFileSync(loose, JSON.stringify(planDocument(repo, head)));
    const created = await cli([
      "plan-create",
      "--run-id",
      "run-2",
      "--plan-file",
      loose,
      "--planner-task-id",
      "t-planner",
    ]);
    expect(created.code).toBe(2);
    expect((created.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
  });
  it("rejects an unknown or unsuccessful planner task", async () => {
    const { repo, head } = repository("repo-a");
    const missing = await cli([
      "plan-create",
      "--run-id",
      "run-3",
      "--plan-file",
      path.join(h.base, "nothing.json"),
      "--planner-task-id",
      "t-absent",
    ]);
    expect((missing.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
    const workspace = path.join(h.base, "failed-planner");
    mkdirSync(workspace, { recursive: true });
    const file = path.join(workspace, "plan.json");
    endpoint("t-failed", workspace, {
      files: ["plan.json"],
      status: "failed",
      write: () =>
        writeFileSync(file, JSON.stringify(planDocument(repo, head))),
    });
    const failed = await cli([
      "plan-create",
      "--run-id",
      "run-4",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-failed",
    ]);
    expect((failed.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
  });
  it("keeps one planner across repeated recovery and refuses a second", async () => {
    const { repo, head } = repository("repo-a");
    const plan = planDocument(repo, head);
    const file = planner("t-planner", plan);
    await cli([
      "plan-create",
      "--run-id",
      "run-5",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-planner",
    ]);
    const replay = await cli([
      "plan-create",
      "--run-id",
      "run-5",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-planner",
    ]);
    expect(replay.code).toBe(0);
    expect(
      (record(replay.body).journal as Data[]).filter(
        (e) => e.event === "planner_accepted",
      ),
    ).toHaveLength(1);
    const second = planner("t-planner-2", plan, "plan-2.json");
    const conflict = await cli([
      "plan-create",
      "--run-id",
      "run-5",
      "--plan-file",
      second,
      "--planner-task-id",
      "t-planner-2",
    ]);
    expect(conflict.code).toBe(2);
    expect((conflict.body.error as Data).code).toBe("RUN_EXISTS");
  });
  it("validates a plan file without requiring a planner", async () => {
    const { repo, head } = repository("repo-a");
    const file = path.join(h.base, "precheck.json");
    writeFileSync(file, JSON.stringify(planDocument(repo, head)));
    const { code, body } = await cli(["plan-validate", "--plan-file", file]);
    expect(code).toBe(0);
    expect(body.status).toBe("PLAN_VALID");
    expect((body.plan as Data).initial_ready).toEqual(["alpha", "beta"]);
  });
});
describe("plan validation rules", () => {
  it.each([
    ["a dependency cycle", { alpha: ["beta"], beta: ["alpha"] }],
    ["a self dependency", { alpha: ["alpha"] }],
    ["an unknown dependency", { alpha: ["missing"] }],
  ])("rejects %s", async (_label, edges) => {
    const { repo, head } = repository("repo-a");
    const plan = planDocument(repo, head, {
      modules: Object.entries(edges).map(([id, deps]) =>
        moduleNode(id, repo, { depends_on: deps }),
      ),
    });
    const file = path.join(h.base, "bad.json");
    writeFileSync(file, JSON.stringify(plan));
    const { code, body } = await cli(["plan-validate", "--plan-file", file]);
    expect(code).toBe(2);
    expect((body.error as Data).code).toBe("PLAN_INVALID");
  });
  it.each([
    [
      "overlapping owned paths in one repository",
      (repo: string) => ({
        modules: [
          moduleNode("alpha", repo, { owned_paths: ["src/core"] }),
          moduleNode("beta", repo, { owned_paths: ["src/core/auth"] }),
        ],
      }),
    ],
    [
      "a duplicate module_id",
      (repo: string) => ({
        modules: [moduleNode("alpha", repo), moduleNode("alpha", repo)],
      }),
    ],
    [
      "a module-declared merge request",
      (repo: string) => ({
        modules: [
          moduleNode("alpha", repo, {
            merge_request: "https://example.invalid/1",
          }),
        ],
      }),
    ],
    [
      "a module with no acceptance criteria",
      (repo: string) => ({
        modules: [moduleNode("alpha", repo, { acceptance: [] })],
      }),
    ],
    [
      "a module with no owned paths",
      (repo: string) => ({
        modules: [moduleNode("alpha", repo, { owned_paths: [] })],
      }),
    ],
    [
      "a module outside the declared repositories",
      (repo: string) => ({
        modules: [moduleNode("alpha", `${repo}-other`)],
      }),
    ],
    ["no modules at all", () => ({ modules: [] })],
  ])("rejects %s", async (_label, build) => {
    const { repo, head } = repository("repo-a");
    const file = path.join(h.base, "bad.json");
    writeFileSync(
      file,
      JSON.stringify(planDocument(repo, head, build(repo) as Data)),
    );
    const { code, body } = await cli(["plan-validate", "--plan-file", file]);
    expect(code).toBe(2);
    expect((body.error as Data).code).toBe("PLAN_INVALID");
  });
  it("rejects a floating head and a repeated repository", async () => {
    const { repo, head } = repository("repo-a");
    const file = path.join(h.base, "bad.json");
    writeFileSync(
      file,
      JSON.stringify(
        planDocument(repo, head, {
          repositories: [
            {
              repository: repo,
              source_branch: "main",
              head_sha: "main",
              delivery_branch: "feature/delivery",
            },
          ],
        }),
      ),
    );
    expect((await cli(["plan-validate", "--plan-file", file])).code).toBe(2);
    writeFileSync(
      file,
      JSON.stringify(
        planDocument(repo, head, {
          repositories: [
            {
              repository: repo,
              source_branch: "main",
              head_sha: head,
              delivery_branch: "feature/delivery",
            },
            {
              repository: repo,
              source_branch: "main",
              head_sha: head,
              delivery_branch: "feature/other",
            },
          ],
        }),
      ),
    );
    const repeated = await cli(["plan-validate", "--plan-file", file]);
    expect((repeated.body.error as Data).code).toBe("PLAN_INVALID");
  });
});
describe("module delivery is verified, not asserted", () => {
  async function startRun(
    runId: string,
    repo: string,
    head: string,
    overrides: Data = {},
  ): Promise<void> {
    const file = planner(
      `${runId}-planner`,
      planDocument(repo, head, overrides),
      `${runId}.json`,
    );
    const created = await cli([
      "plan-create",
      "--run-id",
      runId,
      "--plan-file",
      file,
      "--planner-task-id",
      `${runId}-planner`,
    ]);
    expect(created.code).toBe(0);
  }
  it("refuses delivery for a module task that does not exist", async () => {
    const { repo, head } = repository("repo-a");
    await startRun("run-6", repo, head);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-6",
      "--module-id",
      "alpha",
      "--task-id",
      "ghost-task",
    ]);
    const delivered = await cli([
      "plan-deliver",
      "--run-id",
      "run-6",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
      "--commit-sha",
      "a".repeat(40),
    ]);
    expect(delivered.code).toBe(2);
    expect((delivered.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
    const status = await cli(["plan-status", "--run-id", "run-6"]);
    expect(moduleState(status.body, "alpha")).toBe("dispatched");
  });
  it("refuses delivery when the endpoint's current operation failed", async () => {
    const { repo, head } = repository("repo-a");
    await startRun("run-7", repo, head);
    worker("t-alpha", repo, head, "module/alpha", { status: "failed" });
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-7",
      "--module-id",
      "alpha",
      "--task-id",
      "t-alpha",
    ]);
    const delivered = await cli([
      "plan-deliver",
      "--run-id",
      "run-7",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
    ]);
    expect((delivered.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
    expect(
      ((delivered.body.error as Data).details as Data).operation_status,
    ).toBe("failed");
  });
  it("refuses delivery for an endpoint dispatched without a commit requirement", async () => {
    const { repo, head } = repository("repo-a");
    await startRun("run-8", repo, head);
    worker("t-alpha", repo, head, "module/alpha", { requireCommit: false });
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-8",
      "--module-id",
      "alpha",
      "--task-id",
      "t-alpha",
    ]);
    const delivered = await cli([
      "plan-deliver",
      "--run-id",
      "run-8",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
    ]);
    expect((delivered.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
  });
  it("refuses a commit that is not the verified delivery commit", async () => {
    const { repo, head } = repository("repo-a");
    await startRun("run-9", repo, head);
    worker("t-alpha", repo, head, "module/alpha");
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-9",
      "--module-id",
      "alpha",
      "--task-id",
      "t-alpha",
    ]);
    const wrong = await cli([
      "plan-deliver",
      "--run-id",
      "run-9",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
      "--commit-sha",
      "b".repeat(40),
    ]);
    expect((wrong.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
    const details = (wrong.body.error as Data).details as Data;
    expect(details.reported_commit).toBe("b".repeat(40));
  });
  it("adopts the verified commit when delivery really happened", async () => {
    const { repo, head } = repository("repo-a");
    await startRun("run-10", repo, head);
    const target = worker("t-alpha", repo, head, "module/alpha");
    const real = run(target, ["rev-parse", "HEAD"]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-10",
      "--module-id",
      "alpha",
      "--task-id",
      "t-alpha",
    ]);
    const delivered = await cli([
      "plan-deliver",
      "--run-id",
      "run-10",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
    ]);
    expect(delivered.code).toBe(0);
    const module = modules(delivered.body).find(
      (m) => m.module_id === "alpha",
    )!;
    expect(module.state).toBe("delivered");
    expect(module.commit_sha).toBe(real);
    expect(module.operation_id).toBe("t-alpha-op");
  });
});
describe("dependency graph and readiness", () => {
  it("returns every ready module at once and holds dependents", async () => {
    const { repo, head } = repository("repo-a");
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    const plan = planDocument(repo, head, {
      modules: [
        ...ids.map((id) => moduleNode(id, repo)),
        moduleNode("final", repo, { depends_on: ids }),
      ],
    });
    const file = planner("t-planner", plan);
    await cli([
      "plan-create",
      "--run-id",
      "run-11",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-planner",
    ]);
    const ready = await cli(["plan-status", "--run-id", "run-11"]);
    expect(record(ready.body).ready).toEqual(ids);
    expect(record(ready.body).ready_count).toBe(5);
    const blocked = await cli([
      "plan-dispatch",
      "--run-id",
      "run-11",
      "--module-id",
      "final",
      "--task-id",
      "t-final",
    ]);
    expect((blocked.body.error as Data).code).toBe("PLAN_BARRIER");
    expect(((blocked.body.error as Data).details as Data).waiting_for).toEqual(
      ids,
    );
    for (const id of ids) {
      worker(`t-${id}`, repo, head, `module/${id}`);
      expect(
        (
          await cli([
            "plan-dispatch",
            "--run-id",
            "run-11",
            "--module-id",
            id,
            "--task-id",
            `t-${id}`,
          ])
        ).code,
      ).toBe(0);
    }
    const dispatched = await cli(["plan-status", "--run-id", "run-11"]);
    expect(
      modules(dispatched.body).filter((m) => m.state === "dispatched"),
    ).toHaveLength(5);
    for (const id of ids)
      await cli([
        "plan-deliver",
        "--run-id",
        "run-11",
        "--module-id",
        id,
        "--state",
        "delivered",
      ]);
    const unlocked = await cli(["plan-status", "--run-id", "run-11"]);
    expect(record(unlocked.body).ready).toEqual(["final"]);
  });
  it("rejects reusing one task id for two modules", async () => {
    const { repo, head } = repository("repo-a");
    const file = planner("t-planner", planDocument(repo, head));
    await cli([
      "plan-create",
      "--run-id",
      "run-12",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-planner",
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-12",
      "--module-id",
      "alpha",
      "--task-id",
      "shared",
    ]);
    const reused = await cli([
      "plan-dispatch",
      "--run-id",
      "run-12",
      "--module-id",
      "beta",
      "--task-id",
      "shared",
    ]);
    expect((reused.body.error as Data).code).toBe("PLAN_BARRIER");
  });
  it("resets a failed module for a replacement endpoint", async () => {
    const { repo, head } = repository("repo-a");
    const file = planner("t-planner", planDocument(repo, head));
    await cli([
      "plan-create",
      "--run-id",
      "run-13",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-planner",
    ]);
    worker("t-alpha", repo, head, "module/alpha", { status: "failed" });
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-13",
      "--module-id",
      "alpha",
      "--task-id",
      "t-alpha",
    ]);
    await cli([
      "plan-deliver",
      "--run-id",
      "run-13",
      "--module-id",
      "alpha",
      "--state",
      "failed",
      "--note",
      "provider stalled",
    ]);
    await cli([
      "plan-reset",
      "--run-id",
      "run-13",
      "--module-id",
      "alpha",
      "--reason",
      "replacement",
    ]);
    worker("t-alpha-2", repo, head, "module/alpha-2");
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-13",
      "--module-id",
      "alpha",
      "--task-id",
      "t-alpha-2",
    ]);
    const delivered = await cli([
      "plan-deliver",
      "--run-id",
      "run-13",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
    ]);
    expect(moduleState(delivered.body, "alpha")).toBe("delivered");
    expect(
      modules(delivered.body).find((m) => m.module_id === "alpha")!.task_id,
    ).toBe("t-alpha-2");
  });
});
describe("single multi-repository integrator", () => {
  async function twoRepositoryRun(runId: string): Promise<{
    a: { repo: string; head: string };
    b: { repo: string; head: string };
  }> {
    const a = repository(`${runId}-a`);
    const b = repository(`${runId}-b`);
    const plan = {
      version: 1,
      plan_id: "demo",
      goal: "ship across two repositories",
      repositories: [
        {
          repository: a.repo,
          source_branch: "main",
          head_sha: a.head,
          delivery_branch: "feature/delivery",
        },
        {
          repository: b.repo,
          source_branch: "main",
          head_sha: b.head,
          delivery_branch: "feature/delivery-sdk",
        },
      ],
      modules: [
        moduleNode("alpha", a.repo),
        moduleNode("beta", b.repo, { owned_paths: ["src/client"] }),
      ],
    };
    const file = planner(`${runId}-planner`, plan, `${runId}.json`);
    await cli([
      "plan-create",
      "--run-id",
      runId,
      "--plan-file",
      file,
      "--planner-task-id",
      `${runId}-planner`,
    ]);
    worker(`${runId}-alpha`, a.repo, a.head, "module/alpha");
    worker(`${runId}-beta`, b.repo, b.head, "module/beta");
    for (const [id, task] of [
      ["alpha", `${runId}-alpha`],
      ["beta", `${runId}-beta`],
    ]) {
      await cli([
        "plan-dispatch",
        "--run-id",
        runId,
        "--module-id",
        id,
        "--task-id",
        task,
      ]);
      await cli([
        "plan-deliver",
        "--run-id",
        runId,
        "--module-id",
        id,
        "--state",
        "delivered",
      ]);
    }
    return { a, b };
  }
  it("blocks integration while any module is outstanding", async () => {
    const { repo, head } = repository("repo-a");
    const file = planner("t-planner", planDocument(repo, head));
    await cli([
      "plan-create",
      "--run-id",
      "run-14",
      "--plan-file",
      file,
      "--planner-task-id",
      "t-planner",
    ]);
    const blocked = await cli([
      "plan-integrate",
      "--run-id",
      "run-14",
      "--task-id",
      "t-int",
    ]);
    expect((blocked.body.error as Data).code).toBe("PLAN_BARRIER");
    expect(((blocked.body.error as Data).details as Data).blocked).toHaveLength(
      2,
    );
  });
  it("claims one delivery worktree per repository for one integrator", async () => {
    const { a, b } = await twoRepositoryRun("run-15");
    const integrated = await cli([
      "plan-integrate",
      "--run-id",
      "run-15",
      "--task-id",
      "t-int",
      "--provider",
      "mcode-cli",
    ]);
    expect(integrated.code).toBe(0);
    const workspaces = integration(integrated.body).workspaces as Data[];
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((w) => w.repository).sort()).toEqual(
      [a.repo, b.repo].sort(),
    );
    // Each claimed worktree really exists, on its delivery branch, at the head.
    for (const workspace of workspaces) {
      const target = workspace.target as string;
      expect(existsSync(target)).toBe(true);
      expect(run(target, ["symbolic-ref", "--short", "HEAD"])).toBe(
        workspace.branch,
      );
    }
    const claims = record(integrated.body).claims as Data[];
    expect(claims).toHaveLength(2);
    expect(claims.every((claim) => claim.task_id === "t-int")).toBe(true);
  });
  it("stops another task from writing a claimed repository branch", async () => {
    const { b } = await twoRepositoryRun("run-16");
    await cli(["plan-integrate", "--run-id", "run-16", "--task-id", "t-int"]);
    const intruder = await cli([
      "start",
      "--task-id",
      "t-intruder",
      "--provider",
      "mcode-cli",
      "--repo",
      b.repo,
      "--source-branch",
      "main",
      "--workspace-policy",
      "isolated",
      "--workspace-branch",
      "feature/delivery-sdk",
      "--head-sha",
      run(b.repo, ["rev-parse", "HEAD"]),
      "--message-file",
      messageFile("write into a claimed repository"),
    ]);
    expect(intruder.code).not.toBe(0);
    expect((intruder.body.error as Data).code).toBe("WORKSPACE_CLAIM_CONFLICT");
    expect(((intruder.body.error as Data).details as Data).owner_task_id).toBe(
      "t-int",
    );
  });
  it("refuses a second integrator and reuses the claims on replay", async () => {
    await twoRepositoryRun("run-17");
    const first = await cli([
      "plan-integrate",
      "--run-id",
      "run-17",
      "--task-id",
      "t-int",
    ]);
    const replay = await cli([
      "plan-integrate",
      "--run-id",
      "run-17",
      "--task-id",
      "t-int",
    ]);
    expect(replay.code).toBe(0);
    expect(record(replay.body).claims).toEqual(record(first.body).claims);
    const second = await cli([
      "plan-integrate",
      "--run-id",
      "run-17",
      "--task-id",
      "t-other",
    ]);
    expect((second.body.error as Data).code).toBe("PLAN_BARRIER");
  });
  it("releases claims for a replacement integrator", async () => {
    const { b } = await twoRepositoryRun("run-18");
    await cli(["plan-integrate", "--run-id", "run-18", "--task-id", "t-int"]);
    const reset = await cli([
      "plan-integration-reset",
      "--run-id",
      "run-18",
      "--reason",
      "integrator replaced",
    ]);
    expect(reset.code).toBe(0);
    expect(record(reset.body).claims).toEqual([]);
    expect(integration(reset.body).state).toBe("pending");
    const replacement = await cli([
      "plan-integrate",
      "--run-id",
      "run-18",
      "--task-id",
      "t-int-2",
    ]);
    expect(replacement.code).toBe(0);
    expect(
      (record(replacement.body).claims as Data[]).every(
        (claim) => claim.task_id === "t-int-2",
      ),
    ).toBe(true);
    expect(b.repo).toBeTruthy();
  });
  it("verifies every merge request head against the real delivery branch", async () => {
    const { a, b } = await twoRepositoryRun("run-19");
    const integrated = await cli([
      "plan-integrate",
      "--run-id",
      "run-19",
      "--task-id",
      "t-int",
    ]);
    const workspaces = integration(integrated.body).workspaces as Data[];
    const primary = workspaces.find((w) => w.repository === a.repo)!;
    const secondary = workspaces.find((w) => w.repository === b.repo)!;
    // The integrator merges in both claimed worktrees, then returns.
    const headB = commitInto(
      secondary.target as string,
      "merged.txt",
      "integrated\n",
    );
    const headA = integratorEndpoint(
      "t-int",
      primary.target as string,
      a.repo,
      "feature/delivery",
    );
    const fake = await cli([
      "plan-merge-request",
      "--run-id",
      "run-19",
      "--repo",
      a.repo,
      "--mr-url",
      "https://example.invalid/mr/1",
      "--head-sha",
      "c".repeat(40),
    ]);
    expect((fake.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
    const good = await cli([
      "plan-merge-request",
      "--run-id",
      "run-19",
      "--repo",
      a.repo,
      "--mr-url",
      "https://example.invalid/mr/1",
      "--head-sha",
      headA,
    ]);
    expect(good.code).toBe(0);
    const second = await cli([
      "plan-merge-request",
      "--run-id",
      "run-19",
      "--repo",
      b.repo,
      "--mr-url",
      "https://example.invalid/mr/2",
      "--head-sha",
      headB,
    ]);
    expect(second.code).toBe(0);
    const conflicting = await cli([
      "plan-merge-request",
      "--run-id",
      "run-19",
      "--repo",
      a.repo,
      "--mr-url",
      "https://example.invalid/mr/99",
      "--head-sha",
      headA,
    ]);
    expect((conflicting.body.error as Data).code).toBe("MR_CONFLICT");
  });
  it("refuses a merge request while the integrator has not succeeded", async () => {
    const { a } = await twoRepositoryRun("run-20");
    await cli(["plan-integrate", "--run-id", "run-20", "--task-id", "t-int"]);
    const early = await cli([
      "plan-merge-request",
      "--run-id",
      "run-20",
      "--repo",
      a.repo,
      "--mr-url",
      "https://example.invalid/mr/1",
      "--head-sha",
      run(a.repo, ["rev-parse", "HEAD"]),
    ]);
    expect((early.body.error as Data).code).toBe("ENDPOINT_UNVERIFIED");
  });
  it("closes the run with a canonical report and releases the claims", async () => {
    const { a, b } = await twoRepositoryRun("run-21");
    const integrated = await cli([
      "plan-integrate",
      "--run-id",
      "run-21",
      "--task-id",
      "t-int",
    ]);
    const workspaces = integration(integrated.body).workspaces as Data[];
    const primary = workspaces.find((w) => w.repository === a.repo)!;
    const secondary = workspaces.find((w) => w.repository === b.repo)!;
    const headB = commitInto(
      secondary.target as string,
      "merged.txt",
      "integrated\n",
    );
    const headA = integratorEndpoint(
      "t-int",
      primary.target as string,
      a.repo,
      "feature/delivery",
    );
    await cli([
      "plan-merge-request",
      "--run-id",
      "run-21",
      "--repo",
      a.repo,
      "--mr-url",
      "https://example.invalid/mr/1",
      "--head-sha",
      headA,
    ]);
    const reportFile = path.join(h.base, "report.md");
    writeFileSync(reportFile, "# Run report\n\nMerged both repositories.\n");
    const missing = await cli([
      "plan-report",
      "--run-id",
      "run-21",
      "--report-file",
      reportFile,
    ]);
    expect(((missing.body.error as Data).details as Data).missing).toEqual([
      b.repo,
    ]);
    await cli([
      "plan-merge-request",
      "--run-id",
      "run-21",
      "--repo",
      b.repo,
      "--mr-url",
      "https://example.invalid/mr/2",
      "--head-sha",
      headB,
    ]);
    const empty = path.join(h.base, "empty.md");
    writeFileSync(empty, "   \n");
    const blank = await cli([
      "plan-report",
      "--run-id",
      "run-21",
      "--report-file",
      empty,
    ]);
    expect((blank.body.error as Data).code).toBe("PLAN_BARRIER");
    const closed = await cli([
      "plan-report",
      "--run-id",
      "run-21",
      "--report-file",
      reportFile,
    ]);
    expect(closed.code).toBe(0);
    const report = integration(closed.body).report as Data;
    expect(report.state).toBeUndefined();
    expect(integration(closed.body).state).toBe("reported");
    // The report survives the caller's temporary file.
    expect(existsSync(report.canonical_path as string)).toBe(true);
    expect(report.available).toBe(true);
    expect(readFileSync(report.canonical_path as string, "utf8")).toBe(
      readFileSync(reportFile, "utf8"),
    );
    expect(report.bytes).toBe(readFileSync(reportFile).length);
    expect(record(closed.body).claims).toEqual([]);
    // An identical report replays; a different one cannot silently replace it.
    const again = await cli([
      "plan-report",
      "--run-id",
      "run-21",
      "--report-file",
      reportFile,
    ]);
    expect(again.code).toBe(0);
    const changed = path.join(h.base, "changed.md");
    writeFileSync(changed, "# Different report\n");
    const conflict = await cli([
      "plan-report",
      "--run-id",
      "run-21",
      "--report-file",
      changed,
    ]);
    expect(conflict.code).toBe(2);
    expect((conflict.body.error as Data).code).toBe("REPORT_CONFLICT");
    const journal = (record(closed.body).journal as Data[]).map((e) => e.event);
    expect(journal[0]).toBe("planner_accepted");
    expect(journal).toContain("integration_dispatched");
    expect(journal.at(-1)).toBe("run_reported");
  });
});
/** The integrator's own endpoint on the primary repository worktree. */
function integratorEndpoint(
  taskId: string,
  target: string,
  repo: string,
  branch: string,
): string {
  const op = endpoint(taskId, target, {
    requireCommit: true,
    repository: repo,
    branch,
    write: () => commitInto(target, "merged.txt", "integrated\n"),
  });
  return op.delivery!.commit_sha!;
}
function messageFile(text: string): string {
  const file = path.join(
    h.base,
    `message-${Math.random().toString(36).slice(2)}.txt`,
  );
  writeFileSync(file, text);
  return file;
}
