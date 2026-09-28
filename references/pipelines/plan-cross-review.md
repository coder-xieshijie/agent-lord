# Plan Cross-Review Pipeline

Use `plan-cross-review` to review an existing implementation plan and deliver a new complete, self-contained plan. Read [common.md](common.md) first. The originating caller owns all dispatch, artifact exchange, decisions, and delivery; all questions to the user stay in that conversation.

## Four CLI roles

This named pipeline authorizes exactly four logical CLI roles. Register all four, including pending roles, with `run-create`, one `--task-id` per role, `--nodes-file`, and `source.kind: pipeline`, `source.reference: plan-cross-review`. Use ordinary `start`, `turn`, `checkpoint`, and `run-ack`; the `plan-*` implementation scheduler belongs to `plan-to-implement` and is not used here.

| Role                    | Provider    | Model and effort                                    | Session boundary                                                                                   |
| ----------------------- | ----------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A: MCode reviewer       | `mcode-cli` | Cross-review MCode reviewer default                 | Independent initial review; reuse for cross-exam                                                   |
| B: Codex reviewer       | `codex-cli` | Cross-review Codex reviewer default                 | Independent initial review; reuse for cross-exam                                                   |
| C: checker and writer   | `mcode-cli` | Cross-review MCode checker default                  | Fresh session, distinct from A and B; checks the review, then writes and revises the plan          |
| D: independent verifier | `mcode-cli` | Same default model and effort as the MCode reviewer | Fresh session, distinct from A, B, and C; never receives the review debate; reuse for re-verifying |

