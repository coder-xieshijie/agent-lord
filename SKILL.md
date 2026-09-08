---
name: agent-lord
description: Dispatch and supervise durable Codex CLI, Codex App, Claude Code, or MCode CLI endpoints through deterministic scripts that enforce execution contracts, source identity, recovery, and sanitized results. Preserve explicit dependencies and run independent named actions concurrently when the workspace contract permits; surface any required isolation or integration decision before dispatch. Route explicit cross-review or 交叉 Review requests through the built-in cross-review policy, and explicit handoff / 交接 requests through the built-in handoff policy. Use when a Codex Desktop user asks to start or continue external Codex, Claude, or MCode work; not for in-process subagents, CI jobs, or general DAG workflows.
---

# Agent Lord

Route one logical task to one durable endpoint. Treat `scripts/agent_lord.py` as the control plane: the model supplies intent and performs Codex App host-tool actions when requested, while the script owns provider defaults, validation, retries, state, recovery, and artifact extraction.

## Invariants

- Keep the delegated task's implementation, analysis, review, test execution, and semantic acceptance in the user-authorized external endpoints. The caller handles context transfer, dispatch, supervision, and result convergence, and may directly inspect dispatch contracts, run records, and deliverable completeness or review the orchestration process itself. These control-plane checks do not authorize taking over delegated task work or adding workflow nodes.
- Start only with explicit user authorization. Preserve user choices for target, source revision, model, effort, permission posture, and external writes.
- Treat the user-specified endpoint set as part of the execution contract. Dispatch every requested Codex CLI, Claude Code CLI, or MCode CLI endpoint exactly; never drop or substitute a named provider.
- Keep one endpoint per `task_id` and one in-flight operation per task. Continue the saved endpoint; replacement requires an explicit decision.
- Let the dispatch lock and operation journal enforce that invariant across concurrent controller processes; do not implement a second caller-side lock.
- Let operation-scoped workspace and branch write leases serialize writable local CLI tasks. Read-only tasks share one clean fixed-head worktree under a shared lease; writable tasks never share a worktree concurrently, and an unfenced writable operation keeps blocking new writers until `checkpoint` fences it.
- Store task, operation, action, event, log, and artifact state under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`, never in the target repository.
- Freeze the resolved model, effort, retry plan, permission posture, and source contract when the task starts; every later turn reapplies them.
- Use fixed full SHAs for revision-sensitive work. Read-only tasks refuse any working directory whose `HEAD` differs from the frozen head. A writable repo-managed task may advance: its `HEAD` must stay on the contract checkout branch and remain a descendant of the last verified head, which the control plane then records as the new verification baseline.
- Exchange sanitized artifacts, not raw provider logs or reasoning traces.
- Treat the caller's task set, dependencies, disjoint output boundaries, next-step policy, or explicitly named built-in pipeline as inputs. Agent Lord supervises endpoint operations; it does not invent an unnamed workflow.
- The workflow is user input unless the user invokes a documented named pipeline. Preserve every explicit dependency, sequence, node, role, and completion condition. Multiple named actions that the caller identifies as independent, or whose dependency relationship is genuinely unclear, create a dispatch decision before execution: run confirmed-independent actions concurrently under a valid workspace contract; ask the caller when independence is unclear. Absence of an explicit parallel keyword is not a reason to silently serialize confirmed-independent actions.
- Resolve that dispatch decision before starting the first execution endpoint. When safe concurrency would require isolated worktrees, temporary branches, an integrator, or another user-visible node that the caller did not authorize, report the exact required expansion and obtain the caller's decision. Do not choose serial execution merely to avoid that decision.
- Add no planner, reviewer, tester, audit, acceptance, or other “best practice” node on your own. Ordinary risk judgement is grounds for reporting a concern to the user, never for extending the workflow.
- Internal `task_id` and endpoint operations are execution-control handles only. Creating, retrying, or recovering one grants no authority to add a user-visible workflow node; a new node requires an explicit user flow or a later explicit instruction.

## Pipeline routing

- For every multi-endpoint or named pipeline, read [references/pipelines/common.md](references/pipelines/common.md) and freeze its run manifest, barriers, role checks, convergence bound, and final deliverable before dispatch.
- When the request says “交叉 Review”, “交叉审查”, or `cross-review`, also read [references/pipelines/cross-review.md](references/pipelines/cross-review.md) and execute that exact Opus + Codex mutual-review → independent Fable-check policy, including its documented `Opus fallback` checker outcome. The phrase authorizes only the nodes documented there; explicit user overrides still win.
- When the request says “handoff” or “交接”, or asks to hand the current session's work to a new local CLI that continues a user-named task, read [references/pipelines/handoff.md](references/pipelines/handoff.md) as the complete handoff authoring and execution contract, then use the `handoff` command with a sanitized `handoff-v1` packet. The phrase authorizes exactly one new local CLI continuation endpoint — a sanitized context transfer with new-endpoint lineage, never a session migration; explicit user overrides still win.

## Deterministic loop

1. Resolve the exact repository, source branch, and fixed head/base. Batch independent repository and provider-discovery reads; keep source resolution and dispatch in dependency order. Reuse skill instructions and command help already verified in this session while their source/version is unchanged; refresh mutable repository and provider facts needed for this dispatch. For an unknown MCode model identifier, query `mcode provider list --json` directly and retain only the relevant provider/model/variant fields. Leave delegated code investigation to the endpoint.
2. Write a compact task prompt with five parts: goal, source revision, scope, hard constraints, and deliverables. Preserve all user requirements and necessary evidence or artifact pointers once; omit repeated conversation history and duplicate instructions. Keep the prompt in a private temporary file outside the repository, and remove caller-owned prompt/result files after the consuming command has finished.
3. Inspect `python3 scripts/agent_lord.py start --help` on first use or when the command surface is uncertain or has changed, then run `start` with every explicit user choice. For revision-sensitive local CLI work, use `--repo`, `--source-branch`, one explicit workspace policy, and `--head-sha`; the control plane freezes the resolved checkout as the target. Use `--target` when the exact working directory already is the contract. Do not recreate these preflight checks manually.
4. Process the returned envelope until terminal:
   - `ACTION_REQUIRED`: invoke the exact model-side tool and arguments in `action`; save the raw return value outside the repository, then pass it to `accept`. Add `--auto-read` to `accept` when the next step would only be another polling read; the envelope then carries that read action directly instead of requiring a separate `check`.
   - `RUNNING`: supervise local CLI work with one bounded `checkpoint`, selecting the current task or every active and newly starting pipeline `task_id`, including the pre-task window before its task record exists. Use `check` for a needed full-state diagnosis of one established task, or to request the next Codex App read when `accept --auto-read` was not used. Only `checkpoint` performs recovery; `check` reports state and, when the recorded controller process is gone, an `observed.supervision.recovery_command` hint.
   - `CHECKPOINT_ACTIONABLE`: process every ordinary envelope in `actionable`.
   - `SUCCEEDED`: use the returned artifact as the canonical response.
   - `ERROR`: follow `safe_recovery` only when present; otherwise report the structured error. The Claude `RESULT_INVALID` retry below is the single documented exception.
   - `NEEDS_DECISION`: stop for the authority named by the error. Never convert it into an implicit replacement, model change, source change, or permission expansion.
5. Start a later round with `turn` only after the previous operation is terminal. The script reapplies the saved execution contract and deduplicates an identical in-flight message.

## Claude `RESULT_INVALID` retry

The user authorizes one bounded exception to the `ERROR` rule above: any `claude-cli` operation whose terminal error code is `RESULT_INVALID`, whatever its message, may be retried by the caller. It covers every Claude Code role. The control plane still terminalizes that operation and still emits no `safe_recovery`, so the budget, the fingerprint comparison, and the lineage record are caller-owned; add no runtime implementation to satisfy them.

- **Budget.** Three retry attempts after the original failure, counted across every session for that one logical operation. Stop immediately on success. After the third retry fails, report the structured error and preserve unresolved pipeline state.
- **Same endpoint first.** Retry with `turn` on the same saved `task_id` and provider session, and stay there until the replacement trigger fires.
- **Fingerprint.** Compare consecutive failed results by the error's `code` plus its `message` and nothing else: exclude `operation_id`, `task_id`, attempt history, timestamps, log paths, and every other per-attempt value. A caller may widen the fingerprint with equally stable fields, never narrow it. A different fingerprint resets the consecutive-identical streak to one.
- **Replacement trigger.** When two consecutive failed results share one fingerprint, the next retry must run in a new Claude session. A `task_id` is never rebound, so start a new `task_id` instead, record its `replacement_for` lineage in the caller's run manifest or ledger, and replay only the same authorized logical operation inputs. This policy is the explicit decision that the endpoint-replacement invariant requires. The new session resets the identical-result streak and keeps spending the same three-retry total.
- **Contract.** Same-task and replacement retries alike reapply provider, model, effort, permission posture, target/workspace, fixed source contract, role, semantic scope, and the sanitized inputs the endpoint already had. They may not add a workflow node, change model, source, or permissions, expose a new peer artifact, or substitute the configured fallback stage for the missing result.
- **Pipelines.** This budget is separate from any semantic round or convergence bound and never extends one. A replacement session changes endpoint identity: disclose it in `Pipeline Check` and re-evaluate every identity-continuity and role-independence check against the new endpoint, which may no longer satisfy them.

## Workspace and parallel-write policy

- `shared-readonly`: share or create the source-branch worktree only for `--read-only` local reviews at one fixed head.
- `reuse-or-create`: reuse the one clean source-branch worktree or create it; writable operations hold exclusive workspace and branch leases until the provider operation ends.
- `isolated`: require a writable task plus an explicit distinct `--workspace-branch`; create or reuse that temporary branch worktree from the fixed source head.
- Same-MR parallel writers require caller-declared `--parallel-group`, worker order, one integrator task id, and the original MR source branch as `--integration-target-branch`. Workers use `isolated`; the integrator uses `reuse-or-create` and lists successful worker task ids in order.
- The caller starts the named integrator only after the workers are terminal. Agent Lord validates the declared barrier and isolation contract; it does not invent workers, an integrator, temporary branch names, merge order, or another MR.
- A missing or inconsistent parallel plan returns `NEEDS_DECISION`. Read [references/protocol.md](references/protocol.md) before dispatching concurrent writable tasks.

## Waiting and reporting

`checkpoint` wakes the caller for terminal or model-actionable state before its default 150-second quiet deadline. `CHECKPOINT_QUIET` with exit `124` is healthy: continue with the remaining active task selection. An automatic selection with no active task returns quiet immediately; stop that empty loop and reconcile any expected task. Read the protocol reference for multi-task selection, compact output, and recovery supervision semantics.

- Keep one outstanding checkpoint for the selected task set. If the host tool yields a running command handle, resume that handle until completion; start the next checkpoint only after it returns. Host-tool yields may be shorter than the checkpoint deadline to satisfy responsiveness requirements. An unchanged wait does not call for another `check`, log read, or watcher.
- Report dispatch and meaningful changes such as a new deliverable, recovery, a required decision, or completion. When host instructions require a heartbeat, use one sentence with elapsed time and the last observed state; label stale observations and do not infer current tool activity from silence. Use available sanitized metadata instead of extra queries solely to fill a progress message.
- At completion, read the canonical artifact once and report the result, artifact location, source SHA when applicable, and actual model/variant or its verification limit. When assessing delay, separate caller preparation, endpoint execution, and result retrieval using available timestamps; identify unmeasured intervals. Shorter polling does not make the endpoint execute faster, and any speedup target remains unverified until measured.

## Provider routing and defaults

- Claude Code is an ordinary execution endpoint and may perform any user-assigned implementation, research, review, test, or other node. This execution role is independent of Fable decision routing.
- `claude-cli`: resolve each unspecified model or effort independently from the active Claude user `settings.json`, including a custom `CLAUDE_CONFIG_DIR`; use configured `claude-opus-5` / `high` only when the corresponding setting has no value. Freeze both resolved values at `start`. A generic judgement task does not select Fable implicitly.
- An explicit Claude model preserves that model while an unspecified effort still resolves from user settings; an explicit effort likewise preserves itself while the model resolves. When both are explicit, both win. The default retry plan permits five attempts. When the explicit or resolved primary model belongs to the Fable family, five failed attempts are followed by up to five configured `claude-opus-5` attempts on the same session; report that fallback as the model that actually ran.
- `codex` or `codex-cli`: use Codex CLI, defaulting to `gpt-5.6-sol` with `high`. Treat an unqualified user request for “Codex” as this route.
- `mcode` or `mcode-cli`: require an explicit `provider/model` or `provider/model#variant`; no public default is configured. MCode exposes no independent effort control, so omit `--effort`. A specified variant is frozen and verified from the terminal result; an omitted variant remains explicitly unverified.
- `codex-app`: use only when the user explicitly requests the App/Desktop endpoint. Existing App task handles remain App tasks.

