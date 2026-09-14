# Plan-to-Implement Pipeline

Load this policy when the user asks Agent Lord to turn an existing implementation plan into merged code, or says `plan-to-implement`. Read [common.md](common.md) first.

One planner CLI turns the user's plan into a module ticket plan. The scheduling caller validates that plan, dispatches every dependency-satisfied module at once, and after the last module delivers, starts exactly one integration CLI that merges, fixes, verifies, and publishes one MR per repository. Keep the graph in the caller; a planner never dispatches a worker, and an integrator never becomes a second coordinator.

The durable state lives in the runtime, not in the conversation. `plan-*` commands freeze the plan, compute the ready set, hold the barriers, and journal the run, so a restarted caller resumes from `plan-status` instead of rebuilding the graph from memory.

## Roles and defaults

| Role | Provider | Model | Effort | Workspace |
| --- | --- | --- | --- | --- |
| Planner | `mcode-cli` | resolved provider default (`custom_provider:mafia-claude/claude-opus-5#xhigh`) | Omit `--effort` | `isolated`, read-only prompt |
| Module worker | `mcode-cli` | same resolved default | Omit `--effort` | `isolated`, one worktree and `--workspace-branch` each |
| Final integrator | `mcode-cli` | same resolved default | Omit `--effort` | `isolated`, one per repository it touches |

Resolve and freeze the model from provider configuration at dispatch, then pass it explicitly so the whole run shares one verified literal. MCode carries `xhigh` inside the model literal and takes no separate effort argument. `codex-cli` and `claude-cli` are supported for any role through a global or per-role override; a Codex role needs its own explicit `--effort`. These pipeline choices change no ordinary provider default.

Start every role in `dangerously_bypass` without `--read-only`, and put the task-level write boundary in the prompt. The planner writes only its plan file outside the repository.

## Module granularity

Split by whole module or subsystem — a coherent unit one endpoint can own end to end. A file, a single function, an interface, or one test case is too small; a ticket per module keeps ownership, review, and rollback aligned with the code.

The planner returns an `implementation-plan-v1` document ([schema](../../schemas/implementation-plan-v1.schema.json)):

```bash
node core/dist/cli.js plan-validate --plan-file /tmp/run/plan.json
node core/dist/cli.js plan-create --run-id feature-x --plan-file /tmp/run/plan.json
```

`plan-validate` enforces the contract the barriers depend on: every module carries a responsibility, acceptance criteria, and `owned_paths`; dependencies reference declared modules and stay acyclic; two modules in one repository never own overlapping paths; each repository declares one fixed 40-hex `head_sha` and one `delivery_branch`; and no module declares its own MR. Send a rejected plan back to the planner with the returned `PLAN_INVALID` details. A plan that validates proceeds under the authority already granted — ordinary granularity and dispatch choices need no further user approval.

`plan-create` freezes the validated plan under `run_id`. Replaying the identical plan is idempotent and preserves recorded progress; a changed plan under the same `run_id` returns `RUN_EXISTS`, so recovery never silently rewrites the graph.

## Dispatch the ready set

`plan-status` returns `ready` — every pending module whose dependencies are all delivered. There is no worker cap: dispatch the entire ready set concurrently, bounded only by workspace leases.

```bash
node core/dist/cli.js plan-status --run-id feature-x
node core/dist/cli.js plan-dispatch --run-id feature-x --module-id auth-core \
  --task-id feature-x-auth-core --provider mcode-cli --model "$MODEL"
```

Record each module with `plan-dispatch` before or immediately after its `start`; the command refuses a module whose dependencies are unmet, a module already dispatched, and a `task_id` bound to another module. Dispatch also binds the endpoint to the run's task set, so `checkpoint --run-id` and the observer supervise the whole pipeline through the existing run.

Give each worker its module responsibility, acceptance criteria, `owned_paths` as its write boundary, the sanitized interface contracts of the modules it depends on, and its repository's fixed head. A worker commits locally on its own branch and never pushes, opens an MR, or edits another module's paths.

When a worker returns, verify its delivery envelope, then record the outcome:

```bash
node core/dist/cli.js plan-deliver --run-id feature-x --module-id auth-core \
  --state delivered --commit-sha "$SHA"
```

`delivered` requires the local commit SHA, which is what unlocks downstream modules. Record a genuine failure as `--state failed`; `plan-reset` returns that module to pending for a replacement endpoint under [endpoint replacement](../../SKILL.md#endpoint-replacement), and the journal keeps both attempts.

## Final integration

The last barrier opens only when every module is `delivered`. One integration CLI runs even when a single module produced all the work — the integrator is a distinct role, never a delivery turn reused from a worker.

```bash
node core/dist/cli.js plan-integrate --run-id feature-x --task-id feature-x-integrator
```

The integrator merges every module branch into the repository's one `delivery_branch`, resolves conflicts, fixes the problems merging exposes, runs the whole-project verification, pushes, and opens or updates that repository's single MR. Across multiple repositories it remains one execution owner with one MR per repository, holding a real workspace lease for each repository it touches. It never merges the MR.

```bash
node core/dist/cli.js plan-merge-request --run-id feature-x --repo /path/repo \
  --mr-url https://example/mr/42 --head-sha "$HEAD"
node core/dist/cli.js plan-report --run-id feature-x --report-file /tmp/run/report.md
```

A repository accepts exactly one MR URL; a second distinct URL returns `MR_CONFLICT`. `plan-report` closes the run only with a non-empty report and an MR recorded for every declared repository.

Worker success is not run success. Complete the run only on the integrator's verified result: the merge happened, the verification ran, and the MR head was read back. Report an unverified environment, an external blocker, or an incomplete delivery as exactly that.

## Process record and report

The run journal is the process record. It holds the frozen plan and its digest, each module's dispatch with provider identity and the dependencies it waited on, each delivery commit or failure, the integration dispatch, recorded MRs, and the closing report digest. Read it with `plan-status`. It carries shareable decisions, actions, and results only — never hidden reasoning or raw provider logs.

Write the final user report from that journal under the [explain-as-fool rules](../explain-as-fool.md): lead with the goal and what now exists, then the key decisions, the module split and who did what, what ran in parallel and what waited, the conflicts and how they were resolved, the verification evidence, each repository's MR, and the limits that remain. Write it for someone who has not seen this run, in plain language, without a turn-by-turn log.
