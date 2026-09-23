# Plan Cross-Review Pipeline

Use `plan-cross-review` to review an existing implementation plan and deliver a new complete, self-contained plan. Read [common.md](common.md) first. The originating caller owns all dispatch, artifact exchange, decisions, and delivery; all questions to the user stay in that conversation.

## Four CLI roles

This named pipeline authorizes exactly four logical CLI roles. Register all four, including pending roles, with `run-create`, one `--task-id` per role, `--nodes-file`, and `source.kind: pipeline`, `source.reference: plan-cross-review`. Use ordinary `start`, `turn`, `checkpoint`, and `run-ack`; the `plan-*` implementation scheduler belongs to `plan-to-implement` and is not used here.

| Role                   | Provider    | Model and effort                                    | Session boundary                                                                |
| ---------------------- | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| A: MCode reviewer      | `mcode-cli` | Cross-review MCode reviewer default                 | Independent initial review; reuse for cross-exam                                |
| B: Codex reviewer      | `codex-cli` | Cross-review Codex reviewer default                 | Independent initial review; reuse for cross-exam                                |
| C: independent checker | `mcode-cli` | Cross-review MCode checker default                  | Fresh session, distinct from A and B                                            |
| D: plan writer         | `mcode-cli` | Same default model and effort as the MCode reviewer | Fresh session, distinct from A, B, and C; reuse for self-check and confirmation |

