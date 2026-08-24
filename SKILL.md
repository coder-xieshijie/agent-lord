---
name: agent-lord
description: Dispatch and supervise durable Codex CLI, Codex App, or Claude Code endpoints through deterministic scripts that enforce execution contracts, source identity, recovery, and sanitized results. Use when a Codex Desktop user asks to start or continue external Codex or Claude work; not for in-process subagents, CI jobs, or general DAG workflows.
---

# Agent Lord

Route one logical task to one durable endpoint. Treat `scripts/agent_lord.py` as the control plane: the model supplies intent and performs Codex App host-tool actions when requested, while the script owns provider defaults, validation, retries, state, recovery, and artifact extraction.

## Invariants

- Start only with explicit user authorization. Preserve user choices for target, source revision, model, effort, permission posture, and external writes.
- Keep one endpoint per `task_id` and one in-flight operation per task. Continue the saved endpoint; replacement requires an explicit decision.
- Let the dispatch lock and operation journal enforce that invariant across concurrent controller processes; do not implement a second caller-side lock.
- Store task, operation, action, event, log, and artifact state under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`, never in the target repository.
- Freeze the resolved model, effort, retry plan, permission posture, and source contract when the task starts; every later turn reapplies them.
- Use fixed full SHAs for revision-sensitive work. Local CLI providers refuse a working directory whose `HEAD` differs from the saved contract.
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

## Provider routing and defaults

- `claude-cli`: default to `claude-opus-5` with `xhigh`. A model-only request still uses `xhigh`. The default retry plan permits five attempts. When the primary model belongs to the Fable family, five failed attempts are followed by up to five `claude-opus-5` attempts on the same session; only exhaustion of both stages is terminal.
- `codex` or `codex-cli`: use Codex CLI, defaulting to `gpt-5.6-sol` with `xhigh`. Treat an unqualified user request for “Codex” as this route.
- `codex-app`: use only when the user explicitly requests the App/Desktop endpoint. Existing App task handles remain App tasks.

Explicit user values override defaults. `--retry-attempts` overrides the primary Claude stage; the configured Fable fallback budget remains independent. `config/providers.json` is the executable source of truth for these policies.

## Local CLI adapters

Claude maps the default `dangerously_bypass` posture to `--dangerously-skip-permissions`; `--read-only` maps to `--permission-mode plan`. It verifies the main model from same-session `system` / `assistant` / `result` metadata. A failed auxiliary `auto_mode` model is published as a sanitized warning when the matching main result succeeded; it does not consume retry budget or trigger fallback. It launches from the saved working directory, captures private provider logs, and journals every retry attempt. A later checkpoint can recover a completed attempt after controller loss.

Codex CLI maps `dangerously_bypass` to `--dangerously-bypass-approvals-and-sandbox`; `--read-only` applies explicit sandbox and approval config arguments. It runs `codex exec --json`, stores `thread.started.thread_id` as endpoint identity, publishes only `--output-last-message`, and continues through `codex exec resume <session-id>` while reapplying model, effort, and permissions.

## Codex App action handshake

Codex App host tools are model-side tools, so the script emits an action instead of guessing a shell bridge. The model is a transport carrier:

1. Call exactly `action.tool` with `action.arguments`.
2. Preserve the complete raw tool result in a temporary file outside the repository.
3. Run `python3 scripts/agent_lord.py accept --action-id <id> --result-file <file>`.
4. Continue from the new envelope.

The App adapter uses only the supported minimal `list_threads` arguments, treats `threadId` as endpoint identity and `hostId` as mutable routing, and rebinds the same thread before retrying a route-stale send. Its action schema has no sandbox or approval field, so bypass is recorded as `host-inherited-unverified` and read-only remains instruction-only.

## Artifacts and compatibility

Successful local CLI turns automatically publish a final-response-only artifact. Codex App reads do the same; `export-artifact` can extract the final assistant message and model/effort metadata from an existing Claude or Codex JSONL without copying reasoning. A Codex export must contain the exact operation marker, so an unrelated turn from the same rollout cannot be mistaken for this result.

Version 1 task handles remain readable, but `turn` fails closed because those records did not preserve model, effort, permission, or source. Use `scripts/task_store.py upgrade` with explicit values before continuing one; it never infers the missing contract. The compatibility interface also supports explicit registration and cleanup; new work uses `scripts/agent_lord.py`.

For the action/result schema, state layout, error codes, and recovery permissions, read [references/protocol.md](references/protocol.md) when diagnosing an envelope or extending an adapter. This phase intentionally stops short of a general multi-agent workflow engine.
