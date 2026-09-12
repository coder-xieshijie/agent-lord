/** Loopback-only HTTP + SSE server.
 *
 * Security boundary:
 * - binds 127.0.0.1 only, requires a bearer/query token on every request;
 * - the task allowlist is fixed at startup — no other task is readable;
 * - one authenticated, allow-listed POST may invoke the constrained native
 *   terminal launcher; it cannot accept a shell command from the browser;
 * - static files are served only from the built web root, resolved paths
 *   must stay inside it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Hub, HubListener } from "./hub.js";
import { IDENTIFIER_PATTERN } from "./scan.js";
import { createFontCatalog } from "./fonts.js";
import {
  AgentLordError,
  NATIVE_TERMINALS,
  openTaskTerminal,
  StateStore,
  type NativeTerminal,
  type TerminalOpenResult,
} from "@agent-lord/core";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface ObserverServerOptions {
  hub: Hub;
  token: string;
  webRoot: string | null;
  port: number;
  instanceId?: string;
  launchTerminal?: (taskId: string, terminal: NativeTerminal) => TerminalOpenResult;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "observer_token") {
      try { return decodeURIComponent(rest.join("=")); } catch { return null; }
    }
  }
  return null;
}

/** Token may arrive as a Bearer header, a `?token=` query parameter, or the
 * cookie set after a successful tokenized page load (so that static assets
 * and EventSource requests stay behind the same gate). */
function tokenOk(req: IncomingMessage, url: URL, expected: string): boolean {
  const header = req.headers.authorization;
  const candidates = [
    header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null,
    url.searchParams.get("token"),
    cookieToken(req),
  ];
  return candidates.some((candidate) => candidate !== null && safeEqual(candidate, expected));
}

