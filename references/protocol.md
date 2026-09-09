# Agent Lord deterministic protocol

Read this reference when supervising multiple tasks, diagnosing stalls, errors, or recovery, or changing an adapter or state record. Ordinary single-task `RUNNING` supervision follows the loop in [SKILL.md](../SKILL.md).

## Public result envelope

Every command prints one JSON object. `schemas/result-v1.schema.json` is the maintained shape.

| Status | Meaning | Caller action |
|---|---|---|
| `ACTION_REQUIRED` | A Codex App host-tool action is durably pending | Invoke the exact tool and arguments, then `accept` its raw result |
| `RUNNING` | The provider operation is preparing, progressing, waiting, stalled, or recovering | Continue bounded `checkpoint` supervision; use `check` for full-state diagnosis or the next App read |
| `SUCCEEDED` | Endpoint, execution contract, and final artifact passed the available checks | Consume the artifact; assess `delivery` separately |
| `ERROR` | Deterministic validation or provider execution failed | Use only the emitted safe recovery, if any, plus the caller-owned Claude `RESULT_INVALID` retry in `SKILL.md` |
| `NEEDS_DECISION` | Recovery changes identity, authority, source, or delivery semantics | Stop for an explicit decision |
| `CHECKPOINT_ACTIONABLE` | One or more selected tasks have durable actionable state | Process every envelope in `actionable` |
| `CHECKPOINT_QUIET` | No actionable state change occurred in the bounded interval | Exit `124`; resume the foreground checkpoint loop later |

An `ACTION_REQUIRED` record is idempotent. Re-running the same `start`, `turn`, or checkpoint returns the already-pending action instead of creating a second provider operation.

Dispatch is serialized by a per-task filesystem lock. The journal is written before provider execution, so a concurrent caller either receives the existing operation or `STATE_BUSY`; it cannot create a second endpoint or turn.

## Invocation metadata

`start`、`turn`、`recover`、`handoff` 接受可选的 `--invocation-file <private-json>`，在派发前校验并把调用来源冻结在本次 `operation.invocation`。它不修改 task 的执行契约，也不会在重试、重复 start 或查询时覆盖原调用者。旧 operation 保持可读，缺失来源显示为未记录。

```json
{
  "trigger": "user_request",
  "user_request": "这里逐字保存本次用户原始请求，包括换行。"
}
```

`--message-file` 仍是实际交给执行端的任务正文。`user_request` 是另存的用户原话；二者不相互推断或替代。调度方自行补充的后续轮次使用 `trigger: "caller_followup"` 和 `reason`，不伪装成用户新消息；`recover` 强制记为 `recovery`。没有来源信息时使用 `unspecified`。输入文件由调用者在结果收取后清理；durable operation 保留请求用于只读回放。

| 输入字段 | 约束与来源 |
|---|---|
| `user_request` | 可省略或为 null；非空字符串，最多 1,000,000 字符，逐字保存 |
| `reason` | 可省略或为 null；补充或恢复的原因，最多 16,000 字符 |
| `trigger` | `user_request` / `caller_followup` / `recovery` / `unspecified` |
| `caller` | 可选对象；显式填写时必须含 `kind`，可含 `session_id`、`turn_id`、`data_root` |

省略 `caller` 时，脚本从宿主的 `CODEX_THREAD_ID`（兼容 `CODEX_SESSION_ID`）、可选 `CODEX_TURN_ID` 和 `CODEX_HOME` 捕获来源；数据根默认 `~/.codex`。`identity_source: "runtime-env"` 表示宿主环境来源，不是密码学身份验证。显式 caller 标记为 `caller-declared`，不会借用当前宿主的 Session、Turn 或数据根；没有 Session 则标为 `unavailable`。不要从 prompt 或最近活跃会话猜测身份。

`kind` 与非空 id 只允许 `[A-Za-z0-9][A-Za-z0-9._:-]*`，最多 160 字符；Turn 必须同时提供 Session。显式 `data_root` 必须是绝对路径，仅 Codex caller 保留它。输入不接受自行声称的 `identity_source` 或其他未知字段。调用者身份变量不会传入 provider 子进程，避免后续嵌套调用误认父 Session；子运行时应提供自己的身份，否则保持未知。

