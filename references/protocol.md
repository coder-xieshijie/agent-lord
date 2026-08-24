# Agent Lord deterministic protocol

Read this reference when supervising multiple tasks, diagnosing a non-terminal envelope, or changing an adapter or state record.

## Public result envelope

Every command prints one JSON object. `schemas/result-v1.schema.json` is the maintained shape.

| Status | Meaning | Caller action |
|---|---|---|
| `ACTION_REQUIRED` | A Codex App host-tool action is durably pending | Invoke the exact tool and arguments, then `accept` its raw result |
| `RUNNING` | The provider operation is preparing, progressing, waiting, stalled, or recovering | Inspect `observed.supervision`; use `check` or a bounded `checkpoint` |
| `SUCCEEDED` | Endpoint, execution contract, and final artifact passed the available checks | Consume the artifact |
| `ERROR` | Deterministic validation or provider execution failed | Use only the emitted safe recovery, if any |
| `NEEDS_DECISION` | Recovery changes identity, authority, source, or delivery semantics | Stop for an explicit decision |
| `CHECKPOINT_ACTIONABLE` | One or more selected tasks have durable actionable state | Process every envelope in `actionable` |
| `CHECKPOINT_QUIET` | No actionable state change occurred in the bounded interval | Exit `124`; resume the foreground checkpoint loop later |

An `ACTION_REQUIRED` record is idempotent. Re-running the same `start`, `turn`, or checkpoint returns the already-pending action instead of creating a second provider operation.

Dispatch is serialized by a per-task filesystem lock. The journal is written before provider execution, so a concurrent caller either receives the existing operation or `STATE_BUSY`; it cannot create a second endpoint or turn.

## Actionable-only checkpoint supervision

Repeat `--task-id` to supervise a caller-selected set in one checkpoint; omit it to freeze the set of active tasks observed when the call starts. Actionable wake returns `CHECKPOINT_ACTIONABLE` with every currently terminal or pending-action envelope for the selected tasks. This is a durable snapshot, not a destructive dequeue: repeated calls may return a previously seen envelope, and a later actionable task is returned alongside it instead of being lost or starved. Task selection is the seam for a caller-owned dependency or next-dispatch policy; checkpoint itself neither evaluates dependencies nor dispatches another operation.

Actionable means exactly:

- an already-pending or newly-created `ACTION_REQUIRED` action;
- `SUCCEEDED`, `ERROR`, or `NEEDS_DECISION` terminal state;
- failure to preserve the saved identity during automatic recovery, including exhausted provider or recovery-controller budget.

`updated_at`, progress sequence changes, provider output, tool activity, and other benign progress update durable state without returning. `suspected_stall` and `recovering` are also internal while the saved retry plan and session identity permit automatic handling. The Python control plane polls process/log/journal state at a short interval using only the standard library; this polling runs inside the checkpoint command and consumes no Agent token. Portable event notification can replace that polling behind the same interface later.

The quiet deadline comes from `control.checkpoint_seconds`, whose default is 150 seconds; `--seconds` overrides one call. Deadline expiry returns `CHECKPOINT_QUIET` and exit `124`. Each `active` item is compact: task id, operation id, provider, operation status, supervision state, and progress sequence only. Full operation state stays in the journal and remains available through `check`.

Controller-death recovery is launched as a private Python worker, not another Agent. A kernel-managed controller lease spans operation preparation and the entire retry loop and is released automatically when its process exits. Checkpoint takes over only after that lease is obtainable and the durable owner is no longer live; retry state and ownership are updated in one journal mutation. The launch count plus frozen retry plan bounds takeover, so a long healthy recovery may outlive one quiet interval without duplicate dispatch.

Before recovery, POSIX supervision fences the complete process group with TERM, then KILL after the grace interval, and confirms the group disappeared. Windows uses the platform process-tree termination command and confirms process exit. Failure to complete the fence is terminal and no recovery attempt starts. A prompt is `not-delivered` only after a definite launch failure. Once delivery is `delivery-unknown` or `stdin-attached`, recovery uses one uniquely marked continuation on the same session UUID after a successful fence; if the possible provider process cannot be identified and fenced, recovery fails closed. Every exhausted retry path emits `retryable=false`, no `safe_recovery`, and `details.retry_exhausted=true`.