export function createObserverServer(options: ObserverServerOptions): Server {
  const { hub, token, webRoot } = options;
  const launchTerminal = options.launchTerminal ?? ((taskId: string, terminal: NativeTerminal) =>
    openTaskTerminal(taskId, terminal, { store: new StateStore(hub.stateDir) }));
  const instanceId = options.instanceId ?? randomUUID();
  const fonts = createFontCatalog();

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    const terminalMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/terminal-open$/);
    const terminalPost = req.method === "POST" && terminalMatch !== null;
    if (req.method !== "GET" && req.method !== "HEAD" && !terminalPost) {
      sendJson(res, 405, { error: "observer 仅支持读取和受约束的终端打开操作" });
      return;
    }
    if (!tokenOk(req, url, token)) {
      sendJson(res, 401, { error: "missing or invalid token" });
      return;
    }

    if (terminalMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(terminalMatch[1]);
      } catch {
        sendJson(res, 400, { error: "bad task id" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "terminal-open requires POST" });
        return;
      }
      if (!IDENTIFIER_PATTERN.test(taskId) || !hub.has(taskId)) {
        sendJson(res, 404, { error: "task 不在 allowlist 中" });
        return;
      }
      const terminal = url.searchParams.get("terminal");
      if (!NATIVE_TERMINALS.includes(terminal as NativeTerminal)) {
        sendJson(res, 400, { error: `terminal must be one of: ${NATIVE_TERMINALS.join(", ")}` });
        return;
      }
      try {
        sendJson(res, 200, launchTerminal(taskId, terminal as NativeTerminal));
      } catch (error) {
        if (error instanceof AgentLordError) {
          sendJson(res, error.exit_code === 2 ? 400 : 409, { error: error.message, code: error.code });
        } else {
          sendJson(res, 500, { error: "无法打开终端" });
        }
      }
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { service: "agent-lord-observer", instanceId, pid: process.pid });
      return;
    }
    if (url.pathname === "/api/overview") {
      sendJson(res, 200, { tasks: hub.overview(), generation: hub.generation });
      return;
    }
    if (url.pathname === "/api/schedule") {
      // Same read boundary as /api/overview: aggregates only allow-listed
      // tasks; session ids only — data roots and full paths never ship.
      sendJson(res, 200, hub.schedule());
      return;
    }
    if (url.pathname === "/api/fonts") {
      void fonts().then((catalog) => {
        if (!res.destroyed) sendJson(res, 200, catalog);
      });
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(snapshot|delta|stream|artifact)$/);
    if (taskMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(taskMatch[1]);
      } catch {
        sendJson(res, 400, { error: "bad task id" });
        return;
      }
      const action = taskMatch[2];
      if (!IDENTIFIER_PATTERN.test(taskId) || !hub.has(taskId)) {
        sendJson(res, 404, { error: "task 不在 allowlist 中" });
        return;
      }
      if (action === "artifact") {
        const opId = url.searchParams.get("operation_id") ?? "";
        const bytes = hub.artifact(taskId, opId);
        if (!bytes) { sendJson(res, 404, { error: "最终产物不可用或完整性核验失败" }); return; }
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="${opId}.md"` });
        res.end(bytes);
        return;
      }
      if (action === "snapshot") {
        const snapshot = hub.snapshot(taskId);
        if (!snapshot) {
          sendJson(res, 404, { error: "task 不在 allowlist 中" });
          return;
        }
        sendJson(res, 200, {
          generation: hub.generation,
          cursor: snapshot.cursor,
          task: snapshot.task,
          items: snapshot.items,
          truncatedHistory: snapshot.truncatedHistory,
        });
        return;
      }
      if (action === "delta") {
        const afterSeq = hub.parseCursor(url.searchParams.get("cursor"));
        if (afterSeq === null) {
          sendJson(res, 200, { reset: true, reason: "cursor 缺失或属于其他服务实例，请重新获取快照" });
          return;
        }
        const delta = hub.delta(taskId, afterSeq);
        if (!delta) {
          sendJson(res, 200, { reset: true, reason: "cursor 已超出保留窗口，请重新获取快照" });
          return;
        }
        sendJson(res, 200, delta);
        return;
      }
      // SSE stream
      const afterSeq = hub.parseCursor(url.searchParams.get("cursor"));
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
      const write = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      if (afterSeq === null) {
        write("reset", { reset: true, reason: "cursor 缺失或属于其他服务实例，请重新获取快照" });
        res.end();
        return;
      }
      const initial = hub.delta(taskId, afterSeq);
      if (!initial) {
        write("reset", { reset: true, reason: "cursor 已超出保留窗口，请重新获取快照" });
        res.end();
        return;
      }
      if (initial.patches.length) write("delta", initial);
      const listener: HubListener = {
        seq: initial.patches.length
          ? initial.patches[initial.patches.length - 1].seq
          : afterSeq,
        send(payload) {
          if ("reset" in payload) {
            write("reset", payload);
            res.end();
          } else {
            write("delta", payload);
          }
        },
      };
      const unsubscribe = hub.subscribe(taskId, listener);
      const heartbeat = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      });
      return;
    }

    // Static assets from the built web root only.
    if (webRoot) {
      let assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const resolved = path.resolve(webRoot, `.${assetPath}`);
      if (resolved !== webRoot && !resolved.startsWith(webRoot + path.sep)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      let file = resolved;
      try {
        if (!statSync(file).isFile()) throw new Error("not file");
      } catch {
        // SPA fallback for client routes.
        file = path.join(webRoot, "index.html");
        try {
          statSync(file);
        } catch {
          sendJson(res, 404, { error: "web 资源未构建（先运行 pnpm build）" });
          return;
        }
      }
      const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
      const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store" };
      if (url.searchParams.get("token")) {
        // Tokenized page load: set the cookie so the app's static assets and
        // EventSource requests pass the same gate without URL rewriting.
        headers["set-cookie"] = `observer_token=${encodeURIComponent(
          url.searchParams.get("token") ?? "",
        )}; Path=/; HttpOnly; SameSite=Strict`;
      }
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : readFileSync(file));
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  return server;
}
