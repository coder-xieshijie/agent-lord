#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { AgentLord } from "./engine.js";
import { AgentLordError, usageError } from "./errors.js";
import { controlConfig } from "./config.js";
import { type StartOptions, PROVIDERS } from "./contracts.js";
import { parseJson, stringifyJson } from "./json.js";
import {
  type CommandSpec,
  argumentsFor,
  helpFor,
  inputText,
  valueString,
} from "./arguments.js";
const providers = [...PROVIDERS, "codex", "mcode"];
export const COMMANDS: Record<string, CommandSpec> = {
  start: {
    description: "Create one durable endpoint",
    strings: [
      "task-id",
      "provider",
      "target",
      "repo",
      "message-file",
      "model",
      "effort",
      "head-sha",
      "base-sha",
      "source-branch",
      "workspace-policy",
      "workspace-branch",
      "worktree-root",
      "parallel-group",
      "integration-role",
      "integration-target-branch",
      "integrator-task-id",
      "codex-environment",
      "starting-branch",
    ],
    booleans: ["require-commit", "read-only"],
    integers: ["retry-attempts", "integration-order"],
    multiple: ["require-file", "integration-worker"],
    required: ["task-id", "provider", "message-file"],
    choices: {
      provider: providers,
      "workspace-policy": ["reuse-or-create", "shared-readonly", "isolated"],
      "integration-role": ["worker", "integrator"],
      "codex-environment": ["worktree", "local"],
    },
  },
  turn: {
    description: "Continue the exact saved endpoint",
    strings: ["task-id", "message-file"],
    booleans: ["require-commit"],
    multiple: ["require-file"],
    required: ["task-id", "message-file"],
  },
  recover: {
    description: "Consume one bounded same-session continuation action",
    strings: ["task-id", "operation-id"],
    required: ["task-id", "operation-id"],
  },
  handoff: {
    description:
      "Validate a handoff-v1 packet and start its continuation endpoint",
    strings: [
      "task-id",
      "packet-file",
      "provider",
      "target",
      "model",
      "effort",
      "head-sha",
      "base-sha",
    ],
    booleans: ["read-only", "validate-only"],
    integers: ["retry-attempts"],
    required: ["task-id", "packet-file"],
    choices: { provider: providers.filter((v) => v !== "codex-app") },
  },
  accept: {
    description: "Validate a Codex host-tool result",
    strings: ["action-id", "result-file"],
    booleans: ["auto-read"],
    required: ["action-id", "result-file"],
  },
  check: {
    description: "Reconstruct one task's current state",
    strings: ["task-id"],
    required: ["task-id"],
  },
  checkpoint: {
    description: "Bounded foreground supervision; quiet output exits 124",
    multiple: ["task-id"],
    integers: ["seconds"],
  },
  "export-artifact": {
    description:
      "Extract the last final assistant message from a provider JSONL",
    strings: ["task-id", "operation-id", "source-file", "source-format"],
    required: ["task-id", "operation-id", "source-file", "source-format"],
    choices: {
      "source-format": ["claude-jsonl", "codex-jsonl", "mcode-stream-json"],
    },
  },
};
export async function main(
  argv = process.argv.slice(2),
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<number> {
  try {
    const help = helpFor(argv, COMMANDS, "agent-lord");
    if (help) {
      write(help);
      return 0;
    }
    const { command, values: v } = argumentsFor(argv, COMMANDS);
    const get = (key: string) => valueString(v, key)!;
    const opts = Object.fromEntries(
      Object.entries(v).map(([key, value]) => [
        {
          repo: "repository",
          "require-file": "required_files",
          "integration-worker": "integration_workers",
        }[key] ?? key.replaceAll("-", "_"),
        value,
      ]),
    ) as StartOptions;
    // All parser and input validation happens before any dispatch.
    const lord = new AgentLord();
    let result;
    let quiet = false;
    if (command === "start") {
      if (Boolean(v.target) === Boolean(v.repo))
        throw usageError("exactly one of --target or --repo is required");
      result = await lord.start(
        get("task-id"),
        get("provider"),
        get("target") ?? null,
        inputText(get("message-file")),
        opts,
      );
    } else if (command === "turn")
      result = await lord.turn(
        get("task-id"),
        inputText(get("message-file")),
        opts,
      );
    else if (command === "recover")
      result = await lord.recover(get("task-id"), get("operation-id"));
    else if (command === "handoff")
      result = await lord.handoff(get("task-id"), get("packet-file"), {
        ...opts,
        provider: get("provider"),
        target: get("target"),
        validate_only: Boolean(v["validate-only"]),
      });
    else if (command === "accept") {
      const raw = inputText(get("result-file"));
      let value: unknown;
      try {
        value = parseJson(raw);
      } catch {
        value = raw;
      }
      result = lord.accept(get("action-id"), value, Boolean(v["auto-read"]));
    } else if (command === "check") result = lord.check(get("task-id"));
    else if (command === "checkpoint")
      [result, quiet] = await lord.checkpoint(
        v["task-id"] as string[] | undefined,
        (v.seconds as number | undefined) ?? controlConfig().checkpoint_seconds,
      );
    else
      result = lord.exportArtifact(
        get("task-id"),
        get("operation-id"),
        get("source-file"),
        get("source-format"),
      );
    write(`${stringifyJson(result, 2)}\n`);
    return quiet ? 124 : 0;
  } catch (error) {
    if (!(error instanceof AgentLordError)) throw error;
    write(
      `${stringifyJson({ version: 1, status: error.requires_authorization ? "NEEDS_DECISION" : "ERROR", error: error.asRecord() }, 2)}\n`,
    );
    return error.exit_code;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
