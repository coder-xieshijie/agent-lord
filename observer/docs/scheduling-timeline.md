# 调度时间线（Scheduling Timeline）

一个调度（caller）会话及其已授权子执行会话的同轴泳道视图。本文档是实现的
口径基准：数据来源、时间语义、已实现范围与真实限制以此为准。

## 方案概览

- **入口**：侧栏"调度会话"视图（现为默认视图，切换项顺序为"调度会话 → 执行
  会话"）中，每个调度分组提供"时间线"按钮，打开该分组的同轴时间线面板。
  面板显示在主区顶部，下方保留现有单任务详情/输出/流，两者可同时对照。
- **泳道**：主调度会话固定首行，按 Turn 分段（开始/结束/中止来自会话生命
  周期证据）；每个子执行会话（task）一条泳道，按首次派发时间稳定排列。同一
  task 的每个 operation 各自成段，轮与轮之间留空，天然表达并行与空档。
- **范围**：默认最近（或进行中）Turn；可切换任一历史 Turn 或"整个会话"。
  Turn 范围的右边界取 `max(Turn 结束, 该范围内操作的活动结束, 运行中→now)`，
  因此主调度先结束不会截断仍在运行的子任务。跨界段被裁剪并标注溢出方向。
- **交互**：悬停显示同一时刻对照竖线（带时间标签，贯穿所有泳道）；点击某个
  执行段选中它——选中后才绘制该段的派发/回执连线（避免拥挤），同时下方详情
  区切换到对应任务并滚动定位到该 operation 的请求行，请求/输出/产物照常
  可读、可下载。时间轴沿用现有主题与界面/代码字号变量。

## 数据来源与聚合接口

新增只读聚合接口 `GET /api/schedule`（同一 token 门禁），返回按**最初调度
会话**分组的全部 allowlist 任务的全量 operation 时间点。归属规则与侧栏
一致：首个 operation 记录的 caller session；后续其他会话续聊不迁移分组，
但该 operation 段上如实标注本轮真实调用者。

数据全部来自既有只读扫描循环，不新增全文流读取：

| 字段 | 证据来源 |
| --- | --- |
| operation 派发时间 | operation 记录 `created_at` |
| 执行端开始 | 控制平面 journal `operation-started` / `operation-continued` 的 `timestamp`（缺失时不显示，不用派发时间冒充） |
| 执行结束 | operation 记录 `completed_at`（终态时）；`observed.provider_completed_at_ms` 单独保留 |
| 产物可用 | journal `artifact-exported` 的 `timestamp`；缺失时回退 `completed_at` 并显式标记 `approx`（既有 `artifactReadyAtMs` 的口径即为该回退，本接口将两种口径区分开） |
| 调度收到结构化回执 | 调度会话 rollout 日志中匹配 `operation_id` 的结构化回执（`SUCCEEDED` / `ERROR` / `NEEDS_DECISION`），记录**接收时的活动 Turn**，因此支持跨 Turn 接收 |
| 主调度 Turn 开始/结束/中止 | 调度会话 rollout 日志 `task_started` / `task_complete` / `task_aborted`（session_meta 身份核验通过后才投影） |
| 派发 Turn 绑定 | `invocation.caller.turn_id`（`recorded`）；缺失时按创建时间落入 Turn 窗口推断（`inferred-by-create-time`，界面标注）；无法绑定为 `none` |
| 续做/重试 | `continuation.attempt`（既有 recovery 证据） |
| 并行计划 | operation `parallel_plan`（worker → integrator 的 all-of 结构化依赖） |

既有 `TaskMeta.timing.callerReceivedAtMs` 的口径（仅创建 Turn、仅
SUCCEEDED、且不早于产物就绪时间）保持不变以兼容现有页面；本接口的回执是
更完整的跨 Turn / 多状态口径，两者并存并在此说明。

## 时间语义与诚实性规则

- 全部时间点为证据落盘的 Unix ms；缺失即空，不用文件 mtime、轮询时间或
  推理填充。
- 段的起点是派发时间；有 `operation-started` 证据时段内单独标注执行端
  开始。终态缺 `completed_at` 时段保持开放并标注"结束时间未记录"。
