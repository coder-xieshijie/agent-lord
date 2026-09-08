import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../src/server/hub.js";
import { createObserverServer } from "../src/server/http.js";

const j = (value: unknown): string => JSON.stringify(value);
const TOKEN = "fixture-token";
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeFixture(): { root: string; taskId: string; stdout: string; hub: Hub } {
  const root = mkdtempSync(path.join(tmpdir(), "observer-http-fixture-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "operations"), { recursive: true });
  mkdirSync(path.join(root, "logs"), { recursive: true });
  mkdirSync(path.join(root, "events"), { recursive: true });
  const taskId = "fixture-task-http";
  const stdout = path.join(root, "logs", "fixture-op-http.stdout");
  writeFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "初始" } })}\n`);
  writeFileSync(
    path.join(root, "operations", "fixture-op-http.json"),
    j({
      operation_id: "fixture-op-http",
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

async function startServer(hub: Hub): Promise<{ base: string; server: Server }> {
  const server = createObserverServer({ hub, token: TOKEN, webRoot: null, port: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

describe("HTTP surface", () => {
  it("rejects missing/invalid tokens and non-GET methods", async () => {
    const { hub } = makeFixture();
    const { base } = await startServer(hub);
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    expect((await fetch(`${base}/api/overview?token=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/api/overview?token=${TOKEN}`, { method: "POST" })).status).toBe(405);
    const ok = await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    const viaCookie = await fetch(`${base}/api/overview`, { headers: { cookie: `observer_token=${TOKEN}` } });
    expect(viaCookie.status).toBe(200);
    const badCookie = await fetch(`${base}/api/overview`, { headers: { cookie: "observer_token=wrong" } });
    expect(badCookie.status).toBe(401);
  });

  it("scopes task endpoints to the allowlist", async () => {
    const { hub, taskId } = makeFixture();
    const { base } = await startServer(hub);
    expect((await fetch(`${base}/api/tasks/other-task/snapshot?token=${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/..%2Fescape/snapshot?token=${TOKEN}`)).status).toBe(404);
    const snapshot = await fetch(`${base}/api/tasks/${taskId}/snapshot?token=${TOKEN}`);
    expect(snapshot.status).toBe(200);
    const body = (await snapshot.json()) as { items: unknown[]; cursor: string };
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("serves deltas for valid cursors and explicit resets otherwise", async () => {
    const { hub, taskId, stdout } = makeFixture();
    const { base } = await startServer(hub);
    const snapshot = (await (
      await fetch(`${base}/api/tasks/${taskId}/snapshot?token=${TOKEN}`)
    ).json()) as { cursor: string };
    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "更新" } })}\n`);
    hub.refresh();
    const delta = (await (
      await fetch(`${base}/api/tasks/${taskId}/delta?cursor=${encodeURIComponent(snapshot.cursor)}&token=${TOKEN}`)
    ).json()) as { patches?: unknown[]; reset?: boolean };
    expect(delta.reset).toBeUndefined();
    expect(delta.patches!.length).toBeGreaterThan(0);
    const reset = (await (
      await fetch(`${base}/api/tasks/${taskId}/delta?cursor=stale-generation:1&token=${TOKEN}`)
    ).json()) as { reset?: boolean };
    expect(reset.reset).toBe(true);
  });

  it("streams SSE deltas to multiple concurrent readers", async () => {
    const { hub, taskId, stdout } = makeFixture();
    const { base } = await startServer(hub);
    const snapshot = (await (
      await fetch(`${base}/api/tasks/${taskId}/snapshot?token=${TOKEN}`)
    ).json()) as { cursor: string };

    const readSse = async (signal: AbortSignal): Promise<string> => {
      const res = await fetch(
        `${base}/api/tasks/${taskId}/stream?cursor=${encodeURIComponent(snapshot.cursor)}&token=${TOKEN}`,
        { signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!buffer.includes("event: delta")) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };

    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const readers = [readSse(controller.signal), readSse(controller.signal)];
    // Give both connections time to subscribe before producing the event.
    await new Promise((resolve) => setTimeout(resolve, 150));
    appendFileSync(stdout, `${j({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "广播" } })}\n`);
    hub.refresh();
    const results = await Promise.all(readers);
    for (const buffer of results) {
      expect(buffer).toContain("event: delta");
      expect(buffer).toContain("广播");
    }
    controller.abort();
  });
});
