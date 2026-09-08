# Agent Lord 只读实时观察器（TypeScript）

对 Agent Lord 原生 exec 任务的**只读**实时网页观察：loopback + 访问令牌 +
显式 task allowlist，snapshot + `generation:seq` cursor + SSE（超窗/跨重启
显式 reset），三个 CLI provider（mcode / codex / claude）的流投影与
Codex App 的状态观察。前端为 React + vendored Vercel AI Elements 组件
（来源与许可见 `src/web/components/PROVENANCE.md`）。

## 命令

```bash
# 从仓库根目录安装并构建共享 core：
pnpm install --frozen-lockfile
pnpm --filter @agent-lord/core build
cd observer
pnpm typecheck      # server + web 两份 tsconfig
pnpm test           # vitest（fixtures 全部显式标记为 fixture-*）
pnpm build          # tsc → dist/server + vite → dist/web
pnpm preview:start --tasks task-a,task-b --port 8791
pnpm preview:status --port 8791
pnpm preview:restart --port 8791
pnpm preview:stop --port 8791
# 可选参数：--token T --state-dir DIR --web-root DIR --refresh-ms 1000
# 前台运行：pnpm start --tasks task-a,task-b --port 8791
# 开发：pnpm dev:server --tasks task-a,task-b + pnpm dev:web（vite 代理 /api）
```

Observer 仅从 `@agent-lord/core/contracts` 共享 provider 类型和标识符规则。
状态读取仍由自己的只读 reader 完成，不加载调度器或状态写入 API。

`preview:start` 返回经过 HTTP 核验的 `running` JSON 和浏览器地址，可交给
Codex 的 `open_in_codex` browser target，或在普通浏览器打开。同配置重复启动
复用已有实例。`preview:restart` 保留端口和令牌；省略 `--tasks` 时保留原
allowlist，显式传入时替换整个观察列表。使用自定义 state-dir 时，后续管理命令也要传相同值。
启动失败返回非零退出码，不自动占用另一个端口。

服务只在静态页面、Hub 和监听端口就绪且元数据落盘后记录 `preview-ready`。
运行记录以 0600 原子写入，日志在 `<state>/observer/server-<port>.log`。
停止前核验访问令牌、实例 ID 与 PID；旧版记录、失配 PID 或其他服务不会被杀掉。
旧版服务需先人工核验进程归属并停止，再用新启动器接管原端口。重启关闭 SSE，
前端自动重新取 snapshot；旧 cursor 会显式 reset。

## 派发后的任务绑定

