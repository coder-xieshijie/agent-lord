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

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Hub } from "./hub.js";
import { createObserverServer } from "./http.js";
import { defaultStateDir, IDENTIFIER_PATTERN } from "./scan.js";

interface CliOptions {
  tasks: string[];
  port: number;
  token: string;
  stateDir: string;
  webRoot: string | null;
  refreshMs: number;
}

function parseArgs(argv: string[]): CliOptions {
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
        options.refreshMs = Math.max(200, Number(next()));
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.tasks.length) throw new Error("必须用 --tasks 指定至少一个 task id（显式 allowlist）");
  for (const taskId of options.tasks) {
    if (!IDENTIFIER_PATTERN.test(taskId)) throw new Error(`非法 task id：${taskId}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("端口必须是 1-65535 的整数");
  }
  if (!options.token) options.token = randomBytes(16).toString("base64url");
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
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  }
  const hub = new Hub(options.tasks, options.stateDir);
  hub.refresh();
  const timer = setInterval(() => hub.refresh(), options.refreshMs);
  timer.unref();

  const server = createObserverServer({
    hub,
    token: options.token,
    webRoot: options.webRoot,
    port: options.port,
  });
  server.listen(options.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${options.port}/?token=${options.token}`;
    // Runtime metadata lives in the out-of-repo observer namespace so the
    // caller can find/stop this process later.
    try {
      const metaDir = path.join(options.stateDir, "observer");
      mkdirSync(metaDir, { recursive: true });
      writeFileSync(
        path.join(metaDir, `server-${options.port}.json`),
        `${JSON.stringify(
          {
            pid: process.pid,
            port: options.port,
            url,
            tasks: options.tasks,
            state_dir: options.stateDir,
            web_root: options.webRoot,
            started_at: new Date().toISOString(),
            implementation: "typescript",
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      // Metadata write failure must not kill the observer.
    }
    console.log(`observer listening: ${url}`);
    console.log(`tasks: ${options.tasks.join(", ")}`);
    console.log(`state dir: ${options.stateDir}`);
  });
  server.on("error", (error) => {
    console.error(`server error: ${String(error)}`);
    process.exit(1);
  });
}

main();
