# Long-running work

> Source: [https://developers.openai.com/codex/long-running-work](https://developers.openai.com/codex/long-running-work)

For work that may take many steps, give ChatGPT a clear outcome, constraints,
and definition of done. Keep related work in the same chat so
ChatGPT can use the same context to choose the next step and decide when the
work is complete.

_Applies to: ChatGPT desktop app._

In the ChatGPT desktop app, enter `/goal` to start Goal mode. The progress row
lets you pause, resume, edit, or clear the goal while ChatGPT works.

_Applies to: ChatGPT on the web._

For hosted long-running work in ChatGPT web, use ChatGPT Work and put the
outcome, constraints, and review criteria directly in your prompt.

Continue in the same web chat to add context, change constraints, or
ask for a status update. Use separate chats when independent tasks can run in
parallel, and avoid giving two tasks write access to the same connected source.
For related work, keep the chats and source files together in a
[project](https://learn.chatgpt.com/docs/projects).

_Applies to: Codex CLI._

In an interactive Codex CLI session, enter `/goal` to start Goal mode. Continue
the same session to steer the work or ask for a status update.

_Applies to: IDE extension._

In the IDE extension chat, enter `/goal` to start Goal mode for the open
workspace. Continue the same chat to steer the task while it runs.

_Applies to: ChatGPT desktop app._

  

> Illustration: ChatGPT desktop app goal progress controls above the composer

_Applies to: ChatGPT desktop app, Codex CLI, IDE extension._

## Start a goal

Type `/goal` in the ChatGPT desktop app, Codex CLI, or the IDE extension. The
goal text becomes both the first prompt and the completion criteria for the
task.

If the outcome is still unclear, start with `/plan`. Ask ChatGPT to interview you,
identify constraints, and turn the result into a goal with measurable success
criteria. Then start the refined goal with `/goal`.

_Applies to: ChatGPT desktop app, ChatGPT on the web, Codex CLI, IDE extension._

## Define what done means

Write a goal that lets ChatGPT verify its own progress. Include three things when
they apply:

| Goal element     | What to include                                                               |
| ---------------- | ----------------------------------------------------------------------------- |
| **Outcome**      | Describe the result you want, not only the activity ChatGPT should perform.   |
| **Constraints**  | Name required tools, boundaries, compatibility needs, or approaches to avoid. |
| **Verification** | Add tests, measurements, or review criteria that prove the work is complete.  |

For example:

```text
Migrate this codebase from JavaScript to TypeScript. Preserve existing behavior,
compile in strict mode without explicit `any` types, and make the full test suite pass.
```

_Applies to: ChatGPT desktop app._

## Steer a running goal

In the ChatGPT desktop app, the goal progress row appears above the composer. Use it to
pause or resume work, edit the goal, or clear it. You can also send follow-up
messages while the goal runs to add context or adjust constraints.

Use a side chat when you want a status recap or an explanation without
interrupting the main chat. Pause the goal before you expect to lose
connectivity, then resume it when you're ready for ChatGPT to continue.

_Applies to: ChatGPT on the web._

## Steer running work

Continue in the same chat to add context, adjust constraints, or ask
for a status recap. Start a separate chat when another task can run
independently.

_Applies to: Codex CLI._

## Steer a running goal

Send a follow-up message in the same interactive session to add context or
adjust constraints. Ask for a status recap when you want Codex to summarize
progress before it continues.

_Applies to: IDE extension._

## Steer a running goal

Continue in the same IDE chat to add context, adjust constraints, or ask for a
status recap. Keep the workspace available while the goal is running.

_Applies to: ChatGPT desktop app, Codex CLI, IDE extension._

Starting a goal doesn't grant ChatGPT broader access. It keeps the same
[sandbox and approval policy](https://learn.chatgpt.com/docs/sandboxing) and pauses when it
needs a decision. With [automatic approval](https://learn.chatgpt.com/docs/sandboxing/auto-review): reviews, a separate reviewer can
evaluate eligible requests without expanding those boundaries.

_Applies to: ChatGPT desktop app, Codex CLI, IDE extension._

## Run goals in parallel

Each chat keeps its own context, messages, results, and goal. Run chats
concurrently, but avoid letting two chats change the same files. Use
[worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) to give parallel coding chats separate
checkouts.

_Applies to: ChatGPT desktop app._

For local work, turn on **Prevent sleep while running** in settings so your Mac
stays awake. Use [Pets](https://learn.chatgpt.com/docs/pets?surface=app) or [system](https://learn.chatgpt.com/docs/notifications?surface=app): notifications to see when a chat needs input
or is ready for review.

_Applies to: ChatGPT desktop app, Codex CLI, IDE extension._

## Related docs

- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Goal mode and prompting](https://learn.chatgpt.com/docs/prompting#goal-mode)
- [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)

_Applies to: ChatGPT on the web._

## Related docs

- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- [Sandbox and permissions](https://learn.chatgpt.com/docs/sandboxing)
