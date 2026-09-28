# Agent Lord supervision

Multi-task waiting, persistent task sets, and the passive request inbox. Envelopes, execution contracts, error taxonomy, and recovery semantics live in [protocol.md](protocol.md); provider transport details live in [transports.md](transports.md).

## Persistent task sets

Task sets hold caller-selected membership and received-result acknowledgements under the private state directory's `task-sets/`. They are passive: no automatic dispatch, graph expansion, content review, or Git integration.

```sh
node core/dist/cli.js run-create --run-id book --task-id chapter-1 --task-id chapter-2 --nodes-file /tmp/book-nodes.json
node core/dist/cli.js checkpoint --run-id book --include-response
# After receiving and processing a terminal actionable item's result:
node core/dist/cli.js run-ack --run-id book --receipt <receipt-from-that-item>
node core/dist/cli.js run-status --run-id book
# Explicitly add a new assignment, then dispatch it through the usual start command:
node core/dist/cli.js run-add --run-id book --task-id chapter-3 --nodes-file /tmp/chapter-3-node.json
```

For new ordinary multi-endpoint work, use [node provenance and reporting](scheduling-updates.md) to register role sources before `start --run-id`. Existing task sets without node metadata remain readable and report `provenance_status: unavailable`; they are not retroactively authorized.

Registration may precede dispatch. Unobserved members appear as `not_observed`; they are not silently marked complete or failed. Repeating `run-create` with identical members is idempotent; use `run-add` for additions. `--run-id` is mutually exclusive with explicit `--task-id` / `--starting-task-id` checkpoint selectors. Membership for a running checkpoint is fixed at entry; additions join the next checkpoint.

A terminal actionable result includes a durable `receipt`. Returning it does **not** consume the result. After a caller restart, an unacknowledged result is delivered again. `run-ack` is idempotent and accepts only receipts already issued by that set. Acknowledgement suppresses that exact operation/result on subsequent checkpoints, while other tasks remain supervised. A later turn, recovery operation, or changed terminal delivery/artifact/error produces a new receipt. Pending host actions are never suppressed by terminal acknowledgements. Receipt writes use the existing state lock and atomic-file primitives; concurrent readers may see duplicates, so this is at-least-once delivery with explicit acknowledgement, not exactly-once execution.

A result nobody acknowledges is also a liveness signal. The detached execution worker stays behind after its operation ends; when the task belongs to a run, no run acknowledged that exact result, and no later operation continued the task within `control.result_alert_seconds` (default 1800; `0` disables), it appends a `result-unreceived` event to the task and runs the alert command once. An explicit command replaces the built-in channels: `AGENT_LORD_RESULT_ALERT_COMMAND` (run by `/bin/sh -c`), else `result_alert_command` from the provider configuration (an argv array); it receives the alert as JSON on stdin and a one-line summary in `AGENT_LORD_ALERT_MESSAGE`. Otherwise the worker tries, in order until one succeeds: a Feishu direct message sent by `lark-cli` on `PATH` as its app bot to the user logged in to `lark-cli` (or to `AGENT_LORD_RESULT_ALERT_FEISHU_USER_ID`), then a macOS notification. Each attempt is recorded as `result-alert-sent` or `result-alert-failed` with its channel; with no channel left, only the `result-unreceived` event remains. The watch lives in that worker process, so a reboot or a killed worker drops it; operations finalized by `checkpoint` itself are not watched, because a caller was present.

`run-status` reads current operation/delivery states; it never consumes a result. `all_terminal` and `all_results_acknowledged` do not imply success or semantic acceptance: failed results can also be acknowledged. A fully acknowledged terminal set returns quiet immediately instead of waiting out the window. Existing task-ID checkpoints retain their snapshot behavior.

### Execution decoupled from waiting

The CLI's `start`, `turn`, `handoff`, and any `recover` that opens a new turn first persist the operation, then launch an independent `execution-worker` and return a `RUNNING` receipt. The background controller owns the provider process, the execution write lease, the final result, and the exit credentials; the process that invoked the CLI or a checkpoint may exit without stopping execution. `--include-response` carries the final text only at terminal state — collect results with `checkpoint`. After the receipt, a task does not depend on the host retaining the original start handle; only a still-running checkpoint handle is resumed.

The controller PID is written into the operation before the provider launches, and the worker verifies that it is the registered owner; a repeated dispatch reuses the operation. The gap while the write lease changes hands is covered by the non-terminal operation, which keeps blocking other writers. A failure of the controller itself is still recovered through the existing checkpoint path and never replays the original prompt automatically. Embedded calls using the TypeScript `AgentLord` / `main` directly keep synchronous compatibility and may opt into background execution explicitly; the production CLI defaults to the background controller.

## `check` versus `checkpoint`

The two commands are not interchangeable:

