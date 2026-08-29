# Cross-Review Pipeline

Load this policy whenever the user asks Agent Lord for “交叉 Review”, “交叉审查”, or `cross-review`. It is the documented expansion of that shorthand. Read [common.md](common.md) first.

## Authorized graph and defaults

Unless the user overrides them, freeze these three roles at one repository and fixed review head/base:

| Role | Provider | Model | Effort | Workspace |
| --- | --- | --- | --- | --- |
| Opus reviewer | `claude-cli` | `claude-opus-5` | `high` | `shared-readonly` |
| Codex reviewer | `codex-cli` | `gpt-5.6-sol` | `high` | `shared-readonly` |
| Independent checker | `claude-cli` | `fable` | `high` | `shared-readonly` |

```text
Opus initial ─┐      ┌─ Opus cross-exam ─┐      ┌─ optional Opus convergence ─┐
              ├──────┤                    ├──────┤                              ├─ consensus ─ Fable check ─ table
Codex initial ┘      └─ Codex cross-exam ─┘      └─ optional Codex convergence ─┘
```

The two initial reviews are one concurrent ready set. The two cross-exams are a second concurrent ready set. Run the optional convergence pair only for unresolved findings. Normal convergence costs five provider operations including Fable; one extra convergence round costs seven. Do not add an arbiter or repeat full reviews. If unresolved findings remain after that round, stop before Fable and report them as `UNRESOLVED` unless the user authorizes expansion.

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

After both initial artifacts pass the barrier, send Opus the sanitized Codex artifact and Codex the sanitized Opus artifact in parallel. Each reviewer must challenge every candidate and may merge duplicates, but must preserve the original IDs.

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

## Independent Fable check

Start Fable only after the ledger contains no unresolved rows. Build a de-anchored checker packet containing:

- pinned source scope and the shared review lens;
- both unedited sanitized initial artifacts;
- candidate IDs, locations, evidence, failure scenarios, minimal-fix dependency sets, and the dropped-candidate list;
- no participant consensus label, final severity, or instruction to ratify the reviewers.

Ask Fable to independently reclassify every candidate, verify source evidence and severity, inspect dropped candidates for false negatives, and verify that the proposed fix is minimal and complete. It may report newly discovered items only in an `OUT_OF_SCOPE` appendix; those items are not silently promoted into consensus findings.

The Fable barrier requires `observed.fallback_used=false` and a verified Fable main model. A fallback to Opus makes the check `UNVERIFIED`, because Opus was already a participant. It does not become a Check pass and does not authorize a replacement checker.

## Final deliverable

Report two independent statuses:

- `Pipeline Check`: `PASS` only when the role/source/barrier contract held and independent Fable accepted the audit; otherwise `FAIL`, `PARTIAL`, or `UNVERIFIED` with the exact reason.
- `Review Result`: `FAIL` when at least one confirmed issue remains, otherwise `PASS`. A successful pipeline can therefore produce `Pipeline Check: PASS` and `Review Result: FAIL`.

Show confirmed issues in one table with columns: ID, severity, location, issue and failure scenario, evidence, minimal fix and dependencies, Opus verdict, Codex verdict, and Fable check. Follow it with compact `DROPPED`, `UNRESOLVED`, and `OUT_OF_SCOPE` appendices when non-empty. Never merge an unresolved or checker-only candidate into the confirmed table.
