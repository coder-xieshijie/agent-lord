import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { object, type Data, type Envelope } from "../src/contracts.js";
import { CheckpointScan } from "../src/checkpoint-scan.js";
import {
  INVALID_RETRY_POLICY,
  invalidRetryMessage,
  retryResultInvalid,
} from "../src/invalid-retry.js";
import { harness, operation } from "./helpers.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

describe("O1: MCode progress journal throttling", () => {
  it("journals item progress at a bounded rate without losing identity or the final state", async () => {
    // 40 item events + exec/session/turn lifecycle = 45 stream events. The
    // pre-throttle implementation performed one locked journal write per
    // event (>= 45 updateOperation calls before terminal publication).
    h.options({ itemEvents: 40 });
    const spy = vi.spyOn(h.lord.store, "updateOperation");
    const result = await h.lord.start("task", "mcode", h.target, "work", {
      model: "test/model",
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.endpoint_id).toBe("mcode-session");
    const journalWrites = spy.mock.calls.length;
    expect(journalWrites).toBeLessThan(20);
    // Identity and terminal facts still persisted despite coalescing.
    const op = h.lord.store.operation(String(result.operation_id));
    expect(op.endpoint_id).toBe("mcode-session");
    expect(op.provider_return_code).toBe(0);
    expect(op.status).toBe("succeeded");
  });
  it("throttling does not weaken resume: a continuation reuses the same session", async () => {
    h.options({ itemEvents: 25 });
    const first = await h.lord.start("task", "mcode", h.target, "work", {
      model: "test/model",
    });
    const second = await h.lord.turn("task", "next");
    expect(second.endpoint_id).toBe(first.endpoint_id);
    expect(h.calls()[1].args).toContain(String(first.endpoint_id));
  });
});

describe("O3: checkpoint scan stat cache", () => {
  it("re-parses only records whose file identity changed", async () => {
    await h.lord.start("done", "codex", h.target, "work");
    h.lord.store.createOperation(
      operation("codex-cli", {
        task_id: "extra",
        operation_id: "extra-op",
        target: h.target,
      }),
    );
    const scan = new CheckpointScan(h.lord.store);
    scan.tick();
    const first = scan.stats.parsed;
    expect(first).toBeGreaterThanOrEqual(3); // 1 task + 2 operations
    expect(scan.stats.reused).toBe(0);
    scan.tick();
    // Nothing changed on disk: every record is served from the cache.
    expect(scan.stats.parsed).toBe(first);
    expect(scan.stats.reused).toBe(first);
    h.lord.store.updateOperation("extra-op", (op) => ({
      ...op,
      status: "succeeded",
    }));
    scan.tick();
    // Exactly the rewritten record is re-parsed; the update is observed.
    expect(scan.stats.parsed).toBe(first + 1);
    expect(
      scan.operations.find((op) => op.operation_id === "extra-op")!.status,
    ).toBe("succeeded");
  });
});

describe("O4: batched checkpoint supervision", () => {
  const deadController = (operationId: string) =>
    h.lord.store.updateOperation(operationId, (op) => ({
      ...op,
      status: "running",
      controller_pid: 2147483647,
      recovery_controller_pid: null,
      artifact: null,
      observed: {},
    }));
  it("returns every envelope supervised in one tick instead of the first", async () => {
    for (const id of ["a", "b"]) {
      const target = path.join(h.base, `ws-${id}`);
      mkdirSync(target);
      const first = await h.lord.start(id, "codex", target, "work");
      deadController(String(first.operation_id));
    }
    const [result, quiet] = await h.lord.checkpoint(["a", "b"], 2);
    expect(quiet).toBe(false);
    expect(result.actionable!.map((v) => v.task_id).sort()).toEqual(["a", "b"]);
    for (const envelope of result.actionable as Envelope[])
      expect(envelope.status).toBe("SUCCEEDED");
    expect(h.calls()).toHaveLength(2); // recovery never re-dispatched
  });
  it("a supervision error does not drop envelopes already collected in the tick", async () => {
    const a = await h.lord.start("a", "codex", h.target, "work");
    deadController(String(a.operation_id));
    // Force deterministic ordering: "a" is supervised first.
    h.lord.store.updateOperation(String(a.operation_id), (op) => ({
      ...op,
      created_at: "2020-01-01T00:00:00+00:00",
    }));
    const otherTarget = path.join(h.base, "ws-claude");
    mkdirSync(otherTarget);
    const b = await h.lord.start("b", "claude-cli", otherTarget, "other");
    deadController(String(b.operation_id));
    const spy = vi
      .spyOn(
        h.lord as unknown as { superviseClaude: () => Promise<Envelope> },
        "superviseClaude",
      )
      .mockRejectedValue(new Error("transient supervision failure"));
    try {
      const [result, quiet] = await h.lord.checkpoint(["a", "b"], 2);
      expect(quiet).toBe(false);
      expect(result.actionable!.map((v) => v.task_id)).toEqual(["a"]);
      expect(result.actionable![0].status).toBe("SUCCEEDED");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("O2: scripted Claude RESULT_INVALID retry", () => {
  const invalidOp = (taskId: string, operationId: string, extra: Data = {}) =>
    h.lord.store.createOperation(
      operation("claude-cli", {
        task_id: taskId,
        operation_id: operationId,
        target: h.target,
        status: "failed",
        error: {
          code: "RESULT_INVALID",
          message: "provider output lacked the required result shape",
          retryable: false,
          requires_authorization: false,
        },
        ...extra,
      }),
    );
  it("replays a marked continuation on the same session and is idempotent", async () => {
    await h.lord.start("task", "claude-cli", h.target, "perform original work");
    invalidOp("task", "fail-1");
    const retry = await retryResultInvalid(h.lord, "task", "fail-1");
    expect(retry.status).toBe("SUCCEEDED");
    expect(object(retry.invalid_retry as Data)).toMatchObject({
      root_operation_id: "fail-1",
      attempt: 1,
      mode: "same-session",
      budget_remaining: 2,
    });
    const calls = h.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("--resume");
    expect(calls[1].prompt).toContain("agent-lord-invalid-retry:fail-1:1");
    expect(calls[1].prompt).toContain("authorized work");
    // Ledger lives on the lineage root and records the success.
    const ledger = object(
      h.lord.store.operation("fail-1").invalid_retry_ledger,
    );
    expect(ledger.policy).toBe(INVALID_RETRY_POLICY);
    expect((ledger.attempts as Data[])[0]).toMatchObject({
      attempt: 1,
      mode: "same-session",
      task_id: "task",
    });
    // Idempotent replay: no third provider call, same retry operation.
    const again = await retryResultInvalid(h.lord, "task", "fail-1");
    expect(again.operation_id).toBe(retry.operation_id);
    expect(object(again.invalid_retry as Data).outcome).toBe(
      "already-succeeded",
    );
    expect(h.calls()).toHaveLength(2);
  });
  it("two identical fingerprints force a replacement session with frozen contract and lineage", async () => {
    await h.lord.start("task", "claude-cli", h.target, "perform original work", {
      model: "claude-opus-5",
    });
    invalidOp("task", "fail-1");
    h.options({ missingTerminal: true });
    await expect(
      retryResultInvalid(h.lord, "task", "fail-1"),
    ).rejects.toMatchObject({ code: "RESULT_INVALID" });
    const r1 = h.lord.store
      .operations("task")
      .find(
        (op) =>
          op.message === invalidRetryMessage("fail-1", 1, "authorized work"),
      )!;
    expect(r1.status).toBe("failed");
    expect(object(r1.invalid_retry)).toMatchObject({
      root_operation_id: "fail-1",
      attempt: 1,
      mode: "same-session",
    });
    await expect(
      retryResultInvalid(h.lord, "task", r1.operation_id),
    ).rejects.toMatchObject({ code: "RESULT_INVALID" });
    const r2 = h.lord.store
      .operations("task")
      .find(
        (op) =>
          op.message === invalidRetryMessage("fail-1", 2, "authorized work"),
      )!;
    // Streak of two identical fingerprints: next retry must replace the session.
    h.options({});
    const final = await retryResultInvalid(h.lord, "task", r2.operation_id);
    expect(final.status).toBe("SUCCEEDED");
    expect(object(final.invalid_retry as Data)).toMatchObject({
      root_operation_id: "fail-1",
      attempt: 3,
      mode: "new-session",
      replacement_for: "task",
      budget_remaining: 0,
    });
    expect(final.task_id).toBe("task-r3");
    expect(h.lord.store.hasTask("task-r3")).toBe(true);
    expect(h.lord.store.hasTask("task")).toBe(true); // original never rebound
    const last = h.calls().at(-1)!;
    expect(last.args).toContain("claude-opus-5"); // frozen contract model
    expect(last.prompt).toContain("agent-lord-invalid-retry:fail-1:3");
  });
  it("a dispatched-and-failed retry consumes budget until exhaustion", async () => {
    await h.lord.start("task", "claude-cli", h.target, "perform original work");
    invalidOp("task", "fail-1");
    h.options({ missingTerminal: true });
    let failedId = "fail-1";
    let failedTask = "task";
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(
        retryResultInvalid(h.lord, failedTask, failedId),
      ).rejects.toMatchObject({ code: "RESULT_INVALID" });
      const message = invalidRetryMessage("fail-1", attempt, "authorized work");
      failedTask = attempt >= 3 ? "task-r3" : "task";
      failedId = h.lord.store
        .operations(failedTask)
        .find((op) => op.message === message)!.operation_id;
    }
    await expect(
      retryResultInvalid(h.lord, failedTask, failedId),
    ).rejects.toMatchObject({ code: "RETRY_BUDGET_EXHAUSTED" });
    const ledger = object(
      h.lord.store.operation("fail-1").invalid_retry_ledger,
    );
    expect(ledger.attempts).toHaveLength(3);
    for (const attempt of ledger.attempts as Data[])
      expect(attempt.operation_id).toBeTruthy();
  });
  it("a failure without a durable task forces a new session with recorded lineage", async () => {
    invalidOp("ghost", "ghost-fail");
    const result = await retryResultInvalid(h.lord, "ghost", "ghost-fail");
    expect(result.status).toBe("SUCCEEDED");
    expect(object(result.invalid_retry as Data)).toMatchObject({
      mode: "new-session",
      forced_new_session: true,
      replacement_for: "ghost",
    });
    expect(h.lord.store.hasTask("ghost-r1")).toBe(true);
  });
  it("a parallel-group member is never replaced automatically", async () => {
    invalidOp("member", "member-fail", {
      parallel_plan: { role: "worker" },
    });
    await expect(
      retryResultInvalid(h.lord, "member", "member-fail"),
    ).rejects.toMatchObject({
      code: "REPLACEMENT_UNAVAILABLE",
      requires_authorization: true,
    });
  });
  it("a live concurrent dispatcher is not taken over", async () => {
    await h.lord.start("task", "claude-cli", h.target, "perform original work");
    invalidOp("task", "fail-1");
    h.lord.store.updateOperation("fail-1", (op) => ({
      ...op,
      invalid_retry_ledger: {
        policy: INVALID_RETRY_POLICY,
        budget: 3,
        failures: [
          {
            operation_id: "fail-1",
            fingerprint: "abc",
            observed_at: "2026-09-09T00:00:00+00:00",
          },
        ],
        attempts: [
          {
            attempt: 1,
            mode: "same-session",
            task_id: "task",
            after_failure_operation_id: "fail-1",
            message_sha256: "not-a-real-hash",
            controller_pid: 1,
            dispatched_at: "2026-09-09T00:00:00+00:00",
            operation_id: null,
          },
        ],
      },
    }));
    await expect(
      retryResultInvalid(h.lord, "task", "fail-1"),
    ).rejects.toMatchObject({ code: "STATE_BUSY", retryable: true });
    expect(h.calls()).toHaveLength(1);
  });
  it("only a terminal claude-cli RESULT_INVALID failure qualifies", async () => {
    const ok = await h.lord.start("task", "claude-cli", h.target, "work");
    await expect(
      retryResultInvalid(h.lord, "task", String(ok.operation_id)),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    invalidOp("other", "other-fail", { provider: "codex-cli" });
    await expect(
      retryResultInvalid(h.lord, "other", "other-fail"),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
