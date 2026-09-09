/** Frontend sync engine: serial incremental polling with request timeout,
 * failure backoff and background pause.
 *
 * Why polling instead of SSE by default: browsers cap concurrent HTTP/1.1
 * connections per host (typically 6). One long-lived EventSource per open
 * observer page pins the pool and blocks further page loads on the same host.
 * Short polling requests never hold a connection between ticks, so any number
 * of pages can observe the same service concurrently.
 *
 * Contract with the server (unchanged): `GET snapshot` returns the full
 * current timeline plus a `generation:seq` cursor; `GET delta?cursor=` returns
 * idempotent upsert patches after that cursor, or an explicit `{reset}` when
 * the cursor belongs to another server generation or fell out of the retained
 * patch window — in that case the client re-fetches the snapshot.
 *
 * This module deliberately has no window/document reference so the exact
 * production logic runs unmodified under Node in tests. Visibility is fed in
 * from the outside via `setVisible`; pausing is a resource optimisation only —
 * wrong visibility info can delay updates but never corrupts state, and no
 * long-lived connection is ever required to keep a page current.
 */

import type {
  DeltaResponse,
  OverviewResponse,
  ResetResponse,
  SnapshotResponse,
} from "../../shared/types";

/** Truthful sync status for the UI: what the polling loop is actually doing. */
export type SyncState = "loading" | "live" | "retrying" | "paused";

export interface PollerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SerialPollerOptions {
  /** Delay between a successful tick and the next one. */
  intervalMs: number;
  /** Abort a single request after this long; the failure then backs off. */
  requestTimeoutMs?: number;
  /** First retry delay after a failure; doubles per failure up to the max. */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  timers?: PollerTimers;
  onState?(state: SyncState): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MAX_MS = 15_000;

const realTimers: PollerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs one async tick at a time: the next tick is scheduled only after the
 * previous one settled, so slow responses can never pile up requests. */
export class SerialPoller {
  private readonly timers: PollerTimers;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly onState?: (state: SyncState) => void;

  private timer: unknown = null;
  private inflight: AbortController | null = null;
  private running = false;
  private disposed = false;
  private visible = true;
  private failures = 0;
  private everSucceeded = false;
  private state: SyncState | null = null;

  constructor(
    private readonly tick: (signal: AbortSignal) => Promise<void>,
    options: SerialPollerOptions,
  ) {
    this.timers = options.timers ?? realTimers;
    this.intervalMs = options.intervalMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.backoffInitialMs = options.backoffInitialMs ?? Math.max(options.intervalMs, 1000);
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.onState = options.onState;
  }

  start(): void {
    this.setState(this.everSucceeded ? "live" : "loading");
    this.runNow();
  }

  /** Feed page visibility. Hidden: stop scheduling (an in-flight request may
   * still settle and apply — harmless, idempotent). Visible: sync at once. */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.clearTimer();
      this.setState("paused");
      return;
    }
    this.setState(this.everSucceeded && !this.failures ? "live" : this.failures ? "retrying" : "loading");
    this.runNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.inflight?.abort();
    this.inflight = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setState(state: SyncState): void {
    if (this.disposed || this.state === state) return;
    this.state = state;
    this.onState?.(state);
  }

  private schedule(ms: number): void {
    if (this.disposed || !this.visible) return;
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.runNow();
    }, ms);
  }

  private runNow(): void {
    if (this.disposed || this.running || !this.visible) return;
    this.clearTimer();
    this.running = true;
    const controller = new AbortController();
    this.inflight = controller;
    const timeout = this.timers.setTimeout(() => controller.abort(), this.requestTimeoutMs);
    void this.tick(controller.signal)
      .then(() => {
        if (this.disposed) return;
        this.failures = 0;
        this.everSucceeded = true;
        if (this.visible) this.setState("live");
        this.schedule(this.intervalMs);
      })
      .catch(() => {
        if (this.disposed) return;
        this.failures += 1;
        if (this.visible) this.setState("retrying");
        this.schedule(
          Math.min(this.backoffInitialMs * 2 ** (this.failures - 1), this.backoffMaxMs),
        );
      })
      .finally(() => {
        this.timers.clearTimeout(timeout);
        if (this.inflight === controller) this.inflight = null;
        this.running = false;
      });
  }
}

