# Common Pipeline Contract

Load this reference when one request selects multiple Agent Lord endpoints or names a documented pipeline. It defines orchestration policy only; `node core/dist/cli.js` remains the durable endpoint runtime.

Every step below belongs to the originating [scheduling caller](../../SKILL.md#scheduling-ownership). Assign concrete execution roles to CLI endpoints, and include the executor constraint in each assignment. Keep the manifest, dispatch, barriers, artifact exchange, supervision, recovery, and convergence in this caller; a pipeline is not a task to hand to another coordinator CLI.

User-facing explanations and reports follow the shared [explain-as-fool rules](../explain-as-fool.md). Pass this bundled reference or its wording to the authoring endpoint; each named pipeline defines its report content and delivery requirements.

## Resolve the contract before dispatch

Write one compact run manifest per user-defined workflow outside the target repository. One scheduling session can manage multiple independent runs; apply [tasks added during execution](../../SKILL.md#tasks-added-during-execution) when the user adds work later, and register an addition you cannot dispatch yet in the [request inbox](../../SKILL.md#deferred-instruction-inbox) so it is not lost with the conversation context.

Each manifest contains:

- `run_id`, goal, final deliverable, repository, source branch, fixed head/base, process permission mode, and task-level write boundaries;
- every authorized node with stable `task_id`, role, provider, model, effort, inputs, outputs, and workspace policy;
- dependency edges, ready-set concurrency, barriers, retry/stop bounds, and the authority required for any expansion;
- role-independence requirements, including whether provider or model fallback invalidates a result.

A named pipeline expands only the nodes documented by that policy. User-specified endpoints, models, efforts, nodes, and order override defaults. Do not silently add a planner, arbiter, integrator, or checker. A necessary replacement of an existing role follows [endpoint replacement](../../SKILL.md#endpoint-replacement) without additional user confirmation. Follow [the Skill workspace policy](../../SKILL.md#workspace-and-parallel-write-policy) to create task-required worktrees and isolated local branches without confirmation. Return a decision only for an unauthorized workflow expansion, such as a merge order or integrator, or other missing authority.

New CLI nodes use `dangerously_bypass` without `--read-only`; put task-level write limits in each prompt. Allocate a distinct `isolated` worktree and `--workspace-branch` to each concurrent repo-managed CLI node, including reviews. Review-only concurrency needs no integration metadata or integrator. The runtime treats these processes as writable and enforces exclusive workspace/branch leases regardless of prompt restrictions.

## Execute the graph

1. Dispatch every node in the current ready set concurrently when its workspace contract permits it.
2. Hold each downstream barrier until all required upstream artifacts are terminal and validated.
3. Exchange sanitized final artifacts. Never pass raw logs, hidden reasoning, or an unverified summary of another endpoint's result.
4. Prefer `turn` on the saved task for later rounds. When replacement is necessary, transfer the current round and progress under the replacement policy; a fresh session does not restart the graph or its bounds.
5. Never bypass repository/source validation with a manually prepared worktree plus `--target`. Let the runtime create or reuse the contract workspace. The single documented exception is the exact-target dirty continuation in [handoff.md](handoff.md), where the runtime itself fingerprints the workspace under its write lease.

## Supervise and recover

- For a pipeline, `checkpoint` is the liveness and recovery loop. Immediately after dispatch, select every active `task_id` with `--task-id` and every just-dispatched one with `--starting-task-id`, which tolerates a start that has not journaled its operation or task record yet and reports each such id in `starting[]`.
- `check` is a full-detail inspection for one established task; it is not the pipeline liveness primitive and can correctly return `TASK_UNKNOWN` during the pre-task start window.
- A brief `workspace-prepare` or parallel-group `STATE_BUSY` is retried inside the runtime. After the bounded budget is exhausted, evaluate the returned `safe_recovery` or the replacement policy; a lease conflict still requires resolving the existing writer before dispatch.
- Treat `CHECKPOINT_QUIET` as healthy. Notify the user on meaningful transitions: dispatch, barrier completion, recovery, decision, terminal failure, or final convergence—not on every quiet poll.

## Validate artifacts and roles

Before a node can satisfy a barrier, validate its terminal envelope against the manifest:

- source head/base (unchanged for reviews), target, process permission mode, task-level write boundaries, expected model and effort;
- endpoint identity continuity across turns;
- artifact presence and operation identity;
- role-specific independence.

For a role that must be independent, inspect the observed execution rather than the requested label. In particular, a Fable-family task with `observed.fallback_used=true` ran on the configured fallback model and cannot satisfy an independent-Fable barrier. Mark that check `UNVERIFIED` and return the required decision, unless the named pipeline documents another disposition for its own frozen fallback stage; never label it `PASS`.

Every replacement is a new `task_id` and endpoint under [the Skill replacement policy](../../SKILL.md#endpoint-replacement). Carry its `replacement_for` lineage and context artifact in the manifest, and re-run identity and independence checks against the replacement. Preserve completed artifacts as attributed evidence; require the new endpoint to verify any conclusions it adopts. Session continuity becomes recorded replacement lineage, while explicit same-session requirements still need a separate decision.

## Converge and stop

Every iterative pipeline must define its convergence predicate, maximum rounds or operations, and unresolved output before it starts. Stop when the predicate is met, the bound is exhausted, or new authority is required. Do not keep polling terminal tasks, repeat unchanged full reviews, or invent a third-party tie-breaker. Preserve rejected and unresolved items with their evidence so the final result is auditable. The Claude `RESULT_INVALID` retry budget (`SKILL.md`) is separate and never counts against this bound.
