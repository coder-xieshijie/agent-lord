/** Codex CLI `codex exec --json` projector.
 *
 * Real granularity: agent messages arrive as one `item.completed` (no
 * per-token deltas); command executions have started/completed with
 * aggregated_output + exit_code. Reasoning items are omitted with a marker.
 */

import { clip, clipTitle, MESSAGE_CLIP, toolInputText, toolOutputText, TOOL_TEXT_CLIP } from "../sanitize.js";
import { OpProjector } from "./common.js";

const LIFECYCLE: Record<string, string> = {
  "thread.started": "会话开始",
  "turn.started": "回合开始",
  "turn.completed": "回合结束",
};

export class CodexProjector extends OpProjector {
  protected handleEvent(event: Record<string, unknown>): void {
    if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
      this.observedSessionId = event.thread_id;
    }
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (LIFECYCLE[type]) {
      this.lifecycle(type, LIFECYCLE[type]);
      return;
    }
    if (type === "turn.failed") {
      const error = event.error;
      const message =
        error && typeof error === "object"
          ? (error as Record<string, unknown>).message
          : error;
      this.upsertTool("provider-error/turn.failed", {
        name: "回合失败",
        state: "error",
        errorText: typeof message === "string" ? clip(message, TOOL_TEXT_CLIP) : "turn.failed",
      });
      return;
    }
    if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") {
      this.omitted(type);
      return;
    }
    const item = event.item;
    if (item === null || typeof item !== "object") {
      this.omitted(type);
      return;
    }
    const record = item as Record<string, unknown>;
    const itemType = typeof record.type === "string" ? record.type : "unknown";
    const itemId = typeof record.id === "string" ? record.id : itemType;
    if (itemType === "agent_message") {
      if (type === "item.completed" && typeof record.text === "string" && record.text) {
        this.finishMessage(itemId, record.text);
      }
      return;
    }
    if (itemType === "reasoning") {
      if (type === "item.completed") this.omitted("reasoning（内容不展示）");
      return;
    }
    if (itemType === "command_execution") {
      const command = typeof record.command === "string" ? record.command : "";
      const exitCode = typeof record.exit_code === "number" ? record.exit_code : undefined;
      const done = type === "item.completed";
      const failed = done && exitCode !== undefined && exitCode !== 0;
      this.upsertTool(itemId, {
        name: "command",
        title: command ? clipTitle(command) : undefined,
        inputText: command ? clip(command, TOOL_TEXT_CLIP) : undefined,
        outputText: done ? toolOutputText(record.aggregated_output) : undefined,
        exitCode,
        state: done ? (failed ? "error" : "completed") : "running",
        errorText: failed ? `exit ${exitCode}` : undefined,
      });
      return;
    }
    if (itemType === "error") {
      this.upsertTool(`provider-error/${itemId}`, {
        name: "provider 错误",
        state: "error",
        errorText: typeof record.message === "string" ? clip(record.message, TOOL_TEXT_CLIP) : "error",
      });
      return;
    }
    if (itemType === "mcp_tool_call" || itemType === "web_search" || itemType === "file_change") {
      const done = type === "item.completed";
      const status = typeof record.status === "string" ? record.status : undefined;
      const failed = done && status === "failed";
      this.upsertTool(itemId, {
        name:
          itemType === "web_search"
            ? "web_search"
            : itemType === "file_change"
              ? "文件变更"
              : typeof record.tool === "string"
                ? String(record.tool)
                : itemType,
        title:
          typeof record.query === "string"
            ? clipTitle(String(record.query))
            : undefined,
        inputText: toolInputText(record.arguments ?? record.changes ?? record.query),
        outputText: done ? toolOutputText(record.result ?? record.results) : undefined,
        state: done ? (failed ? "error" : "completed") : "running",
        errorText: failed ? (status ?? "failed") : undefined,
      });
      return;
    }
    if (itemType === "todo_list") {
      // Plan updates are frequent and low-signal here; keep an honest marker.
      this.omitted("todo_list");
      return;
    }
    this.omitted(`${type}:${itemType}`);
  }

  protected override finishMessage(messageId: string, fullText: string | undefined, tsMs?: number): void {
    if (fullText === undefined) return;
    super.finishMessage(messageId, clip(fullText, MESSAGE_CLIP), tsMs);
  }
}
