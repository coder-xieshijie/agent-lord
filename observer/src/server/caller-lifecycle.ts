/** Read only lifecycle metadata from one explicitly bound Codex session.
 * No host tools, provider calls, transcript projection or state writes. */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import type { CallerLifecycle, ScheduleReceipt, ScheduleTurn } from "../shared/types.js";
import { readCompleteLines } from "./scan.js";

/** Structured receipt statuses projected from the caller's rollout log. */
const RECEIPT_STATUSES = new Set(["SUCCEEDED", "ERROR", "NEEDS_DECISION"]);

interface Receipt {
  atMs: number;
  status: ScheduleReceipt["status"];
}
interface Turn {
  id: string;
  started: number;
  completed: number | null;
  aborted: boolean;
  receipts: Map<string, Receipt>;
}

export interface SessionTimeline {
  /** Verified turns, oldest first. */
  turns: ScheduleTurn[];
  /** operation_id → structured receipt (turn active at arrival; cross-turn). */
  receipts: Map<string, ScheduleReceipt>;
  /** Empty when fully observed; otherwise why data is missing/partial. */
  note: string;
}
interface Reader {
  file: string | null;
  lookupAt: number;
  offset: number;
  inode: number;
  verified: boolean;
  rejected: boolean;
  active: string | null;
  turns: Map<string, Turn>;
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const unknown = (note: string): CallerLifecycle => ({ status: "unknown", turnId: null, startedAtMs: null, completedAtMs: null, receivedAtMs: null, observedAtMs: null, note });

/** Locate the unique rollout log of one explicitly named session id. */
export function locateRolloutFile(root: string, session: string): string | null {
  const found: string[] = [];
  let entries = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 4 || entries > 50_000) return;
    let files;
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const file of files) {
      if (++entries > 50_000) return;
      if (file.isDirectory()) visit(path.join(dir, file.name), depth + 1);
      else if (file.isFile() && file.name.startsWith("rollout-") && file.name.endsWith(`-${session}.jsonl`)) found.push(path.join(dir, file.name));
    }
  };
  visit(path.join(root, "sessions"), 0);
  visit(path.join(root, "archived_sessions"), 0);
  return found.length === 1 ? found[0] : null;
}

/** Unwrap host transport containers only, retaining an operation id and receipt time. */
function receipts(value: unknown, turn: Turn, ts: number, depth = 0): void {
  if (depth > 12) return;
  if (typeof value === "string") {
    if (value.length > 4 * 1024 * 1024) return;
    try { receipts(JSON.parse(value), turn, ts, depth + 1); } catch { /* not structured transport */ }
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 1000)) receipts(item, turn, ts, depth + 1);
  } else {
    const item = object(value);
    if (typeof item.status === "string" && RECEIPT_STATUSES.has(item.status)
      && typeof item.operation_id === "string" && !turn.receipts.has(item.operation_id)) {
      turn.receipts.set(item.operation_id, { atMs: ts, status: item.status as ScheduleReceipt["status"] });
      if (turn.receipts.size > 1000) turn.receipts.delete(turn.receipts.keys().next().value!);
    }
    for (const key of ["output", "text", "content", "value", "result", "actionable"]) if (key in item) receipts(item[key], turn, ts, depth + 1);
  }
}

export class CallerLifecycleReader {
  private readers = new Map<string, Reader>();

