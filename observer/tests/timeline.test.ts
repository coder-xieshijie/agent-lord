import { describe, expect, it } from "vitest";
import { Timeline, PATCH_RING_LIMIT } from "../src/server/timeline.js";
import type { MessageItem } from "../src/shared/types.js";

function message(id: string, text: string): MessageItem {
  return { id, kind: "message", role: "assistant", text, streaming: false, ord: 0 };
}

describe("Timeline cursor semantics", () => {
  it("assigns stable ord and merges upserts by id", () => {
    const timeline = new Timeline();
    timeline.upsert(message("a", "one"));
    timeline.upsert(message("b", "two"));
    timeline.upsert(message("a", "one edited"));
    const items = timeline.snapshotItems();
    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
    expect((items[0] as MessageItem).text).toBe("one edited");
    expect(items[0].ord).toBeLessThan(items[1].ord);
    expect(timeline.lastSeq).toBe(3);
  });

  it("returns patches strictly after a cursor and empty at head", () => {
    const timeline = new Timeline();
    timeline.upsert(message("a", "one"));
    timeline.upsert(message("b", "two"));
    const patches = timeline.patchesAfter(1);
    expect(patches).not.toBeNull();
    expect(patches!.map((patch) => patch.item.id)).toEqual(["b"]);
    expect(timeline.patchesAfter(2)).toEqual([]);
  });

  it("signals an explicit reset for cursors outside the ring or future", () => {
    const timeline = new Timeline();
    for (let i = 0; i < PATCH_RING_LIMIT + 10; i += 1) {
      timeline.upsert(message(`m${i % 50}`, `text ${i}`));
    }
    expect(timeline.patchesAfter(1)).toBeNull(); // fell out of the ring
    expect(timeline.patchesAfter(timeline.lastSeq + 5)).toBeNull(); // future cursor
    expect(timeline.patchesAfter(timeline.lastSeq)).toEqual([]);
  });

  it("re-applying overlapping patches is idempotent for readers", () => {
    const timeline = new Timeline();
    timeline.upsert(message("a", "one"));
    timeline.upsert(message("a", "two"));
    const all = timeline.patchesAfter(0)!;
    // A reader that applies every patch by id ends with the latest state only.
    const store = new Map<string, string>();
    for (const patch of [...all, ...all]) {
      store.set(patch.item.id, (patch.item as MessageItem).text);
    }
    expect([...store.entries()]).toEqual([["a", "two"]]);
  });
});
