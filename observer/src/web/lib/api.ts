/** Browser-side API client: token propagation, snapshot/delta fetch, SSE. */

import type {
  DeltaResponse,
  FontCatalog,
  OverviewResponse,
  ScheduleResponse,
  SnapshotResponse,
  TimelineItem,
} from "../../shared/types";

export const token = new URLSearchParams(window.location.search).get("token") ?? "";

async function getJson<T>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function fetchOverview(): Promise<OverviewResponse> {
  return getJson<OverviewResponse>("/api/overview");
}

export function fetchSchedule(): Promise<ScheduleResponse> {
  return getJson<ScheduleResponse>("/api/schedule");
}

export function fetchFonts(): Promise<FontCatalog> {
  return getJson<FontCatalog>("/api/fonts");
}

export function fetchSnapshot(taskId: string): Promise<SnapshotResponse> {
  return getJson<SnapshotResponse>(`/api/tasks/${encodeURIComponent(taskId)}/snapshot`);
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

export interface StreamHandlers {
  onDelta(delta: DeltaResponse): void;
  onReset(reason: string): void;
  onStateChange(state: "live" | "reconnecting"): void;
}

/** Open the task SSE stream. Returns a close function. */
export function openStream(taskId: string, cursor: string, handlers: StreamHandlers): () => void {
  const url = `/api/tasks/${encodeURIComponent(taskId)}/stream?cursor=${encodeURIComponent(
    cursor,
  )}&token=${encodeURIComponent(token)}`;
  const source = new EventSource(url);
  source.addEventListener("open", () => handlers.onStateChange("live"));
  source.addEventListener("delta", (event) => {
    try {
      handlers.onDelta(JSON.parse((event as MessageEvent).data) as DeltaResponse);
    } catch {
      // Ignore malformed frames; the next snapshot restores consistency.
    }
  });
  source.addEventListener("reset", (event) => {
    let reason = "服务端要求重新同步";
    try {
      reason = (JSON.parse((event as MessageEvent).data) as { reason?: string }).reason ?? reason;
    } catch {
      // keep default reason
    }
    source.close();
    handlers.onReset(reason);
  });
  source.addEventListener("error", () => {
    // A cursor from before reconnection may fall outside the ring; take the
    // safe path: close and let the app re-snapshot.
    handlers.onStateChange("reconnecting");
    source.close();
    handlers.onReset("连接中断，正在重新同步");
  });
  return () => source.close();
}
