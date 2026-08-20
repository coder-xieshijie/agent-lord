---
name: agent-lord
description: Dispatch and supervise durable Codex App or Claude Code endpoints through deterministic scripts that enforce execution contracts, source identity, recovery, and sanitized results. Use when a Codex Desktop user asks to start or continue external Codex or Claude work; not for in-process subagents, CI jobs, or general DAG workflows.
---

# Agent Lord

Route one logical task to one durable endpoint. Treat `scripts/agent_lord.py` as the control plane: the model supplies intent and performs requested Codex host-tool calls, while the script owns validation, state, error classification, safe same-endpoint recovery, and artifact extraction.

## Invariants

- Start only with explicit user authorization. Preserve user choices for target, source revision, model, effort, permission posture, and external writes.
- Keep one endpoint per `task_id` and one in-flight operation per task. Continue the saved endpoint; replacement requires an explicit decision.
- Let the dispatch lock and operation journal enforce that invariant across concurrent controller processes; do not implement a second caller-side lock.
- Store task, operation, action, event, log, and artifact state under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`, never in the target repository.
- Pass explicit model and effort on every turn when the user supplied them. A mismatched or unverifiable model result is not a successful turn.
- Use fixed full SHAs for revision-sensitive work. For Claude, the script refuses a working directory whose `HEAD` differs from the saved contract.
- Exchange sanitized artifacts, not raw provider logs or reasoning traces.

## Deterministic loop

1. Resolve the exact target and write the task prompt to a private temporary file outside the target repository. Remove caller-owned prompt/result files after the command has consumed them.
2. Inspect `python3 scripts/agent_lord.py start --help`, then run `start` with every explicit user choice. Do not recreate its preflight checks manually.
3. Process the returned envelope until terminal:
   - `ACTION_REQUIRED`: invoke the exact model-side tool and arguments in `action`; save the raw return value outside the repository, then pass it to `accept`.
   - `RUNNING`: use `check`, or run one bounded `checkpoint` (150 seconds by default) when the user requested supervision.
   - `SUCCEEDED`: use the returned artifact as the canonical response.
   - `ERROR`: follow `safe_recovery` only when present; otherwise report the structured error.
   - `NEEDS_DECISION`: stop for the authority named by the error. Never convert it into an implicit replacement, model change, source change, or permission expansion.
4. Start a later round with `turn` only after the previous operation is terminal. The script reapplies the saved execution contract and deduplicates an identical in-flight message.

`checkpoint` is a bounded foreground call. Exit `124` with `CHECKPOINT_QUIET` is a healthy quiet interval; run the next checkpoint after handling user input. An actionable Codex check returns `ACTION_REQUIRED` and exit `0`.

## Codex App action handshake

Codex App host tools are model-side tools, so the script emits an action instead of guessing a shell bridge. The model is a transport carrier:

1. Call exactly `action.tool` with `action.arguments`.
2. Preserve the complete raw tool result in a temporary file outside the repository.
3. Run `python3 scripts/agent_lord.py accept --action-id <id> --result-file <file>`.
4. Continue from the new envelope.

The adapter uses only the supported minimal `list_threads` arguments, treats `threadId` as endpoint identity and `hostId` as mutable routing, and rebinds the same thread before retrying a route-stale send. An ambiguous send is checked for its operation marker before any resend decision.

## Claude CLI

The default permission posture is `dangerously_bypass`. The Claude adapter maps it to Claude Code's real `--dangerously-skip-permissions` argument; `--read-only` overrides it with `--permission-mode plan`. The adapter launches directly from the saved working directory, feeds the prompt through a private temporary file, captures private provider logs, selects the last valid `type=result` object, and validates session identity, provider success, and observed model. `turn` always reapplies the saved model, effort, and permission posture. If the invoking controller disappears after launch, a later checkpoint recovers and validates a completed result from the saved operation journal instead of losing the turn.

The Codex endpoint in this skill is Codex App, not Codex CLI. Codex CLI calls the equivalent bypass flag `--dangerously-bypass-approvals-and-sandbox`, but the App create/send action schema has no sandbox or approval field. The adapter therefore records the default as `dangerously_bypass` with `host-inherited-unverified` enforcement and never claims that a CLI flag was passed. `--read-only` remains prompt-enforced only for this adapter.

## Artifacts and compatibility

Successful Claude turns automatically publish a final-response-only artifact. Codex results read through the host tool do the same; `export-artifact` can extract the final assistant message and model/effort metadata from an existing Claude or Codex JSONL without copying reasoning. A Codex export must contain the exact operation marker, so an unrelated turn from the same rollout cannot be mistaken for this result.

Version 1 task handles remain readable, but `turn` fails closed because those records did not preserve model, effort, permission, or source. Use `scripts/task_store.py upgrade` with explicit values before continuing one; it never infers the missing contract. The compatibility interface also supports explicit registration and cleanup; new work uses `scripts/agent_lord.py`.

For the action/result schema, state layout, error codes, and recovery permissions, read [references/protocol.md](references/protocol.md) when diagnosing an envelope or extending an adapter. This phase intentionally stops short of a general multi-agent workflow engine.
