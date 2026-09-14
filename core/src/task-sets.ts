import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentLord } from "./engine.js";
import {
  type Envelope,
  type Data,
  TERMINAL_STATES,
  isObject,
} from "./contracts.js";
import { sha256 } from "./json.js";
import { AgentLordError, usageError } from "./errors.js";
import {
  readJson,
  writeJson,
  withLock,
  validateIdentifier,
  utcNow,
} from "./state.js";
import { CheckpointScan } from "./checkpoint-scan.js";
import { operationResultKey } from "./result-key.js";

interface Receipt {
  operation_id: string;
  result_key: string;
  acknowledged: boolean;
}
interface TaskSet {
  version: 1;
  run_id: string;
  task_ids: string[];
  receipts: Record<string, Receipt>;
  created_at: string;
  updated_at: string;
}
/** Passive task membership and explicit result acknowledgements; never dispatches work. */
export class TaskSets {
  constructor(private readonly lord: AgentLord) {}
  private file(id: string): string {
    return path.join(
      this.lord.root,
      "task-sets",
      `${validateIdentifier("run_id", id)}.json`,
    );
  }
  private read(id: string): TaskSet {
    const raw = readJson(
      this.file(id),
      "RUN_UNKNOWN",
      "task set does not exist",
    );
    if (
      raw.version !== 1 ||
      raw.run_id !== id ||
      !Array.isArray(raw.task_ids) ||
      !raw.task_ids.length ||
      !isObject(raw.receipts)
    )
      throw new AgentLordError("STATE_CORRUPT", "invalid task set record");
    raw.task_ids.forEach((v) => validateIdentifier("task_id", v));
    for (const [token, value] of Object.entries(raw.receipts)) {
      if (
        !isObject(value) ||
        typeof value.result_key !== "string" ||
        typeof value.acknowledged !== "boolean" ||
        token !== sha256(`${id}\0${value.result_key}`)
      )
        throw new AgentLordError("STATE_CORRUPT", "invalid task set receipt");
      validateIdentifier("operation_id", value.operation_id);
    }
    return raw as unknown as TaskSet;
  }
  private persist(record: TaskSet): void {
    mkdirSync(path.dirname(this.file(record.run_id)), {
      recursive: true,
      mode: 0o700,
    });
    writeJson(this.file(record.run_id), { ...record, updated_at: utcNow() });
  }
  create(id: string, taskIds: string[], append = false): Envelope {
    this.file(id);
    if (!Array.isArray(taskIds) || !taskIds.length)
      throw usageError("at least one task-id is required");
    const ids = [
      ...new Set(taskIds.map((v) => validateIdentifier("task_id", v))),
    ].sort();
    withLock("task-set", id, this.lord.root, () => {
      if (existsSync(this.file(id))) {
        const record = this.read(id);
        if (append)
          this.persist({
            ...record,
            task_ids: [...new Set([...record.task_ids, ...ids])].sort(),
          });
        else if (JSON.stringify(record.task_ids) !== JSON.stringify(ids))
          throw new AgentLordError(
            "RUN_EXISTS",
            "task set already has different members; use run-add for explicit additions",
          );
      } else {
        if (append)
          throw new AgentLordError("RUN_UNKNOWN", "task set does not exist");
        const now = utcNow();
        this.persist({
          version: 1,
          run_id: id,
          task_ids: ids,
          receipts: {},
          created_at: now,
          updated_at: now,
        });
      }
    });
    return this.status(id);
  }
  status(id: string): Envelope {
    const record = this.read(id);
    const scan = new CheckpointScan(this.lord.store);
    scan.tick(record.task_ids);
    const latest = new Map(
      scan.latest(record.task_ids).map((op) => [op.task_id, op]),
    );
    const tasks = record.task_ids.map((task_id) => {
      const op = latest.get(task_id);
      const key =
        op && TERMINAL_STATES.has(op.status)
          ? operationResultKey(op)
          : undefined;
      const receipt = key
        ? record.receipts[sha256(`${id}\0${key}`)]
        : undefined;
      return {
        task_id,
        operation_id: op?.operation_id ?? null,
        status: op?.status ?? "not_observed",
        delivery: op?.delivery?.status ?? "unverified",
        acknowledged: receipt?.acknowledged ?? false,
      };
    });
    return {
      version: 1,
      status: "RUN_RECORD",
      run: {
        run_id: id,
        task_ids: record.task_ids,
        tasks,
        all_terminal: tasks.every((t) => TERMINAL_STATES.has(t.status)),
        all_results_acknowledged: tasks.every(
          (t) => TERMINAL_STATES.has(t.status) && t.acknowledged,
        ),
      },
    };
  }
  ack(id: string, receipt: string): Envelope {
    withLock(
      "task-set",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        if (!Object.hasOwn(record.receipts, receipt))
          throw new AgentLordError(
            "RECEIPT_UNKNOWN",
            "receipt was not issued by this task set",
          );
        record.receipts[receipt]!.acknowledged = true;
        this.persist(record);
      },
    );
    return this.status(id);
  }
  async checkpoint(id: string, seconds: number): Promise<[Envelope, boolean]> {
    const record = this.read(id);
    const consumed = new Set(
      Object.values(record.receipts)
        .filter((r) => r.acknowledged)
        .map((r) => r.result_key),
    );
    // Members may be registered before dispatch; checkpoint still supervises known ones.
    const [result, quiet] = await this.lord.checkpoint(
      undefined,
      seconds,
      record.task_ids,
      consumed,
    );
    if (result.actionable?.some((e) => typeof e.result_key === "string")) {
      withLock("task-set", id, this.lord.root, () => {
        const current = this.read(id);
        for (const envelope of result.actionable ?? []) {
          if (typeof envelope.result_key !== "string" || !envelope.operation_id)
            continue;
          const token = sha256(`${id}\0${envelope.result_key}`);
          current.receipts[token] ??= {
            operation_id: envelope.operation_id,
            result_key: envelope.result_key,
            acknowledged: false,
          };
          envelope.receipt = token;
        }
        this.persist(current);
      });
    }
    result.run = this.status(id).run as Data;
    return [result, quiet];
  }
}
