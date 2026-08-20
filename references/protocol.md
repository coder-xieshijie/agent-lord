# Agent Lord deterministic protocol

Read this reference when an envelope is not terminal, when an error requires diagnosis, or when changing an adapter or state record.

## Public result envelope

Every command prints one JSON object. `schemas/result-v1.schema.json` is the maintained shape.

| Status | Meaning | Caller action |
|---|---|---|
| `ACTION_REQUIRED` | A Codex App host-tool action is durably pending | Invoke the exact tool and arguments, then `accept` its raw result |
| `RUNNING` | The provider operation exists but is not terminal | `check` or a bounded `checkpoint` |
| `SUCCEEDED` | Endpoint, execution contract, and final artifact passed the available checks | Consume the artifact |
| `ERROR` | Deterministic validation or provider execution failed | Use only the emitted safe recovery, if any |
| `NEEDS_DECISION` | Recovery changes identity, authority, source, or delivery semantics | Stop for an explicit decision |
| `CHECKPOINT_QUIET` | No actionable state change occurred in the bounded interval | Exit `124`; resume the foreground checkpoint loop later |

An `ACTION_REQUIRED` record is idempotent. Re-running the same `start`, `turn`, or checkpoint returns the already-pending action instead of creating a second provider operation.

Dispatch is serialized by a per-task filesystem lock. The journal is written before provider execution, so a concurrent caller either receives the existing operation or `STATE_BUSY`; it cannot create a second endpoint or turn.

## State ownership

The script is the only writer under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`:

```text
<task-id>.json                 durable endpoint and execution contract
operations/<operation-id>.json
actions/<action-id>.json       model-mediated Codex tool request
events/<task-id>.jsonl         append-only transitions
artifacts/<task-id>/<operation-id>.md
logs/<operation-id>.stdout
logs/<operation-id>.stderr
locks/
tmp/
```

Current state comes from task, operation, and provider truth. `events/*.jsonl` is a wake/audit log, not current-state authority.

Task handles follow `schemas/task-v2.schema.json`. Version 1 records are normalized for inspection, but another turn is blocked until `scripts/task_store.py upgrade` attaches an explicit model, effort, permission, and optional source contract; migration never guesses these missing facts. Operations and actions follow their corresponding schemas.

## Execution contract

The durable task record owns:

- provider and immutable endpoint id;
- current route and route history;
- target;
- explicit model and effort;
- explicit permission posture (`dangerously_bypass` by default; `--read-only` is an explicit override);
- fixed source head/base when supplied.

Provider arguments enforce model and effort on every operation. Claude success also requires observable model metadata. Codex host-tool actions carry the explicit contract; importing a Codex rollout with `export-artifact` additionally verifies `turn_context` model and effort.

Permission policy lives in `config/providers.json`; the selected mode is frozen in the durable task contract and resolved again before every operation. Claude Code maps the default `dangerously_bypass` posture to `--dangerously-skip-permissions`; a read-only override maps to `--permission-mode plan`. Codex CLI names the equivalent bypass flag `--dangerously-bypass-approvals-and-sandbox`, but Agent Lord's Codex adapter uses Codex App host actions, whose create/send schema exposes no approval or sandbox argument. It records default enforcement as `host-inherited-unverified`; read-only remains `instruction-only`. Neither state is misreported as a CLI argument enforced by the App transport.

The default bounded checkpoint is 150 seconds. `--seconds` remains an explicit per-call override.

## Error taxonomy

| Code | Meaning | Default disposition |
|---|---|---|
| `CONFIG_INVALID` | Invalid task input or unsupported configured value | Correct input |
| `TASK_EXISTS` / `TASK_UNKNOWN` | Logical identity conflict or missing task | Correct identity; do not guess |
| `EXECUTION_CONTRACT_REQUIRED` | A legacy handle lacks model, effort, permission, or source truth | Explicitly upgrade the same handle before continuing |
| `OPERATION_IN_FLIGHT` | Previous turn is not terminal | Check the same operation |
| `SOURCE_MISMATCH` / `SOURCE_UNVERIFIED` | Fixed source cannot be proven | Correct the checkout or obtain a decision |
| `MODEL_UNRECOGNIZED` | Provider rejected/rerouted the requested model | Retry the same endpoint with the saved contract |
| `MODEL_MISMATCH` / `MODEL_UNVERIFIED` | Observed result does not prove the requested model | Invalidate the operation; retry the same endpoint |
| `EFFORT_MISMATCH` / `EFFORT_UNVERIFIED` | Provider log contradicts or cannot prove saved effort | Invalidate and retry the same endpoint |
| `ENDPOINT_ROUTE_STALE` | Codex host routing changed | Resolve the same `threadId`, update route history, retry once |
| `ENDPOINT_GONE` | Same endpoint cannot be rediscovered | `NEEDS_DECISION`; replacement is a new identity |
| `DELIVERY_UNKNOWN` | Send lacks a trustworthy receipt | Read the same endpoint for the operation marker before resend |
| `ENDPOINT_MISMATCH` | Provider result belongs to another endpoint | Fail closed |
| `RESULT_INVALID` | Provider output lacks the required result shape | Fail closed and preserve private logs |
| `PROCESS_EXITED_WITHOUT_RESULT` | Local provider process disappeared before terminal publication | Inspect private logs, then retry the same endpoint if safe |
| `IDENTITY_CONFLICT` / `STATE_CONFLICT` | Durable records disagree about endpoint or terminal identity | Stop and repair explicitly |
| `STATE_BUSY` / `STATE_CORRUPT` | Concurrent writer or invalid durable state | Retry the same command or repair state explicitly |

## Safe recovery line

The implementation may perform only identity-preserving recovery automatically:

- re-read status;
- reapply the saved model/effort;
- rediscover the host for the same Codex `threadId`;
- return the same pending action for an identical in-flight message;
- inspect an ambiguous delivery for its operation marker.
- recover a completed Claude result from the prewritten journal after the original controller disappears.

The implementation returns `NEEDS_DECISION` before creating a replacement endpoint, changing provider/model/effort/source, widening permissions, or performing external writes.

## Codex App transport seam

The current adapter emits model-mediated actions because no verified shell bridge owns the same Desktop-visible endpoint lifecycle. Tool results may be JSON objects, JSON strings, or plain errors; `accept` unwraps and classifies them.

The route-recovery sequence is deterministic:

```text
send/read -> No AppServerManager
          -> list_threads(limit=50)
          -> find exact threadId client-side
          -> append route history
          -> retry the original action with the same operation id and prompt marker
```

If a supported shell or App Server transport later becomes available, replace only the Codex adapter. Workflow state, contracts, errors, and artifacts stay unchanged.

`config/providers.json` owns provider capabilities plus the checkpoint, dead-process grace, and lock retry constants. Dynamic facts such as `hostId`, PID, operation state, and observed model never belong in configuration.
