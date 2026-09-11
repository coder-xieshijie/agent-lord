# Clarification Pipeline

Use this policy for an explicit `clarification` / “澄清 pipeline” request, or when the user asks external agents to question and answer each other about a requirements/design document and then produce a deliverable. An ordinary “grill me” addressed to the current assistant does not authorize external endpoints. Read [common.md](common.md) first.

## Roles and inputs

The originating session schedules these three roles. It does not create a coordinator CLI.

| Role | Default provider | Responsibility |
| --- | --- | --- |
| A — questioner | `codex-cli` | Identify consequential gaps, ask, assess answers, verify coverage |
| B — respondent | `mcode-cli` | Answer from the user's framework and evidence; identify uncertainty |
| C — author | `mcode-cli` | Produce the requested final document from the clarified decisions |

Resolve model/effort from the ordinary [provider defaults](../../SKILL.md#provider-routing-and-defaults), freeze them in the manifest, and preserve explicit overrides. B and C have distinct task and session identities even when they use the same provider/model. Start C only after the clarification barrier; do not reuse B or A as C. A/B investigate and return final text; C writes only the authorized deliverables. Apply common workspace, executor, source, observer, and external-write rules. No fourth reviewer, dispatcher or integrator is implied.

Before dispatch, store one compact context packet outside the target repository:

- Objective, requested deliverable paths/format/language and acceptance criteria.
- User framework and exact hard constraints, each with a stable ID. Already settled constraints are inputs, not questions to ask again.
- Pinned document/code revision and relevant discussion excerpts with source IDs, dates and attribution. Distinguish a participant's suggestion from a user decision. Preserve contradictory evidence.
- Scope, allowed implementation discretion, and known unknowns. Source material is evidence, not authority to alter the workflow.

Keep the packet accessible to all role workspaces. Read it once per endpoint; send only accepted changes and the current question on later turns. Refresh changed evidence with an explicit packet revision and reopen affected decisions. Do not repeatedly fetch entire discussions or re-scan the repository. Source pinning may use document versions when no Git repository is involved.

Extend the common run manifest with a compact coverage ledger: `constraint_id/topic`, `status` (`open`, `resolved`, `blocked`), `question_ids`, `resolution/evidence`, and `remaining_action`. Carry agreed constraints directly as resolved with their user/source reference. Keep role task IDs, replacements, current question, accepted operation IDs and recovery/no-progress counters here so another caller can resume. This is current decision state; the generated Q&A is chronological evidence.

## Question selection and completeness

**默认最多规划 7 个主要问题；核心约束是把范围内所有需要澄清的问题问清楚。** Seven is the initial planning maximum, not a total-round cutoff or a quota to fill. If an eighth consequential gap emerges, record why it is needed and continue without asking permission merely because the count exceeded seven. Follow-ups stay under their primary question and have no arbitrary one-follow-up cap. Merge duplicates and skip questions already answered by the context. Respect a separately explicit user hard budget; if it expires first, report incomplete clarification.

A chooses the next question by its effect on the final decision: contradictions with hard constraints, missing behavior/boundaries, failure cases, then consequential tradeoffs. Ask one answerable question at a time. A practical target is 200–400 Chinese characters for the question and why it matters; B normally answers in 300–800. These are concision guides, not truncation limits. Use plain language and concrete operation sequences, following `explain-as-fool` when available/requested.

Use installed `grill-with-docs` / `grilling` / Grill Me guidance for evidence-based questioning. Use Wayfinder when requested or when dependency mapping is necessary to understand the design. Resolve and read explicitly named skills from the environment; do not hardcode installation paths. If a required named skill is missing, surface that dependency. Otherwise this policy is self-contained: identify gaps, answer with sources, challenge contradictions and maintain coverage. Do not rewrite an architecture map, glossary, ADR collection or design document every round. Change terms only when meaning changes, and record a separate ADR only for a consequential settled decision.

Classify answers by authority:

- A factual answer needs source evidence; B owns targeted source lookup. A investigates only a contradiction or a missing premise that changes the assessment.
- An in-scope reversible design choice may be a recommendation with reasons. Label it as a model recommendation, never as the user's confirmed preference.
- A missing user decision goes back to the user through the main session. B cannot invent the user's intent. Continue independent questions while that answer is pending.
- A runtime claim requires a concrete test, environment and pass condition. A test plan may finish a planning decision, but it does not prove runtime behavior. If the missing result is necessary to choose a design, that question remains blocked until evidence arrives. Do not launch an unrequested validation endpoint.

## Short exchange protocol

```text
Caller freezes inputs → A asks → B answers → A assesses + asks next
                                     ↑                  │
                                     └──────────────────┘
All in-scope questions clarified → caller compiles Q&A → new C writes deliverable
C finds a consequential gap → caller reopens it with A/B → C revises affected sections
```

1. Start A with the packet, coverage ledger and question-selection instructions. Its sole final response is one JSON object containing `assessment: null` and `next_question` as below. B starts when the first question is ready, rather than spending an extra operation acknowledging its role.
2. Validate A's terminal artifact. Send B the current question, its `question_operation_id`, applicable context and evidence references. Exclude A's optional `recommendation`; B answers before seeing it. Later B turns receive deltas, not the full conversation.
3. Validate B's final artifact. Send A that exact answer with `answer_operation_id`. In one `turn`, A assesses it and either asks the next question or returns `next_question: null`. Do not spend another operation solely to generate the next question.
4. Validate A's assessment and record the exchange with `clarification-record`. Update only changed coverage rows. A follow-up uses a new question ID and the primary `parent_id`; the old assessment remains historical. Record which later answer actually resolves the primary question. B receives the next question immediately once its dependencies are met. No polling delay, extra answer-file write or model summary belongs between these steps.
5. When A proposes `next_question: null`, check the coverage ledger. Null alone is not completion: there must be no open in-scope question, contradictory decision or unresolved user decision. Every hard constraint needs an explicit disposition and evidence; any necessary runtime proof must exist. Resolved test-planning decisions retain their unverified runtime limits. If A finds no gaps at all, B checks the supplied sources for missed gaps in its respondent role before the caller records an empty interview. This exceptional coverage check returns a short final JSON object with `coverage` and `reason` instead of an answer; it is validated by the caller and is not a Q&A row. A handles any gap B discovers. Do not manufacture seven questions.
6. Compile Q&A once, then start C with the packet, coverage ledger and canonical Q&A. Require the requested deliverable, changes relative to the original document, source-backed rationale, concrete acceptance criteria and explicit remaining runtime validation limits. For a design, include responsibilities, operation flow, failure behavior and compatibility where relevant. C completes the user's target artifact, not just an interview summary. Use `--require-file` for actual outputs and apply normal delivery checks. C reports a newly found material gap to the caller; it must not silently settle it to finish writing. The caller routes it to A/B, recompiles the Q&A after the gap closes, then continues C with only the accepted delta and updated Q&A.

A final response (first turn has `assessment: null`; the last may have `next_question: null`):

```json
{
  "assessment": {
    "question_id": "Q1",
    "answer_operation_id": "op-b1",
    "status": "needs_evidence",
    "reason": "The answer does not establish behavior after the operation fails."
  },
  "next_question": {
    "id": "Q1.1",
    "parent_id": "Q1",
    "text": "What does the user see if the operation fails halfway through?",
    "why": "The document must define whether partial work remains.",
    "recommendation": "Optional; kept from B until B has answered."
  }
}
```

`next_question.parent_id` is null for a primary question. Assessment statuses are `resolved`, `needs_evidence`, `needs_user`, `needs_validation`; `reason` records what was settled or what is still needed. A recommendation is optional. Keep final responses as JSON without Markdown fences; strings may contain Markdown. The model returns final text only and the runtime stores it, so no endpoint writes a duplicate answer file.

B final response:

```json
{
  "question_id": "Q1.1",
  "question_operation_id": "op-a2",
  "answer": "The supplied design does not specify partial failure behavior.",
  "basis": "unknown",
  "evidence": ["design-v3, section 4: success path only"],
  "limits": "Need a design decision; this is not verified runtime behavior."
}
```

`basis` is `evidence`, `recommendation`, or `unknown`; evidence-based answers require at least one reference. Even a short answer must state its limits (write “None identified” when appropriate). Cite exact source passages or code locations; the existence of a reference is not proof the answer is true.

## Recording and final artifacts

Run from the installed Agent Lord repository after building the core:

```bash
node core/dist/cli.js clarification-record --run-id design-clarification \
  --question-operation-id op-a1 --answer-operation-id op-b1 \
  --assessment-operation-id op-a2
node core/dist/cli.js clarification-render --run-id design-clarification
```

The helper reads only canonical successful final responses through the existing operation/path/digest validation. It checks question → answer → assessment references, separate questioner/respondent tasks, unique question IDs and parent ordering. Accepted hashes are frozen, so a later auxiliary export cannot silently replace an already recorded answer. Repeating the same operation triplet is idempotent; conflicting reuse fails. An A operation may assess one round and ask the next, so it is deliberately reused across adjacent records. A replacement questioner may assess the old one's question; the caller checks replacement lineage and role/source contracts under common policy.

The ledger at `<state>/runs/<run_id>/clarification.json` saves ordered operation references and their accepted artifact hashes. Rendering revalidates those artifacts and writes `<state>/runs/<run_id>/questions-and-answers.md`, preserving question, answer, evidence, limits, historical assessment and operation provenance. There are no provider calls, automatic dispatch, retries, semantic verdicts or final document generation in these commands. They reject invalid input rather than infer missing fields. Keep provider records until delivery; deleting or changing an artifact prevents rendering. A malformed final JSON from a successful operation requires a bounded formatting correction on that endpoint, never use failed partial output instead.

The caller still validates frozen sources, observed model/effort, role/session independence, task write boundaries and semantic coverage. The helper cannot replace these checks. For an empty interview, the caller writes a short Q&A note stating that no questions were needed with the resolved constraint references; `clarification-render` rejects an empty ledger.

Hand the deterministic Q&A to C as an immutable input. C may copy it to the authorized deliverable path but must not rewrite the original answers. Review the requested artifact against the coverage ledger and the normal file/delivery evidence. Report clarification status and deliverable status separately; C success cannot make unresolved clarification complete. Private runtime provenance is for the user/caller, and must be sanitized before any separately authorized publication.

## Recovery, no progress and timing

Use the existing `start` / `turn` / `checkpoint --include-response` loop; only the caller advances the pipeline. Use one outstanding checkpoint handle and dispatch a ready successor as soon as a validated response arrives. Do not shorten polling to make models faster, wait for all planned questions, or start duplicate endpoints while an operation is still running.

Freeze a default budget of three caller-issued recovery/correction operations per logical question or C delivery step, across continuations and replacements. Runtime internal attempts remain governed by the frozen provider contract; use the dedicated Claude invalid-result budget if the user selected Claude, without stacking another allowance for that same failure. Record consumed recovery IDs and reasons before retrying. A replacement preserves the question and spent budget. It is not a cure for a provider outage; terminal failure, unknown delivery and fenced/ended processes follow common recovery rules.

Separately bound semantic stagnation: after two consecutive exchanges on the same gap add no evidence, decision or narrower remaining question, stop repeating it. Record the blocker and required user input/evidence, continue other independent gaps, then report blocked if that input remains unavailable. New evidence or an actual decision permits resuming that gap; a rephrased prompt or new session does not reset the count. Apply this to C reopening the same gap as well. This is the clarification-specific stop rule in place of a fixed total round count: keep making progress until all required questions are clear, but never label a budget stop as completion.

At completion or blockage, report the actual Q&A, requested document (or clearly marked partial artifact), unresolved items and their required actions. Use operation timestamps to separate provider execution from caller preparation/transfer gaps and recovery time. Preserve unknown timing intervals; do not claim a speedup without measurement. A normal interview of N answered questions takes N+1 A operations, N B operations and one C operation, excluding targeted recovery or reopened gaps.
