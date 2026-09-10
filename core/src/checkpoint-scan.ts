import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  type Action,
  type Data,
  type Operation,
  type Task,
  TERMINAL_STATES,
  integer,
  object,
  string,
} from "./contracts.js";
import { AgentLordError } from "./errors.js";
import { StateStore, normalizeTask, readJson } from "./state.js";

export type ActiveOperation = {
  task_id: string;
  provider: Operation["provider"];
  operation: Operation;
};
/** Parse once per tick; immutable ownership lets later ticks skip unrelated records. */
export class CheckpointScan {
  private owners = new Map<string, string>();
  private actionOwners = new Map<string, string>();
  private byId = new Map<string, Operation>();
  private pending = new Map<string, Action>();
  /** Parsed JSON keyed by path, reused while the file stat stays unchanged. */
  private fileCache = new Map<string, { key: string; value: unknown }>();
  /** Per-instance parse accounting so tests can prove unchanged files are not re-parsed. */
  readonly stats = { parsed: 0, reused: 0 };
  tasks: Task[] = [];
  operations: Operation[] = [];
  known = new Set<string>();
  constructor(private readonly store: StateStore) {}
  /**
   * Parse `file` only when its stat identity changed since the last tick.
   * The stat is taken before the read: if the file is atomically replaced
   * between the two, the cache stores the fresh value under the stale key and
   * the next tick simply re-parses. Records are written via atomic replace,
   * so (mtimeMs,size,ino) changes on every cross-process update; a stat
   * failure (for example deletion between readdir and read) falls through to
   * the original uncached read and keeps its error contract.
   */
  private cachedJson<T>(file: string, parse: () => T): T {
    let key: string | null = null;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      key = null;
    }
    if (key !== null) {
      const hit = this.fileCache.get(file);
      if (hit && hit.key === key) {
        this.stats.reused += 1;
        return hit.value as T;
      }
    }
    const value = parse();
    this.stats.parsed += 1;
    if (key !== null) this.fileCache.set(file, { key, value });
    return value;
  }
  tick(selected?: string[]): void {
    const selection = selected ? new Set(selected) : undefined;
    this.tasks = readdirSync(this.store.root)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        const file = path.join(this.store.root, f);
        return this.cachedJson(file, () =>
          normalizeTask(readJson(file, "TASK_UNKNOWN", "task disappeared")),
        );
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    this.operations = [];
    this.known = new Set(this.tasks.map((v) => v.task_id));
    for (const file of this.store.paths("operations")) {
      const owner = this.owners.get(file);
      if (owner) this.known.add(owner);
      if (owner && selection && !selection.has(owner)) continue;
      const op = this.cachedJson(
        file,
        () =>
          readJson(
            file,
            "OPERATION_UNKNOWN",
            "operation disappeared",
          ) as unknown as Operation,
      );
      if (string(op.task_id)) {
        this.owners.set(file, op.task_id);
        this.known.add(op.task_id);
      }
      this.operations.push(op);
    }
    this.operations.sort((a, b) => a.created_at.localeCompare(b.created_at));
    this.byId = new Map(this.operations.map((v) => [v.operation_id, v]));
    this.pending.clear();
    for (const file of this.store.paths("actions")) {
      const owner = this.actionOwners.get(file);
      if (owner && selection && !selection.has(owner)) continue;
      const action = this.cachedJson(
        file,
        () =>
          readJson(
            file,
            "ACTION_UNKNOWN",
            "action disappeared",
          ) as unknown as Action,
      );
      const task = this.owners.get(
        path.join(this.store.root, "operations", `${action.operation_id}.json`),
      );
      if (task) this.actionOwners.set(file, task);
      if (action.status !== "pending") continue;
      const current = this.pending.get(action.operation_id);
      if (
        !current ||
        `${action.created_at}\0${action.action_id}` >=
          `${current.created_at}\0${current.action_id}`
      )
        this.pending.set(action.operation_id, action);
    }
  }
  operation(id: string): Operation {
    let op = this.byId.get(id);
    if (!op) {
      op = this.store.operation(id);
      this.byId.set(id, op);
    }
    return op;
  }
  action(id: string): Action | undefined {
    return this.pending.get(id);
  }
  /**
   * `lenient` holds explicitly declared starting ids. They may legitimately
   * have no record yet, so they are excluded from the strict unknown check
   * that still protects ordinary `--task-id` typos.
   */
  active(selected?: string[], lenient?: Iterable<string>): ActiveOperation[] {
    const allowed = new Set(lenient ?? []);
    const unknown = selected?.filter(
      (id) => !this.known.has(id) && !allowed.has(id),
    );
    if (unknown?.length)
      throw new AgentLordError(
        "TASK_UNKNOWN",
        "checkpoint contains an unknown task_id",
        { details: { task_ids: unknown }, exit_code: 2 },
      );
    const tasks = new Map(this.tasks.map((v) => [v.task_id, v]));
    return this.operations
      .filter(
        (op) =>
          !TERMINAL_STATES.has(op.status) &&
          (!selected || selected.includes(op.task_id)) &&
          (!tasks.has(op.task_id) ||
            tasks.get(op.task_id)!.last_operation_id === op.operation_id),
      )
      .map((operation) => ({
        task_id: operation.task_id,
        provider: operation.provider,
        operation,
      }));
  }
  /**
   * The startup stage this id has reached in the current tick. The three
   * stages are distinct on purpose: worktree preparation runs before the
   * operation record exists, the operation record exists well before the
   * provider endpoint is durable, and only a task record proves the endpoint
   * identity was persisted.
   */
  observedPhase(taskId: string): Data {
    const task = this.tasks.find((v) => v.task_id === taskId);
    const owned = this.operations.filter((v) => v.task_id === taskId);
    const last = owned[owned.length - 1];
    const phase = task
      ? "task_established"
      : last
        ? "operation_recorded"
        : "not_observed";
    const result: Data = {
      task_id: taskId,
      phase,
      operation_id: task?.last_operation_id ?? last?.operation_id ?? null,
      operation_status: last?.status ?? null,
    };
    if (phase === "not_observed") {
      result.reason = "no_record_observed";
      result.detail =
        "no operation or task record was observed for this starting task_id during the window; this states only what the state directory shows, not whether the dispatch process started, is still preparing its workspace, or exited — read the dispatch command's own exit status and error envelope for that";
    }
    return result;
  }
  latest(selected: string[]): Operation[] {
    const latest = new Map<string, Operation>();
    const durable = new Set(this.tasks.map((v) => v.task_id));
    for (const task of this.tasks)
      if (task.last_operation_id && selected.includes(task.task_id))
        latest.set(task.task_id, this.operation(task.last_operation_id));
    for (const op of this.operations) {
      if (!selected.includes(op.task_id)) continue;
      const current = latest.get(op.task_id);
      if (
        !current ||
        (!durable.has(op.task_id) &&
          `${op.created_at}\0${op.operation_id}` >
            `${current.created_at}\0${current.operation_id}`)
      )
        latest.set(op.task_id, op);
    }
    return [...latest]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, op]) => op);
  }
}
export function compactActive(active: ActiveOperation[]): Data[] {
  return active.map(({ task_id, provider, operation: op }) => {
    const a = object(op.active_attempt);
    const s = object(op.observed.supervision);
    const seq = [a.progress_seq, s.progress_seq].find(integer);
    const result: Data = {
      task_id,
      operation_id: op.operation_id,
      provider,
      operation_status: op.status,
      supervision_state: s.state || a.progress_state || null,
      progress_seq: seq ?? null,
    };
    for (const key of [
      "last_event_type",
      "last_tool",
      "active_tool_count",
      "active_tools",
      "last_progress_at_ms",
    ])
      if (key in s) result[key] = s[key];
    const last = s.last_progress_at_ms || a.last_progress_at_ms;
    if (integer(last))
      result.progress_age_seconds = Math.max(
        0,
        Math.floor((Date.now() - last) / 1000),
      );
    return result;
  });
}