观察页按首次 operation 与当前 operation 分别显示最初调度者、本轮调用者，并按轮次展示原始请求和实际派发正文。Codex 生命周期读取只定位该数据根下唯一匹配的 Session 日志，并校验 `session_meta`；仅投影匹配 Turn 的开始、结束和精确 operation 成功回执时间。未观测、日志不支持、身份不匹配均显示未知，不把执行端结束当成主调度结束；宿主正文与推理内容不进入页面。`data_root` 只留在本地服务端。

## Inline terminal response

`start`、`turn`、`recover`、`handoff`、`accept`、`check`、`checkpoint` 支持可选的 `--include-response`。成功 envelope 增加 `response: {"text": "完整最终正文", "read_at_ms": 1788928363000}`；checkpoint 对每个成功 `actionable` 项应用同一规则。默认仍不返回正文，非成功项不附加正文。

读取只接受当前 task/operation 的 canonical artifact，核对真实路径、SHA-256、字节数与 UTF-8。文件被改写、丢失或符号链接越界时返回 `ARTIFACT_INVALID`，不改变已成功的 operation。原有 `artifact` 和 `delivery` 含义不变；正文不是语义验收证明。

普通 operation envelope 同时带 `provider_return_code`（未记录则 null）与 `timing.created_at_ms`、`timing.completed_at_ms`。`response.read_at_ms` 是脚本完成读取的时刻，不能替代宿主真正收到结果的时刻。观察页分别展示执行端结束、产物发布、主调度收到结果、主调度结束；缺少任一时间点时不计算对应耗时。收尾使用一次终态 envelope 和正文读取，复用已绑定的观察页，收取尚未回收的控制器句柄并清理私有输入，不再增加浏览器核验或重复状态查询。

## `check` versus `checkpoint`

The two commands are not interchangeable:

- `check --task-id <id>` reconstructs one task's full current envelope and never supervises. For a `codex-app` task it also creates the next polling read action. When the recorded controller process for a non-terminal local CLI operation is gone, the envelope adds `observed.supervision = {"controller_state": "exited", "recovery_command": "checkpoint"}`; that hint is advice, not recovery.
- `checkpoint` fences, recovers terminal facts, terminalizes a dead controller's operation, or waits. It returns compact `active` entries rather than full envelopes. The separate `recover` command consumes an emitted MCode continuation action and starts a bounded new turn on the same Session.

So a `RUNNING` envelope from `check` never becomes terminal by itself: run `checkpoint` when the hint appears or when the caller asked for supervision.

## Actionable-only checkpoint supervision

Repeat `--task-id` to supervise a caller-selected set in one checkpoint; omit it to freeze the set of active tasks observed when the call starts. Actionable wake returns `CHECKPOINT_ACTIONABLE` with every currently terminal or pending-action envelope for the selected tasks. This is a durable snapshot, not a destructive dequeue: repeated calls may return a previously seen envelope, and a later actionable task is returned alongside it instead of being lost or starved. Task selection is the seam for a caller-owned dependency or next-dispatch policy; checkpoint itself neither evaluates dependencies nor dispatches another operation.

Actionable means exactly:

- an already-pending or newly-created `ACTION_REQUIRED` action;
- `SUCCEEDED`, `ERROR`, or `NEEDS_DECISION` terminal state;
- failure to preserve the saved identity during automatic recovery, including exhausted provider or recovery-controller budget.

`updated_at`, progress sequence changes, provider output, tool activity, and other benign progress update durable state without returning. `suspected_stall` and `recovering` are also internal while the saved retry plan and session identity permit automatic handling. The TypeScript control plane polls process/log/journal state at a short interval using Node.js timers and filesystem APIs; this polling runs inside the checkpoint command and consumes no Agent token. Portable event notification can replace that polling behind the same interface later.

