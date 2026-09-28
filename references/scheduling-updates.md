# Node provenance and meaningful updates

Use this contract for ordinary multi-endpoint runs. A named pipeline authorizes only its documented roles. Implementation-local tests remain inside the assigned endpoint; presenting results does not by itself select an independent tester or judge.

## Freeze role sources before dispatch

The nodes file maps every registered task ID to a role and a source:

```json
{
  "replica-a": {
    "role": "implementation",
    "source": {
      "kind": "user_request",
      "reference": "Try different implementations in parallel and show the results."
    }
  },
  "replica-b": {
    "role": "implementation",
    "source": {
      "kind": "user_request",
      "reference": "Try different implementations in parallel and show the results."
    }
  }
}
```

Register with `run-create --run-id replicas --task-id replica-a --task-id replica-b --nodes-file /tmp/nodes.json`. Start each endpoint with the same `--run-id replicas` plus its normal start arguments. This preflight requires membership and provenance before provider execution and copies them into the operation. Later turns and recovery preserve that operation's workflow record.

For `source.kind: pipeline`, `reference` is exactly `cross-review`, `plan-cross-review`, or `plan-to-implement`; preserve the user's invocation of that pipeline separately in invocation metadata. Stored `handoff` provenance remains readable for existing runs, but new registrations are rejected. For `source.kind: replacement`, include the old `task_id`, retain the same role, and give the recovery reason in `reference`. Register replacements with `run-add --nodes-file` before dispatch; the old operation must be terminal. Keep workspace fencing and the normal recovery contract.

Once a run has provenance, additions require it too and existing role/source entries are immutable. Register all authorized pending roles upfront so Observer can show them before execution. Sources are **caller-declared**, not a runtime interpretation of user intent: the runtime cannot prove that a quoted sentence authorizes a role. The caller must map each role to actual authorization; writing a manifest or choosing a role label does not supply it. Legacy task sets and starts without `--run-id` remain supported and have no implied provenance.

## Bind the run once

After registration, use `pnpm preview:attach --run-id replicas --port 8791` from `observer/`. Inspect `binding_verified` and `page_http_verified`, then open the returned URL once. The observer follows only the explicitly subscribed run's membership, including later additions. `run-add` verifies subscribed instances by authenticated HTTP and returns its binding outcome independently of registration. A broken observer never rolls back membership or authorizes another dispatch. `run-status` retries the verification without changing the task set.

The `task=` URL parameter selects focus; it does not authorize visibility. `queued` from a host link-opening tool is only a display request.

## Report transitions, retain recovery

Task-set checkpoints return `reporting.should_notify` and `reporting.events`. Checkpoint output compacts each task's `node` to `{ role, source: { kind, reference?, task_id? } }`: `reference` survives only for `source.kind: "pipeline"`, so long `user_request` and `replacement` reference text never rides in checkpoint output. Full provenance stays queryable through `run-status` and the persisted records. A persistent per-task fingerprint suppresses repeated operation states, including across caller restarts. New operations, terminal outcomes, pending host actions, and changed terminal delivery produce update candidates. Tool names, event counts, liveness age, and result acknowledgement do not. Pending registration alone is not evidence that execution started.

This reporting ledger records emitted update candidates, **not human receipt**. If a tool response is lost, reconcile with `run-status` and the terminal result. Always process `actionable`, even when `should_notify` is false; terminal receipts remain at-least-once until `run-ack`. Reporting never triggers dispatch or recovery and never consumes an actionable result.

Report a milestone such as a successful build only when concrete artifacts or an attributed endpoint report establish it. The runtime does not infer milestones from `bash`, `read`, or `write`. A verified declared-file/commit check is structural evidence; report endpoint test claims and any actual independent verification separately.

## Wait without inventing progress

Keep one outstanding checkpoint and resume its host handle. A longer bounded `--seconds` window (for example 600 for an observer-backed run) reduces quiet tool returns; the existing supervision loop continues checking failures and wakes early for actionable state. Match host yield/resume limits and explicit user intervals. Stop empty or fully acknowledged terminal loops.

Keep routine waiting in Observer and follow the [waiting and reporting rules](../SKILL.md#waiting-and-reporting) for status interpretation, internal window boundaries, and any host-required heartbeat. This Skill cannot change the host's cadence; it can prevent fabricated stages and repeated substantive claims.