  /** Locate + incrementally consume the session's rollout log. Returns the
   * up-to-date reader with the current stat, or an honest failure note. */
  private pump(caller: CallerIdentity | undefined):
    | { reader: Reader; size: number; mtimeMs: number }
    | { note: string } {
    if (caller?.kind !== "codex" || !caller.session_id || !caller.data_root || !path.isAbsolute(caller.data_root)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(caller.session_id)) return { note: "未记录可核验的 Codex 调度会话来源" };
    const key = `${caller.data_root}\0${caller.session_id}`;
    let reader = this.readers.get(key);
    if (!reader) {
      reader = { file: null, lookupAt: 0, offset: 0, inode: 0, verified: false, rejected: false, active: null, turns: new Map() };
      this.readers.set(key, reader);
    }
    if (!reader.file && Date.now() - reader.lookupAt > 5000) {
      reader.file = locateRolloutFile(caller.data_root, caller.session_id);
      reader.lookupAt = Date.now();
    }
    if (!reader.file) return { note: "未找到唯一匹配的 Codex Session 日志" };
    try {
      const stat = statSync(reader.file);
      if ((reader.inode && reader.inode !== stat.ino) || stat.size < reader.offset) {
        reader.offset = 0; reader.verified = false; reader.rejected = false; reader.active = null; reader.turns.clear();
      }
      reader.inode = stat.ino;
      const tail = readCompleteLines(reader.file, reader.offset);
      reader.offset = tail.offset;
      for (const line of tail.lines) {
        let event;
        try { event = object(JSON.parse(line)); } catch { continue; }
        const payload = object(event.payload);
        if (event.type === "session_meta") {
          if (payload.id !== caller.session_id) { reader.rejected = true; reader.verified = false; reader.turns.clear(); }
          else if (!reader.rejected) reader.verified = true;
          continue;
        }
        if (!reader.verified || reader.rejected) continue;
        const ts = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue;
        if (event.type === "event_msg") {
          if (payload.type === "task_started" && typeof payload.turn_id === "string") {
            reader.active = payload.turn_id;
            if (!reader.turns.has(payload.turn_id)) reader.turns.set(payload.turn_id, { id: payload.turn_id, started: ts, completed: null, aborted: false, receipts: new Map() });
            if (reader.turns.size > 1000) reader.turns.delete(reader.turns.keys().next().value!);
          } else if (payload.type === "task_complete" || payload.type === "task_aborted") {
            const id = typeof payload.turn_id === "string" ? payload.turn_id : reader.active;
            const turn = id ? reader.turns.get(id) : null;
            if (turn && ts >= turn.started) { turn.completed = ts; turn.aborted = payload.type === "task_aborted"; }
            if (id === reader.active) reader.active = null;
          }
        } else if (event.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(String(payload.type))) {
          const turn = reader.active ? reader.turns.get(reader.active) : null;
          if (turn) receipts(payload.output, turn, ts);
        }
      }
      if (!reader.verified || reader.rejected) return { note: "Codex 日志的 Session 身份不匹配" };
      if (reader.offset < stat.size) return { note: "正在读取调度生命周期记录" };
      return { reader, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      reader.file = null;
      return { note: "调度生命周期记录暂不可读" };
    }
  }

  /** Cross-turn session view for the scheduling timeline: every verified
   * Turn plus a cross-turn, multi-status receipt index. observe() keeps its
   * original narrower contract (creation turn + SUCCEEDED only). */
  sessionTimeline(caller: CallerIdentity | undefined): SessionTimeline {
    const pumped = this.pump(caller);
    if ("note" in pumped) return { turns: [], receipts: new Map(), note: pumped.note };
    const turns = [...pumped.reader.turns.values()].sort((a, b) => a.started - b.started);
    const index = new Map<string, ScheduleReceipt>();
    for (const turn of turns) {
      for (const [opId, receipt] of turn.receipts) {
        if (!index.has(opId)) index.set(opId, { turnId: turn.id, atMs: receipt.atMs, status: receipt.status });
      }
    }
    return {
      turns: turns.map((turn) => ({ turnId: turn.id, startedAtMs: turn.started, completedAtMs: turn.completed, aborted: turn.aborted })),
      receipts: index,
      note: "",
    };
  }

  observe(caller: CallerIdentity | undefined, opId: string, createdAt: string, readyAt: number | null): CallerLifecycle {
    const pumped = this.pump(caller);
    if ("note" in pumped) return unknown(pumped.note);
    const reader = pumped.reader;
    const created = Date.parse(createdAt);
    const ordered = [...reader.turns.values()].sort((a, b) => a.started - b.started);
    const turn = caller?.turn_id ? reader.turns.get(caller.turn_id) : ordered.filter((item) => item.started <= created).at(-1);
    if (!turn || !Number.isFinite(created) || created < turn.started || (turn.completed !== null && created > turn.completed)) return unknown("无法将本次操作绑定到调度 Turn");
    const hasLaterTurn = ordered.some((item) => item.started > turn.started);
    const receipt = turn.receipts.get(opId) ?? null;
    const received = receipt && receipt.status === "SUCCEEDED" ? receipt.atMs : null;
    return {
      status: turn.completed !== null ? turn.aborted ? "aborted" : "completed" : hasLaterTurn ? "unknown" : "running",
      turnId: turn.id, startedAtMs: turn.started, completedAtMs: turn.completed,
      receivedAtMs: received !== null && (readyAt === null || received >= readyAt) ? received : null,
      observedAtMs: pumped.mtimeMs,
      note: "来自匹配 Session/Turn 的宿主生命周期事件；未观测的时间点保持为空",
    };
  }
}