The quiet deadline comes from `control.checkpoint_seconds`, whose default is 150 seconds; `--seconds` overrides one call. Deadline expiry returns `CHECKPOINT_QUIET` and exit `124`. An automatic selection with no active task returns quiet immediately. Each `active` item contains task/operation/provider identity, status and progress sequence, plus content-free activity fields when available: last event/tool, active tool names/count, last progress timestamp and its age in seconds. MCode removes completed tools from that active set and clears it at terminal state. Full operation state stays in the journal and remains available through `check`.

One checkpoint parses each task, operation, and action record at most once per tick, and skips records it has already attributed to a task outside the selection. Attribution uses only `task_id` and `operation_id`, which exclusive record creation writes once and never rewrites; it is never inferred from an identifier prefix, because identifiers are caller-supplied.

Claude controller-death retry recovery is launched as a private Node.js worker using the same compiled TypeScript runtime. A kernel-managed controller lease spans operation preparation and the entire retry loop and is released automatically when its process exits. Checkpoint takes over only after that lease is obtainable and the durable owner is no longer live; retry state and ownership are updated in one journal mutation. The launch count plus frozen retry plan bounds takeover, so a long healthy recovery may outlive one quiet interval without duplicate dispatch.

Before Claude retry recovery, POSIX supervision fences the complete process group with TERM, then KILL after the grace interval, and confirms the group disappeared. Windows uses the platform process-tree termination command and confirms process exit. Failure to complete the fence is terminal and no recovery attempt starts. A prompt is `not-delivered` only after a definite launch failure. Once Claude delivery is `delivery-unknown` or `stdin-attached`, recovery uses one uniquely marked continuation on the same session UUID after a successful fence; if the possible provider process cannot be identified and fenced, recovery fails closed. Every exhausted retry path emits `retryable=false`, no `safe_recovery`, and `details.retry_exhausted=true`.

MCode uses no automatic prompt replay. The first `session.started` or `session.resumed` event durably records Session, Turn, and Run identity and creates the task handle, so `check` can expose live progress. If its controller dies while the dedicated operation process group remains, `checkpoint` fences only that group and then evaluates the operation's own stream. A complete non-success terminal record is failure; a complete success is publishable only with a durably recorded zero exit code. Missing terminal facts, an unknown exit code, or an unfenceable delivery becomes `DELIVERY_UNKNOWN` with the saved Session retained. No checkpoint sends the prompt again or creates a replacement Session.

A Codex or MCode CLI operation can also die in `preparing`, before any provider pid exists. Checkpoint terminalizes that window from the journal, without guessing: when `provider_command` was never recorded the launch definitely did not happen, so the operation fails with retryable `PROCESS_EXITED_WITHOUT_RESULT` and `RETRY_SAME_COMMAND`; when `provider_command` was already recorded the launch may have happened and cannot be fenced, so the operation becomes `DELIVERY_UNKNOWN` as `NEEDS_DECISION`. A live controller pid keeps the operation quiet.

Codex App host tools remain model-mediated. Checkpoint returns an existing action promptly but does not synthesize a polling read at the quiet deadline; call `check`, or pass `--auto-read` to the preceding `accept`, when a new App read action is intended.

## State ownership

The script is the only writer under `${AGENT_LORD_STATE_DIR:-$HOME/.codex/state/agent-lord}`:

