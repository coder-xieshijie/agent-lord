/** Read-only display metadata for scheduling (caller) sessions.
 *
 * Sources, bounded to the data root the invocation itself declared:
 *   - thread name: newest `state_<version>.sqlite` threads.name, then
 *     session_index.jsonl (latest entry), then threads.preview / legacy title;
 *   - project name: basename of the caller session's own `cwd` from the
 *     `session_meta` head of its uniquely located rollout log.
 *
 * Only session ids already recorded by allow-listed task invocations are ever
 * looked up; other thread rows and full paths never leave the server, and
 * rollout content is never read past the session_meta line.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallerIdentity } from "@agent-lord/core/contracts";
import { locateRolloutFile } from "./caller-lifecycle.js";
import { readCompleteLines } from "./scan.js";
import { clipTitle } from "./sanitize.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const RETRY_MS = 5000;

interface IndexCache {
  mtimeMs: number;
  size: number;
  checkedAt: number;
  names: Map<string, string>;
}
interface StateTitleCache {
  checkedAt: number;
  name: string | null;
  fallback: string | null;
}
interface ProjectCache {
  lookupAt: number;
  value: string | null;
  /** Once the session_meta line was read (match or mismatch) the answer is final. */
  settled: boolean;
}

export class CallerSessionReader {
  private readonly index = new Map<string, IndexCache>();
  private readonly stateTitles = new Map<string, StateTitleCache>();
  private readonly projects = new Map<string, ProjectCache>();

  /** Best-effort {name, projectName}; every unverifiable input yields nulls. */
  read(caller: CallerIdentity | undefined): { name: string | null; projectName: string | null } {
    if (caller?.kind !== "codex" || !caller.session_id || !caller.data_root
      || !path.isAbsolute(caller.data_root) || !SESSION_ID_PATTERN.test(caller.session_id))
      return { name: null, projectName: null };
    const state = this.stateTitle(caller.data_root, caller.session_id);
    return {
      name: state.name ?? this.indexName(caller.data_root, caller.session_id) ?? state.fallback,
      projectName: this.projectName(caller.data_root, caller.session_id),
    };
  }

  private stateTitle(root: string, session: string): StateTitleCache {
    const key = `${root}\0${session}`;
    const now = Date.now();
    const cached = this.stateTitles.get(key);
    if (cached && now - cached.checkedAt < RETRY_MS) return cached;
    const entry: StateTitleCache = { checkedAt: now, name: null, fallback: null };
    this.stateTitles.set(key, entry);
    let db: DatabaseSync | undefined;
    try {
      const file = readdirSync(root, { withFileTypes: true })
        .filter((file) => file.isFile() && /^state_\d+\.sqlite$/.test(file.name))
        .sort((a, b) => Number(b.name.split("_")[1].split(".")[0]) - Number(a.name.split("_")[1].split(".")[0]))[0];
      if (!file) return entry;
      // Never create or migrate Codex state. Reopen on each retry so renames
      // committed only to the WAL are visible without a main-file mtime change.
      db = new DatabaseSync(path.join(root, file.name), { readOnly: true });
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
      const fields = ["name", "preview", "title"].filter((field) => columns.has(field));
      if (!columns.has("id") || !fields.length) return entry;
      const row = db.prepare(`SELECT ${fields.join(", ")} FROM threads WHERE id = ? LIMIT 1`).get(session);
      const title = (value: unknown): string | null => typeof value === "string" ? clipTitle(value) || null : null;
      entry.name = title(row?.name);
      entry.fallback = title(row?.preview) ?? title(row?.title);
    } catch {
      // Missing, busy, corrupt or incompatible state keeps the index fallback.
    } finally {
      db?.close();
    }
    return entry;
  }

  private indexName(root: string, session: string): string | null {
    let cache = this.index.get(root);
    const now = Date.now();
    if (!cache || now - cache.checkedAt > RETRY_MS) {
      const file = path.join(root, "session_index.jsonl");
      let stat: { mtimeMs: number; size: number } | null;
      try {
        stat = statSync(file);
      } catch {
        stat = null;
      }
      if (!stat || stat.size > MAX_INDEX_BYTES) {
        cache = { mtimeMs: -1, size: -1, checkedAt: now, names: new Map() };
      } else if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
        cache.checkedAt = now;
      } else {
        const names = new Map<string, string>();
        try {
          for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line) continue;
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              continue; // half-written trailing line
            }
            const record = value as Record<string, unknown>;
            if (record && typeof record.id === "string" && typeof record.thread_name === "string") {
              const title = clipTitle(record.thread_name);
              if (title) names.set(record.id, title); // later lines win
            }
          }
        } catch {
          // Unreadable index: honest empty result, retried next interval.
        }
        cache = { mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now, names };
      }
      this.index.set(root, cache);
    }
    return cache.names.get(session) ?? null;
  }

  private projectName(root: string, session: string): string | null {
    const key = `${root}\0${session}`;
    const cached = this.projects.get(key);
    if (cached && (cached.settled || Date.now() - cached.lookupAt < RETRY_MS)) return cached.value;
    const entry: ProjectCache = { lookupAt: Date.now(), value: null, settled: false };
    this.projects.set(key, entry);
    try {
      const file = locateRolloutFile(root, session);
      if (!file) return null;
      const head = readCompleteLines(file, 0);
      for (const line of head.lines.slice(0, 20)) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!event || event.type !== "session_meta") continue;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        entry.settled = true;
        // Never label a group with another session's project.
        if (payload.id !== session) return null;
        const base = typeof payload.cwd === "string" ? path.basename(payload.cwd) : "";
        entry.value = base && base !== path.sep ? clipTitle(base) : null;
        return entry.value;
      }
      return null; // no session_meta among head lines yet; retried later
    } catch {
      return null;
    }
  }
}