Explicit user values override defaults. `--retry-attempts` overrides the primary Claude stage; the configured Fable fallback budget remains independent. `config/providers.json` is the executable source of truth for these policies.

## Local CLI adapters

Claude maps the default `dangerously_bypass` posture to `--dangerously-skip-permissions`; `--read-only` maps to `--permission-mode plan`. Every initial, resumed, retried, or recovered Claude process receives the frozen model/effort arguments and a child-only environment that defers settings-owned model/route values to Claude's user configuration while preserving credentials, custom headers/base URL, helpers, and config location. It verifies the main model from same-session `system` / `assistant` / `result` metadata; a requested context modifier such as `[1m]` additionally requires matching context-capability evidence. A failed auxiliary `auto_mode` model is published as a sanitized warning when the matching main result succeeded; it does not consume retry budget or trigger fallback. Claude journals streaming progress and retries or recovers only on the saved session under the frozen contract. Read the protocol reference when diagnosing stalls, controller takeover, or retry exhaustion.

Codex CLI maps `dangerously_bypass` to `--dangerously-bypass-approvals-and-sandbox`; `--read-only` applies explicit sandbox and approval config arguments. It runs `codex exec --json`, stores `thread.started.thread_id` as endpoint identity, publishes only `--output-last-message`, and continues through `codex exec resume <session-id>` while reapplying model, effort, and permissions. A `preparing` operation whose controller died is supervised by `checkpoint`: never-launched work is retryable, and a possibly-launched one becomes `DELIVERY_UNKNOWN`.

