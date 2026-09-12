import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider, Task } from "../src/contracts.js";
import {
  openTaskTerminal,
  taskResumeCommand,
  type ProcessResult,
} from "../src/terminal.js";
import { harness, operation } from "./helpers.js";

let h: ReturnType<typeof harness>;

beforeEach(() => {
  h = harness();
  vi.stubEnv("AGENT_LORD_MCODE_BIN", "mcode");
  vi.stubEnv("AGENT_LORD_CLAUDE_BIN", "claude");
  vi.stubEnv("AGENT_LORD_CODEX_BIN", "codex");
  vi.stubEnv("AGENT_LORD_ITERM_BIN", "it2");
});

afterEach(() => h.cleanup());

function task(
  provider: Provider = "mcode-cli",
  overrides: Partial<Task> = {},
): Task {
  const now = "2026-09-12T10:00:00+00:00";
  return {
    version: 2,
    task_id: "terminal-task",
    provider,
    endpoint_id: "session-terminal",
    target: h.target,
    route: {
      host_id: provider === "codex-app" ? "local" : null,
      resolved_at: now,
      history: [],
    },
    contract: {
      model: provider === "mcode-cli" ? "test/model#xhigh" : "test-model",
      effort: provider === "mcode-cli" ? null : "high",
      read_only: false,
      permission_mode: "dangerously_bypass",
      source: {},
      retry_plan: [{ model: "test-model", attempts: 1 }],
      workspace: { policy: "exact-target" },
      ...(provider === "mcode-cli" ? { continuation_limit: 2 } : {}),
    },
    created_at: now,
    updated_at: now,
    last_operation_id: null,
    ...overrides,
  };
}

const ok = (): ProcessResult => ({ status: 0, stdout: "{}", stderr: "" });

describe("native terminal launcher", () => {
  it("opens a running MCode Session in Orca without stopping the operation", () => {
    h.lord.store.createTask(task());
    h.lord.store.createOperation(
      operation("mcode-cli", {
        task_id: "terminal-task",
        operation_id: "terminal-operation",
        endpoint_id: "session-terminal",
        target: h.target,
        status: "running",
      }),
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = openTaskTerminal("terminal-task", "orca", {
      store: h.lord.store,
      run(command, args) {
        calls.push({ command, args });
        return ok();
      },
    });

    expect(result).toMatchObject({
      status: "TERMINAL_OPENED",
      terminal: "orca",
      operation_running: true,
      resume_command: "mcode --session session-terminal",
    });
    expect(calls).toEqual([
      {
        command: "orca",
        args: [
          "terminal",
          "create",
          "--worktree",
          `path:${h.target}`,
          "--title",
          "Agent Lord · terminal-task",
          "--command",
          "exec mcode --session session-terminal",
          "--focus",
          "--json",
        ],
      },
    ]);
    expect(
      readFileSync(path.join(h.root, "events", "terminal-task.jsonl"), "utf8"),
    ).toContain('"type":"terminal-opened"');
  });

  it("registers an unknown Orca repository once and retries the exact worktree", () => {
    h.lord.store.createTask(
      task("mcode-cli", {
        contract: {
          ...task().contract,
          workspace: {
            policy: "reuse-or-create",
            repository: "/source/repository",
            source_branch: "main",
          },
        },
      }),
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const responses: ProcessResult[] = [
      {
        status: 1,
        stdout: '{"error":{"code":"selector_not_found"}}',
        stderr: "",
      },
      ok(),
      ok(),
    ];
    const result = openTaskTerminal("terminal-task", "orca", {
      store: h.lord.store,
      run(command, args) {
        calls.push({ command, args });
        return responses.shift()!;
      },
    });

    expect(result.repository_registered).toBe(true);
    expect(calls[1]).toEqual({
      command: "orca",
      args: ["repo", "add", "--path", "/source/repository", "--json"],
    });
    expect(calls[2]).toEqual(calls[0]);
  });

  it("opens an iTerm window and runs the shell-quoted command in its Session", () => {
    h.lord.store.createTask(
      task("claude-cli", { endpoint_id: "session with ' quote" }),
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = openTaskTerminal("terminal-task", "iterm", {
      store: h.lord.store,
      platform: "darwin",
      run(command, args) {
        calls.push({ command, args });
        if (calls.length === 1)
          return {
            status: 0,
            stdout: "Created new window: pty-window-e2e\n",
            stderr: "",
          };
        if (calls.length === 2)
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: "iterm-session-e2e", window_id: "pty-window-e2e" },
            ]),
            stderr: "",
          };
        return ok();
      },
    });

    expect(result.operation_running).toBe(false);
    expect(result.resume_command).toBe(
      "claude --resume 'session with '\\'' quote'",
    );
    const command =
      `cd -- ${h.target} && exec claude --resume 'session with '\\'' quote'`;
    expect(calls).toEqual([
      { command: "it2", args: ["window", "new"] },
      { command: "it2", args: ["session", "list", "--json"] },
      {
        command: "it2",
        args: [
          "session",
          "run",
          command,
          "--session",
          "iterm-session-e2e",
        ],
      },
    ]);
  });

  it("rejects Codex App because it has no native local CLI Session", () => {
    h.lord.store.createTask(task("codex-app"));
    expect(() =>
      taskResumeCommand(h.lord.store.task("terminal-task")),
    ).toThrowError(/native CLI Session/u);
    expect(() =>
      openTaskTerminal("terminal-task", "orca", {
        store: h.lord.store,
        run: ok,
      }),
    ).toThrowError(/native CLI Session/u);
  });
});
