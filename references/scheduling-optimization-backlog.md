# 调度与 CLI 执行优化

记录日期：2026-09-23；更新：2026-09-28。本文记录一次 plan-to-implement 运行的耗时审计、据此做的修改，以及还没有结论的事项。

## 原则：做减法

给 worker 的限制越少越好。优先删除或纠正已经不需要的指令；需要每次都发生的动作交给运行时机制，不写成 prompt 规则；不给 worker 规定开发方法。

这与两家模型厂商当前的建议一致：

- Anthropic 的 [Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) 建议在模型能力提升后重新评估哪些指令和护栏还有必要，并指出为旧模型写的 prompt 和 skill 往往规定得太细，可能降低输出质量。
- OpenAI 的 [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) 以"每次编辑前先读 architecture.md、database.md、deployment.md"作为反面例子，说明按场景指向文档即可，并提醒测试类指令可能导致不必要的测试。
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices) 建议：模型不靠这条指令也能做对，就删掉它或改成钩子。

## 样本与主要发现

样本为 `goal-v2-7252-62e88814` 的 plan-to-implement 运行：MCode Fable 5 / high，业务仓库基线 `62e88814f55f01aec259607e3e6141b5f9fe74e3`，8 个模块。统计截止于 2026-09-23 10:54:43（Asia/Shanghai），当时 integrator 仍在修 CI。

- **CLI 数量：** 11 个会话、15 次执行，累计 17:53:28，实际历时 14:02:44。串行链为 `core → turn → domain → assembly → consumer → integrator`。
- **时间主要花在模型往返上：** 五个重点 worker 共 1,121 轮模型响应。工具执行时间只占各自总时间的 3%～21%；79%～91% 的轮次只发出一个工具调用。
- **每轮等待与同时运行的 worker 数有关：** 只统计输出不超过 500 token 的轮次，首个可见事件前的等待中位数在 1 个 worker 运行时约 10 秒，2～3 个 worker 同时运行时约 26 秒。同一个 turn 会话内，legacy 仍在运行时中位数 25.2 秒，legacy 结束后 12.5 秒。所有 worker 共用同一个网关和 key。这一条来自运行记录的统计；第 6 项的实验在 Opus 5.5 下没有复现，原因未定。
- **重复读取不是 token 的主要来源：** 五个 worker 读过的 147 个文件中，只有 5 个被两个以上 worker 读过，重复部分按整文件计约 12 万 token，占 1.149 亿输入 token 的约 0.1%；输入中 88.7% 命中缓存。合并 CLI 会让每轮重发的上下文变大，不会更省。
- **派发 prompt 要求"编辑前完整读完"**根目录与包级 AGENTS.md、91KB 的 plan.md、spec.md、ARCHITECTURE.md 和整个计划文件。turn 到第 62 分钟才第一次写代码。
- **lint 滞后：** storage、turn、domain 第一次真正运行 lint 分别在第 82、176、89 分钟，接近各自结束，之后各返工 15～20 分钟。storage 和 domain 的验证清单里写了 lint，照样拖到最后。
- **layout 检查指引写错：** 包级 AGENTS.md 指向检查器自己的单测，按文档执行不会扫描当前代码。turn 到第 164 分钟才发现，随后拆分文件。
- **新 worktree 没有依赖：** 五个 worker 都在第 43～105 分钟第一次验证时才发现 `tsc/tsgo: command not found`。
- **assembly 收尾多花约 30 分钟：** `gen:thrift` 附带改动了 owned_paths 之外的文件；修正时删掉它导致编译失败，续跑被 `SOURCE_MISMATCH` 拒绝，最后 `plan-reset` 再派替补会话。
- **Claude Code 子进程只有 200K 上下文：** 2026-09-25 的一次 plan-cross-review 运行中，Agent Lord 传的是 `claude-opus-5-5`。请求走网关时，Claude Code 无法确认网关支持 1M，没有 `[1m]` 后缀就按 200K 处理，结果压缩 12 次，约 29 分钟，写终稿那一轮压缩 9 次。实测通过同一网关时，`claude-fable-5[1m]`、`claude-opus-5[1m]`、`claude-opus-5-5[1m]` 的 `contextWindow` 都是 1,000,000，不带后缀的 `claude-opus-5` 是 200,000。
- **子 agent 模型说明有副作用：** Claude Code、Codex、MCode 的子 agent 默认都继承主 agent 的模型和 effort。派发说明要求写明模型后，MCode worker 调用子 agent 时每次都显式传模型，这会重置继承来的 effort；其中一次传了当前模型不支持的 effort，子任务失败。

