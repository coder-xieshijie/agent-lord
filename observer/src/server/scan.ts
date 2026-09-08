/** Read-only access to the Agent Lord state directory.
 *
 * Never writes, never locks; readers tolerate concurrent appends by only
 * consuming complete lines. Also covers the first-turn gap: when the task
 * record does not exist yet (the scheduler creates it only after endpoint
 * identity is verified), metadata and logs are derived from operation
 * records that already carry the allow-listed task_id.
 */

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface OperationRecord {
  operationId: string;
  taskId: string;
  provider: string | null;
  kind: string | null;
  status: string | null;
  pid: number | null;
  createdAt: string;
  completedAt: string | null;
  stdoutPath: string | null;
  endpointId: string | null;
  observedSessionId: string | null;
  target: string | null;
  model: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TaskRecord {
  taskId: string;
  provider: string | null;
  endpointId: string | null;
  target: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastOperationId: string | null;
}

export function defaultStateDir(): string {
  const configured = process.env.AGENT_LORD_STATE_DIR;
  if (configured) return path.resolve(configured);
  return path.join(homedir(), ".codex", "state", "agent-lord");
}

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function readTaskRecord(root: string, taskId: string): TaskRecord | null {
  const file = path.join(root, `${taskId}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const contract = (value.contract ?? {}) as Record<string, unknown>;
    return {
      taskId,
      provider: asString(value.provider),
      endpointId: asString(value.endpoint_id),
      target: asString(value.target),
      model: asString(contract.model),
      effort: asString(contract.effort),
      permissionMode: asString(contract.permission_mode),
      createdAt: asString(value.created_at),
      updatedAt: asString(value.updated_at),
      lastOperationId: asString(value.last_operation_id),
    };
  } catch {
    return null;
  }
}

interface OpCacheEntry {
  mtimeMs: number;
  size: number;
  record: OperationRecord | null;
}

const opCache = new Map<string, OpCacheEntry>();

function parseOperationFile(file: string): OperationRecord | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const observed = (value.observed ?? {}) as Record<string, unknown>;
    const expected = (value.expected ?? {}) as Record<string, unknown>;
    const error = (value.error ?? null) as Record<string, unknown> | null;
    const operationId = asString(value.operation_id);
    const taskId = asString(value.task_id);
    if (!operationId || !taskId) return null;
    return {
      operationId,
      taskId,
      provider: asString(value.provider),
      kind: asString(value.kind),
      status: asString(value.status),
      pid: typeof value.pid === "number" ? value.pid : null,
      createdAt: asString(value.created_at) ?? "",
      completedAt: asString(value.completed_at),
      stdoutPath: asString(value.stdout_path),
      endpointId: asString(value.endpoint_id),
      observedSessionId: asString(observed.session_id),
      target: asString(value.target),
      model: asString(expected.model) ?? asString(observed.model),
      errorCode: error ? asString(error.code) : null,
      errorMessage: error ? asString(error.message) : null,
    };
  } catch {
    return null;
  }
}

/** All operations belonging to `taskId`, sorted by created_at.
 * Cached per file by (mtime,size) so 1s polling stays cheap. */
export function listOperations(root: string, taskId: string): OperationRecord[] {
  const dir = path.join(root, "operations");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const result: OperationRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    let stats;
    try {
      stats = statSync(file);
    } catch {
      continue;
    }
    const cached = opCache.get(file);
    let record: OperationRecord | null;
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      record = cached.record;
    } else {
      record = parseOperationFile(file);
      opCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, record });
    }
    if (record && record.taskId === taskId) result.push(record);
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function journalPath(root: string, taskId: string): string {
  return path.join(root, "events", `${taskId}.jsonl`);
}

/** Validate a journaled stdout path: must live in `<root>/logs` and belong to
 * the operation. Client-supplied paths are never accepted anywhere. */
export function validStdoutPath(root: string, operationId: string, raw: string | null): string | null {
  if (!raw) return null;
  const resolved = path.resolve(raw);
  const logsDir = path.resolve(root, "logs");
  if (path.dirname(resolved) !== logsDir) return null;
  if (!path.basename(resolved).startsWith(`${operationId}.`)) return null;
  return resolved;
}

export interface TailResult {
  lines: string[];
  offset: number;
  /** Set when the file shrank below the cursor (truncate/rotation). */
  truncated: boolean;
}

export const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Read complete lines from `offset`; half-written trailing bytes stay. */
export function readCompleteLines(file: string, offset: number): TailResult {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { lines: [], offset, truncated: false };
  }
  if (size < offset) {
    return { lines: [], offset: size, truncated: true };
  }
  if (size === offset) {
    return { lines: [], offset, truncated: false };
  }
  const length = Math.min(size - offset, MAX_READ_BYTES);
  const buffer = Buffer.alloc(length);
  let descriptor: number;
  try {
    descriptor = openSync(file, "r");
  } catch {
    return { lines: [], offset, truncated: false };
  }
  let bytesRead = 0;
  try {
    bytesRead = readSync(descriptor, buffer, 0, length, offset);
  } finally {
    closeSync(descriptor);
  }
  const chunk = buffer.subarray(0, bytesRead);
  const cut = chunk.lastIndexOf(0x0a);
  if (cut < 0) return { lines: [], offset, truncated: false };
  const consumed = chunk.subarray(0, cut + 1);
  return {
    lines: consumed.toString("utf8").split("\n").filter((line) => line.length > 0),
    offset: offset + consumed.length,
    truncated: false,
  };
}

export function pidAlive(pid: number | null): boolean | null {
  if (!pid || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0: existence probe only
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

export function fileMtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