- 运行中的段延伸到 now 并以动效区分——这只表示"尚未观测到终态"。
- `completed_at < created_at` 等时钟顺序异常不静默交换，段标注 anomaly。
- 执行结束、回执接收、交付核验（`delivery`，无独立时间戳，仅以徽标呈现，
  不伪造时间点）与主调度 Turn 结束是四个独立事实，分别展示；收到回执
  不代表调度方已分析结果。
- 依赖/等待只呈现结构化证据：`parallel_plan` 的 integrator 对 workers 的
  all-of 依赖、同 operation 的 continuation attempt 链。纯时间先后与输出
  空档不推断等待或因果。
- 调度会话生命周期不可核验（无 data_root、日志缺失、身份不符）时，主泳道
  只显示"Turn 证据不可用"的说明，子任务泳道退化为绝对时间轴（仅"整个
  会话"范围），不猜测 Turn 边界。
- 服务重启后 journal 与 operation 记录全量重放，聚合结果可重建；journal
  被截断/轮换时沿用既有 notice 机制并在时间点缺失处保持空。

## 已实现范围

- 服务端：`caller-lifecycle.ts` 增加 `sessionTimeline()`（Turn 列表 + 跨
  Turn、多状态回执索引；`observe()` 契约不变）；新增 `schedule.ts` 纯聚合
  器；`hub.ts` 保留每任务全量 operations 与 journal 时间点索引并提供
  `schedule()`；`http.ts` 增加 `/api/schedule`。
- 前端：侧栏切换项顺序改为"调度会话/执行会话"、默认调度会话（保留 task URL
  定位与选中分组自动展开）；`lib/schedule-timeline.ts` 纯布局（范围求解、
  分数坐标、裁剪、标记、选中连线）；`components/schedule-timeline.tsx`
  渲染面板（2s 轮询 `/api/schedule`、Turn 选择器、悬停竖线、点选定位）。
- 测试：聚合器（多子任务并行、同 session 多轮、跨 Turn 回执、首次归属与
  当前调用者不同、失败/续做、缺失时间、主调度先结束、重启重放）、生命周期
  回执扩展、布局库（默认范围、裁剪、开放段、异常标注、选中连线）、侧栏
  顺序与默认值。

## 真实限制（如实声明）

- **执行端开始时间**依赖 journal `operation-started` 事件；历史任务或未
  写入该事件的 provider 没有此时间点，界面上不显示"开始"标记。
- **等待耗时 / 关键路径**：当前状态文件没有"某 Turn 从 T1 等到 T2、等待
  对象为 X"的直接采集证据（回执时间只能证明"何时收到"，不能证明"从何时
  开始等"）。因此本实现不显示等待时长与关键路径；如需精确等待归因，需要
  调度端在派发/join 处落盘结构化等待事件（后续采集工作，不在本次范围）。
- **交付核验时间**：`delivery` 无时间戳，只显示核验状态徽标。
- **视觉验证边界**：交互与布局通过纯函数测试、fixtures 与认证 HTTP 验证；
  浏览器内的实际视觉效果未做自动化截图验证（本任务不使用浏览器自动化），
  需人工在预览页确认。
- 回执解析沿用既有 transport 解包器，只识别结构化 `operation_id` +
  状态字段；非结构化文本回执不计入。

## 验证结果

以下检查已于 2026-09-09 在本工作区实际执行并全部通过：

- `pnpm typecheck`（tsconfig.server.json + tsconfig.web.json，`--noEmit`）。
- `pnpm test`：14 个测试文件、72 个用例全绿，包含新增
  `tests/schedule.test.ts`（聚合器 + Hub journal 时间点重启重放）、
  `tests/schedule-timeline.test.ts`（范围/布局/连线纯函数）、以及
  `caller-lifecycle.test.ts`（sessionTimeline 跨 Turn 多状态回执）、
  `session-views.test.ts`（侧栏顺序/默认值）、`http.test.ts`
  （`/api/schedule` token 门禁与路径不泄露）的扩展用例。
- `pnpm build`（server tsc + vite build）产物可运行。
- 本地认证 HTTP 冒烟：以隔离 fixture state-dir 启动
  `node dist/server/main.js`，`/api/schedule` 无 token 返回 401，带 token
  返回聚合 JSON（含 journal `operation-started` 时间点、诚实的
  turnsNote），响应中不含 data_root 或任何绝对路径。
- 未验证：浏览器内实际视觉效果（见上节视觉验证边界）。
