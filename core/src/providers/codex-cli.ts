import path from "node:path";
import { statSync } from "node:fs";
import {
  type Data,
  type Operation,
  type ProviderResult,
  string,
} from "../contracts.js";
import { permissionModePolicy, providerBinary } from "../config.js";
import { AgentLordError } from "../errors.js";
import { jsonLines } from "../artifacts.js";
import { StateStore } from "../state.js";
import { readText, runChild } from "../process.js";
import { markedMessage } from "./codex-app.js";
export function validateCodexOutput(
  stdout: string,
  stderr: string,
  finalText: string,
  op: Operation,
): ProviderResult {
  const events = jsonLines(stdout);
  const id = events
    .filter((v) => v.type === "thread.started")
    .map((v) => string(v.thread_id))
    .filter(Boolean)
    .at(-1);
  if (!id)
    throw new AgentLordError(
      "RESULT_INVALID",
      "Codex CLI output contains no thread.started session identity",
      {
        retryable: true,
        safe_recovery: "RETRY_SAME_COMMAND",
        details: { stderr_tail: stderr.slice(-500) },
      },
    );
  if (op.resume && op.endpoint_id && id !== op.endpoint_id)
    throw new AgentLordError(
      "ENDPOINT_MISMATCH",
      "Codex CLI result belongs to a different session",
      { details: { expected: op.endpoint_id, observed: id } },
    );
  const recovery = op.resume ? "RETRY_SAME_ENDPOINT" : "RETRY_SAME_COMMAND";
  const error = [...events]
    .reverse()
    .find((v) => v.type === "error" || v.type === "turn.failed");
  if (
    (op.provider_return_code != null && op.provider_return_code !== 0) ||
    error
  )
    throw new AgentLordError(
      "PROVIDER_FAILED",
      "Codex CLI exited without a successful turn",
      {
        retryable: true,
        safe_recovery: recovery,
        details: {
          return_code: op.provider_return_code ?? null,
          provider_error: error ?? null,
          endpoint_id: id,
          stderr_tail: stderr.slice(-500),
        },
      },
    );
  if (!events.some((v) => v.type === "turn.completed"))
    throw new AgentLordError(
      "RESULT_INVALID",
      "Codex CLI output contains no turn.completed event",
      {
        retryable: true,
        safe_recovery: recovery,
        details: { endpoint_id: id, stderr_tail: stderr.slice(-500) },
      },
    );
  if (!finalText.trim())
    throw new AgentLordError(
      "RESULT_INVALID",
      "Codex CLI produced no final assistant message",
      {
        retryable: true,
        safe_recovery: recovery,
        details: { endpoint_id: id },
      },
    );
  const { model, effort, permission_mode } = op.expected;
  const permission = permissionModePolicy("codex-cli", permission_mode);
  return {
    endpoint_id: id,
    assistant_text: finalText.trim(),
    model,
    effort,
    observed: {
      models: model ? [model] : [],
      model_verification: model ? "argument-enforced" : "not-requested",
      effort,
      effort_verification: effort
        ? "config-argument-enforced"
        : "not-requested",
      permission_mode,
      permission_enforcement: permission.enforcement,
    },
  };
}
export function recoverCodex(op: Operation): ProviderResult {
  const paths = [op.stdout_path, op.stderr_path, op.result_path];
  if (!paths.every((v) => typeof v === "string"))
    throw new AgentLordError(
      "RESULT_INVALID",
      "Codex CLI operation journal lacks provider log paths",
    );
  const result = validateCodexOutput(
    readText(paths[0] as string),
    readText(paths[1] as string),
    readText(paths[2] as string, true),
    op,
  );
  return {
    ...result,
    command: op.provider_command ?? [],
    stdout_path: paths[0],
    stderr_path: paths[1],
    result_path: paths[2],
  };
}
export async function runCodex(
  store: StateStore,
  op: Operation,
): Promise<ProviderResult> {
  try {
    if (!statSync(op.target).isDirectory()) throw new Error();
  } catch {
    throw new AgentLordError(
      "TARGET_INVALID",
      "Codex working directory does not exist",
      { details: { target: op.target }, exit_code: 2 },
    );
  }
  const stdout = path.join(store.root, "logs", `${op.operation_id}.stdout`);
  const stderr = path.join(store.root, "logs", `${op.operation_id}.stderr`);
  const result = path.join(store.root, "logs", `${op.operation_id}.final`);
  if (op.resume && !op.endpoint_id)
    throw new AgentLordError(
      "STATE_CORRUPT",
      "Codex CLI resume requires a saved endpoint id",
    );
  const command = [
    providerBinary("codex-cli"),
    "exec",
    ...(op.resume ? ["resume"] : []),
    "--json",
    "--strict-config",
  ];
  if (op.expected.model) command.push("--model", op.expected.model);
  if (op.expected.effort)
    command.push(
      "-c",
      `model_reasoning_effort=${JSON.stringify(op.expected.effort)}`,
    );
  command.push(
    ...permissionModePolicy("codex-cli", op.expected.permission_mode).arguments,
    "--output-last-message",
    result,
    ...(op.resume ? [op.endpoint_id!] : []),
    "-",
  );
  store.updateOperation(op.operation_id, (value) => ({
    ...value,
    provider_command: command,
    stdout_path: stdout,
    stderr_path: stderr,
    result_path: result,
  }));
  await runChild({
    command,
    target: op.target,
    prompt: markedMessage(op.operation_id, op.message),
    stdout,
    stderr,
    root: store.root,
    detached: false,
    launched: (pid) => {
      store.updateOperation(op.operation_id, (value) => ({
        ...value,
        status: "running",
        pid,
      }));
    },
    notDelivered: () => {},
    exited: (code) => {
      store.updateOperation(op.operation_id, (value) => ({
        ...value,
        provider_return_code: code,
      }));
    },
  });
  return recoverCodex(store.operation(op.operation_id));
}
