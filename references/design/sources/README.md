# 官方原文存档

[设计规范](../guidelines.md)引用的全部原文，于 2026-09-28 抓取。文件保持抓取时的原样：不经 prettier 格式化，不做改写；`scripts/check-docs.mjs` 不检查这些文件内部的链接，但会校验规范指向这些文件的锚点。原文版权归各自发布方所有，这里仅作为设计依据的存档。

## Anthropic

| 文件                                                                                                       | 标题                                                        | 发布日期   | 获取方式 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------- | -------- |
| [claude-prompting-best-practices.md](anthropic/claude-prompting-best-practices.md)                         | Prompting best practices                                    | 持续更新   | A        |
| [prompting-claude-fable-5.md](anthropic/prompting-claude-fable-5.md)                                       | Prompting Claude Fable 5                                    | 持续更新   | A        |
| [prompting-claude-fable-5-1.md](anthropic/prompting-claude-fable-5-1.md)                                   | Prompting Claude Fable 5.1                                  | 持续更新   | A        |
| [prompting-claude-opus-5.md](anthropic/prompting-claude-opus-5.md)                                         | Prompting Claude Opus 5                                     | 持续更新   | A        |
| [prompting-claude-opus-5-5.md](anthropic/prompting-claude-opus-5-5.md)                                     | Prompting Claude Opus 5.5                                   | 持续更新   | A        |
| [skill-authoring-best-practices.md](anthropic/skill-authoring-best-practices.md)                           | Skill authoring best practices                              | 持续更新   | A        |
| [claude-code-best-practices.md](anthropic/claude-code-best-practices.md)                                   | Best practices for Claude Code                              | 持续更新   | B        |
| [building-effective-agents.md](anthropic/building-effective-agents.md)                                     | Building effective agents                                   | 2024-12-19 | C        |
| [multi-agent-research-system.md](anthropic/multi-agent-research-system.md)                                 | How we built our multi-agent research system                | 2025-06-13 | C        |
| [effective-context-engineering.md](anthropic/effective-context-engineering.md)                             | Effective context engineering for AI agents                 | 2025-09-29 | C        |
| [effective-harnesses-for-long-running-agents.md](anthropic/effective-harnesses-for-long-running-agents.md) | Effective harnesses for long-running agents                 | 页面未标注 | C        |
| [building-multi-agent-systems-when-and-how.md](anthropic/building-multi-agent-systems-when-and-how.md)     | Building multi-agent systems: When and how to use them      | 2026-01-23 | C        |
| [harness-design-long-running-apps.md](anthropic/harness-design-long-running-apps.md)                       | Harness design for long-running application development     | 2026-03-24 | C        |
| [scaling-managed-agents.md](anthropic/scaling-managed-agents.md)                                           | Scaling Managed Agents: Decoupling the brain from the hands | 2026-04-08 | C        |
| [multiagent-systems-patterns-and-problems.md](anthropic/multiagent-systems-patterns-and-problems.md)       | Patterns and problems in multiagent systems                 | 2026-08-13 | C        |

原始地址：

- Prompting 系列（前 5 篇）：`https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/<文件名去掉 .md>`
- Skill authoring best practices：https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Claude Code best practices：https://code.claude.com/docs/en/best-practices
- Building effective agents：https://www.anthropic.com/engineering/building-effective-agents
- Multi-agent research system：https://www.anthropic.com/engineering/multi-agent-research-system
- Effective context engineering：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Effective harnesses：https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Building multi-agent systems：https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- Harness design：https://www.anthropic.com/engineering/harness-design-long-running-apps
- Scaling Managed Agents：https://www.anthropic.com/engineering/managed-agents
- Patterns and problems in multiagent systems：https://www.anthropic.com/research/multiagent-systems

## OpenAI

| 文件                                                                                                        | 标题                                                          | 发布日期   | 获取方式 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- | -------- |
| [rethinking-skills-and-prompts-for-gpt-6-astra.md](openai/rethinking-skills-and-prompts-for-gpt-6-astra.md) | Rethinking skills and prompts for GPT-6 Astra                 | 2026-09-11 | B        |
| [using-gpt-6.md](openai/using-gpt-6.md)                                                                     | Using GPT-6（含 Prompting best practices）                    | 持续更新   | B        |
| [codex-prompting.md](openai/codex-prompting.md)                                                             | Prompting（Codex / ChatGPT）                                  | 持续更新   | B        |
| [codex-long-running-work.md](openai/codex-long-running-work.md)                                             | Long-running work                                             | 持续更新   | B        |
| [codex-subagents.md](openai/codex-subagents.md)                                                             | Subagents                                                     | 持续更新   | B        |
| [orchestration-and-handoffs.md](openai/orchestration-and-handoffs.md)                                       | Orchestration and handoffs                                    | 持续更新   | B        |
| [harness-engineering.md](openai/harness-engineering.md)                                                     | Harness engineering: leveraging Codex in an agent-first world | 2026-02-11 | C        |
| [run-long-horizon-tasks-with-codex.md](openai/run-long-horizon-tasks-with-codex.md)                         | Run long horizon tasks with Codex                             | 2026-02-23 | B        |

原始地址：

- GPT-6 Astra：https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra
- Using GPT-6：https://developers.openai.com/api/docs/guides/latest-model
- Codex Prompting：https://developers.openai.com/codex/prompting
- Long-running work：https://developers.openai.com/codex/long-running-work
- Subagents：https://developers.openai.com/codex/subagents
- Orchestration and handoffs：https://developers.openai.com/api/docs/guides/agents/orchestration
- Harness engineering：https://openai.com/index/harness-engineering/
- Run long horizon tasks with Codex：https://developers.openai.com/blog/run-long-horizon-tasks-with-codex

## 获取方式

- **A**：`platform.claude.com` 在抓取机器上被地区限制，直连会跳转到 app-unavailable-in-region。改为通过 Jina Reader（`https://r.jina.ai/<URL>`，请求头 `X-Return-Format: html`）取得完整渲染页面，再转换为 Markdown：保留从 `<h1>` 标题到页面底部 "Was this page helpful?" 之前的正文，包括标题、列表、表格、代码块、链接和强调，去掉站点导航与页脚；站内相对链接改写为 `https://platform.claude.com` 下的绝对地址。可以访问时，优先改用在页面 URL 后加 `.md` 得到的官方 Markdown。
- **B**：在页面 URL 后加 `.md`，直接下载站点提供的官方 Markdown。
- **C**：通过 Jina Reader（`https://r.jina.ai/<URL>`）取得的 Markdown，文件开头的 `Title` / `URL Source` 为 Jina 附加的元数据。

更新原文时沿用同一种方式，覆盖对应文件并更新本表的日期；新增原文时同时在[设计规范](../guidelines.md)里补上引用。
