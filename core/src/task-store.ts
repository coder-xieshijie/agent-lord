#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { type Task } from "./contracts.js";
import {
  normalizeProvider,
  permissionPolicy,
  providerConfig,
  resolveExecutionDefaults,
  resolveRetryPlan,
  validateEffort,
} from "./config.js";
import { AgentLordError, usageError } from "./errors.js";
import { stringifyJson } from "./json.js";
import { StateStore, utcNow, validateIdentifier } from "./state.js";
import { validateSource } from "./workspace.js";
import {
  type CommandSpec,
  argumentsFor,
  helpFor,
  valueString,
} from "./arguments.js";
const COMMANDS: Record<string, CommandSpec> = {
  put: {
    description: "Register a pre-existing endpoint",
    strings: [
      "task-id",
      "provider",
      "endpoint-id",
      "host-id",
      "target",
      "model",
      "effort",
    ],
    booleans: ["read-only"],
    integers: ["retry-attempts"],
    required: ["task-id", "provider", "endpoint-id", "target"],
  },
  get: {
    description: "Read one endpoint",
    strings: ["task-id"],
    required: ["task-id"],
  },
  remove: {
    description: "Remove a closed or verified non-start endpoint",
    strings: ["task-id"],
    required: ["task-id"],
  },
  upgrade: {
    description: "Attach an explicit contract to a version 1 endpoint",
    strings: ["task-id", "model", "effort", "head-sha", "base-sha"],
    booleans: ["read-only"],
    integers: ["retry-attempts"],
    required: ["task-id", "model", "effort"],
  },
};
export function main(
  argv = process.argv.slice(2),
  write = (text: string) => {
    process.stdout.write(text);
  },
  writeError = (text: string) => {
    process.stderr.write(text);
  },
): number {
  try {
    const help = helpFor(argv, COMMANDS, "agent-lord-task-store");
    if (help) {
      write(help);
      return 0;
    }
    const { command, values: v } = argumentsFor(argv, COMMANDS);
    const get = (key: string) => valueString(v, key)!;
    const id = validateIdentifier("task_id", get("task-id"));
    const store = new StateStore();
    let task: Task;
    if (command === "get") task = store.task(id);
    else if (command === "remove") task = store.removeTask(id);
    else if (command === "put") {
      const provider = normalizeProvider(get("provider"));
      providerConfig(provider);
      for (const key of ["endpoint-id", "target"])
        if (!get(key) || get(key).includes("\0"))
          throw usageError(
            `${key.replaceAll("-", "_")} must be a non-empty string without NUL bytes`,
          );
      const [model, effort] = resolveExecutionDefaults(
        provider,
        get("model"),
        get("effort"),
      );
      const retries = resolveRetryPlan(
        provider,
        model,
        v["retry-attempts"] as number | undefined,
      );
      const host = get("host-id") ?? null;
      if ((provider === "codex-app") !== Boolean(host))
        throw usageError(
          provider === "codex-app"
            ? "host_id is required for provider codex-app"
            : "host_id is not accepted for CLI providers",
        );
      const now = utcNow();
      const readOnly = Boolean(v["read-only"]);
      const permission = permissionPolicy(provider, readOnly);
      task = store.createTask({
        version: 2,
        task_id: id,
        provider,
        endpoint_id: get("endpoint-id"),
        target: get("target"),
        route: {
          host_id: host,
          resolved_at: now,
          history: host
            ? [
                {
                  host_id: host,
                  observed_at: now,
                  reason: "manual-registration",
                },
              ]
            : [],
        },
        contract: {
          model,
          effort,
          read_only: readOnly,
          permission_mode: permission.mode,
          source: {},
          retry_plan: retries,
        },
        created_at: now,
        updated_at: now,
        last_operation_id: null,
      });
    } else {
      task = store.task(id);
      if (task.legacy_version !== 1)
        throw usageError("task record is already version 2");
      validateEffort(task.provider, get("effort"));
      const mode = permissionPolicy(task.provider, Boolean(v["read-only"]));
      const source = validateSource(get("head-sha"), get("base-sha"));
      const retries = resolveRetryPlan(
        task.provider,
        get("model"),
        v["retry-attempts"] as number | undefined,
      );
      task = store.updateTask(id, (value) => ({
        ...value,
        contract: {
          model: get("model"),
          effort: get("effort"),
          read_only: Boolean(v["read-only"]),
          permission_mode: mode.mode,
          source,
          retry_plan: retries,
        },
      }));
    }
    write(`${stringifyJson(task, 2)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof AgentLordError)) throw error;
    writeError(`error[${error.code}]: ${error.message}\n`);
    return error.exit_code;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main();
