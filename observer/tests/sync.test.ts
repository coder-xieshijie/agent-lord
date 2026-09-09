/** Frontend sync engine tests.
 *
 * Two layers:
 * 1. Deterministic unit tests with injected fake timers/transport for the
 *    mechanisms themselves: serial scheduling (no request pile-up), request
 *    timeout + exponential backoff + recovery, hidden/visible pause-resume,
 *    dispose vs late results, reset-driven re-snapshot, meta dedup.
 * 2. Integration tests running the exact production sync classes
 *    (TaskSyncController + createHttpTransport) as 10 concurrent clients
 *    against a real HTTP observer server, including a server restart with a
 *    new generation and the read-only token gate. This exercises the real
 *    network path in Node, not a browser — browser connection-pool behaviour
 *    is addressed by design (no held connections), not measured here.
 */

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../src/server/hub.js";
import { createObserverServer } from "../src/server/http.js";
import {
  createHttpTransport,
  SerialPoller,
  TaskSyncController,
  type PollerTimers,
  type SyncState,
  type TaskTransport,
} from "../src/web/lib/sync.js";
import type {
  DeltaResponse,
  ResetResponse,
  SnapshotResponse,
  TaskMeta,
  TimelineItem,
} from "../src/shared/types.js";

const j = (value: unknown): string => JSON.stringify(value);
const TOKEN = "fixture-token";
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/* ------------------------------------------------------------------ */
/* Fakes                                                              */
/* ------------------------------------------------------------------ */

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeTimers implements PollerTimers {
  now = 0;
  private queue: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ at: this.now + ms, fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((entry) => entry.id !== handle);
  }

  /** Advance fake time, firing due timers in order and flushing microtasks
   * between them so async tick chains settle deterministically. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await flush(); // settle async tick chains that may schedule new timers
      const due = [...this.queue]
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue.splice(this.queue.indexOf(due), 1);
      this.now = due.at;
      due.fn();
    }
    this.now = target;
    await flush();
  }
}

function meta(over: Partial<TaskMeta> = {}): TaskMeta {
  return { taskId: "fixture-task", status: "运行中", ...over } as TaskMeta;
}

function snap(cursor: string, over: Partial<SnapshotResponse> = {}): SnapshotResponse {
  return { generation: "g", cursor, task: meta(), items: [], truncatedHistory: false, ...over };
}

function delta(cursor: string, over: Partial<DeltaResponse> = {}): DeltaResponse {
  return { cursor, patches: [], task: meta(), ...over };
}

interface Recorded {
  snapshots: SnapshotResponse[];
  deltas: DeltaResponse[];
  states: SyncState[];
}

function makeController(
  transport: TaskTransport,
  timers: FakeTimers,
  options: { intervalMs?: number; requestTimeoutMs?: number; backoffInitialMs?: number; backoffMaxMs?: number } = {},
): { controller: TaskSyncController; recorded: Recorded } {
  const recorded: Recorded = { snapshots: [], deltas: [], states: [] };
  const controller = new TaskSyncController(
    "fixture-task",
    transport,
    {
      onSnapshot: (s) => recorded.snapshots.push(s),
      onDelta: (d) => recorded.deltas.push(d),
      onState: (state) => recorded.states.push(state),
    },
    { intervalMs: 100, backoffInitialMs: 100, backoffMaxMs: 400, timers, ...options },
  );
  cleanups.push(() => controller.dispose());
  return { controller, recorded };
}

/* ------------------------------------------------------------------ */
/* Unit: mechanisms                                                   */
/* ------------------------------------------------------------------ */

