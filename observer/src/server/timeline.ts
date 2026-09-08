/** Per-task timeline: id-stable upserts with a monotonic patch sequence.
 *
 * Cursor semantics (explicit, verifiable):
 * - `generation` identifies one server process + scan history. A cursor from
 *   another generation cannot be replayed and yields an explicit reset.
 * - `seq` is the last applied patch. Patches are retained in a bounded ring;
 *   a cursor older than the ring start yields an explicit reset (no silent
 *   gap). Upserts are idempotent by item id, so overlap on reconnect only
 *   re-applies the same item state.
 */

import type { Patch, TimelineItem } from "../shared/types.js";

export const PATCH_RING_LIMIT = 4000;
export const ITEM_LIMIT = 1500;

export class Timeline {
  private readonly items = new Map<string, TimelineItem>();
  private order: string[] = [];
  private patches: Patch[] = [];
  private nextOrd = 1;
  private seq = 0;
  private truncated = false;

  get lastSeq(): number {
    return this.seq;
  }

  get truncatedHistory(): boolean {
    return this.truncated;
  }

  allocOrd(): number {
    return this.nextOrd++;
  }

  get(id: string): TimelineItem | undefined {
    return this.items.get(id);
  }

  /** Insert or replace an item; emits one patch. New items get an ord unless
   * the caller pre-allocated one. */
  upsert(item: TimelineItem): void {
    const existing = this.items.get(item.id);
    if (existing) {
      item.ord = existing.ord;
    } else {
      if (!item.ord) item.ord = this.nextOrd++;
      else if (item.ord >= this.nextOrd) this.nextOrd = item.ord + 1;
      this.order.push(item.id);
      if (this.order.length > ITEM_LIMIT) {
        const dropped = this.order.splice(0, this.order.length - ITEM_LIMIT);
        for (const id of dropped) this.items.delete(id);
        this.truncated = true;
      }
    }
    this.items.set(item.id, item);
    this.seq += 1;
    this.patches.push({ seq: this.seq, type: "upsert", item });
    if (this.patches.length > PATCH_RING_LIMIT) {
      this.patches.splice(0, this.patches.length - PATCH_RING_LIMIT);
    }
  }

  snapshotItems(): TimelineItem[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((item): item is TimelineItem => Boolean(item))
      .sort((a, b) => a.ord - b.ord);
  }

  /** Patches strictly after `afterSeq`, or null when the ring no longer
   * reaches back that far (caller must reset). */
  patchesAfter(afterSeq: number): Patch[] | null {
    if (afterSeq > this.seq) return null;
    if (afterSeq === this.seq) return [];
    const first = this.patches.length ? this.patches[0].seq : this.seq + 1;
    if (afterSeq < first - 1) return null;
    return this.patches.filter((patch) => patch.seq > afterSeq);
  }
}
