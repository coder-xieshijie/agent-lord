# Agent Lord supervision

Multi-task waiting, persistent task sets, durable plan runs, durable workspace claims, and the passive request inbox. Envelopes, execution contracts, error taxonomy, and recovery semantics live in [protocol.md](protocol.md); provider transport details live in [transports.md](transports.md).

## Persistent task sets

Task sets hold caller-selected membership and received-result acknowledgements under the private state directory's `task-sets/`. They are passive: no automatic dispatch, graph expansion, content review, or Git integration.

```sh
node core/dist/cli.js run-create --run-id book --task-id chapter-1 --task-id chapter-2 --nodes-file /tmp/book-nodes.json
node core/dist/cli.js checkpoint --run-id book --seconds 120 --include-response
# After receiving and processing a terminal actionable item's result:
node core/dist/cli.js run-ack --run-id book --receipt <receipt-from-that-item>
node core/dist/cli.js run-status --run-id book
# Explicitly add a new assignment, then dispatch it through the usual start command:
node core/dist/cli.js run-add --run-id book --task-id chapter-3 --nodes-file /tmp/chapter-3-node.json
```

For new ordinary multi-endpoint work, use [node provenance and reporting](scheduling-updates.md) to register role sources before `start --run-id`. Existing task sets without node metadata remain readable and report `provenance_status: unavailable`; they are not retroactively authorized.

Registration may precede dispatch. Unobserved members appear as `not_observed`; they are not silently marked complete or failed. Repeating `run-create` with identical members is idempotent; use `run-add` for additions. `--run-id` is mutually exclusive with explicit `--task-id` / `--starting-task-id` checkpoint selectors. Membership for a running checkpoint is fixed at entry; additions join the next checkpoint.

A terminal actionable result includes a durable `receipt`. Returning it does **not** consume the result. After a caller restart, an unacknowledged result is delivered again. `run-ack` is idempotent and accepts only receipts already issued by that set. Acknowledgement suppresses that exact operation/result on subsequent checkpoints, while other tasks remain supervised. A later turn, recovery operation, or changed terminal delivery/artifact/error produces a new receipt. Pending host actions are never suppressed by terminal acknowledgements. Receipt writes use the existing state lock and atomic-file primitives; concurrent readers may see duplicates, so this is at-least-once delivery with explicit acknowledgement, not exactly-once execution.

`run-status` reads current operation/delivery states; it never consumes a result. `all_terminal` and `all_results_acknowledged` do not imply success or semantic acceptance: failed results can also be acknowledged. A fully acknowledged terminal set returns quiet immediately instead of waiting out the window. Existing task-ID checkpoints retain their snapshot behavior.

### Execution decoupled from waiting

The CLI's `start`, `turn`, `handoff`, and any `recover` that opens a new turn first persist the operation, then launch an independent `execution-worker` and return a `RUNNING` receipt. The background controller owns the provider process, the execution write lease, the final result, and the exit credentials; the process that invoked the CLI or a checkpoint may exit without stopping execution. `--include-response` carries the final text only at terminal state — collect results with `checkpoint`. After the receipt, a task does not depend on the host retaining the original start handle; only a still-running checkpoint handle is resumed.

The controller PID is written into the operation before the provider launches, and the worker verifies that it is the registered owner; a repeated dispatch reuses the operation. The gap while the write lease changes hands is covered by the non-terminal operation, which keeps blocking other writers. A failure of the controller itself is still recovered through the existing checkpoint path and never replays the original prompt automatically. Embedded calls using the TypeScript `AgentLord` / `main` directly keep synchronous compatibility and may opt into background execution explicitly; the production CLI defaults to the background controller.

## Durable plan runs

A plan run holds the frozen module plan and barrier state for the [plan-to-implement pipeline](pipelines/plan-to-implement.md) under the private state directory's `plan-runs/`. Like task sets it never dispatches: it accepts a plan, computes the ready set, refuses a transition that would break a barrier, and journals what happened.

```sh
node core/dist/cli.js plan-validate --plan-file /tmp/run/plan.json
node core/dist/cli.js plan-create --run-id feature-x --plan-file /tmp/run/plan.json --planner-task-id feature-x-planner
node core/dist/cli.js plan-status --run-id feature-x
node core/dist/cli.js plan-dispatch --run-id feature-x --module-id auth-core --task-id feature-x-auth-core
node core/dist/cli.js plan-deliver --run-id feature-x --module-id auth-core --state delivered
node core/dist/cli.js plan-integrate --run-id feature-x --task-id feature-x-integrator
node core/dist/cli.js plan-merge-request --run-id feature-x --repo /path/repo --mr-url <url> --head-sha <sha> --verification-file /tmp/run/verification.json
node core/dist/cli.js plan-report --run-id feature-x --report-file /tmp/run/report.md
```

