# Cross-Review Pipeline

Load this policy for “交叉 Review”, “交叉审查”, or `cross-review` of an existing change. For `plan-cross-review` or a request to cross-review and rewrite a complete plan, route to [plan-cross-review.md](plan-cross-review.md) instead; it reuses this review protocol within its four-role graph. It is the documented expansion of that shorthand. Read [common.md](common.md) first.

The scheduling caller directly starts the reviewers, exchanges their final artifacts through `turn`, maintains the verdict ledger, and starts the independent checker after the barrier. Each reviewer or checker receives its current review assignment and the [executor constraint](../../SKILL.md#scheduling-ownership). Keep this orchestration in the caller instead of creating a cross-review coordinator CLI.

## Authorized graph and defaults

Unless the user overrides them, freeze these three roles at one repository and fixed review head/base:

| Role                      | Provider    | Model                                        | Effort  | Workspace  |
| ------------------------- | ----------- | -------------------------------------------- | ------- | ---------- |
| MCode reviewer            | `mcode-cli` | `custom_provider:mafia-claude/claude-opus-5` | `xhigh` | `isolated` |
| Codex reviewer            | `codex-cli` | `gpt-6-astra`                                | `high`  | `isolated` |
| Independent MCode checker | `mcode-cli` | `custom_provider:mafia-claude/claude-opus-5` | `xhigh` | `isolated` |

Pass these pipeline-specific model and effort choices explicitly, including `--effort xhigh` for MCode and `--effort high` for Codex. A MCode `#variant` remains model identity and is never used as reasoning effort. These choices do not change ordinary provider defaults.

Start all three CLI roles in `dangerously_bypass` without `--read-only`. Give each role its own worktree and distinct `--workspace-branch` from the same fixed review head; create them without confirmation under [common.md](common.md). Continue each role's later turns in its saved workspace. These review roles hold exclusive runtime leases and need no integration metadata or integrator.

Every review, cross-exam, convergence, and checker prompt states one boundary with its reason: the process is writable, and the caller accepts findings only against the pinned head, so the endpoint returns findings and leaves the checkout, HEAD, and external systems unchanged. The prompt is the only guard here; the runtime does not enforce read-only access. Verify the pinned source before accepting each artifact.

```text
MCode initial ─┐      ┌─ MCode cross-exam ─┐      ┌─ optional MCode convergence ─┐
               ├──────┤                    ├──────┤                              ├─ ledger ─ new-session MCode check ─ table
Codex initial ─┘      └─ Codex cross-exam ─┘      └─ optional Codex convergence ─┘
```

The two initial reviews are one concurrent ready set. The two cross-exams are a second concurrent ready set. Run at most one optional convergence pair, only for unresolved findings. Normal convergence costs five planned provider operations including the checker; the optional convergence round costs seven in total. Runtime recovery uses its frozen budget and adds no semantic convergence rounds or workflow nodes. Rows still unresolved after that round go to the checker, which is this pipeline's one adjudication step; do not add another arbiter or repeat full reviews.

## Shared review lens

Give both initial reviewers the same pinned source scope and the installed `review-rules` Skill resolved under the [dependency contract](../../SKILL.md#skill-dependencies). Read and apply that reference to findings and proposed fixes in every review, cross-exam, and checker assignment; it owns the quality criteria. Neither initial reviewer receives the other's output. Repository rules and confirmed task requirements define the applicable architecture and behavior boundaries.

Ask each initial reviewer to report every real issue it finds. Filtering happens later, in the cross-exam and the checker, so the initial prompt carries no severity threshold or “be conservative” instruction: current models follow such instructions literally and report less. Require source-pinned findings only. Each initial finding needs a stable reviewer-prefixed ID, severity proposal, exact location, evidence, concrete failure scenario, and the smallest credible fix. “Could be cleaner” or unsupported architectural preference is not a finding.

## Mutual cross-exam and ledger

After both initial artifacts pass the barrier, send the MCode reviewer the sanitized Codex artifact and Codex the sanitized MCode artifact in parallel. Each reviewer must challenge every candidate and may merge duplicates, but must preserve the original IDs.

Maintain one finding ledger outside the repository. Adjudicate these dimensions separately for each reviewer:

| Dimension                  | Question                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `fact_evidence`            | Does the cited code and failure scenario prove a real issue at the pinned source?       |
| `severity`                 | Is the proposed impact and priority proportionate?                                      |
| `minimal_fix_dependencies` | Is the smallest fix correct, and are all affected symbols/callers/contracts identified? |

Each reviewer returns `ACCEPT`, `REJECT`, or `NEEDS_EVIDENCE` plus a source-grounded reason for every dimension. Classify a candidate as:

- `CONFIRMED` only when both reviewers return `ACCEPT` on all three dimensions;
- `DROPPED` only when both explicitly agree it is not a real/actionable issue and record why;
- `UNRESOLVED` in every other combination.

The optional convergence turn receives only the unresolved ledger rows and the missing evidence requests. It must not restart a full review or introduce unrelated findings. Preserve the dropped ledger for the checker and final audit.

## Independent MCode check

Start the MCode checker once the cross-exams and any convergence turn are complete, including when rows remain unresolved. Use a new `task_id` and provider Session that participated in neither initial review nor mutual cross-exam/convergence; never continue a reviewer session as the checker. Independence comes from that fresh session and the de-anchored input below, not from a different model family. The checker deliberately uses the same Opus model and effort as the MCode reviewer.

Build a de-anchored checker packet containing:

- pinned source scope and the shared review lens;
- both unedited sanitized initial artifacts;
- candidate IDs, locations, evidence, failure scenarios, minimal-fix dependency sets, and the dropped-candidate list;
- no participant consensus label, final severity, or instruction to ratify the reviewers.

Ask the MCode checker to return its own verdict for every candidate: `CONFIRMED`, `REJECTED`, or `CANNOT_VERIFY`, each with source evidence. For each one it verifies the evidence and severity at the pinned source and checks that the proposed fix is minimal and complete. It also inspects dropped candidates for false negatives. A verifier tends to pass work after a light look, so the prompt names each of these checks explicitly rather than asking for a general “double-check”. The checker's verdict settles rows the reviewers left unresolved. It may report newly discovered items only in an `OUT_OF_SCOPE` appendix; those items have not been cross-examined and are not promoted into the confirmed table.

Complete this step only with a verified successful MCode result: the observed model matches the frozen contract, `xhigh` is argument-enforced, Session/Turn/Run and artifact identity verify, and the checker session is distinct from the reviewers. All source and barrier checks still apply.

For either MCode role, consume an applicable `safe_recovery=CONTINUE_SAME_SESSION` with `recover` under the frozen [MCode recovery contract](../protocol.md#safe-recovery-line). When continuation is impractical, the caller may replace that role under [endpoint replacement](../../SKILL.md#endpoint-replacement), within the run's recovery bound and without additional user confirmation. Transfer the role's current assignment, evidence, progress, and failures; a replacement checker receives only checker-permitted, de-anchored inputs and must remain distinct from every reviewer session, including replaced reviewers. Replacement does not extend the convergence bound or satisfy the failed barrier by itself. When the recovery bound is exhausted, report the structured error. A checker without a verified successful result stays `UNVERIFIED`.

This pipeline has no provider fallback. MCode failures do not qualify for Claude `retry-invalid` or a different-model fallback; necessary session replacements preserve the role's frozen provider/model/variant/effort. The general Claude retry/fallback protocol remains unchanged for Claude tasks outside this default graph.

## Final deliverable

Report two independent statuses:

- `Pipeline Check`: `PASS` only when the role/source/barrier contract held and a verified independent MCode checker returned a verdict for every candidate. Report the actual model/variant, MCode and Codex effort evidence, and the distinct reviewer/checker task/session identities. Otherwise report `FAIL`, `PARTIAL`, or `UNVERIFIED` with the exact reason; a failed or unverified checker never satisfies the final barrier.
- `Review Result`: `FAIL` when the checker confirmed at least one issue, otherwise `PASS` after completed verification. If verification could not finish, report `UNVERIFIED` with the blockers. A successful pipeline can therefore produce `Pipeline Check: PASS` and `Review Result: FAIL`.

Show the checker-confirmed issues in one table with columns: ID, severity, location, issue and failure scenario, evidence, minimal fix and dependencies, MCode reviewer verdict, Codex verdict, and independent MCode checker verdict. Label the MCode columns `Opus 5 xhigh` and the Codex column `GPT-6 high`, using the verified execution details above to distinguish the same-model MCode roles. Mark rows the reviewers did not both accept, so the user can see which issues the checker settled. Follow the table with compact appendices when non-empty: `DROPPED` for candidates the checker rejected, keeping both reviewers' evidence where they had agreed it was real; `UNRESOLVED` for `CANNOT_VERIFY` verdicts, naming the missing evidence; and `OUT_OF_SCOPE` for checker-only items. Never merge a checker-only candidate into the confirmed table.
