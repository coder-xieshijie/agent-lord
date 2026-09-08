# Agent Lord 只读实时观察器（TypeScript）

对 Agent Lord 原生 exec 任务的**只读**实时网页观察：loopback + 访问令牌 +
显式 task allowlist，snapshot + `generation:seq` cursor + SSE（超窗/跨重启
显式 reset），三个 CLI provider（mcode / codex / claude）的流投影与
Codex App 的状态观察。前端为 React + vendored Vercel AI Elements 组件
（来源与许可见 `src/web/components/PROVENANCE.md`）。

## 命令

```bash
pnpm install        # 依赖（带 lockfile）
pnpm typecheck      # server + web 两份 tsconfig
pnpm test           # vitest（fixtures 全部显式标记为 fixture-*）
pnpm build          # tsc → dist/server + vite → dist/web
pnpm start -- --tasks <task_id[,task_id…]> [--port 8791] [--token T] [--state-dir DIR]
# 开发： pnpm dev:server（tsx watch，端口 8791） + pnpm dev:web（vite，代理 /api）
```

## 边界

- 纯只读：不调用 start/turn/check/checkpoint，不回写任何 task/operation/事件。
- 只绑定 127.0.0.1；每个请求都要求 token；只暴露 allowlist 内的任务。
- 不提供任意文件读取；stdout 路径必须位于 `<state>/logs/` 且属于对应操作。
- reasoning/thinking 内容永不输出；未知事件只以聚合"已省略"标记出现。
- 运行元数据写入 `<state>/observer/server-<port>.json`（observer 专属命名空间），
  不触碰调度器数据。
