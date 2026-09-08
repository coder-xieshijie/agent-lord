/** MCode CLI `mcode exec --output-format stream-json` projector.
 *
 * Verified fields (schemaVersion 1): sequence, timestampMs, type,
 * item.{id,type}, agent_message.contentDelta, tool_call.toolCall
 * {id,name,status(1=running,2=completed),input,output.content[].text,error}.
 */

import { toolInputText, toolOutputText, toolTitle } from "../sanitize.js";
import { OpProjector } from "./common.js";

const LIFECYCLE: Record<string, string> = {
  "exec.started": "执行开始",
  "session.started": "会话开始",
  "session.resumed": "会话已恢复",
  "turn.started": "回合开始",
  "turn.completed": "回合结束",
  "exec.completed": "执行结束",
};

export class McodeProjector extends OpProjector {
  protected handleEvent(event: Record<string, unknown>): void {
    if (typeof event.sessionId === "string" && event.sessionId) {
      this.observedSessionId = event.sessionId;
    }
    const type = typeof event.type === "string" ? event.type : "unknown";
    const tsMs = typeof event.timestampMs === "number" ? event.timestampMs : undefined;
    if (type === "exec.completed" || type === "turn.failed") this.finishPending();
    if (LIFECYCLE[type]) {
      this.lifecycle(type, LIFECYCLE[type], tsMs);
      return;
    }
    if (type === "turn.failed" || type === "exec.failed" || type === "error") {
      const detail = event.error ?? event.message;
      this.upsertTool(`provider-error/${type}`, {
        name: "provider 错误",
        state: "error",
        errorText: toolOutputText(detail) ?? type,
        tsMs,
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
    if (itemType === "agent_message") {
      const messageId = typeof record.id === "string" ? record.id : "message";
      const delta = record.contentDelta;
      if (typeof delta === "string" && delta) {
        this.appendMessage(messageId, delta, tsMs);
      }
      if (type === "item.completed") {
        const full = typeof record.content === "string" && record.content ? record.content : undefined;
        this.finishMessage(messageId, full, tsMs);
      }
      return;
    }
    if (itemType === "reasoning" || itemType === "thinking") {
      this.omitted("reasoning（内容不展示）");
      return;
    }
    if (itemType === "tool_call") {
      const call = record.toolCall;
      if (call === null || typeof call !== "object") {
        this.omitted("tool_call");
        return;
      }
      const callRecord = call as Record<string, unknown>;
      const toolId =
        typeof callRecord.id === "string" ? callRecord.id : typeof record.id === "string" ? record.id : "tool";
      const status = callRecord.status;
      const failed =
        callRecord.error !== undefined && callRecord.error !== null
          ? true
          : typeof status === "number" && status > 2;
      this.upsertTool(toolId, {
        name: typeof callRecord.name === "string" ? callRecord.name : undefined,
        title: toolTitle(callRecord.input),
        inputText: toolInputText(callRecord.input),
        outputText: toolOutputText(callRecord.output),
        errorText: failed ? (toolOutputText(callRecord.error) ?? "工具失败") : undefined,
        state: type === "item.completed" || status === 2 || failed ? (failed ? "error" : "completed") : "running",
        tsMs,
      });
      return;
    }
    this.omitted(`${type}:${itemType}`);
  }
}