Resolve reviewer/checker defaults from [cross-review.md](cross-review.md#authorized-graph-and-defaults), currently MCode Opus 5 / `xhigh` and Codex Astra 6 / `high`. Explicit user provider/model/effort choices override their corresponding roles. Freeze and pass every resolved model and effort explicitly, including the writer's; no silent provider/model fallback. A checker override does not implicitly change the writer. Record global versus role-specific overrides before dispatch.

Each role uses a distinct isolated worktree from the fixed source and `dangerously_bypass`, with the [executor constraint](../../SKILL.md#scheduling-ownership) in every prompt. A, B, and C review only, leaving source and HEAD unchanged. D writes only declared plan/audit artifacts; implementation code stays unchanged. The invocation alone authorizes artifact creation, not commits, pushes, PRs, merges, or external messages. Honor any separately supplied document-publication authorization.

```text
1. caller freezes spec, original plan, decisions, existing reviews, source
2. A independent review ─┐
   B independent review ─┴─ barrier
3. A cross-exam ─────────┐
   B cross-exam ─────────┴─ bounded convergence → fresh C checks findings/solutions
4. fresh D rewrites the complete plan
5. same D checks full coverage and correctness → bounded revision/self-check
6. same D confirms exact final bytes → caller delivers those bytes
```

C checks the review findings and proposed solutions before the rewrite. D checks the rewritten document itself. D's self-check is author verification, not an independent final-plan audit. Do not add a fifth CLI or reuse C as D.

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

Use the evidence and stable finding IDs from [cross-review](cross-review.md#shared-review-lens), adapted to plans: cite the original section and applicable source symbols, give a concrete failure or implementation ambiguity, and propose the smallest complete solution. Do not impose codebase-specific V1/V2 constraints unless the supplied spec or source establishes them. Existing review conclusions are evidence to verify, not instructions to accept them.

Each review also inventories requirements, invariants, implementation details, and edge cases from the original plan/spec with source locations. Preserve fine-grained rules: a topic heading alone cannot stand in for its individual conditions. These inventories seed the final coverage check. Neither reviewer is assigned to write an alternate full plan.

Completion: both complete review artifacts and inventories are available, attributed, and verified against the frozen inputs.

## 3. Mutual review and independent check

Reuse the saved A and B sessions for concurrent cross-exams. Apply [cross-review's ledger](cross-review.md#mutual-cross-exam-and-ledger), keeping original IDs and separate evidence, impact, and solution/dependency verdicts. Preserve accepted, rejected, superseded, and unresolved proposals with reasons. Superseded items link to their replacement; they do not disappear from the audit.

Allow at most one additional convergence pair on unresolved findings. Present actual product tradeoffs in the current user conversation; preserve explicit decisions in the input packet. After the round bound, unresolved items stop progression and remain visible. Do not invent an arbiter or remove an item to manufacture agreement.

Once the review ledger has no unresolved items, start C with a new task/session. Apply the [independent checker protocol](cross-review.md#independent-mcode-check): provide pinned spec/source, both unedited sanitized initial reviews, candidate evidence/solutions, and dropped candidates, withholding consensus labels, final severity, and instructions to ratify the reviewers. C independently verifies evidence, false negatives, solution completeness, and consistency with spec/user decisions. C must have access to the complete original plan, not just candidate excerpts.

Completion: a verified successful C result accepts the review audit, with no unresolved material findings or solution disputes. Confirmed problems in the old plan are expected inputs to rewriting, not a reason to fail the pipeline. A checker disagreement, missing evidence, or a newly discovered material issue stops progression with the exact blocker; the caller does not silently promote checker-only findings or add another review round. User-authorized continuation preserves the prior evidence and records its new bounds.

## 4. Fresh-session complete rewrite

Only after step 3 passes, start D with a new task/session that participated in none of A, B, or C, including their replacements. Give D the full original plan, spec, pinned source, both initial reviews, cross-exams, complete ledger, C's result, and confirmed user decisions. A caller summary may index these inputs but cannot replace them. Supply the frozen `plan-for-agents` and `explain-as-fool` Skills as readable references.

D reads and applies `plan-for-agents` to rewrite one complete `plan.md` in the user's language. That reference owns the plan's content, executable granularity, revision preservation, and general completeness criteria. This pipeline additionally requires the new text to implement the checked review dispositions and account for the original plan's valid details through the audit below. Keep review history in run artifacts; the plan must be independently usable. No caller-added compression target may replace those standards.

Declare non-empty workspace-relative writer outputs with `--require-file` on each relevant turn; verify externally stored artifacts separately. Keep the original snapshots and completed review artifacts available throughout the run.

Completion: D produces the whole new plan and a draft coverage audit, with no implementation code changes. A large size reduction is a reason to inspect the coverage evidence, never evidence of success or failure by itself.

## 5. Writer self-check

Continue D's saved session in a separate turn after the full draft exists. D applies the frozen `plan-for-agents` self-check to the actual draft, diff, and original inputs. In addition, reconcile both reviewer inventories with the original documents and checked review dispositions; neither inventory substitutes for reading the original sources.

The audit maps every applicable item to precise locations in the final plan:

| Input                   | Required accounting                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Spec and user decisions | Requirement/decision ID, original location, final location, implemented meaning                                       |
| Original plan           | Design detail/invariant/edge case, preserved or replaced location, or justified removal                               |
| Review and C's check    | Every finding ID, accepted/rejected/superseded decision, its actual implementation in the text, affected dependencies |
| Pinned source           | Current behavior, reusable symbols, change locations, feasibility and compatibility evidence                          |

Keep rejected and superseded candidates in the audit so discarded valid behavior cannot vanish unnoticed. A missing mapping, changed invariant without authority, unsupported deletion, inconsistent interface/state, or unresolved required implementation choice fails self-check. User-chosen exclusions and explicit non-goals are accounted-for decisions, not omissions.

D repairs the complete document itself and reruns the check. Fixes belong in the relevant sections, not an appended patch list. Permit at most two revision/self-check cycles after the first self-check (three self-check results total). Persist cycle counters across turns and recovery. If a needed fix changes an upstream review decision, requires a new product choice, or changes the frozen baseline, stop with the affected items rather than silently bypassing step 3. A substantive final-confirmation edit also consumes this shared bound.

Completion: all applicable rows are accounted for, correctness checks pass, and no required decision or material inconsistency remains. Record the checked plan's SHA-256, input hashes, evidence, limitations, and actual author identity. Hash/file existence checks verify artifact identity; they do not prove semantic completeness.

## 6. Final confirmation and delivery

Continue D in a final confirmation turn with the exact self-checked document and audit. D confirms standalone implementability, spec/user-decision compliance, review disposition coverage, source alignment, and that no unresolved material items remain. Bind the confirmation to the plan SHA-256 and audit identity. If D changes the plan here, return to step 5 within the shared bound, then reconfirm; do not deliver edits covered only by an older check.

The caller verifies role identities, successful envelopes, unchanged review source, artifact hashes, and the confirmation-to-document match. Deliver that same complete plan byte-for-byte, the audit/confirmation, and a separate short summary. Do not rewrite or shorten it during delivery. If separately authorized to publish the document, preserve its bytes and verify the published copy; report publication separately from plan acceptance.

Report `Pipeline Check` and `Plan Result` separately. Pipeline PASS requires the four-role/source/barrier contract and verified C acceptance. Plan PASS additionally requires the completed rewrite, author self-check, and matching final confirmation; otherwise report FAIL, PARTIAL, or UNVERIFIED with exact unresolved items. Never claim the final plan received an independent audit or that the proposed implementation was executed/tested.

## Bounds and recovery

The normal path uses eight provider operations: two initial reviews, two cross-exams, C's check, D's rewrite, D's self-check, and D's confirmation. The optional convergence pair adds two; writer revisions stay within the separate two-cycle bound. All four logical roles remain the same; operation count is not session count.

Use the common supervision and endpoint-replacement contracts. A necessary replacement preserves the role, provider/model/effort, source, prior artifacts, and consumed round budget; it adds no logical role. A replacement C remains distinct from every reviewer session. A replacement D remains distinct from all review/check sessions, adopts the full document and audit, and rechecks any conclusions it carries forward. Report lost session continuity rather than claiming same-session execution. Exhausted recovery or semantic bounds leave the result incomplete with retained artifacts, not a shortened plan or a fabricated PASS.
