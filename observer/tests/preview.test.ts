import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/server/main.js";
import { attachPreview, startPreview, stopPreview, previewStatus, type LaunchOptions } from "../src/server/preview.js";
import { metadataPath, previewToken, readMetadata, writeMetadata, type PreviewRecord } from "../src/server/runtime.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture(): Promise<LaunchOptions> {
  const root = mkdtempSync(path.join(tmpdir(), "observer-preview-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const webRoot = path.join(root, "web");
  mkdirSync(webRoot);
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Fixture preview</title>");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return {
    tasks: ["fixture-task"], port, token: "fixture-preview", stateDir: root, webRoot, refreshMs: 200,
    entrypoint: fileURLToPath(new URL("../src/server/main.ts", import.meta.url)), nodeArgs: ["--import", "tsx"],
  };
}

describe("preview lifecycle", () => {
  it("attaches using HTTP, preserves other tasks and configuration, and focuses the requested task without a browser", async () => {
    const options = await fixture();
    let owned: PreviewRecord | null = null;
    cleanups.push(async () => { if (owned) await stopPreview(options.stateDir, options.port); });
    const first = await attachPreview(options);
    owned = first.record;
    expect(first).toMatchObject({ binding_verified: true, page_http_verified: true, focus_task: "fixture-task" });
    expect(new URL(first.url).searchParams.get("task")).toBe("fixture-task");
    expect(first.tasks[0].available).toBe(false); // valid pre-task binding, not a claim of execution
    const next = await attachPreview({ ...options, tasks: ["fixture-other"], focusTask: "fixture-other", token: "ignored-new-token", refreshMs: 900 });
    owned = next.record;
    expect(next.record.tasks).toEqual(["fixture-other", "fixture-task"]);
    expect(next.record.refresh_ms).toBe(options.refreshMs);
    expect(previewToken(next.record)).toBe(previewToken(first.record));
    expect(next.record.web_root).toBe(first.record.web_root);
    expect(next.record.entrypoint).toBe(first.record.entrypoint);
    expect(new URL(next.url).searchParams.get("task")).toBe("fixture-other");
    const again = await attachPreview({ ...options, tasks: ["fixture-other"] });
    expect(again.record.instance_id).toBe(next.record.instance_id);
    await expect(stopPreview(options.stateDir, options.port, first.record.instance_id)).rejects.toThrow("实例已变化");
    writeMetadata({ ...owned, pid: process.pid });
    await expect(attachPreview(options)).rejects.toThrow("无法核验");
    writeMetadata(owned);
    expect((await previewStatus(options.stateDir, options.port)).status).toBe("running");
  }, 15_000);
  it("starts once, verifies readiness, closes SSE and preserves the address across restart", async () => {
    const options = await fixture();
    let owned: PreviewRecord | null = null;
    cleanups.push(async () => { if (owned) await stopPreview(options.stateDir, options.port); });
    owned = await startPreview(options);
    const first = owned;
    expect((await startPreview(options)).pid).toBe(first.pid);
    expect((await previewStatus(options.stateDir, options.port)).status).toBe("running");
    expect(await (await fetch(first.url)).text()).toContain("Fixture preview");
    expect(statSync(metadataPath(options.stateDir, options.port)).mode & 0o777).toBe(0o600);
    const log = readFileSync(path.join(options.stateDir, "observer", `server-${options.port}.log`), "utf8");
    // stdout events and Node diagnostics (for example node:sqlite warnings)
    // share the log. Readiness is a structured event tied to this instance.
    const events = log.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    expect(events).toEqual([expect.objectContaining({ event: "preview-ready", instance_id: first.instance_id, pid: first.pid })]);
    const headers = { authorization: `Bearer ${previewToken(first)}` };
    const base = `http://127.0.0.1:${first.port}`;
    const snapshot = await (await fetch(`${base}/api/tasks/fixture-task/snapshot`, { headers })).json() as { cursor: string };
    const stream = await fetch(`${base}/api/tasks/fixture-task/stream?cursor=${encodeURIComponent(snapshot.cursor)}`, { headers });
    const reader = stream.body!.getReader();
    const stopped = await stopPreview(options.stateDir, options.port);
    owned = null;
    await reader.read().catch(() => undefined); // termination closes the open reader
    expect(stopped!.instance_id).toBe(first.instance_id);
    expect(readMetadata(options.stateDir, options.port)).toBeNull();
    owned = await startPreview({ ...options, token: previewToken(stopped!) });
    expect(owned.url).toBe(first.url);
    expect(owned.instance_id).not.toBe(first.instance_id);
  }, 15_000);

  it("refuses to stop a reused PID or overwrite a running preview's config", async () => {
    const options = await fixture();
    const record = await startPreview(options);
    cleanups.push(async () => {
      writeMetadata(record);
      await stopPreview(options.stateDir, options.port);
    });
    await expect(startPreview({ ...options, tasks: ["different-task"] })).rejects.toThrow("配置不同");
    writeMetadata({ ...record, pid: process.pid }); // stale/reused PID must never be signalled
    await expect(stopPreview(options.stateDir, options.port)).rejects.toThrow("未发送停止信号");
    expect((await previewStatus(options.stateDir, options.port)).status).toBe("unverified");
    writeMetadata(record);
    expect((await previewStatus(options.stateDir, options.port)).status).toBe("running");
  });

  it("reports a port collision as failure without replacing the listener", async () => {
    const options = await fixture();
    const listener = createServer((_req, res) => res.end("unrelated"));
    await new Promise<void>((resolve) => listener.listen(options.port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    await expect(startPreview(options)).rejects.toThrow("预览未就绪");
    expect(await (await fetch(`http://127.0.0.1:${options.port}`)).text()).toBe("unrelated");
    expect(readMetadata(options.stateDir, options.port)).toBeNull();
  });

  it("rejects invalid refresh intervals and empty task allowlists", () => {
    for (const value of ["NaN", "Infinity", "-1", "0", "1.5", "60001"]) {
      expect(() => parseArgs(["--tasks", "fixture-task", "--refresh-ms", value])).toThrow("refresh-ms");
    }
    expect(() => parseArgs([])).toThrow("allowlist");
    expect(() => parseArgs(["--tasks", "fixture-task", "--focus-task", "other"])).toThrow("focus-task");
  });
});
