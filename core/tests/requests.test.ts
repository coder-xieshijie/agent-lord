import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Data, type Envelope } from "../src/contracts.js";
import { AgentLord } from "../src/engine.js";
import { RequestInbox } from "../src/requests.js";
import { main } from "../src/cli.js";
import { harness, operation, waitFor } from "./helpers.js";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const inbox = () => new RequestInbox(h.lord);
const record = (envelope: Envelope): Data => envelope.request as Data;
function file(name: string, text: string): string {
  const target = path.join(h.base, name);
  writeFileSync(target, text);
  return target;
}
function register(overrides: Data = {}): Envelope {
  return inbox().register({
    request_id: "req-1",
    intent: "start",
    task_id: "later",
    message: "do the deferred work",
    user_request: "after the current task, do the deferred work",
    provider: "mcode-cli",
    target: h.target,
    options: { model: "test/model" },
    ...overrides,
  });
}
/** A journaled operation that already carries its originating request. */
function journalFor(requestId: string, overrides: Data = {}) {
  return h.lord.store.createOperation(
    operation("mcode-cli", {
      operation_id: `op-${requestId}`,
      task_id: "later",
      target: h.target,
      request_id: requestId,
      ...overrides,
    }),
  );
}

describe("passive request inbox", () => {
  it("registers a pending request that a separate process can still find", async () => {
    const registered = register();
    expect(record(registered)).toMatchObject({
      request_id: "req-1",
      status: "pending",
      operation_id: null,
      message: "do the deferred work",
      user_request: "after the current task, do the deferred work",
    });
    // A fresh engine stands in for the restarted scheduler: nothing is cached
    // in the original process.
    const restarted = new RequestInbox(new AgentLord(h.root));
    expect(record(restarted.get("req-1"))).toMatchObject({
      status: "pending",
      message: "do the deferred work",
    });
    const listed = restarted.list({ status: "pending" });
    expect(listed.counts).toMatchObject({ pending: 1, dispatched: 0 });
    expect(listed.requests![0]).toMatchObject({
      request_id: "req-1",
      message_preview: "do the deferred work",
      has_user_request: true,
    });
    let out = "";
    expect(
      await main(["request-list", "--status", "pending"], (v) => {
        out += v;
      }),
    ).toBe(0);
    expect(JSON.parse(out).requests[0].request_id).toBe("req-1");
  });
  it("registering the same id again is re-entrant but a different intent conflicts", () => {
    const first = register();
    expect(record(register())).toEqual(record(first));
    expect(() => register({ message: "something else entirely" })).toThrow(
      expect.objectContaining({ code: "REQUEST_CONFLICT" }),
    );
    expect(() => register({ task_id: "other" })).toThrow(
      expect.objectContaining({ code: "REQUEST_CONFLICT" }),
    );
    // Two ids may legitimately carry the same text.
    expect(record(register({ request_id: "req-2" })).request_id).toBe("req-2");
    expect(inbox().list().counts).toMatchObject({ pending: 2 });
  });
  it("rejects a registration whose options do not belong to its intent", () => {
    expect(() =>
      register({
        request_id: "req-turn",
        intent: "turn",
        provider: null,
        target: null,
        options: { model: "test/model" },
      }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() =>
      register({ request_id: "req-both", options: {}, provider: null }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
  it("dispatch turns one pending request into exactly one operation", async () => {
    register();
    const dispatched = await inbox().dispatch("req-1");
    expect(dispatched.status).toBe("SUCCEEDED");
    const operationId = dispatched.operation_id!;
    expect(dispatched.request).toMatchObject({
      request_id: "req-1",
      status: "dispatched",
      operation_id: operationId,
    });
    expect(h.lord.store.operations("later")).toHaveLength(1);
    expect(h.lord.store.operation(operationId).request_id).toBe("req-1");
    // Consuming an already dispatched request returns the same association
    // instead of opening another turn.
    const again = await inbox().dispatch("req-1");
    expect(again.operation_id).toBe(operationId);
    expect(h.lord.store.operations("later")).toHaveLength(1);
    expect(h.calls()).toHaveLength(1);
  });
  it("keeps a request pending while its target task is busy", async () => {
    const start = await h.lord.start(
      "busy",
      "mcode-cli",
      h.target,
      "first turn",
      { model: "test/model" },
    );
    h.lord.store.updateOperation(start.operation_id!, (op) => ({
      ...op,
      status: "running",
    }));
    register({
      request_id: "req-busy",
      intent: "turn",
      task_id: "busy",
      provider: null,
      target: null,
      options: {},
      message: "the follow-up the user asked for",
    });
    const pending = await inbox().dispatch("req-busy");
    expect(pending.status).toBe("REQUEST_PENDING");
    expect(pending.pending_reason!.code).toBe("OPERATION_IN_FLIGHT");
    expect(record(pending)).toMatchObject({
      status: "pending",
      operation_id: null,
    });
    // Nothing was injected into the running operation.
    expect(h.lord.store.operations("busy")).toHaveLength(1);
    expect(record(inbox().get("req-busy")).status).toBe("pending");
  });
  it("rebuilds a request that crashed after its operation was journaled", async () => {
    register();
    const journaled = journalFor("req-1", { status: "succeeded" });
    // The request record still says pending: only the operation log committed.
    expect(h.lord.store.requestRecord("req-1").status).toBe("pending");
    const recovered = inbox().get("req-1");
    expect(record(recovered)).toMatchObject({
      status: "dispatched",
      operation_id: journaled.operation_id,
    });
    expect(h.lord.store.requestRecord("req-1").status).toBe("dispatched");
    const dispatched = await inbox().dispatch("req-1");
    expect(dispatched.operation_id).toBe(journaled.operation_id);
    expect(h.lord.store.operations("later")).toHaveLength(1);
    expect(h.calls()).toHaveLength(0);
  });
  it("never re-sends a request whose delivery is unknown", async () => {
    register();
    journalFor("req-1", {
      status: "failed",
      error: {
        code: "DELIVERY_UNKNOWN",
        message: "prompt delivery could not be confirmed",
        retryable: false,
        requires_authorization: true,
      },
    });
    const result = await inbox().dispatch("req-1");
    expect(result.error!.code).toBe("DELIVERY_UNKNOWN");
    expect(result.operation_id).toBe("op-req-1");
    // The recorded operation is the only one; recovery stays the existing
    // decision boundary rather than a second dispatch.
    expect(h.lord.store.operations("later")).toHaveLength(1);
    expect(h.calls()).toHaveLength(0);
  });
  it("resolves the cancel and consume race in both directions", async () => {
    register({ request_id: "req-cancel" });
    expect(
      record(inbox().cancel("req-cancel", "user withdrew it")),
    ).toMatchObject({ status: "cancelled", cancel_reason: "user withdrew it" });
    // Cancelling twice is idempotent; consuming a cancelled request refuses.
    expect(record(inbox().cancel("req-cancel")).status).toBe("cancelled");
    await expect(inbox().dispatch("req-cancel")).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    expect(h.lord.store.operations("later")).toHaveLength(0);
    register({ request_id: "req-2" });
    await inbox().dispatch("req-2");
    expect(() => inbox().cancel("req-2")).toThrow(
      expect.objectContaining({ code: "REQUEST_CONFLICT" }),
    );
  });
  it("concurrent consumers of one request produce a single operation", async () => {
    h.options({ delayMs: 400 });
    const message = file("request.txt", "the deferred work");
    let out = "";
    expect(
      await main(
        [
          "request-add",
          "--request-id",
          "req-race",
          "--intent",
          "start",
          "--task-id",
          "raced",
          "--provider",
          "mcode",
          "--model",
          "test/model",
          "--target",
          h.target,
          "--message-file",
          message,
        ],
        (v) => {
          out += v;
        },
      ),
    ).toBe(0);
    const consume = () =>
      h.controller(["request-dispatch", "--request-id", "req-race"]);
    const children = [consume(), consume()];
    const codes = await Promise.all(
      children.map(
        (child) =>
          new Promise<number>((resolve) =>
            child.on("exit", (code) => resolve(code ?? -1)),
          ),
      ),
    );
    expect(codes).toContain(0);
    const operations = h.lord.store.operations("raced");
    expect(operations).toHaveLength(1);
    expect(operations[0].request_id).toBe("req-race");
    expect(h.calls()).toHaveLength(1);
    // The loser is a deterministic busy refusal, never a second dispatch.
    expect(codes.filter((v) => v === 0)).toHaveLength(1);
    const settled = await inbox().dispatch("req-race");
    expect(settled.operation_id).toBe(operations[0].operation_id);
    expect(h.lord.store.operations("raced")).toHaveLength(1);
  }, 20000);
  it("keeps caller metadata descriptive", () => {
    register({
      request_id: "req-a",
      source: { kind: "codex", session_id: "session-a" },
    });
    register({
      request_id: "req-b",
      source: { kind: "codex", session_id: "session-b" },
    });
    expect(
      inbox().list({ source_session_id: "session-a" }).requests,
    ).toHaveLength(1);
    // Filtering never hides a record from an explicit read.
    expect(record(inbox().get("req-b")).status).toBe("pending");
    expect(inbox().list().requests).toHaveLength(2);
  });
  it("refuses a corrupt or unknown request record", () => {
    expect(() => inbox().get("missing")).toThrow(
      expect.objectContaining({ code: "REQUEST_UNKNOWN" }),
    );
    register();
    const raw = h.lord.store.requestRecord("req-1");
    h.lord.store.writeRequest({ ...raw, message: "tampered" });
    expect(() => inbox().get("req-1")).toThrow(
      expect.objectContaining({ code: "STATE_CORRUPT" }),
    );
  });
});

describe("checkpoint starting window", () => {
  it("keeps an unknown ordinary task_id strict even beside a starting id", async () => {
    await expect(
      h.lord.checkpoint(["missing"], 1, ["arriving"]),
    ).rejects.toMatchObject({ code: "TASK_UNKNOWN" });
    await expect(
      h.lord.checkpoint(["arriving"], 1, ["arriving"]),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("reports a starting id that never appears instead of waiting forever", async () => {
    const started = Date.now();
    const [envelope, quiet] = await h.lord.checkpoint(undefined, 0.3, [
      "arriving",
    ]);
    expect(quiet).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(envelope.starting).toEqual([
      {
        task_id: "arriving",
        phase: "not_observed",
        operation_id: null,
        operation_status: null,
        reason: "no_record_observed",
        detail: expect.stringContaining("not whether the dispatch process"),
      },
    ]);
  });
  it("supervises a starting id as soon as its operation appears", async () => {
    const timer = setTimeout(
      () =>
        h.lord.store.createOperation(
          operation("mcode-cli", {
            operation_id: "op-late",
            task_id: "arriving",
            target: h.target,
            status: "succeeded",
          }),
        ),
      120,
    );
    try {
      const [envelope, quiet] = await h.lord.checkpoint(undefined, 4, [
        "arriving",
      ]);
      expect(quiet).toBe(false);
      expect(envelope.actionable).toHaveLength(1);
      expect(envelope.actionable![0]).toMatchObject({
        status: "SUCCEEDED",
        task_id: "arriving",
      });
      // The operation exists without a task record yet, and that stage is
      // reported precisely rather than as "not observed".
      expect(envelope.starting).toEqual([
        {
          task_id: "arriving",
          phase: "operation_recorded",
          operation_id: "op-late",
          operation_status: "succeeded",
        },
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  it("reports a durable task record as the established phase", async () => {
    await h.lord.start("arriving", "mcode-cli", h.target, "work", {
      model: "test/model",
    });
    const [envelope] = await h.lord.checkpoint(undefined, 2, ["arriving"]);
    expect(envelope.starting![0]).toMatchObject({
      task_id: "arriving",
      phase: "task_established",
    });
  });
  it("supervises known tasks while a starting id is still missing", async () => {
    h.lord.store.createOperation(
      operation("mcode-cli", {
        operation_id: "op-known",
        task_id: "known",
        target: h.target,
        status: "running",
        controller_pid: 2147483647,
        pid: null,
      }),
    );
    const timer = setTimeout(
      () =>
        h.lord.store.updateOperation("op-known", (op) => ({
          ...op,
          status: "succeeded",
        })),
      120,
    );
    try {
      const [envelope, quiet] = await h.lord.checkpoint(["known"], 4, [
        "arriving",
      ]);
      expect(quiet).toBe(false);
      expect(envelope.actionable!.map((v) => v.task_id)).toEqual(["known"]);
      expect(envelope.starting![0]).toMatchObject({
        task_id: "arriving",
        phase: "not_observed",
      });
    } finally {
      clearTimeout(timer);
    }
  });
  it("accepts a starting id from the CLI and exits 124 while it is quiet", async () => {
    let out = "";
    const code = await main(
      ["checkpoint", "--starting-task-id", "arriving", "--seconds", "1"],
      (v) => {
        out += v;
      },
    );
    expect(code).toBe(124);
    const envelope = JSON.parse(out);
    expect(envelope.status).toBe("CHECKPOINT_QUIET");
    expect(envelope.starting[0]).toMatchObject({
      task_id: "arriving",
      phase: "not_observed",
      reason: "no_record_observed",
    });
  });
  it("waits for a real dispatch that has not journaled its operation yet", async () => {
    h.options({ delayMs: 200 });
    const prompt = file("prompt.txt", "work");
    const child = h.controller([
      "start",
      "--task-id",
      "spawning",
      "--provider",
      "mcode",
      "--model",
      "test/model",
      "--target",
      h.target,
      "--message-file",
      prompt,
    ]);
    try {
      const [envelope, quiet] = await h.lord.checkpoint(undefined, 8, [
        "spawning",
      ]);
      expect(quiet).toBe(false);
      expect(envelope.actionable![0]).toMatchObject({
        task_id: "spawning",
        status: "SUCCEEDED",
      });
      expect(envelope.starting![0].phase).not.toBe("not_observed");
    } finally {
      child.kill("SIGKILL");
      await waitFor(
        () => child.exitCode !== null || child.signalCode !== null,
        5000,
      );
    }
  }, 20000);
});
