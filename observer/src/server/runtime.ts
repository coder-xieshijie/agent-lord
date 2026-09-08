/** Observer-owned metadata, never scheduler state. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PreviewRecord {
  instance_id: string;
  pid: number;
  port: number;
  url: string;
  tasks: string[];
  state_dir: string;
  web_root: string;
  refresh_ms: number;
  entrypoint: string;
  started_at: string;
  implementation: "typescript";
}

export function metadataPath(root: string, port: number): string {
  return path.join(root, "observer", `server-${port}.json`);
}

export function readMetadata(root: string, port: number): PreviewRecord | null {
  let raw: string;
  try {
    raw = readFileSync(metadataPath(root, port), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(raw) as PreviewRecord;
  if (!value.instance_id || !Number.isInteger(value.pid) || value.pid <= 0
    || value.port !== port || value.state_dir !== path.resolve(root)
    || !Array.isArray(value.tasks) || !value.web_root || !value.url) {
    throw new Error("预览记录缺少可核验的实例身份；请先检查旧服务的进程与端口归属");
  }
  return value;
}

export function writeMetadata(record: PreviewRecord): void {
  const file = metadataPath(record.state_dir, record.port);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${record.instance_id}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

export function removeMetadata(record: PreviewRecord): void {
  const current = readMetadata(record.state_dir, record.port);
  if (current?.instance_id === record.instance_id && current.pid === record.pid) {
    unlinkSync(metadataPath(record.state_dir, record.port));
  }
}

export function previewToken(record: PreviewRecord): string {
  const url = new URL(record.url);
  const token = url.searchParams.get("token");
  if (url.origin !== `http://127.0.0.1:${record.port}` || !token) throw new Error("非法预览地址");
  return token;
}

export async function probe(record: PreviewRecord): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/health`, {
      headers: { authorization: `Bearer ${previewToken(record)}` },
      signal: AbortSignal.timeout(750),
      redirect: "error",
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return false;
    const health = await response.json() as { service?: string; instanceId?: string; pid?: number };
    return health.service === "agent-lord-observer" && health.instanceId === record.instance_id && health.pid === record.pid;
  } catch {
    return false;
  }
}
