# Agent Lord deterministic protocol

The deterministic contract is split by concern:

- **This file** — result envelopes, invocation metadata, declared inputs, state ownership, execution contracts, source and workspace verification, error taxonomy, and recovery semantics.
- **[supervision.md](supervision.md)** — multi-task checkpoint supervision, persistent task sets, durable plan runs, durable workspace claims, and the passive request inbox.
- **[transports.md](transports.md)** — provider transport details for Codex CLI, Codex App, and MCode.

Ordinary single-task `RUNNING` supervision follows the loop in [SKILL.md](../SKILL.md).

## Public result envelope

Every command prints one JSON object. `schemas/result-v1.schema.json` is the maintained shape.

| Status                  | Meaning                                                                               | Caller action                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ACTION_REQUIRED`       | A Codex App host-tool action is durably pending                                       | Invoke the exact tool and arguments, then `accept` its raw result                                                   |
| `RUNNING`               | The provider operation is preparing, progressing, waiting, stalled, or recovering     | Continue bounded `checkpoint` supervision; use `check` for full-state diagnosis or the next App read                |
| `SUCCEEDED`             | Endpoint, execution contract, and final artifact passed the available checks          | Consume the artifact; assess `delivery` separately                                                                  |
| `ERROR`                 | Deterministic validation or provider execution failed                                 | Evaluate emitted safe recovery, the caller-owned replacement policy, or Claude `RESULT_INVALID` retry in `SKILL.md` |
| `NEEDS_DECISION`        | Recovery changes identity, authority, source, or delivery semantics                   | Resolve from existing authorization and Skill policy; ask only for missing authority                                |
| `CHECKPOINT_ACTIONABLE` | One or more selected tasks have durable actionable state                              | Process every envelope in `actionable`                                                                              |
| `CHECKPOINT_QUIET`      | No actionable state change occurred in the bounded interval                           | Exit `124`; resume the foreground checkpoint loop later                                                             |
| `REQUEST_RECORD`        | One registered inbox request, after `request-add`, `request-get`, or `request-cancel` | Report it as pending, dispatched, or cancelled; registration alone dispatched nothing                               |
| `REQUEST_LIST`          | Compact discovery of registered requests with per-status counts                       | Read the full instruction of a specific one with `request-get`                                                      |
| `REQUEST_PENDING`       | A consumed request could not be dispatched because its target is busy                 | Keep it pending and retry after the current operation is terminal                                                   |

An `ACTION_REQUIRED` record is idempotent. Re-running the same `start`, `turn`, or checkpoint returns the already-pending action instead of creating a second provider operation.

Dispatch is serialized by a per-task filesystem lock. The journal is written before provider execution, so a concurrent caller either receives the existing operation or `STATE_BUSY`; it cannot create a second endpoint or turn.

## Invocation metadata

`start`, `turn`, `recover`, and `handoff` accept an optional `--invocation-file <private-json>`, validated before dispatch, which freezes the invocation source into this `operation.invocation`. It does not modify the task's execution contract and is never overwritten by a retry, a repeated start, or a query. Old operations stay readable; a missing source is shown as unrecorded.

```json
{
  "trigger": "user_request",
  "user_request": "The user's original request for this dispatch, saved verbatim, including newlines."
}
```

`--message-file` remains the actual task body handed to the execution endpoint. `user_request` is the separately saved user wording; neither is inferred from nor substituted for the other. Caller-authored follow-up turns use `trigger: "caller_followup"` with a `reason` instead of masquerading as a new user message; `recover` is always recorded as `recovery`. Use `unspecified` when no source information exists. The caller removes its input files after result retrieval; the durable operation keeps the request for read-only replay.

| Input field    | Constraint and source                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `user_request` | Optional or null; nonempty string, at most 1,000,000 characters, saved verbatim                            |
| `reason`       | Optional or null; the reason for a follow-up or recovery, at most 16,000 characters                        |
| `trigger`      | `user_request` / `caller_followup` / `recovery` / `unspecified`                                            |
| `caller`       | Optional object; when explicit it must contain `kind` and may contain `session_id`, `turn_id`, `data_root` |

When `caller` is omitted, the script captures the source from the host's `CODEX_THREAD_ID` (with `CODEX_SESSION_ID` compatibility), optional `CODEX_TURN_ID`, and `CODEX_HOME`; the data root defaults to `~/.codex`. `identity_source: "runtime-env"` records a host-environment origin, not cryptographic identity verification. An explicit caller is marked `caller-declared` and never borrows the current host's Session, Turn, or data root; without a Session it is marked `unavailable`. Never guess identity from the prompt or from the most recently active session.

`kind` and nonempty ids allow only `[A-Za-z0-9][A-Za-z0-9._:-]*`, at most 160 characters; a Turn requires its Session. An explicit `data_root` must be an absolute path, preserved for every scheduling client. Input rejects a self-asserted `identity_source` and any unknown field. Caller identity variables are not passed into provider child processes, so a later nested invocation cannot mistake the parent Session for its own; a child runtime supplies its own identity or stays unknown.

### CLI scheduling identity and display binding

Supported `caller.kind` values are `codex`, `claude`, and `mcode`; `codex-cli`, `claude-cli` / `claude-code`, and `mcode-cli` normalize to those names. This describes who is scheduling, independently of the provider being launched.

Claude Code and MCode explicitly fill in the Session identity supplied by the current client in every `--invocation-file`. The data root uses the client's actually configured absolute directory: Codex is usually `~/.codex`, Claude Code usually `~/.claude`, and MCode usually `~/.minimax`. Expand `~` in the JSON. For example:

```json
{
  "trigger": "user_request",
  "user_request": "The user's original task for this turn",
  "caller": {
    "kind": "mcode",
    "session_id": "mvs_CURRENT_SESSION_ID",
    "data_root": "/absolute/path/to/.minimax"
  }
}
```

The Session identity must come from the current client context, an exactly matching runtime record, or a client hook; never pick a session by working directory, title, or most recent update time. Pass `turn_id` when the Turn is known: MCode uses the ingress turn id and Claude Code uses the uuid of the corresponding user-input record. Omit it when unknown — the operation creation time is used instead and the page labels that. An explicit caller does not borrow the host's other identity fields.

Host integrations may instead set `AGENT_LORD_CALLER_KIND`, `AGENT_LORD_CALLER_SESSION_ID`, optional `AGENT_LORD_CALLER_TURN_ID`, and `AGENT_LORD_CALLER_DATA_ROOT` in the tool-command environment. This is Agent Lord's integration contract; it does not claim that Claude/MCode natively export these variables. Precedence is explicit `caller` > this environment group > the original Codex auto-detection. Dispatched child processes clear this parent identity group; client configuration such as the data root remains. Historical unknown records are not backfilled.

**After every dispatch, every scheduling client runs the observer's `preview:attach`; when adding tasks, merge the current task set and check `binding_verified`.** `start` does not publish a task automatically. Skip this only when the user explicitly declines an observation page. A CLI without the Codex host link-opening tool returns the bound local link instead; that never justifies skipping the binding.

### Scheduling-session metadata and lifecycle

The observation page shows the original scheduler and the current turn's caller separately, from the first and current operations, and presents the original request and the actually dispatched body per turn. Only the data root of a bound identity is read:

- Codex Desktop / CLI: the uniquely matching rollout, verifying `session_meta` and reading the Session title, project, Turn start/end, and structured tool receipts.
- MCode: opens `v2/sqlite/runtime-state.sqlite` read-only, reading `local_runtime_sessions` title/project and turn start/end from `local_runtime_turn_ingress` by exact Session ID. At most the most recent 1000 turns; displayed message times are not tool completion times, so no receipt times are fabricated.
- Claude Code: locates only `projects/*/<session-id>.jsonl`, excluding sidechains and other Sessions' history. Reads `custom-title` (falling back to a summary of the first user input), cwd, user-input uuids, the `system/turn_duration` end event, and structured receipts inside tool results. When only a model `end_turn` exists without a client end event, the lifecycle is explicitly shown as incompletely observed; a hook still running is not misreported as completed.

Unobserved, unsupported-log, and identity-mismatch cases all display as unknown; an execution endpoint's end is never treated as the scheduler's end. Host bodies are not projected beyond title summaries, reasoning content never reaches the page, and `data_root` stays on the local server side.

## Inline terminal response

`start`, `turn`, `recover`, `handoff`, `accept`, `check`, and `checkpoint` support an optional `--include-response`. A successful envelope adds `response: {"text": "<complete final text>", "read_at_ms": 1788928363000}`; checkpoint applies the same rule to each successful `actionable` item. The default still returns no text, and unsuccessful items never carry one.

The read accepts only the current task/operation's canonical artifact, verifying the real path, SHA-256, byte count, and UTF-8. A rewritten, missing, or symlink-escaping file returns `ARTIFACT_INVALID` without changing an already-successful operation. The existing `artifact` and `delivery` meanings are unchanged; the returned text is not semantic-acceptance proof.

An ordinary operation envelope also carries `provider_return_code` (null when unrecorded) and `timing.created_at_ms` / `timing.completed_at_ms`. `response.read_at_ms` is when the script finished reading; it cannot substitute for when the host actually received the result. The observation page shows endpoint completion, artifact publication, scheduler receipt, and scheduler completion separately, and computes no duration whose endpoints are missing. Closing uses one terminal envelope plus its text read, reuses the bound observation page, collects any unretrieved controller handle, and cleans up private inputs — with no extra browser verification or duplicate status query.

## Declared input preflight

`start`, `turn`, and `request-add` accept repeatable `--require-input <workspace-relative-file>`. For repository-managed tasks, checks run against the prepared checkout. A declared path must resolve to a readable, nonempty regular file inside that workspace; missing, empty, unreadable, directory, and escaping paths prevent provider launch. `INPUT_INCOMPLETE` lists file-level issues. Omit this option when there are no required local files. No document topic, writing length, implementation choice, or extra review step is imposed.

Successful dispatch records `input_evidence` (path, byte count, SHA-256) in the operation and envelope. These are historical receipts, not immutable-file restrictions: a new explicit turn checks its declared inputs afresh. Same-start idempotency includes the declared path set; retrying the same start does not revalidate or relaunch a completed operation. `recover` retains the parent's original input receipt as history and lets the CLI inspect saved work. Pending requests check inputs when dispatched, not when registered. Input bytes are not copied into Agent Lord state or automatically injected into the prompt; the caller supplies relevant paths/context to the CLI.

## State ownership

The script is the only writer under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`:

```text
<task-id>.json                 durable endpoint and execution contract
operations/<operation-id>.json
actions/<action-id>.json       model-mediated Codex tool request
requests/<request-id>.json     registered, not yet dispatched instruction
events/<task-id>.jsonl         append-only transitions
artifacts/<task-id>/<operation-id>.md
artifacts/<task-id>/<operation-id>.handoff-v1.json   canonical sanitized handoff input packet
logs/<operation-id>[.attempt-N].stdout
logs/<operation-id>[.attempt-N].stderr
logs/<operation-id>.final       local CLI final response only
locks/
tmp/
worktrees/<task-id>/            default local source-branch worktree location
```

Current state comes from task, operation, and provider truth. `events/*.jsonl` is a wake/audit log, not current-state authority.

Task handles follow `schemas/task-v2.schema.json`. Version 1 records are normalized for inspection, but another turn is blocked until `node core/dist/task-store.js upgrade` attaches an explicit model, effort, retry, permission, and optional source contract. Operations and actions follow their corresponding schemas.

A `handoff` operation is a third initial-operation kind beside `start` and `turn`-continued work: it consumes one validated `handoff-v1` packet (`schemas/handoff-v1.schema.json`), stores the canonical packet as an input artifact, freezes the workspace snapshot in its `handoff` manifest, and writes an immutable `lineage` record into the continuation task it creates. Lineage means `continues_user_task` on a brand-new endpoint; source-session identity stays `caller-declared` or `unavailable`, never `verified`. The command remains available for explicit low-level use and existing runs; the named handoff pipeline has been retired. See [legacy command](#legacy-handoff-command).

## Legacy handoff command

`handoff` is retained as a low-level compatibility command, not a Skill route or named pipeline. New `source.kind: pipeline` registrations cannot select `handoff`; existing stored runs keep their lineage and can continue. Use the ordinary task/replacement contract for new user-authorized work. The command does not add scheduling authority or additional roles.

For an explicitly authorized exact-workspace continuation, the source authors a sanitized packet from visible context under [task context preparation](../SKILL.md#task-context-preparation). Include the executor constraint, current decisions, completed work, remaining work, acceptance criteria, and accessible evidence references. The source session identity is caller-declared or unavailable. The destination is one new local CLI endpoint, never a migrated native session or a Codex App task.

- [handoff-v1 schema](../schemas/handoff-v1.schema.json) defines the packet, including contract request, workspace-relative evidence, sanitization attestation, and integrity digest. The validator enforces the closed shape and size bounds; the source remains responsible for redacting secrets and personal data.
- `handoff --task-id <new-task> --packet-file <private-json> --provider <cli> --target <workspace> --model <model> --effort <effort>` validates the packet and contract, acquires the workspace lease, fingerprints HEAD and dirty contents, saves a canonical packet, and starts the new endpoint. `--validate-only` checks without creating durable state. Use `dangerously_bypass`; task-level write limits still apply.
- Replaying an identical packet and contract returns the existing operation; conflicting reuse fails with `HANDOFF_CONFLICT`. An uncertain delivery follows the standard recovery rules rather than replaying to another endpoint.
- Continue with `turn` and supervise with `checkpoint`. The canonical packet remains in the state directory; remove the caller-owned temporary packet after it has been consumed. Task identity, delivery evidence, and source-assurance limits remain visible in the result.

## Execution contract

The durable task record owns:

- provider and immutable endpoint id;
- current route and route history;
- target;
- explicit model and applicable effort;
- an ordered retry plan whose stages freeze model and attempt budget;
- explicit permission posture (`dangerously_bypass` for new Skill CLI dispatches; the runtime retains `--read-only` as a low-level compatibility override);
- fixed source head/base when supplied, plus the last verified head of a writable repo-managed checkout.
- frozen workspace policy, repository, source branch, and isolated branch when supplied;
- a caller-declared parallel worker/integrator contract when supplied.

Provider arguments enforce the frozen model and applicable effort on every operation. Claude success requires observable main-model metadata from the same session. `system.init.model` and `assistant.message.model` are authoritative; `result.modelUsage` is a fallback when it names one unambiguous model. Same-model canonical and context-modified spellings may coexist, but every usage/canonical id must match the verified family and version. A requested context modifier such as `[1m]` requires matching modifier or `contextWindow` evidence; absent or contradictory evidence fails closed. Provider diagnostic lines are parsed separately from JSON message content. A failed `query_source=auto_mode` model becomes a sanitized `AUXILIARY_MODEL_UNRECOGNIZED` warning when the matching main result succeeded, without consuming retry budget or triggering fallback. Codex CLI stores the `thread.started` UUID and requires `turn.completed`; Codex App actions carry the explicit contract. MCode resolves a qualified model and independent effort from explicit input or provider defaults, validates terminal Session/Turn/Run plus model and any requested variant, and records effort as `argument-enforced` because schema-version-1 terminal metadata does not echo the selected level.

`export-artifact` is an auxiliary import path, not a delivery. It never rewrites an already-terminal operation, so a rejected export leaves a `succeeded` operation and its canonical artifact intact; only a non-terminal operation is invalidated. A Codex rollout import must contain the exact operation marker and additionally verifies `turn_context` model and effort. A Claude import must be `claude-jsonl` and every candidate assistant record must carry this operation's own session id; a log with no such record is `RESULT_INVALID`. A Claude session log carries no effort field, so effort cannot be proven from it. Rather than fabricate a value or reject a valid transcript, the export publishes `{"code": "EFFORT_UNVERIFIABLE_FORMAT", "source_format": ..., "expected_effort": ...}` — the second declared warning variant in `schemas/result-v1.schema.json`. Effort itself remains argument-enforced at dispatch and recorded as `effort_verification`. MCode `stream-json` does not expose a separately verifiable Agent Lord operation marker, so `mcode-stream-json` import is refused without changing an existing success; the direct adapter's verified final file is authoritative.

Permission policy lives in `config/providers.json`; the selected mode is frozen in the durable task contract and resolved again before every operation. New Skill CLI dispatches omit `--read-only` and carry review/no-code-change/external-write limits in their prompts; these limits do not change the process mode. The following mappings describe runtime capabilities, including read-only compatibility for existing contracts and low-level callers. Claude Code maps bypass to `--dangerously-skip-permissions` and `--read-only` to `--permission-mode plan`; Codex CLI maps bypass to `--dangerously-bypass-approvals-and-sandbox`. MCode maps bypass to `--permission full` and records `mcode-permission-full-argument`; this is MCode permission-policy enforcement, not a claim that the argument disables every sandbox. MCode has no enforceable read-only mode because `smart`, `full`, and `off` are not read-only, so `--read-only` fails before dispatch. Codex App exposes no approval or sandbox argument, so it records bypass as `host-inherited-unverified` and read-only as `instruction-only`.

Claude defaults to configured `claude-fable-5` / `xhigh` with `default_resolution.source: provider-config`; user settings still supply authentication, routing and other CLI settings. The optional `claude-user-settings` policy resolves unspecified fields from the active user `settings.json` (`CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`): `model` supplies the model and `effortLevel` supplies effort, with configured defaults as per-field fallbacks. Explicit model and effort arguments override independently. The resolved pair is stored in the task contract, so later defaults or settings changes cannot rewrite it. Fable-family tasks append a five-attempt `claude-opus-5` fallback stage. `--retry-attempts` overrides only the primary stage; the configured fallback budget is independent and is not scaled by it. The primary and fallback stages reuse the same session UUID, and `--resume` on that session means a failed attempt's partial work stays in the transcript the next attempt reads — that is the deliberate trade-off for preserving endpoint identity, not a defect. After the frozen plan is exhausted, the terminal error has no automatic recovery. Codex CLI defaults to `gpt-6-astra` with `xhigh`; Codex App remains `gpt-5.6-sol` with `high`. Unqualified `codex` resolves to `codex-cli`. MCode defaults to `custom_provider:mafia-claude/claude-opus-5` with `xhigh`; explicit model and effort arguments override independently, and later turns replay both resolved values. The MCode runtime validates effort against the selected model's live `effortOptions` before sending a request. A `#variant` stays part of the model literal and never substitutes for effort.

At every Claude process launch, including retry and recovery, the adapter builds a child environment without mutating its parent. It removes only inherited model/route/effort keys for which the selected Claude settings file is authoritative; environment-only credentials and unrelated Claude/Anthropic values remain intact, as do `CLAUDE_CONFIG_DIR`, the configured binary override, base URL, custom headers, and credential-helper settings. Settings values other than the resolved model/effort are neither copied into task records nor emitted in artifacts.

Claude and MCode emit stream progress into the operation journal. MCode stores only identity, sequence, event type, process state, and timing metadata there; raw reasoning and tool records stay in private logs. Provider configuration owns progress polling and termination grace intervals. Claude additionally uses `provider_wait`, `progressing`, `tool_wait`, `suspected_stall`, `provider_failed`, or `recovering`, with a 900-second default no-progress deadline and 3600 seconds for known tool activity.

### CLI surface

`--codex-environment` and `--starting-branch` describe a Codex App thread and have no meaning for `claude-cli`, `codex`, `codex-cli`, `mcode`, or `mcode-cli`. They have no parser default, so passing either to a CLI provider is rejected with `CONFIG_INVALID` instead of being silently dropped. Configuration itself is read while the parser is built, so an unreadable or invalid `config/providers.json` still exits as one `ERROR` envelope rather than a bare traceback.

### Local worktree preparation

Local Claude, Codex CLI, and MCode starts may replace `--target` with `--repo`, `--source-branch`, one workspace policy, and a fixed `--head-sha`. The control plane performs no fetch and never removes a worktree. New worktrees default to `worktrees/<task-id>` under the Agent Lord state directory; `--worktree-root` overrides only that parent. Because MCode rejects `--read-only`, it cannot use `shared-readonly` in this phase.

The [Skill workspace policy](../SKILL.md#workspace-and-parallel-write-policy) authorizes task-required worktrees and isolated local branches without confirmation. New concurrent CLI dispatches, including reviews, use distinct isolated worktrees under exclusive leases; they do not use `shared-readonly`. Review-only concurrency does not require the integration workflow below.

The policies below describe runtime capabilities; `shared-readonly` remains a low-level compatibility option:

- `shared-readonly` accepts only `--read-only`, then shares or creates the clean source-branch worktree at the fixed head.
- `reuse-or-create` reuses the one clean worktree bound to the source branch or creates it from an already-available local branch, `origin` tracking ref, or commit.
- `isolated` accepts only writable tasks and requires a distinct explicit `--workspace-branch`. It creates or reuses that branch's worktree from the fixed source head without binding another worktree to the MR source branch.

The resolved worktree path becomes the operation and durable task target. A dirty worktree, conflicting branch head, unavailable fixed commit, ambiguous binding, or occupied destination fails with `SOURCE_MISMATCH` or `SOURCE_UNVERIFIED`. Existing `--target` starts keep their original source behavior and receive an exact-target workspace contract. Preparation runs under a per-`(repository, checkout branch)` lease and lists worktrees once; brief lease contention uses the configured bounded lock retry budget before returning retryable `STATE_BUSY`. The final proof is the target's own clean status and head, not a repeated listing.

#### Source verification across turns

`start` freezes `contract.source.head_sha`, which never changes. What a later `turn` must prove depends on the contract:

- Runtime `read_only` tasks and `exact-target` tasks stay strict: `HEAD` must still equal the frozen `head_sha`, otherwise `SOURCE_MISMATCH`.
- A writable repo-managed task may advance its HEAD when commits are within its authorized scope. Its checkout must still be on the contract branch (`isolated` → `workspace_branch`, `reuse-or-create` → `source_branch`) and its `HEAD` must be a descendant of the last verified head. Leaving the contract branch, or a head that is not a descendant, is `SOURCE_MISMATCH` with the observed branch or head in `details`.
- The verification baseline is `contract.source.verified_head_sha` when present and `head_sha` otherwise. A successful check persists the observed head as the new `verified_head_sha` in the same durable record, so the advance is recoverable after a crash and monotone: the task can never silently move backwards or onto another branch. `verified_head_sha` without `head_sha` is `STATE_CORRUPT`.

Bypass reviews use the writable runtime contract, so unchanged review source is a prompt and artifact-acceptance requirement, not a claim that the runtime rejects every descendant commit. Keep the pinned checkout unchanged and verify its source before accepting each review artifact; all runtime source and identity checks still apply.

Every writable local CLI operation, including a bypass review, holds an exclusive workspace lease until provider completion. Repo-managed operations also hold an exclusive checkout-branch lease. Runtime `read_only` operations take the same workspace lease in shared mode, so any number of readers share one fixed-head checkout while a writer is still excluded in both directions; contention returns `WORKSPACE_WRITE_CONFLICT` (`details.requested = "read-only"` when a reader was refused) or `BRANCH_WRITE_CONFLICT`.

The locks are kernel-managed and process-scoped, so controller death releases them. That alone is not enough: the provider process may outlive its controller and keep writing. Before granting a workspace to a new writer, the control plane also scans for any non-terminal writable operation on the same worktree. If one exists, the start fails closed with `WORKSPACE_WRITE_CONFLICT`, `safe_recovery = "RUN_CHECKPOINT_TO_FENCE_THEN_RETRY"`, and the blocking `operation_id`/`operation_status` in `details`. Running `checkpoint` fences and terminalizes that operation; only then can the second writer proceed.

### Declared same-MR parallel writes

Parallel editing is a caller-owned workflow with a fail-closed execution contract. Agent Lord never infers the need for parallel writers and never adds an integration node. The caller declares each node when starting it:

```text
worker:
  --workspace-policy isolated
  --workspace-branch <explicit-temporary-branch>
  --parallel-group <group>
  --integration-role worker
  --integration-target-branch <mr-source-branch>
  --integrator-task-id <task-id>
  --integration-order <positive-integer>

integrator:
  --workspace-policy reuse-or-create
  --parallel-group <same-group>
  --integration-role integrator
  --integration-target-branch <mr-source-branch>
  --integration-worker <task-id>  # repeat in declared order
```

The integration target must equal `--source-branch`; it is the original MR source branch, never the MR target branch. Worker order and temporary branch names must be unique within the group. Worker starts in one group are serialized by a group lease so two workers cannot claim the same order through a check-then-write race, and the integrator start independently rejects a worker list whose declared orders are not unique — a backstop for any state that predates or escapes that lease. The integrator start verifies that every listed worker has a successful terminal operation, names this integrator, belongs to the same group, targets the same MR source branch, and appears in its declared order. The endpoint assigned as integrator then refreshes/replays as instructed by the caller, integrates and tests the worker commits, and pushes the MR source branch. Agent Lord validates isolation and the barrier; it does not itself cherry-pick, push, force-push, create another MR, or merge.

Missing, inconsistent, premature, or target-branch parallel metadata returns `PARALLEL_WRITE_PLAN_INCOMPLETE` as `NEEDS_DECISION` before endpoint dispatch.

## Error taxonomy

| Code                                                 | Meaning                                                                                                   | Default disposition                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_INVALID`                                     | Invalid task input or unsupported configured value                                                        | Correct input                                                                                                                       |
| `TASK_EXISTS` / `TASK_UNKNOWN`                       | Logical identity conflict or missing task                                                                 | Correct identity; do not guess                                                                                                      |
| `EXECUTION_CONTRACT_REQUIRED`                        | A legacy handle lacks model, effort, permission, or source truth                                          | Explicitly upgrade the same handle before continuing                                                                                |
| `OPERATION_IN_FLIGHT`                                | Previous turn is not terminal                                                                             | Check the same operation                                                                                                            |
| `SOURCE_MISMATCH` / `SOURCE_UNVERIFIED`              | Fixed source cannot be proven                                                                             | Correct the checkout or obtain a decision                                                                                           |
| `WORKSPACE_WRITE_CONFLICT` / `BRANCH_WRITE_CONFLICT` | Another live or unfenced writable local task owns the worktree or checkout branch                         | Wait for it, run `checkpoint` to fence it, or use an isolated worktree for the authorized task                                      |
| `PARALLEL_WRITE_PLAN_INCOMPLETE`                     | Same-MR parallel write metadata, barrier, or order is incomplete or not unique                            | `NEEDS_DECISION`; correct the caller-owned plan                                                                                     |
| `HANDOFF_PACKET_INVALID`                             | Handoff packet fails schema, bounds, sanitization, integrity, or secret checks                            | Fix the packet; nothing was dispatched                                                                                              |
| `HANDOFF_CONFLICT`                                   | Handoff arguments, packet binding, or an existing continuation task disagree                              | Fail closed; a different continuation needs a new `task_id` or corrected inputs                                                     |
| `MODEL_UNRECOGNIZED`                                 | Provider did not recognize the requested main model and no valid matching main result exists              | Retry the same endpoint with the saved contract                                                                                     |
| `MODEL_MISMATCH` / `MODEL_UNVERIFIED`                | Observed result does not prove the requested model                                                        | Invalidate a non-terminal operation; retry the same endpoint                                                                        |
| `EFFORT_MISMATCH` / `EFFORT_UNVERIFIED`              | Provider log contradicts saved effort, or a format that could prove it did not                            | Invalidate a non-terminal operation and retry the same endpoint                                                                     |
| `ENDPOINT_ROUTE_STALE`                               | Codex host routing changed                                                                                | Resolve the same `threadId`, update route history, retry once                                                                       |
| `ENDPOINT_GONE`                                      | Same endpoint cannot be rediscovered                                                                      | `NEEDS_DECISION`; the caller may resolve it under the Skill replacement policy with a new identity and context handoff              |
| `DELIVERY_UNKNOWN`                                   | Send lacks a trustworthy receipt or durable exit status                                                   | Preserve the endpoint; do not resend without provider-specific proof or an explicit decision                                        |
| `ENDPOINT_MISMATCH`                                  | Provider result belongs to another endpoint                                                               | Fail closed                                                                                                                         |
| `RESULT_INVALID`                                     | Provider output lacks the required result shape                                                           | Fail closed and preserve private logs; a terminal `claude-cli` one additionally allows the caller-owned bounded retry in `SKILL.md` |
| `PROCESS_EXITED_WITHOUT_RESULT`                      | Local provider process disappeared before terminal publication                                            | Inspect private logs, then retry the same endpoint if safe                                                                          |
| `PROVIDER_STALLED`                                   | Claude stayed alive but produced no stream progress before the saved control deadline                     | Fence the old process group, then resume the same session with a continuation query                                                 |
| `IDENTITY_CONFLICT` / `STATE_CONFLICT`               | Durable records disagree about endpoint or terminal identity                                              | Stop and repair explicitly                                                                                                          |
| `REQUEST_UNKNOWN`                                    | No request is registered under that `request_id`                                                          | Correct the identity; do not guess                                                                                                  |
| `REQUEST_CONFLICT`                                   | The same `request_id` was registered with a different intent, or a dispatched request cannot be cancelled | Use a new `request_id`, or accept the existing operation                                                                            |
| `REQUEST_CANCELLED`                                  | The request was cancelled before it was dispatched                                                        | Register a new request if the work is still wanted                                                                                  |
| `STATE_BUSY` / `STATE_CORRUPT`                       | Concurrent writer or invalid durable state                                                                | Retry the same command or repair state explicitly                                                                                   |

## Safe recovery line

The implementation may perform only identity-preserving recovery automatically:

- re-read status;
- reapply the saved model/effort;
- execute the saved Claude retry stages on the same session;
- rediscover the host for the same Codex `threadId`;
- return the same pending action for an identical in-flight message;
- inspect an ambiguous delivery for its operation marker;
- recover a completed local CLI result from the prewritten journal after the original controller disappears, only when its provider exit status is durable;
- fence a stalled Claude process group, confirm exit, and append one uniquely marked continuation query through `--resume` on the same session;
- let the private recovery controller claim that same recovery when the original controller is dead.

The implementation can return `NEEDS_DECISION` for an identity or authority change. The caller resolves necessary endpoint replacement under [the Skill replacement policy](../SKILL.md#endpoint-replacement) without additional user confirmation, using a fresh task and context handoff; the runtime does not replace endpoints inside `checkpoint` or rebind tasks. Provider/model/effort/source changes, permission expansion, and external writes still require their own authority. A missing safe recovery action alone is not a request for permission.

The Claude `RESULT_INVALID` retry in `SKILL.md` is not part of this line: such an operation still terminalizes with no `safe_recovery`, and its replacement session is a new `task_id` with recorded lineage rather than a rebound endpoint. Its bookkeeping is scripted by the separate `retry-invalid` command described below, which the caller must invoke explicitly.

MCode checkpoint recovery stops at the existing Run boundary. For a verified transient failure, the terminal error may additionally offer `safe_recovery=CONTINUE_SAME_SESSION`. The caller consumes it with `recover --task-id <id> --operation-id <failed-id>`; no further permission question is needed within the existing task authorization. The command revalidates the original stream, Session/Turn/Run, model/variant, durable exit code 4, failed/timeout status, runtime `retryable=true` error, and absence of a live provider process group. Cancelled, limit-exceeded, unknown delivery/exit, or unverified identity/model results do not qualify.

New MCode tasks freeze `config.providers.mcode-cli.same_session_continuations` (default 2, range 0–5) as `contract.continuation_limit`. Existing contracts without the field retain a zero budget. Each recovery creates a new `turn` operation on the same saved Session with a short continuation instruction to inspect existing work and finish only remaining requirements; it never replays the original prompt. The child records parent/root operation and attempt/limit, while the failed parent is immutable. Repeated or concurrent recovery of that parent returns the same child. Each failed continuation spends the same chain budget. The command rechecks the frozen contract, source and write leases; only the latest failed operation can create a child. A normal user-requested `turn` starts a new logical chain.

When that verified recoverable error contains `stream ended before message_stop`, the continuation adds a short advisory: if a large write was interrupted, inspect saved work and consider smaller writes or incremental edits. The CLI chooses the method and chunk size. This hint uses the existing recovery command, Session, and budget; it adds no interruption of healthy runs, fixed output limits, or automatic task decomposition. Other failures retain the ordinary continuation prompt.

## Scripted Claude RESULT_INVALID retry

`retry-invalid --task-id <id> --operation-id <failed-id>` is the single control-plane entry for the bounded Claude `RESULT_INVALID` retry. The caller still invokes it explicitly per attempt; the command owns all budget, fingerprint, and lineage bookkeeping, so no second hand-maintained ledger exists.

The ledger is persisted on the lineage-root operation record as `invalid_retry_ledger` and updated atomically under the operation lock. Policy is frozen at creation: only terminal `claude-cli` `RESULT_INVALID` qualifies, and at most 3 retries follow the original failure, shared across every session in the lineage; a success ends the lineage immediately. The failure fingerprint is `sha256(code, message)`; a changed fingerprint resets the consecutive streak, and a replacement session starts a fresh streak counted only from its own failures (see the retry placement rules below).

Retry placement follows the frozen rules. While the streak of identical fingerprints is below 2 and the failed operation has a durable task, the retry is a `turn` on the same session carrying a uniquely marked continuation of the original message. After two consecutive identical fingerprints the next retry must be a new task and session: the replacement records `replacement_for`, never rebinds the original `task_id`, and freezes the same provider, model, effort, retry plan, permission mode, source/workspace binding, role, and input contract from the root operation. When the original failure never published a durable task, the same-session path is unavailable and the session identity cannot be trusted for a same-endpoint replay; that missing identity is not a silent replacement trigger. Without a replacement id, the command refuses with `RECOVERY_UNAVAILABLE` and `requires_authorization`. The caller may supply a fresh `--replacement-task-id` under the Skill replacement policy without asking the user again; the command records `forced_new_session`. A declared parallel-group member retries and replaces like any other role; its `parallel_role` is persisted in the ledger, the dispatch event, and the `invalid_retry` block so pipeline identity-continuity checks can re-evaluate the replacement, and workspace write-lease conflicts surface as the usual structured lease errors.

Every retry operation is stamped with its root operation, attempt number, mode, and the failure it follows, so any failed operation on the chain resolves back to the shared ledger. The command is idempotent and crash-safe: an in-flight retry returns `STATE_BUSY` for the same lineage, a re-run after a crash claims the already-dispatched attempt by its marker message hash instead of dispatching again, an exhausted budget returns `RETRY_BUDGET_EXHAUSTED`, and a synchronous dispatch failure rolls back the recorded intent without consuming budget. Refusals are themselves persisted before being raised. The returned envelope carries an `invalid_retry` block with the attempt lineage, remaining budget, and a contract-mismatch check of the replayed model/effort/permission fields.

## Declared delivery evidence

For ordinary local CLI `start`/`turn`, repeated `--require-file <workspace-relative-path>` checks that every declared file exists, is non-empty and resolves inside the workspace. `--require-commit` checks a new descendant of the dispatch-time HEAD and a clean worktree. Requirements are operation-scoped and inherited by `recover`; an ordinary new turn declares its own requirements. Repeating an in-flight request cannot silently change them. A plan-bound implementation role always requires a commit, with the baseline fixed at the plan's original SHA; when a recovery only completes verification, an existing delivery commit remains valid.

`SUCCEEDED` continues to mean execution success. Its separate `delivery` record has scope `declared-files-and-commit` and status `verified`, `incomplete`, or `unverified` (no requirements, including old operations). Checks record files and optional commit evidence; the observer displays these separately. No semantic tests, browser behavior, or license correctness are inferred from a provider's final prose. A missing declared file keeps delivery incomplete even if the CLI exited successfully.
