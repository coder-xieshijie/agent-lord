import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../src/cli.js";
import { harness } from "./helpers.js";
import type { Data } from "../src/contracts.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
const HEAD = "a".repeat(40);
function repository(overrides: Data = {}): Data {
  return {
    repository: "/repo/main",
    source_branch: "main",
    head_sha: HEAD,
    delivery_branch: "feature/plan-to-implement",
    ...overrides,
  };
}
function moduleNode(id: string, overrides: Data = {}): Data {
  return {
    module_id: id,
    repository: "/repo/main",
    responsibility: `implement the ${id} subsystem`,
    acceptance: [`${id} behaves as specified`],
    depends_on: [],
    owned_paths: [`src/${id}`],
    verification: ["pnpm test"],
    ...overrides,
  };
}
function plan(overrides: Data = {}): Data {
  return {
    version: 1,
    plan_id: "plan-1",
    goal: "deliver the feature across modules",
    repositories: [repository()],
    modules: [moduleNode("alpha"), moduleNode("beta")],
    ...overrides,
  };
}
/** Run one CLI command and return its parsed envelope plus exit code. */
async function cli(argv: string[]): Promise<{ code: number; body: Data }> {
  let out = "";
  const code = await main(argv, (value) => {
    out += value;
  });
  return { code, body: JSON.parse(out) as Data };
}
function planFile(value: Data, name = "plan.json"): string {
  const file = path.join(h.base, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}
function run(body: Data): Data {
  return body.plan_run as Data;
}
function modules(body: Data): Data[] {
  return run(body).modules as Data[];
}
function moduleState(body: Data, id: string): string {
  return modules(body).find((m) => m.module_id === id)!.state as string;
}
describe("implementation plan validation", () => {
  it("accepts a well-formed plan and reports the dependency-free ready set", async () => {
    const { code, body } = await cli([
      "plan-validate",
      "--plan-file",
      planFile(
        plan({
          modules: [
            moduleNode("alpha"),
            moduleNode("beta"),
            moduleNode("gamma", { depends_on: ["alpha"] }),
          ],
        }),
      ),
    ]);
    expect(code).toBe(0);
    expect(body.status).toBe("PLAN_VALID");
    expect((body.plan as Data).initial_ready).toEqual(["alpha", "beta"]);
    expect((body.plan as Data).modules).toBe(3);
  });
  it.each([
    [
      "a dependency cycle",
      plan({
        modules: [
          moduleNode("alpha", { depends_on: ["beta"] }),
          moduleNode("beta", { depends_on: ["alpha"] }),
        ],
      }),
    ],
    [
      "a self dependency",
      plan({ modules: [moduleNode("alpha", { depends_on: ["alpha"] })] }),
    ],
    [
      "an unknown dependency",
      plan({ modules: [moduleNode("alpha", { depends_on: ["missing"] })] }),
    ],
    [
      "overlapping owned paths in one repository",
      plan({
        modules: [
          moduleNode("alpha", { owned_paths: ["src/core"] }),
          moduleNode("beta", { owned_paths: ["src/core/auth"] }),
        ],
      }),
    ],
    [
      "a duplicate module_id",
      plan({ modules: [moduleNode("alpha"), moduleNode("alpha")] }),
    ],
    [
      "a repeated repository",
      plan({ repositories: [repository(), repository()] }),
    ],
    [
      "a floating head",
      plan({ repositories: [repository({ head_sha: "main" })] }),
    ],
    [
      "a module-declared merge request",
      plan({
        modules: [
          moduleNode("alpha", { merge_request: "https://example.invalid/1" }),
        ],
      }),
    ],
    [
      "a module with no acceptance criteria",
      plan({ modules: [moduleNode("alpha", { acceptance: [] })] }),
    ],
    [
      "a module with no owned paths",
      plan({ modules: [moduleNode("alpha", { owned_paths: [] })] }),
    ],
    [
      "a module outside the declared repositories",
      plan({ modules: [moduleNode("alpha", { repository: "/repo/other" })] }),
    ],
    ["no modules at all", plan({ modules: [] })],
  ])("rejects %s", async (_label, value) => {
    const { code, body } = await cli([
      "plan-validate",
      "--plan-file",
      planFile(value as Data),
    ]);
    expect(code).toBe(2);
    expect((body.error as Data).code).toBe("PLAN_INVALID");
  });
  it("allows the same owned path in two different repositories", async () => {
    const { code } = await cli([
      "plan-validate",
      "--plan-file",
      planFile(
        plan({
          repositories: [
            repository(),
            repository({
              repository: "/repo/second",
              delivery_branch: "feature/second",
            }),
          ],
          modules: [
            moduleNode("alpha", { owned_paths: ["src/shared"] }),
            moduleNode("beta", {
              repository: "/repo/second",
              owned_paths: ["src/shared"],
            }),
          ],
        }),
      ),
    ]);
    expect(code).toBe(0);
  });
});
describe("durable plan run", () => {
  it("dispatches every ready module at once without a worker cap", async () => {
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const file = planFile(
      plan({
        modules: [
          ...ids.map((id) => moduleNode(id)),
          moduleNode("final", { depends_on: ids }),
        ],
      }),
    );
    await cli(["plan-create", "--run-id", "run-1", "--plan-file", file]);
    const created = await cli(["plan-status", "--run-id", "run-1"]);
    expect(run(created.body).ready).toEqual(ids);
    expect(run(created.body).ready_count).toBe(6);
    for (const id of ids) {
      const { code } = await cli([
        "plan-dispatch",
        "--run-id",
        "run-1",
        "--module-id",
        id,
        "--task-id",
        `task-${id}`,
        "--provider",
        "mcode-cli",
      ]);
      expect(code).toBe(0);
    }
    const dispatched = await cli(["plan-status", "--run-id", "run-1"]);
    expect(run(dispatched.body).ready).toEqual([]);
    expect(
      modules(dispatched.body).filter((m) => m.state === "dispatched"),
    ).toHaveLength(6);
  });
  it("holds a dependent module until its upstream module is delivered", async () => {
    const file = planFile(
      plan({
        modules: [
          moduleNode("alpha"),
          moduleNode("beta", { depends_on: ["alpha"] }),
        ],
      }),
    );
    await cli(["plan-create", "--run-id", "run-2", "--plan-file", file]);
    const blocked = await cli([
      "plan-dispatch",
      "--run-id",
      "run-2",
      "--module-id",
      "beta",
      "--task-id",
      "task-beta",
    ]);
    expect(blocked.code).toBe(2);
    expect((blocked.body.error as Data).code).toBe("PLAN_BARRIER");
    expect(((blocked.body.error as Data).details as Data).waiting_for).toEqual([
      "alpha",
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-2",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    await cli([
      "plan-deliver",
      "--run-id",
      "run-2",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
      "--commit-sha",
      "b".repeat(40),
    ]);
    const unlocked = await cli(["plan-status", "--run-id", "run-2"]);
    expect(run(unlocked.body).ready).toEqual(["beta"]);
    const allowed = await cli([
      "plan-dispatch",
      "--run-id",
      "run-2",
      "--module-id",
      "beta",
      "--task-id",
      "task-beta",
    ]);
    expect(allowed.code).toBe(0);
  });
  it("requires a commit for delivery and rejects an unknown module", async () => {
    const file = planFile(plan());
    await cli(["plan-create", "--run-id", "run-3", "--plan-file", file]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-3",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    const missing = await cli([
      "plan-deliver",
      "--run-id",
      "run-3",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
    ]);
    expect((missing.body.error as Data).code).toBe("PLAN_BARRIER");
    const unknown = await cli([
      "plan-deliver",
      "--run-id",
      "run-3",
      "--module-id",
      "nope",
      "--state",
      "delivered",
      "--commit-sha",
      "c".repeat(40),
    ]);
    expect((unknown.body.error as Data).code).toBe("MODULE_UNKNOWN");
  });
  it("replays an identical plan and refuses a changed plan under the same run id", async () => {
    const file = planFile(plan());
    const first = await cli([
      "plan-create",
      "--run-id",
      "run-4",
      "--plan-file",
      file,
    ]);
    expect(first.code).toBe(0);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-4",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    const replay = await cli([
      "plan-create",
      "--run-id",
      "run-4",
      "--plan-file",
      file,
    ]);
    expect(replay.code).toBe(0);
    // Recovery must not reset progress already recorded for this run.
    expect(moduleState(replay.body, "alpha")).toBe("dispatched");
    const repeated = await cli([
      "plan-dispatch",
      "--run-id",
      "run-4",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    expect(repeated.code).toBe(0);
    const changed = await cli([
      "plan-create",
      "--run-id",
      "run-4",
      "--plan-file",
      planFile(plan({ goal: "a different goal" }), "plan-2.json"),
    ]);
    expect(changed.code).toBe(2);
    expect((changed.body.error as Data).code).toBe("RUN_EXISTS");
  });
  it("rejects reusing one task id for two modules", async () => {
    await cli([
      "plan-create",
      "--run-id",
      "run-5",
      "--plan-file",
      planFile(plan()),
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-5",
      "--module-id",
      "alpha",
      "--task-id",
      "shared-task",
    ]);
    const reused = await cli([
      "plan-dispatch",
      "--run-id",
      "run-5",
      "--module-id",
      "beta",
      "--task-id",
      "shared-task",
    ]);
    expect(reused.code).toBe(2);
    expect((reused.body.error as Data).code).toBe("PLAN_BARRIER");
  });
  it("resets a failed module for a replacement endpoint", async () => {
    await cli([
      "plan-create",
      "--run-id",
      "run-6",
      "--plan-file",
      planFile(plan()),
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-6",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    await cli([
      "plan-deliver",
      "--run-id",
      "run-6",
      "--module-id",
      "alpha",
      "--state",
      "failed",
      "--note",
      "provider stalled",
    ]);
    const reset = await cli([
      "plan-reset",
      "--run-id",
      "run-6",
      "--module-id",
      "alpha",
      "--reason",
      "replacement endpoint",
    ]);
    expect(moduleState(reset.body, "alpha")).toBe("pending");
    const redispatched = await cli([
      "plan-dispatch",
      "--run-id",
      "run-6",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha-2",
    ]);
    expect(redispatched.code).toBe(0);
    await cli([
      "plan-deliver",
      "--run-id",
      "run-6",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
      "--commit-sha",
      "d".repeat(40),
    ]);
    const delivered = await cli(["plan-status", "--run-id", "run-6"]);
    expect(moduleState(delivered.body, "alpha")).toBe("delivered");
    const events = (run(delivered.body).journal as Data[]).map((e) => e.event);
    expect(events).toContain("module_reset");
  });
  it("refuses to reset a module that already delivered", async () => {
    await cli([
      "plan-create",
      "--run-id",
      "run-7",
      "--plan-file",
      planFile(plan()),
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-7",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    await cli([
      "plan-deliver",
      "--run-id",
      "run-7",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
      "--commit-sha",
      "e".repeat(40),
    ]);
    const reset = await cli([
      "plan-reset",
      "--run-id",
      "run-7",
      "--module-id",
      "alpha",
    ]);
    expect(reset.code).toBe(2);
    expect((reset.body.error as Data).code).toBe("PLAN_BARRIER");
  });
  it("binds every dispatched endpoint to the run for supervision", async () => {
    await cli([
      "plan-create",
      "--run-id",
      "run-8",
      "--plan-file",
      planFile(plan()),
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-8",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-8",
      "--module-id",
      "beta",
      "--task-id",
      "task-beta",
    ]);
    const status = await cli(["run-status", "--run-id", "run-8"]);
    expect(status.code).toBe(0);
    expect((status.body.run as Data).task_ids).toEqual([
      "task-alpha",
      "task-beta",
    ]);
  });
});
describe("final integration barrier", () => {
  async function deliverAll(runId: string, file: string): Promise<void> {
    await cli(["plan-create", "--run-id", runId, "--plan-file", file]);
    for (const id of ["alpha", "beta"]) {
      await cli([
        "plan-dispatch",
        "--run-id",
        runId,
        "--module-id",
        id,
        "--task-id",
        `task-${id}`,
      ]);
      await cli([
        "plan-deliver",
        "--run-id",
        runId,
        "--module-id",
        id,
        "--state",
        "delivered",
        "--commit-sha",
        "f".repeat(40),
      ]);
    }
  }
  it("blocks integration while any module is outstanding", async () => {
    await cli([
      "plan-create",
      "--run-id",
      "run-9",
      "--plan-file",
      planFile(plan()),
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-9",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    await cli([
      "plan-deliver",
      "--run-id",
      "run-9",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
      "--commit-sha",
      "f".repeat(40),
    ]);
    const blocked = await cli([
      "plan-integrate",
      "--run-id",
      "run-9",
      "--task-id",
      "task-integrator",
    ]);
    expect(blocked.code).toBe(2);
    expect((blocked.body.error as Data).code).toBe("PLAN_BARRIER");
    expect(((blocked.body.error as Data).details as Data).blocked).toHaveLength(
      1,
    );
  });
  it("runs one integrator even when a single module produced the work", async () => {
    const file = planFile(
      plan({ modules: [moduleNode("alpha")] }),
      "solo.json",
    );
    await cli(["plan-create", "--run-id", "run-10", "--plan-file", file]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-10",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
    ]);
    await cli([
      "plan-deliver",
      "--run-id",
      "run-10",
      "--module-id",
      "alpha",
      "--state",
      "delivered",
      "--commit-sha",
      "f".repeat(40),
    ]);
    const integrated = await cli([
      "plan-integrate",
      "--run-id",
      "run-10",
      "--task-id",
      "task-integrator",
      "--provider",
      "mcode-cli",
    ]);
    expect(integrated.code).toBe(0);
    const integration = run(integrated.body).integration as Data;
    expect(integration.state).toBe("dispatched");
    expect(integration.task_id).toBe("task-integrator");
  });
  it("keeps exactly one integrator and one merge request per repository", async () => {
    await deliverAll("run-11", planFile(plan()));
    await cli([
      "plan-integrate",
      "--run-id",
      "run-11",
      "--task-id",
      "task-integrator",
    ]);
    const second = await cli([
      "plan-integrate",
      "--run-id",
      "run-11",
      "--task-id",
      "other-integrator",
    ]);
    expect(second.code).toBe(2);
    expect((second.body.error as Data).code).toBe("PLAN_BARRIER");
    const recorded = await cli([
      "plan-merge-request",
      "--run-id",
      "run-11",
      "--repo",
      "/repo/main",
      "--mr-url",
      "https://example.invalid/mr/1",
      "--head-sha",
      "1".repeat(40),
    ]);
    expect(recorded.code).toBe(0);
    const same = await cli([
      "plan-merge-request",
      "--run-id",
      "run-11",
      "--repo",
      "/repo/main",
      "--mr-url",
      "https://example.invalid/mr/1",
      "--head-sha",
      "2".repeat(40),
    ]);
    expect(same.code).toBe(0);
    expect((run(same.body).integration as Data).merge_requests).toHaveLength(1);
    const conflicting = await cli([
      "plan-merge-request",
      "--run-id",
      "run-11",
      "--repo",
      "/repo/main",
      "--mr-url",
      "https://example.invalid/mr/2",
    ]);
    expect(conflicting.code).toBe(2);
    expect((conflicting.body.error as Data).code).toBe("MR_CONFLICT");
  });
  it("refuses a merge request before the integrator exists", async () => {
    await deliverAll("run-12", planFile(plan()));
    const early = await cli([
      "plan-merge-request",
      "--run-id",
      "run-12",
      "--repo",
      "/repo/main",
      "--mr-url",
      "https://example.invalid/mr/1",
    ]);
    expect(early.code).toBe(2);
    expect((early.body.error as Data).code).toBe("PLAN_BARRIER");
  });
  it("closes the run only with a non-empty report and every repository MR", async () => {
    const file = planFile(
      plan({
        repositories: [
          repository(),
          repository({
            repository: "/repo/second",
            delivery_branch: "feature/second",
          }),
        ],
        modules: [
          moduleNode("alpha"),
          moduleNode("beta", { repository: "/repo/second" }),
        ],
      }),
      "multi.json",
    );
    await deliverAll("run-13", file);
    await cli([
      "plan-integrate",
      "--run-id",
      "run-13",
      "--task-id",
      "task-integrator",
    ]);
    const empty = path.join(h.base, "empty-report.md");
    writeFileSync(empty, "   \n");
    const report = path.join(h.base, "report.md");
    writeFileSync(report, "# Run report\n\nMerged both modules.\n");
    await cli([
      "plan-merge-request",
      "--run-id",
      "run-13",
      "--repo",
      "/repo/main",
      "--mr-url",
      "https://example.invalid/mr/1",
    ]);
    const incomplete = await cli([
      "plan-report",
      "--run-id",
      "run-13",
      "--report-file",
      report,
    ]);
    expect(incomplete.code).toBe(2);
    expect(((incomplete.body.error as Data).details as Data).missing).toEqual([
      "/repo/second",
    ]);
    await cli([
      "plan-merge-request",
      "--run-id",
      "run-13",
      "--repo",
      "/repo/second",
      "--mr-url",
      "https://example.invalid/mr/2",
    ]);
    const blank = await cli([
      "plan-report",
      "--run-id",
      "run-13",
      "--report-file",
      empty,
    ]);
    expect(blank.code).toBe(2);
    expect((blank.body.error as Data).code).toBe("PLAN_BARRIER");
    const closed = await cli([
      "plan-report",
      "--run-id",
      "run-13",
      "--report-file",
      report,
    ]);
    expect(closed.code).toBe(0);
    const integration = run(closed.body).integration as Data;
    expect(integration.state).toBe("reported");
    expect(integration.report_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
  it("journals the whole run for the process report", async () => {
    await deliverAll("run-14", planFile(plan()));
    await cli([
      "plan-integrate",
      "--run-id",
      "run-14",
      "--task-id",
      "task-integrator",
      "--provider",
      "codex-cli",
    ]);
    await cli([
      "plan-merge-request",
      "--run-id",
      "run-14",
      "--repo",
      "/repo/main",
      "--mr-url",
      "https://example.invalid/mr/1",
    ]);
    const report = path.join(h.base, "journal-report.md");
    writeFileSync(report, "done\n");
    const closed = await cli([
      "plan-report",
      "--run-id",
      "run-14",
      "--report-file",
      report,
    ]);
    const journal = run(closed.body).journal as Data[];
    expect(journal.map((e) => e.event)).toEqual([
      "plan_frozen",
      "module_dispatched",
      "module_result",
      "module_dispatched",
      "module_result",
      "integration_dispatched",
      "merge_request_recorded",
      "run_reported",
    ]);
    expect(journal.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("records mixed providers per role", async () => {
    await cli([
      "plan-create",
      "--run-id",
      "run-15",
      "--plan-file",
      planFile(plan()),
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-15",
      "--module-id",
      "alpha",
      "--task-id",
      "task-alpha",
      "--provider",
      "mcode-cli",
      "--model",
      "custom_provider:mafia-claude/claude-opus-5#xhigh",
    ]);
    await cli([
      "plan-dispatch",
      "--run-id",
      "run-15",
      "--module-id",
      "beta",
      "--task-id",
      "task-beta",
      "--provider",
      "codex-cli",
      "--model",
      "gpt-6-astra",
    ]);
    const status = await cli(["plan-status", "--run-id", "run-15"]);
    expect(modules(status.body).map((m) => [m.module_id, m.provider])).toEqual([
      ["alpha", "mcode-cli"],
      ["beta", "codex-cli"],
    ]);
  });
});
