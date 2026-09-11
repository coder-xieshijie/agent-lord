# Cross-Review Pipeline

Load this policy whenever the user asks Agent Lord for “交叉 Review”, “交叉审查”, or `cross-review`. It is the documented expansion of that shorthand. Read [common.md](common.md) first.

The scheduling caller directly starts the reviewers, exchanges their final artifacts through `turn`, maintains the verdict ledger, and starts the independent checker after the barrier. Each reviewer or checker receives its current review assignment and the [executor constraint](../../SKILL.md#scheduling-ownership). Keep this orchestration in the caller instead of creating a cross-review coordinator CLI.

## Authorized graph and defaults

Unless the user overrides them, freeze these three roles at one repository and fixed review head/base:

| Role | Provider | Model | Effort | Workspace |
| --- | --- | --- | --- | --- |
| MCode reviewer | `mcode-cli` | `custom_provider:mafia-claude/claude-opus-5#xhigh` | Omit `--effort` | `isolated` |
| Codex reviewer | `codex-cli` | `gpt-6-astra` | `max` | `isolated` |
| Independent MCode checker | `mcode-cli` | `custom_provider:mafia-claude/claude-opus-5#xhigh` | Omit `--effort` | `isolated` |

Pass these pipeline-specific model choices explicitly, including `--effort max` for Codex. MCode's `xhigh` is the variant in its full model literal, not an independent effort argument. These choices do not change ordinary provider defaults.

Start all three CLI roles in `dangerously_bypass` without `--read-only`. Give each role its own worktree and distinct `--workspace-branch` from the same fixed review head; create them without confirmation under [common.md](common.md). Continue each role's later turns in its saved workspace. These review roles hold exclusive runtime leases and need no integration metadata or integrator.

Every initial, cross-exam, convergence, and checker prompt must require review only: keep the checkout and HEAD unchanged, make no code edits or commits, perform no push, publish, message, or write API call, and return findings for the runtime to store outside the repository. These are task constraints on a bypass process, not process-enforced read-only protection. Verify the pinned source before accepting each artifact.

```text
MCode initial ─┐      ┌─ MCode cross-exam ─┐      ┌─ optional MCode convergence ─┐
               ├──────┤                    ├──────┤                              ├─ consensus ─ new-session MCode check ─ table
Codex initial ─┘      └─ Codex cross-exam ─┘      └─ optional Codex convergence ─┘
```

The two initial reviews are one concurrent ready set. The two cross-exams are a second concurrent ready set. Run at most one optional convergence pair, only for unresolved findings. Normal convergence costs five planned provider operations including the checker; the optional convergence round costs seven in total. Runtime recovery uses its frozen budget and adds no semantic convergence rounds or workflow nodes. Do not add an arbiter or repeat full reviews. If unresolved findings remain after that round, stop before the checker and report them as `UNRESOLVED` unless the user authorizes expansion.

## Shared review lens

Give both initial reviewers the same pinned source scope and acceptance lens, but neither receives the other's output:

- prefer the smallest change and reuse existing capability;
- keep core implementation in V2 and minimize V1 changes;
- reject complexity introduced only for a narrow local case when its cost exceeds the risk;
- retain sufficient extension seams without speculative abstractions;
- minimize context required by the next change;
- make production ownership, rollback units, boundaries, and coupling obvious;
- find real bugs, incomplete behavior, unnecessary code, smaller alternatives, and duplication with existing implementation.

Require source-pinned findings only. Each initial finding needs a stable reviewer-prefixed ID, severity proposal, exact location, evidence, concrete failure scenario, and the smallest credible fix. “Could be cleaner” or unsupported architectural preference is not a finding.

## Mutual cross-exam and ledger

After both initial artifacts pass the barrier, send the MCode reviewer the sanitized Codex artifact and Codex the sanitized MCode artifact in parallel. Each reviewer must challenge every candidate and may merge duplicates, but must preserve the original IDs.

Maintain one finding ledger outside the repository. Adjudicate these dimensions separately for each reviewer:

| Dimension | Question |
| --- | --- |
| `fact_evidence` | Does the cited code and failure scenario prove a real issue at the pinned source? |
| `severity` | Is the proposed impact and priority proportionate? |
| `minimal_fix_dependencies` | Is the smallest fix correct, and are all affected symbols/callers/contracts identified? |

Each reviewer returns `ACCEPT`, `REJECT`, or `NEEDS_EVIDENCE` plus a source-grounded reason for every dimension. Classify a candidate as:

- `CONFIRMED` only when both reviewers return `ACCEPT` on all three dimensions;
- `DROPPED` only when both explicitly agree it is not a real/actionable issue and record why;
- `UNRESOLVED` in every other combination.

The optional convergence turn receives only the unresolved ledger rows and the missing evidence requests. It must not restart a full review or introduce unrelated findings. Preserve the dropped ledger for the checker and final audit.

## Independent MCode check

Start the MCode checker only after the ledger contains no unresolved rows. Use a new `task_id` and provider Session that participated in neither initial review nor mutual cross-exam/convergence; never continue a reviewer session as the checker. Independence comes from that fresh session and the de-anchored input below, not from a different model family. The checker deliberately uses the same Opus model/variant as the MCode reviewer.

Build a de-anchored checker packet containing:

- pinned source scope and the shared review lens;
- both unedited sanitized initial artifacts;
- candidate IDs, locations, evidence, failure scenarios, minimal-fix dependency sets, and the dropped-candidate list;
- no participant consensus label, final severity, or instruction to ratify the reviewers.

Ask the MCode checker to independently reclassify every candidate, verify source evidence and severity, inspect dropped candidates for false negatives, and verify that the proposed fix is minimal and complete. It may report newly discovered items only in an `OUT_OF_SCOPE` appendix; those items are not silently promoted into consensus findings.

Complete this step only with a verified successful MCode result: the observed model and `xhigh` variant match the frozen contract, Session/Turn/Run and artifact identity verify, and the checker session is distinct from the reviewers. All source and barrier checks still apply.

For either MCode role, consume an applicable `safe_recovery=CONTINUE_SAME_SESSION` with `recover` under the frozen [MCode recovery contract](../protocol.md#safe-recovery-line). When continuation is impractical, the caller may replace that role under [endpoint replacement](../../SKILL.md#endpoint-replacement), within the run's recovery bound and without additional user confirmation. Transfer the role's current assignment, evidence, progress, and failures; a replacement checker receives only checker-permitted, de-anchored inputs and must remain distinct from every reviewer session, including replaced reviewers. Replacement does not extend the convergence bound or satisfy the failed barrier by itself. When the recovery bound is exhausted, report the structured error. A checker without a verified successful result stays `UNVERIFIED`.

This pipeline has no provider fallback. MCode failures do not qualify for Claude `retry-invalid` or a different-model fallback; necessary session replacements preserve the role's frozen provider/model/variant. The general Claude retry/fallback protocol remains unchanged for Claude tasks outside this default graph.

## Final deliverable

Report two independent statuses:

- `Pipeline Check`: `PASS` only when the role/source/barrier contract held and a verified independent MCode checker accepted the audit. Report the actual model/variant, Codex effort, and the distinct reviewer/checker task/session identities. Otherwise report `FAIL`, `PARTIAL`, or `UNVERIFIED` with the exact reason; a failed or unverified checker never satisfies the final barrier.
- `Review Result`: `FAIL` when at least one confirmed issue remains, otherwise `PASS` after completed verification. If verification could not finish, report `UNVERIFIED` with the blockers. A successful pipeline can therefore produce `Pipeline Check: PASS` and `Review Result: FAIL`.

Show confirmed issues in one table with columns: ID, severity, location, issue and failure scenario, evidence, minimal fix and dependencies, MCode reviewer verdict, Codex verdict, and independent MCode checker verdict. Label the MCode columns `Opus 5 xhigh` and the Codex column `GPT-6 max`, using the verified execution details above to distinguish the same-model MCode roles. Follow it with compact `DROPPED`, `UNRESOLVED`, and `OUT_OF_SCOPE` appendices when non-empty. Never merge an unresolved or checker-only candidate into the confirmed table.
