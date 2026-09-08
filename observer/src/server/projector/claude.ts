/** Claude Code CLI `claude -p --output-format stream-json` projector.
 *
 * Handles both granularities without duplication:
 * - `stream_event` partial messages (message_start / content_block_delta /
 *   message_stop) merge deltas into a message item keyed by message.id;
 * - the full `assistant` event with the same message.id replaces the merged
 *   text authoritatively and creates tool items from tool_use blocks;
 * - `user` tool_result blocks close the matching tool item by tool_use_id.
 * Thinking blocks are omitted with a content-free marker.
 */

import { clip, MESSAGE_CLIP, toolInputText, toolOutputText, toolTitle } from "../sanitize.js";
import { OpProjector } from "./common.js";

export class ClaudeProjector extends OpProjector {
  /** message.id currently streaming via stream_event, by content block index. */
  private streamingMessageId: string | null = null;

  protected handleEvent(event: Record<string, unknown>): void {
    if (typeof event.session_id === "string" && event.session_id) {
      this.observedSessionId = event.session_id;
    }
    const type = typeof event.type === "string" ? event.type : "unknown";
    switch (type) {
      case "system":
        this.handleSystem(event);
        return;
      case "stream_event":
        this.handleStreamEvent(event);
        return;
      case "assistant":
        this.handleAssistant(event);
        return;
      case "user":
        this.handleUser(event);
        return;
      case "result":
        this.handleResult(event);
        return;
      default:
        this.omitted(type);
    }
  }

  private handleSystem(event: Record<string, unknown>): void {
    const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
    if (subtype === "init") {
      this.lifecycle("system.init", "会话开始");
      return;
    }
    this.omitted(`system:${subtype}`);
  }

  private handleStreamEvent(outer: Record<string, unknown>): void {
    const event = outer.event;
    if (event === null || typeof event !== "object") {
      this.omitted("stream_event");
      return;
    }
    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "unknown";
    if (type === "message_start") {
      const message = record.message;
      const id =
        message && typeof message === "object" && typeof (message as Record<string, unknown>).id === "string"
          ? ((message as Record<string, unknown>).id as string)
          : null;
      this.streamingMessageId = id;
      return;
    }
    if (type === "content_block_delta") {
      const delta = record.delta;
      if (delta && typeof delta === "object") {
        const deltaRecord = delta as Record<string, unknown>;
        if (deltaRecord.type === "text_delta" && typeof deltaRecord.text === "string" && this.streamingMessageId) {
          this.appendMessage(this.streamingMessageId, deltaRecord.text);
        }
        // thinking_delta / input_json_delta are intentionally not rendered.
      }
      return;
    }
    if (type === "message_stop") {
      if (this.streamingMessageId) this.finishMessage(this.streamingMessageId, undefined);
      this.streamingMessageId = null;
      return;
    }
    // content_block_start/stop, message_delta, ping … carry no displayable text.
  }

  private handleAssistant(event: Record<string, unknown>): void {
    const message = event.message;
    if (message === null || typeof message !== "object") {
      this.omitted("assistant");
      return;
    }
    const record = message as Record<string, unknown>;
    const messageId = typeof record.id === "string" ? record.id : "message";
    const content = Array.isArray(record.content) ? record.content : [];
    const textParts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const blockRecord = block as Record<string, unknown>;
      const blockType = blockRecord.type;
      if (blockType === "text" && typeof blockRecord.text === "string" && blockRecord.text) {
        textParts.push(blockRecord.text);
      } else if (blockType === "tool_use") {
        const toolId = typeof blockRecord.id === "string" ? blockRecord.id : `tool-${this.opId}`;
        this.upsertTool(toolId, {
          name: typeof blockRecord.name === "string" ? blockRecord.name : "tool",
          title: toolTitle(blockRecord.input),
          inputText: toolInputText(blockRecord.input),
          state: "running",
        });
      } else if (blockType === "thinking" || blockType === "redacted_thinking") {
        this.omitted("thinking（内容不展示）");
      }
    }
    if (textParts.length) {
      this.finishMessage(messageId, clip(textParts.join("\n\n"), MESSAGE_CLIP));
    } else if (this.streamingMessageId === messageId) {
      this.finishMessage(messageId, undefined);
    }
    if (this.streamingMessageId === messageId) this.streamingMessageId = null;
  }

  private handleUser(event: Record<string, unknown>): void {
    const message = event.message;
    if (message === null || typeof message !== "object") return;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const blockRecord = block as Record<string, unknown>;
      if (blockRecord.type !== "tool_result") continue;
      const toolUseId = typeof blockRecord.tool_use_id === "string" ? blockRecord.tool_use_id : null;
      const isError = blockRecord.is_error === true;
      if (!toolUseId) continue;
      this.upsertTool(toolUseId, {
        state: isError ? "error" : "completed",
        outputText: isError ? undefined : toolOutputText(blockRecord.content),
        errorText: isError ? (toolOutputText(blockRecord.content) ?? "工具失败") : undefined,
      });
    }
  }

  private handleResult(event: Record<string, unknown>): void {
    const isError = event.is_error === true;
    this.timeline.upsert({
      id: this.id("final"),
      kind: "final",
      ok: !isError,
      // The success-path result text repeats the final assistant message, so
      // only surface it when the turn errored.
      summary:
        isError && typeof event.result === "string" && event.result
          ? clip(event.result, MESSAGE_CLIP)
          : undefined,
      durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
      opId: this.opId,
      ord: 0,
    });
  }
}