```text
<task-id>.json                 durable endpoint and execution contract
operations/<operation-id>.json
actions/<action-id>.json       model-mediated Codex tool request
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

A `handoff` operation is a third initial-operation kind beside `start` and `turn`-continued work: it consumes one validated `handoff-v1` packet (`schemas/handoff-v1.schema.json`), stores the canonical packet as an input artifact, freezes the workspace snapshot in its `handoff` manifest, and writes an immutable `lineage` record into the continuation task it creates. Lineage means `continues_user_task` on a brand-new endpoint; source-session identity stays `caller-declared` or `unavailable`, never `verified`. Policy, authorization, and the packet contract live in `references/pipelines/handoff.md`.

## Execution contract

The durable task record owns:

- provider and immutable endpoint id;
- current route and route history;
- target;
- explicit model and applicable effort;
- an ordered retry plan whose stages freeze model and attempt budget;
- explicit permission posture (`dangerously_bypass` by default; `--read-only` is an explicit override);
- fixed source head/base when supplied, plus the last verified head of a writable repo-managed checkout.
- frozen workspace policy, repository, source branch, and isolated branch when supplied;
- a caller-declared parallel worker/integrator contract when supplied.

Provider arguments enforce the frozen model and applicable effort on every operation. Claude success requires observable main-model metadata from the same session. `system.init.model` and `assistant.message.model` are authoritative; `result.modelUsage` is a fallback when it names one unambiguous model. Same-model canonical and context-modified spellings may coexist, but every usage/canonical id must match the verified family and version. A requested context modifier such as `[1m]` requires matching modifier or `contextWindow` evidence; absent or contradictory evidence fails closed. Provider diagnostic lines are parsed separately from JSON message content. A failed `query_source=auto_mode` model becomes a sanitized `AUXILIARY_MODEL_UNRECOGNIZED` warning when the matching main result succeeded, without consuming retry budget or triggering fallback. Codex CLI stores the `thread.started` UUID and requires `turn.completed`; Codex App actions carry the explicit contract. MCode requires an explicit qualified model and validates terminal Session/Turn/Run plus model and any requested variant; it records effort as unsupported rather than inferring one.

`export-artifact` is an auxiliary import path, not a delivery. It never rewrites an already-terminal operation, so a rejected export leaves a `succeeded` operation and its canonical artifact intact; only a non-terminal operation is invalidated. A Codex rollout import must contain the exact operation marker and additionally verifies `turn_context` model and effort. A Claude import must be `claude-jsonl` and every candidate assistant record must carry this operation's own session id; a log with no such record is `RESULT_INVALID`. A Claude session log carries no effort field, so effort cannot be proven from it. Rather than fabricate a value or reject a valid transcript, the export publishes `{"code": "EFFORT_UNVERIFIABLE_FORMAT", "source_format": ..., "expected_effort": ...}` — the second declared warning variant in `schemas/result-v1.schema.json`. Effort itself remains argument-enforced at dispatch and recorded as `effort_verification`. MCode `stream-json` does not expose a separately verifiable Agent Lord operation marker, so `mcode-stream-json` import is refused without changing an existing success; the direct adapter's verified final file is authoritative.

Permission policy lives in `config/providers.json`; the selected mode is frozen in the durable task contract and resolved again before every operation. Claude Code maps bypass to `--dangerously-skip-permissions`; Codex CLI maps it to `--dangerously-bypass-approvals-and-sandbox`. MCode maps bypass to `--permission full` and records `mcode-permission-full-argument`; this is MCode permission-policy enforcement, not a claim that the argument disables every sandbox. MCode has no enforceable read-only mode because `smart`, `full`, and `off` are not read-only, so `--read-only` fails before dispatch. Codex App exposes no approval or sandbox argument, so it records bypass as `host-inherited-unverified` and read-only as `instruction-only`.

For Claude, each unspecified field resolves at task start from the active user `settings.json` (`CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`): `model` supplies the model and `effortLevel` supplies effort. The configured `claude-opus-5` and `high` remain per-field fallbacks. Explicit model and effort arguments override independently, and the resolved pair is stored in the task contract, so later settings changes cannot rewrite it. Fable-family tasks append a five-attempt `claude-opus-5` fallback stage. `--retry-attempts` overrides only the primary stage; the configured fallback budget is independent and is not scaled by it. The primary and fallback stages reuse the same session UUID, and `--resume` on that session means a failed attempt's partial work stays in the transcript the next attempt reads — that is the deliberate trade-off for preserving endpoint identity, not a defect. After the frozen plan is exhausted, the terminal error has no automatic recovery. Codex CLI and Codex App defaults are unchanged: `gpt-5.6-sol` with `high`, and unqualified `codex` resolves to `codex-cli`. MCode has no public default: `start` and `handoff` require `provider/model` or `provider/model#variant`; later turns replay that literal. No independent `--effort` exists, so any non-empty effort is rejected.

