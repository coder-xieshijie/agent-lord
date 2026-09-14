#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { AgentLord } from "./engine.js";
import { TaskSets } from "./task-sets.js";
import { PlanRuns, planValidationEnvelope } from "./plan.js";
import { RequestInbox } from "./requests.js";
import { retryResultInvalid } from "./invalid-retry.js";
import { NATIVE_TERMINALS, openTaskTerminal } from "./terminal.js";
import { AgentLordError, usageError } from "./errors.js";
import { controlConfig } from "./config.js";
import { type Envelope, type StartOptions, PROVIDERS } from "./contracts.js";
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
      "invocation-file",
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
    booleans: ["require-commit", "read-only", "include-response"],
    integers: ["retry-attempts", "integration-order"],
    multiple: ["require-file", "require-input", "integration-worker"],
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
    strings: ["task-id", "message-file", "invocation-file"],
    booleans: ["require-commit", "include-response"],
    multiple: ["require-file", "require-input"],
    required: ["task-id", "message-file"],
  },
  recover: {
    description: "Consume one bounded same-session continuation action",
    strings: ["task-id", "operation-id", "invocation-file"],
    booleans: ["include-response"],
    required: ["task-id", "operation-id"],
  },
  "retry-invalid": {
    description:
      "Scripted Claude RESULT_INVALID retry with a persistent budget, fingerprint streak, and replacement lineage",
    strings: [
      "task-id",
      "operation-id",
      "replacement-task-id",
      "invocation-file",
    ],
    booleans: ["include-response"],
    required: ["task-id", "operation-id"],
  },
  handoff: {
    description:
      "Validate a handoff-v1 packet and start its continuation endpoint",
    strings: [
      "task-id",
      "packet-file",
      "invocation-file",
      "provider",
      "target",
      "model",
      "effort",
      "head-sha",
      "base-sha",
    ],
    booleans: ["read-only", "validate-only", "include-response"],
    integers: ["retry-attempts"],
    required: ["task-id", "packet-file"],
    choices: { provider: providers.filter((v) => v !== "codex-app") },
  },
  accept: {
    description: "Validate a Codex host-tool result",
    strings: ["action-id", "result-file"],
    booleans: ["auto-read", "include-response"],
    required: ["action-id", "result-file"],
  },
  check: {
    description: "Reconstruct one task's current state",
    strings: ["task-id"],
    booleans: ["include-response"],
    required: ["task-id"],
  },
  "run-create": {
    description: "Persist a passive task set before or after dispatch",
    strings: ["run-id"],
    multiple: ["task-id"],
    required: ["run-id", "task-id"],
  },
  "run-add": {
    description: "Explicitly add members to a task set",
    strings: ["run-id"],
    multiple: ["task-id"],
    required: ["run-id", "task-id"],
  },
  "run-status": {
    description: "Read task and delivery states without consuming results",
    strings: ["run-id"],
    required: ["run-id"],
  },
  "run-ack": {
    description: "Acknowledge a checkpoint receipt after receiving its result",
    strings: ["run-id", "receipt"],
    required: ["run-id", "receipt"],
  },
  "plan-validate": {
    description:
      "Validate an implementation-plan-v1 file without creating a run",
    strings: ["plan-file"],
    required: ["plan-file"],
  },
  "plan-create": {
    description: "Freeze a validated module plan into a durable plan run",
    strings: ["run-id", "plan-file"],
    required: ["run-id", "plan-file"],
  },
  "plan-status": {
    description:
      "Read the frozen plan, the uncapped ready set, barriers, and the journal",
    strings: ["run-id"],
    required: ["run-id"],
  },
  "plan-dispatch": {
    description: "Record one module endpoint against the dependency barrier",
    strings: ["run-id", "module-id", "task-id", "provider", "model"],
    required: ["run-id", "module-id", "task-id"],
  },
  "plan-deliver": {
    description: "Record one module's verified local delivery or failure",
    strings: ["run-id", "module-id", "state", "commit-sha", "note"],
    required: ["run-id", "module-id", "state"],
    choices: { state: ["delivered", "failed"] },
  },
  "plan-reset": {
    description: "Return a failed module to pending for a replacement endpoint",
    strings: ["run-id", "module-id", "reason"],
    required: ["run-id", "module-id"],
  },
  "plan-integrate": {
    description:
      "Open the single final integration endpoint after every module delivered",
    strings: ["run-id", "task-id", "provider", "model"],
    required: ["run-id", "task-id"],
  },
  "plan-merge-request": {
    description: "Record the one merge request for one plan repository",
    strings: ["run-id", "repo", "mr-url", "head-sha"],
    required: ["run-id", "repo", "mr-url"],
  },
  "plan-report": {
    description: "Close the run with a non-empty process report",
    strings: ["run-id", "report-file"],
    required: ["run-id", "report-file"],
  },
  checkpoint: {
    description: "Bounded foreground supervision; quiet output exits 124",
    strings: ["run-id"],
    multiple: ["task-id", "starting-task-id"],
    integers: ["seconds"],
    booleans: ["include-response"],
  },
  "request-add": {
    description:
      "Register one not-yet-dispatched instruction in the passive inbox",
    strings: [
      "request-id",
      "intent",
      "task-id",
      "message-file",
      "user-request-file",
      "source-kind",
      "source-session-id",
      "source-note",
      "provider",
      "target",
      "repo",
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
    multiple: ["require-file", "require-input", "integration-worker"],
    required: ["request-id", "intent", "task-id", "message-file"],
    choices: {
      intent: ["start", "turn"],
      provider: providers,
      "workspace-policy": ["reuse-or-create", "shared-readonly", "isolated"],
      "integration-role": ["worker", "integrator"],
      "codex-environment": ["worktree", "local"],
    },
  },
  "request-get": {
    description: "Read one registered request, including its full message",
    strings: ["request-id"],
    required: ["request-id"],
  },
  "request-list": {
    description: "Discover registered requests; filters are descriptive only",
    strings: [
      "status",
      "intent",
      "task-id",
      "source-kind",
      "source-session-id",
    ],
    choices: {
      status: ["pending", "dispatched", "cancelled"],
      intent: ["start", "turn"],
    },
  },
  "request-cancel": {
    description: "Cancel a request that has not been dispatched",
    strings: ["request-id", "reason"],
    required: ["request-id"],
  },
  "request-dispatch": {
    description:
      "Consume one request into a start or turn; stays pending when the target is busy",
    strings: ["request-id", "invocation-file"],
    booleans: ["include-response"],
    required: ["request-id"],
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
  "terminal-open": {
    description: "Open a task's saved native CLI Session in Orca or iTerm",
    strings: ["task-id", "terminal"],
    required: ["task-id", "terminal"],
    choices: { terminal: NATIVE_TERMINALS },
  },
};
function parsePlanFile(file: string): unknown {
  try {
    return parseJson(inputText(file));
  } catch (error) {
    if (error instanceof AgentLordError) throw error;
    throw usageError("plan-file must contain valid JSON");
  }
}
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
          "require-input": "required_inputs",
          "integration-worker": "integration_workers",
        }[key] ?? key.replaceAll("-", "_"),
        value,
      ]),
    ) as StartOptions;
    if (v["invocation-file"]) {
      try {
        opts.invocation = parseJson(inputText(get("invocation-file")));
      } catch (error) {
        if (error instanceof AgentLordError) throw error;
        throw usageError("invocation-file must contain valid JSON");
      }
    }
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
      result = await lord.recover(get("task-id"), get("operation-id"), opts);
    else if (command === "retry-invalid")
      result = await retryResultInvalid(
        lord,
        get("task-id"),
        get("operation-id"),
        {
          replacement_task_id:
            valueString(v, "replacement-task-id") ?? undefined,
          ...(opts.invocation !== undefined
            ? { invocation: opts.invocation }
            : {}),
        },
      );
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
    else if (["run-create", "run-add"].includes(command))
      result = new TaskSets(lord).create(
        get("run-id"),
        v["task-id"] as string[],
        command === "run-add",
      );
    else if (command === "run-status")
      result = new TaskSets(lord).status(get("run-id"));
    else if (command === "run-ack")
      result = new TaskSets(lord).ack(get("run-id"), get("receipt"));
    else if (command === "checkpoint") {
      const seconds =
        (v.seconds as number | undefined) ?? controlConfig().checkpoint_seconds;
      if (v["run-id"]) {
        if (v["task-id"] || v["starting-task-id"])
          throw usageError(
            "run-id cannot be combined with task-id or starting-task-id",
          );
        [result, quiet] = await new TaskSets(lord).checkpoint(
          get("run-id"),
          seconds,
        );
      } else
        [result, quiet] = await lord.checkpoint(
          v["task-id"] as string[] | undefined,
          seconds,
          v["starting-task-id"] as string[] | undefined,
        );
    } else if (command === "plan-validate")
      result = planValidationEnvelope(parsePlanFile(get("plan-file")));
    else if (command === "plan-create")
      result = new PlanRuns(lord).create(
        get("run-id"),
        parsePlanFile(get("plan-file")),
      );
    else if (command === "plan-status")
      result = new PlanRuns(lord).status(get("run-id"));
    else if (command === "plan-dispatch")
      result = new PlanRuns(lord).dispatch(
        get("run-id"),
        get("module-id"),
        get("task-id"),
        {
          provider: valueString(v, "provider"),
          model: valueString(v, "model"),
        },
      );
    else if (command === "plan-deliver")
      result = new PlanRuns(lord).deliver(
        get("run-id"),
        get("module-id"),
        get("state") as "delivered" | "failed",
        {
          commit_sha: valueString(v, "commit-sha"),
          note: valueString(v, "note"),
        },
      );
    else if (command === "plan-reset")
      result = new PlanRuns(lord).reset(
        get("run-id"),
        get("module-id"),
        valueString(v, "reason") ?? null,
      );
    else if (command === "plan-integrate")
      result = new PlanRuns(lord).integrate(get("run-id"), get("task-id"), {
        provider: valueString(v, "provider"),
        model: valueString(v, "model"),
      });
    else if (command === "plan-merge-request")
      result = new PlanRuns(lord).mergeRequest(
        get("run-id"),
        get("repo"),
        get("mr-url"),
        valueString(v, "head-sha") ?? null,
      );
    else if (command === "plan-report")
      result = new PlanRuns(lord).report(
        get("run-id"),
        get("report-file"),
        inputText(get("report-file")),
      );
    else if (command === "request-add") {
      const {
        request_id: _id,
        intent: _intent,
        task_id: _task,
        message_file: _message,
        user_request_file: _user,
        source_kind: _kind,
        source_session_id: _session,
        source_note: _note,
        provider: _provider,
        target: _target,
        repository: _repository,
        ...options
      } = opts as unknown as Record<string, unknown>;
      result = new RequestInbox(lord).register({
        request_id: get("request-id"),
        intent: get("intent"),
        task_id: get("task-id"),
        message: inputText(get("message-file")),
        user_request: v["user-request-file"]
          ? inputText(get("user-request-file"))
          : null,
        source: {
          kind: valueString(v, "source-kind") ?? null,
          session_id: valueString(v, "source-session-id") ?? null,
          note: valueString(v, "source-note") ?? null,
        },
        provider: valueString(v, "provider") ?? null,
        target: valueString(v, "target") ?? null,
        repository: valueString(v, "repo") ?? null,
        options,
      });
    } else if (command === "request-get")
      result = new RequestInbox(lord).get(get("request-id"));
    else if (command === "request-list")
      result = new RequestInbox(lord).list({
        status: valueString(v, "status"),
        intent: valueString(v, "intent"),
        task_id: valueString(v, "task-id"),
        source_kind: valueString(v, "source-kind"),
        source_session_id: valueString(v, "source-session-id"),
      });
    else if (command === "request-cancel")
      result = new RequestInbox(lord).cancel(
        get("request-id"),
        valueString(v, "reason"),
      );
    else if (command === "request-dispatch")
      result = await new RequestInbox(lord).dispatch(get("request-id"), {
        ...(opts.invocation !== undefined
          ? { invocation: opts.invocation }
          : {}),
      });
    else if (command === "terminal-open")
      result = openTaskTerminal(
        get("task-id"),
        get("terminal") as (typeof NATIVE_TERMINALS)[number],
        { store: lord.store },
      );
    else
      result = lord.exportArtifact(
        get("task-id"),
        get("operation-id"),
        get("source-file"),
        get("source-format"),
      );
    if (v["include-response"]) result = lord.withResponse(result as Envelope);
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
