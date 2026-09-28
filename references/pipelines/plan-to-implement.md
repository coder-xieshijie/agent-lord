# Plan-to-Implement Pipeline

Load this policy when the user says `plan-to-implement` or asks Agent Lord to turn an existing implementation plan into code. Read [common.md](common.md) first.

One implementation role carries an existing plan to completion on the delivery branch, one session per stage of the plan. Two independent checkers then look at the finished head: a reviewer reads the code against the plan, and an acceptance tester runs the plan's requirements from the product's real entry points. The code lives on the delivery branch from the first commit, so the run has no planner, module split, parallel writer, or integrator.

The scheduling caller owns the loop: start the session for each stage, continue a session that stopped early, run the checks, route their reports back to the implementation, and decide when the work stops. Reading, commits, and verification inside a stage belong to the session under [scheduling ownership](../../SKILL.md#scheduling-ownership).

## Roles and defaults

| Role                   | Provider, model, effort                                                                           | Workspace                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Implementation session | `mcode-cli` resolved default unless the user chooses; one frozen contract shared by every session | `reuse-or-create` on a declared delivery branch, `--head-sha` at that branch's head |
| Reviewer               | Same rule; a fresh session that wrote none of the code                                            | `isolated` at the checked head with its own `--workspace-branch`                    |
| Acceptance tester      | Same rule; a fresh session that wrote none of the code and never receives the sessions' messages  | `isolated` with its own `--workspace-branch`                                        |

The reviewer reads code against the plan, so behavior that only shows when the product runs — default wiring, real entry points, paths across modules — stays unchecked unless someone runs it. Earlier runs ended with "the real model path was never verified", and the gaps users later found themselves were of exactly that kind. The tester is a separate session because an author checking its own work tends to pass it.

A tester or end-to-end role the user names takes the acceptance tester's place, with the user's provider and instructions. When the user turns acceptance off for a run, record that in the manifest and report every requirement as unverified. The pipeline adds no other role.

## Prepare the run

Write the [run manifest](common.md#resolve-the-contract-before-dispatch): the goal, the plan path and content hash, the plan's stages in order, every repository with its delivery branch and base head (an existing MR's source branch when the user names one), the role contracts, and the user's publication authority and subagent instructions. Register the first implementation session, the reviewer, and the acceptance tester with `run-create --nodes-file` using `source.kind: pipeline` and `reference: plan-to-implement`; register each later implementation session with `run-add` before its `start`.

### Acceptance scenarios

The scenarios come from the plan and the spec it cites, and they exist before any code, so they describe what was asked for rather than what was built. A scenario runs from a real entry point — the UI, CLI, or API a user or caller would reach — and states its preconditions, the action, the observable result that counts as passing, and the evidence to keep. A requirement no real entry point can reach is listed as such.

- When the plan already has a scenario for each requirement (plan-cross-review writes them), the scenarios are that section of the plan.
- Otherwise, start the acceptance tester first, at the base head, with the plan and spec as inputs; this turn writes the scenario file, declared with `--require-file`. Implementation starts once the file exists.

Copy the scenarios outside the delivery repository and record their SHA-256 in the manifest. Implementation sessions receive that snapshot as the definition of done and leave it unchanged; without a frozen copy, a failing scenario can be turned green by deleting it or loosening what counts as passing. A session that finds a scenario wrong says so in its final message, and the caller passes that to the tester. Only the tester changes a scenario, only to correct how it runs, never to drop a requirement or weaken its pass condition, and its report lists each change with the reason; record each new snapshot hash.

## Run implementation sessions

Each implementation session owns one stage of the plan, in the plan's order: its own phases or milestones, or the whole plan when it has none. A stage is done when its checks pass and its work is committed on the delivery branch.

Author every session prompt under [task context preparation](../../SKILL.md#task-context-preparation). Its continuation state is:

- the plan and the goal it serves, and the stage this session owns, named by the plan's own heading;
- every repository with its delivery branch, and which one this session's checkout holds;
- the scenario snapshot, as the definition of done for the requirements the stage touches;
- what earlier stages delivered: the previous session's final message verbatim, with the artifact paths of earlier final messages as optional reading; the first session starts from the base head;
- the user's publication authority, such as committing and pushing to the delivery branches and opening or updating their MRs.

State the stage and what done means; leave out the session's memory, remaining context, and who reads its final message. An endpoint told that it has no memory and that its last message goes to the next session tends to wrap up early and write a handoff instead of finishing. Leave commit granularity, verification, and the form of the final message to the session.

```bash
node core/dist/cli.js start --run-id <run> --task-id <run>-s3 \
  --provider <provider> --model <model> --effort <effort> \
  --repo <repo> --source-branch <delivery-branch> --workspace-policy reuse-or-create \
  --head-sha <current-head> --message-file <prompt> --invocation-file <invocation> \
  --include-response
```

`--head-sha` pins each session to the head its predecessor left, and `reuse-or-create` refuses a dirty checkout. A session may end on a question without a commit, so sessions declare no `--require-commit`. When the stage covers work in another declared repository, start its session on that repository's delivery branch.

## Continue, ask, or stop

After each session operation, read its final message with `git status` and `git log <start-head>..HEAD` of its checkout, then take the matching action:

| Outcome                                           | Action                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage done, stages remain                         | Start the next stage's session                                                                                                                                                                                   |
| Stage not done, no blocker named                  | `turn` the same session naming the stage's remaining items, at most twice per session                                                                                                                            |
| Stage still not done after two continuation turns | Start a fresh session for the rest of the stage                                                                                                                                                                  |
| A question for the user                           | Ask the user, then `turn` the same session with the answer                                                                                                                                                       |
| Uncommitted changes in the checkout               | `turn` the same session with the `git status` output                                                                                                                                                             |
| Last stage done                                   | Start the checks                                                                                                                                                                                                 |
| Operation error                                   | Recover under the [deterministic loop](../../SKILL.md#deterministic-loop) and [endpoint replacement](../../SKILL.md#endpoint-replacement); a replacement receives the session prompt at the latest verified head |

Stop and report to the user, with the last final message, when two consecutive operations add no commit and ask no question.

## Check the finished head

When the last stage is done, run both checks on the same delivery head, concurrently, each in its own isolated worktree:

- **Review.** Start the reviewer with the plan, each delivery branch's `<base>..<head>` range, the last final message, and the installed `review-rules` Skill under the [dependency contract](../../SKILL.md#skill-dependencies). The reviewer checks the branches against the plan and returns findings.
- **Acceptance.** Continue the tester that wrote the scenarios with `turn`, or start it now when the scenarios came from the plan. Its prompt names the head to test and the scenario snapshot. It runs every scenario from its real entry point against that head and reports each as PASS with its evidence, FAIL with the observed and expected result, or UNVERIFIED with what blocked it, such as a missing entry point, environment, or credential. A scenario it could not run is UNVERIFIED, never PASS, and every result names the head it ran on. The delivery branch stays unchanged: throwaway scripts stay uncommitted in the tester's worktree, and a test worth keeping belongs in the fix.

Each check turn names the head to check; a checker whose worktree holds an earlier head brings its own workspace branch forward to it, since every later head descends from the earlier one.

A round passes when the review returns no finding that needs a change and no scenario FAILs. An UNVERIFIED scenario does not start a fix; it goes into the report.

When the round has a finding or a failure, `turn` the last implementation session with both reports verbatim; it wrote the code and holds its context, so it fixes by the reports. Start a fresh session for the fix only when that session is unusable. The fix follows the same [continue, ask, or stop](#continue-ask-or-stop) loop. When it is done, `turn` the reviewer with the fix range and the tester with the new head: the tester reruns the scenarios the fix could affect and those that failed, and states which earlier results it carries over and why. The run allows three check rounds; when the third still has a finding or a failure, stop and report the open items.

## Deliver and report

The run is complete when the last check round passes, every user-named role has passed, and each delivery branch's remote MR shows its final head. Read each MR back through `gh api` or `glab api` for source branch, target branch, head SHA, and open state; when a head is unpublished, `turn` the last implementation session to publish it.

Write the user report under the installed `explain-as-fool` Skill: the goal and what now exists; each stage, its sessions, and where they stopped; the plan deviations the sessions reported; the review result; each requirement as PASS, FAIL, or UNVERIFIED with its evidence location and the head it ran on; any scenario the tester changed and why; each MR; and what remains unverified. The pipeline publishes MRs; merging stays with the user.
