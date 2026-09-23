import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { harness } from "./helpers.js";
import { TaskSets } from "../src/task-sets.js";
import { workflowNodes } from "../src/workflow-nodes.js";
import { reportChanges } from "../src/reporting.js";
import { main } from "../src/cli.js";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
const node = {
  role: "implementation",
  source: { kind: "user_request", reference: "Try two implementations" },
};

describe("frozen node provenance", () => {
  it("rejects missing additions and role-changing replacements without mutating membership", () => {
    const sets = new TaskSets(h.lord);
    sets.create("run", ["a"], false, workflowNodes({ a: node }));
    expect(() => sets.create("run", ["judge"], true)).toThrow(
      "requires provenance",
    );
    expect(() =>
      sets.create(
        "run",
        ["a"],
        true,
        workflowNodes({ a: { ...node, role: "review" } }),
      ),
    ).toThrow("frozen");
    expect(() =>
      sets.create(
        "run",
        ["b"],
        true,
        workflowNodes({
          b: {
            role: "review",
            source: {
              kind: "replacement",
              task_id: "a",
              reference: "provider failed",
            },
          },
        }),
      ),
    ).toThrow("preserve an existing role");
    expect((sets.status("run").run as any).task_ids).toEqual(["a"]);
    expect(h.calls()).toHaveLength(0);
  });

  it("checks provenance before dispatch, persists it through continuation, and permits a same-role replacement", async () => {
    const sets = new TaskSets(h.lord);
    sets.create("run", ["a"], false, workflowNodes({ a: node }));
    await expect(
      h.lord.start("judge", "mcode", h.target, "review", {
        workflow_run_id: "run",
      }),
    ).rejects.toThrow("before dispatch");
    expect(h.calls()).toHaveLength(0);
    const result = await h.lord.start("a", "mcode", h.target, "implement", {
      workflow_run_id: "run",
    });
    expect(h.lord.store.operation(result.operation_id!).workflow).toMatchObject(
      { run_id: "run", node },
    );
    const next = await h.lord.turn("a", "finish");
    expect(h.lord.store.operation(next.operation_id!).workflow).toEqual(
      h.lord.store.operation(result.operation_id!).workflow,
    );
    sets.create(
      "run",
      ["b"],
      true,
      workflowNodes({
        b: {
          role: "implementation",
          source: {
            kind: "replacement",
            task_id: "a",
            reference: "resume existing work",
          },
        },
      }),
    );
    const replacement = await h.lord.start("b", "mcode", h.target, "continue", {
      workflow_run_id: "run",
    });
    expect(
      (h.lord.store.operation(replacement.operation_id!).workflow as any).node
        .source.task_id,
    ).toBe("a");
  });

  it("parses CLI node files and retains legacy provenance as unavailable", async () => {
    const file = path.join(h.base, "nodes.json");
    writeFileSync(file, JSON.stringify({ a: node }));
    let output = "";
    expect(
      await main(
        [
          "run-create",
          "--run-id",
          "run",
          "--task-id",
          "a",
          "--nodes-file",
          file,
        ],
        (s) => {
          output += s;
        },
      ),
    ).toBe(0);
    expect(JSON.parse(output).run.tasks[0].node).toEqual(node);
    expect(JSON.parse(output).observer.status).toBe("not_attached");
    new TaskSets(h.lord).create("legacy", ["old"]);
    expect(
      (new TaskSets(h.lord).status("legacy").run as any).tasks[0]
        .provenance_status,
    ).toBe("unavailable");
  });

  it("registers all plan-cross-review roles and preserves pipeline provenance across writer turns", async () => {
    const roles = {
      mcode: "mcode-reviewer",
      codex: "codex-reviewer",
      checker: "independent-checker",
      writer: "plan-writer",
    };
    const nodes = workflowNodes(
      Object.fromEntries(
        Object.entries(roles).map(([id, role]) => [
          id,
          {
            role,
            source: { kind: "pipeline", reference: "plan-cross-review" },
          },
        ]),
      ),
    );
    const file = path.join(h.base, "plan-review-nodes.json");
    writeFileSync(file, JSON.stringify(nodes));
    let output = "";
    expect(
      await main(
        [
          "run-create",
          "--run-id",
          "plan-review",
          ...Object.keys(roles).flatMap((id) => ["--task-id", id]),
          "--nodes-file",
          file,
        ],
        (s) => {
          output += s;
        },
      ),
    ).toBe(0);
    const run = JSON.parse(output).run;
    expect(run.task_ids).toEqual(Object.keys(roles).sort());
    expect(run.tasks.map((task: any) => task.node)).toEqual(
      Object.keys(roles)
        .sort()
        .map((id) => nodes[id]),
    );
    expect(h.calls()).toHaveLength(0); // Registration never dispatches a role.
    const draft = await h.lord.start("writer", "mcode", h.target, "rewrite", {
      workflow_run_id: "plan-review",
    });
    const check = await h.lord.turn("writer", "self-check");
    const confirmed = await h.lord.turn("writer", "confirm exact plan");
    for (const result of [draft, check, confirmed]) {
      expect(h.lord.store.operation(result.operation_id!).workflow).toEqual({
        run_id: "plan-review",
        node: nodes.writer,
        provenance_status: "caller-declared",
      });
    }
  });

  it.each(["cross-review", "plan-to-implement"])(
    "retains the existing %s pipeline source",
    (reference) => {
      const declared = {
        role: "existing-role",
        source: { kind: "pipeline", reference },
      };
      expect(workflowNodes({ existing: declared }).existing).toEqual(declared);
    },
  );

  it("rejects new handoff pipeline registrations while existing runs remain readable and resumable", async () => {
    const sets = new TaskSets(h.lord);
    const retired = {
      role: "continuation",
      source: { kind: "pipeline" as const, reference: "handoff" },
    };
    expect(() =>
      sets.create("new-handoff", ["a"], false, { a: retired }),
    ).toThrow("unknown pipeline");
    const nodesFile = path.join(h.base, "retired-nodes.json");
    writeFileSync(nodesFile, JSON.stringify({ a: retired }));
    let output = "";
    expect(
      await main(
        [
          "run-create",
          "--run-id",
          "new-handoff",
          "--task-id",
          "a",
          "--nodes-file",
          nodesFile,
        ],
        (s) => {
          output += s;
        },
      ),
    ).toBe(2);
    expect(JSON.parse(output).status).toBe("ERROR");
    expect(h.calls()).toHaveLength(0);

    // Simulate a persisted pre-retirement run; do not create new retired roles.
    sets.create("old-handoff", ["a"]);
    const file = path.join(h.lord.root, "task-sets", "old-handoff.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.nodes = { a: retired };
    writeFileSync(file, JSON.stringify(record));
    expect((sets.status("old-handoff").run as any).tasks[0].node).toEqual(
      retired,
    );
    const result = await h.lord.start("a", "mcode", h.target, "continue", {
      workflow_run_id: "old-handoff",
    });
    const next = await h.lord.turn("a", "finish");
    for (const operation of [result, next])
      expect(
        h.lord.store.operation(operation.operation_id!).workflow,
      ).toMatchObject({
        run_id: "old-handoff",
        node: retired,
      });
  });

  it("rejects invented pipeline names and cyclic replacement lineage", () => {
    expect(() =>
      workflowNodes({
        a: {
          role: "judge",
          source: { kind: "pipeline", reference: "my-manifest" },
        },
      }),
    ).toThrow("unknown pipeline");
    const cycle = workflowNodes({
      a: {
        role: "worker",
        source: { kind: "replacement", task_id: "b", reference: "retry" },
      },
      b: {
        role: "worker",
        source: { kind: "replacement", task_id: "a", reference: "retry" },
      },
    });
    expect(() =>
      new TaskSets(h.lord).create("cycle", ["a", "b"], false, cycle),
    ).toThrow("cycle");
  });
});

describe("meaningful updates", () => {
  it("ignores tool activity and acknowledgement but emits new operations and changed delivery", () => {
    const task = {
      task_id: "a",
      operation_id: "op1",
      status: "running",
      delivery: "unverified",
    };
    const first = reportChanges([task], {});
    expect(first.reporting.should_notify).toBe(true);
    const quiet = reportChanges(
      [{ ...task, progress_seq: 999, last_tool: "bash", acknowledged: true }],
      first.next,
    );
    expect(quiet.reporting).toMatchObject({
      should_notify: false,
      events: [],
      liveness_is_not_a_milestone: true,
    });
    expect(
      reportChanges([{ ...task, operation_id: "op2" }], quiet.next).reporting
        .should_notify,
    ).toBe(true);
    const done = {
      ...task,
      status: "succeeded",
      delivery: "verified",
      result_key: "result1",
    };
    const delivered = reportChanges([done], quiet.next);
    expect(delivered.reporting.events[0]).toMatchObject({
      kind: "completed",
      delivery_scope: "declared-files-and-commit",
    });
    expect(
      reportChanges([{ ...done, result_key: "result2" }], delivered.next)
        .reporting.should_notify,
    ).toBe(true);
  });

  it("persists notification dedup across restarts without consuming terminal recovery receipts", async () => {
    const sets = new TaskSets(h.lord);
    sets.create("run", ["a"]);
    await h.lord.start("a", "mcode", h.target, "implement");
    const [first] = await sets.checkpoint("run", 0.01);
    expect(first.reporting).toMatchObject({ should_notify: true });
    const [again] = await new TaskSets(h.lord).checkpoint("run", 0.01);
    expect(again.reporting).toMatchObject({ should_notify: false });
    expect(again.actionable![0]!.receipt).toBe(first.actionable![0]!.receipt);
    sets.ack("run", first.actionable![0]!.receipt as string);
    const [quiet] = await sets.checkpoint("run", 1);
    expect(quiet.reporting).toMatchObject({ should_notify: false });
    const record = JSON.parse(
      readFileSync(path.join(h.root, "task-sets/run.json"), "utf8"),
    );
    expect(record.reported.a).toBeTruthy();
  });
});