`plan-validate` checks an [implementation-plan-v1](../schemas/implementation-plan-v1.schema.json) document and returns `PLAN_INVALID` with the offending detail. It is a pre-check and creates nothing.

**Completion is verified against endpoint records.** `plan-create` requires a successful planner task whose verified delivery files include the plan file, so a run cannot start from an arbitrary JSON document. `plan-deliver --state delivered` requires the module's task to exist, its current operation to have succeeded, and its declared delivery to be verified with a commit; that verified commit is adopted, and a disagreeing `--commit-sha` is rejected. Because the task's _current_ operation is used, an older success never covers a failed retry. `plan-merge-request` and `plan-report` require the integrator's current operation to have succeeded. Failures return `ENDPOINT_UNVERIFIED` with the task, operation, and observed status.

`plan-status` returns every module's state, the complete `ready` set, remaining blockers, integration state with its claimed workspaces, the stored report, live claims, and the journal. The ready set has no concurrency cap — it lists every pending module whose dependencies are all delivered, and workspace leases remain the only limit.

Barriers are enforced, not advisory. `plan-dispatch` rejects unmet dependencies, a non-pending module, and a `task_id` already bound to another module; it binds the endpoint to the same `run_id` task set, so `checkpoint --run-id` and the observer cover the whole pipeline. A `task_id` may be bound before its endpoint exists, which is why delivery is where the endpoint is verified. `plan-reset` returns a failed module to pending for a replacement endpoint and keeps both attempts in the journal. `plan-integrate` opens the single final integrator only after every module is delivered, and a second distinct integrator task is refused. `plan-merge-request` verifies `--head-sha` against the repository's real local delivery-branch head, and keeps one MR URL per repository, returning `MR_CONFLICT` for a second. `plan-integration-reset` releases the run's claims and allows a replacement integrator.

Replaying `plan-create` with the same plan and planner is idempotent and keeps recorded progress; a changed plan or a different planner under the same `run_id` returns `RUN_EXISTS`.

`plan-report` closes the run only with a non-empty report and an MR recorded for every declared repository. It copies the report into `plan-reports/<run_id>.md` inside the state directory and records `canonical_path`, `bytes` and `sha256`, so the run keeps a readable copy after the caller's temporary file is gone; `plan-status` also reports whether that file is still `available`. Re-submitting an identical report is idempotent; a different report for a closed run returns `REPORT_CONFLICT`.

The journal records shareable decisions, actions, and results — planner identity and plan digest, module dispatch and provider identity, dependency waits, verified delivery commits, failures and resets, integration with its claimed workspaces, MRs and the heads they were checked against, and the closing report digest. It stores no hidden reasoning or raw provider logs.

`plan-integration-resume --run-id ... --task-id <replacement> --reason ...` keeps the integration workspace, commits, and MRs, and hands over the claims only after verifying that the old execution has stopped; do not substitute `plan-reset` for recovery. Registered workers and integrators automatically inherit their role's delivery requirements, and the commit baseline across attempts stays the plan's original SHA. Beyond the report and MR registration, `plan-report` also verifies the final workspace, the module integration history, and the verification record bound to the SHA, and reads the MR's project, branch, and SHA back through the authenticated GitHub/GitLab API. The verification-record format, exemption boundaries, and recovery steps follow [plan-to-implement](pipelines/plan-to-implement.md#final-integration).

## Durable workspace claims

A workspace claim is a durable reservation of one repository checkout branch by one task, stored in the state directory's `workspace-claims/`. Per-operation leases and the unfenced-operation scan already exclude a second writer, but both are bound to a single `op.target`. A claim expresses the same exclusion independently of any one operation, so one task can own the delivery worktree of several repositories at once — which is what lets the plan-to-implement pipeline run a single integrator across repositories without giving it unleased write access.

Claims are created by `plan-integrate` and released by `plan-report` or `plan-integration-reset`. Any writable `start`, `turn`, `handoff`, or recovery whose worktree identity, or whose repository and checkout branch, matches a claim held by a _different_ task fails with a retryable `WORKSPACE_CLAIM_CONFLICT` naming the owning task and run. The claim owner is never blocked by its own claim, and read-only operations are unaffected. No other start/turn behavior changes: a run with no claims behaves exactly as before.

