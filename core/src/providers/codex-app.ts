import {
  type Action,
  type Data,
  type Operation,
  type Task,
  isObject,
  object,
  string,
} from "../contracts.js";
import { providerConfig } from "../config.js";
import { parseJson, stringifyJson } from "../json.js";
import { StateStore, utcNow } from "../state.js";
import { walk } from "../artifacts.js";
export const ROUTE_STALE_FRAGMENT = "No AppServerManager registered for hostId";
export function operationMarker(id: string): string {
  return `<agent_lord_operation_id>${id}</agent_lord_operation_id>`;
}
export function markedMessage(id: string, message: string): string {
  const marker = operationMarker(id);
  return message.includes(marker)
    ? message
    : `${message.trimEnd()}\n\n${marker}\n`;
}
export function operationMessage(op: Operation): string {
  const prefix = op.read_only
    ? "<agent_lord_execution_contract>\nread_only=true\nDo not modify files or perform external writes. Report any action that would require write authority instead.\n</agent_lord_execution_contract>\n\n"
    : "";
  return markedMessage(op.operation_id, prefix + op.message);
}
export class CodexAppAdapter {
  constructor(readonly store: StateStore) {}
  private action(
    op: Operation,
    kind: string,
    tool: string,
    args: Data,
    extra: Data = {},
  ): Action {
    const id = `${op.operation_id}-a${this.store.actions(op.operation_id).length + 1}`;
    const now = utcNow();
    return this.store.createAction({
      version: 1,
      action_id: id,
      operation_id: op.operation_id,
      task_id: op.task_id,
      provider: "codex-app",
      kind,
      tool,
      arguments: args,
      status: "pending",
      created_at: now,
      updated_at: now,
      ...extra,
    });
  }
  private tool(kind: string): string {
    return String(object(providerConfig("codex-app").tools)[kind]);
  }
  create(op: Operation, environment: string, branch?: string): Action {
    const env: Data = { type: environment };
    if (environment === "worktree" && branch)
      env.startingState = { type: "branch", branchName: branch };
    const args: Data = {
      prompt: operationMessage(op),
      target: { type: "project", projectId: op.target, environment: env },
    };
    if (op.expected.model) args.model = op.expected.model;
    if (op.expected.effort) args.thinking = op.expected.effort;
    return this.action(op, "codex.create", this.tool("create"), args);
  }
  send(op: Operation, task: Task, prompt?: string): Action {
    const args: Data = {
      threadId: task.endpoint_id,
      prompt: prompt || operationMessage(op),
    };
    if (task.route.host_id) args.hostId = task.route.host_id;
    if (op.expected.model) args.model = op.expected.model;
    if (op.expected.effort) args.thinking = op.expected.effort;
    return this.action(op, "codex.send", this.tool("send"), args);
  }
  read(op: Operation, task: Task): Action {
    return this.action(op, "codex.read", this.tool("read"), {
      threadId: task.endpoint_id,
      turnLimit: 5,
      includeOutputs: false,
      ...(task.route.host_id ? { hostId: task.route.host_id } : {}),
    });
  }
  list(op: Operation, actionId: string, kind: string): Action {
    return this.action(
      op,
      "codex.list",
      this.tool("list"),
      { limit: providerConfig("codex-app").list_threads_limit ?? 50 },
      { resume_action_id: actionId, resume_kind: kind },
    );
  }
}
export function unwrapResult(value: unknown): unknown {
  for (let i = 0; i < 4 && typeof value === "string"; i++) {
    try {
      value = parseJson(value.trim());
    } catch {
      break;
    }
  }
  return value;
}
export function appError(value: unknown): string | null {
  if (typeof value === "string")
    return [
      "error",
      "failed",
      "no appservermanager",
      "invalid arguments",
      "timed out",
      "timeout",
      "unavailable",
    ].some((v) => value.toLowerCase().includes(v))
      ? value
      : null;
  for (const item of walk(value)) {
    if (item.isError === true || item.is_error === true)
      return String(item.error || item.message || stringifyJson(item));
    for (const key of ["error", "error_message"])
      if (string(item[key])) return item[key] as string;
  }
  return null;
}
export function endpointIdentity(
  value: unknown,
): [string | null, string | null] {
  for (const item of walk(value)) {
    const id = string(item.threadId) || string(item.id);
    if (id) return [id, string(item.hostId)];
  }
  return [null, null];
}
export function findThread(value: unknown, id: string): Data | undefined {
  return [...walk(value)].find((v) => (v.threadId || v.id) === id);
}
export function threadStatus(value: unknown, id: string): string | null {
  return (
    string(findThread(value, id)?.status) ??
    [...walk(value)].map((v) => string(v.status)).find(Boolean) ??
    null
  );
}
export function actionPublic(action: Action): Data {
  return {
    action_id: action.action_id,
    tool: action.tool,
    arguments: action.arguments,
  };
}
