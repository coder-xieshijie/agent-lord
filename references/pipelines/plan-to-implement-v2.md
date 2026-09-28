# Plan-to-Implement v2 Pipeline

Load this policy when the user says `plan-to-implement-v2`. Read [common.md](common.md) first.

One implementation role carries an existing plan to completion through consecutive fresh sessions on the delivery branch, and one independent reviewer checks the finished branch against the plan. Each session reads the plan, the branch, and its predecessor's final message, then decides what to do and how far to go. The code lives on the delivery branch from the first commit, so the run has no planner, module split, parallel writer, or integrator.

The scheduling caller owns only the loop: start a session, pass its final message verbatim to the next one, and decide when the work stops. Reading, scope per session, commits, and verification belong to the session under [scheduling ownership](../../SKILL.md#scheduling-ownership).

## Roles and defaults

| Role                   | Provider, model, effort                                                                           | Workspace                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Implementation session | `mcode-cli` resolved default unless the user chooses; one frozen contract shared by every session | `reuse-or-create` on a declared delivery branch, `--head-sha` at that branch's head   |
| Final reviewer         | Same rule; a fresh session that wrote none of the code                                            | `isolated` at the reviewed head with its own `--workspace-branch`, checkout unchanged |

A role the user names, such as an end-to-end tester, runs on the reviewed heads after the review passes. The pipeline adds no other role.

## Prepare the run

Write the [run manifest](common.md#resolve-the-contract-before-dispatch): the goal, the plan path and content hash, every repository with its delivery branch and base head (an existing MR's source branch when the user names one), the role contracts, the user's publication authority and subagent instructions, and a session cap. Register the first session and the reviewer with `run-create --nodes-file` using `source.kind: pipeline` and `reference: plan-to-implement-v2`; register each later session with `run-add` before its `start`.

## Run implementation sessions

Author every session prompt under [task context preparation](../../SKILL.md#task-context-preparation). Its continuation state is:

- the plan and the goal it serves, every repository with its delivery branch, and which one this session's checkout holds;
- that the work spans several sessions, each starting with no memory beyond the repositories, their history, and the previous session's final message, and that this session's final message reaches the next session verbatim;
- the previous session's final message verbatim, with the artifact paths of earlier final messages as optional reading; the first session starts from the base head;
- the user's publication authority, such as committing and pushing to the delivery branches and opening or updating their MRs.

Leave scope per session, commit granularity, verification, and the form of the final message to the session.

```bash
node core/dist/cli.js start --run-id <run> --task-id <run>-s3 \
  --provider <provider> --model <model> --effort <effort> \
  --repo <repo> --source-branch <delivery-branch> --workspace-policy reuse-or-create \
  --head-sha <current-head> --message-file <prompt> --invocation-file <invocation> \
  --include-response
```

`--head-sha` pins each session to the head its predecessor left, and `reuse-or-create` refuses a dirty checkout. A session may end on a question without a commit, so sessions declare no `--require-commit`. When the previous final message names work in another declared repository, start the next session on that repository's delivery branch.

## Continue, ask, or stop

After each session, read its final message with `git status` and `git log <start-head>..HEAD` of its checkout, then take the matching action:

| Session outcome                     | Action                                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work remains                        | Start the next session                                                                                                                                                                                           |
| A question for the user             | Ask the user, then `turn` the same session with the answer                                                                                                                                                       |
| Uncommitted changes in the checkout | `turn` the same session with the `git status` output                                                                                                                                                             |
| The plan reported complete          | Start the final review                                                                                                                                                                                           |
| Operation error                     | Recover under the [deterministic loop](../../SKILL.md#deterministic-loop) and [endpoint replacement](../../SKILL.md#endpoint-replacement); a replacement receives the session prompt at the latest verified head |

Stop and report to the user, with the last final message, when two consecutive sessions add no commit or the session cap is reached.

## Final review

Start the reviewer with the plan, each delivery branch's `<base>..<head>` range, the last final message, and the installed `review-rules` Skill under the [dependency contract](../../SKILL.md#skill-dependencies). The reviewer checks the branches against the plan and returns findings.

When a finding needs a change, pass the review report verbatim as the next implementation session's continuation state, then `turn` the reviewer with the new range. Stop after two review rounds and report the findings still open.

## Deliver and report

The run is complete when the review returns no finding that needs a change, every user-named role has passed, and each delivery branch's remote MR shows its final head. Read each MR back through `gh api` or `glab api` for source branch, target branch, head SHA, and open state; when a head is unpublished, `turn` the last implementation session to publish it.

Write the user report under the installed `explain-as-fool` Skill: the goal and what now exists, each session and where it stopped, the plan deviations the sessions reported, the review result, each MR, and what remains unverified. The pipeline publishes MRs; merging stays with the user.
