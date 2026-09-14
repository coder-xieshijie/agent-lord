# Plan-to-Implement Pipeline

Load this policy when the user asks Agent Lord to turn an existing implementation plan into merged code, or says `plan-to-implement`. Read [common.md](common.md) first.

One planner CLI turns the user's plan into a module ticket plan. The scheduling caller accepts that plan into a durable run, dispatches every dependency-satisfied module at once, and after the last module delivers, starts exactly one integration CLI that merges, fixes, verifies, and publishes one MR per repository. Keep the graph in the caller; a planner never dispatches a worker, and an integrator never becomes a second coordinator.

The durable state lives in the runtime, not in the conversation. `plan-*` commands hold the plan, the ready set, the barriers, the integrator's per-repository workspace claims, and the run journal, so a restarted caller resumes from `plan-status`.

Completion is verified, never asserted. Every barrier checks the bound endpoint's real task, current operation, and runtime-verified delivery, so a caller cannot close a run by reporting success for work that did not happen.

## Roles and defaults

| Role | Provider | Model | Effort | Workspace |
| --- | --- | --- | --- | --- |
| Planner | `mcode-cli` | resolved provider default (`custom_provider:mafia-claude/claude-opus-5#xhigh`) | Omit `--effort` | `isolated`, declares the plan file with `--require-file` |
| Module worker | `mcode-cli` | same resolved default | Omit `--effort` | `isolated`, one worktree and `--workspace-branch` each, `--require-commit` |
| Final integrator | `mcode-cli` | same resolved default | Omit `--effort` | `isolated` on the primary repository, `--require-commit`; other repositories come from run-held claims |

Resolve and freeze the model from provider configuration at dispatch, then pass it explicitly so the whole run shares one verified literal. MCode carries `xhigh` inside the model literal and takes no separate effort argument. `codex-cli` and `claude-cli` are supported for any role through a global or per-role override; a Codex role needs its own explicit `--effort`. These pipeline choices change no ordinary provider default.

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
```

Record each module with `plan-dispatch` before or immediately after its `start`; the command refuses a module whose dependencies are unmet, a module already dispatched, and a `task_id` bound to another module. Binding a `task_id` this early is deliberate — the endpoint may still be starting — so the endpoint itself is verified at delivery, not here. Dispatch also binds the endpoint to the run's task set, so `checkpoint --run-id` and the observer supervise the whole pipeline through the existing run.

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

`plan-integrate` prepares each declared repository's `delivery_branch` worktree at its frozen head and records a durable [workspace claim](../protocol.md#durable-workspace-claims) owned by that one integrator task. This is what makes a single multi-repository integrator safe: a task's own leases cover only the one repository it targets, so the run holds the others. While the claims exist, any other Agent Lord task that tries to write a claimed worktree or delivery branch fails with `WORKSPACE_CLAIM_CONFLICT`. Replaying `plan-integrate` with the same task reuses the existing claims instead of re-preparing them.

Start the integrator on the primary repository with the normal `start --repo … --workspace-branch <delivery_branch> --head-sha … --require-commit`; the runtime reuses the already-claimed worktree, and the integrator's own claim never blocks itself. Pass the other repositories' claimed worktree paths from `plan-status` in its prompt, and state that those paths are its entire write boundary outside the primary repository.

The integrator merges every module branch into each repository's `delivery_branch`, resolves conflicts, fixes the problems merging exposes, runs the whole-project verification, pushes, and opens or updates each repository's single MR. It never merges an MR. It also writes the process report. Because these commands verify the integrator's finished result, the scheduling caller runs them after the integrator returns — never the integrator itself mid-run.

```bash
node core/dist/cli.js plan-merge-request --run-id feature-x --repo /path/repo \
  --mr-url https://example/mr/42 --head-sha "$HEAD"
node core/dist/cli.js plan-report --run-id feature-x --report-file /tmp/run/report.md
```

`plan-merge-request` requires the integrator's current operation to have succeeded, a live claim for that repository, and a `--head-sha` that equals the repository's real local `delivery_branch` head; for the integrator's own repository it must also equal its verified delivery commit. A repository accepts exactly one MR URL; a second distinct URL returns `MR_CONFLICT`.

`plan-report` closes the run only with a non-empty report and an MR recorded for every declared repository. It copies the report into Agent Lord state, so the run keeps a readable canonical copy after the caller's temporary file is gone, and releases the workspace claims. Re-submitting the identical report is idempotent; a different report for a closed run returns `REPORT_CONFLICT`.

When an integrator must be replaced, `plan-integration-reset` releases the claims and returns integration to pending for a new integrator task.

Worker success is not run success. Complete the run only on the integrator's verified result: the merge happened, the verification ran, and the MR head was read back. Report an unverified environment, an external blocker, or an incomplete delivery as exactly that. The runtime verifies local evidence — endpoint success, delivery commits, delivery-branch heads — not the remote MR itself, so state the remote publication as the integrator's reported outcome.

## Process record and report

The run journal is the process record. It holds the planner's identity and accepted plan digest, each module's dispatch with provider identity and the dependencies it waited on, each verified delivery commit or failure, resets, the integration dispatch with its claimed workspaces, recorded MRs with the branch heads they were checked against, and the closing report digest. Read it with `plan-status`. It carries shareable decisions, actions, and results only — never hidden reasoning or raw provider logs.

Write the final user report from that journal under the [explain-as-fool rules](../explain-as-fool.md): lead with the goal and what now exists, then the key decisions, the module split and who did what, what ran in parallel and what waited, the conflicts and how they were resolved, the verification evidence, each repository's MR, and the limits that remain. Write it for someone who has not seen this run, in plain language, without a turn-by-turn log.