Codex App host tools remain model-mediated. Checkpoint returns an existing action promptly but does not synthesize a polling read at the quiet deadline; call `check` when a new App read action is intended.

## State ownership

The script is the only writer under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`:

```text
<task-id>.json                 durable endpoint and execution contract
operations/<operation-id>.json
actions/<action-id>.json       model-mediated Codex tool request
events/<task-id>.jsonl         append-only transitions
artifacts/<task-id>/<operation-id>.md
logs/<operation-id>[.attempt-N].stdout
logs/<operation-id>[.attempt-N].stderr
logs/<operation-id>.final       Codex CLI final response only
locks/
tmp/
worktrees/<task-id>/            default local source-branch worktree location
```

Current state comes from task, operation, and provider truth. `events/*.jsonl` is a wake/audit log, not current-state authority.

Task handles follow `schemas/task-v2.schema.json`. Version 1 records are normalized for inspection, but another turn is blocked until `scripts/task_store.py upgrade` attaches an explicit model, effort, retry, permission, and optional source contract. Operations and actions follow their corresponding schemas.

## Execution contract

The durable task record owns:

- provider and immutable endpoint id;
- current route and route history;
- target;
- explicit model and effort;
- an ordered retry plan whose stages freeze model and attempt budget;
- explicit permission posture (`dangerously_bypass` by default; `--read-only` is an explicit override);
- fixed source head/base when supplied.

Provider arguments enforce model and effort on every operation. Claude success requires observable main-model metadata from the same session. `system.init.model` and `assistant.message.model` are authoritative; `result.modelUsage` is a fallback when it names one unambiguous model. Provider diagnostic lines are parsed separately from JSON message content. A failed `query_source=auto_mode` model becomes a sanitized `AUXILIARY_MODEL_UNRECOGNIZED` warning when the matching main result succeeded, without consuming retry budget or triggering fallback. Codex CLI stores the `thread.started` UUID and requires `turn.completed`; Codex App actions carry the explicit contract. Importing a Codex rollout with `export-artifact` additionally verifies `turn_context` model and effort.

Permission policy lives in `config/providers.json`; the selected mode is frozen in the durable task contract and resolved again before every operation. Claude Code maps bypass to `--dangerously-skip-permissions`; Codex CLI maps it to `--dangerously-bypass-approvals-and-sandbox`. Codex App exposes no approval or sandbox argument, so it records bypass as `host-inherited-unverified` and read-only as `instruction-only`.

Claude defaults to `claude-opus-5` and `high` with five primary attempts. Fable-family tasks append a five-attempt `claude-opus-5` fallback stage. The primary and fallback stages reuse the same session UUID; after the frozen plan is exhausted, the terminal error has no automatic recovery. Codex CLI and Codex App default to `gpt-5.6-sol` with `high`; unqualified `codex` resolves to `codex-cli`.

Claude emits stream progress into the operation journal. Its supervision state is `provider_wait`, `progressing`, `tool_wait`, `suspected_stall`, `provider_failed`, or `recovering`. The default provider no-progress deadline is 900 seconds; known tool activity receives a separate 3600-second deadline. Provider configuration also owns the progress poll and termination grace intervals.

### Local worktree preparation

Local Claude and Codex CLI starts may replace `--target` with `--repo`, `--source-branch`, `--workspace-policy reuse-or-create`, and a fixed `--head-sha`. The control plane reuses the one clean worktree bound to the exact local branch or creates it from an already-available local, `origin` tracking, or commit ref. It performs no fetch and never removes the worktree. New worktrees default to `worktrees/<task-id>` under the Agent Lord state directory; `--worktree-root` overrides only that parent.

The resolved worktree path becomes the operation and durable task target, so every later `turn` verifies and reuses the same checkout. A dirty worktree, conflicting branch head, unavailable fixed commit, ambiguous binding, or occupied destination fails with the existing `SOURCE_MISMATCH` or `SOURCE_UNVERIFIED` result. Existing `--target` starts keep their original behavior.

## Error taxonomy

| Code | Meaning | Default disposition |
|---|---|---|
| `CONFIG_INVALID` | Invalid task input or unsupported configured value | Correct input |
| `TASK_EXISTS` / `TASK_UNKNOWN` | Logical identity conflict or missing task | Correct identity; do not guess |
| `EXECUTION_CONTRACT_REQUIRED` | A legacy handle lacks model, effort, permission, or source truth | Explicitly upgrade the same handle before continuing |
| `OPERATION_IN_FLIGHT` | Previous turn is not terminal | Check the same operation |
| `SOURCE_MISMATCH` / `SOURCE_UNVERIFIED` | Fixed source cannot be proven | Correct the checkout or obtain a decision |
| `MODEL_UNRECOGNIZED` | Provider did not recognize the requested main model and no valid matching main result exists | Retry the same endpoint with the saved contract |
| `MODEL_MISMATCH` / `MODEL_UNVERIFIED` | Observed result does not prove the requested model | Invalidate the operation; retry the same endpoint |
| `EFFORT_MISMATCH` / `EFFORT_UNVERIFIED` | Provider log contradicts or cannot prove saved effort | Invalidate and retry the same endpoint |
| `ENDPOINT_ROUTE_STALE` | Codex host routing changed | Resolve the same `threadId`, update route history, retry once |
| `ENDPOINT_GONE` | Same endpoint cannot be rediscovered | `NEEDS_DECISION`; replacement is a new identity |
| `DELIVERY_UNKNOWN` | Send lacks a trustworthy receipt | Read the same endpoint for the operation marker before resend |
| `ENDPOINT_MISMATCH` | Provider result belongs to another endpoint | Fail closed |
| `RESULT_INVALID` | Provider output lacks the required result shape | Fail closed and preserve private logs |
| `PROCESS_EXITED_WITHOUT_RESULT` | Local provider process disappeared before terminal publication | Inspect private logs, then retry the same endpoint if safe |
| `PROVIDER_STALLED` | Claude stayed alive but produced no stream progress before the saved control deadline | Fence the old process group, then resume the same session with a continuation query |
| `IDENTITY_CONFLICT` / `STATE_CONFLICT` | Durable records disagree about endpoint or terminal identity | Stop and repair explicitly |
| `STATE_BUSY` / `STATE_CORRUPT` | Concurrent writer or invalid durable state | Retry the same command or repair state explicitly |

## Safe recovery line

The implementation may perform only identity-preserving recovery automatically:

- re-read status;
- reapply the saved model/effort;
- execute the saved Claude retry stages on the same session;
- rediscover the host for the same Codex `threadId`;
- return the same pending action for an identical in-flight message;
- inspect an ambiguous delivery for its operation marker;
- recover a completed local CLI result from the prewritten journal after the original controller disappears;
- fence a stalled Claude process group, confirm exit, and append one uniquely marked continuation query through `--resume` on the same session;
- let the private recovery controller claim that same recovery when the original controller is dead.

The implementation returns `NEEDS_DECISION` before creating a replacement endpoint, changing provider/model/effort/source, widening permissions, or performing external writes.

## Codex transports

Codex CLI is the default Codex transport. It runs non-interactively, extracts the endpoint from `thread.started`, and resumes only by the exact saved session UUID. The operation marker remains in the prompt so an exported rollout can be tied to one operation.

### Codex App transport seam

The current adapter emits model-mediated actions because no verified shell bridge owns the same Desktop-visible endpoint lifecycle. Tool results may be JSON objects, JSON strings, or plain errors; `accept` unwraps and classifies them.

The route-recovery sequence is deterministic:

```text
send/read -> No AppServerManager
          -> list_threads(limit=50)
          -> find exact threadId client-side
          -> append route history
          -> retry the original action with the same operation id and prompt marker
```

App routing is independent of the CLI session namespace. Never migrate an existing `codex-app` task handle to `codex-cli` implicitly.

`config/providers.json` owns provider capabilities plus checkpoint, stall, termination grace, progress poll, dead-process grace, and lock retry constants. Dynamic facts such as `hostId`, PID, process group, controller lease/launch count, recovery marker, operation state, and observed model never belong in configuration.
