# Plan-to-Implement Pipeline

Load this policy when the user asks Agent Lord to turn an existing implementation plan into merged code, or says `plan-to-implement`. Read [common.md](common.md) first.

One planner CLI turns the user's plan into a module ticket plan. The scheduling caller accepts that plan into a durable run, dispatches every dependency-satisfied module at once, and after the last module delivers, starts exactly one integration CLI that merges, fixes, verifies, and publishes one MR per repository. Keep the graph in the caller; a planner never dispatches a worker, and an integrator never becomes a second coordinator.

The durable state lives in the runtime, not in the conversation. `plan-*` commands hold the plan, the ready set, the barriers, the integrator's per-repository workspace claims, and the run journal, so a restarted caller resumes from `plan-status`.

Completion is judged by delivery facts, not by the final block of natural language. The runtime verifies endpoints, commits, integration history, and remote MR identity; test conclusions come from structured evidence submitted by the scheduling caller and must clearly separate passes from known failures the user has accepted.

## Roles and defaults

| Role             | Provider    | Model                                                                    | Effort                              | Workspace                                                                                              |
| ---------------- | ----------- | ------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Planner          | `mcode-cli` | resolved provider default (`custom_provider:mafia-claude/claude-opus-5`) | resolved provider default (`xhigh`) | `isolated`, declares the plan file with `--require-file`                                               |
| Module worker    | `mcode-cli` | same resolved default                                                    | same resolved default               | `isolated`, one worktree and `--workspace-branch` each, `--require-commit`                             |
| Final integrator | `mcode-cli` | same resolved default                                                    | same resolved default               | `isolated` on the primary repository, `--require-commit`; other repositories come from run-held claims |

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
  --task-id feature-x-auth-core --provider mcode-cli --model "$MODEL"
node core/dist/cli.js start --task-id feature-x-auth-core --provider mcode-cli \
  --model "$MODEL" --effort "$EFFORT" --workspace-branch feature-x/auth-core \
  --message-file /tmp/run/auth-core-prompt.md \
  --invocation-file /tmp/run/auth-core-invocation.json --include-response
```

Run `plan-dispatch` first, then `start`. `plan-dispatch` records only the provider and model against the barrier — it accepts no `--effort`; pass effort on `start`, which freezes it. The runtime fills in the repository, source, workspace policy, and commit requirement from the registered role; explicit arguments that conflict with the plan are rejected, and each worker must still supply its own `--workspace-branch`. Dependency barriers, task binding, and observer grouping stay within this run. Legacy records that ran `start` before registration remain readable, but completion equally requires a valid commit delivery.

CLI `start` / `turn` return a `RUNNING` dispatch receipt while a detached controller keeps holding the execution and write leases. Collect terminal state with `checkpoint --run-id ... --include-response`; a wait command ending or timing out does not mean execution failed and does not terminate the controller. When a controller is genuinely gone, follow checkpoint's recovery and process-identity verification.

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

`plan-integrate` prepares each declared repository's `delivery_branch` worktree at its frozen head and records a durable [workspace claim](../supervision.md#durable-workspace-claims) owned by that one integrator task. This is what makes a single multi-repository integrator safe: a task's own leases cover only the one repository it targets, so the run holds the others. While the claims exist, any other Agent Lord task that tries to write a claimed worktree or delivery branch fails with `WORKSPACE_CLAIM_CONFLICT`. Each claim is taken under the same `workspace-write` and `branch-write` locks an ordinary writer uses, so two runs competing for one repository cannot both pass the check — the loser gets `WORKSPACE_CLAIM_CONFLICT`, and a repository already being written returns a retryable `STATE_BUSY`. Replaying `plan-integrate` with the same task reuses the existing claims instead of re-preparing them.

After `plan-integrate`, call `start` with that `task_id`; the runtime automatically uses the plan's first repository and its claimed delivery worktree and freezes the role's delivery requirements. Pass the other repositories' paths into the prompt from `plan-status`, declaring them as the complete write boundary beyond the primary repository.

The integrator merges every module branch into each repository's `delivery_branch`, resolves conflicts, fixes the problems merging exposes, runs the whole-project verification, pushes, and opens or updates each repository's single MR. It never merges an MR. It also writes the process report. Because these commands verify the integrator's finished result, the scheduling caller runs them after the integrator returns — never the integrator itself mid-run.

```bash
node core/dist/cli.js plan-merge-request --run-id feature-x --repo /path/repo \
  --mr-url https://gitlab.example/group/repo/-/merge_requests/42 --head-sha "$HEAD" \
  --verification-file /tmp/run/repo-verification.json