MCode maps `dangerously_bypass` to `--permission full`; this records MCode permission-policy enforcement and does not claim that every sandbox is disabled. MCode read-only is unsupported because `smart`, `full`, and `off` do not enforce read-only, so `--read-only` fails before dispatch. The adapter uses `mcode exec --input - --cwd ... --model ... --output-format stream-json --output-last-message ...`, resumes only through the saved `--session`, and strictly binds schema-version-1 Session/Turn/Run identities, terminal status, actual model/variant, exit code, and final file. Read the protocol reference for recovery boundaries.

## Codex App action handshake

Codex App host tools are model-side tools, so the script emits an action instead of guessing a shell bridge. The model is a transport carrier:

1. Call exactly `action.tool` with `action.arguments`.
2. Preserve the complete raw tool result in a temporary file outside the repository.
3. Run `python3 scripts/agent_lord.py accept --action-id <id> --result-file <file>`; add `--auto-read` when you only intend to keep polling the same thread.
4. Continue from the new envelope.

The App adapter uses only the supported minimal `list_threads` arguments, treats `threadId` as endpoint identity and `hostId` as mutable routing, and rebinds the same thread before retrying a route-stale send. A transiently failed listing is re-issued within a small bounded budget instead of terminalizing the operation. Its action schema has no sandbox or approval field, so bypass is recorded as `host-inherited-unverified` and read-only remains instruction-only.

