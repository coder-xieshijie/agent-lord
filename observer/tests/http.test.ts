import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, unlinkSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/server/hub.js";
import { createObserverServer } from "../src/server/http.js";

vi.mock("../src/server/fonts.js", () => ({
  createFontCatalog: () => async () => ({ available: true, families: ["Fixture Mono"] }),
}));

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
  it("downloads only an authenticated, operation-bound canonical final artifact with a valid digest", async () => {
    const { root, hub, taskId } = makeFixture();
    const dir = path.join(root, "artifacts", taskId); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "fixture-op-http.md");
    const text = "# 最终产物\n"; writeFileSync(file, text);
    const opFile = path.join(root, "operations", "fixture-op-http.json");
    const op = JSON.parse(readFileSync(opFile, "utf8"));
    writeFileSync(opFile, j({ ...op, status: "succeeded", artifact: { path: file, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") } }));
    const { base } = await startServer(hub);
    const route = `/api/tasks/${taskId}/artifact?operation_id=fixture-op-http`;
    expect((await fetch(base + route)).status).toBe(401);
    const response = await fetch(`${base}${route}&token=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toBe(text);
    expect((await fetch(`${base}/api/tasks/other/artifact?operation_id=fixture-op-http&token=${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/${taskId}/artifact?operation_id=../escape&token=${TOKEN}`)).status).toBe(404);
    const validRecord = readFileSync(opFile, "utf8");
    writeFileSync(opFile, j({ ...JSON.parse(validRecord), operation_id: "another-operation" }));
    expect((await fetch(`${base}${route}&token=${TOKEN}`)).status).toBe(404);
    writeFileSync(opFile, validRecord);
    writeFileSync(file, "tampered");
    expect((await fetch(`${base}${route}&token=${TOKEN}`)).status).toBe(404);
    const outside = path.join(root, "outside.md"); writeFileSync(outside, text); unlinkSync(file); symlinkSync(outside, file);
    expect((await fetch(`${base}${route}&token=${TOKEN}`)).status).toBe(404);
  });
  it("keeps host font discovery behind the existing read-only token gate", async () => {
    const { hub } = makeFixture();
    const { base } = await startServer(hub);
    expect((await fetch(`${base}/api/fonts`)).status).toBe(401);
    expect((await fetch(`${base}/api/fonts?token=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/api/fonts?token=${TOKEN}`, { method: "POST" })).status).toBe(405);
    expect(await (await fetch(`${base}/api/fonts?token=${TOKEN}`)).json()).toEqual({ available: true, families: ["Fixture Mono"] });
  });
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
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
    const health = await (await fetch(`${base}/api/health?token=${TOKEN}`)).json() as { service: string; instanceId: string; pid: number };
    expect(health.service).toBe("agent-lord-observer");
    expect(health.pid).toBe(process.pid);
    expect(health.instanceId).toBeTruthy();
    expect((await fetch(`${base}/api/overview`, { headers: { cookie: "observer_token=%E0%A4%A" } })).status).toBe(401);
    expect((await fetch(`${base}/api/tasks/%E0%A4%A/snapshot?token=${TOKEN}`)).status).toBe(400);
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
