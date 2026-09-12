import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { platform as hostPlatform } from "node:os";
import { providerBinary } from "./config.js";
import { TERMINAL_STATES, type CliProvider, type Task } from "./contracts.js";
import { AgentLordError, errorMessage, usageError } from "./errors.js";
import { StateStore } from "./state.js";

export const NATIVE_TERMINALS = ["orca", "iterm"] as const;
export type NativeTerminal = (typeof NATIVE_TERMINALS)[number];

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

export type ProcessRunner = (command: string, args: string[]) => ProcessResult;

export interface TerminalOpenOptions {
  store?: StateStore;
  run?: ProcessRunner;
  platform?: NodeJS.Platform;
}

export interface TerminalOpenResult {
  version: 1;
  status: "TERMINAL_OPENED";
  task_id: string;
  terminal: NativeTerminal;
  provider: CliProvider;
  session_id: string;
  target: string;
  operation_running: boolean;
  resume_command: string;
  repository_registered: boolean;
  journaled: boolean;
}

const DEFAULT_ITERM_BIN =
  "/Applications/iTerm.app/Contents/Resources/utilities/it2";

function defaultRunner(command: string, args: string[]): ProcessResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

/** POSIX-shell quote for a value persisted by a provider or workspace. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._\/:@%+=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function taskResumeCommand(task: Task): string {
  if (task.provider === "codex-app")
    throw new AgentLordError(
      "TERMINAL_UNSUPPORTED",
      "Codex App tasks do not have a native CLI Session",
      { exit_code: 2 },
    );
  const binary = shellQuote(providerBinary(task.provider));
  const session = shellQuote(task.endpoint_id);
  if (task.provider === "mcode-cli") return `${binary} --session ${session}`;
  if (task.provider === "claude-cli") return `${binary} --resume ${session}`;
  return `${binary} resume -C ${shellQuote(task.target)} ${session}`;
}

function checkedRun(
  run: ProcessRunner,
  command: string,
  args: string[],
  terminal: NativeTerminal,
): ProcessResult {
  const result = run(command, args);
  if (result.status === 0 && !result.error) return result;
  throw new AgentLordError(
    "TERMINAL_OPEN_FAILED",
    `failed to open ${terminal}`,
    {
      details: {
        terminal,
        exit_code: result.status,
        error: result.error ? errorMessage(result.error) : undefined,
        stderr: result.stderr.slice(-1000),
      },
    },
  );
}

function missingOrcaWorktree(result: ProcessResult): boolean {
  return /selector_not_found|No Orca workspace matched/u.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function itermWindowId(result: ProcessResult): string {
  const match = result.stdout.match(/Created new window:\s*(\S+)/u);
  if (match) return match[1];
  throw new AgentLordError(
    "TERMINAL_OPEN_FAILED",
    "iTerm did not return the new window id",
    { details: { stdout: result.stdout.slice(-1000) } },
  );
}

function itermSessionId(result: ProcessResult, windowId: string): string {
  try {
    const sessions = JSON.parse(result.stdout) as Array<{
      id?: unknown;
      window_id?: unknown;
    }>;
    const session = sessions.find(
      (candidate) => candidate.window_id === windowId,
    );
    if (typeof session?.id === "string") return session.id;
  } catch {
    // Fall through to a structured control-plane error below.
  }
  throw new AgentLordError(
    "TERMINAL_OPEN_FAILED",
    "iTerm did not expose the new terminal Session",
    { details: { window_id: windowId } },
  );
}

export function openTaskTerminal(
  taskId: string,
  terminal: NativeTerminal,
  options: TerminalOpenOptions = {},
): TerminalOpenResult {
  if (!NATIVE_TERMINALS.includes(terminal))
    throw usageError(`terminal must be one of: ${NATIVE_TERMINALS.join(", ")}`);
  const store = options.store ?? new StateStore();
  const task = store.task(taskId);
  if (task.provider === "codex-app")
    throw new AgentLordError(
      "TERMINAL_UNSUPPORTED",
      "Codex App tasks do not have a native CLI Session",
      { exit_code: 2 },
    );
  try {
    if (!statSync(task.target).isDirectory())
      throw new Error("not a directory");
  } catch (error) {
    throw new AgentLordError(
      "TERMINAL_OPEN_FAILED",
      "task workspace is unavailable",
      { details: { target: task.target, error: errorMessage(error) } },
    );
  }
  const run = options.run ?? defaultRunner;
  const resume = taskResumeCommand(task);
  const operationRunning = store
    .operations(taskId)
    .some((operation) => !TERMINAL_STATES.has(operation.status));
  let repositoryRegistered = false;

  if (terminal === "orca") {
    const orca = process.env.AGENT_LORD_ORCA_BIN || "orca";
    const args = [
      "terminal",
      "create",
      "--worktree",
      `path:${task.target}`,
      "--title",
      `Agent Lord · ${task.task_id}`,
      "--command",
      `exec ${resume}`,
      "--focus",
      "--json",
    ];
    let result = run(orca, args);
    if (result.status !== 0 && missingOrcaWorktree(result)) {
      const repository = task.contract.workspace?.repository ?? task.target;
      const registration = run(orca, [
        "repo",
        "add",
        "--path",
        repository,
        "--json",
      ]);
      repositoryRegistered =
        registration.status === 0 && !registration.error;
      result = run(orca, args);
    }
    if (result.status !== 0 || result.error)
      checkedRun(() => result, orca, args, terminal);
  } else {
    const platform = options.platform ?? hostPlatform();
    if (platform !== "darwin")
      throw new AgentLordError(
        "TERMINAL_UNSUPPORTED",
        "iTerm integration is available only on macOS",
        { details: { platform }, exit_code: 2 },
      );
    const command = `cd -- ${shellQuote(task.target)} && exec ${resume}`;
    const iterm = process.env.AGENT_LORD_ITERM_BIN || DEFAULT_ITERM_BIN;
    const created = checkedRun(run, iterm, ["window", "new"], terminal);
    const windowId = itermWindowId(created);
    const listed = checkedRun(
      run,
      iterm,
      ["session", "list", "--json"],
      terminal,
    );
    const sessionId = itermSessionId(listed, windowId);
    // `it2 window new` creates the window without activating iTerm. Keep the
    // new window selected inside iTerm, then activate the application so the
    // profile is not rendered with iTerm's background-window dimming.
    checkedRun(run, iterm, ["window", "focus", windowId], terminal);
    checkedRun(
      run,
      "/usr/bin/open",
      ["-b", "com.googlecode.iterm2"],
      terminal,
    );
    checkedRun(
      run,
      iterm,
      ["session", "run", command, "--session", sessionId],
      terminal,
    );
  }

  let journaled = true;
  try {
    store.event(taskId, "terminal-opened", {
      terminal,
      provider: task.provider,
      operation_running: operationRunning,
    });
  } catch {
    // The terminal is already open; do not misreport that side effect as a
    // failed launch merely because the audit event could not be appended.
    journaled = false;
  }
  return {
    version: 1,
    status: "TERMINAL_OPENED",
    task_id: taskId,
    terminal,
    provider: task.provider,
    session_id: task.endpoint_id,
    target: task.target,
    operation_running: operationRunning,
    resume_command: resume,
    repository_registered: repositoryRegistered,
    journaled,
  };
}
