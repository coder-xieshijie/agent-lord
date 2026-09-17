# Plan-to-Implement Pipeline

Load this policy when the user asks Agent Lord to turn an existing implementation plan into merged code, or says `plan-to-implement`. Read [common.md](common.md) first.

One planner CLI turns the user's plan into a module ticket plan. The scheduling caller accepts that plan into a durable run, dispatches every dependency-satisfied module at once, and after the last module delivers, starts exactly one integration CLI that merges, fixes, verifies, and publishes one MR per repository. Keep the graph in the caller; a planner never dispatches a worker, and an integrator never becomes a second coordinator.

The durable state lives in the runtime, not in the conversation. `plan-*` commands hold the plan, the ready set, the barriers, the integrator's per-repository workspace claims, and the run journal, so a restarted caller resumes from `plan-status`.

完成依据是交付事实，不是最后一段自然语言。Runtime 核验端点、提交、整合历史和远端 MR 身份；测试结论来自调度方提交的结构化证据，须明确区分通过和用户接受的已知失败。

## Roles and defaults

| Role | Provider | Model | Effort | Workspace |
| --- | --- | --- | --- | --- |
| Planner | `mcode-cli` | resolved provider default (`custom_provider:mafia-claude/claude-opus-5`) | resolved provider default (`xhigh`) | `isolated`, declares the plan file with `--require-file` |
| Module worker | `mcode-cli` | same resolved default | same resolved default | `isolated`, one worktree and `--workspace-branch` each, `--require-commit` |
| Final integrator | `mcode-cli` | same resolved default | same resolved default | `isolated` on the primary repository, `--require-commit`; other repositories come from run-held claims |

Resolve and freeze model and effort independently from provider configuration at dispatch, then pass both explicitly so the whole run shares one execution contract. `codex-cli` and `claude-cli` are supported for any role through a global or per-role override; every provider-specific effort remains explicit. These pipeline choices change no ordinary provider default.

Start every role in `dangerously_bypass` without `--read-only`, and put the task-level write boundary in the prompt.

## Planner

Start the planner with `--require-file <plan.json>` so the runtime verifies the plan file as declared delivery. Its prompt carries the user's plan, the repositories with their fixed heads, and the granularity rule below.

Split by whole module or subsystem — a coherent unit one endpoint can own end to end. A file, a single function, an interface, or one test case is too small; a ticket per module keeps ownership, review, and rollback aligned with the code.

The planner returns an `implementation-plan-v1` document ([schema](../../schemas/implementation-plan-v1.schema.json)):

```bash
node core/dist/cli.js plan-validate --plan-file /tmp/run/plan.json
node core/dist/cli.js plan-create --run-id feature-x \
  --plan-file /tmp/run/plan.json --planner-task-id feature-x-planner
```

`plan-validate` is a pre-check on any file and creates nothing. It enforces the contract the barriers depend on: every module carries a responsibility, acceptance criteria, and `owned_paths`; dependencies reference declared modules and stay acyclic; two modules in one repository never own overlapping paths; each repository declares one fixed 40-hex `head_sha` and one `delivery_branch`; and no module declares its own MR. Send a rejected plan back to the planner with the returned `PLAN_INVALID` details. A plan that validates proceeds under the authority already granted — ordinary granularity and dispatch choices need no further user approval.

`plan-create` accepts the plan into the run and records the planner as a run role. The planner task must have succeeded, and the plan file must be one of its verified delivery files; an arbitrary local JSON document is rejected with `ENDPOINT_UNVERIFIED`. Replaying the same plan and planner is idempotent and never creates a second planner; a changed plan or a different planner under the same `run_id` returns `RUN_EXISTS`.

## Dispatch the ready set

`plan-status` returns `ready` — every pending module whose dependencies are all delivered. There is no worker cap: dispatch the entire ready set concurrently, bounded only by workspace leases.