Codex Desktop 的调用方按 [Skill 主流程](../SKILL.md#deterministic-loop) 接入观察页。
绑定沿用已派发的 `task_id`；只操作观察器和浏览器，不新增执行端点。

1. 使用本次会话已选定的端口和 state-dir 运行 `pnpm preview:status`；首次使用默认端口
   `8791`。本次任务集合来自已授权的派发或 pipeline，不扫描并公开其他任务。
2. 根据查询结果处理：
   - `stopped`：用 `pnpm preview:start --tasks <本次任务集合> --port <端口>` 启动。
   - `running` 且已包含本次全部任务：直接复用返回的地址。
   - `running` 但缺少本次任务：合并、去重已有 `record.tasks` 与本次任务集合，再用
     `pnpm preview:restart --tasks <合并后的完整集合> --port <端口>` 更新。保留旧任务、
     端口、令牌和其他已有配置；只有任务集合变化才重启。
   - `unverified` 或启动失败：说明观察页的具体问题，继续监督原执行端点；按生命周期规则
     核验实例身份后再处理，避免停止归属不明的进程。
3. 检查查询或启动结果为经 HTTP 核验的 `running`，且返回的任务列表包含本次全部任务。
   用 `open_in_codex` 的 browser target 打开返回的地址，复用已有匹配标签页，并选中本次任务。
4. 通过浏览器 UI 确认所选任务及其状态可见；pipeline 同时确认各任务均可在列表中选择。
   `open_in_codex` 返回 `queued` 只表示已请求打开，需继续检查已有标签页或用可用浏览器工具
   打开并核验。保留作为交付的标签页；若当前宿主无法显示或核验，明确报告该限制并提供本机链接，
   不把请求已发送或服务已就绪表述为页面已展示。

服务就绪、任务已绑定、页面已展示是分别核验的三个结果。派发控制器仍在准备任务记录时，
可先绑定已确定的 `task_id` 并打开页面；待记录出现后，在同一页面确认任务状态。
观察页失败不改变执行任务的成功、失败或恢复状态，原有 `checkpoint` 监督继续进行。

## 展示与核验

每个 allowlist 任务独立显示执行状态、时间线与原生续聊命令；切换任务读取它
自己的 snapshot/SSE。MCode 的活动工具依据生命周期维护，完成的工具不再
显示为等待中；失败时未完成的流明确标记缺少终态。恢复次数显示同会话续做的
已用次数与上限，网页本身不发起恢复。

“执行成功”与“声明的交付项已核验”分别展示。调度时可以传 `--require-file`
和 `--require-commit`，核验范围仅为非空文件和新的干净提交；未声明、缺文件、
历史记录分别如实显示。测试、UI 行为和内容正确性仍需实际验收。

### 阅读与外观

正文以助手消息为主；工具默认只显示名称与状态。连续三个及以上已完成工具
折叠为一组，分组不跨助手消息、执行轮次或其他事件。运行中、失败工具独立
可见；实时更新和任务切换保留手动展开状态。常规生命周期与成功记录收进
底部“执行记录”，错误、重连和历史缺失提示仍保留。展开工具可复制命令、
查看带高亮/行号的参数和 ANSI 日志；日志向上滚动时暂停跟随。

顶部“外观”提供主题、界面字体、代码字体及字号下拉选择。主题包含跟随系统、
浅色、深色、Nord、Dracula、Catppuccin、Solarized 浅/深色；偏好保存在本
浏览器的 localStorage，跟随系统会响应系统深浅切换，减少动态效果的系统
偏好也会生效。

界面字号可选 12–24 px（默认正文 14 px），代码字号可选 10–24 px（默认
12 px）。两者独立即时生效并自动保存；“恢复默认字号”只重置字号，保留
主题和字体。界面字号同步缩放文字、控件和间距；代码字号作用于 Markdown
代码、工具参数、日志及续聊命令。旧版外观设置自动补上默认字号。

`GET /api/fonts` 通过同一 token 门禁返回本机已安装字体族名称：macOS 调用
AppKit 的 `NSFontManager.availableFontFamilies`，Linux 使用 `fc-list`，
Windows 使用 PowerShell 的 InstalledFontCollection。固定命令异步执行，
超时 8 秒、结果缓存 30 秒，仅返回名称，不读取/传输字体文件；失败时可继续
使用系统默认字体。新安装字体在缓存过期后点“重新检测”即可。最终字形由浏览器
及其可访问的本地字体决定，缺失字形使用系统回退字体。跨系统实现有 mock
测试；当前桌面实际验证平台为 macOS。

测试统计、Git 变更及成果入口仍等待结构化数据接入，不从助手文本推断结果。

## 边界

- 纯只读：不调用 start/turn/check/checkpoint，不回写任何 task/operation/事件。
- 只绑定 127.0.0.1；每个请求都要求 token；只暴露 allowlist 内的任务。
- 不提供任意文件读取；stdout 路径必须位于 `<state>/logs/` 且属于对应操作。
- reasoning/thinking 内容永不输出；未知事件只以聚合"已省略"标记出现。
- 工具的选定参数、输出和错误会在折叠详情中展示，不是通用敏感信息脱敏器；
  仅供本机持令牌的用户查看，不要把包含私人任务的预览地址公开。
- 运行元数据写入 `<state>/observer/server-<port>.json`（observer 专属命名空间），
  不触碰调度器数据。