export interface TaskTransport {
  snapshot(taskId: string, signal: AbortSignal): Promise<SnapshotResponse>;
  delta(taskId: string, cursor: string, signal: AbortSignal): Promise<DeltaResponse | ResetResponse>;
}

export interface ObserverTransport extends TaskTransport {
  overview(signal: AbortSignal): Promise<OverviewResponse>;
}

export interface TaskSyncHandlers {
  /** Full state replacement (initial load and every reset re-sync). */
  onSnapshot(snapshot: SnapshotResponse): void;
  /** Incremental patches; `task` present only when the metadata changed. */
  onDelta(delta: DeltaResponse): void;
  onState?(state: SyncState): void;
}

export interface TaskSyncOptions {
  intervalMs?: number;
  requestTimeoutMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  timers?: PollerTimers;
}

/** Incremental sync for one selected task: snapshot once, then serial delta
 * polling; server resets (restart / cursor beyond the retained window) trigger
 * an immediate re-snapshot inside the same tick. */
export class TaskSyncController {
  private readonly poller: SerialPoller;
  private cursor: string | null = null;
  private lastMetaJson = "";

  constructor(
    taskId: string,
    transport: TaskTransport,
    handlers: TaskSyncHandlers,
    options: TaskSyncOptions = {},
  ) {
    const applySnapshot = (snapshot: SnapshotResponse, signal: AbortSignal): void => {
      // A disposed controller must never touch handlers again: results that
      // arrive after a task switch would pollute the newly selected task.
      if (signal.aborted) return;
      this.cursor = snapshot.cursor;
      this.lastMetaJson = JSON.stringify(snapshot.task);
      handlers.onSnapshot(snapshot);
    };
    this.poller = new SerialPoller(
      async (signal) => {
        if (this.cursor === null) {
          applySnapshot(await transport.snapshot(taskId, signal), signal);
          return;
        }
        const result = await transport.delta(taskId, this.cursor, signal);
        if (signal.aborted) return;
        if ("reset" in result) {
          this.cursor = null;
          applySnapshot(await transport.snapshot(taskId, signal), signal);
          return;
        }
        this.cursor = result.cursor;
        const metaJson = result.task ? JSON.stringify(result.task) : this.lastMetaJson;
        const metaChanged = metaJson !== this.lastMetaJson;
        this.lastMetaJson = metaJson;
        if (result.patches.length || metaChanged) {
          handlers.onDelta({
            cursor: result.cursor,
            patches: result.patches,
            task: metaChanged ? result.task : undefined,
          });
        }
      },
      {
        intervalMs: options.intervalMs ?? 1000,
        requestTimeoutMs: options.requestTimeoutMs,
        backoffInitialMs: options.backoffInitialMs,
        backoffMaxMs: options.backoffMaxMs,
        timers: options.timers,
        onState: handlers.onState,
      },
    );
  }

  start(): void {
    this.poller.start();
  }

  setVisible(visible: boolean): void {
    this.poller.setVisible(visible);
  }

  dispose(): void {
    this.poller.dispose();
  }
}

/** Production HTTP transport. `baseUrl` is "" in the browser (same origin) and
 * an explicit `http://127.0.0.1:<port>` in Node-based tests. */
export function createHttpTransport(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): ObserverTransport {
  const getJson = async <T>(path: string, signal: AbortSignal): Promise<T> => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetchImpl(`${baseUrl}${path}${sep}token=${encodeURIComponent(token)}`, {
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    overview: (signal) => getJson<OverviewResponse>("/api/overview", signal),
    snapshot: (taskId, signal) =>
      getJson<SnapshotResponse>(`/api/tasks/${encodeURIComponent(taskId)}/snapshot`, signal),
    delta: (taskId, cursor, signal) =>
      getJson<DeltaResponse | ResetResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/delta?cursor=${encodeURIComponent(cursor)}`,
        signal,
      ),
  };
}
