---
name: agent-lord
description: Start a Codex App task or Claude Code CLI session and continue later turns on the exact original endpoint. Use when a Codex Desktop user explicitly asks to dispatch or hand off work to Codex or Claude and keep conversing with that task; not for in-process subagents, CI jobs, or full workflow automation.
---

# Agent Lord

Route one logical task to one durable host endpoint. This first version has two operations:

```text
start(task_id, provider, target, prompt) -> task handle + first response
turn(task_id, message)                   -> response from the same endpoint
```

`provider` is `codex-app` or `claude-cli`. A turn starts only after the previous turn has reached a terminal state; in-flight steering and queued input are outside this version.

## Authorization and invariants

- Start a task only when the user explicitly asks to create or dispatch it. A request to analyze, plan, or explain is not dispatch authorization.
- Resolve the exact saved Codex project or Claude working directory before launch. The user supplies any branch, worktree, model, effort, permission, push, PR, or deployment choice that would materially change execution.
- Give each logical task a unique `task_id`. Refuse duplicate starts and unknown follow-ups instead of guessing an endpoint.
- Keep one writer per working directory. This skill allocates Codex worktrees through the Desktop host but does not allocate Claude worktrees.
- Preserve the endpoint across turns. A failed or missing endpoint is an error; never create a replacement task implicitly.
- Store orchestration handles outside repositories. Product changes and task metadata must not share a commit.

## Task handles

Use `scripts/task_store.py` relative to this `SKILL.md`. It writes one record per task under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`.

The record contains only:

```json
{
  "version": 1,
  "task_id": "logical-name",
  "provider": "codex-app",
  "endpoint_id": "thread-or-session-id",
  "host_id": "codex-host-or-null",
  "target": "project-id-or-working-directory",
  "created_at": "UTC timestamp"
}
```

Register a handle only after the provider returned an independently addressable endpoint. `turn` begins by loading that handle. The store refuses replacement; remove a record only as explicit cleanup after the endpoint is closed or a verified non-start.

## Start

### Codex App

1. List Desktop projects and resolve one exact saved project. For a Git repository, default to a new worktree; use the saved checkout directly only when the user explicitly requests it.
2. Create a visible Codex task with the initial prompt. Preserve the configured default model and effort unless the user supplied overrides.
3. A returned `clientThreadId` is pending setup, not an endpoint. Do not register or message it; wait until the Desktop returns a real `threadId` and `hostId`.
4. Register `provider=codex-app`, `endpoint_id=<threadId>`, `host_id=<hostId>`, and `target=<projectId>`.
5. Wait for completion or attention, then read and return the first response.

### Claude Code CLI

1. Resolve and validate the exact working directory and confirm `claude` is available.
2. Generate a UUID and save the prompt in a temporary input file outside the target repository. Launch from the target directory without a shell-interpolated prompt:

   ```bash
   claude --print --session-id <uuid> --output-format json < <input-file>
   ```

   Omit model, effort, permission, and bypass flags unless the user explicitly supplied them.
3. Wait for the command to finish. Provider wrappers may print diagnostics before the result, so scan complete output from the end and select the last valid JSON object whose `type` is `result`; do not treat stdout as one pure JSON document. Verify that object's `session_id` equals the generated UUID and `is_error` is false.
4. Register `provider=claude-cli`, `endpoint_id=<uuid>`, no `host_id`, and `target=<absolute-working-directory>`.
5. Return Claude's first response. Remove the temporary input file after the command has consumed it.

## Turn

Load the exact task handle first.

- For `codex-app`, send the follow-up to its recorded `threadId` and `hostId`, then wait and read that same task.
- For `claude-cli`, verify the recorded working directory still exists, write the message to a temporary input file outside it, and run:

  ```bash
  claude --print --resume <session-id> --output-format json < <input-file>
  ```

  Select the last `type=result` JSON object by the same rule as `start`. Verify its session id still matches the record and `is_error` is false, return the response, and remove the input file.

A successful `turn` must not create a new Codex thread or Claude session. Report `task_id`, provider, and delivery outcome to the user without claiming automatic recovery or a workflow Gate.

## Scope

This version provides endpoint creation and round-boundary continuation only. Hooks, daemons, watchers, CI, retries, replacement workers, Agent Flow nodes, automatic cross-restart wakeups, and First Mate backend integration require separate designs after this interface passes live smoke tests.
