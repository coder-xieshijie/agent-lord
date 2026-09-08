import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type Data,
  type Operation,
  type ProviderResult,
  object,
  string,
} from "../contracts.js";
import {
  type Control,
  claudeChildEnvironment,
  permissionModePolicy,
  providerBinary,
} from "../config.js";
import { AgentLordError } from "../errors.js";
import { extractClaudeResult, jsonLines, jsonObjects } from "../artifacts.js";
import { StateStore } from "../state.js";
import { LogTail, readText, runChild } from "../process.js";
import { evaluateClaudeAttempt } from "./claude-result.js";
export function claudeSessionObserved(op: Operation): boolean {
  const active = object(op.active_attempt);
  if (active.session_observed === true) return true;
  const file = string(active.stdout_path) || string(op.stdout_path);
  if (!op.endpoint_id || !file) return false;
  try {
    return jsonObjects(readText(file)).some(
      (v) => v.session_id === op.endpoint_id,
    );
  } catch {
    return false;
  }
}
export function claudeOutputActivityMs(op: Operation): number | null {
  const active = object(op.active_attempt);
  const times: number[] = [];
  for (const key of ["stdout_path", "stderr_path"]) {
    const file = string(active[key]) || string(op[key]);
    if (file) {
      try {
        times.push(statSync(file).mtimeMs);
      } catch {
        /* no activity */
      }
    }
  }
  return times.length ? Math.max(...times) : null;
}
export function recoverClaude(op: Operation): ProviderResult {
  if (!op.endpoint_id)
    throw new AgentLordError(
      "RESULT_INVALID",
      "Claude operation journal lacks its session identity",
    );
  const active = object(op.active_attempt);
  const stdout = string(active.stdout_path) || string(op.stdout_path);
  const stderr = string(active.stderr_path) || string(op.stderr_path);
  if (!stdout || !stderr)
    throw new AgentLordError(
      "RESULT_INVALID",
      "Claude operation journal lacks provider log paths",
    );
  const model = string(active.model) || op.expected.model;
  const evaluation = evaluateClaudeAttempt(
    readText(stdout),
    readText(stderr),
    op.endpoint_id,
    model,
    op.provider_return_code,
  );
  const permission = permissionModePolicy(
    "claude-cli",
    op.expected.permission_mode,
  );
  const effort = op.expected.effort;
  return {
    endpoint_id: op.endpoint_id,
    model,
    effort,
    provider_result: evaluation.result,
    assistant_text: extractClaudeResult(evaluation.result),
    observed: {
      models: [evaluation.main_model],
      main_model: evaluation.main_model,
      main_model_verified: true,
      main_model_evidence: evaluation.main_model_evidence,
      auxiliary_models: evaluation.auxiliary_models,
      warnings: evaluation.warnings,
      effort,
      effort_verification: effort ? "argument-enforced" : "not-requested",
      permission_mode: permission.mode,
      permission_enforcement: permission.enforcement,
    },
    command: active.command ?? op.provider_command ?? [],
    stdout_path: stdout,
    stderr_path: stderr,
    attempt_number: active.number,
    attempt_model: model,
  };
}
function progressState(event: Data): string {
  if (
    [event.type, event.subtype, object(event.event).type].some((v) =>
      /hook|tool/.test(String(v ?? "")),
    )
  )
    return "tool_wait";
  return event.type === "system" ? "provider_wait" : "progressing";
}
export async function runClaude(
  store: StateStore,
  op: Operation,
  control: Control,
  model: string,
  number: number,
  resume: boolean,
  prompt: string,
  promptKind: string,
  recoveryMarker: string | null,
): Promise<ProviderResult> {
  try {
    if (!statSync(op.target).isDirectory()) throw new Error();
  } catch {
    throw new AgentLordError(
      "TARGET_INVALID",
      "Claude working directory does not exist",
      { details: { target: op.target }, exit_code: 2 },
    );
  }
  const command = [
    providerBinary("claude-cli"),
    "--print",
    resume ? "--resume" : "--session-id",
    op.endpoint_id!,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
  ];
  if (model) command.push("--model", model);
  if (op.expected.effort) command.push("--effort", op.expected.effort);
  command.push(
    ...permissionModePolicy("claude-cli", op.expected.permission_mode)
      .arguments,
  );
  const stdout = path.join(
    store.root,
    "logs",
    `${op.operation_id}.attempt-${number}.stdout`,
  );
  const stderr = path.join(
    store.root,
    "logs",
    `${op.operation_id}.attempt-${number}.stderr`,
  );
  const attemptId = randomUUID().replaceAll("-", "");
  const started = Date.now();
  store.updateOperation(op.operation_id, (value) => {
    value.resume = resume;
    value.provider_command = command;
    value.stdout_path = stdout;
    value.stderr_path = stderr;
    delete value.provider_return_code;
    delete value.dead_process_observed_at_ms;
    value.active_attempt = {
      number,
      model,
      resume,
      command,
      stdout_path: stdout,
      stderr_path: stderr,
      attempt_id: attemptId,
      controller_pid: process.pid,
      prompt_kind: promptKind,
      recovery_marker: recoveryMarker,
      prompt_delivery: "delivery-unknown",
      progress_state: "provider_wait",
      last_progress_at_ms: started,
      progress_seq: 0,
    };
    value.last_progress_at_ms = started;
    value.observed = {
      ...value.observed,
      supervision: {
        state: "provider_wait",
        attempt: number,
        last_progress_at_ms: started,
      },
    };
    return value;
  });
  const tail = new LogTail(stdout);
  let lastActivity = performance.now();
  let lastJournaled = 0;
  let seq = 0;
  let sessionObserved = false;
  let state = "provider_wait";
  await runChild({
    command,
    target: op.target,
    prompt,
    stdout,
    stderr,
    root: store.root,
    detached: true,
    env: claudeChildEnvironment(),
    pollMs: control.claude_progress_poll_interval_ms,
    graceSeconds: control.claude_terminate_grace_seconds,
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
          prompt_delivered_at_ms: Date.now(),
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
      const read = tail.read(final);
      if (read.bytes) lastActivity = performance.now();
      const events = jsonLines(read.lines.join("\n"));
      if (events.length) {
        seq += events.length;
        sessionObserved ||= events.some((v) => v.session_id === op.endpoint_id);
        const kind = String(events.at(-1)!.type || "provider-output");
        state = progressState(events.at(-1)!);
        if (
          performance.now() - lastJournaled >= 1000 ||
          kind === "result" ||
          final
        ) {
          const now = Date.now();
          store.updateOperation(op.operation_id, (value) => {
            const active = object(value.active_attempt);
            if (active.attempt_id !== attemptId) return value;
            value.active_attempt = {
              ...active,
              last_progress_at_ms: now,
              last_progress_event: kind,
              progress_state: state,
              progress_seq: seq,
              session_observed: sessionObserved,
            };
            value.last_progress_at_ms = now;
            value.observed = {
              ...value.observed,
              supervision: {
                state,
                attempt: number,
                last_progress_at_ms: now,
                last_event: kind,
                progress_seq: seq,
              },
            };
            return value;
          });
          lastJournaled = performance.now();
        }
      }
      const limit =
        state === "tool_wait"
          ? control.claude_tool_stall_seconds
          : control.claude_stall_seconds;
      if (!final && performance.now() - lastActivity >= limit * 1000) {
        store.updateOperation(op.operation_id, (value) => ({
          ...value,
          active_attempt: {
            ...object(value.active_attempt),
            progress_state: "suspected_stall",
            stalled_at_ms: Date.now(),
          },
          observed: {
            ...value.observed,
            supervision: {
              state: "suspected_stall",
              attempt: number,
              last_progress_at_ms: object(value.active_attempt)
                .last_progress_at_ms,
            },
          },
        }));
        throw new AgentLordError(
          "PROVIDER_STALLED",
          "Claude produced no stream progress before the supervision deadline",
          {
            retryable: true,
            safe_recovery: "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
            details: {
              attempt: number,
              stall_seconds: limit,
              session_observed: sessionObserved,
            },
          },
        );
      }
    },
    exited: (code) => {
      store.updateOperation(op.operation_id, (value) => ({
        ...value,
        provider_return_code: code,
        active_attempt: {
          ...object(value.active_attempt),
          ...(sessionObserved ? { session_observed: true } : {}),
        },
      }));
    },
  });
  return recoverClaude(store.operation(op.operation_id));
}
