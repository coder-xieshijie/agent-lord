# Handoff Pipeline

Load this reference when the user asks to hand the current session's work off to a new local CLI endpoint. Handoff is one Agent Lord pipeline branch, and this file is its complete authoring and execution contract. `node core/dist/cli.js handoff` remains the durable runtime, while [common.md](common.md) and [../protocol.md](../protocol.md) keep owning supervision, envelope, and recovery semantics.

## Selection and authorization

The handoff shorthand authorizes exactly one node: one new local CLI continuation endpoint (`claude-cli`, `codex-cli`, or `mcode-cli`) that continues the user-specified task. It never authorizes a planner, reviewer, tester, integrator, or any other additional user-visible node, and never selects `codex-app`. A necessary replacement of this continuation role follows [endpoint replacement](../../SKILL.md#endpoint-replacement) without additional user confirmation. The user decides the provider, model, applicable effort, and task-level write boundaries; the packet's `contract_request` carries provider/model/effort choices when the command line omits them, and an explicit argument that contradicts the packet fails closed. Every new handoff uses `dangerously_bypass` without `--read-only` under [the Skill invariants](../../SKILL.md#invariants). MCode handoffs resolve the qualified model from explicit input or provider defaults and omit effort.

The originating [scheduling caller](../../SKILL.md#scheduling-ownership) retains orchestration and performs the deterministic loop below. The continuation CLI executes the named task and returns its result; handoff does not transfer scheduling authority.

## Identity and lineage

A handoff is a sanitized context transfer plus new-endpoint lineage — never a native session migration:

- The source session authors the packet from its own visible context only. Nothing in this pipeline reads, or claims to read, the source session's native transcript or hidden reasoning.
- The continuation is a new `task_id` bound to a new provider endpoint. Source-endpoint identity is never reused or rebound.
- Source-session identity can only be caller-declared. The control plane records `identity_assurance` as `caller-declared` (an `opaque_id` was supplied) or `unavailable`; it never records `verified`, and a missing ID does not block the handoff.
- Lineage lives in three places written by the runtime: the operation's `handoff` manifest, the immutable task `lineage` record, and the `handoff` summary in every envelope. It means `continues_user_task`, nothing more.

## Packet authoring contract

Treat the `handoff-v1` packet as a compact handoff document for a fresh agent. Author it from the current session's visible context and tailor `objective`, `remaining_work`, and `acceptance_criteria` to the user's named continuation task. Include `suggested_skills` that materially help the continuation. Reference existing work through `evidence` instead of duplicating specs, plans, decisions, diffs, or other durable artifacts. Redact secrets and personally identifiable information; raw provider logs, transcripts, and hidden reasoning never belong in the packet.

Include the [executor constraint](../../SKILL.md#scheduling-ownership) in the packet's `constraints` array so the fresh endpoint receives its role boundary in the rendered prompt.

The existing schema couples `authorization.workspace_writes` to the process mode: bypass requires `true`, including for review continuations. Record narrower task limits in `constraints` explicitly (for example, keep the checkout and HEAD unchanged; no code edits or commits). Set `authorization.external_writes` only from the user's actual authorization. The process field does not override these constraints or grant broader task or external-write authority; a strict review prompt is not a read-only process.

Write the caller-owned JSON file to a private path in the operating system's temporary directory, never into the target repository. `schemas/handoff-v1.schema.json` is the authoritative shape; the control plane enforces it with closed objects, 64 KiB canonical bytes, 8 KiB strings, 64-item lists, workspace-relative evidence paths, an all-false sanitization attestation, an `integrity.sha256` self-digest, and a high-confidence secret-pattern scan. The scan cannot prove secrets are absent, so sanitizing the content remains the source session's obligation.

## Deterministic loop

1. Author the packet and optionally pre-check it: `handoff --validate-only` validates schema, integrity, task binding, contract request, and write-posture consistency without touching durable state (its envelope carries `handoff.validated_only`).
2. Consume it: `node core/dist/cli.js handoff --task-id <new-task> --packet-file <file> --provider <cli> --target <workspace> [--model … --effort … --head-sha … --retry-attempts …]`. The command validates, freezes the contract, snapshots the workspace, journals a `handoff` operation, stores the canonical packet as an input artifact, renders the deterministic continuation prompt (packet content plus digest and contract), and starts the provider.
3. Process the returned envelope and every later round exactly as the standard loop in `SKILL.md`: `turn` continues the same saved endpoint, `checkpoint` supervises and recovers it. Handoff adds no second runtime.
4. Remove the caller-owned packet file after the command has consumed it; the canonical copy persists as `artifacts/<task-id>/<operation-id>.handoff-v1.json` under the state directory.

## Exact-target dirty-workspace exception

Handoff is the one documented exception to the common-pipeline ban on `--target`: the continuation runs in the exact existing workspace — typically dirty with the source session's uncommitted work — so repo-managed preparation (which requires a clean worktree) does not apply and `--repo` is rejected. In exchange, the control plane fingerprints the workspace itself while holding the write lease: HEAD, every changed path, and each changed file's content digest are frozen into the operation's `workspace_snapshot`. The caller cannot substitute its own claim, and a workspace that changes between snapshot and dispatch fails closed with `SOURCE_MISMATCH` before the provider launches. `--head-sha`, when given, is verified exactly as in `start`; note an exact-target contract stays strict on later turns, so pin the head only for continuations that will not commit.

## Pre-dispatch barrier

Everything below must pass before an endpoint may launch; any failure leaves no endpoint behind:

- packet schema, bounds, sanitization attestation, integrity digest, secret scan (`HANDOFF_PACKET_INVALID`);
- `continuation.task_id` equals `--task-id`, contract request and write posture are consistent (`HANDOFF_CONFLICT`);
- provider is a local CLI, source SHAs verify, workspace snapshot is stable (`CONFIG_INVALID` / `SOURCE_MISMATCH`);
- standard dispatch lock, workspace and branch write leases from the common runtime.

## Idempotency and conflicts

- Replaying the identical handoff (same packet digest, task, target, and frozen contract) returns the existing operation's envelope — in flight or succeeded — and never starts a second endpoint or process.
- The same `task_id` with a different packet or contract fails closed with `HANDOFF_CONFLICT`; nothing is overwritten.
- A handoff that failed before its provider launched may be retried with the same command; the retry is a new initial operation for the same continuation task, and no endpoint existed to duplicate. Once an endpoint exists, the same task continues or recovers that endpoint; a necessary replacement uses a fresh task and context packet under the replacement policy.

## Completion

`SUCCEEDED` carries the new `task_id`, the new CLI `endpoint_id`, the `handoff` lineage summary (packet digest and bytes, source-session assurance, workspace snapshot), and the sanitized final artifact. Report the continuation as a new endpoint with handoff lineage — never as the source session moved or resumed.

## Non-goals

- No migration of a Desktop/App session and no reuse of its endpoint identity.
- No reading or exporting of the source session's native transcript or hidden reasoning.
- No inferred extra workflow nodes, no workspace copy, and no commit, stash, branch, or push by the control plane.
- No second endpoint runtime: state, supervision, recovery, and artifacts are the ones `SKILL.md` and `protocol.md` already define.
- No third permission posture: `external_writes: false` is recorded and prompt-enforced, not sandbox-enforced, until providers expose one.
