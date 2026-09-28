/** Unreceived-result alert.
 *
 * The scheduling caller is the only reader of terminal results, so a caller
 * that dies silently leaves finished work unnoticed: in goal-v2 run-02 a 401
 * ended the Codex main session and a completed module waited 55 hours with no
 * signal. The detached execution worker therefore outlives its operation for
 * `control.result_alert_seconds`: when the task belongs to a run and no run
 * acknowledged the result (and no later operation continued the task), it
 * records a `result-unreceived` event and alerts the user once. Tasks outside
 * every run have no acknowledgement to wait for and are not watched.
 *
 * Channels are tried in order until one succeeds: an explicitly configured
 * command alone; otherwise a Feishu direct message from the `lark-cli` app bot
 * to the logged-in user (the user may be away from this machine), then a macOS
 * notification.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Data,
  type Operation,
  TERMINAL_STATES,
  object,
  string,
} from "./contracts.js";
import { resultAlertCommand } from "./config.js";
import { errorMessage } from "./errors.js";
import { parseJson, sha256, stringifyJson } from "./json.js";
import { operationResultKey } from "./result-key.js";
import { TaskSets } from "./task-sets.js";
import type { AgentLord } from "./engine.js";

const POLL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const LARK_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
};

export interface AlertChannel {
  name: string;
  send(alert: Data): Promise<void>;
}
export interface AlertDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  channels?: AlertChannel[];
}

function executable(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      /* not in this directory */
    }
  }
  return null;
}

/** The channels an alert tries, in order. */
export function alertChannels(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): AlertChannel[] {
  const command = resultAlertCommand();
  if (command)
    return [
      {
        name: "command",
        send: (alert) =>
          run(command, {
            stdin: `${stringifyJson(alert)}\n`,
            env: { AGENT_LORD_ALERT_MESSAGE: String(alert.message) },
          }).then(() => undefined),
      },
    ];
  const channels: AlertChannel[] = [];
  const lark = executable("lark-cli", env);
  if (lark) channels.push({ name: "feishu", send: (a) => feishu(lark, a) });
  if (platform === "darwin")
    channels.push({
      name: "macos",
      send: (alert) =>
        run(
          [
            "osascript",
            "-e",
            'display notification (system attribute "AGENT_LORD_ALERT_MESSAGE") with title "Agent Lord"',
          ],
          { env: { AGENT_LORD_ALERT_MESSAGE: String(alert.message) } },
        ).then(() => undefined),
    });
  return channels;
}

/** Direct message from the lark-cli app bot to the user logged in to lark-cli. */
async function feishu(lark: string, alert: Data): Promise<void> {
  let recipient = process.env.AGENT_LORD_RESULT_ALERT_FEISHU_USER_ID?.trim();
  if (!recipient) {
    const status = object(
      parseJson(
        await run([lark, "auth", "status", "--json"], { env: LARK_ENV }),
      ),
    );
    recipient =
      string(object(object(status.identities).user).openId) ?? undefined;
    if (!recipient)
      throw new Error("lark-cli has no logged-in user to receive the alert");
  }
  const sent = object(
    parseJson(
      await run(
        [
          lark,
          "im",
          "+messages-send",
          "--as",
          "bot",
          "--user-id",
          recipient,
          "--text",
          String(alert.message),
          "--idempotency-key",
          `al-${sha256(String(alert.operation_id)).slice(0, 40)}`,
        ],
        { env: LARK_ENV },
      ),
    ),
  );
  if (sent.ok !== true) throw new Error("lark-cli did not confirm the message");
}

/** Returns an alert it raised, or null when the result was received or is not watched. */
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
      return raise(
        lord,
        op,
        run_ids,
        seconds,
        deps.channels ?? alertChannels(),
      );
    await sleep(Math.min(wait, POLL_MS));
  }
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

async function raise(
  lord: AgentLord,
  op: Operation,
  runIds: string[],
  seconds: number,
  channels: AlertChannel[],
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
  for (const channel of channels) {
    try {
      await channel.send(alert);
      lord.store.event(
        op.task_id,
        "result-alert-sent",
        { channel: channel.name },
        op.operation_id,
      );
      break;
    } catch (error) {
      lord.store.event(
        op.task_id,
        "result-alert-failed",
        { channel: channel.name, error: errorMessage(error) },
        op.operation_id,
      );
    }
  }
  return alert;
}

/** Runs a command to completion and returns its stdout; a non-zero exit rejects. */
function run(
  command: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(command[0])} timed out`));
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`${path.basename(command[0])} exited with ${code}`));
    });
    child.stdin!.on("error", () => {
      /* a command that ignores stdin may close it early */
    });
    child.stdin!.end(opts.stdin ?? "");
  });
}
