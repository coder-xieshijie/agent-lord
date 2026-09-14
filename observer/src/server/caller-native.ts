/** Session-bound, read-only metadata for native MCode and Claude schedulers.
 * Transcript bodies never leave this module. No latest-session guessing. */
import { readdirSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import type { ScheduleReceipt, ScheduleTurn } from "../shared/types.js";
import type { SessionTimeline } from "./caller-lifecycle.js";
import { collectReceipts } from "./caller-receipts.js";
import { readCompleteLines } from "./scan.js";
import { clipTitle } from "./sanitize.js";

interface Snapshot {
  name: string | null;
  projectName: string | null;
  observedAtMs: number | null;
  timeline: SessionTimeline;
  lifecycleKnown: boolean;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const title = (v: unknown): string | null => typeof v === "string" ? clipTitle(v) || null : null;
const project = (v: unknown): string | null => typeof v === "string" ? title(path.basename(v)) : null;
const empty = (note: string): Snapshot => ({ name: null, projectName: null, observedAtMs: null, lifecycleKnown: false, timeline: { turns: [], receipts: new Map(), note } });
const timestamp = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const MAX_TURNS = 1000;

interface ClaudeState {
  file: string; inode: number; offset: number; verified: boolean;
  name: string | null; projectName: string | null; active: ScheduleTurn | null;
  turns: ScheduleTurn[]; receipts: Map<string, ScheduleReceipt>;
  pendingStop: boolean;
}

export class NativeCallerReader {
  private cache = new Map<string, { at: number; value: Snapshot }>();
  private claude = new Map<string, ClaudeState>();

  read(caller: CallerIdentity): Snapshot {
    if (!["mcode", "claude"].includes(caller.kind) || !caller.session_id
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(caller.session_id)
      || !caller.data_root || !path.isAbsolute(caller.data_root)) return empty("未记录可核验的调度客户端、Session 和数据根");
    const key = `${caller.kind}\0${caller.data_root}\0${caller.session_id}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 1000) return cached.value;
    let value: Snapshot;
    try { value = caller.kind === "mcode" ? this.mcode(caller) : this.readClaude(caller, key); }
    catch { value = empty("调度会话记录暂不可读或格式不支持"); }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private mcode(caller: CallerIdentity): Snapshot {
    const file = path.join(caller.data_root!, "v2", "sqlite", "runtime-state.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      // A consistent read snapshot; never create, migrate or update client state.
      db.exec("BEGIN");
      const session = db.prepare("SELECT title, workspace_dir FROM local_runtime_sessions WHERE session_id = ?").get(caller.session_id!);
      if (!session) return empty("MCode 数据根中没有匹配的 Session");
      const result = empty("");
      result.name = title(session.title); result.projectName = project(session.workspace_dir);
      result.observedAtMs = Date.now(); result.lifecycleKnown = true;
      const rows = db.prepare("SELECT turn_id, status, accepted_at_ms, completed_at_ms FROM local_runtime_turn_ingress WHERE session_id = ? ORDER BY accepted_at_ms DESC LIMIT ?").all(caller.session_id!, MAX_TURNS + 1);
      if (rows.length > MAX_TURNS) result.timeline.note = "仅展示最近 1000 个调度回合";
      result.timeline.turns = rows.slice(0, MAX_TURNS).reverse().flatMap((row) => {
        const started = timestamp(row.accepted_at_ms);
        const ended = timestamp(row.completed_at_ms);
        if (typeof row.turn_id !== "string" || started === null) return [];
        return [{ turnId: row.turn_id, startedAtMs: started,
          completedAtMs: row.status !== "accepted" && ended !== null && ended >= started ? ended : null,
          aborted: row.status === "aborted" || row.status === "failed" }];
      });
      // Stored display-message timestamps precede tool completion. They cannot
      // establish an exact receipt time; leave that index empty rather than
      // label a tool-call start as receipt of its eventual result.
      result.timeline.note ||= "MCode 回合状态来自持久化 ingress；工具回执时间未记录";
      return result;
    } finally { db.close(); }
  }

  private receive(value: unknown, turnId: string, ts: number, index: Map<string, ScheduleReceipt>): void {
    const found = { receipts: new Map<string, { atMs: number; status: ScheduleReceipt["status"] }>() };
    collectReceipts(value, found, ts);
    for (const [id, receipt] of found.receipts) if (!index.has(id)) index.set(id, { ...receipt, turnId });
    while (index.size > 1000) index.delete(index.keys().next().value!);
  }

  private readClaude(caller: CallerIdentity, key: string): Snapshot {
    let state = this.claude.get(key);
    const file = state?.file ?? locateClaudeSession(caller.data_root!, caller.session_id!);
    if (!file) return empty("未找到唯一匹配的 Claude Code Session 日志");
    let stat;
    try { stat = statSync(file); } catch { this.claude.delete(key); return empty("Claude Code 日志暂不可读"); }
    if (!state || state.inode !== stat.ino || stat.size < state.offset) {
      state = { file, inode: stat.ino, offset: 0, verified: false, name: null, projectName: null,
        active: null, turns: [], receipts: new Map(), pendingStop: false };
      this.claude.set(key, state);
    }
    const tail = readCompleteLines(file, state.offset);
    state.offset = tail.offset;
    for (const line of tail.lines) {
      let event;
      try { event = object(JSON.parse(line)); } catch { continue; }
      // Forked transcripts can contain another session's history and sidechains.
      if (event.sessionId !== caller.session_id || event.isSidechain === true) continue;
      state.verified = true;
      if (event.type === "custom-title") state.name = title(event.customTitle) ?? state.name;
      state.projectName = project(event.cwd) ?? state.projectName;
      const ts = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;
      const message = object(event.message);
      const content = message.content;
      const toolResults = Array.isArray(content) ? content.filter((item) => object(item).type === "tool_result") : [];
      if (event.type === "user" && toolResults.length) {
        if (state.active) for (const tool of toolResults) this.receive(object(tool).content, state.active.turnId, ts, state.receipts);
      } else if (event.type === "user" && event.isMeta !== true && typeof event.uuid === "string") {
        const text = typeof content === "string" ? content : Array.isArray(content)
          ? content.map((item) => object(item).type === "text" ? object(item).text : "").filter((v) => typeof v === "string").join(" ") : "";
        state.name ??= title(text);
        // UUID identifies a concrete user ingress; duplicate appends do not re-open it.
        if (state.turns.some((turn) => turn.turnId === event.uuid)) continue;
        state.active = { turnId: event.uuid, startedAtMs: ts, completedAtMs: null, aborted: false };
        state.turns.push(state.active); state.pendingStop = false;
        if (state.turns.length > MAX_TURNS) state.turns.shift();
      } else if (event.type === "assistant" && state.active) {
        state.pendingStop = message.stop_reason === "end_turn";
      } else if (event.type === "system" && event.subtype === "turn_duration" && state.active && ts >= state.active.startedAtMs) {
        state.active.completedAtMs = ts; state.active = null; state.pendingStop = false;
      }
    }
    if (!state.verified) return empty("Claude Code 日志的 Session 身份不匹配");
    return { name: state.name, projectName: state.projectName, observedAtMs: stat.mtimeMs,
      lifecycleKnown: state.offset >= stat.size && !state.pendingStop,
      timeline: { turns: state.turns.map((turn) => ({ ...turn })), receipts: new Map(state.receipts),
        note: state.offset < stat.size ? "正在读取 Claude Code 调度日志"
          : state.pendingStop ? "已观测模型回答结束，尚无 Claude Code 回合结束事件" : "" } };
  }
}

/** Restrict discovery to top-level project transcripts, excluding subagents. */
function locateClaudeSession(root: string, session: string): string | null {
  const found: string[] = [];
  let count = 0;
  try {
    const projects = path.join(root, "projects");
    for (const dir of readdirSync(projects, { withFileTypes: true })) {
      if (++count > 50_000) return null;
      if (!dir.isDirectory()) continue;
      const file = path.join(projects, dir.name, `${session}.jsonl`);
      // Dirent.isFile avoids following a transcript symlink outside the data root.
      try { if (lstatSync(file).isFile()) found.push(file); } catch { /* no matching session here */ }
    }
  } catch { return null; }
  return found.length === 1 ? found[0] : null;
}
