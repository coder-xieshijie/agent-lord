# 组件来源（vendored）

以下组件源码复制自 Vercel **ai-elements** 仓库（Apache-2.0）：

- 仓库：https://github.com/vercel/ai-elements
- 本地克隆：`/Users/minimax/code/github/ai-elements`
- 固定 commit：`6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`
- 许可证：Apache-2.0，许可文本原样收录于
  [`observer/third-party-licenses/ai-elements.LICENSE.txt`](../../../third-party-licenses/ai-elements.LICENSE.txt)
  （复制自上游仓库根 `LICENSE`，Copyright 2023 Vercel, Inc.）。

许可核验说明（基于上述固定 commit）：上游仓库仅根目录 `LICENSE` 与
`packages/cli/LICENSE`（内容相同的 Apache-2.0 声明；CLI 包与本次 vendored
文件无关）；`packages/elements`、`packages/shadcn-ui` 无各自的 LICENSE 文件，
其 `package.json` 也未声明 `license` 字段，故根 `LICENSE` 覆盖全部 vendored
文件。上游无 NOTICE 或其他附加声明文件。

## 文件对应

| 本仓库路径 | 上游路径 |
| --- | --- |
| `ai-elements/message.tsx` | `packages/elements/src/message.tsx` |
| `ai-elements/tool.tsx` | `packages/elements/src/tool.tsx` |
| `ai-elements/conversation.tsx` | `packages/elements/src/conversation.tsx` |
| `ai-elements/code-block.tsx` | `packages/elements/src/code-block.tsx` |
| `ai-elements/terminal.tsx` | `packages/elements/src/terminal.tsx` |
| `ui/button.tsx` 等 shadcn 基础组件（button / button-group / tooltip / badge / collapsible / separator / select） | `packages/shadcn-ui/components/ui/*.tsx` |
| `../lib/utils.ts` | `packages/shadcn-ui/lib/utils.ts` |

## 本地改动（相对上游）

1. 导入别名改写：`@repo/shadcn-ui/components/ui/*` → `@/components/ui/*`，
   `@repo/shadcn-ui/lib/utils` → `@/lib/utils`（脱离上游 pnpm workspace）。
2. `message.tsx`：移除 `@streamdown/math` 与 `@streamdown/mermaid` 插件
   （observer 不需要数学公式/流程图渲染，减小构建体积），
   `streamdownPlugins` 相应改为 `{ cjk, code }`。
3. `tool.tsx`：状态徽标文案本地化为中文（Running→运行中 等），图标与
   结构不变。
4. `terminal.tsx`：为流式光标添加 `data-terminal-cursor`，供主题 CSS 单独着色。
   导入别名同第 1 项，ANSI 解析依赖 `ansi-to-react` 与上游保持在 6.x。

除上述改动外未修改任何逻辑。升级方式：在本地克隆中 `git fetch` 后按
上表重新复制并重放以上改动。

`tool-row.tsx` 是本项目的组合层：复用 Tool / CodeBlock / Terminal，替换
工具标题的排版并控制分组、折叠与日志跟随。运行文字的轻微流光由本项目 CSS
实现，响应 `prefers-reduced-motion`，没有引入上游 Shimmer 的 motion 依赖。
主题为参考 Nord / Dracula / Catppuccin / Solarized 常见配色的本地令牌预设，
不是对这些项目全部主题文件的复制。
