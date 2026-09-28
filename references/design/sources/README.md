# 官方原文存档

[设计规范](../guidelines.md)引用的全部原文，于 2026-09-28 抓取。内容保持原文，只做格式整理，得到普通的 Markdown 文档，整理方式见文末。`scripts/check-docs.mjs` 不检查这些文件内部的链接，但会校验规范指向这些文件的锚点。原文版权归各自发布方所有，这里仅作为设计依据的存档。

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

每篇文件的第二行都写有原始地址。

## 获取方式

- **A**：官方 Markdown（在页面地址后加 `.md`）。`platform.claude.com` 在抓取机器上被地区限制，通过 Agent Reach 的 Jina Reader 读取。
- **B**：在页面 URL 后加 `.md`，下载站点提供的官方 Markdown。
- **C**：通过 Agent Reach 的 Jina Reader 取得的 Markdown。

## 整理方式

三种来源都按同一套规则整理，内容本身不改写：

- 文件开头统一为 `# 标题`，下一行是原文地址（有发布日期的一并注明）。
- 删除站点附加内容：Jina 元数据、站点导航、"推荐阅读"一类的站点区块、页面锚点标签和图标组件；YAML 元数据只保留标题和页面副标题（副标题作为正文第一段）。
- 站点组件改为普通 Markdown：提示框（Tip、Note、Info、Warning、Callout）改为引用块；步骤组件改为编号的加粗小标题；折叠块改为加粗小标题；多语言代码组按语言依次列出，每段代码上方标注语言；卡片改为"链接：说明"的列表；OpenAI 文档中按使用环境切换的内容块改为一行 "Applies to: …"；按键标签改为行内代码；组件带来的缩进一并去掉。
- 代码块内容逐字保留，只把代码块的语言标注简化为语言名，原来的代码块标题放到代码块上一行。
- 正文中以文字形式出现的标签名（例如 `<instructions>`）包进行内代码，避免被当成 HTML。
- 修复抓取时粘连的空格（例如加粗、链接与前后文字之间），站内相对链接改为绝对地址，指向本页的链接改为页内锚点，列表改为紧凑格式。

更新原文时按同样方式抓取和整理，覆盖对应文件并更新本表；新增原文时同时在[设计规范](../guidelines.md)里补上引用。
