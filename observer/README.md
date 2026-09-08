# Agent Lord 只读实时观察器（TypeScript）

对 Agent Lord 原生 exec 任务的**只读**实时网页观察：loopback + 访问令牌 +
显式 task allowlist，snapshot + `generation:seq` cursor + SSE（超窗/跨重启
显式 reset），三个 CLI provider（mcode / codex / claude）的流投影与
Codex App 的状态观察。前端为 React + vendored Vercel AI Elements 组件
（来源与许可见 `src/web/components/PROVENANCE.md`）。

## 命令

```bash
pnpm install --frozen-lockfile
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

`preview:start` 返回经过 HTTP 核验的 `running` JSON 和浏览器地址，可交给
Codex 的 `open_in_codex` browser target，或在普通浏览器打开。同配置重复启动
复用已有实例。`preview:restart` 保留端口、令牌和 allowlist；可显式传入新的
`--tasks` 更新观察范围。使用自定义 state-dir 时，后续管理命令也要传相同值。
启动失败返回非零退出码，不自动占用另一个端口。

服务只在静态页面、Hub 和监听端口就绪且元数据落盘后记录 `preview-ready`。
运行记录以 0600 原子写入，日志在 `<state>/observer/server-<port>.log`。
停止前核验访问令牌、实例 ID 与 PID；旧版记录、失配 PID 或其他服务不会被杀掉。
旧版服务需先人工核验进程归属并停止，再用新启动器接管原端口。重启关闭 SSE，
前端自动重新取 snapshot；旧 cursor 会显式 reset。

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

顶部“外观”提供主题、界面字体、代码字体三个下拉框。主题包含跟随系统、
浅色、深色、Nord、Dracula、Catppuccin、Solarized 浅/深色；偏好保存在本
浏览器的 localStorage，跟随系统会响应系统深浅切换，减少动态效果的系统
偏好也会生效。

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
