/** Task metadata + native resume hints (evidence-based, shell-safe). */

import type { ProviderId, ResumeInfo, TaskMeta } from "../shared/types.js";
import type { OperationRecord, TaskRecord } from "./scan.js";
import { shellQuote } from "./sanitize.js";

const TERMINAL = new Set(["succeeded", "failed", "needs_decision"]);

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  "mcode-cli": "MCode CLI",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude Code",
  "codex-app": "Codex App",
};

export const GRANULARITY: Record<ProviderId, string> = {
  "mcode-cli": "逐增量文本 + 工具全过程",
  "codex-cli": "消息按完成粒度（无逐字增量）+ 命令全过程",
  "claude-cli": "消息级事件（部分流可用时逐增量）+ 工具全过程",
  "codex-app": "仅任务状态与控制平面事件，无输出流",
};

export const CAPABILITY: Record<ProviderId, string> = {
  "mcode-cli": "控制平面事件 + 原生 exec 流（只读投影）",
  "codex-cli": "控制平面事件 + 原生 exec 流（只读投影）",
  "claude-cli": "控制平面事件 + 原生 exec 流（只读投影）",
  "codex-app": "仅状态观察（无流式输出）",
};

const DATA_ROOT_NOTES: Record<ProviderId, string> = {
  "mcode-cli": "会话由 mcode 运行时数据目录管理（本轮未逐一验证具体路径）",
  "codex-cli": "会话默认存于 ~/.codex（或 CODEX_HOME）（本轮未逐一验证）",
  "claude-cli": "会话默认存于 ~/.claude 按工作目录组织（本轮未逐一验证）",
  "codex-app": "由 Codex App 托管",
};

export function humanTitle(taskId: string): string {
  const stripped = taskId.replace(/-20\d{6}.*$/, "");
  return stripped || taskId;
}

export interface SessionEvidence {
  sessionId: string | null;
  source: string | null;
}

export function sessionEvidence(
  task: TaskRecord | null,
  operations: OperationRecord[],
  streamSessionId: string | null,
): SessionEvidence {
  if (task?.endpointId) return { sessionId: task.endpointId, source: "任务记录 endpoint_id（控制平面 journal）" };
  for (const operation of [...operations].reverse()) {
    if (operation.endpointId) return { sessionId: operation.endpointId, source: "操作记录 endpoint_id（控制平面 journal）" };
    if (operation.observedSessionId) {
      return { sessionId: operation.observedSessionId, source: "操作记录 observed.session_id（控制平面 journal）" };
    }
  }
  if (streamSessionId) return { sessionId: streamSessionId, source: "原生 exec 输出流（只读观察）" };
  return { sessionId: null, source: null };
}

export function buildResume(
  provider: ProviderId | null,
  evidence: SessionEvidence,
  target: string | null,
  running: boolean,
): ResumeInfo {
  const base: ResumeInfo = {
    sessionId: evidence.sessionId,
    sessionSource: evidence.source,
    workdir: target,
    dataRootNote: provider ? DATA_ROOT_NOTES[provider] : null,
    command: null,
    resumable: false,
    note: "",
  };
  if (provider === "codex-app") {
    return { ...base, note: "Codex App 任务只提供状态观察，无本地 CLI 续聊命令" };
  }
  if (!evidence.sessionId) {
    return { ...base, note: "尚未观察到原生 Session ID，暂无法给出续聊命令" };
  }
  let command: string | null = null;
  if (provider === "claude-cli") command = `claude --resume ${shellQuote(evidence.sessionId)}`;
  else if (provider === "codex-cli")
    command = `codex resume${target ? ` -C ${shellQuote(target)}` : ""} ${shellQuote(evidence.sessionId)}`;
  else if (provider === "mcode-cli") command = `mcode --session ${shellQuote(evidence.sessionId)}`;
  if (!command) return { ...base, note: "未知 provider，无法给出续聊命令" };
  if (running) {
    return {
      ...base,
      command,
      note: "任务仍在运行：resume 会开启新一轮对话，不是附着到运行中的进程；请等待终态后在终端执行",
    };
  }
  return {
    ...base,
    command,
    resumable: true,
    note: "Session ID 来自上述证据来源；命令本身未做过实际 resume 验证，请在原工作目录的终端执行",
  };
}

export function deriveStatus(operations: OperationRecord[], aliveOf: (pid: number | null) => boolean | null): {
  status: string;
  statusKind: TaskMeta["statusKind"];
  running: boolean;
  pidAlive: boolean | null;
} {
  const last = operations[operations.length - 1];
  if (!last) return { status: "尚无操作", statusKind: "empty", running: false, pidAlive: null };
  const raw = last.status ?? "unknown";
  if (TERMINAL.has(raw)) {
    const kind = raw as "succeeded" | "failed" | "needs_decision";
    const label = raw === "succeeded" ? "本轮执行完成" : raw === "failed" ? "本轮执行失败" : "待决策";
    return { status: label, statusKind: kind, running: false, pidAlive: null };
  }
  const alive = aliveOf(last.pid);
  if (alive === false) {
    return {
      status: "运行中（进程已不存在，等待控制平面 checkpoint 判定）",
      statusKind: "unknown",
      running: false,
      pidAlive: false,
    };
  }
  return { status: "运行中", statusKind: "running", running: true, pidAlive: alive };
}