- `check --task-id <id>` reconstructs one task's full current envelope and never supervises. For a `codex-app` task it also creates the next polling read action. When the recorded controller process for a non-terminal local CLI operation is gone, the envelope adds `observed.supervision = {"controller_state": "exited", "recovery_command": "checkpoint"}`; that hint is advice, not recovery.
- `checkpoint` fences, recovers terminal facts, terminalizes a dead controller's operation, or waits. It returns compact `active` entries rather than full envelopes. The separate `recover` command consumes an emitted MCode continuation action and starts a bounded new turn on the same Session.

So a `RUNNING` envelope from `check` never becomes terminal by itself: run `checkpoint` when the hint appears or when the caller asked for supervision.

## Actionable-only checkpoint supervision

Repeat `--task-id` to supervise a caller-selected set in one checkpoint; omit it to freeze the set of active tasks observed when the call starts. Actionable wake returns `CHECKPOINT_ACTIONABLE` with every currently terminal or pending-action envelope for the selected tasks. This is a durable snapshot, not a destructive dequeue: repeated calls may return a previously seen envelope, and a later actionable task is returned alongside it instead of being lost or starved. Task selection is the seam for a caller-owned dependency or next-dispatch policy; checkpoint itself neither evaluates dependencies nor dispatches another operation.

### Starting supervision window

`--task-id` requires the id to be known already and still fails with `TASK_UNKNOWN` and exit `2` on a typo. Repeat `--starting-task-id` for a task the caller has just dispatched: that id alone may have no operation and no task record yet, and the same id must not appear in both lists. Once its operation appears inside the window it is scanned, fenced, recovered, and returned exactly like any other selected task, including an operation that is already terminal when first observed. Other selected tasks stay supervised throughout.

Every return that used `--starting-task-id` carries `starting[]`, one entry per declared id, so a starting task is never silently pending:

| `phase`              | Meaning                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `not_observed`       | Neither an operation nor a task record exists. Worktree preparation runs before the operation record is created, so this window is real. |
| `operation_recorded` | The operation record exists; the provider endpoint identity is not durable yet.                                                          |
| `task_established`   | A task record exists, so the endpoint identity was persisted (MCode at its first session event, Claude and Codex CLI at publication).    |

`not_observed` reports only what the state directory shows. It is not evidence that the dispatch process died, never started, or failed; a `task_id` cannot carry that information. The dispatch command's own exit status and error envelope remain the authority on dispatch failure, and checkpoint never fabricates one.

Actionable means exactly:

- an already-pending or newly-created `ACTION_REQUIRED` action;
- `SUCCEEDED`, `ERROR`, or `NEEDS_DECISION` terminal state;
- failure to preserve the saved identity during automatic recovery, including exhausted provider or recovery-controller budget.

`updated_at`, progress sequence changes, provider output, tool activity, and other benign progress update durable state without returning. `suspected_stall` and `recovering` are also internal while the saved retry plan and session identity permit automatic handling. The TypeScript control plane polls process/log/journal state at a short interval using Node.js timers and filesystem APIs; this polling runs inside the checkpoint command and consumes no Agent token. Portable event notification can replace that polling behind the same interface later.