At every Claude process launch, including retry and recovery, the adapter builds a child environment without mutating its parent. It removes only inherited model/route/effort keys for which the selected Claude settings file is authoritative; environment-only credentials and unrelated Claude/Anthropic values remain intact, as do `CLAUDE_CONFIG_DIR`, the configured binary override, base URL, custom headers, and credential-helper settings. Settings values other than the resolved model/effort are neither copied into task records nor emitted in artifacts.

Claude and MCode emit stream progress into the operation journal. MCode stores only identity, sequence, event type, process state, and timing metadata there; raw reasoning and tool records stay in private logs. Provider configuration owns progress polling and termination grace intervals. Claude additionally uses `provider_wait`, `progressing`, `tool_wait`, `suspected_stall`, `provider_failed`, or `recovering`, with a 900-second default no-progress deadline and 3600 seconds for known tool activity.

### CLI surface

`--codex-environment` and `--starting-branch` describe a Codex App thread and have no meaning for `claude-cli`, `codex`, `codex-cli`, `mcode`, or `mcode-cli`. They have no parser default, so passing either to a CLI provider is rejected with `CONFIG_INVALID` instead of being silently dropped. Configuration itself is read while the parser is built, so an unreadable or invalid `config/providers.json` still exits as one `ERROR` envelope rather than a bare traceback.

### Local worktree preparation

Local Claude, Codex CLI, and MCode starts may replace `--target` with `--repo`, `--source-branch`, one workspace policy, and a fixed `--head-sha`. The control plane performs no fetch and never removes a worktree. New worktrees default to `worktrees/<task-id>` under the Agent Lord state directory; `--worktree-root` overrides only that parent. Because MCode rejects `--read-only`, it cannot use `shared-readonly` in this phase.

The policies are structural:

- `shared-readonly` accepts only `--read-only`, then shares or creates the clean source-branch worktree at the fixed head.
- `reuse-or-create` reuses the one clean worktree bound to the source branch or creates it from an already-available local branch, `origin` tracking ref, or commit.
- `isolated` accepts only writable tasks and requires a distinct explicit `--workspace-branch`. It creates or reuses that branch's worktree from the fixed source head without binding another worktree to the MR source branch.

The resolved worktree path becomes the operation and durable task target. A dirty worktree, conflicting branch head, unavailable fixed commit, ambiguous binding, or occupied destination fails with `SOURCE_MISMATCH` or `SOURCE_UNVERIFIED`. Existing `--target` starts keep their original source behavior and receive an exact-target workspace contract. Preparation runs under a per-`(repository, checkout branch)` lease and lists worktrees once; brief lease contention uses the configured bounded lock retry budget before returning retryable `STATE_BUSY`. The final proof is the target's own clean status and head, not a repeated listing.

#### Source verification across turns

`start` freezes `contract.source.head_sha`, which never changes. What a later `turn` must prove depends on the contract:

- Read-only tasks and `exact-target` tasks stay strict: `HEAD` must still equal the frozen `head_sha`, otherwise `SOURCE_MISMATCH`.
- A writable repo-managed task is expected to commit. Its checkout must still be on the contract branch (`isolated` → `workspace_branch`, `reuse-or-create` → `source_branch`) and its `HEAD` must be a descendant of the last verified head. Leaving the contract branch, or a head that is not a descendant, is `SOURCE_MISMATCH` with the observed branch or head in `details`.
- The verification baseline is `contract.source.verified_head_sha` when present and `head_sha` otherwise. A successful check persists the observed head as the new `verified_head_sha` in the same durable record, so the advance is recoverable after a crash and monotone: the task can never silently move backwards or onto another branch. `verified_head_sha` without `head_sha` is `STATE_CORRUPT`.

