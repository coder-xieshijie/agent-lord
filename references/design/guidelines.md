# Pipeline 与 Skill 设计规范

修改以下内容前，先读本规范并逐条对照：`SKILL.md`（包括 frontmatter 里的 `description`）、`references/pipelines/` 下的任一 pipeline、调度方写给执行端的 prompt 规则，以及执行端会读到的依赖 Skill。每条规则后面列出官方原文出处。原文存档在 [sources/](sources/README.md)，引用以存档里的原文为准。

## 总原则

**每条指令、每个角色、每个步骤，都是在补一项"模型自己做不到"的假设。** 模型变强后，这些假设会过时，过时的就删掉。判断一条内容该不该留，问一句：删掉它，模型会做错吗？不会就删，或者改成由运行时强制。

依据：[Harness design · Iterating on the harness](sources/anthropic/harness-design-long-running-apps.md#iterating-on-the-harness)、[Fable 5 · Recommended scaffolding changes](sources/anthropic/prompting-claude-fable-5.md#recommended-scaffolding-changes)、[Claude Code · Write an effective CLAUDE.md](sources/anthropic/claude-code-best-practices.md#write-an-effective-claudemd)、[GPT-6 Astra · Up-to-date AGENTS.md](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#up-to-date-agentsmd)、[Scaling Managed Agents](sources/anthropic/scaling-managed-agents.md)（开篇：旧模型需要的 context reset 在新模型上成了累赘）。

"做减法"不等于什么都不写。目标、完成标准和少量真实的边界仍要写清楚：委派时任务描述过于简略，执行端会重复劳动、漏掉部分或误解任务；精简的意思是"最少的必要信息"，不是"越短越好"。

依据：[Multi-agent research system · Prompt engineering](sources/anthropic/multi-agent-research-system.md#prompt-engineering-and-evaluations-for-research-agents)、[Context engineering · The anatomy of effective context](sources/anthropic/effective-context-engineering.md#the-anatomy-of-effective-context)。

**优先级。** 用户的明确要求高于本规范和任何 Skill。依据：[Using GPT-6 · Instruction following](sources/openai/using-gpt-6.md#instruction-following)。

**只对某个模型成立的建议。** 官方指南里点名某个模型的建议，只在那个模型上测过。不同模型的建议冲突时，写成对各模型都成立的结果要求，不照抄某个模型的专用指令。例如验证：Opus 5 指南建议删掉验证指令，Fable 5 指南建议在长任务里明确要求用子 agent 按间隔验证。依据：[Prompting best practices · General principles](sources/anthropic/claude-prompting-best-practices.md#general-principles)。

## 一、调度方写给执行端的 prompt

1. **写结果、目的和完成标准，不写步骤。** 说清要什么、给谁用、做到什么程度算完成。只有用户或具名 pipeline 要求时，才规定过程。
   依据：[Codex Prompting · Describe the result you need](sources/openai/codex-prompting.md#describe-the-result-you-need)、[Codex Prompting · Prompting overview](sources/openai/codex-prompting.md#prompting-overview)、[Fable 5 · Give the reason, not only the request](sources/anthropic/prompting-claude-fable-5.md#give-the-reason-not-only-the-request)、[Codex Long-running work · Define what done means](sources/openai/codex-long-running-work.md#define-what-done-means)、[Opus 5 · Capability improvements](sources/anthropic/prompting-claude-opus-5.md#capability-improvements)（"performs best when given the complete task specification up front and left to run"）。

2. **完成标准写成可观察的结果和要交回的证据，不给执行端加通用的复查或验证步骤。** 用户自己提出的验证要求原样转达。
   依据：[Opus 5 · Task scope and over-verification](sources/anthropic/prompting-claude-opus-5.md#task-scope-and-over-verification)、[Opus 5 · Self-correction](sources/anthropic/prompting-claude-opus-5.md#self-correction)、[GPT-6 Astra · Up-to-date AGENTS.md](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#up-to-date-agentsmd)（测试类指令会导致不必要的测试）、[Using GPT-6 · Testing and verification](sources/openai/using-gpt-6.md#testing-and-verification)。

3. **材料写清用途和什么时候用，不要求"先读完再动手"。** 给出路径，由执行端按需读取。只有用户或具名 pipeline 要求全文时，才要求完整阅读。
   依据：[GPT-6 Astra · Up-to-date AGENTS.md](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#up-to-date-agentsmd)、[Context engineering · Context retrieval and agentic search](sources/anthropic/effective-context-engineering.md#context-retrieval-and-agentic-search)、[Harness engineering · Repository knowledge as the system of record](sources/openai/harness-engineering.md#we-made-repository-knowledge-the-system-of-record)。

4. **边界只写真正会出问题的一两条，每条附上原因，只写一次，用正面表述。** 执行端会照字面执行，措辞强硬的边界会让它在本可继续的地方停下；叠加的禁止句和强调词会稀释真正重要的那条。真实存在的边界仍要写明。
   依据：[Codex Prompting · Set boundaries that prevent real problems](sources/openai/codex-prompting.md#set-boundaries-that-prevent-real-problems)、[GPT-6 Astra · Decision boundaries](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#decision-boundaries)、[Prompting best practices · Add context to improve performance](sources/anthropic/claude-prompting-best-practices.md#add-context-to-improve-performance)、[Claude Code · Write an effective CLAUDE.md](sources/anthropic/claude-code-best-practices.md#write-an-effective-claudemd)、[Fable 5 · State the boundaries](sources/anthropic/prompting-claude-fable-5.md#state-the-boundaries)。

5. **授权执行端无人值守地把工作做完。** 可回退、在授权范围内的工作直接做；先完成不受问题阻塞的部分；只有用户才能决定的事，以及破坏性、不可逆的操作，才交回调度方。
   依据：[Fable 5.1 · Finish the whole task](sources/anthropic/prompting-claude-fable-5-1.md#finish-the-whole-task)、[Fable 5 · Strong instruction following](sources/anthropic/prompting-claude-fable-5.md#strong-instruction-following)、[Using GPT-6 · Initiative and follow-through](sources/openai/using-gpt-6.md#initiative-and-follow-through)、[GPT-6 Astra · Persistence](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#persistence)。

6. **不规定方法。** 算法、库、命令顺序、测试数量、是否使用子 agent，都留给执行端，除非用户有要求。要守住的是不变量，不是实现方式。
   依据：[Fable 5.1 · Finish the whole task](sources/anthropic/prompting-claude-fable-5-1.md#finish-the-whole-task)（"without much guidance on methodology"）、[Harness engineering · Enforcing architecture and taste](sources/openai/harness-engineering.md#enforcing-architecture-and-taste)、[Harness design · The architecture](sources/anthropic/harness-design-long-running-apps.md#the-architecture)（planner 只约束交付物，路径留给执行者）。

7. **不要求执行端在回复里复述推理过程。** 这类指令可能被判为提取推理而拒绝执行。
   依据：[Fable 5 · Recommended scaffolding changes](sources/anthropic/prompting-claude-fable-5.md#recommended-scaffolding-changes)。

8. **只有文字、没有工具调用的结尾是一次汇报，不代表完成。** 执行端交回时仍列着未完成、又没说明被什么卡住的事项，调度方就在同一 session 里点名这些事项让它继续；同一任务最多续 2–3 次。
   依据：[Opus 5.5 · Unattended agentic runs](sources/anthropic/prompting-claude-opus-5-5.md#unattended-agentic-runs)。

## 二、Pipeline 设计

1. **从一个 agent 开始，有明确收益才拆。** 值得拆的情况只有四种：上下文会互相污染、工作确实能并行、需要不同的工具或互相冲突的指令、需要独立验证。多 agent 一般要多花 3–10 倍 token。
   依据：[Multi-agent systems · Starting with a single agent](sources/anthropic/building-multi-agent-systems-when-and-how.md#the-case-for-starting-with-a-single-agent)、[Multi-agent systems · Decision framework](sources/anthropic/building-multi-agent-systems-when-and-how.md#a-decision-framework-for-multi-agent-systems)、[Orchestration · Add specialists only when the contract changes](sources/openai/orchestration-and-handoffs.md#add-specialists-only-when-the-contract-changes)、[Building effective agents · When to use agents](sources/anthropic/building-effective-agents.md#when-and-when-not-to-use-agents)。

2. **按上下文边界拆，不按工种拆。** 已经掌握某份上下文的角色，接着做依赖这份上下文的下一步；同一件事的规划、实现、测试不拆给不同角色，否则信息每交接一次就丢一部分。可以拆开的边界有三类：互不相关的调研方向、接口清晰的组件、只看结果的验证。例：plan-cross-review 由核查过处置结论的 checker 接着写 plan。
   依据：[Multi-agent systems · Context-centric decomposition](sources/anthropic/building-multi-agent-systems-when-and-how.md#context-centric-decomposition)、[Multi-agent research system · Appendix](sources/anthropic/multi-agent-research-system.md#appendix)（"game of telephone"）。

3. **检查交给新 session，不让作者检查自己。** 作者评价自己的产出，倾向于放行。验证者只拿到完成标准、产物和原始材料，拿不到过程中的讨论；验证者只报告问题、不改产物，由作者按报告修改。
   依据：[Harness design · Why naive implementations fall short](sources/anthropic/harness-design-long-running-apps.md#why-naive-implementations-fall-short)、[Fable 5 · Recommended scaffolding changes](sources/anthropic/prompting-claude-fable-5.md#recommended-scaffolding-changes)（"fresh-context verifier subagents tend to outperform self-critique"）、[Claude Code · Run multiple Claude sessions](sources/anthropic/claude-code-best-practices.md#run-multiple-claude-sessions)、[Claude Code · Add an adversarial review step](sources/anthropic/claude-code-best-practices.md#add-an-adversarial-review-step)、[Multi-agent systems · The verification subagent pattern](sources/anthropic/building-multi-agent-systems-when-and-how.md#the-verification-subagent-pattern)。

4. **验证者的 prompt 逐项写明查什么、怎样算不通过，并且只让它报告影响正确性或既定要求的问题。** 只写"检查一下"，验证者会看几眼就放行；反过来，让它"找缺口"，即使工作没问题它也会报出一些，逐条追改会导致过度设计，所以其余意见标为可选。这和第一节第 2 条不冲突：验证本身就是验证者的任务。
   依据：[Multi-agent systems · The early victory problem](sources/anthropic/building-multi-agent-systems-when-and-how.md#the-early-victory-problem)、[Harness design · Running the harness](sources/anthropic/harness-design-long-running-apps.md#running-the-harness)（"Out of the box, Claude is a poor QA agent"）、[Claude Code · Add an adversarial review step](sources/anthropic/claude-code-best-practices.md#add-an-adversarial-review-step)。

5. **独立验证按需设置，同一作者的重复检查不设。** 任务超出模型单独可靠完成的范围时（长时间运行、大文档、需要跨多份来源保持一致），才加独立验证者；作者自查、自确认这类额外轮次一律删掉。
   依据：[Harness design · Removing the sprint construct](sources/anthropic/harness-design-long-running-apps.md#removing-the-sprint-construct)（"The practical implication is that the evaluator is not a fixed yes-or-no decision"）、[Opus 5 · Task scope and over-verification](sources/anthropic/prompting-claude-opus-5.md#task-scope-and-over-verification)（"The same applies to legacy harness scaffolding that adds separate verification steps"）、[Multi-agent systems · The verification subagent pattern](sources/anthropic/building-multi-agent-systems-when-and-how.md#the-verification-subagent-pattern)。

6. **评审先求全，再过滤。** 初审 prompt 不写严重度门槛，也不写"保守一点"，否则模型会照字面少报；过滤放到后面的质证或核查环节。
   依据：[Opus 5 · Capability improvements](sources/anthropic/prompting-claude-opus-5.md#capability-improvements)（Code review and bug-finding）。

7. **独立视角要真的不同，结论靠证据裁决。** 同一模型、相近上下文的多个 agent 会犯同样的错；讨论容易收敛到大家都知道的信息，只有一方掌握的关键事实会被忽略。多位 reviewer 的共识不等于证据；出现分歧时，交给一个独立角色按证据裁决，不靠多数票或协商。
   依据：[Multiagent systems research · Failures from conformity](sources/anthropic/multiagent-systems-patterns-and-problems.md#failures-from-conformity)、[Multiagent systems research · Epistemic failures](sources/anthropic/multiagent-systems-patterns-and-problems.md#epistemic-failures)。

8. **每个循环都写明收敛条件和轮数上限。** 自动续做或修订一般 2–3 轮；到上限就停，保留未决项和证据，不伪造通过。
   依据：[Opus 5.5 · Unattended agentic runs](sources/anthropic/prompting-claude-opus-5-5.md#unattended-agentic-runs)。

9. **只有必须由用户决定时才停下来问**，其余不受影响的工作继续推进；需要用户批准的事，先做到可以直接批准的程度。
   依据：[Fable 5 · Strong instruction following](sources/anthropic/prompting-claude-fable-5.md#strong-instruction-following)、[Fable 5.1 · Finish the whole task](sources/anthropic/prompting-claude-fable-5-1.md#finish-the-whole-task)（Delivering work）、[Using GPT-6 · Initiative and follow-through](sources/openai/using-gpt-6.md#initiative-and-follow-through)。

10. **每次都必须发生的动作，交给运行时或工具强制，不写成 prompt 规则。** 例如安装依赖、核验提交、校验来源 SHA。
    依据：[Claude Code · Set up hooks](sources/anthropic/claude-code-best-practices.md#set-up-hooks)（hooks 是确定执行的，说明文件里的指令只是建议）、[Harness engineering · Enforcing architecture and taste](sources/openai/harness-engineering.md#enforcing-architecture-and-taste)。

11. **跨 session 接续，默认在同一 session 里继续。** session 不可用时再开新的，交接依靠仓库、git 历史和进度记录。不要向模型展示剩余上下文额度，也不要用"你没有记忆、马上要交接"这类说法，这会诱发提前收尾。
    依据：[Harness design · The architecture](sources/anthropic/harness-design-long-running-apps.md#the-architecture)（新模型上去掉了 context reset）、[Fable 5 · Rare cases of context-budget concern](sources/anthropic/prompting-claude-fable-5.md#rare-cases-of-context-budget-concern)、[Prompting best practices · Long-horizon reasoning and state tracking](sources/anthropic/claude-prompting-best-practices.md#long-horizon-reasoning-and-state-tracking)、[Effective harnesses · Getting up to speed](sources/anthropic/effective-harnesses-for-long-running-agents.md#getting-up-to-speed)、[Long horizon tasks with Codex · Durable project memory](sources/openai/run-long-horizon-tasks-with-codex.md#the-key-idea-durable-project-memory)。

## 三、SKILL.md 与 description

1. **description 只写"做什么"和"什么时候用"。** 用用户实际会说的词作触发，越短越好；不堆同义词，也不把适用范围写得比实际宽。
   依据：[GPT-6 Astra · Better skills](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#better-skills)、[Skill authoring · Writing effective descriptions](sources/anthropic/skill-authoring-best-practices.md#writing-effective-descriptions)。

2. **SKILL.md 当路由用。** 每次都要用到的内容放正文；只在某些情况下才用到的放进 `references/`，正文只留一行指针，写清什么时候去读。正文控制在 500 行以内，字节预算只降不升。
   依据：[Skill authoring · Progressive disclosure patterns](sources/anthropic/skill-authoring-best-practices.md#progressive-disclosure-patterns)、[Skill authoring · Token budgets](sources/anthropic/skill-authoring-best-practices.md#token-budgets)、[GPT-6 Astra · Better skills](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#better-skills)、[Harness engineering · Repository knowledge as the system of record](sources/openai/harness-engineering.md#we-made-repository-knowledge-the-system-of-record)（"give Codex a map, not a 1,000-page instruction manual"）。

3. **默认模型已经很聪明，只写它不知道的：** 本仓库的约定、选择背后的原因、踩过的坑。
   依据：[Skill authoring · Concise is key](sources/anthropic/skill-authoring-best-practices.md#concise-is-key)、[Claude Code · Write an effective CLAUDE.md](sources/anthropic/claude-code-best-practices.md#write-an-effective-claudemd)。

4. **自由度与风险相匹配。** 调度控制面（派发、恢复、并发写入、交付核验）是"窄桥"，用精确的命令和运行时校验；执行端的实现、评审、写作是"开阔地"，只给目标，不给路线。
   依据：[Skill authoring · Set appropriate degrees of freedom](sources/anthropic/skill-authoring-best-practices.md#set-appropriate-degrees-of-freedom)。

5. **一个意思只写在一处；强调只留给确实被反复忽略的那一行。** 什么都强调，等于什么都没强调。
   依据：[Claude Code · Write an effective CLAUDE.md](sources/anthropic/claude-code-best-practices.md#write-an-effective-claudemd)、[Harness engineering · Repository knowledge as the system of record](sources/openai/harness-engineering.md#we-made-repository-knowledge-the-system-of-record)（"When everything is important, nothing is"）。

6. **执行端会读到的 Skill，也按本规范审。** 较新的模型对 Skill 和 AGENTS.md 里的指令更敏感，含糊或互相冲突的指令会让它提前停下；Skill 会被不同模型读到，要在所有会用它的模型上成立。
   依据：[Using GPT-6 · Instruction following](sources/openai/using-gpt-6.md#instruction-following)、[GPT-6 Astra · Better skills](sources/openai/rethinking-skills-and-prompts-for-gpt-6-astra.md#better-skills)、[Skill authoring · Test with all models you plan to use](sources/anthropic/skill-authoring-best-practices.md#test-with-all-models-you-plan-to-use)。

## 四、修改流程

按顺序做，前一步完成再做下一步：

1. **列出改动。** 新增或修改的每条指令、每个角色、每个步骤，逐一写出它弥补的是哪项模型不足，并对应到本规范的条目或原文章节。对应不上的不加。
2. **对照相关的旧内容。** 改动涉及的旧指令，逐条确认在当前模型上是否仍然需要，不需要的删掉。
3. **一次只拆一个组件。** 删减 pipeline 的角色或步骤时，每次只动一处，并在 [scheduling-optimization-backlog.md](../scheduling-optimization-backlog.md) 记下依据和下次运行要观察的数据。依据：[Harness design · Iterating on the harness](sources/anthropic/harness-design-long-running-apps.md#iterating-on-the-harness)。
4. **记录依据。** PR 描述或 backlog 引用本规范的条目。

完成标准：每条改动都能对应到本规范的条目或原文章节；不同模型的建议有冲突的地方，已改成对各模型都成立的写法；`node scripts/check-docs.mjs` 通过（它会校验本规范指向原文的每个锚点）。

## 五、更新本规范

厂商发布新模型或新的提示词指南时：按[原文清单](sources/README.md)里的方式抓取并整理新原文，存进 `sources/` 并更新清单；重新核对引用了变动原文的条目，与新原文冲突的改掉；然后按第四节把 SKILL.md 和各 pipeline 重新审一遍。原文存档只做格式整理（去掉站点组件和 HTML 残留），不改写内容。
