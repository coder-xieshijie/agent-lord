# Agent Lord 只读实时观察器（TypeScript）

对 Agent Lord 原生 exec 任务的**只读**实时网页观察：loopback + 访问令牌 +
显式 task allowlist，snapshot + `generation:seq` cursor + 增量轮询（超窗/
跨重启显式 reset），三个 CLI provider（mcode / codex / claude）的流投影与
Codex App 的状态观察。前端为 React + vendored Vercel AI Elements 组件
（来源与许可见 `src/web/components/PROVENANCE.md`）。

## 默认同步方式：增量轮询

前端默认不再使用 SSE 长连接。浏览器对同一主机的 HTTP/1.1 并发连接有上限
（通常 6 条），每个观察页各占一条长连接会占满连接池、阻塞同主机的其他页面；
改为短请求增量轮询后，任意数量的页面可以同时观察同一服务。

- **前台**：选中任务约每秒拉取一次 `delta?cursor=`，只取新增内容；调度是
  串行的——上一个请求完成后才安排下一次，慢响应不会堆积请求。列表用
  2.5 秒的 overview 轮询，同样串行。
- **故障**：单个请求超时会被取消；失败按指数退避重试，成功后恢复正常间隔。
  服务重启或 cursor 失效/超出保留窗口时收到显式 reset，自动重取当前快照，
  历史截断提示如实保留。
- **后台**：页面隐藏时暂停任务与列表轮询（纯资源优化，不依赖可见性信息
  正确才可用）；恢复可见立即同步一次。正常完成的执行会话之后可能续聊，
  轮询不会永久停止观察它。
- **状态徽章**：显示真实轮询状态（同步中 / 增量轮询中 / 重试中 / 后台已暂停）。

服务端的 SSE `/stream` 接口保留以兼容旧页面，但默认前端不再连接它。
**升级后**：升级前已打开的旧页面仍运行旧 bundle（仍会开 SSE 长连接），
需要手动刷新一次才会切换到增量轮询。

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
pnpm preview:attach --tasks task-a,task-b --focus-task task-b --port 8791
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
旧版服务需先人工核验进程归属并停止，再用新启动器接管原端口。重启会更换
`generation`，前端轮询收到显式 reset 后自动重取 snapshot；升级运行代码后，
仍在运行旧 bundle 的已打开页面需手动刷新一次。

## 派发后的任务绑定

