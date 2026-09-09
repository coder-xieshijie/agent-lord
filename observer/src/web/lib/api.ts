/** Browser-side API glue: token propagation and one-shot fetches.
 *
 * Task/overview sync lives in `sync.ts` (serial incremental polling). The
 * server still exposes the SSE `/stream` endpoint for compatibility, but this
 * client intentionally never opens it: long-lived EventSource connections pin
 * the browser's per-host HTTP/1.1 connection pool and block other pages.
 */

import type { FontCatalog, TimelineItem } from "../../shared/types";

export const token = new URLSearchParams(window.location.search).get("token") ?? "";

async function getJson<T>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function fetchFonts(): Promise<FontCatalog> {
  return getJson<FontCatalog>("/api/fonts");
}

/** Insert or replace one item, keeping the list sorted by ord. */
export function applyItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    const next = items.slice();
    next[index] = item;
    return next;
  }
  const next = items.slice();
  let at = next.length;
  while (at > 0 && next[at - 1].ord > item.ord) at -= 1;
  next.splice(at, 0, item);
  return next;
}
