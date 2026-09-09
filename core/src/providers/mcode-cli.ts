import path from "node:path";
import { statSync, unlinkSync } from "node:fs";
import {
  type Data,
  type Operation,
  type ProviderResult,
  object,
  string,
} from "../contracts.js";
import {
  type Control,
  parseMcodeModel,
  permissionModePolicy,
  providerBinary,
} from "../config.js";
import { AgentLordError, errorCode, errorMessage } from "../errors.js";
import { StateStore } from "../state.js";
import { filesystemTimeNs, LogTail, readText, runChild } from "../process.js";
import { markedMessage } from "./codex-app.js";
import {
  McodeProgress,
  McodeStream,
  validateMcodeOutput,
} from "./mcode-result.js";
export function recoverMcode(op: Operation): ProviderResult {
  const active = object(op.active_attempt);
  const paths = ["stdout_path", "stderr_path", "result_path"].map(
    (k) => string(active[k]) || string(op[k]),
  );
  if (!paths.every(Boolean))
    throw new AgentLordError(
      "RESULT_INVALID",
      "MCode operation journal lacks provider output paths",
    );
  const [stdout, stderr, result] = paths as string[];
  let mtime: bigint | null = null;
  try {
    mtime = statSync(result, { bigint: true }).mtimeNs;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const parsed = validateMcodeOutput(
    readText(stdout),
    readText(stderr),
    readText(result, true),
    mtime,
    op,
  );
  return {
    ...parsed,
    command: active.command ?? op.provider_command ?? [],
    stdout_path: stdout,
    stderr_path: stderr,
    result_path: result,
  };
}
export async function runMcode(
  store: StateStore,
  op: Operation,
  control: Control,
  identityCallback: (id: string) => void,
): Promise<ProviderResult> {
  try {
    if (!statSync(op.target).isDirectory()) throw new Error();
  } catch {
    throw new AgentLordError(
      "TARGET_INVALID",
      "MCode working directory does not exist",
      { details: { target: op.target }, exit_code: 2 },
    );
  }
  parseMcodeModel(op.expected.model);
  if (op.expected.effort)
    throw new AgentLordError(
      "CONFIG_INVALID",
      "mcode-cli has no independently enforceable --effort contract; omit --effort",
      { exit_code: 2 },
    );
  if (op.resume && !op.endpoint_id)
    throw new AgentLordError(
      "STATE_CORRUPT",
      "MCode resume requires a saved Session id",
    );
  const stdout = path.join(store.root, "logs", `${op.operation_id}.stdout`);
  const stderr = path.join(store.root, "logs", `${op.operation_id}.stderr`);
  const result = path.join(store.root, "logs", `${op.operation_id}.final`);
  for (const file of [stdout, stderr, result]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        throw new AgentLordError(
          "RESULT_INVALID",
          "cannot reset MCode operation output",
          { details: { path: file, error: errorMessage(error) } },
        );
    }
  }
  const reset = filesystemTimeNs(store.root);
  const attemptId = `${process.pid}-${reset}`;
  const command = [
    providerBinary("mcode-cli"),
    "exec",
    "--input",
    "-",
    "--cwd",
    op.target,
    "--model",
    op.expected.model!,
    ...permissionModePolicy("mcode-cli", op.expected.permission_mode).arguments,
    "--output-format",
    "stream-json",
    "--output-last-message",
    result,
  ];
  if (op.resume) command.push("--session", op.endpoint_id!);
  store.updateOperation(op.operation_id, (value) => {
    value.provider_command = command;
    value.stdout_path = stdout;
    value.stderr_path = stderr;
    value.result_path = result;
    value.result_reset_at_ns = reset;
    delete value.provider_return_code;
    delete value.dead_process_observed_at_ms;
    value.active_attempt = {
      attempt_id: attemptId,
      controller_pid: process.pid,
      command,
      stdout_path: stdout,
      stderr_path: stderr,
      result_path: result,
      result_reset_at_ns: reset,
      prompt_delivery: "delivery-unknown",
      progress_state: "provider_wait",
      progress_seq: 0,
    };
    value.observed = {
      ...value.observed,
      supervision: { state: "provider_wait", progress_seq: 0 },
    };
    return value;
  });
  const progress = new McodeProgress();
  const stream = new McodeStream(Boolean(op.resume), op.endpoint_id ?? null);
  const tail = new LogTail(stdout, true);
  // Identity and lifecycle transitions journal immediately; item-level
  // progress coalesces to at most one journal write per second (mirroring the
  // Claude progress throttle) with a mandatory flush when the stream ends.
  const IMMEDIATE_EVENTS = new Set([
    "session.started",
    "session.resumed",
    "turn.completed",
    "turn.failed",
    "exec.completed",
  ]);
  let lastJournaled = 0;
  const journal = (eventType: string, summary: Data): void => {
    const identity = stream.identity!;
    const now = Date.now();
    store.updateOperation(op.operation_id, (value) => {
      const active = object(value.active_attempt);
      if (active.attempt_id !== attemptId)
        throw new AgentLordError(
          "STATE_CONFLICT",
          "MCode progress belongs to a superseded attempt",
        );
      value.active_attempt = {
        ...active,
        run_id: identity[0],
        session_id: identity[1],
        turn_id: identity[2],
        progress_seq: stream.sequence,
        last_event_type: eventType,
        progress_state: summary.state,
        last_progress_at_ms: now,
      };
      value.run_id = identity[0];
      value.turn_id = identity[2];
      if (["session.started", "session.resumed"].includes(eventType))
        value.endpoint_id = identity[1];
      value.observed = {
        ...value.observed,
        supervision: {
          ...summary,
          progress_seq: stream.sequence,
          last_progress_at_ms: now,
          provider_pid: active.pid,
          process_group_id: active.process_group_id,
        },
      };
      return value;
    });
    lastJournaled = performance.now();
  };
  await runChild({
    command,
    target: op.target,
    prompt: markedMessage(op.operation_id, op.message),
    stdout,
    stderr,
    root: store.root,
    detached: true,
    exclusive: true,
    pollMs: control.mcode_progress_poll_interval_ms,
    graceSeconds: control.mcode_terminate_grace_seconds,
    launched: (pid) => {
      store.updateOperation(op.operation_id, (value) => ({
        ...value,
        status: "running",
        pid,
        active_attempt: {
          ...object(value.active_attempt),
          pid,
          process_group_id: process.platform === "win32" ? null : pid,
          prompt_delivery: "stdin-attached",
        },
      }));
    },
    notDelivered: () => {
      store.updateOperation(op.operation_id, (value) => ({
        ...value,
        active_attempt: {
          ...object(value.active_attempt),
          prompt_delivery: "not-delivered",
        },
      }));
    },
    observe: (final) => {
      let lines: string[];
      try {
        lines = tail.read(final).lines;
      } catch (error) {
        throw new AgentLordError(
          "RESULT_INVALID",
          "MCode stream is not valid UTF-8",
          { details: { error: errorMessage(error) } },
        );
      }
      let pending: [string, Data] | null = null;
      for (const line of lines) {
        if (!line) continue;
        const event = stream.feed(line);
        const type = String(event.type);
        const summary = progress.observe(event);
        if (IMMEDIATE_EVENTS.has(type)) {
          journal(type, summary);
          pending = null;
          if (["session.started", "session.resumed"].includes(type))
            identityCallback(stream.identity![1]);
        } else pending = [type, summary];
      }
      if (pending && (final || performance.now() - lastJournaled >= 1000))
        journal(pending[0], pending[1]);
    },
    exited: (code) => {
      store.updateOperation(op.operation_id, (value) => ({
        ...value,
        provider_return_code: code,
      }));
    },
  });
  return recoverMcode(store.operation(op.operation_id));
}