The quiet deadline comes from `control.checkpoint_seconds`, whose default is 600 seconds; `--seconds` overrides one call. Actionable state still returns as soon as it appears: the command reads the state files every 250 ms and exits on the first terminal or actionable result, and host wait limits such as Codex's are upper bounds that end when the command exits. A long window therefore costs nothing while a result is on its way, and a short one only multiplies caller model calls. Match the host's wait mechanism to the window as described in [Waiting and reporting](../SKILL.md#waiting-and-reporting). Deadline expiry returns `CHECKPOINT_QUIET` and exit `124`. An automatic selection with no active task returns quiet immediately. Each `active` item contains task/operation/provider identity, status and progress sequence, plus content-free activity fields when available: last event/tool, active tool names/count, last progress timestamp and its age in seconds. MCode removes completed tools from that active set and clears it at terminal state. Full operation state stays in the journal and remains available through `check`.

One checkpoint parses each task, operation, and action record at most once per tick, and skips records it has already attributed to a task outside the selection. Across ticks of the same checkpoint call, a record whose file stat identity (mtime, size, inode) is unchanged reuses the previously parsed value instead of being re-read; atomic replacement of any record changes that identity, so cross-process updates are always observed. Attribution uses only `task_id` and `operation_id`, which exclusive record creation writes once and never rewrites; it is never inferred from an identifier prefix, because identifiers are caller-supplied.

Claude controller-death retry recovery is launched as a private Node.js worker using the same compiled TypeScript runtime. A kernel-managed controller lease spans operation preparation and the entire retry loop and is released automatically when its process exits. Checkpoint takes over only after that lease is obtainable and the durable owner is no longer live; retry state and ownership are updated in one journal mutation. The launch count plus frozen retry plan bounds takeover, so a long healthy recovery may outlive one quiet interval without duplicate dispatch.

Before Claude retry recovery, POSIX supervision fences the complete process group with TERM, then KILL after the grace interval, and confirms the group disappeared. Windows uses the platform process-tree termination command and confirms process exit. Failure to complete the fence is terminal and no recovery attempt starts. A prompt is `not-delivered` only after a definite launch failure. Once Claude delivery is `delivery-unknown` or `stdin-attached`, recovery uses one uniquely marked continuation on the same session UUID after a successful fence; if the possible provider process cannot be identified and fenced, recovery fails closed. Every exhausted retry path emits `retryable=false`, no `safe_recovery`, and `details.retry_exhausted=true`.

MCode uses no automatic prompt replay. The first `session.started` or `session.resumed` event durably records Session, Turn, and Run identity and creates the task handle, so `check` can expose live progress. If its controller dies while the dedicated operation process group remains, `checkpoint` fences only that group and then evaluates the operation's own stream. A complete non-success terminal record is failure; a complete success is publishable only with a durably recorded zero exit code. Missing terminal facts, an unknown exit code, or an unfenceable delivery becomes `DELIVERY_UNKNOWN` with the saved Session retained. No checkpoint sends the prompt again or creates a replacement Session.

A Codex or MCode CLI operation can also die in `preparing`, before any provider pid exists. Checkpoint terminalizes that window from the journal, without guessing: when `provider_command` was never recorded the launch definitely did not happen, so the operation fails with retryable `PROCESS_EXITED_WITHOUT_RESULT` and `RETRY_SAME_COMMAND`; when `provider_command` was already recorded the launch may have happened and cannot be fenced, so the operation becomes `DELIVERY_UNKNOWN` as `NEEDS_DECISION`. A live controller pid keeps the operation quiet.

Codex App host tools remain model-mediated. Checkpoint returns an existing action promptly but does not synthesize a polling read at the quiet deadline; call `check`, or pass `--auto-read` to the preceding `accept`, when a new App read action is intended.

## Passive request inbox

```bash
node core/dist/cli.js request-add --request-id followup-1 --intent turn \
  --task-id refactor-auth --message-file /private/tmp/followup.txt \
  --user-request-file /private/tmp/user-said.txt --source-kind codex
node core/dist/cli.js request-list --status pending
node core/dist/cli.js request-dispatch --request-id followup-1 --include-response
```

`request-add`, `request-get`, `request-list`, `request-cancel`, and `request-dispatch` give the scheduling caller a durable place for an instruction it is not ready to dispatch. The inbox is passive by construction: it has no scheduler, no dependency evaluation, no background wakeup, and no daemon. Registration starts nothing, and only an explicit `request-dispatch` becomes a `start` or a `turn`.

A request record follows `schemas/request-v1.schema.json` and lives in the same private state directory under the same atomic-write and per-record lease rules as every other record. `--intent start` freezes the provider, target or repository, and the same dispatch options `start` accepts; `--intent turn` continues a saved endpoint and accepts only delivery requirements. Those options are validated against the live execution contract, source identity, workspace policy, and recovery boundary at dispatch, exactly as a direct `start` or `turn` would be — registration performs no contract validation and grants no authorization.

Identity and re-entrancy:

- `intent_sha256` covers the intent, the message digest, and the original user request. The same `request_id` registered again with the same digest returns the original record unchanged; a different digest is `REQUEST_CONFLICT` with exit `2` and never overwrites what was registered.
- Two different `request_id` values may carry identical text. They are two legitimate requests.
- `source` is descriptive provenance for filtering only. It is never an identity claim, never an authorization, and never widens the Observer allowlist.

Consumption is single-operation by construction:

- The consumed `request_id` is written inside the operation record's own atomic creation. The operation log — not a second index file — is the authority for the association, so nothing depends on two JSON files committing together.
- `request-dispatch` holds the request lease for the whole dispatch, so a concurrent second consumer gets a retryable `STATE_BUSY` instead of racing into a second operation.
- Before dispatching, and after any dispatch failure, the operation log is searched for that `request_id`. A consumer that crashed after journaling its operation, or whose provider then failed, therefore adopts the existing operation on retry rather than opening a new turn. `request-get` and `request-list` rebuild the same association, so a request record left at `pending` by a crash is repaired from the operation log.
- `request-cancel` on a request that already has an operation is `REQUEST_CONFLICT`; `request-dispatch` on a cancelled request is `REQUEST_CANCELLED`. Whichever holds the lease first wins, and the outcome is always one of those two.
- When the target task is busy, `request-dispatch` returns `REQUEST_PENDING` with the underlying `pending_reason` and leaves the request pending. Nothing is injected into the running operation, no endpoint is substituted, and no retry is scheduled.

Three claims stay separate and must not be collapsed in a report:

1. `status: "pending"` — the instruction is registered and durable.
2. `status: "dispatched"` with `operation_id` — a logical operation exists for it.
3. The operation envelope's own status, artifact, and `delivery` — whether the provider actually received or completed the message.

An operation record does not prove provider receipt. `DELIVERY_UNKNOWN` keeps its existing recovery and decision boundary; the inbox neither bypasses it nor re-sends the message, and it makes no exactly-once claim about provider-side effects.