```bash
node core/dist/cli.js plan-status --run-id feature-x
node core/dist/cli.js plan-dispatch --run-id feature-x --module-id auth-core \
  --task-id feature-x-auth-core --provider mcode-cli --model "$MODEL" --effort "$EFFORT"
```

先 `plan-dispatch`，再 `start`。Runtime 从已登记角色补齐 repository、source、workspace policy 和 commit requirement；显式参数与计划冲突会被拒绝，worker 仍须给出自己的 `--workspace-branch`。依赖屏障、任务绑定和 Observer 分组保持在这个 run 内。旧的先 start 后登记记录仍可读取，但完成时同样必须有有效的 commit delivery。

CLI `start` / `turn` 返回 `RUNNING` 派发回执，独立控制器持续持有执行与写锁。用 `checkpoint --run-id ... --include-response` 取得终态；等待命令结束或超时不代表执行失败，也不会终止控制器。控制器真的消失时，沿用 checkpoint 的恢复与进程身份核验。

Give each worker its module responsibility, acceptance criteria, `owned_paths` as its write boundary, the sanitized interface contracts of the modules it depends on, and its repository's fixed head. A worker commits locally on its own branch and never pushes, opens an MR, or edits another module's paths.

When a worker returns, record the outcome:

```bash
node core/dist/cli.js plan-deliver --run-id feature-x --module-id auth-core --state delivered
```

`delivered` is a verification, not a claim. The runtime requires the bound task to exist, its current operation to have succeeded, and its declared delivery to be verified with a real commit — which is why every worker needs `--require-commit`. The verified commit is adopted as the module's delivery commit and is what unlocks downstream modules; passing a `--commit-sha` that disagrees with it is rejected. A retried or recovered task is judged by its current operation, so an older success cannot stand in for a failed attempt.