## Artifacts and compatibility

Successful local CLI turns automatically publish a final-response-only artifact. Codex App reads do the same; `export-artifact` can extract the final assistant message and model/effort metadata from an existing Claude or Codex JSONL without copying reasoning. A Codex export must contain the exact operation marker, and a Claude export must be a `claude-jsonl` log whose assistant records carry this operation's own session id, so an unrelated turn cannot be mistaken for this result. MCode stream JSON has no independently verifiable Agent Lord operation marker, so `mcode-stream-json` auxiliary import is explicitly refused; the direct adapter remains the canonical artifact path. `export-artifact` is auxiliary: a rejected export never invalidates an already-succeeded operation or its artifact. A Claude session log cannot prove effort, so the export publishes an explicit `EFFORT_UNVERIFIABLE_FORMAT` warning instead of inventing one; the contract itself is still argument-enforced at dispatch.


Version 1 task handles remain readable, but `turn` fails closed because those records did not preserve model, effort, permission, or source. Use `scripts/task_store.py upgrade` with explicit values before continuing one; it never infers the missing contract. The compatibility interface also supports explicit registration and cleanup; new work uses `scripts/agent_lord.py`.

## Read-only live observer

The observer is a TypeScript/Node service in [observer/](observer/) (the earlier Python `scripts/observer_server.py` implementation was removed in favor of it). Build once with `cd observer && pnpm install && pnpm build`, then run `node dist/server/main.js --tasks <task_id[,task_id…]> [--port N] [--token T] [--state-dir DIR]` to serve a loopback-only web view (snapshot + generation:seq cursor + SSE with explicit reset semantics) of the allow-listed tasks: control-plane journal events plus a sanitized projection of the native exec streams for `codex-cli`, `claude-cli` (including partial `stream_event` deltas, deduplicated against full messages), and `mcode-cli` (`codex-app` shows state only, no stream). Tasks whose record has not been created yet (first turn) are discovered from their operation records. The UI is React + vendored Vercel AI Elements components (Conversation/Message/Tool/CodeBlock; provenance and license in `observer/src/web/components/PROVENANCE.md`), with wide-sidebar and narrow-panel layouts, light/dark themes, and collapsed tool cards. It is strictly read-only against dispatch state — it never triggers checks, checkpoints, recovery, or prompts — and its own runtime files live under the independent `<state>/observer/` namespace (`server-<port>.json` records `pid`/`url`/`tasks`). Every request requires the access token printed at startup; reasoning traces, raw logs, prompts, and credentials are never served, and unknown payload types surface only as aggregated "omitted" markers. The task view offers a copyable shell-safe native resume command (`claude --resume ID`, `codex resume -C WORKTREE ID`, `mcode --session ID`) only when a session id is evidenced, labels the evidence source, and marks running tasks as not attachable (resume starts a new turn, it does not attach). Dev loop: `pnpm dev:server` + `pnpm dev:web`; verification: `pnpm typecheck && pnpm test && pnpm build`. Stopping the server never affects the observed tasks.

Read [references/protocol.md](references/protocol.md) when supervising multiple tasks, diagnosing stalls, errors, or recovery, or changing an adapter or state record. Ordinary single-task `RUNNING` supervision follows the loop above. The reference is the source of truth for actionability, recovery, schemas, and error semantics.
