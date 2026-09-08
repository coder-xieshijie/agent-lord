/** Provider projector base: merge provider stream lines into timeline items
 * with stable source ids. */

import type { MessageItem, OmittedItem, ToolItem } from "../../shared/types.js";
import { clip, MESSAGE_CLIP } from "../sanitize.js";
import type { Timeline } from "../timeline.js";

export abstract class OpProjector {
  /** Native session id observed in the stream itself (evidence for resume). */
  observedSessionId: string | null = null;

  constructor(
    protected readonly timeline: Timeline,
    protected readonly opId: string,
  ) {}

  /** Handle one complete stdout line. Must never throw. */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.omitted("non-json-line");
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.omitted("non-object-line");
      return;
    }
    try {
      this.handleEvent(value as Record<string, unknown>);
    } catch {
      this.omitted("projector-error");
    }
  }

  protected abstract handleEvent(event: Record<string, unknown>): void;

  protected id(suffix: string): string {
    return `${this.opId}/${suffix}`;
  }

  private lifecycleCounter = 0;

  protected lifecycle(name: string, label: string, tsMs?: number): void {
    const id = this.id(`lifecycle/${name}/${this.lifecycleCounter++}`);
    this.timeline.upsert({ id, kind: "lifecycle", name, label, opId: this.opId, ord: 0, tsMs });
  }

  /** Aggregated marker for intentionally unrendered event types. */
  protected omitted(name: string): void {
    const id = this.id(`omitted/${name}`);
    const existing = this.timeline.get(id);
    const count = existing && existing.kind === "omitted" ? existing.count + 1 : 1;
    const item: OmittedItem = { id, kind: "omitted", name, count, opId: this.opId, ord: 0 };
    this.timeline.upsert(item);
  }

  protected appendMessage(messageId: string, delta: string, tsMs?: number): void {
    const id = this.id(`message/${messageId}`);
    const existing = this.timeline.get(id);
    const previous = existing && existing.kind === "message" ? existing.text : "";
    const item: MessageItem = {
      id,
      kind: "message",
      role: "assistant",
      text: clip(previous + delta, MESSAGE_CLIP),
      streaming: true,
      opId: this.opId,
      ord: 0,
      tsMs,
    };
    this.timeline.upsert(item);
  }

  /** Replace a message with its authoritative full text (dedupes partials). */
  protected finishMessage(messageId: string, fullText: string | undefined, tsMs?: number): void {
    const id = this.id(`message/${messageId}`);
    const existing = this.timeline.get(id);
    const text =
      fullText !== undefined
        ? clip(fullText, MESSAGE_CLIP)
        : existing && existing.kind === "message"
          ? existing.text
          : "";
    if (!text && !existing) return;
    this.timeline.upsert({
      id,
      kind: "message",
      role: "assistant",
      text,
      streaming: false,
      opId: this.opId,
      ord: 0,
      tsMs,
    });
  }

  protected upsertTool(toolId: string, patch: Partial<ToolItem> & { name?: string }): void {
    const id = this.id(`tool/${toolId}`);
    const existing = this.timeline.get(id);
    const base: ToolItem =
      existing && existing.kind === "tool"
        ? existing
        : { id, kind: "tool", name: patch.name ?? "tool", state: "running", opId: this.opId, ord: 0 };
    this.timeline.upsert({ ...base, ...patch, id, kind: "tool", opId: this.opId });
  }
}
