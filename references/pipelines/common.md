# Common Pipeline Contract

Load this reference when one request selects multiple Agent Lord endpoints or names a documented pipeline. It defines orchestration policy only; `node core/dist/cli.js` remains the durable endpoint runtime.

## Resolve the contract before dispatch

Write one compact run manifest outside the target repository:

- `run_id`, goal, final deliverable, repository, source branch, fixed head/base, and read/write posture;
- every authorized node with stable `task_id`, role, provider, model, effort, inputs, outputs, and workspace policy;
- dependency edges, ready-set concurrency, barriers, retry/stop bounds, and the authority required for any expansion;
- role-independence requirements, including whether provider or model fallback invalidates a result.

A named pipeline expands only the nodes documented by that policy. User-specified endpoints, models, efforts, nodes, and order override defaults. Do not silently add a planner, arbiter, integrator, checker, or replacement endpoint. If required isolation would add user-visible branches, worktrees, merge order, or an integrator, return the decision before dispatch.

## Execute the graph

1. Dispatch every node in the current ready set concurrently when its workspace contract permits it.
2. Hold each downstream barrier until all required upstream artifacts are terminal and validated.
3. Exchange sanitized final artifacts. Never pass raw logs, hidden reasoning, or an unverified summary of another endpoint's result.
4. Continue the same `task_id` with `turn`; do not create a replacement endpoint to simulate a later round.
5. Never bypass repository/source validation with a manually prepared worktree plus `--target`. Let the runtime create or reuse the contract workspace. The single documented exception is the exact-target dirty continuation in [handoff.md](handoff.md), where the runtime itself fingerprints the workspace under its write lease.

## Supervise and recover

- For a pipeline, `checkpoint` is the liveness and recovery loop. Select all active and newly starting `task_id` values in one call immediately after dispatch, including starts that may have journaled an operation before their task record exists.
- `check` is a full-detail inspection for one established task; it is not the pipeline liveness primitive and can correctly return `TASK_UNKNOWN` during the pre-task start window.
- A brief `workspace-prepare` or parallel-group `STATE_BUSY` is retried inside the runtime. After the bounded budget is exhausted, follow only the returned `safe_recovery`.
- Treat `CHECKPOINT_QUIET` as healthy. Notify the user on meaningful transitions: dispatch, barrier completion, recovery, decision, terminal failure, or final convergence—not on every quiet poll.

## Validate artifacts and roles

Before a node can satisfy a barrier, validate its terminal envelope against the manifest:

- source head/base, target, read/write posture, expected model and effort;
- endpoint identity continuity across turns;
- artifact presence and operation identity;
- role-specific independence.

For a role that must be independent, inspect the observed execution rather than the requested label. In particular, a Fable-family task with `observed.fallback_used=true` ran on the configured fallback model and cannot satisfy an independent-Fable barrier. Mark that check `UNVERIFIED` and return the required decision, unless the named pipeline documents another disposition for its own frozen fallback stage; never label it `PASS`.

A `SKILL.md` `RESULT_INVALID` replacement session is a new `task_id` and a new endpoint. Carry its `replacement_for` lineage in the manifest, and re-run these identity and independence checks against the replacement instead of inheriting the original node's result.

## Converge and stop

Every iterative pipeline must define its convergence predicate, maximum rounds or operations, and unresolved output before it starts. Stop when the predicate is met, the bound is exhausted, or new authority is required. Do not keep polling terminal tasks, repeat unchanged full reviews, or invent a third-party tie-breaker. Preserve rejected and unresolved items with their evidence so the final result is auditable. The Claude `RESULT_INVALID` retry budget (`SKILL.md`) is separate and never counts against this bound.