## 修改与状态

| #   | 事项                  | 结果                                                                                                                                                                                   | 位置                                                                                              |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | layout 检查指引       | Agent-Archon 包级 AGENTS.md 的写法错误属于业务仓库自己的文档，不在 Agent Lord 范围内；原先放在 !7451 里，该 MR 已关闭，未修正                                                          | —                                                                                                 |
| 2   | 生成器输出越界        | planner 规则：模块的 `owned_paths` 包含它自己的命令会改写的文件                                                                                                                        | 已随旧的并行 plan-to-implement 删除                                                               |
| 3   | 子 agent 模型说明     | 删除固定约束中的模型句，以及"写明 endpoint 模型"的要求；只转达用户指定的模型或 effort                                                                                                  | [SKILL.md](../SKILL.md#scheduling-ownership)                                                      |
| 4   | 新 worktree 依赖      | Agent Lord 在新 endpoint 启动前按自己配置里的 `workspace_setup` 规则安装依赖：检出目录有 `pnpm-lock.yaml` 就执行 `pnpm install --frozen-lockfile --prefer-offline`。业务仓库不需要改动 | [protocol](protocol.md#workspace-setup)                                                           |
| 5   | "编辑前完整读完"      | 只有用户或命名流程要求时才要求完整阅读；其余只写明文档用途，由 endpoint 按需读                                                                                                         | [SKILL.md](../SKILL.md#task-context-preparation)                                                  |
| 6   | 网关并发实验          | 已完成：Opus 5.5 high 下并发 1～10 都没有排队或变慢。结果见下                                                                                                                          | —                                                                                                 |
| 7   | lint 时机             | 不改 prompt，不加钩子。原因见下                                                                                                                                                        | —                                                                                                 |
| 8   | 模块依赖              | planner 规则：只有离开另一模块已交付的代码就无法构建或验证时，才声明 `depends_on`                                                                                                      | 已随旧的并行 plan-to-implement 删除                                                               |
| 9   | effort 对照；TDD 试点 | 都不做。TDD 试点的原因见下                                                                                                                                                             | —                                                                                                 |
| 10  | `Run only ...` 限制   | 维护中的来源里没有这句，是调度方当时自己写的；SKILL.md 已规定验证方式由 CLI 决定，不需要再改                                                                                           | —                                                                                                 |
| 11  | 默认上下文窗口        | 只针对走网关的两类：Claude Code 对配置里列出的 1M 型号，没带窗口时自动补 `[1m]`，Fable 兜底同样适用；MCode 的窗口取自 MCode 配置，默认模型已是 1M。Codex CLI 走订阅，保持默认窗口      | [SKILL.md](../SKILL.md#provider-routing-and-defaults)、[protocol](protocol.md#execution-contract) |

**第 4 项的行为：** 只对 Agent Lord 管理的 worktree（`reuse-or-create`、`isolated`）的可写 `start` 执行；调用方直接指定的目录、只读任务和不匹配任何规则的仓库都不执行。`turn` 和同会话续跑不再执行；输出写入 `logs/<operation_id>.setup.log`。命令非零退出、超过 30 分钟，或改变 `git status --porcelain --untracked-files=normal` 的输出时，操作以 `SETUP_FAILED` 结束，不启动 provider；修好后重复同一个 `start` 即可。在 Agent-Archon 的全新 worktree 中，`pnpm install` 首次执行 24 秒，再次执行 2 秒，前后 Git 状态不变。最初的做法是让业务仓库提供 `.agent-lord/setup.sh`，这要求每个仓库为 Agent Lord 提交文件并经过评审，所以改为由 Agent Lord 按锁文件判断。遇到只装依赖不够的仓库时，再在配置里加规则。

**第 6 项网关并发实验：** 2026-09-25 北京时间 22:43～23:21，不经过 Agent Lord 和 MCode，用 MCode 的网关、key 和请求格式直接请求 `claude-opus-5-5`，effort 为 `high`。两组共 294 个请求，全部成功，没有报错或限流。

- 短提示（约 120 个输入 token，加随机前缀避免缓存）：并发度取 1、2、3、4、5、6、8、10，每种 6 轮，共 234 个请求，各并发度的运行顺序每轮随机打乱。各并发度的中位数：`message_start` 前等待 2.4～3.4 秒，生成速度每秒 74～79 个 token，总耗时 22.7～25.9 秒。并发 10 与并发 1 的差别都在 10% 以内，也没有随并发增加而变差的趋势。
- 长上下文（每个槽位先写入约 12.5 万 token 的不同源码缓存）：并发度取 1、3、6、10，每种 3 轮，60 个测量请求全部命中缓存。`message_start` 前等待中位数 5.3～6.0 秒，总耗时 7.9～8.5 秒。长上下文多出的约 3 秒与并发数无关。

这推翻了"网关对同一个 key 有并发限制"的推断，至少对 Opus 5.5 不成立。9 月 22 日每轮等待变长的原因未定：当时用的是 Fable 5；当时统计的是首个可见事件前的时间，包含不输出给客户端的思考；不同日子的负载也可能不同。另外，MCode 9 月 23 日的模型自检记录过网关返回 `HTTP 429: scheduler capacity exhausted`，说明网关在某些时段确实会拒绝请求。原始脚本和逐请求数据当时放在 `/tmp/gateway-exp/`，已被系统清理，上面的数字来自实验结束时的汇总。

**第 7 项不加钩子的原因：** MCode 的 `PostToolUse` 钩子来自插件或项目级 agent（`.harness/reins/`）。Agent Lord 派发的 worker 用 `mcode exec` 的默认 agent，仓库里放一个钩子文件不会对它生效；要生效就得安装插件或改 worker 的 agent 配置，改动更大，也会影响本机其他会话。下次运行先看 lint 首次执行的时间。

**第 9 项取消 TDD 试点的原因：** TDD 是在规定开发方法；业务仓库 AGENTS.md 明确不强制测试先行；这次的后期返工主要来自 lint、layout 和缺依赖，TDD 解决不了。

## 不做的事项

- **合并 CLI 以减少重复读取：** 见上面的 token 数据。
- **要求 worker 批量读取：** MCode 系统提示词已写明独立工具调用可以放在同一轮。Anthropic 文档记录了 Fable 5.1 在编码循环中可能每轮只发一个工具，给出的修法在 harness 层（每轮附一句提示），属于 MCode 本身的改动，不在 Agent Lord 范围内。
- **在派发 prompt 里规定 lint 时机、检查清单或阅读顺序。**
- **单独调整压缩：** 压缩次数多的根源是窗口只有 200K，见第 11 项。

## 下一次运行要看的数据

- 第一次写代码的时间（对照 turn 的 62 分钟）。
- 第一次运行 lint 和 layout 检查的时间。
- `SETUP_FAILED` 是否出现，以及 worker 是否还报缺依赖。
- 有没有模块因生成器输出越界而返工。
- 每轮首个可见事件前的等待，与同时运行的 worker 数对照。
