/** Unreceived-result alert.
 *
 * The scheduling caller is the only reader of terminal results, so a caller
 * that dies silently leaves finished work unnoticed: in goal-v2 run-02 a 401
 * ended the Codex main session and a completed module waited 55 hours with no
 * signal. The detached execution worker therefore outlives its operation for
 * `control.result_alert_seconds`: when the task belongs to a run and no run
 * acknowledged the result (and no later operation continued the task), it
 * records a `result-unreceived` event and runs the configured alert command
 * once. Tasks outside every run have no acknowledgement to wait for and are
 * not watched.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { type Data, type Operation, TERMINAL_STATES } from "./contracts.js";
import { resultAlertCommand } from "./config.js";
import { errorMessage } from "./errors.js";
import { stringifyJson } from "./json.js";
import { operationResultKey } from "./result-key.js";
import { TaskSets } from "./task-sets.js";
import type { AgentLord } from "./engine.js";

const POLL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

export interface AlertDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  deliver?: (command: string[], alert: Data) => Promise<void>;
}

function continued(lord: AgentLord, op: Operation): boolean {
  return lord.store
    .operations(op.task_id)
    .some(
      (other) =>
        other.operation_id !== op.operation_id &&
        other.created_at > op.created_at,
    );
}

/** Returns the alert it raised, or null when the result was received or is not watched. */
export async function watchResult(
  lord: AgentLord,
  operationId: string,
  deps: AlertDependencies = {},
): Promise<Data | null> {
  const seconds = lord.control.result_alert_seconds;
  if (!seconds) return null;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const sets = new TaskSets(lord);
  for (;;) {
    const op = lord.store.operation(operationId);
    if (!TERMINAL_STATES.has(op.status)) return null;
    const { run_ids, acknowledged } = sets.receiptsFor(
      op.task_id,
      operationResultKey(op),
    );
    if (!run_ids.length || acknowledged || continued(lord, op)) return null;
    const due =
      Date.parse(String(op.completed_at ?? op.updated_at)) + seconds * 1000;
    const wait = due - now();
    if (wait <= 0)
      return raise(lord, op, run_ids, seconds, deps.deliver ?? deliver);
    await sleep(Math.min(wait, POLL_MS));
  }
}

async function raise(
  lord: AgentLord,
  op: Operation,
  runIds: string[],
  seconds: number,
  send: NonNullable<AlertDependencies["deliver"]>,
): Promise<Data> {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const alert: Data = {
    task_id: op.task_id,
    operation_id: op.operation_id,
    status: op.status,
    run_ids: runIds,
    completed_at: op.completed_at ?? op.updated_at,
    alert_after_seconds: seconds,
    message: `Agent Lord: task ${op.task_id} ended (${op.status}) ${minutes} min ago and no scheduling session has acknowledged its result. Resume from a scheduling session: checkpoint --run-id ${runIds[0]} --include-response`,
  };
  lord.store.event(op.task_id, "result-unreceived", alert, op.operation_id);
  const command = resultAlertCommand();
  if (command) {
    try {
      await send(command, alert);
      lord.store.event(
        op.task_id,
        "result-alert-sent",
        { command: command[0] },
        op.operation_id,
      );
    } catch (error) {
      lord.store.event(
        op.task_id,
        "result-alert-failed",
        { command: command[0], error: errorMessage(error) },
        op.operation_id,
      );
    }
  }
  return alert;
}

/** Runs the alert command with the alert as JSON on stdin and the message in the environment. */
function deliver(command: string[], alert: Data): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...process.env,
        AGENT_LORD_ALERT_MESSAGE: String(alert.message),
      },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("alert command timed out"));
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`alert command exited with ${code}`));
    });
    child.stdin!.on("error", () => {
      /* a command that ignores stdin may close it early */
    });
    child.stdin!.end(`${stringifyJson(alert)}\n`);
  });
}
