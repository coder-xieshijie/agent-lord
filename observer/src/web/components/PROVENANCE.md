# 组件来源（vendored）

以下组件源码复制自 Vercel **ai-elements** 仓库（Apache-2.0）：

- 仓库：https://github.com/vercel/ai-elements
- 本地克隆：`/Users/minimax/code/github/ai-elements`
- 固定 commit：`6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`
- 许可证：Apache-2.0（见上游仓库 LICENSE）

## 文件对应

| 本仓库路径 | 上游路径 |
| --- | --- |
| `ai-elements/message.tsx` | `packages/elements/src/message.tsx` |
| `ai-elements/tool.tsx` | `packages/elements/src/tool.tsx` |
| `ai-elements/conversation.tsx` | `packages/elements/src/conversation.tsx` |
| `ai-elements/code-block.tsx` | `packages/elements/src/code-block.tsx` |
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

除上述改动外未修改任何逻辑。升级方式：在本地克隆中 `git fetch` 后按
上表重新复制并重放以上三类改动。
