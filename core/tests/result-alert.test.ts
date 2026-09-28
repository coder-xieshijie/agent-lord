import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Data } from "../src/contracts.js";
import { AgentLord } from "../src/engine.js";
import {
  type AlertChannel,
  alertChannels,
  watchResult,
} from "../src/result-alert.js";
import { TaskSets } from "../src/task-sets.js";
import { workflowNodes } from "../src/workflow-nodes.js";
import { harness, waitFor } from "./helpers.js";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness({ result_alert_seconds: 60 });
});
afterEach(() => h.cleanup());

const source = { kind: "pipeline", reference: "plan-to-implement" } as const;
const register = (taskId = "task") =>
  new TaskSets(h.lord).create(
    "run",
    [taskId],
    false,
    workflowNodes({ [taskId]: { role: "implementation-session", source } }),
  );
const events = (taskId = "task") =>
  readFileSync(path.join(h.root, "events", `${taskId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Data);
/** A channel that records what it would have sent, or fails. */
const channel = (name: string, sent: Data[], fail = false): AlertChannel => ({
  name,
  send: async (alert) => {
    if (fail) throw new Error(`${name} unavailable`);
    sent.push(alert);
  },
});
/** Time after the result ended, so the loop never actually sleeps. */
const later = (operationId: string, seconds: number) => () =>
  Date.parse(String(h.lord.store.operation(operationId).completed_at)) +
  seconds * 1000;

describe("unreceived-result alert", () => {
  it("alerts once when a run member's result stays unacknowledged", async () => {
    register();
    const done = await h.lord.start("task", "claude-cli", h.target, "work");
    const sent: Data[] = [];
    const alert = await watchResult(h.lord, String(done.operation_id), {
      now: later(String(done.operation_id), 61),
      channels: [channel("feishu", sent)],
    });
    expect(alert).toMatchObject({
      task_id: "task",
      status: "succeeded",
      run_ids: ["run"],
      alert_after_seconds: 60,
    });
    expect(String(alert!.message)).toContain("checkpoint --run-id run");
    expect(sent).toHaveLength(1);
    expect(events().map((e) => e.type)).toEqual(
      expect.arrayContaining(["result-unreceived", "result-alert-sent"]),
    );
  });
  it("waits out the window, then stays quiet once the result is acknowledged", async () => {
    register();
    const done = await h.lord.start("task", "claude-cli", h.target, "work");
    const id = String(done.operation_id);
    const [result] = await new TaskSets(h.lord).checkpoint("run", 1);
    const receipt = String(result.actionable![0].receipt);
    let slept = 0;
    const alert = await watchResult(h.lord, id, {
      now: later(id, 1),
      sleep: async (ms) => {
        slept += ms;
        new TaskSets(h.lord).ack("run", receipt);
      },
      channels: [channel("feishu", [], true)],
    });
    expect(alert).toBeNull();
    expect(slept).toBeGreaterThan(0);
  });
  it("does not watch a task outside every run, a continued task, or a disabled window", async () => {
    const lone = await h.lord.start("lone", "claude-cli", h.target, "work");
    const unexpected: Data[] = [];
    const channels = [channel("feishu", unexpected)];
    expect(
      await watchResult(h.lord, String(lone.operation_id), {
        now: later(String(lone.operation_id), 61),
        channels,
      }),
    ).toBeNull();
    register();
    const first = await h.lord.start("task", "claude-cli", h.target, "work");
    await h.lord.turn("task", "next");
    expect(
      await watchResult(h.lord, String(first.operation_id), {
        now: later(String(first.operation_id), 61),
        channels,
      }),
    ).toBeNull();
    const quiet = new AgentLord(h.root);
    (quiet.control as { result_alert_seconds: number }).result_alert_seconds =
      0;
    const last = h.lord.store.task("task").last_operation_id!;
    expect(
      await watchResult(quiet, last, { now: later(last, 61), channels }),
    ).toBeNull();
    expect(unexpected).toEqual([]);
  });
  it("records a failed alert command without losing the alert", async () => {
    register();
    vi.stubEnv("AGENT_LORD_RESULT_ALERT_COMMAND", "exit 3");
    const done = await h.lord.start("task", "claude-cli", h.target, "work");
    const alert = await watchResult(h.lord, String(done.operation_id), {
      now: later(String(done.operation_id), 61),
    });
    expect(alert).not.toBeNull();
    const failed = events().find((e) => e.type === "result-alert-failed");
    expect(String((failed!.data as Data).error)).toContain("exited with 3");
  });
  it("falls back to the next channel when Feishu fails", async () => {
    register();
    const done = await h.lord.start("task", "claude-cli", h.target, "work");
    const sent: Data[] = [];
    await watchResult(h.lord, String(done.operation_id), {
      now: later(String(done.operation_id), 61),
      channels: [channel("feishu", [], true), channel("macos", sent)],
    });
    expect(sent).toHaveLength(1);
    expect(
      events()
        .filter((e) => String(e.type).startsWith("result-alert-"))
        .map((e) => [e.type, (e.data as Data).channel]),
    ).toEqual([
      ["result-alert-failed", "feishu"],
      ["result-alert-sent", "macos"],
    ]);
  });
  it("prefers Feishu through lark-cli, then macOS; an explicit command replaces both", async () => {
    const bin = path.join(h.base, "bin");
    mkdirSync(bin);
    const log = path.join(h.base, "lark.log");
    writeFileSync(
      path.join(bin, "lark-cli"),
      `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$1" in
  auth) echo '{"identities":{"user":{"openId":"ou_owner"}}}' ;;
  *) echo '{"ok":true}' ;;
esac
`,
      { mode: 0o700 },
    );
    const env = { PATH: bin };
    expect(alertChannels("darwin", env).map((c) => c.name)).toEqual([
      "feishu",
      "macos",
    ]);
    expect(alertChannels("linux", env).map((c) => c.name)).toEqual(["feishu"]);
    expect(
      alertChannels("darwin", { PATH: h.base }).map((c) => c.name),
    ).toEqual(["macos"]);
    expect(alertChannels("linux", { PATH: h.base })).toEqual([]);
    await alertChannels("linux", env)[0].send({
      operation_id: "op-1",
      message: "task ended",
    });
    const [status, send] = readFileSync(log, "utf8").trim().split("\n");
    expect(status).toBe("auth status --json");
    expect(send).toMatch(
      /^im \+messages-send --as bot --user-id ou_owner --text task ended --idempotency-key al-[0-9a-f]{40}$/,
    );
    vi.stubEnv("AGENT_LORD_RESULT_ALERT_COMMAND", "true");
    expect(alertChannels("darwin", env).map((c) => c.name)).toEqual([
      "command",
    ]);
  });
  it("the detached worker delivers the alert through the configured command", async () => {
    h.cleanup();
    h = harness({ result_alert_seconds: 1 });
    const out = path.join(h.base, "alert.json");
    vi.stubEnv(
      "AGENT_LORD_RESULT_ALERT_COMMAND",
      `cat > ${JSON.stringify(out)}`,
    );
    register();
    const lord = new AgentLord(h.root, true);
    await lord.start("task", "claude-cli", h.target, "work", {
      workflow_run_id: "run",
    });
    await waitFor(
      () => existsSync(out) && readFileSync(out, "utf8").endsWith("\n"),
      15000,
    );
    const alert = JSON.parse(readFileSync(out, "utf8"));
    expect(alert).toMatchObject({ task_id: "task", run_ids: ["run"] });
  }, 20000);
});
