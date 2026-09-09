/** Observer entry point.
 *
 * Usage:
 *   node dist/server/main.js --tasks <id[,id…]> [--port 8791] [--token …]
 *     [--state-dir <root>] [--web-root <dir>]
 *
 * Read-only by design: the process never writes into the Agent Lord state
 * root except its own runtime metadata under `<root>/observer/` (an
 * out-of-repo namespace reserved for observer bookkeeping).
 */

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { Hub } from "./hub.js";
import { createObserverServer } from "./http.js";
import { defaultStateDir, IDENTIFIER_PATTERN } from "./scan.js";
import { removeMetadata, writeMetadata, type PreviewRecord } from "./runtime.js";

export interface CliOptions {
  tasks: string[];
  port: number;
  token: string;
  stateDir: string;
  webRoot: string | null;
  refreshMs: number;
  focusTask?: string;
}

export function parseArgs(argv: string[], requireTasks = true): CliOptions {
  const options: CliOptions = {
    tasks: [],
    port: 8791,
    token: "",
    stateDir: defaultStateDir(),
    webRoot: null,
    refreshMs: 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`缺少 ${arg} 的值`);
      return value;
    };
    switch (arg) {
      case "--tasks":
        options.tasks.push(...next().split(",").map((part) => part.trim()).filter(Boolean));
        break;
      case "--focus-task":
        options.focusTask = next();
        break;
      case "--port":
        options.port = Number(next());
        break;
      case "--token":
        options.token = next();
        break;
      case "--state-dir":
        options.stateDir = path.resolve(next());
        break;
      case "--web-root":
        options.webRoot = path.resolve(next());
        break;
      case "--refresh-ms":
        options.refreshMs = Number(next());
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  options.tasks = [...new Set(options.tasks)].sort();
  if (requireTasks && !options.tasks.length) throw new Error("必须用 --tasks 指定至少一个 task id（显式 allowlist）");
  for (const taskId of options.tasks) {
    if (!IDENTIFIER_PATTERN.test(taskId)) throw new Error(`非法 task id：${taskId}`);
  }
  if (options.focusTask && !options.tasks.includes(options.focusTask)) throw new Error("focus-task 必须属于本次 --tasks");
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("端口必须是 1-65535 的整数");
  }
  if (!Number.isInteger(options.refreshMs) || options.refreshMs < 200 || options.refreshMs > 60_000) {
    throw new Error("refresh-ms 必须是 200-60000 的整数");
  }
  if (!options.webRoot) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/server/main.js → dist/web ; src/server/main.ts (tsx dev) → dist/web
    const candidate = path.resolve(here, "..", "web");
    options.webRoot = candidate.includes(`${path.sep}dist${path.sep}`)
      ? candidate
      : path.resolve(here, "..", "..", "dist", "web");
  }
  return options;
}

function main(): void {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!statSync(path.join(options.webRoot!, "index.html")).isFile()) throw new Error("web 资源未构建，请先运行 pnpm build");
    if (!options.token) options.token = randomBytes(16).toString("base64url");
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  }
  const instanceId = randomUUID();
  const hub = new Hub(options.tasks, options.stateDir);
  hub.refresh();
  const timer = setInterval(() => hub.refresh(), options.refreshMs);
  timer.unref();

  const server = createObserverServer({
    hub,
    token: options.token,
    webRoot: options.webRoot,
    port: options.port,
    instanceId,
  });
  let record: PreviewRecord | null = null;
  const stop = (): void => {
    clearInterval(timer);
    server.close(() => {
      if (record) {
        try { removeMetadata(record); } catch (error) { console.error(String(error)); }
      }
    });
    server.closeAllConnections(); // includes SSE readers, whose close handlers unsubscribe
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(options.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${options.port}/?token=${encodeURIComponent(options.token)}`;
    // Runtime metadata lives in the out-of-repo observer namespace so the
    // caller can find/stop this process later.
    try {
      record = {
        instance_id: instanceId,
        pid: process.pid,
        port: options.port,
        url,
        tasks: options.tasks,
        state_dir: options.stateDir,
        web_root: options.webRoot!,
        refresh_ms: options.refreshMs,
        entrypoint: path.resolve(process.argv[1]),
        started_at: new Date().toISOString(),
        implementation: "typescript",
      };
      writeMetadata(record);
    } catch (error) {
      console.error(`无法记录预览进程：${String(error)}`);
      process.exitCode = 1;
      stop();
      return;
    }
    console.log(JSON.stringify({ event: "preview-ready", ...record }));
  });
  server.on("error", (error) => {
    console.error(`server error: ${String(error)}`);
    process.exit(1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