Codex Desktop 的调用方按 [Skill 主流程](../SKILL.md#deterministic-loop) 接入观察页。
绑定沿用已派发的 `task_id`，使用 CLI 和认证 HTTP；不使用或依赖 Computer Use / CUA，
也不以浏览器自动化作为失败后的兜底。

1. 使用本次会话选定的端口、state-dir 运行 `pnpm preview:attach --tasks <本次任务集合>
   --focus-task <目标任务> --port <端口>`。默认端口为 `8791`；任务集合来自已授权派发，
   不扫描并公开其他任务。不传 focus-task 时选择本次列表排序后的首个任务。
2. 命令复用或启动服务；只在新增绑定任务时合并 allowlist 并重启，保留原端口、令牌、
   web-root、refresh-ms 和 entrypoint。修改服务配置或升级运行代码使用显式 `preview:restart`。
   已有实例无法核验时返回失败，不停止或替换归属不明的服务；并发绑定遇到实例变化时重试绑定。
3. 返回 `binding_verified: true` 表示 health、overview 和本次各任务 snapshot 均已核验；
   `page_http_verified: true` 仅表示静态 HTML 可访问。`tasks[].available: false` 允许首轮操作
   尚未落盘，只证明该 task 已绑定，不代表执行已经开始。
4. 通过宿主 `open_in_codex` 链接接口请求打开返回的 URL 一次。页面读取 `task` 参数自动定位，
   无需点击；后续手动选择会更新 URL。目标不在列表时明确提示，不静默展示其他任务。
   `queued` 只报告“已请求打开”；无法打开时提供本机链接并继续监督。

同一任务的续聊、恢复和完成复用当前绑定，不再次打开或核验页面。只有任务集合变化或服务故障
才重新 attach。观察页失败不改变执行任务状态，原有 `checkpoint` 监督继续进行。

## 展示与核验

每个 allowlist 任务独立显示执行状态、时间线与原生续聊命令；切换任务读取它
自己的 snapshot 并增量轮询。MCode 的活动工具依据生命周期维护，完成的工具不再
显示为等待中；失败时未完成的流明确标记缺少终态。恢复次数显示同会话续做的
已用次数与上限，网页本身不发起恢复。

“本轮执行完成”、主调度状态与“声明的交付项已核验”分别展示。调度时可以传 `--require-file`
和 `--require-commit`，核验范围仅为非空文件和新的干净提交；未声明、缺文件、
历史记录分别如实显示。测试、UI 行为和内容正确性仍需实际验收。

详情完整展示请求模型、实际模型、推理档位和核验来源。MCode 的 xhigh 是 variant，
不是独立 effort；Codex 只有参数约束证据时，实际模型仍显示未回报。Claude fallback 显示实际模型。
最初调度者与本轮调用者分别来自首次和当前 operation.invocation，缺失时标为未记录。

每轮先显示用户原始请求（有记录时）、实际派发请求，再显示执行端输出。调度方补充和故障恢复
分别标注来源与原因。请求正文来自持久化记录，长文折叠但保留完整内容与复制能力。
历史 operation.message 可直接回放；不从整理过的 prompt 猜测用户原话。

主调度状态由同一个扫描循环只读匹配的 Codex Session/Turn 生命周期记录。按 invocation 中的
data-root 和 Session ID 定位唯一日志，再核验 session_meta；只投影开始、完成、中止事件及
匹配 operation 的结构化 SUCCEEDED 回执时间，不展示主会话正文或推理。Turn 缺失时按操作创建时间
绑定，跨 Turn、日志缺失或身份不符时显示未知。后续 Turn 开始不能代替当前 Turn 的结束证据。
时间点保存/返回 Unix ms；缺失项保持为空，不把轮询时间当成执行完成时间。

最终产物可在主调度回复前下载。下载接口要求同一令牌、任务 allowlist、精确 operation 绑定、
canonical artifact 路径和 SHA-256/字节数一致；不提供任意路径读取。

### 任务列表的两种视图

侧栏任务列表可在两种视图间切换，均按最近活动时间倒序（缺失时间的条目沉底，
顺序保持稳定）：

- **执行会话**：默认视图，逐个列出被调度的 CLI 执行会话（即 allowlist 任务）。
- **调度会话**：按发起调度的调用方会话分组。分组标题显示该调度会话的名称，
  下一行以文件夹图标显示其项目名称；点击分组展开它拉起的 CLI 执行会话，
  再点击子项查看既有详情与实时输出。分组按组内最新活动倒序，组内子列表同样倒序。

归属规则：任务归属于**最初拉起该 CLI 会话的调度会话**，即首个操作记录的
调用方 session_id；之后其他调度会话续做（turn/recovery）不会迁移分组，
本轮调用者仍在详情中以 initial/current 分别展示。首个操作没有调用方记录
的任务不从后来的操作推断最初拉起者，与完全无记录的历史任务一起集中在
"未记录调度会话"分组，保持可访问。

调度会话的名称来自其数据根的 `session_index.jsonl`（取最新条目），项目名称
来自该会话 rollout 日志 `session_meta` 中它自己的工作目录（仅暴露 basename，
完整路径与 data_root 不出服务端）；读取前核验 Session 身份，身份不符或数据
缺失时如实显示"未命名调度会话 / 项目未记录"，不用 session ID 或派发目标
目录冒充项目名。分组只重排已授权的 allowlist 任务，不扫描或暴露其他任务；
切换视图保留当前选中任务，所在分组自动展开。

### 阅读与外观

正文按每轮请求、助手消息的顺序展示；工具默认只显示名称与状态。连续三个及以上已完成工具
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
