import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tryLock, unlock } from "fs-native-extensions";
import {
  type Action,
  type Data,
  type Operation,
  type Task,
  IDENTIFIER_PATTERN,
  PROVIDERS,
  TERMINAL_STATES,
  integer,
  isObject,
  object,
  records,
  string,
} from "./contracts.js";
import { parseMcodeModel, resolveRetryPlan } from "./config.js";
import {
  AgentLordError,
  errorCode,
  errorMessage,
  usageError,
} from "./errors.js";
import { parseJson, stringifyJson } from "./json.js";
import { resolvePath } from "./paths.js";

export function utcNow(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}
export function stateDir(): string {
  return process.env.AGENT_LORD_STATE_DIR
    ? resolvePath(process.env.AGENT_LORD_STATE_DIR)
    : path.join(homedir(), ".codex/state/agent-lord");
}
export function validateIdentifier(name: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER_PATTERN.test(value) ||
    value.endsWith("\n")
  )
    throw usageError(
      `${name} must start with an alphanumeric character and use only letters, digits, dot, underscore, or hyphen`,
      { [name]: value },
    );
  return value;
}
export function ensureLayout(root = stateDir()): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const child of [
    "operations",
    "actions",
    "events",
    "artifacts",
    "logs",
    "locks",
    "tmp",
  ])
    mkdirSync(path.join(root, child), { recursive: true, mode: 0o700 });
  return root;
}
export function taskPath(id: string, root = stateDir()): string {
  return path.join(root, `${validateIdentifier("task_id", id)}.json`);
}
export function operationPath(id: string, root = stateDir()): string {
  return path.join(
    root,
    "operations",
    `${validateIdentifier("operation_id", id)}.json`,
  );
}
export function actionPath(id: string, root = stateDir()): string {
  return path.join(
    root,
    "actions",
    `${validateIdentifier("action_id", id)}.json`,
  );
}
export function eventPath(id: string, root = stateDir()): string {
  return path.join(
    root,
    "events",
    `${validateIdentifier("task_id", id)}.jsonl`,
  );
}
export function syncDirectory(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    closeSync(fd);
  }
}
export function atomicWrite(
  file: string,
  text: string,
  exclusive = false,
): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    if (exclusive) {
      try {
        linkSync(temporary, file);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        throw new AgentLordError(
          "IDENTITY_CONFLICT",
          "state record already exists",
          { details: { path: file }, exit_code: 2 },
        );
      }
    } else renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