describe("TaskSyncController mechanisms", () => {
  it("polls serially: a slow response never piles up further requests", async () => {
    const timers = new FakeTimers();
    let deltaCalls = 0;
    let releaseDelta: (() => void) | null = null;
    const transport: TaskTransport = {
      snapshot: async () => snap("g:1"),
      delta: (_t, _c) => {
        deltaCalls += 1;
        return new Promise((resolve) => {
          releaseDelta = () => resolve(delta("g:1"));
        });
      },
    };
    const { controller, recorded } = makeController(transport, timers);
    controller.start();
    await flush();
    expect(recorded.snapshots).toHaveLength(1);
    await timers.advance(100); // first delta goes out
    expect(deltaCalls).toBe(1);
    // The response hangs for a long stretch of virtual time (beyond the
    // request timeout is tested separately; here we release before timeout is
    // irrelevant since default timeout is 10s of fake time).
    await timers.advance(5000);
    expect(deltaCalls).toBe(1); // nothing piled up while in flight
    releaseDelta!();
    await flush();
    await timers.advance(100); // next tick only after the previous settled
    expect(deltaCalls).toBe(2);
  });

  it("aborts a timed-out request, backs off exponentially, and recovers to the normal interval", async () => {
    const timers = new FakeTimers();
    const deltaStarts: number[] = [];
    let healthy = false;
    const transport: TaskTransport = {
      snapshot: async () => snap("g:1"),
      delta: (_t, _c, signal) => {
        deltaStarts.push(timers.now);
        if (healthy) return Promise.resolve(delta("g:2"));
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    };
    const { controller, recorded } = makeController(transport, timers, { requestTimeoutMs: 50 });
    controller.start();
    await flush();
    // t=100 first delta; timeout at t=150; retries with backoff 100, 200, 400 (capped).
    await timers.advance(2000);
    expect(deltaStarts.length).toBeGreaterThanOrEqual(4);
    const gaps = deltaStarts.slice(1).map((at, i) => at - deltaStarts[i]);
    // Each gap = 50ms timeout + backoff(100 * 2^n, capped at 400).
    expect(gaps.slice(0, 3)).toEqual([150, 250, 450]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(450); // capped
    expect(recorded.states).toContain("retrying");
    // Recovery: server healthy again → success restores the normal interval.
    healthy = true;
    const before = deltaStarts.length;
    await timers.advance(1000);
    const healthyGaps = deltaStarts.slice(before + 1).map((at, i) => at - deltaStarts[before + i]);
    expect(healthyGaps.every((gap) => gap === 100)).toBe(true);
    expect(recorded.states[recorded.states.length - 1]).toBe("live");
  });

  it("pauses scheduling while hidden and re-syncs immediately on visible", async () => {
    const timers = new FakeTimers();
    let deltaCalls = 0;
    const transport: TaskTransport = {
      snapshot: async () => snap("g:1"),
      delta: async () => {
        deltaCalls += 1;
        return delta("g:1");
      },
    };
    const { controller, recorded } = makeController(transport, timers);
    controller.start();
    await timers.advance(250);
    const callsWhileVisible = deltaCalls;
    expect(callsWhileVisible).toBeGreaterThan(0);
    controller.setVisible(false);
    expect(recorded.states[recorded.states.length - 1]).toBe("paused");
    await timers.advance(10_000);
    expect(deltaCalls).toBe(callsWhileVisible); // no requests in background
    controller.setVisible(true);
    await flush();
    expect(deltaCalls).toBe(callsWhileVisible + 1); // immediate, not after interval
    expect(recorded.states[recorded.states.length - 1]).toBe("live");
  });

  it("drops late results after dispose so they cannot pollute the next task", async () => {
    const timers = new FakeTimers();
    let releaseDelta: (() => void) | null = null;
    const transport: TaskTransport = {
      snapshot: async () => snap("g:1"),
      delta: (_t, _c) =>
        new Promise((resolve) => {
          releaseDelta = () =>
            resolve(
              delta("g:9", {
                patches: [
                  { seq: 9, type: "upsert", item: { id: "late", kind: "notice", text: "迟到", ord: 9 } },
                ],
              }),
            );
        }),
    };
    const { controller, recorded } = makeController(transport, timers);
    controller.start();
    await flush();
    await timers.advance(100); // delta in flight
    controller.dispose();
    releaseDelta!(); // settles after dispose
    await flush();
    await timers.advance(1000);
    expect(recorded.deltas).toHaveLength(0);
    expect(recorded.snapshots).toHaveLength(1); // only the pre-dispose snapshot
  });

  it("re-snapshots on reset and faithfully passes truncatedHistory through", async () => {
    const timers = new FakeTimers();
    let snapshotCalls = 0;
    let deltaCalls = 0;
    const transport: TaskTransport = {
      snapshot: async () => {
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? snap("g:1")
          : snap("h:5", { generation: "h", truncatedHistory: true });
      },
      delta: async (): Promise<DeltaResponse | ResetResponse> => {
        deltaCalls += 1;
        if (deltaCalls === 1) return { reset: true, reason: "cursor 属于其他服务实例" };
        return delta("h:5");
      },
    };
    const { controller, recorded } = makeController(transport, timers);
    controller.start();
    await timers.advance(100); // delta → reset → snapshot, same tick
    expect(snapshotCalls).toBe(2);
    expect(recorded.snapshots).toHaveLength(2);
    expect(recorded.snapshots[1].truncatedHistory).toBe(true);
    await timers.advance(100);
    expect(deltaCalls).toBe(2); // next delta uses the fresh cursor, no loop
  });

  it("suppresses empty deltas with unchanged metadata", async () => {
    const timers = new FakeTimers();
    let deltaCalls = 0;
    const stable = meta();
    const transport: TaskTransport = {
      snapshot: async () => snap("g:1", { task: stable }),
      delta: async () => {
        deltaCalls += 1;
        return deltaCalls < 3
          ? delta("g:1", { task: { ...stable } })
          : delta("g:1", { task: meta({ status: "已完成" }) });
      },
    };
    const { controller, recorded } = makeController(transport, timers);
    controller.start();
    await timers.advance(300);
    expect(deltaCalls).toBe(3);
    expect(recorded.deltas).toHaveLength(1); // only the real metadata change
    expect(recorded.deltas[0].task?.status).toBe("已完成");
  });
});

/* ------------------------------------------------------------------ */
/* Integration: production sync logic against a real HTTP server      */
/* ------------------------------------------------------------------ */

function makeFixture(): { root: string; taskId: string; stdout: string; hub: Hub } {
  const root = mkdtempSync(path.join(tmpdir(), "observer-sync-fixture-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "operations"), { recursive: true });
  mkdirSync(path.join(root, "logs"), { recursive: true });
  mkdirSync(path.join(root, "events"), { recursive: true });
  const taskId = "fixture-task-sync";
  const stdout = path.join(root, "logs", "fixture-op-sync.stdout");
  writeFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "初始" } })}\n`);
  writeFileSync(
    path.join(root, "operations", "fixture-op-sync.json"),
    j({
      operation_id: "fixture-op-sync",
      task_id: taskId,
      provider: "codex-cli",
      status: "running",
      created_at: "2026-09-08T10:00:00Z",
      stdout_path: stdout,
    }),
  );
  const hub = new Hub([taskId], root);
  hub.refresh();
  return { root, taskId, stdout, hub };
}

async function listen(hub: Hub, port = 0): Promise<{ base: string; port: number; server: Server }> {
  const server = createObserverServer({ hub, token: TOKEN, webRoot: null, port });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  cleanups.push(() => server.close());
  const actual = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${actual}`, port: actual, server };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface LiveClient {
  items: Map<string, TimelineItem>;
  states: SyncState[];
  snapshots: number;
  controller: TaskSyncController;
}

