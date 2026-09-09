import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  claudeChildEnvironment,
  controlConfig,
  expectedModelMatches,
  parseMcodeModel,
  permissionModePolicy,
  resolveExecutionDefaults,
  resolveRetryPlan,
} from "../src/config.js";
import { canonicalPacketBytes, validateHandoffPacket } from "../src/handoff.js";
import { type Data } from "../src/contracts.js";
import { harness, packet } from "./helpers.js";
let h: ReturnType<typeof harness>;
function useClaudeDefaults(source: string): void {
  const file = path.join(h.base, "providers.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.providers["claude-cli"].default_resolution.source = source;
  writeFileSync(file, JSON.stringify(config));
}
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
describe("frozen configuration", () => {
  it.each([
    [{}, undefined, undefined, ["claude-fable-5", "xhigh"]],
    [
      { model: "fable", effortLevel: "xhigh" },
      undefined,
      undefined,
      ["fable", "xhigh"],
    ],
    [
      { model: "fable", effortLevel: "xhigh" },
      "opus",
      undefined,
      ["opus", "xhigh"],
    ],
    [
      { model: "fable", effortLevel: "xhigh" },
      undefined,
      "low",
      ["fable", "low"],
    ],
    [{ model: "fable", effortLevel: "xhigh" }, "opus", "max", ["opus", "max"]],
    [
      { model: "   ", effortLevel: "   " },
      undefined,
      undefined,
      ["claude-fable-5", "xhigh"],
    ],
  ] as const)(
    "resolves model and effort independently: %j",
    (settings, model, effort, expected) => {
      useClaudeDefaults("claude-user-settings");
      writeFileSync(
        path.join(h.base, "claude", "settings.json"),
        JSON.stringify(settings),
      );
      expect(resolveExecutionDefaults("claude-cli", model, effort)).toEqual(
        expected,
      );
    },
  );
  it.each([
    [undefined, undefined, ["claude-fable-5", "xhigh"]],
    ["opus", undefined, ["opus", "xhigh"]],
    [undefined, "low", ["claude-fable-5", "low"]],
    ["opus", "max", ["opus", "max"]],
  ] as const)(
    "provider defaults override user settings while explicit fields win: %j %j",
    (model, effort, expected) => {
      writeFileSync(
        path.join(h.base, "claude", "settings.json"),
        JSON.stringify({ model: "sonnet", effortLevel: "medium" }),
      );
      expect(resolveExecutionDefaults("claude-cli", model, effort)).toEqual(
        expected,
      );
    },
  );
  it("uses Codex CLI defaults independently of Codex App", () => {
    expect(resolveExecutionDefaults("codex-cli")).toEqual([
      "gpt-6-astra",
      "xhigh",
    ]);
    expect(resolveExecutionDefaults("codex-app")).toEqual([
      "gpt-5.6-sol",
      "high",
    ]);
    expect(resolveExecutionDefaults("codex-cli", "gpt-5.6-sol", "low")).toEqual(
      ["gpt-5.6-sol", "low"],
    );
  });
  it("resolves a qualified MCode default and preserves explicit models and variants", () => {
    expect(resolveExecutionDefaults("mcode-cli")).toEqual([
      "custom_provider:mafia-claude/claude-fable-5#xhigh",
      null,
    ]);
    expect(resolveExecutionDefaults("mcode-cli", "test/model#deep")).toEqual([
      "test/model#deep",
      null,
    ]);
    expect(resolveExecutionDefaults("mcode-cli", "test/model")).toEqual([
      "test/model",
      null,
    ]);
    expect(() =>
      resolveExecutionDefaults("mcode-cli", undefined, "xhigh"),
    ).toThrow();
    expect(() => resolveExecutionDefaults("mcode-cli", "")).toThrow();
    const file = path.join(h.base, "providers.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.providers["mcode-cli"].default_model = null;
    writeFileSync(file, JSON.stringify(config));
    expect(() => resolveExecutionDefaults("mcode-cli")).toThrow();
  });
  it("only settings-owned model/effort environment variables are removed from a child", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "stale");
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "low");
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://test.invalid");
    writeFileSync(
      path.join(h.base, "claude", "settings.json"),
      JSON.stringify({ model: "fable", effortLevel: "high" }),
    );
    const env = claudeChildEnvironment();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://test.invalid");
    expect(process.env.ANTHROPIC_MODEL).toBe("stale");
  });
  it("turns keep model/effort and permission mode despite changing defaults", async () => {
    useClaudeDefaults("claude-user-settings");
    writeFileSync(
      path.join(h.base, "claude", "settings.json"),
      JSON.stringify({ model: "fable", effortLevel: "high" }),
    );
    await h.lord.start("task", "claude-cli", h.target, "work");
    writeFileSync(
      path.join(h.base, "claude", "settings.json"),
      JSON.stringify({ model: "opus", effortLevel: "low" }),
    );
    const file = path.join(h.base, "providers.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.providers["claude-cli"].permissions.default = "read_only";
    writeFileSync(file, JSON.stringify(config));
    await h.lord.turn("task", "next");
    expect(h.calls()[1].args).toContain("fable");
    expect(h.calls()[1].args).toContain("high");
    expect(h.calls()[1].args).toContain("--dangerously-skip-permissions");
  });
  it.each([
    undefined,
    "",
    "model",
    "a/",
    "/b",
    "a/#b",
    "a/b#",
    "a/b#x#y",
    "a#x/b",
    "a/b c",
    "a/b\n",
  ])("refuses ambiguous MCode model %j", (value) =>
    expect(() => parseMcodeModel(value)).toThrow(),
  );
  it.each(["test/model", "test/model#deep", "test/model/version#deep"])(
    "accepts literal MCode model %s",
    (value) => expect(parseMcodeModel(value).provider_id).toBe("test"),
  );
  it("retry override changes only the primary Claude stage", () => {
    expect(resolveRetryPlan("claude-cli", "fable", 2)).toEqual([
      { model: "fable", attempts: 2 },
      { model: "claude-opus-5", attempts: 5 },
    ]);
    expect(() => resolveRetryPlan("codex-cli", "gpt-5.6-sol", 2)).toThrow();
    expect(() => resolveRetryPlan("claude-cli", "opus", 0)).toThrow();
  });
  it("legacy configurations receive supervision defaults and checkpoint keeps 150 seconds", () => {
    const file = path.join(h.base, "providers.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    delete config.control.claude_stall_seconds;
    delete config.control.mcode_progress_poll_interval_ms;
    writeFileSync(file, JSON.stringify(config));
    expect(controlConfig()).toMatchObject({
      checkpoint_seconds: 150,
      claude_stall_seconds: 900,
      mcode_progress_poll_interval_ms: 100,
    });
  });
  it("model aliases permit versioned IDs without accepting another version", () => {
    expect(expectedModelMatches("opus[1m]", "claude-opus-5")).toBe(true);
    expect(
      expectedModelMatches("claude-opus-5", "claude-opus-5-20260101"),
    ).toBe(true);
    expect(expectedModelMatches("claude-opus-5", "claude-opus-6")).toBe(false);
  });
});
describe("handoff-v1 trust boundary", () => {
  it.each([
    ["schema", "other"],
    ["handoff_id", "../escape"],
    ["created_at", "not-a-date"],
    ["source_session", { kind: "Invalid Kind" }],
    ["objective", ""],
    ["objective", "x\0y"],
    ["objective", "\ud800"],
    ["objective", "x".repeat(8193)],
    ["remaining_work", Array(65).fill("work")],
    ["remaining_work", [false]],
    [
      "authorization",
      { task: "work", workspace_writes: "yes", external_writes: false },
    ],
    [
      "sanitization",
      { raw_provider_logs: false, hidden_reasoning: true, secrets: false },
    ],
    ["evidence", [{ path: "../escape" }]],
    ["evidence", [{ path: "/absolute" }]],
    ["evidence", [{ path: "a\\b" }]],
    ["evidence", [{ path: "file", sha256: "bad" }]],
    ["contract_request", { provider: "codex-app" }],
    ["unexpected", true],
    ["objective", "token sk-abcdefghijklmnopqrstuvwxyz"],
  ] as [string, unknown][])("rejects %s=%j", (key, value) =>
    expect(() =>
      validateHandoffPacket(packet("task", { [key]: value })),
    ).toThrow(),
  );
  it("detects content tampering even when the JSON remains valid", () => {
    const p = packet("task");
    p.objective = "different task";
    expect(() => validateHandoffPacket(p)).toThrow(/integrity digest/);
  });
  it("canonical UTF-8 bytes preserve supplementary characters and Python key ordering", () => {
    expect(
      canonicalPacketBytes({
        "\u{10000}": "中文",
        "\ue000": "é",
        a: "\u2028",
      }).toString("utf8"),
    ).toBe('{"a":"\u2028","\ue000":"é","\u{10000}":"中文"}\n');
  });
});