Every writable local CLI operation holds an exclusive workspace lease until provider completion. Repo-managed operations also hold an exclusive checkout-branch lease. Read-only operations take the same workspace lease in shared mode, so any number of readers share one fixed-head checkout while a writer is still excluded in both directions; contention returns `WORKSPACE_WRITE_CONFLICT` (`details.requested = "read-only"` when a reader was refused) or `BRANCH_WRITE_CONFLICT`.

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

| Code | Meaning | Default disposition |
|---|---|---|
| `CONFIG_INVALID` | Invalid task input or unsupported configured value | Correct input |
| `TASK_EXISTS` / `TASK_UNKNOWN` | Logical identity conflict or missing task | Correct identity; do not guess |
| `EXECUTION_CONTRACT_REQUIRED` | A legacy handle lacks model, effort, permission, or source truth | Explicitly upgrade the same handle before continuing |
| `OPERATION_IN_FLIGHT` | Previous turn is not terminal | Check the same operation |
| `SOURCE_MISMATCH` / `SOURCE_UNVERIFIED` | Fixed source cannot be proven | Correct the checkout or obtain a decision |
| `WORKSPACE_WRITE_CONFLICT` / `BRANCH_WRITE_CONFLICT` | Another live or unfenced writable local task owns the worktree or checkout branch | Wait for it, run `checkpoint` to fence it, or declare an isolated worker |
| `PARALLEL_WRITE_PLAN_INCOMPLETE` | Same-MR parallel write metadata, barrier, or order is incomplete or not unique | `NEEDS_DECISION`; correct the caller-owned plan |
| `HANDOFF_PACKET_INVALID` | Handoff packet fails schema, bounds, sanitization, integrity, or secret checks | Fix the packet; nothing was dispatched |
| `HANDOFF_CONFLICT` | Handoff arguments, packet binding, or an existing continuation task disagree | Fail closed; a different continuation needs a new `task_id` or corrected inputs |
| `MODEL_UNRECOGNIZED` | Provider did not recognize the requested main model and no valid matching main result exists | Retry the same endpoint with the saved contract |
| `MODEL_MISMATCH` / `MODEL_UNVERIFIED` | Observed result does not prove the requested model | Invalidate a non-terminal operation; retry the same endpoint |
| `EFFORT_MISMATCH` / `EFFORT_UNVERIFIED` | Provider log contradicts saved effort, or a format that could prove it did not | Invalidate a non-terminal operation and retry the same endpoint |
| `ENDPOINT_ROUTE_STALE` | Codex host routing changed | Resolve the same `threadId`, update route history, retry once |
| `ENDPOINT_GONE` | Same endpoint cannot be rediscovered | `NEEDS_DECISION`; replacement is a new identity |
| `DELIVERY_UNKNOWN` | Send lacks a trustworthy receipt or durable exit status | Preserve the endpoint; do not resend without provider-specific proof or an explicit decision |
| `ENDPOINT_MISMATCH` | Provider result belongs to another endpoint | Fail closed |
| `RESULT_INVALID` | Provider output lacks the required result shape | Fail closed and preserve private logs; a terminal `claude-cli` one additionally allows the caller-owned bounded retry in `SKILL.md` |
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
- recover a completed local CLI result from the prewritten journal after the original controller disappears, only when its provider exit status is durable;
- fence a stalled Claude process group, confirm exit, and append one uniquely marked continuation query through `--resume` on the same session;
- let the private recovery controller claim that same recovery when the original controller is dead.

The implementation returns `NEEDS_DECISION` when a replacement endpoint, provider/model/effort/source change, permission expansion, or external write requires authority that has not already been supplied. A missing safe recovery action alone is not a request for permission.

The Claude `RESULT_INVALID` retry in `SKILL.md` is not part of this line: it is caller-owned, so such an operation still terminalizes with no `safe_recovery`, and its replacement session is a new `task_id` with caller-recorded lineage rather than a rebound endpoint.

