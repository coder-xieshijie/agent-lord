# CLI walkthrough

[English overview](../README.md) · [中文概览](../README.zh-CN.md)

This example uses Codex CLI to create a file in a new temporary workspace, then continues the same task. Install and authenticate Codex CLI, and complete the [build](../README.md#1-install-and-build) first. Run the commands from the Agent Lord repository root in the same shell.

The CLI uses the configured permission mode; the default for new tasks is bypass. Use this disposable workspace for the example. The [execution contract](protocol.md#execution-contract) explains provider permissions, defaults, and verification.

## Start and check a deliverable

```sh
agent_lord_demo="$(mktemp -d)"
agent_lord_task="hello-$(date +%s)-$$"
mkdir -p "$agent_lord_demo/workspace"
git init --quiet "$agent_lord_demo/workspace"
cat > "$agent_lord_demo/prompt.txt" <<'PROMPT'
Create hello.md in the current working directory.
Use the heading "# Hello from Agent Lord" followed by a short greeting.
Complete this task yourself without delegating to other agents.
Return a brief summary of the file you created.
PROMPT

node core/dist/cli.js start \
  --task-id "$agent_lord_task" \
  --provider codex-cli \
  --target "$agent_lord_demo/workspace" \
  --message-file "$agent_lord_demo/prompt.txt" \
  --require-file hello.md \
  --include-response
```

Read the returned JSON envelope:

- `SUCCEEDED`: the provider operation finished. Read `response.text` and check `delivery.status` separately.
- `delivery.status: "verified"`: the declared `hello.md` exists and is non-empty. This does not judge its contents.
- `RUNNING`: supervise with the checkpoint below.
- `ERROR` or `NEEDS_DECISION`: inspect the structured error and follow the [recovery rules](protocol.md#safe-recovery-line).

If the task is still running:

```sh
node core/dist/cli.js checkpoint \
  --task-id "$agent_lord_task" \
  --seconds 120 \
  --include-response
```

A quiet interval returns `CHECKPOINT_QUIET` with exit code **124**; continue waiting on the same task. `CHECKPOINT_ACTIONABLE` carries individual task envelopes in `actionable`. Use `--starting-task-id` instead of `--task-id` only for a task you just dispatched whose record may not exist yet; inspect its `starting[]` observation before deciding what to do next.

To read an established task without supervising it:

```sh
node core/dist/cli.js check --task-id "$agent_lord_task" --include-response
```

## Continue the saved session

After the first operation finishes successfully:

```sh
cat > "$agent_lord_demo/next.txt" <<'PROMPT'
Append one sentence to hello.md noting that this is a follow-up in the same task.
Preserve the existing content and complete the work without delegating.
PROMPT

node core/dist/cli.js turn \
  --task-id "$agent_lord_task" \
  --message-file "$agent_lord_demo/next.txt" \
  --require-file hello.md \
  --include-response
```

The task retains its saved endpoint and execution contract. Delivery requirements belong to each operation, so the follow-up declares `hello.md` again.

## Open the Observer

In the same shell, run:

```sh
pnpm --filter agent-lord-observer preview:attach \
  --tasks "$agent_lord_task" \
  --focus-task "$agent_lord_task"
```

Open the returned local URL. The binding is checked over HTTP, and the page focuses on this task. You can run this command from another terminal while the task is active by supplying the recorded task ID directly. Later turns use the same page. See the [Observer guide](../observer/README.md) for service lifecycle and access controls.

## More operations

Use `node core/dist/cli.js --help` to inspect the command surface.

- `request-add`, `request-get`, `request-list`, `request-cancel`, and `request-dispatch` manage the passive request inbox. Registration starts nothing; explicit dispatch returns `REQUEST_PENDING` while the target task is busy.
- `--require-commit` checks for a new descendant of the dispatch-time HEAD and a clean worktree. It requires an existing Git commit.
- Revision-sensitive work can use `--repo`, `--source-branch`, a workspace policy, and `--head-sha` to bind execution to a known checkout.
- Codex App uses host-tool actions and receipts. Follow the [transport protocol](protocol.md#codex-transports) for that path.

Task records, logs, and canonical artifacts stay in the configured state directory. The temporary workspace and prompt files in this example are caller-owned; remove them when you no longer need them.
