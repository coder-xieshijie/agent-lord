import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";
import { AgentLord } from "../src/engine.js";
import {
  DEFAULT_CONFIG,
  permissionPolicy,
  resolveRetryPlan,
} from "../src/config.js";
import { type Data, type Operation, type Provider } from "../src/contracts.js";
import { canonicalPacketBytes } from "../src/handoff.js";
import { sha256 } from "../src/json.js";
import { utcNow } from "../src/state.js";
export async function waitFor(
  check: () => boolean,
  timeout = 6000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(20);
  }
}
export function operation(
  provider: Provider = "mcode-cli",
  overrides: Partial<Operation> = {},
): Operation {
  const model =
    provider === "mcode-cli"
      ? "test/model#deep"
      : provider === "claude-cli"
        ? "claude-opus-5"
        : "gpt-5.6-sol";
  const p = permissionPolicy(provider, false);
  const now = utcNow();
  return {
    version: 1,
    operation_id: "operation-1",
    task_id: "task-1",
    provider,
    kind: "start",
    target: "/tmp",
    status: "running",
    message: "authorized work",
    message_sha256: sha256("authorized work"),
    expected: {
      model,
      effort: provider === "mcode-cli" ? null : "high",
      permission_mode: p.mode,
      permission_enforcement: p.enforcement,
      retry_plan: resolveRetryPlan(provider, model),
      ...(provider === "mcode-cli" ? { continuation_limit: 2 } : {}),
    },
    observed: {},
    source: {},
    read_only: false,
    artifact: null,
    error: null,
    created_at: now,
    updated_at: now,
    resume: false,
    ...overrides,
  };
}
export function packet(taskId: string, overrides: Data = {}): Data {
  const body = {
    schema: "handoff-v1",
    handoff_id: "handoff-1",
    created_at: "2026-09-02T10:00:00+00:00",
    source_session: { kind: "codex-desktop" },
    continuation: { task_id: taskId },
    authorization: {
      task: "continue the authorized refactor",
      workspace_writes: true,
      external_writes: false,
    },
    objective: "finish the task",
    completed_work: ["existing implementation"],
    remaining_work: ["add tests"],
    constraints: ["no external writes"],
    acceptance_criteria: ["focused tests pass"],
    evidence: [{ path: "tracked.txt" }],
    sanitization: {
      raw_provider_logs: false,
      hidden_reasoning: false,
      secrets: false,
    },
    ...overrides,
  };
  return { ...body, integrity: { sha256: sha256(canonicalPacketBytes(body)) } };
}
export function harness(): {
  base: string;
  root: string;
  target: string;
  lord: AgentLord;
  options: (value: Data) => void;
  calls: () => Data[];
  initGit: () => string;
  git: (args: string[]) => string;
  controller: (args: string[]) => ChildProcess;
  cleanup: () => void;
} {
  const base = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "agent-lord-ts-")),
  );
  const root = path.join(base, "state");
  const target = path.join(base, "workspace");
  mkdirSync(target);
  const claudeConfig = path.join(base, "claude");
  mkdirSync(claudeConfig);
  const configFile = path.join(base, "providers.json");
  const config = JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"));
  Object.assign(config.control, {
    dead_process_result_grace_seconds: 1,
    claude_stall_seconds: 1,
    claude_tool_stall_seconds: 2,
    claude_terminate_grace_seconds: 1,
    mcode_terminate_grace_seconds: 1,
    claude_progress_poll_interval_ms: 50,
    mcode_progress_poll_interval_ms: 50,
  });
  writeFileSync(configFile, JSON.stringify(config));
  const optionsFile = path.join(base, "options.json");
  writeFileSync(optionsFile, "{}");
  const log = path.join(base, "calls.jsonl");
  vi.stubEnv("AGENT_LORD_STATE_DIR", root);
  vi.stubEnv("AGENT_LORD_PROVIDER_CONFIG", configFile);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeConfig);
  vi.stubEnv("FAKE_OPTIONS", optionsFile);
  vi.stubEnv("FAKE_LOG", log);
  for (const [provider, env] of [
    ["claude-cli", "AGENT_LORD_CLAUDE_BIN"],
    ["codex-cli", "AGENT_LORD_CODEX_BIN"],
    ["mcode-cli", "AGENT_LORD_MCODE_BIN"],
  ]) {
    const binary = path.join(base, `${provider}.mjs`);
    writeFileSync(
      binary,
      `#!${process.execPath}\nprocess.env.FAKE_PROVIDER = ${JSON.stringify(provider)};\nawait import(${JSON.stringify(new URL("./fixtures/provider.ts", import.meta.url).href)});\n`,
      { mode: 0o700 },
    );
    vi.stubEnv(env, binary);
  }
  const lord = new AgentLord(root);
  const children: ChildProcess[] = [];
  const git = (args: string[]) => {
    const result = spawnSync(
      "git",
      ["-C", target, "-c", "core.hooksPath=/dev/null", ...args],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  return {
    base,
    root,
    target,
    lord,
    options: (value) => writeFileSync(optionsFile, JSON.stringify(value)),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((v) => JSON.parse(v))
        : [],
    git,
    initGit: () => {
      git(["init", "-q"]);
      git(["config", "user.name", "Agent Lord Test"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "commit.gpgsign", "false"]);
      writeFileSync(path.join(target, "tracked.txt"), "source\n");
      git(["add", "tracked.txt"]);
      git(["commit", "-qm", "initial"]);
      git(["branch", "feat/source"]);
      return git(["rev-parse", "HEAD"]);
    },
    controller: (args) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          ...args,
        ],
        { stdio: "pipe", detached: process.platform !== "win32" },
      );
      children.push(child);
      return child;
    },
    cleanup: () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      for (const op of lord.store.operations()) {
        const command = op.provider_command;
        if (
          Array.isArray(command) &&
          String(command[0]).startsWith(base) &&
          typeof op.pid === "number"
        ) {
          try {
            process.kill(
              process.platform === "win32" || op.provider === "codex-cli"
                ? op.pid
                : -op.pid,
              "SIGKILL",
            );
          } catch {
            /* reaped */
          }
        }
      }
      rmSync(base, { recursive: true, force: true });
      vi.unstubAllEnvs();
    },
  };
}