MCode checkpoint recovery stops at the existing Run boundary. For a verified transient failure, the terminal error may additionally offer `safe_recovery=CONTINUE_SAME_SESSION`. The caller consumes it with `recover --task-id <id> --operation-id <failed-id>`; no further permission question is needed within the existing task authorization. The command revalidates the original stream, Session/Turn/Run, model/variant, durable exit code 4, failed/timeout status, runtime `retryable=true` error, and absence of a live provider process group. Cancelled, limit-exceeded, unknown delivery/exit, or unverified identity/model results do not qualify.

New MCode tasks freeze `config.providers.mcode-cli.same_session_continuations` (default 2, range 0–5) as `contract.continuation_limit`. Existing contracts without the field retain a zero budget. Each recovery creates a new `turn` operation on the same saved Session with a short continuation instruction to inspect existing work and finish only remaining requirements; it never replays the original prompt. The child records parent/root operation and attempt/limit, while the failed parent is immutable. Repeated or concurrent recovery of that parent returns the same child. Each failed continuation spends the same chain budget. The command rechecks the frozen contract, source and write leases; only the latest failed operation can create a child. A normal user-requested `turn` starts a new logical chain.

## Declared delivery evidence

For local CLI `start`/`turn`, repeated `--require-file <workspace-relative-path>` checks that every declared file exists, is non-empty and resolves inside the workspace. `--require-commit` checks a new descendant of the dispatch-time HEAD and a clean worktree. Requirements are operation-scoped and inherited by `recover`; an ordinary new turn declares its own requirements. Repeating an in-flight request cannot silently change them.

`SUCCEEDED` continues to mean execution success. Its separate `delivery` record has scope `declared-files-and-commit` and status `verified`, `incomplete`, or `unverified` (no requirements, including old operations). Checks record files and optional commit evidence; the observer displays these separately. No semantic tests, browser behavior, or license correctness are inferred from a provider's final prose. A missing declared file keeps delivery incomplete even if the CLI exited successfully.

## Codex transports

Codex CLI is the default Codex transport. It runs non-interactively, extracts the endpoint from `thread.started`, and resumes only by the exact saved session UUID. The operation marker remains in the prompt so an exported rollout can be tied to one operation.

## MCode Exec transport

The first phase is the non-interactive `mcode exec` adapter; ACP history, steer, queue, delegation, and long-lived control are outside this transport. The binary honors `AGENT_LORD_MCODE_BIN`. Each operation invokes `--input -`, the exact `--cwd`, frozen `--model`, `--permission full`, `--output-format stream-json`, and an operation-specific `--output-last-message`; later turns add only the saved `--session` and never use `--continue`.

Every non-empty stream record must be a supported `schemaVersion=1` event with contiguous sequence and one consistent Run/Session/Turn tuple. Success requires exit zero, exactly one final `exec.completed`, a schema-version-1 `exec.result` with `status=succeeded`, matching Turn terminal and model metadata, any explicit variant, and a fresh final file equal to `output`. String output compares literally; structured output compares with the parsed JSON file value. The only accepted non-success statuses are `failed`, `timeout`, `cancelled`, and `limit_exceeded`; unknown statuses are protocol errors. Artifacts contain only the verified final file.

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

A `list_threads` action that itself fails transiently (a timeout, a transport error) does not end route recovery. The same listing is re-issued, carrying the original `resume_action_id` and `resume_kind`, for a bounded three attempts counted from the operation's own failed `codex.list` actions; only the last one terminalizes with `PROVIDER_FAILED`.

A `codex.read` whose result is not ready yet is not an error either: `accept` keeps the operation non-terminal and returns the next read. `accept --auto-read` returns that read in the same envelope instead of requiring a separate `check`. The flag is opt-in and changes no field of the default envelope; without it, an accepted send stays `submitted` and quiet exactly as before.

App routing is independent of the CLI session namespace. Never migrate an existing `codex-app` task handle to `codex-cli` implicitly.

`config/providers.json` owns provider capabilities, Claude default-resolution and child-environment policy, plus checkpoint, stall, termination grace, progress poll, dead-process grace, and lock retry constants. Dynamic facts such as `hostId`, PID, process group, Session/Turn/Run, controller lease/launch count, recovery marker, operation state, and observed model never belong in configuration.
