/** Durable loopback preview lifecycle; never signals an unverified process. */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, type CliOptions } from "./main.js";
import { pidAlive } from "./scan.js";
import { previewToken, probe, readMetadata, removeMetadata, type PreviewRecord } from "./runtime.js";

export interface LaunchOptions extends CliOptions {
  /** Test-only launch seam; production uses the adjacent compiled entrypoint. */
  entrypoint?: string;
  nodeArgs?: string[];
}

export async function previewStatus(root: string, port: number) {
  const record = readMetadata(root, port);
  return { status: record ? await probe(record) ? "running" : "unverified" : "stopped", port, record };
}

export async function stopPreview(root: string, port: number, expectedInstance?: string): Promise<PreviewRecord | null> {
  const record = readMetadata(root, port);
  if (!record) return null;
  if (expectedInstance && record.instance_id !== expectedInstance) throw new Error("observer 实例已变化；未停止新实例，请重试绑定");
  if (!await probe(record)) throw new Error("无法确认该端口和 PID 属于记录的 observer 实例；未发送停止信号");
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pidAlive(record.pid)) {
      removeMetadata(record);
      return record;
    }
    await delay(100);
  }
  throw new Error(`observer ${record.pid} 尚未退出；未强制杀进程`);
}

export async function startPreview(options: LaunchOptions): Promise<PreviewRecord> {
  if (!options.tasks.length) throw new Error("启动需要显式 --tasks allowlist");
  const entrypoint = options.entrypoint ?? fileURLToPath(new URL("./main.js", import.meta.url));
  const existing = readMetadata(options.stateDir, options.port);
  if (existing && await probe(existing)) {
    if (JSON.stringify(existing.tasks) !== JSON.stringify(options.tasks) || existing.web_root !== options.webRoot
      || existing.refresh_ms !== options.refreshMs || existing.entrypoint !== entrypoint
      || (options.token && previewToken(existing) !== options.token)) {
      throw new Error("该端口的 observer 配置不同；请显式使用 preview:restart 应用新配置");
    }
    return existing;
  }
  if (existing && pidAlive(existing.pid)) throw new Error("预览记录的 PID 仍存在但实例身份无法确认；未启动或终止任何进程");
  const token = options.token || (existing ? previewToken(existing) : randomBytes(16).toString("base64url"));
  const directory = path.join(options.stateDir, "observer");
  mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, `server-${options.port}.log`);
  const log = openSync(logPath, "a", 0o600);
  const args = [
    ...(options.nodeArgs ?? []), entrypoint, "--tasks", options.tasks.join(","), "--port", String(options.port),
    "--token", token, "--state-dir", options.stateDir, "--web-root", options.webRoot!, "--refresh-ms", String(options.refreshMs),
  ];
  let child;
  try {
    child = spawn(process.execPath, args, { stdio: ["ignore", log, log], detached: true });
  } finally {
    closeSync(log);
  }
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    const record = readMetadata(options.stateDir, options.port);
    if (record && record.pid === child.pid && await probe(record)) return record;
    await delay(100);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  throw new Error(`预览未就绪${spawnError ? `：${String(spawnError)}` : ""}；查看 ${logPath}`);
}

/** Lifecycle CLI only: preserve existing configuration, then verify through HTTP without browser control. */
export async function attachPreview(options: LaunchOptions) {
  if (!options.tasks.length) throw new Error("绑定需要显式 --tasks allowlist");
  const focus = options.focusTask ?? options.tasks[0];
  if (!options.tasks.includes(focus)) throw new Error("focus-task 必须属于本次 --tasks");
  let record = readMetadata(options.stateDir, options.port);
  if (record) {
    if (!await probe(record)) throw new Error("无法核验已有 observer；未停止或替换服务");
    const tasks = [...new Set([...record.tasks, ...options.tasks])].sort();
    if (tasks.some((task) => !record!.tasks.includes(task))) {
      const old = record;
      await stopPreview(options.stateDir, options.port, old.instance_id);
      record = await startPreview({
        ...options, tasks, token: previewToken(old), webRoot: old.web_root,
        refreshMs: old.refresh_ms, entrypoint: old.entrypoint,
      });
    }
  } else record = await startPreview(options);
  const headers = { authorization: `Bearer ${previewToken(record)}` };
  const base = `http://127.0.0.1:${record.port}`;
  const json = async (route: string) => {
    const response = await fetch(`${base}${route}`, { headers, signal: AbortSignal.timeout(2000), redirect: "error" });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error(`绑定 HTTP 核验失败：${route}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const overview = await json("/api/overview");
  const tasks = Array.isArray(overview.tasks) ? overview.tasks as Array<{ taskId?: string }> : [];
  if (options.tasks.some((task) => !tasks.some((entry) => entry.taskId === task))) throw new Error("overview 缺少本次任务");
  const snapshots = await Promise.all(options.tasks.map(async (task) => {
    const snapshot = await json(`/api/tasks/${encodeURIComponent(task)}/snapshot`);
    const meta = snapshot.task as { taskId?: string; available?: boolean; status?: string } | undefined;
    if (meta?.taskId !== task) throw new Error("snapshot 任务身份不匹配");
    return { task_id: task, available: meta.available === true, status: meta.status ?? "未知" };
  }));
  const page = await fetch(base, { headers, signal: AbortSignal.timeout(2000), redirect: "error" });
  if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) throw new Error("观察页静态资源不可用");
  await page.body?.cancel();
  const url = new URL(record.url);
  url.searchParams.set("task", focus);
  return { status: "running", binding_verified: true, page_http_verified: true, focus_task: focus, url: url.href, tasks: snapshots, record };
}

async function main(): Promise<void> {
  const [action, ...argv] = process.argv.slice(2);
  if (!["start", "status", "stop", "restart", "attach"].includes(action)) throw new Error("用法：preview start|status|stop|restart|attach [--tasks id,...] [--focus-task id] [--port 8791]");
  const options = parseArgs(argv, false);
  if (action === "attach") {
    console.log(JSON.stringify(await attachPreview(options)));
  } else if (action === "status") {
    console.log(JSON.stringify(await previewStatus(options.stateDir, options.port)));
  } else if (action === "stop") {
    await stopPreview(options.stateDir, options.port);
    console.log(JSON.stringify({ status: "stopped", port: options.port }));
  } else {
    if (action === "restart") {
      const old = readMetadata(options.stateDir, options.port);
      if (old) {
        if (!options.tasks.length) options.tasks = old.tasks;
        if (!argv.includes("--token")) options.token = previewToken(old);
        if (!argv.includes("--web-root")) options.webRoot = old.web_root;
        if (!argv.includes("--refresh-ms")) options.refreshMs = old.refresh_ms;
        await stopPreview(options.stateDir, options.port);
      }
    }
    console.log(JSON.stringify({ status: "running", ...await startPreview(options) }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(String(error)); process.exitCode = 1; });
}
