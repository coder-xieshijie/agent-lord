import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { main } from "../src/cli.js";
import { resolveInvocation } from "../src/invocation.js";
import { runChild } from "../src/process.js";
import { harness } from "./helpers.js";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
  vi.stubEnv("CODEX_THREAD_ID", "fixture-caller-1");
  vi.stubEnv("CODEX_TURN_ID", "");
  vi.stubEnv("CODEX_HOME", path.join(h.base, "codex"));
});
afterEach(() => h.cleanup());

describe("caller context and one-read terminal delivery", () => {
  it("records verbatim user and dispatched requests, keeps callers per operation, and returns the canonical final text", async () => {
    const message = path.join(h.base, "message.txt");
    const context = path.join(h.base, "invocation.json");
    const original = "用户原话：所有网络都不受限制。\n保留第二行。";
    writeFileSync(message, "A compact delegated task");
    writeFileSync(context, JSON.stringify({ user_request: original }));
    let output = "";
    const code = await main(
      [
        "start",
        "--task-id",
        "fixture-task",
        "--provider",
        "mcode",
        "--model",
        "test/model#deep",
        "--target",
        h.target,
        "--message-file",
        message,
        "--invocation-file",
        context,
        "--include-response",
      ],
      (text) => {
        output += text;
      },
    );
    expect(code).toBe(0);
    const first = JSON.parse(output);
    expect(first.response.text).toBe(readFileSync(first.artifact.path, "utf8"));
    expect(first.provider_return_code).toBe(0);
    expect(first.invocation).toMatchObject({
      caller: {
        kind: "codex",
        session_id: "fixture-caller-1",
        turn_id: null,
        identity_source: "runtime-env",
      },
      user_request: original,
      trigger: "user_request",
    });
    const op = h.lord.store.operation(first.operation_id);
    expect(op.message).toBe("A compact delegated task");
    const contract = h.lord.store.task("fixture-task").contract;
    const next = await h.lord.turn(
      "fixture-task",
      "Complete the omitted requirement",
      {
        invocation: {
          caller: { kind: "codex", session_id: "fixture-caller-2" },
          trigger: "caller_followup",
          reason: "旧 deny 配置处理缺失",
        },
      },
    );
    expect(h.lord.store.operation(next.operation_id!).invocation).toMatchObject(
      {
        caller: {
          session_id: "fixture-caller-2",
          identity_source: "caller-declared",
        },
        trigger: "caller_followup",
        user_request: null,
      },
    );
    expect(
      h.lord.store.operation(first.operation_id).invocation?.caller.session_id,
    ).toBe("fixture-caller-1");
    expect(h.lord.store.task("fixture-task").contract).toEqual(contract);
    const batch = h.lord.withResponse({
      version: 1,
      status: "CHECKPOINT_ACTIONABLE",
      actionable: [next],
    });
    expect(batch.actionable![0].response).toHaveProperty("text");
  });

  it("never fills another declared caller with the current host identity and keeps missing identities honest", () => {
    expect(resolveInvocation({ caller: { kind: "human" } }).caller).toEqual({
      kind: "human",
      session_id: null,
      turn_id: null,
      identity_source: "unavailable",
    });
    expect(resolveInvocation(undefined, false, {}).caller.identity_source).toBe(
      "unavailable",
    );
    expect(
      resolveInvocation({ trigger: "caller_followup", reason: "retry" }, true)
        .trigger,
    ).toBe("recovery");
  });

  it("does not leak parent caller ids into a provider process or mutate its configured environment", async () => {
    const stdout = path.join(h.base, "child.stdout");
    const env = {
      ...process.env,
      CODEX_SESSION_ID: "parent-session",
      CODEX_TURN_ID: "parent-turn",
      AGENT_LORD_FIXTURE_ROUTE: "retained",
    };
    const keys = [
      "CODEX_THREAD_ID",
      "CODEX_SESSION_ID",
      "CODEX_TURN_ID",
      "CODEX_HOME",
      "AGENT_LORD_FIXTURE_ROUTE",
    ];
    const code = await runChild({
      command: [
        process.execPath,
        "-e",
        `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))))`,
      ],
      target: h.target,
      prompt: "fixture",
      stdout,
      stderr: path.join(h.base, "child.stderr"),
      root: h.root,
      env,
      detached: false,
      launched: () => {},
      notDelivered: () => {},
      exited: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(stdout, "utf8"))).toEqual({
      CODEX_THREAD_ID: null,
      CODEX_SESSION_ID: null,
      CODEX_TURN_ID: null,
      CODEX_HOME: process.env.CODEX_HOME,
      AGENT_LORD_FIXTURE_ROUTE: "retained",
    });
    expect(env.CODEX_SESSION_ID).toBe("parent-session");
    expect(process.env.CODEX_THREAD_ID).toBe("fixture-caller-1");
  });

  it.each([
    { caller: { kind: "codex", session_id: "../../other" } },
    { caller: { kind: "codex", turn_id: "turn-without-session" } },
    { caller: { kind: "codex", session_id: "fixture", data_root: "relative" } },
    { caller: { kind: "codex", identity_source: "runtime-env" } },
    { trigger: "pretend-completed" },
    { user_request: "" },
    { raw_reasoning: "not supported" },
  ])(
    "rejects invalid metadata before starting an endpoint: %j",
    async (invocation) => {
      await expect(
        h.lord.start("fixture-invalid", "mcode", h.target, "work", {
          model: "test/model",
          invocation,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(h.calls()).toHaveLength(0);
    },
  );

  it("does not change execution success when final text integrity fails or its path escapes", async () => {
    const result = await h.lord.start(
      "fixture-artifact",
      "mcode",
      h.target,
      "work",
      { model: "test/model" },
    );
    const saved = readFileSync(result.artifact!.path);
    writeFileSync(result.artifact!.path, "tampered");
    expect(() => h.lord.withResponse(result)).toThrow(
      "canonical final response",
    );
    expect(h.lord.check("fixture-artifact").status).toBe("SUCCEEDED");
    const other = path.join(h.base, "outside.md");
    writeFileSync(other, saved);
    unlinkSync(result.artifact!.path);
    symlinkSync(other, result.artifact!.path);
    expect(() => h.lord.withResponse(result)).toThrow(
      "canonical final response",
    );
  });

  it("does not overwrite invocation on an idempotent repeated start", async () => {
    const first = await h.lord.start(
      "fixture-once",
      "mcode",
      h.target,
      "work",
      { model: "test/model" },
    );
    vi.stubEnv("CODEX_THREAD_ID", "fixture-other-caller");
    const repeated = await h.lord.start(
      "fixture-once",
      "mcode",
      h.target,
      "work",
      { model: "test/model" },
    );
    expect(repeated).toEqual(first);
    expect(h.calls()).toHaveLength(1);
  });
});