function startClient(base: string, taskId: string, token: string): LiveClient {
  const transport = createHttpTransport(base, token);
  const client: LiveClient = { items: new Map(), states: [], snapshots: 0, controller: null! };
  client.controller = new TaskSyncController(
    taskId,
    transport,
    {
      onSnapshot(snapshot) {
        client.snapshots += 1;
        client.items = new Map(snapshot.items.map((item) => [item.id, item]));
      },
      onDelta(d) {
        for (const patch of d.patches) client.items.set(patch.item.id, patch.item);
      },
      onState: (state) => client.states.push(state),
    },
    { intervalMs: 50, backoffInitialMs: 50, backoffMaxMs: 200 },
  );
  cleanups.push(() => client.controller.dispose());
  client.controller.start();
  return client;
}

const hasText = (client: LiveClient, text: string): boolean =>
  [...client.items.values()].some((item) => item.kind === "message" && item.text.includes(text));

describe("production sync against a real HTTP server", () => {
  it("keeps 10 concurrent polling clients current without held connections", async () => {
    const { hub, taskId, stdout } = makeFixture();
    const { base } = await listen(hub);
    const clients = Array.from({ length: 10 }, () => startClient(base, taskId, TOKEN));
    await waitFor(() => clients.every((c) => c.snapshots >= 1), "所有客户端完成首次快照");
    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "并发广播" } })}\n`);
    hub.refresh();
    await waitFor(() => clients.every((c) => hasText(c, "并发广播")), "所有客户端通过 delta 收到新增内容");
    for (const client of clients) {
      expect(client.snapshots).toBe(1); // updates arrived incrementally, not via re-snapshot
      expect(client.states).toContain("live");
    }
  });

  it("enforces the read-only token gate for polling clients", async () => {
    const { hub, taskId } = makeFixture();
    const { base } = await listen(hub);
    const bad = startClient(base, taskId, "wrong-token");
    await waitFor(() => bad.states.includes("retrying"), "401 进入重试退避");
    expect(bad.snapshots).toBe(0);
    expect(bad.items.size).toBe(0);
    const direct = await fetch(`${base}/api/tasks/${taskId}/snapshot?token=wrong-token`);
    expect(direct.status).toBe(401);
  });

  it("survives a server restart: backoff during downtime, reset + re-snapshot on the new generation", async () => {
    const fixture = makeFixture();
    const first = await listen(fixture.hub);
    const clients = Array.from({ length: 3 }, () => startClient(first.base, fixture.taskId, TOKEN));
    await waitFor(() => clients.every((c) => c.snapshots >= 1), "首次快照");
    // Stop the first server (drop every connection), keep clients polling.
    first.server.closeAllConnections();
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    await waitFor(() => clients.every((c) => c.states.includes("retrying")), "停机期间进入退避");
    // Restart on the same port with a fresh Hub → new generation, new history.
    appendFileSync(fixture.stdout, `${j({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "重启后新增" } })}\n`);
    const hub2 = new Hub([fixture.taskId], fixture.root);
    hub2.refresh();
    await listen(hub2, first.port);
    await waitFor(
      () => clients.every((c) => c.snapshots >= 2 && hasText(c, "重启后新增")),
      "旧 cursor 触发 reset 并重取快照",
    );
    for (const client of clients) {
      expect(client.states[client.states.length - 1]).toBe("live");
    }
  });
});