Claim acquisition, checking, and release are atomic against both another plan run and an ordinary writer, because they use the same per-resource locks in the same order rather than a separate lock domain. Acquiring a claim holds `workspace-prepare`, then the target's `workspace-write` lease, then the repository branch's `branch-write` lease, and checks for an existing claim inside that innermost section before preparing the worktree and writing the record. A writable operation checks the worktree dimension only after it owns that worktree's `workspace-write` lease and the branch dimension only after it owns `branch-write`, so no writer can observe an empty result and then be overtaken. Release re-reads each claim under its `branch-write` lock and removes it only while it still belongs to the releasing run, so a replacement owner's claim on the same deterministic path survives a late cleanup. Repositories are claimed in a deterministic identity order and a failure releases the run's claims, so a multi-repository acquisition is all-or-cleanup. Contention surfaces as a retryable `STATE_BUSY` instead of a silent overwrite.

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

The quiet deadline comes from `control.checkpoint_seconds`, whose default is 120 seconds; `--seconds` overrides one call. Codex callers follow the explicit duration policy in [Waiting and reporting](../SKILL.md#waiting-and-reporting), independently of host-tool wait/yield windows. Deadline expiry returns `CHECKPOINT_QUIET` and exit `124`. An automatic selection with no active task returns quiet immediately. Each `active` item contains task/operation/provider identity, status and progress sequence, plus content-free activity fields when available: last event/tool, active tool names/count, last progress timestamp and its age in seconds. MCode removes completed tools from that active set and clears it at terminal state. Full operation state stays in the journal and remains available through `check`.

One checkpoint parses each task, operation, and action record at most once per tick, and skips records it has already attributed to a task outside the selection. Across ticks of the same checkpoint call, a record whose file stat identity (mtime, size, inode) is unchanged reuses the previously parsed value instead of being re-read; atomic replacement of any record changes that identity, so cross-process updates are always observed. Attribution uses only `task_id` and `operation_id`, which exclusive record creation writes once and never rewrites; it is never inferred from an identifier prefix, because identifiers are caller-supplied.

Claude controller-death retry recovery is launched as a private Node.js worker using the same compiled TypeScript runtime. A kernel-managed controller lease spans operation preparation and the entire retry loop and is released automatically when its process exits. Checkpoint takes over only after that lease is obtainable and the durable owner is no longer live; retry state and ownership are updated in one journal mutation. The launch count plus frozen retry plan bounds takeover, so a long healthy recovery may outlive one quiet interval without duplicate dispatch.

Before Claude retry recovery, POSIX supervision fences the complete process group with TERM, then KILL after the grace interval, and confirms the group disappeared. Windows uses the platform process-tree termination command and confirms process exit. Failure to complete the fence is terminal and no recovery attempt starts. A prompt is `not-delivered` only after a definite launch failure. Once Claude delivery is `delivery-unknown` or `stdin-attached`, recovery uses one uniquely marked continuation on the same session UUID after a successful fence; if the possible provider process cannot be identified and fenced, recovery fails closed. Every exhausted retry path emits `retryable=false`, no `safe_recovery`, and `details.retry_exhausted=true`.

MCode uses no automatic prompt replay. The first `session.started` or `session.resumed` event durably records Session, Turn, and Run identity and creates the task handle, so `check` can expose live progress. If its controller dies while the dedicated operation process group remains, `checkpoint` fences only that group and then evaluates the operation's own stream. A complete non-success terminal record is failure; a complete success is publishable only with a durably recorded zero exit code. Missing terminal facts, an unknown exit code, or an unfenceable delivery becomes `DELIVERY_UNKNOWN` with the saved Session retained. No checkpoint sends the prompt again or creates a replacement Session.

A Codex or MCode CLI operation can also die in `preparing`, before any provider pid exists. Checkpoint terminalizes that window from the journal, without guessing: when `provider_command` was never recorded the launch definitely did not happen, so the operation fails with retryable `PROCESS_EXITED_WITHOUT_RESULT` and `RETRY_SAME_COMMAND`; when `provider_command` was already recorded the launch may have happened and cannot be fenced, so the operation becomes `DELIVERY_UNKNOWN` as `NEEDS_DECISION`. A live controller pid keeps the operation quiet.

Codex App host tools remain model-mediated. Checkpoint returns an existing action promptly but does not synthesize a polling read at the quiet deadline; call `check`, or pass `--auto-read` to the preceding `accept`, when a new App read action is intended.

## Passive request inbox

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