Resolve reviewer/checker defaults from [cross-review.md](cross-review.md#authorized-graph-and-defaults), currently MCode Opus 5 / `xhigh` and Codex Astra 6 / `high`. Explicit user provider/model/effort choices override their corresponding roles. Freeze and pass every resolved model and effort explicitly, including the verifier's; no silent provider/model fallback. A checker override also applies to C's writing turns, because C is one session; it does not change D. Record global versus role-specific overrides before dispatch.

Each role uses a distinct isolated worktree from the fixed source and `dangerously_bypass`, with the [executor constraint](../../SKILL.md#scheduling-ownership) in every prompt. A, B, and D review only, as does C's check turn, leaving source and HEAD unchanged. C's writing turns write only the declared plan and disposition-index artifacts; implementation code stays unchanged. The invocation alone authorizes artifact creation, not commits, pushes, PRs, merges, or external messages. Honor any separately supplied document-publication authorization.

```text
1. caller freezes spec, original plan, decisions, existing reviews, source
2. A independent review ─┐
   B independent review ─┴─ barrier
3. A cross-exam ─────────┐
   B cross-exam ─────────┴─ bounded convergence → fresh C checks findings/solutions
4. same C writes the complete plan and a disposition index
5. fresh D verifies the plan against the sources → C revises → D re-verifies (bounded)
6. caller delivers the verified bytes
```

C writes because it already holds the checked dispositions and their evidence; a fresh writer would have to reread the whole corpus, and detail gets lost at each handoff. D verifies because an author reviewing its own document tends to approve it, while a fresh session that never saw the debate checks the text against the sources. Do not add a fifth CLI, let D edit the plan, or give D the cross-exams or ledger.

## 1. Freeze inputs

The caller preserves readable, immutable snapshots of:

- the core `spec.md` (or explicitly designated specification), original complete plan, and confirmed user decisions;
- all existing review artifacts and proposed solutions supplied for this scope, including rejected and unresolved items;
- repository identity, complete source head/base SHAs, and the baseline refresh time; for a request using the latest target branch, fetch it before freezing;
- authorized scope, output locations, write/publication boundaries, role contracts, and the round limits below;
- the installed `review-rules`, `plan-for-agents`, and `explain-as-fool` Skills, resolved and frozen under the [dependency contract](../../SKILL.md#skill-dependencies).

Record content hashes and paths in the run manifest outside the target repository. Declare workspace-relative inputs with `--require-input`; verify access to external snapshots separately. Supply complete documents rather than replacing them with summaries. Identify conflicts between spec and user decisions explicitly; seek a current-session decision only where existing instructions do not resolve them. A missing required input or undecided material scope prevents the affected downstream stage.

Completion: both reviewers have the same accessible inputs and source identity. A later baseline or user-decision change invalidates affected review/check conclusions; record the new revision and revalidate affected work before advancing. Never silently relabel old evidence as current.

## 2. Independent reviews

Run A and B concurrently without exchanging their initial outputs. Both review the entire original plan against the spec, confirmed decisions, and pinned implementation. Each identifies valid design/implementation details to preserve as well as defects, omissions, unnecessary complexity, and smaller alternatives that reuse existing capability.

Use the evidence and stable finding IDs from [cross-review](cross-review.md#shared-review-lens), adapted to plans: cite the original section and applicable source symbols, give a concrete failure or implementation ambiguity, and propose the smallest complete solution. As there, reviewers report every real issue they find and leave filtering to the cross-exam and C. Do not impose codebase-specific V1/V2 constraints unless the supplied spec or source establishes them. Existing review conclusions are evidence to verify, not instructions to accept them.

Completion: both complete review artifacts are available, attributed, and verified against the frozen inputs.

## 3. Mutual review and independent check

Reuse the saved A and B sessions for concurrent cross-exams. Apply [cross-review's ledger](cross-review.md#mutual-cross-exam-and-ledger), keeping original IDs and separate evidence, impact, and solution/dependency verdicts. Preserve accepted, rejected, superseded, and unresolved proposals with reasons. Superseded items link to their replacement; they do not disappear from the audit.

Allow at most one additional convergence pair on unresolved findings. Evidence disputes still open after that go to C, which settles them as the cross-review checker does. Product tradeoffs only the user can decide go to the user in the current conversation; preserve explicit decisions in the input packet. Do not remove an item to manufacture agreement.

After the cross-exams and any convergence pair, start C with a new task/session. Apply the [independent checker protocol](cross-review.md#independent-mcode-check): provide pinned spec/source, both unedited sanitized initial reviews, candidate evidence/solutions, and dropped candidates, withholding consensus labels, final severity, and instructions to ratify the reviewers. C gives every candidate its own verdict and verifies evidence, false negatives, solution completeness, and consistency with spec/user decisions. C must have access to the complete original plan, not just candidate excerpts.

Completion: a verified successful C check with a verdict for every candidate. Confirmed problems in the old plan are expected inputs to rewriting, not a reason to fail the pipeline; C's verdicts become the dispositions the plan implements. A material `CANNOT_VERIFY` verdict, a checker-only material issue, or a pending user decision is carried into the plan as an open item that blocks only its affected steps; raise it with the user when it changes scope. The caller does not silently promote checker-only findings or add another review round. User-authorized continuation preserves the prior evidence and records its new bounds.

## 4. The same C writes the complete plan

Continue C's saved session in a writing turn. The prompt states the goal: one complete `plan.md` in the user's language that an agent who never saw this review can execute. It names C's own verdicts as the dispositions to implement and supplies the frozen `plan-for-agents` and `explain-as-fool` Skills as readable references. The full original plan, spec, pinned source, both initial reviews, cross-exams, and confirmed user decisions stay available as files; a caller summary may index them but cannot replace them.

`plan-for-agents` owns the plan's content, executable granularity, revision preservation, and completeness criteria, including the writer's own coverage check before delivery. The caller adds no separate self-check or confirmation turn: the writer already checks its own work, and a second pass by the same author adds cost without adding independence. This pipeline additionally requires the text to implement every disposition and keep the original plan's valid details. Fine-grained rules count individually; a topic heading cannot stand in for its conditions. Keep review history in run artifacts; the plan must be independently usable. No caller-added compression target may replace those standards.

Alongside the plan, C writes a short disposition index: each finding ID, its verdict, and where the plan implements it or why it was rejected or superseded. Declare both non-empty workspace-relative files with `--require-file` on each relevant turn; verify externally stored artifacts separately. Keep the original snapshots and completed review artifacts available throughout the run.

Completion: C produces the whole new plan and the disposition index, with no implementation code changes. A large size reduction is a reason to inspect D's coverage findings, never evidence of success or failure by itself.

## 5. Independent verification by a fresh D

After each writing turn, the caller snapshots and hashes the plan and index. Start D with a new task/session that participated in none of A, B, or C, including their replacements. D receives the frozen spec, confirmed user decisions, the complete original plan, the pinned source, C's disposition index, and the plan snapshot. D does not receive the cross-exams, the ledger, or C's working notes, so it checks the text against the sources rather than re-reading the debate.

A verifier tends to approve after a light look, so D's prompt names each check. D builds its own mapping from the original documents instead of judging whether C's index looks plausible:

| Source                  | What D checks                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Spec and user decisions | Each requirement and decision is implemented with its meaning intact; user-chosen exclusions and non-goals count       |
| Original plan           | Each design detail, invariant, and edge case is preserved, replaced, or removed with a stated reason, rule by rule     |
| Disposition index       | Each accepted finding is implemented where the index says; rejected and superseded items did not remove valid behavior |
| Pinned source           | Current behavior, reusable symbols, change locations, feasibility, and compatibility claims hold                       |

D also applies the `plan-for-agents` completeness criteria: every step has its inputs, actions, outputs, and completion criteria, and no interface, state, or required implementation choice is left inconsistent or open without being marked. D reports each gap with its location and evidence; it never edits the plan. A reviewer asked to find gaps usually reports some even in sound work, and chasing every one leads to over-engineering, so D reports as material only gaps that affect correctness or a stated requirement and lists anything else as optional.

When D reports gaps, continue C with D's report verbatim. C fixes each gap in the relevant section, not in an appended patch list, or answers it with a reason, and updates the index. The caller hashes the new snapshot and continues D to re-verify the whole revised document. Allow at most two revise/re-verify cycles after the first verification (three verification results total), and persist the counters across turns and recovery. If a fix would change an upstream disposition, require a new product choice, or change the frozen baseline, stop with the affected items rather than silently bypassing step 3. Gaps that C and D still disagree on after the bound become open items in `Plan Result`.

Completion: D's latest verification covers the exact current snapshot and reports no material gap. Record the plan's SHA-256, input hashes, D's report, and the author and verifier identities. Hash/file existence checks verify artifact identity; they do not prove semantic completeness.

## 6. Delivery

The caller verifies role identities, successful envelopes, unchanged review source, artifact hashes, and that D's passing report covers the SHA-256 being delivered. Deliver that same complete plan byte-for-byte, the disposition index, D's report, and a separate short summary. Do not rewrite or shorten it during delivery. If separately authorized to publish the document, preserve its bytes and verify the published copy; report publication separately from plan acceptance.

Report `Pipeline Check` and `Plan Result` separately. Pipeline PASS requires the four-role/source/barrier contract and a verified C check with a verdict for every candidate. Plan PASS additionally requires D's passing verification of the delivered bytes; otherwise report FAIL, PARTIAL, or UNVERIFIED with exact unresolved items. Describe D's verification accurately: D is a fresh session that never saw the review debate, and by default it runs the same model family as C. Never claim that the proposed implementation was executed or tested.

## Bounds and recovery

The normal path uses seven provider operations: two initial reviews, two cross-exams, C's check, C's writing turn, and D's verification. The optional convergence pair adds two; each revise/re-verify cycle adds two, at most two cycles. All four logical roles remain the same; operation count is not session count.

Use the common supervision and endpoint-replacement contracts. A necessary replacement preserves the role, provider/model/effort, source, prior artifacts, and consumed round budget; it adds no logical role. A replacement C remains distinct from every reviewer and verifier session, adopts the check result, the current draft, and the index, and rechecks any conclusions it carries forward. A replacement D remains distinct from A, B, and C and receives only verifier-permitted inputs. Report lost session continuity rather than claiming same-session execution. Exhausted recovery or semantic bounds leave the result incomplete with retained artifacts, not a shortened plan or a fabricated PASS.
