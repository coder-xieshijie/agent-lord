import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { harness, waitFor } from "./helpers.js";
import { TaskSets } from "../src/task-sets.js";
import { inspectInputs } from "../src/inputs.js";
import { mcodeToolPhase, McodeToolTiming } from "../src/mcode-tools.js";
import { McodeProgress } from "../src/providers/mcode-result.js";
import { main } from "../src/cli.js";
import { RequestInbox } from "../src/requests.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

describe("declared input preflight", () => {
  it("checks deferred request inputs at dispatch after registration", async () => {
    const prompt = path.join(h.base, "prompt");
    writeFileSync(prompt, "use source.md");
    let out = "";
    expect(
      await main(
        [
          "request-add",
          "--request-id",
          "later",
          "--intent",
          "start",
          "--task-id",
          "task",
          "--provider",
          "mcode",
          "--target",
          h.target,
          "--message-file",
          prompt,
          "--require-input",
          "source.md",
        ],
        (s) => (out += s),
      ),
    ).toBe(0);
    expect(JSON.parse(out).request.intent.options.required_inputs).toEqual([
      "source.md",
    ]);
    expect(h.calls()).toHaveLength(0);
    // The source did not exist when registered; only dispatch needs it.
    writeFileSync(path.join(h.target, "source.md"), "ready now");
    const result = await new RequestInbox(h.lord).dispatch("later");
    expect(result.status).toBe("SUCCEEDED");
    expect(result.input_evidence).toEqual([
      expect.objectContaining({ path: "source.md", bytes: 9 }),
    ]);
  });
  it("collects missing/empty/directory issues and does not launch a CLI", async () => {
    writeFileSync(path.join(h.target, "empty.md"), "");
    mkdirSync(path.join(h.target, "dir"));
    await expect(
      h.lord.start("task", "mcode", h.target, "work", {
        required_inputs: ["missing.md", "empty.md", "dir"],
      }),
    ).rejects.toMatchObject({
      code: "INPUT_INCOMPLETE",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "missing.md" }),
          expect.objectContaining({ path: "empty.md" }),
          expect.objectContaining({ path: "dir" }),
        ]),
      },
    });
    expect(h.calls()).toHaveLength(0);
    expect(h.lord.store.operations()).toHaveLength(0);
  });
  it("records input identity, preserves idempotency and checks each explicit turn", async () => {
    writeFileSync(path.join(h.target, "questions.md"), "question one");
    const first = await h.lord.start("task", "mcode", h.target, "work", {
      required_inputs: ["./questions.md"],
    });
    expect(first.input_evidence).toEqual([
      {
        path: "questions.md",
        bytes: 12,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(
      await h.lord.start("task", "mcode", h.target, "work", {
        required_inputs: ["questions.md"],
      }),
    ).toEqual(first);
    await expect(
      h.lord.start("task", "mcode", h.target, "work", { required_inputs: [] }),
    ).rejects.toMatchObject({ code: "TASK_EXISTS" });
    await expect(
      h.lord.turn("task", "followup", { required_inputs: ["absent"] }),
    ).rejects.toMatchObject({ code: "INPUT_INCOMPLETE" });
    expect(h.calls()).toHaveLength(1);
    // Receipts are historical; they do not force the CLI to preserve input contents.
    writeFileSync(path.join(h.target, "questions.md"), "revised question");
    const next = await h.lord.turn("task", "followup", {
      required_inputs: ["questions.md"],
    });
    expect(next.input_evidence).not.toEqual(first.input_evidence);
  });
  it("rejects traversal and symlinks leaving the workspace", () => {
    expect(() => inspectInputs(h.target, ["../private"])).toThrow(
      /relative workspace/,
    );
    const outside = path.join(h.base, "outside");
    writeFileSync(outside, "private");
    symlinkSync(outside, path.join(h.target, "link"));
    expect(() => inspectInputs(h.target, ["link"])).toThrow(
      /inputs are not ready/,
    );
  });
  it("CLI repeated require-input flags are checked before dispatch", async () => {
    const prompt = path.join(h.base, "prompt");
    writeFileSync(prompt, "work");
    let out = "";
    expect(
      await main(
        [
          "start",
          "--task-id",
          "task",
          "--provider",
          "mcode",
          "--target",
          h.target,
          "--message-file",
          prompt,
          "--require-input",
          "a",
          "--require-input",
          "b",
        ],
        (s) => (out += s),
      ),
    ).toBe(2);
    expect(JSON.parse(out).error.details.issues).toHaveLength(2);
    expect(h.calls()).toHaveLength(0);
  });
});

describe("passive task sets", () => {
  it("persists membership without dispatching and tolerates not-yet-started tasks", async () => {
    const sets = new TaskSets(h.lord);
    sets.create("book", ["a"]);
    expect(h.calls()).toHaveLength(0);
    const [result, quiet] = await new TaskSets(h.lord).checkpoint("book", 0.01);
    expect(quiet).toBe(true);
    expect(result.starting).toEqual([
      expect.objectContaining({ task_id: "a", phase: "not_observed" }),
    ]);
    sets.create("book", ["b"], true);
    expect((sets.status("book").run as any).task_ids).toEqual(["a", "b"]);
    expect(() => sets.create("book", ["c"])).toThrow(/different members/);
  });
  it("replays unacknowledged results across restarts, then surfaces new turns and changed delivery", async () => {
    const sets = new TaskSets(h.lord);
    sets.create("book", ["task"]);
    await h.lord.start("task", "mcode", h.target, "work");
    const [first] = await sets.checkpoint("book", 0.01);
    const receipt = first.actionable![0]!.receipt as string;
    const [again] = await new TaskSets(h.lord).checkpoint("book", 0.01);
    expect(again.actionable![0]!.receipt).toBe(receipt);
    expect(() => sets.ack("book", "not-issued")).toThrow(/not issued/);
    sets.ack("book", receipt);
    sets.ack("book", receipt);
    const [quiet, isQuiet] = await sets.checkpoint("book", 30);
    expect(isQuiet).toBe(true);
    expect(quiet.actionable).toBeUndefined();
    expect((quiet.run as any).all_results_acknowledged).toBe(true);
    const id = h.lord.store.task("task").last_operation_id!;
    h.lord.store.updateOperation(id, (op) => ({
      ...op,
      delivery: {
        status: "incomplete",
        scope: "declared-files-and-commit",
        checks: [],
      },
    }));
    const [changed] = await sets.checkpoint("book", 0.01);
    expect(changed.actionable![0]!.receipt).not.toBe(receipt);
    sets.ack("book", changed.actionable![0]!.receipt as string);
    await h.lord.turn("task", "next");
    const [next] = await sets.checkpoint("book", 0.01);
    expect(next.actionable![0]!.operation_id).not.toBe(id);
  });
  it("continues supervising other members after one result is acknowledged", async () => {
    const sets = new TaskSets(h.lord);
    sets.create("book", ["first", "second"]);
    await h.lord.start("first", "mcode", h.target, "one");
    const [first] = await sets.checkpoint("book", 0.01);
    sets.ack("book", first.actionable![0]!.receipt as string);
    h.options({ delayMs: 400 });
    const running = h.lord.start("second", "mcode", h.target, "two");
    await waitFor(() => h.lord.store.operations("second").length > 0);
    const [result] = await sets.checkpoint("book", 3);
    await running;
    expect(result.actionable).toHaveLength(1);
    expect(result.actionable![0]!.task_id).toBe("second");
  });
  it("exposes run commands through the CLI and rejects mixed checkpoint selections", async () => {
    let out = "";
    expect(
      await main(
        ["run-create", "--run-id", "book", "--task-id", "a"],
        (s) => (out += s),
      ),
    ).toBe(0);
    expect(JSON.parse(out).status).toBe("RUN_RECORD");
    out = "";
    expect(
      await main(
        ["checkpoint", "--run-id", "book", "--task-id", "a"],
        (s) => (out += s),
      ),
    ).toBe(2);
    expect(JSON.parse(out).error.message).toContain("cannot be combined");
    expect(
      JSON.parse(readFileSync(path.join(h.root, "task-sets/book.json"), "utf8"))
        .task_ids,
    ).toEqual(["a"]);
    await h.lord.start("a", "mcode", h.target, "work");
    out = "";
    expect(
      await main(
        [
          "checkpoint",
          "--run-id",
          "book",
          "--seconds",
          "1",
          "--include-response",
        ],
        (s) => (out += s),
      ),
    ).toBe(0);
    const result = JSON.parse(out).actionable[0];
    expect(result.response.text).toBeTruthy();
    expect(
      await main(
        ["run-ack", "--run-id", "book", "--receipt", result.receipt],
        () => {},
      ),
    ).toBe(0);
    out = "";
    expect(
      await main(
        ["checkpoint", "--run-id", "book", "--seconds", "120"],
        (s) => (out += s),
      ),
    ).toBe(124);
    expect(JSON.parse(out).run.all_results_acknowledged).toBe(true);
  });
});

describe("MCode tool phases", () => {
  it("preserves preparation states without marking them as failures", () => {
    const progress = new McodeProgress();
    for (const status of [4, 5, 1]) {
      const value = progress.observe({
        type: "item.updated",
        item: {
          type: "tool_call",
          toolCall: { id: "a", name: "write", status },
        },
      });
      expect(value.active_tool_count).toBe(1);
      expect(value.active_tool_phases).toEqual([
        mcodeToolPhase(status, "item.updated"),
      ]);
    }
    expect(
      progress.observe({
        type: "item.completed",
        item: {
          type: "tool_call",
          toolCall: { id: "a", name: "write", status: 2 },
        },
      }).active_tool_count,
    ).toBe(0);
    expect(mcodeToolPhase(99, "item.updated")).toBe("unknown");
    expect(mcodeToolPhase(1, "item.updated", { message: "failed" })).toBe(
      "failed",
    );
  });
  it("does not fabricate execution duration without an execution event", () => {
    const timing = new McodeToolTiming();
    timing.observe("preparing", 1);
    expect(timing.observe("failed", 301000)).toEqual({});
  });
});
