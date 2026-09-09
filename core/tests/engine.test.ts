import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { object, type Data, type Envelope } from "../src/contracts.js";
import { harness, packet, waitFor } from "./helpers.js";
import {
  operationMarker,
  ROUTE_STALE_FRAGMENT,
} from "../src/providers/codex-app.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
const actionId = (result: Envelope) => String(result.action!.action_id);
async function completeApp(id = "app"): Promise<Envelope> {
  const start = await h.lord.start(id, "codex-app", "project", "first");
  const accepted = h.lord.accept(
    actionId(start),
    { threadId: `thread-${id}`, hostId: "old-host" },
    true,
  );
  return h.lord.accept(actionId(accepted), {
    turns: [
      {
        items: [
          {
            role: "user",
            content: [
              { type: "text", text: operationMarker(start.operation_id!) },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "first report" }],
          },
        ],
      },
    ],
  });
}
describe("local CLI lifecycle", () => {
  it.each(["claude-cli", "codex", "mcode"])(
    "%s starts once, freezes contract, and resumes the same endpoint",
    async (provider) => {
      const opts = provider === "mcode" ? { model: "test/model#deep" } : {};
      const first = await h.lord.start(
        "task",
        provider,
        h.target,
        "first",
        opts,
      );
      expect(first.status).toBe("SUCCEEDED");
      expect(
        await h.lord.start("task", provider, h.target, "first", opts),
      ).toEqual(first);
      expect(h.calls()).toHaveLength(1);
      const contract = h.lord.store.task("task").contract;
      const second = await h.lord.turn("task", "second");
      expect(second.status).toBe("SUCCEEDED");
      expect(second.endpoint_id).toBe(first.endpoint_id);
      expect(h.lord.store.task("task").contract).toEqual(contract);
      expect(h.calls()).toHaveLength(2);
      expect(readFileSync(second.artifact!.path, "utf8")).toMatch(/final\n$/);
      const args = h.calls()[1].args as string[];
      expect(args).toContain(String(first.endpoint_id));
      expect(args).toContain(contract.model);
      if (provider === "codex") expect(args).toContain("--strict-config");
      if (provider === "mcode") {
        expect(args).toContain("full");
        expect(args).not.toContain("--effort");
      }
    },
  );
  it("same in-flight prompt is idempotent and a different prompt is rejected", async () => {
    h.options({ delayMs: 300 });
    const pending = h.lord.start("task", "codex", h.target, "first");
    await waitFor(() => h.calls().length === 1);
    const snapshot = await h.lord.start("task", "codex", h.target, "first");
    expect(snapshot.status).toBe("RUNNING");
    await expect(
      h.lord.start("task", "codex", h.target, "other"),
    ).rejects.toMatchObject({ code: "OPERATION_IN_FLIGHT" });
    expect((await pending).operation_id).toBe(snapshot.operation_id);
    expect(h.calls()).toHaveLength(1);
  });
  it("read-only arguments are enforced and MCode rejects unsupported read-only before launch", async () => {
    await h.lord.start("claude", "claude-cli", h.target, "review", {
      read_only: true,
    });
    expect(h.calls()[0].args).toContain("plan");
    await h.lord.start("codex", "codex", h.target, "review", {
      read_only: true,
    });
    expect(h.calls()[1].args).toContain('sandbox_mode="read-only"');
    await expect(
      h.lord.start("mcode", "mcode", h.target, "review", {
        model: "test/model",
        read_only: true,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_UNSUPPORTED" });
    expect(h.calls()).toHaveLength(2);
  });
  it.each([{ model: "bad" }, { model: "test/model", effort: "high" }])(
    "MCode rejects unenforceable contracts before launch: %j",
    async (opts) => {
      await expect(
        h.lord.start("task", "mcode", h.target, "work", opts),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(h.calls()).toHaveLength(0);
    },
  );
  it("MCode starts with the configured default and freezes its variant on continuation", async () => {
    const result = await h.lord.start("task", "mcode", h.target, "work");
    expect(result.status).toBe("SUCCEEDED");
    expect(object(result.observed)).toMatchObject({
      model: "custom_provider:mafia-claude/claude-fable-5",
      variant: "xhigh",
      variant_verification: "provider-metadata",
    });
    const file = path.join(h.base, "providers.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.providers["mcode-cli"].default_model = "test/other#low";
    writeFileSync(file, JSON.stringify(config));
    await h.lord.turn("task", "next");
    expect(h.calls()[1].args).toContain(
      "custom_provider:mafia-claude/claude-fable-5#xhigh",
    );
  });
  it("Claude retry uses a continuation query after ambiguous delivery", async () => {
    h.options({ failAttempts: 1, silent: true });
    const result = await h.lord.start(
      "task",
      "claude-cli",
      h.target,
      "perform original mutation",
      { retry_attempts: 2 },
    );
    expect(result.status).toBe("SUCCEEDED");
    const calls = h.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain("--resume");
    expect(calls[1].prompt).toContain("agent-lord-recovery:");
    expect(calls[1].prompt).not.toContain("perform original mutation");
  });
  it("Claude fallback keeps the original requested model and bounded history", async () => {
    h.options({ failAttempts: 2 });
    const result = await h.lord.start("task", "claude-cli", h.target, "work", {
      model: "fable",
      retry_attempts: 2,
    });
    expect(object(result.observed)).toMatchObject({
      attempts: 3,
      requested_model: "fable",
      fallback_used: true,
    });
    expect(h.lord.store.task("task").contract.model).toBe("fable");
  });
  it("Claude exhausts its retry budget without publishing a handle", async () => {
    h.options({ failAll: true });
    await expect(
      h.lord.start("task", "claude-cli", h.target, "work", {
        model: "claude-opus-5",
        retry_attempts: 2,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
      retryable: false,
      details: { retry_exhausted: true },
    });
    expect(h.calls()).toHaveLength(2);
    expect(h.lord.store.hasTask("task")).toBe(false);
  });
  it("Claude auxiliary model failures do not cause retries", async () => {
    h.options({ auxiliaryWarning: true });
    const result = await h.lord.start("task", "claude-cli", h.target, "work");
    expect(result.status).toBe("SUCCEEDED");
    expect(result.warnings).toEqual([
      {
        code: "AUXILIARY_MODEL_UNRECOGNIZED",
        source: "auto_mode",
        model: "auxiliary-model",
      },
    ]);
    expect(h.calls()).toHaveLength(1);
  });
  it("MCode retains its session on model mismatch and never publishes an artifact", async () => {
    h.options({ wrongModel: "other" });
    await expect(
      h.lord.start("task", "mcode", h.target, "work", { model: "test/model" }),
    ).rejects.toMatchObject({ code: "MODEL_MISMATCH" });
    expect(h.lord.store.task("task").endpoint_id).toBe("mcode-session");
    expect(h.lord.store.operations()[0].artifact).toBeNull();
  });
  it("MCode continuation is bounded, frozen and idempotent", async () => {
    h.options({ status: "timeout", retryable: true });
    await expect(
      h.lord.start("task", "mcode", h.target, "original", {
        model: "test/model",
      }),
    ).rejects.toMatchObject({ safe_recovery: "CONTINUE_SAME_SESSION" });
    const first = h.lord.store.operations()[0];
    h.options({});
    const next = await h.lord.recover("task", first.operation_id);
    expect(next.status).toBe("SUCCEEDED");
    expect(next.endpoint_id).toBe("mcode-session");
    expect(object(next.continuation).attempt).toBe(1);
    expect(h.calls()[1].prompt).toContain("agent-lord-continuation:");
    expect(h.calls()[1].prompt).not.toContain("original\n");
    expect(await h.lord.recover("task", first.operation_id)).toEqual(next);
    expect(h.calls()).toHaveLength(2);
  });
  it("MCode continuation budget exhausts after two child operations", async () => {
    h.options({ status: "failed", retryable: true });
    await expect(
      h.lord.start("task", "mcode", h.target, "work", { model: "test/model" }),
    ).rejects.toMatchObject({ safe_recovery: "CONTINUE_SAME_SESSION" });
    for (let i = 0; i < 2; i++) {
      const parent = h.lord.store.task("task").last_operation_id!;
      await expect(h.lord.recover("task", parent)).rejects.toMatchObject({
        code: "PROVIDER_FAILED",
      });
    }
    const last = h.lord.store.operation(
      h.lord.store.task("task").last_operation_id!,
    );
    expect(last.error?.safe_recovery).not.toBe("CONTINUE_SAME_SESSION");
    await expect(
      h.lord.recover("task", last.operation_id),
    ).rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
    expect(h.calls()).toHaveLength(3);
  });
  it.each(["cancelled", "limit_exceeded"])(
    "MCode %s never authorizes automatic continuation",
    async (status) => {
      h.options({ status, retryable: true });
      await expect(
        h.lord.start("task", "mcode", h.target, "work", {
          model: "test/model",
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_FAILED", retryable: false });
      expect(h.calls()).toHaveLength(1);
    },
  );
  it("delivery evidence remains separate from execution success", async () => {
    const result = await h.lord.start("task", "codex", h.target, "work", {
      required_files: ["missing.txt"],
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.delivery).toMatchObject({
      status: "incomplete",
      checks: [{ kind: "file", path: "missing.txt", ok: false }],
    });
  });
});
describe("Codex App actions", () => {
  it("create/read/send keep endpoint identity and repeated receipts cannot dispatch twice", async () => {
    const first = await completeApp();
    expect(first.status).toBe("SUCCEEDED");
    const turn = await h.lord.turn("app", "next");
    expect(object(turn.action!.arguments)).toMatchObject({
      threadId: "thread-app",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    const reply = h.lord.accept(
      actionId(turn),
      { threadId: "thread-app", hostId: "new-host" },
      true,
    );
    expect(
      h.lord.accept(
        actionId(turn),
        { threadId: "wrong", hostId: "other" },
        true,
      ),
    ).toEqual(reply);
    expect(h.lord.store.task("app").route.host_id).toBe("new-host");
  });
  it("stale routes rediscover the same thread and reuse the exact prepared prompt", async () => {
    await completeApp();
    const turn = await h.lord.turn("app", "next");
    const prompt = object(turn.action!.arguments).prompt;
    const list = h.lord.accept(actionId(turn), { error: ROUTE_STALE_FRAGMENT });
    const send = h.lord.accept(actionId(list), {
      threads: [{ threadId: "thread-app", hostId: "new-host" }],
    });
    expect(object(send.action!.arguments)).toMatchObject({
      threadId: "thread-app",
      hostId: "new-host",
      prompt,
    });
  });
  it("route listing retries are bounded", async () => {
    await completeApp();
    const turn = await h.lord.turn("app", "next");
    let result = h.lord.accept(actionId(turn), { error: ROUTE_STALE_FRAGMENT });
    for (let i = 0; i < 2; i++) {
      result = h.lord.accept(actionId(result), { error: "temporary timeout" });
      expect(result.status).toBe("ACTION_REQUIRED");
    }
    result = h.lord.accept(actionId(result), { error: "temporary timeout" });
    expect(result.status).toBe("ERROR");
    expect(result.error!.code).toBe("PROVIDER_FAILED");
  });
  it("ambiguous send reads before any resend and absent marker requires a decision", async () => {
    await completeApp();
    const turn = await h.lord.turn("app", "next");
    const check = h.lord.accept(actionId(turn), { error: "timeout" });
    expect(check.action!.tool).toBe("codex_app__read_thread");
    const result = h.lord.accept(actionId(check), { turns: [] });
    expect(result.status).toBe("NEEDS_DECISION");
    expect(result.error!.code).toBe("DELIVERY_UNKNOWN");
  });
  it("missing original endpoint is not replaced", async () => {
    await completeApp();
    const turn = await h.lord.turn("app", "next");
    const list = h.lord.accept(actionId(turn), { error: ROUTE_STALE_FRAGMENT });
    const result = h.lord.accept(actionId(list), { threads: [] });
    expect(result.error!.code).toBe("ENDPOINT_GONE");
    expect(result.status).toBe("NEEDS_DECISION");
  });
  it("queued create IDs and wrong-thread receipts are rejected", async () => {
    const start = await h.lord.start("queued", "codex-app", "project", "work");
    expect(
      h.lord.accept(actionId(start), {
        clientThreadId: "pending",
        hostId: "local",
      }).error!.code,
    ).toBe("RESULT_INVALID");
    await completeApp();
    const turn = await h.lord.turn("app", "next");
    expect(
      h.lord.accept(actionId(turn), { threadId: "wrong", hostId: "local" })
        .error!.code,
    ).toBe("ENDPOINT_MISMATCH");
  });
  it("auto-read is opt in and incomplete reads stay running", async () => {
    const start = await h.lord.start("app", "codex-app", "project", "work");
    const ack = h.lord.accept(actionId(start), {
      threadId: "thread-app",
      hostId: "local",
    });
    expect(ack.action).toBeUndefined();
    const read = h.lord.check("app");
    const next = h.lord.accept(actionId(read), { turns: [] }, true);
    expect(next.status).toBe("ACTION_REQUIRED");
    expect(next.action!.tool).toBe("codex_app__read_thread");
  });
});
describe("handoff", () => {
  it.each(["codex-cli", "claude-cli", "mcode-cli"])(
    "%s starts a new endpoint with stable lineage and replay digest",
    async (provider) => {
      const head = h.initGit();
      writeFileSync(path.join(h.target, "tracked.txt"), "unfinished work\n");
      const file = path.join(h.base, "packet.json");
      const body = packet("continuation", {
        contract_request: {
          provider,
          ...(provider === "mcode-cli" ? { model: "test/model" } : {}),
        },
      });
      writeFileSync(file, JSON.stringify(body));
      const result = await h.lord.handoff("continuation", file, {
        target: h.target,
        head_sha: head,
      });
      expect(result.status).toBe("SUCCEEDED");
      expect(object(result.handoff).relationship).toBe("continues_user_task");
      expect(object(object(result.handoff).workspace_snapshot).dirty).toBe(
        true,
      );
      expect(h.lord.store.task("continuation").lineage).toMatchObject({
        kind: "handoff",
        source_session_identity: "unavailable",
      });
      expect(
        await h.lord.handoff("continuation", file, {
          target: h.target,
          head_sha: head,
        }),
      ).toEqual(result);
      expect(h.calls()).toHaveLength(1);
      expect((await h.lord.turn("continuation", "next")).endpoint_id).toBe(
        result.endpoint_id,
      );
    },
  );
  it("validate-only records no operation or task", async () => {
    const file = path.join(h.base, "packet.json");
    writeFileSync(file, JSON.stringify(packet("task")));
    const result = await h.lord.handoff("task", file, {
      provider: "codex",
      validate_only: true,
    });
    expect(result.operation_id).toBeUndefined();
    expect(h.lord.store.operations()).toHaveLength(0);
    expect(existsSync(path.join(h.root, "task.json"))).toBe(false);
  });
  it("packet binding and permission conflicts cause no dispatch", async () => {
    const file = path.join(h.base, "packet.json");
    writeFileSync(file, JSON.stringify(packet("task")));
    await expect(
      h.lord.handoff("wrong", file, { provider: "codex", target: h.target }),
    ).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await expect(
      h.lord.handoff("task", file, {
        provider: "codex",
        target: h.target,
        read_only: true,
      }),
    ).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    expect(h.calls()).toHaveLength(0);
  });
});