Record a genuine failure as `--state failed`; `plan-reset` returns that module to pending for a replacement endpoint under [endpoint replacement](../../SKILL.md#endpoint-replacement), and the journal keeps both attempts.

## Final integration

The last barrier opens only when every module is `delivered`. One integration CLI runs even when a single module produced all the work — the integrator is a distinct role, never a delivery turn reused from a worker.

```bash
node core/dist/cli.js plan-integrate --run-id feature-x --task-id feature-x-integrator
```

`plan-integrate` prepares each declared repository's `delivery_branch` worktree at its frozen head and records a durable [workspace claim](../protocol.md#durable-workspace-claims) owned by that one integrator task. This is what makes a single multi-repository integrator safe: a task's own leases cover only the one repository it targets, so the run holds the others. While the claims exist, any other Agent Lord task that tries to write a claimed worktree or delivery branch fails with `WORKSPACE_CLAIM_CONFLICT`. Each claim is taken under the same `workspace-write` and `branch-write` locks an ordinary writer uses, so two runs competing for one repository cannot both pass the check — the loser gets `WORKSPACE_CLAIM_CONFLICT`, and a repository already being written returns a retryable `STATE_BUSY`. Replaying `plan-integrate` with the same task reuses the existing claims instead of re-preparing them.

`plan-integrate` 后以该 `task_id` 调用 `start`，Runtime 自动使用计划第一个仓库及其已占用的 delivery worktree，冻结角色交付要求。其他仓库的路径从 `plan-status` 传入 prompt，并声明它们是主仓库之外的完整写入边界。

The integrator merges every module branch into each repository's `delivery_branch`, resolves conflicts, fixes the problems merging exposes, runs the whole-project verification, pushes, and opens or updates each repository's single MR. It never merges an MR. It also writes the process report. Because these commands verify the integrator's finished result, the scheduling caller runs them after the integrator returns — never the integrator itself mid-run.

```bash
node core/dist/cli.js plan-merge-request --run-id feature-x --repo /path/repo \
  --mr-url https://gitlab.example/group/repo/-/merge_requests/42 --head-sha "$HEAD" \
  --verification-file /tmp/run/repo-verification.json
node core/dist/cli.js plan-report --run-id feature-x --report-file /tmp/run/report.md
```

`plan-merge-request` 要求 integrator 当前 operation 成功且有 verified commit delivery，仓库 claim 有效，SHA 与本地 delivery branch 一致。主仓库还要与端点核验的 commit 一致。Runtime 通过已认证的 `gh api` / `glab api` 回读 MR/PR，核验 origin 项目、source branch、target branch（计划的 `source_branch`）、SHA 和 opened 状态；目前支持同项目 GitHub / GitLab PR/MR，fork 与其他 forge 明确拒绝。每仓库一个 URL，重复登记同 URL 可更新 SHA 和证据。

验证文件绑定最终 SHA，`checks` 覆盖该仓库所有模块的 `verification` 字符串，以及名为 `ci` 的检查：

```json
{
  "head_sha": "<40-hex final SHA>",
  "checks": [
    {"name": "pnpm test", "status": "passed", "evidence": "测试日志路径或链接"},
    {"name": "ci", "status": "accepted_failure", "evidence": "pipeline/job 链接", "reason": "用户明确接受的已知问题及授权依据"}
  ]
}
```

`passed` 必须有实际证据；`accepted_failure` 只用于用户已经授权接受的失败或未执行项，必须保留原因和依据。未结束的测试/CI 继续等待，未获接受的失败继续修复或报告阻塞。Runtime 检查证据结构和 SHA，不代替调度方执行测试或判断豁免授权，也不把自报测试结论当成独立证明。

`plan-report` 再次核验全部仓库：干净的 delivery branch、最终 SHA、相对原始计划基线的增量、每个模块的 merge 或 patch-equivalent cherry-pick、完整验证记录，以及远端 MR 身份。Squash/改写导致 patch 无法对应时会拒绝，保留可追踪的模块整合历史。成功后持久化报告再释放 claims；相同报告重试可清理中断遗留的 claims，不同报告返回 `REPORT_CONFLICT`。

整合恢复优先复用同 task 的 `recover` / `turn`；必须换 session 时：

```bash
node core/dist/cli.js plan-integration-resume --run-id feature-x \
  --task-id feature-x-integrator-2 --reason "原执行已终止，需要新会话完成剩余验证"
```

该命令先核验旧 operation 已终止、相关进程已退出、所有工作区干净且历史未倒退，再转移 claims，保留工作区、commit、MR、验证记录和模块状态。然后对新 task 调用 `start`，从原交付 HEAD 继续。角色交付基线始终是原计划 SHA，所以只补测试或报告的恢复不必制造新 commit。交接中断则重复同一 resume 命令；完成交接前禁止启动两边的角色。`plan-integration-reset` 只用于明确放弃本次整合登记，不能用于普通恢复；它仍会清空 MR/workspace 登记，并同样拒绝释放活跃执行的 claims。

Worker 成功不等于 run 成功。最终报告分别列出 Runtime 已核验的提交/MR 事实、实际测试结果、用户接受的例外和仍未验证的平台边界。已关闭 run 的角色不再接受新执行；后续改动使用新 task/run，保留已验收交付的边界。

## Process record and report

The run journal is the process record. It holds the planner's identity and accepted plan digest, each module's dispatch with provider identity and the dependencies it waited on, each verified delivery commit or failure, resets, the integration dispatch with its claimed workspaces, recorded MRs with the branch heads they were checked against, and the closing report digest. Read it with `plan-status`. It carries shareable decisions, actions, and results only — never hidden reasoning or raw provider logs.

Write the final user report from that journal under the [explain-as-fool rules](../explain-as-fool.md): lead with the goal and what now exists, then the key decisions, the module split and who did what, what ran in parallel and what waited, the conflicts and how they were resolved, the verification evidence, each repository's MR, and the limits that remain. Write it for someone who has not seen this run, in plain language, without a turn-by-turn log.