export function writeJson(
  file: string,
  value: unknown,
  exclusive = false,
): void {
  atomicWrite(file, `${stringifyJson(value, 2)}\n`, exclusive);
}
export function readJson(
  file: string,
  missingCode: string,
  missingMessage: string,
): Data {
  let value: unknown;
  try {
    value = parseJson(readFileSync(file, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      throw new AgentLordError(missingCode, missingMessage, {
        details: { path: file },
        exit_code: 2,
      });
    throw new AgentLordError("STATE_CORRUPT", "cannot read state record", {
      details: { path: file, error: errorMessage(error) },
    });
  }
  if (!isObject(value))
    throw new AgentLordError(
      "STATE_CORRUPT",
      "state record is not a JSON object",
      { details: { path: file } },
    );
  return value;
}
export interface Lease {
  release(): void;
}
/** Leases belong to an open descriptor, never a timer or an in-memory mutex. */
export function recordLock(
  kind: string,
  id: string,
  root = stateDir(),
  shared = false,
): Lease {
  ensureLayout(root);
  const file = path.join(
    root,
    "locks",
    `${validateIdentifier(`${kind}_id`, id)}.lock`,
  );
  const fd = openSync(file, "a+", 0o600);
  let acquired = false;
  let closed = false;
  try {
    acquired = tryLock(fd, { shared: shared && sharedLocksSupported() });
    if (!acquired)
      throw new AgentLordError(
        "STATE_BUSY",
        "another process is updating this record",
        {
          retryable: true,
          safe_recovery: "RETRY_SAME_COMMAND",
          details: { record_kind: kind, record_id: id },
        },
      );
    if (!shared) {
      ftruncateSync(fd, 0);
      writeSync(fd, `${process.pid}\n`, 0, "utf8");
      fsyncSync(fd);
    }
  } catch (error) {
    if (acquired) unlock(fd);
    closeSync(fd);
    throw error;
  }
  return {
    release() {
      if (closed) return;
      closed = true;
      try {
        unlock(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}
export function sharedLocksSupported(): boolean {
  return process.platform !== "win32";
}
export function withLock<T>(
  kind: string,
  id: string,
  root: string,
  fn: () => T,
): T {
  const lease = recordLock(kind, id, root);
  try {
    return fn();
  } finally {
    lease.release();
  }
}
export async function withAsyncLock<T>(
  kind: string,
  id: string,
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lease = recordLock(kind, id, root);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}
function shape(
  value: Data,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    required.every((k) => k in value) &&
    Object.keys(value).every(
      (k) => required.includes(k) || optional.includes(k),
    )
  );
}
function validText(value: unknown): value is string {
  return Boolean(string(value) && !(value as string).includes("\0"));
}
function corrupt(message: string): never {
  throw new AgentLordError("STATE_CORRUPT", message);
}
export function normalizeTask(raw: unknown): Task {
  if (!isObject(raw)) return corrupt("task record is not a JSON object");
  const value = raw;
  if (value.version === 1) {
    if (
      !shape(value, [
        "version",
        "task_id",
        "provider",
        "endpoint_id",
        "host_id",
        "target",
        "created_at",
      ])
    )
      return corrupt("version 1 task record has an unexpected shape");
    if (!validText(value.task_id) || !IDENTIFIER_PATTERN.test(value.task_id))
      return corrupt("version 1 task record has an invalid task_id");
    if (!["claude-cli", "codex-app"].includes(String(value.provider)))
      return corrupt("version 1 task record has an unsupported provider");
    for (const key of ["endpoint_id", "target", "created_at"])
      if (!validText(value[key]))
        return corrupt(`version 1 task record has an invalid ${key}`);
    if (
      value.provider === "codex-app"
        ? !validText(value.host_id)
        : value.host_id !== null
    )
      return corrupt("version 1 task record has an invalid host_id");
    const created = value.created_at as string;
    const host = value.host_id as string | null;
    return {
      version: 2,
      task_id: value.task_id,
      provider: value.provider as Task["provider"],
      endpoint_id: value.endpoint_id as string,
      target: value.target as string,
      route: {
        host_id: host,
        resolved_at: created,
        history: host
          ? [{ host_id: host, observed_at: created, reason: "v1-import" }]
          : [],
      },
      contract: {
        model: null,
        effort: null,
        read_only: false,
        permission_mode: null,
        source: {},
        retry_plan: [],
      },
      created_at: created,
      updated_at: created,
      last_operation_id: null,
      legacy_version: 1,
    };
  }
  if (value.version !== 2)
    return corrupt("task record has an unsupported version");
  if (
    !shape(
      value,
      [
        "version",
        "task_id",
        "provider",
        "endpoint_id",
        "target",
        "route",
        "contract",
        "created_at",
        "updated_at",
        "last_operation_id",
      ],
      ["lineage"],
    )
  )
    return corrupt(
      "version 2 task record is incomplete or has unexpected fields",
    );
  if (
    !validText(value.task_id) ||
    !IDENTIFIER_PATTERN.test(value.task_id) ||
    value.task_id.endsWith("\n")
  )
    return corrupt("task record has an invalid task_id");
  if (!PROVIDERS.includes(value.provider as Task["provider"]))
    return corrupt("task record has an unsupported provider");
  for (const key of ["endpoint_id", "target", "created_at", "updated_at"])
    if (!validText(value[key]))
      return corrupt(`task record has an invalid ${key}`);
  const route = object(value.route);
  if (
    !Array.isArray(route.history) ||
    !validText(route.resolved_at) ||
    (route.host_id !== null && !validText(route.host_id))
  )
    return corrupt("task record has an invalid route");
  if (value.provider === "codex-app" ? !route.host_id : route.host_id !== null)
    return corrupt("task record has an invalid host_id");
  const contract = object(value.contract);
  const legacy = ["model", "effort", "read_only", "permission_mode", "source"];
  if (shape(contract, legacy))
    contract.retry_plan = resolveRetryPlan(
      value.provider as Task["provider"],
      contract.model as string | null,
    );
  if (
    !shape(
      contract,
      [...legacy, "retry_plan"],
      ["workspace", "parallel_plan", "continuation_limit"],
    )
  )
    return corrupt("task record has an invalid execution contract");
  for (const key of ["model", "effort"])
    if (contract[key] !== null && !validText(contract[key]))
      return corrupt(`task contract has an invalid ${key}`);
  if (
    typeof contract.read_only !== "boolean" ||
    !validText(contract.permission_mode) ||
    contract.read_only !== (contract.permission_mode === "read_only") ||
    !isObject(contract.source)
  )
    return corrupt("task contract has invalid permissions or source");
  if (
    "continuation_limit" in contract &&
    (value.provider !== "mcode-cli" ||
      !integer(contract.continuation_limit) ||
      contract.continuation_limit < 0 ||
      contract.continuation_limit > 5)
  )
    return corrupt("task has an invalid continuation limit");
  if (value.provider === "mcode-cli") {
    try {
      parseMcodeModel(contract.model);
    } catch {
      return corrupt("MCode task contract has an invalid model");
    }
    if (
      contract.effort !== null ||
      contract.read_only ||
      contract.permission_mode !== "dangerously_bypass"
    )
      return corrupt(
        "MCode task contract has an unsupported effort or permission posture",
      );
  }
  if (
    Object.entries(contract.source).some(
      ([k, v]) =>
        !["head_sha", "base_sha", "verified_head_sha"].includes(k) ||
        typeof v !== "string" ||
        !/^[0-9a-f]{40}$/.test(v) ||
        v.length !== 40,
    )
  )
    return corrupt("task contract has an invalid source fingerprint");
  if (
    "verified_head_sha" in contract.source &&
    !("head_sha" in contract.source)
  )
    return corrupt("task contract advanced a source head it never froze");
  if (
    !Array.isArray(contract.retry_plan) ||
    !contract.retry_plan.length ||
    contract.retry_plan.some(
      (v) =>
        !isObject(v) ||
        !shape(v, ["model", "attempts"]) ||
        (v.model !== null && !validText(v.model)) ||
        !integer(v.attempts) ||
        v.attempts <= 0,
    )
  )
    return corrupt("task contract has an invalid retry plan");
  for (const key of ["workspace", "parallel_plan"])
    if (key in contract && !isObject(contract[key]))
      return corrupt("task contract has invalid workspace metadata");
  const workspace = object(contract.workspace);
  if (Object.keys(workspace).length) {
    const fields =
      workspace.policy === "exact-target"
        ? ["policy"]
        : workspace.policy === "isolated"
          ? ["policy", "repository", "source_branch", "workspace_branch"]
          : ["policy", "repository", "source_branch"];
    if (
      ![
        "exact-target",
        "reuse-or-create",
        "shared-readonly",
        "isolated",
      ].includes(String(workspace.policy)) ||
      !shape(workspace, fields) ||
      fields.some((k) => !validText(workspace[k]))
    )
      return corrupt("task contract has invalid workspace metadata");
  }
  const plan = object(contract.parallel_plan);
  if (Object.keys(plan).length) {
    const common = ["group", "role", "integration_target_branch"];
    const fields =
      plan.role === "worker"
        ? [...common, "integrator_task_id", "integration_order"]
        : plan.role === "integrator"
          ? [...common, "integration_workers"]
          : [];
    if (
      !fields.length ||
      !shape(plan, fields) ||
      fields
        .filter(
          (k) => !["integration_order", "integration_workers"].includes(k),
        )
        .some((k) => !validText(plan[k]))
    )
      return corrupt("task contract has an invalid parallel plan");
    if (
      plan.role === "worker" &&
      (!integer(plan.integration_order) || plan.integration_order < 1)
    )
      return corrupt("task contract has an invalid integration order");
    const workers = plan.integration_workers;
    if (
      plan.role === "integrator" &&
      (!Array.isArray(workers) ||
        !workers.length ||
        workers.some((v) => !validText(v)) ||
        new Set(workers).size !== workers.length)
    )
      return corrupt("task contract has an invalid integration worker list");
  }
  if (
    value.last_operation_id !== null &&
    (!validText(value.last_operation_id) ||
      !IDENTIFIER_PATTERN.test(value.last_operation_id))
  )
    return corrupt("task record has an invalid last_operation_id");
  if (value.lineage !== undefined) {
    const lineage = object(value.lineage);
    if (
      !shape(lineage, [
        "kind",
        "handoff_id",
        "handoff_operation_id",
        "packet_sha256",
        "source_session_kind",
        "source_session_id",
        "source_session_identity",
        "relationship",
      ]) ||
      lineage.kind !== "handoff" ||
      lineage.relationship !== "continues_user_task" ||
      !["handoff_id", "handoff_operation_id"].every(
        (k) =>
          validText(lineage[k]) &&
          IDENTIFIER_PATTERN.test(lineage[k] as string),
      ) ||
      typeof lineage.packet_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(lineage.packet_sha256) ||
      !validText(lineage.source_session_kind) ||
      !["caller-declared", "unavailable"].includes(
        String(lineage.source_session_identity),
      ) ||
      (lineage.source_session_id !== null &&
        !validText(lineage.source_session_id)) ||
      (lineage.source_session_identity === "caller-declared") !==
        (lineage.source_session_id !== null)
    )
      return corrupt("task record has an invalid handoff lineage");
  }
  return value as unknown as Task;
}
export class StateStore {
  readonly root: string;
  constructor(root = stateDir()) {
    this.root = ensureLayout(resolvePath(root));
  }
  task(id: string): Task {
    const value = normalizeTask(
      readJson(taskPath(id, this.root), "TASK_UNKNOWN", "unknown task_id"),
    );
    if (value.task_id !== id)
      return corrupt("task record identity does not match its filename");
    return value;
  }
  createTask(task: Task): Task {
    normalizeTask(task);
    writeJson(taskPath(task.task_id, this.root), task, true);
    return task;
  }
  updateTask(id: string, mutate: (value: Task) => Task): Task {
    return withLock("task", id, this.root, () => {
      const value = mutate(this.task(id));
      value.version = 2;
      value.updated_at = utcNow();
      delete value.legacy_version;
      normalizeTask(value);
      writeJson(taskPath(id, this.root), value);
      return value;
    });
  }
  removeTask(id: string): Task {
    return withLock("task", id, this.root, () => {
      const value = this.task(id);
      unlinkSync(taskPath(id, this.root));
      syncDirectory(this.root);
      return value;
    });
  }
  operation(id: string): Operation {
    return readJson(
      operationPath(id, this.root),
      "OPERATION_UNKNOWN",
      "unknown operation_id",
    ) as unknown as Operation;
  }
  createOperation(value: Operation): Operation {
    writeJson(operationPath(value.operation_id, this.root), value, true);
    return value;
  }
  updateOperation(
    id: string,
    mutate: (value: Operation) => Operation,
  ): Operation {
    return withLock("operation", id, this.root, () => {
      const value = mutate(this.operation(id));
      value.updated_at = utcNow();
      writeJson(operationPath(id, this.root), value);
      return value;
    });
  }
  action(id: string): Action {
    return readJson(
      actionPath(id, this.root),
      "ACTION_UNKNOWN",
      "unknown action_id",
    ) as unknown as Action;
  }
  createAction(value: Action): Action {
    writeJson(actionPath(value.action_id, this.root), value, true);
    return value;
  }
  updateAction(id: string, mutate: (value: Action) => Action): Action {
    return withLock("action", id, this.root, () => {
      const value = mutate(this.action(id));
      value.updated_at = utcNow();
      writeJson(actionPath(id, this.root), value);
      return value;
    });
  }
  paths(kind: "operations" | "actions"): string[] {
    return readdirSync(path.join(this.root, kind))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => path.join(this.root, kind, f));
  }
  operations(taskId?: string): Operation[] {
    return this.paths("operations")
      .map(
        (file) =>
          readJson(
            file,
            "OPERATION_UNKNOWN",
            "operation disappeared",
          ) as unknown as Operation,
      )
      .filter((v) => taskId === undefined || v.task_id === taskId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  actions(operationId: string): Action[] {
    return this.paths("actions")
      .map(
        (file) =>
          readJson(
            file,
            "ACTION_UNKNOWN",
            "action disappeared",
          ) as unknown as Action,
      )
      .filter((v) => v.operation_id === operationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  tasks(): Task[] {
    return readdirSync(this.root)
      .filter((f) => f.endsWith(".json"))
      .map((f) =>
        normalizeTask(
          readJson(path.join(this.root, f), "TASK_UNKNOWN", "task disappeared"),
        ),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  pendingAction(id: string): Action | undefined {
    return this.actions(id)
      .reverse()
      .find((v) => v.status === "pending");
  }
  inflight(id: string, hash: string): Operation | undefined {
    return this.operations(id)
      .reverse()
      .find((v) => v.message_sha256 === hash && !TERMINAL_STATES.has(v.status));
  }
  hasTask(id: string): boolean {
    return existsSync(taskPath(id, this.root));
  }
  event(
    taskId: string,
    type: string,
    data: Data,
    operationId: string | null = null,
  ): void {
    withLock("event", taskId, this.root, () => {
      const fd = openSync(eventPath(taskId, this.root), "a", 0o600);
      try {
        const bytes = Buffer.from(
          `${stringifyJson({ timestamp: utcNow(), task_id: taskId, operation_id: operationId, type, data })}\n`,
        );
        let offset = 0;
        while (offset < bytes.length)
          offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  }
}
