import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  object,
  type Data,
  type Envelope,
  TERMINAL_STATES,
} from "../src/contracts.js";
import { recordLock } from "../src/state.js";
import { leaseId } from "../src/workspace.js";
import { pidAlive } from "../src/process.js";
import { claudeOutputActivityMs } from "../src/providers/claude-cli.js";
import { harness, operation, waitFor } from "./helpers.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
const onlyAction = (result: [Envelope, boolean]): Envelope => {
  expect(result[1]).toBe(false);
  expect(result[0].actionable).toHaveLength(1);
  return result[0].actionable![0];
};
function journal(
  provider: "claude-cli" | "codex-cli" | "mcode-cli",
  extra: Data = {},
) {
  return h.lord.store.createOperation(
    operation(provider, {
      target: h.target,
      controller_pid: 2147483647,
      pid: null,
      ...extra,
    }),
  );
}
describe("checkpoint behavior", () => {
  it("auto-select with no active tasks is immediately quiet", async () => {
    const start = Date.now();
    const result = await h.lord.checkpoint(undefined, 150);
    expect(result).toEqual([
      { version: 1, status: "CHECKPOINT_QUIET", seconds: 150, active: [] },
      true,
    ]);
    expect(Date.now() - start).toBeLessThan(500);
  });
  it("unknown explicitly selected tasks are reported", async () => {
    await expect(h.lord.checkpoint(["unknown"], 1)).rejects.toMatchObject({
      code: "TASK_UNKNOWN",
    });
  });
  it("a pending App action is immediately actionable", async () => {
    const start = await h.lord.start("app", "codex-app", "project", "work");
    const result = onlyAction(await h.lord.checkpoint(["app"], 1));
    expect(result.action).toEqual(start.action);
  });
  it("progress stays compact until the quiet deadline without requiring a task handle", async () => {
    journal("claude-cli", {
      controller_pid: process.pid,
      active_attempt: {
        controller_pid: process.pid,
        progress_seq: 7,
        progress_state: "tool_wait",
      },
      message: "private prompt must not appear",
      observed: {
        supervision: {
          state: "tool_wait",
          active_tools: ["Bash"],
          active_tool_count: 1,
        },
      },
    });
    const start = Date.now();
    const [result, quiet] = await h.lord.checkpoint(["task-1"], 0.2);
    expect(quiet).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(190);
    expect(result.active![0]).toMatchObject({
      progress_seq: 7,
      supervision_state: "tool_wait",
      active_tool_count: 1,
    });
    expect(JSON.stringify(result)).not.toContain("private prompt");
  });
  it("terminal changes wake promptly and repeated reads preserve the terminal result", async () => {
    journal("claude-cli", { controller_pid: process.pid });
    const timer = setTimeout(
      () =>
        h.lord.store.updateOperation("operation-1", (op) => ({
          ...op,
          status: "succeeded",
        })),
      100,
    );
    try {
      const start = Date.now();
      const result = onlyAction(await h.lord.checkpoint(["task-1"], 3));
      expect(result.status).toBe("SUCCEEDED");
      expect(Date.now() - start).toBeLessThan(1500);
      expect(onlyAction(await h.lord.checkpoint(["task-1"], 1))).toEqual(
        result,
      );
    } finally {
      clearTimeout(timer);
    }
  });
  it("returns all simultaneous terminal tasks", async () => {
    for (const id of ["a", "b"])
      h.lord.store.createOperation(
        operation("codex-cli", {
          task_id: id,
          operation_id: `${id}-op`,
          status: "succeeded",
          target: h.target,
        }),
      );
    const [result, quiet] = await h.lord.checkpoint(["a", "b"], 1);
    expect(quiet).toBe(false);
    expect(result.actionable!.map((v) => v.task_id)).toEqual(["a", "b"]);
  });
  it.each(["codex-cli", "mcode-cli"] as const)(
    "orphan %s before launch is retryable; ambiguous launch needs a decision",
    async (provider) => {
      journal(provider, { status: "preparing" });
      const first = onlyAction(await h.lord.checkpoint(["task-1"], 1));
      expect(first.error).toMatchObject({
        code: "PROCESS_EXITED_WITHOUT_RESULT",
        retryable: true,
      });
      h.lord.store.updateOperation("operation-1", (op) => ({
        ...op,
        status: "preparing",
        provider_command: ["missing"],
      }));
      const second = onlyAction(await h.lord.checkpoint(["task-1"], 1));
      expect(second.status).toBe("NEEDS_DECISION");
      expect(second.error!.code).toBe("DELIVERY_UNKNOWN");
    },
  );
  it("Claude cannot take over the live controller lease", async () => {
    journal("claude-cli", {
      status: "recovering",
      endpoint_id: "session-1",
      active_attempt: null,
    });
    const lease = recordLock(
      "controller-lease",
      leaseId("controller", "operation-1"),
      h.root,
    );
    try {
      expect((await h.lord.checkpoint(["task-1"], 0.15))[1]).toBe(true);
      expect(h.calls()).toHaveLength(0);
    } finally {
      lease.release();
    }
  });
  it("Claude ambiguous preparation without a fenceable process fails closed", async () => {
    journal("claude-cli", {
      status: "preparing",
      endpoint_id: "session-1",
      active_attempt: { prompt_delivery: "delivery-unknown" },
    });
    const result = onlyAction(await h.lord.checkpoint(["task-1"], 1));
    expect(result.error!.code).toBe("DELIVERY_UNKNOWN");
    expect(h.calls()).toHaveLength(0);
  });
  it("Claude controller launch budget produces a terminal, non-retryable error", async () => {
    journal("claude-cli", {
      status: "recovering",
      endpoint_id: "session-1",
      recovery_controller_launches: 5,
    });
    const result = onlyAction(await h.lord.checkpoint(["task-1"], 1));
    expect(result.error).toMatchObject({
      code: "PROVIDER_FAILED",
      retryable: false,
      details: { retry_exhausted: true },
    });
    expect(h.calls()).toHaveLength(0);
  });
  it("check provides a checkpoint hint without taking over a dead controller", async () => {
    const first = await h.lord.start("task", "codex", h.target, "work");
    h.lord.store.updateOperation(first.operation_id!, (op) => ({
      ...op,
      status: "running",
      controller_pid: 2147483647,
    }));
    expect(object(h.lord.check("task").observed).supervision).toMatchObject({
      controller_state: "exited",
      recovery_command: "checkpoint",
    });
    expect(h.lord.store.operation(first.operation_id!).status).toBe("running");
  });
});
describe("durable process recovery", () => {
  it.each(["claude-cli", "codex-cli", "mcode-cli"] as const)(
    "%s recovers a verified result after controller loss without dispatching",
    async (provider) => {
      const first = await h.lord.start(
        "task",
        provider,
        h.target,
        "work",
        provider === "mcode-cli" ? { model: "test/model" } : {},
      );
      h.lord.store.updateOperation(first.operation_id!, (op) => ({
        ...op,
        status: "running",
        controller_pid: 2147483647,
        artifact: null,
        observed: {},
      }));
      const result = onlyAction(await h.lord.checkpoint(["task"], 2));
      expect(result.status).toBe("SUCCEEDED");
      expect(result.artifact).toEqual(first.artifact);
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("MCode never converts terminal text into success without a durable exit receipt", async () => {
    const first = await h.lord.start("task", "mcode", h.target, "work", {
      model: "test/model",
    });
    h.lord.store.updateOperation(first.operation_id!, (op) => {
      op.status = "running";
      op.controller_pid = 2147483647;
      delete op.provider_return_code;
      return op;
    });
    const result = onlyAction(await h.lord.checkpoint(["task"], 1));
    expect(result.status).toBe("NEEDS_DECISION");
    expect(result.error!.code).toBe("DELIVERY_UNKNOWN");
    expect(result.artifact).toBeUndefined();
    expect(h.calls()).toHaveLength(1);
  });
  it("MCode incomplete terminal gets a bounded grace interval and no resend", async () => {
    journal("mcode-cli", {
      stdout_path: path.join(h.root, "logs", "out"),
      stderr_path: path.join(h.root, "logs", "err"),
      result_path: path.join(h.root, "logs", "final"),
    });
    writeFileSync(path.join(h.root, "logs", "out"), "");
    writeFileSync(path.join(h.root, "logs", "err"), "");
    const result = onlyAction(await h.lord.checkpoint(["task-1"], 2));
    expect(result.error!.code).toBe("DELIVERY_UNKNOWN");
    expect(result.error!.requires_authorization).toBe(true);
    expect(h.calls()).toHaveLength(0);
  });
  it("Claude stall fences a real provider and sends exactly one continuation", async () => {
    h.options({ delayMs: 20000, delayFirstOnly: true });
    const result = await h.lord.start(
      "task",
      "claude-cli",
      h.target,
      "original mutation",
      { retry_attempts: 2 },
    );
    expect(result.status).toBe("SUCCEEDED");
    expect(h.calls()).toHaveLength(2);
    expect(h.calls()[1].prompt).toContain("agent-lord-recovery:");
    expect(pidAlive(h.calls()[0].pid)).toBe(false);
  }, 10000);
  it("a killed Claude controller is recovered by one detached worker across concurrent checkpoints", async () => {
    h.options({ delayMs: 20000, delayFirstOnly: true });
    const prompt = path.join(h.base, "prompt.txt");
    writeFileSync(prompt, "original mutation");
    const controller = h.controller([
      "start",
      "--task-id",
      "task",
      "--provider",
      "claude-cli",
      "--target",
      h.target,
      "--message-file",
      prompt,
      "--retry-attempts",
      "2",
    ]);
    await waitFor(() => h.calls().length === 1);
    await waitFor(() => h.lord.store.operations()[0]?.status === "running");
    controller.kill("SIGKILL");
    await waitFor(() => controller.signalCode !== null);
    const started = Date.now();
    const results = await Promise.all([
      h.lord.checkpoint(["task"], 0.15),
      h.lord.checkpoint(["task"], 0.15),
    ]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results.every(([, quiet]) => quiet)).toBe(true);
    await waitFor(() => {
      const op = h.lord.store.operations()[0];
      const activity = op && claudeOutputActivityMs(op);
      return activity !== null && Date.now() - activity > 1200;
    });
    await Promise.all([
      h.lord.checkpoint(["task"], 0.2),
      h.lord.checkpoint(["task"], 0.2),
    ]);
    try {
      await waitFor(
        () => h.lord.store.operations()[0]?.status === "succeeded",
        9000,
      );
    } catch (error) {
      const op = h.lord.store.operations()[0];
      throw new Error(
        JSON.stringify({
          status: op.status,
          error: op.error,
          history: op.attempt_history,
          active: op.active_attempt,
          owner: op.recovery_controller_pid,
          launches: op.recovery_controller_launches,
          calls: h.calls().length,
        }),
        { cause: error },
      );
    }
    expect(h.calls()).toHaveLength(2);
    expect(h.calls()[1].args).toContain("--resume");
    expect(h.calls()[1].prompt).not.toContain("original mutation");
    expect(onlyAction(await h.lord.checkpoint(["task"], 1)).status).toBe(
      "SUCCEEDED",
    );
  }, 15000);
  it("MCode checkpoint fences only its orphan provider, never a different process", async () => {
    h.options({ delayMs: 20000 });
    const prompt = path.join(h.base, "prompt.txt");
    writeFileSync(prompt, "work");
    const controller = h.controller([
      "start",
      "--task-id",
      "task",
      "--provider",
      "mcode",
      "--model",
      "test/model",
      "--target",
      h.target,
      "--message-file",
      prompt,
    ]);
    await waitFor(() => h.calls().length === 1 && h.lord.store.hasTask("task"));
    const pid = Number(h.calls()[0].pid);
    controller.kill("SIGKILL");
    await waitFor(() => controller.signalCode !== null);
    const result = onlyAction(await h.lord.checkpoint(["task"], 3));
    expect(result.error!.code).toBe("DELIVERY_UNKNOWN");
    expect(pidAlive(pid)).toBe(false);
    expect(pidAlive(process.pid)).toBe(true);
    expect(h.calls()).toHaveLength(1);
  }, 10000);
  it("MCode refuses to fence a live PID not bound to its output path", async () => {
    journal("mcode-cli", {
      pid: process.pid,
      active_attempt: {
        pid: process.pid,
        process_group_id: null,
        result_path: "/unrelated-file",
      },
    });
    const result = onlyAction(await h.lord.checkpoint(["task-1"], 1));
    expect(result.error!.code).toBe("PROCESS_FENCE_FAILED");
    expect(pidAlive(process.pid)).toBe(true);
  });
});
