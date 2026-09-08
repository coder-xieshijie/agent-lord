import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/server/main.js";
import { startPreview, stopPreview, previewStatus, type LaunchOptions } from "../src/server/preview.js";
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
    expect(JSON.parse(log.trim()).event).toBe("preview-ready");
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
  });
});