node core/dist/cli.js plan-report --run-id feature-x --report-file /tmp/run/report.md
```

`plan-merge-request` requires the integrator's current operation to have succeeded with a verified commit delivery, the repository claim to be valid, and the SHA to match the local delivery branch. The primary repository must additionally match the endpoint-verified commit. The runtime reads the MR/PR back through the authenticated `gh api` / `glab api`, verifying the origin project, source branch, target branch (the plan's `source_branch`), SHA, and opened state; same-project GitHub / GitLab PRs/MRs are currently supported, while forks and other forges are explicitly rejected. One URL per repository; re-registering the same URL updates the SHA and evidence.

The verification file binds the final SHA; `checks` must cover every module's `verification` string for that repository, plus a check named `ci`:

```json
{
  "head_sha": "<40-hex final SHA>",
  "checks": [
    {
      "name": "pnpm test",
      "status": "passed",
      "evidence": "path or link to the test log"
    },
    {
      "name": "ci",
      "status": "accepted_failure",
      "evidence": "pipeline/job link",
      "reason": "known issue explicitly accepted by the user, with the authorizing basis"
    }
  ]
}
```

`passed` requires real evidence; `accepted_failure` is only for failures or skipped items the user has already authorized, and must preserve the reason and its basis. Keep waiting for unfinished tests/CI; keep fixing unaccepted failures or report the blocker. The runtime checks the evidence structure and SHA — it neither runs tests for the scheduling caller nor judges waiver authority, and it never treats a self-reported test conclusion as independent proof.

`plan-report` re-verifies every repository: a clean delivery branch, the final SHA, the delta against the original plan baseline, each module's merge or patch-equivalent cherry-pick, the complete verification record, and the remote MR identity. A squash or rewrite that makes a patch untraceable is rejected, preserving a traceable module integration history. On success the report is persisted before the claims are released; retrying with the identical report can clean up claims left by an interruption, while a different report returns `REPORT_CONFLICT`.

Integration recovery prefers `recover` / `turn` on the same task; when a session change is unavoidable:

```bash
node core/dist/cli.js plan-integration-resume --run-id feature-x \
  --task-id feature-x-integrator-2 --reason "original execution terminated; a new session must finish the remaining verification"
```

The command first verifies that the old operation has terminated, its processes have exited, every workspace is clean, and history has not moved backward; only then does it transfer the claims, preserving the workspaces, commits, MRs, verification records, and module state. Then call `start` on the new task to continue from the original delivery HEAD. The role's delivery baseline is always the original plan SHA, so a recovery that only completes tests or the report needs no new commit. If the handover is interrupted, repeat the same resume command; do not start either side's role before the handover completes. `plan-integration-reset` is only for explicitly abandoning this integration registration, never for ordinary recovery; it still clears the MR/workspace registrations and equally refuses to release claims held by an active execution.

Worker success is not run success. The final report separately lists the runtime-verified commit/MR facts, the actual test results, the user-accepted exceptions, and the platform boundaries still unverified. Roles of a closed run accept no new execution; later changes use a new task/run, preserving the boundary of the accepted delivery.

## Process record and report

The run journal is the process record. It holds the planner's identity and accepted plan digest, each module's dispatch with provider identity and the dependencies it waited on, each verified delivery commit or failure, resets, the integration dispatch with its claimed workspaces, recorded MRs with the branch heads they were checked against, and the closing report digest. Read it with `plan-status`. It carries shareable decisions, actions, and results only — never hidden reasoning or raw provider logs.

Write the final user report from that journal under the [explain-as-fool rules](../explain-as-fool.md): lead with the goal and what now exists, then the key decisions, the module split and who did what, what ran in parallel and what waited, the conflicts and how they were resolved, the verification evidence, each repository's MR, and the limits that remain. Write it for someone who has not seen this run, in plain language, without a turn-by-turn log.
