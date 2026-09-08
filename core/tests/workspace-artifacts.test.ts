import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { object, type Data } from "../src/contracts.js";
import { deliveryRequirements, verifyDelivery } from "../src/delivery.js";
import {
  extractCodexResult,
  extractJsonlWithMetadata,
} from "../src/artifacts.js";
import { operationMarker } from "../src/providers/codex-app.js";
import { harness, operation, waitFor } from "./helpers.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
describe("source checkout and write ownership", () => {
  it("prepares and reuses the requested source worktree", async () => {
    const head = h.initGit();
    const opts = {
      repository: h.target,
      source_branch: "feat/source",
      workspace_policy: "shared-readonly" as const,
      read_only: true,
      head_sha: head,
    };
    const first = await h.lord.start("review-a", "codex", null, "review", opts);
    const second = await h.lord.start(
      "review-b",
      "codex",
      null,
      "review",
      opts,
    );
    expect(first.target).toBe(second.target);
    expect(first.target).not.toBe(h.target);
    expect(h.lord.store.task("review-a").contract.source.head_sha).toBe(head);
  });
  it("fixed head mismatch is rejected before provider launch", async () => {
    h.initGit();
    await expect(
      h.lord.start("task", "codex", h.target, "review", {
        head_sha: "a".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_MISMATCH" });
    expect(h.calls()).toHaveLength(0);
  });
  it("a managed writable branch can advance only to a descendant commit on that branch", async () => {
    const head = h.initGit();
    h.git(["checkout", "feat/source"]);
    await h.lord.start("task", "codex", null, "work", {
      repository: h.target,
      source_branch: "feat/source",
      workspace_policy: "reuse-or-create",
      head_sha: head,
    });
    writeFileSync(path.join(h.target, "tracked.txt"), "changed\n");
    h.git(["commit", "-qam", "advance"]);
    const advanced = h.git(["rev-parse", "HEAD"]);
    await h.lord.turn("task", "next");
    expect(h.lord.store.task("task").contract.source).toMatchObject({
      head_sha: head,
      verified_head_sha: advanced,
    });
    h.git(["checkout", "-b", "wrong-branch"]);
    writeFileSync(path.join(h.target, "tracked.txt"), "wrong\n");
    h.git(["commit", "-qam", "wrong branch"]);
    await expect(h.lord.turn("task", "reject")).rejects.toMatchObject({
      code: "SOURCE_MISMATCH",
    });
    expect(h.calls()).toHaveLength(2);
  });
  it("read-only tasks still require their frozen source head after a commit", async () => {
    const head = h.initGit();
    await h.lord.start("task", "codex", h.target, "review", {
      head_sha: head,
      read_only: true,
    });
    writeFileSync(path.join(h.target, "tracked.txt"), "changed\n");
    h.git(["commit", "-qam", "advance"]);
    await expect(h.lord.turn("task", "next")).rejects.toMatchObject({
      code: "SOURCE_MISMATCH",
    });
  });
  it("one writer excludes both another writer and readers until completion", async () => {
    h.options({ delayMs: 300 });
    const first = h.lord.start("writer", "codex", h.target, "work");
    await waitFor(() => h.calls().length === 1);
    await expect(
      h.lord.start("writer-b", "codex", h.target, "other"),
    ).rejects.toMatchObject({ code: "WORKSPACE_WRITE_CONFLICT" });
    await expect(
      h.lord.start("reader", "codex", h.target, "review", { read_only: true }),
    ).rejects.toMatchObject({ code: "WORKSPACE_WRITE_CONFLICT" });
    await first;
  });
  it("shared readers run concurrently", async () => {
    h.options({ delayMs: 400 });
    const first = h.lord.start("a", "codex", h.target, "review", {
      read_only: true,
    });
    await waitFor(() => h.calls().length === 1);
    const second = h.lord.start("b", "codex", h.target, "review", {
      read_only: true,
    });
    expect((await Promise.all([first, second])).map((v) => v.status)).toEqual([
      "SUCCEEDED",
      "SUCCEEDED",
    ]);
  });
  it("a durable unfenced writer blocks another writer even without a live lock", async () => {
    h.lord.store.createOperation(
      operation("codex-cli", { target: h.target, controller_pid: 2147483647 }),
    );
    await expect(
      h.lord.start("other", "codex", h.target, "work"),
    ).rejects.toMatchObject({
      code: "WORKSPACE_WRITE_CONFLICT",
      safe_recovery: "RUN_CHECKPOINT_TO_FENCE_THEN_RETRY",
    });
  });
  it("parallel workers use isolated branches and integrator waits for the declared worker order", async () => {
    const head = h.initGit();
    const common = {
      repository: h.target,
      source_branch: "feat/source",
      head_sha: head,
      parallel_group: "batch",
      integration_target_branch: "feat/source",
    };
    for (const [id, order] of [
      ["a", 1],
      ["b", 2],
    ] as const)
      await h.lord.start(id, "codex", null, "work", {
        ...common,
        workspace_policy: "isolated",
        workspace_branch: `codex/${id}`,
        integration_role: "worker",
        integrator_task_id: "integrator",
        integration_order: order,
      });
    expect(h.lord.store.task("a").target).not.toBe(
      h.lord.store.task("b").target,
    );
    await expect(
      h.lord.start("integrator", "codex", null, "integrate", {
        ...common,
        workspace_policy: "reuse-or-create",
        integration_role: "integrator",
        integration_workers: ["b", "a"],
      }),
    ).rejects.toMatchObject({ code: "PARALLEL_WRITE_PLAN_INCOMPLETE" });
    const result = await h.lord.start(
      "integrator",
      "codex",
      null,
      "integrate",
      {
        ...common,
        workspace_policy: "reuse-or-create",
        integration_role: "integrator",
        integration_workers: ["a", "b"],
      },
    );
    expect(result.status).toBe("SUCCEEDED");
  });
  it("parallel workers cannot claim the same integration position", async () => {
    const head = h.initGit();
    const common = {
      repository: h.target,
      source_branch: "feat/source",
      head_sha: head,
      workspace_policy: "isolated" as const,
      parallel_group: "batch",
      integration_target_branch: "feat/source",
      integration_role: "worker" as const,
      integrator_task_id: "integrator",
      integration_order: 1,
    };
    await h.lord.start("a", "codex", null, "work", {
      ...common,
      workspace_branch: "codex/a",
    });
    await expect(
      h.lord.start("b", "codex", null, "work", {
        ...common,
        workspace_branch: "codex/b",
      }),
    ).rejects.toMatchObject({ code: "PARALLEL_WRITE_PLAN_INCOMPLETE" });
  });
});
describe("delivery and artifact boundaries", () => {
  it.each(["../escape", "/absolute", "a\\b", "", "a\0b"])(
    "rejects unsafe required file %j",
    (name) => expect(() => deliveryRequirements(h.target, [name])).toThrow(),
  );
  it("files must be nonempty and cannot escape through a symlink", () => {
    writeFileSync(path.join(h.base, "outside.txt"), "private");
    symlinkSync(path.join(h.base, "outside.txt"), path.join(h.target, "link"));
    expect(() => deliveryRequirements(h.target, ["link"])).toThrow();
    const requirements = deliveryRequirements(h.target, ["result.txt"]);
    const op = operation("codex-cli", {
      target: h.target,
      delivery_requirements: requirements,
    });
    expect(verifyDelivery(op).status).toBe("incomplete");
    writeFileSync(path.join(h.target, "result.txt"), "");
    expect(verifyDelivery(op).status).toBe("incomplete");
    writeFileSync(path.join(h.target, "result.txt"), "result");
    expect(verifyDelivery(op).status).toBe("verified");
  });
  it("commit evidence requires a new descendant commit and a clean worktree", () => {
    h.initGit();
    const op = operation("codex-cli", {
      target: h.target,
      delivery_requirements: deliveryRequirements(h.target, [], true),
    });
    expect(verifyDelivery(op).status).toBe("incomplete");
    writeFileSync(path.join(h.target, "tracked.txt"), "changed");
    h.git(["commit", "-qam", "delivery"]);
    expect(verifyDelivery(op).status).toBe("verified");
    writeFileSync(path.join(h.target, "untracked"), "dirty");
    expect(verifyDelivery(op).status).toBe("incomplete");
  });
  it("Codex result selection is bound to the operation marker and excludes hidden reasoning", () => {
    const items = [
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "user", content: [{ type: "text", text: "marker" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "final" },
        ],
      },
    ];
    expect(extractCodexResult({ items }, "marker")).toBe("final");
    expect(() => extractCodexResult({ items }, "absent")).toThrow();
  });
  function codexLog(
    opId: string,
    model = "gpt-5.6-sol",
    effort: string | null = "high",
  ): string {
    const file = path.join(h.base, "export.jsonl");
    const records = [
      {
        type: "turn_context",
        payload: { model, ...(effort ? { effort } : {}) },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: operationMarker(opId) }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "reasoning", text: "private" },
            { type: "output_text", text: "exported final" },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((v) => JSON.stringify(v)).join("\n"));
    return file;
  }
  it.each([
    ["wrong", "high", "MODEL_MISMATCH"],
    ["gpt-5.6-sol", null, "EFFORT_UNVERIFIED"],
  ])(
    "rejected export %s/%s preserves an existing success",
    async (model, effort, code) => {
      const first = await h.lord.start("task", "codex", h.target, "work");
      const file = codexLog(first.operation_id!, model!, effort);
      expect(() =>
        h.lord.exportArtifact("task", first.operation_id!, file, "codex-jsonl"),
      ).toThrow();
      const saved = h.lord.store.operation(first.operation_id!);
      expect(saved.status).toBe("succeeded");
      expect(saved.artifact).toEqual(first.artifact);
      expect(readFileSync(first.artifact!.path, "utf8")).toBe("codex final\n");
    },
  );
  it("successful export selects the last final assistant message", async () => {
    const first = await h.lord.start("task", "codex", h.target, "work");
    const result = h.lord.exportArtifact(
      "task",
      first.operation_id!,
      codexLog(first.operation_id!),
      "codex-jsonl",
    );
    expect(readFileSync(result.artifact!.path, "utf8")).toBe(
      "exported final\n",
    );
  });
  it("Claude export binds the saved session and declares its effort evidence gap", async () => {
    const first = await h.lord.start("task", "claude-cli", h.target, "work");
    const file = path.join(h.base, "claude.jsonl");
    const entry = {
      type: "assistant",
      sessionId: first.endpoint_id,
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [
          { type: "text", text: "final export" },
          { type: "thinking", thinking: "private" },
        ],
      },
    };
    writeFileSync(file, JSON.stringify(entry));
    const result = h.lord.exportArtifact(
      "task",
      first.operation_id!,
      file,
      "claude-jsonl",
    );
    expect(result.warnings).toEqual([
      {
        code: "EFFORT_UNVERIFIABLE_FORMAT",
        source_format: "claude-jsonl",
        expected_effort: "high",
      },
    ]);
    entry.sessionId = "other";
    writeFileSync(file, JSON.stringify(entry));
    expect(() =>
      h.lord.exportArtifact("task", first.operation_id!, file, "claude-jsonl"),
    ).toThrow(/requested session/);
  });
  it("MCode auxiliary import is refused without invalidating success", async () => {
    const first = await h.lord.start("task", "mcode", h.target, "work", {
      model: "test/model",
    });
    expect(() =>
      h.lord.exportArtifact(
        "task",
        first.operation_id!,
        "unused",
        "mcode-stream-json",
      ),
    ).toThrow(/auxiliary MCode import is refused/);
    expect(h.lord.check("task").status).toBe("SUCCEEDED");
  });
});
