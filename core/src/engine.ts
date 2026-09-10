import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Action,
  type Contract,
  type Data,
  type DeliveryRequirements,
  type Envelope,
  type Expected,
  type Operation,
  type OperationStatus,
  type Provider,
  type ProviderResult,
  type RetryStage,
  type Source,
  type StartOptions,
  type Task,
  type Workspace,
  TERMINAL_STATES,
  integer,
  object,
  records,
  string,
  strings,
} from "./contracts.js";
import {
  controlConfig,
  type Control,
  expectedModelMatches,
  normalizeProvider,
  permissionModePolicy,
  permissionPolicy,
  providerConfig,
  resolveExecutionDefaults,
  resolveRetryPlan,
} from "./config.js";
import { AgentLordError, usageError } from "./errors.js";
import { equal, sha256, stringifyJson } from "./json.js";
import {
  type Lease,
  StateStore,
  recordLock,
  stateDir,
  utcNow,
  validateIdentifier,
  withAsyncLock,
  withLock,
} from "./state.js";
import {
  WorkspaceManager,
  acquireLease,
  git,
  leaseId,
  managedBranch,
  repositoryIdentity,
  validateSource,
  verifyBase,
  verifyCheckout,
  verifyManagedAdvance,
} from "./workspace.js";
import { resolvePath } from "./paths.js";
import { resolveInvocation } from "./invocation.js";
import {
  deliveryRequirements,
  sameDeliveryRequest,
  verifyDelivery,
} from "./delivery.js";
import {
  extractCodexResult,
  extractJsonlWithMetadata,
  writeArtifact,
} from "./artifacts.js";
import {
  HANDOFF_PROVIDERS,
  handoffConflict,
  loadHandoffPacket,
  renderHandoffPrompt,
  resolveContractRequest,
  snapshotExactTarget,
  sourceSessionRecord,
  validateHandoffPacket,
} from "./handoff.js";
import {
  CodexAppAdapter,
  ROUTE_STALE_FRAGMENT,
  actionPublic,
  appError,
  endpointIdentity,
  findThread,
  operationMarker,
  threadStatus,
  unwrapResult,
} from "./providers/codex-app.js";
import { recoverCodex, runCodex } from "./providers/codex-cli.js";
import {
  claudeOutputActivityMs,
  claudeSessionObserved,
  recoverClaude,
  runClaude,
} from "./providers/claude-cli.js";
import { recoverMcode, runMcode } from "./providers/mcode-cli.js";
import {
  groupAlive,
  pidAlive,
  processIdentityMatches,
  terminateProcess,
} from "./process.js";
import {
  CheckpointScan,
  compactActive,
  type ActiveOperation,
} from "./checkpoint-scan.js";

export class AgentLord {
  readonly store: StateStore;
  readonly control: Control;
  readonly workspaces: WorkspaceManager;
  readonly app: CodexAppAdapter;
  constructor(root = stateDir()) {
    this.store = new StateStore(root);
    this.control = controlConfig();
    this.workspaces = new WorkspaceManager(this.store, this.control);
    this.app = new CodexAppAdapter(this.store);
  }
  get root(): string {
    return this.store.root;
  }
  private operationId(taskId: string, kind: string): string {
    return `${taskId.slice(0, 105)}-${kind}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }
  private activeOperation(taskId: string): Operation | undefined {
    const active = this.store
      .operations(taskId)
      .filter((op) => !TERMINAL_STATES.has(op.status));
    if (active.length > 1)
      throw new AgentLordError(
        "STATE_CORRUPT",
        "task has more than one in-flight operation",
        {
          details: {
            task_id: taskId,
            operation_ids: active.map((v) => v.operation_id),
          },
        },
      );
    return active[0];
  }
  private expected(
    provider: Provider,
    model: string | null,
    effort: string | null,
    readOnly: boolean,
    retryPlan?: RetryStage[],
    mode?: string | null,
    continuationLimit?: number,
  ): Expected {
    const permission = mode
      ? permissionModePolicy(provider, mode)
      : permissionPolicy(provider, readOnly);
    if (readOnly !== (permission.mode === "read_only"))
      throw new AgentLordError(
        "STATE_CORRUPT",
        "saved permission mode contradicts the read-only contract",
        {
          details: {
            provider,
            permission_mode: permission.mode,
            read_only: readOnly,
          },
        },
      );
    const result: Expected = {
      model,
      effort,
      permission_mode: permission.mode,
      permission_enforcement: permission.enforcement,
      retry_plan: retryPlan ?? resolveRetryPlan(provider, model),
    };
    if (provider === "mcode-cli") {
      const limit =
        continuationLimit ??
        providerConfig(provider).same_session_continuations ??
        0;
      if (!integer(limit) || limit < 0 || limit > 5)
        throw usageError("MCode continuation limit must be between 0 and 5");
      result.continuation_limit = limit;
    }
    return result;
  }
  private newOperation(
    taskId: string,
    provider: Provider,
    kind: string,
    target: string,
    message: string,
    expected: Expected,
    source: Source,
    readOnly: boolean,
    workspace?: Workspace,
    extra: Partial<Operation> = {},
  ): Operation {
    const now = utcNow();
    const op: Operation = {
      version: 1,
      operation_id: this.operationId(taskId, kind),
      task_id: taskId,
      provider,
      kind,
      target,
      status: "preparing",
      message,
      message_sha256: sha256(message),
      expected,
      observed: {},
      source,
      read_only: readOnly,
      ...(workspace ? { workspace } : {}),
      parallel_plan: {},
      artifact: null,
      error: null,
      created_at: now,
      updated_at: now,
      ...extra,
    };
    if (op.delivery_requirements == null) delete op.delivery_requirements;
    this.store.createOperation(op);
    this.store.event(
      taskId,
      "operation-created",
      { kind, provider },
      op.operation_id,
    );
    return op;
  }
  private setStatus(
    id: string,
    status: OperationStatus,
    fields: Partial<Operation> = {},
  ): Operation {
    return this.store.updateOperation(id, (value) => ({
      ...value,
      status,
      ...fields,
      ...(TERMINAL_STATES.has(status) ? { completed_at: utcNow() } : {}),
    }));
  }
  private taskRecord(
    op: Operation,
    endpoint: string,
    host: string | null,
  ): Task {
    const now = utcNow();
    const task: Task = {
      version: 2,
      task_id: op.task_id,
      provider: op.provider,
      endpoint_id: endpoint,
      target: op.target,
      route: {
        host_id: host,
        resolved_at: now,
        history: host
          ? [{ host_id: host, observed_at: now, reason: "endpoint-created" }]
          : [],
      },
      contract: {
        model: op.expected.model,
        effort: op.expected.effort,
        read_only: op.read_only,
        permission_mode: op.expected.permission_mode,
        source: op.source,
        retry_plan: op.expected.retry_plan,
        ...(op.workspace ? { workspace: op.workspace } : {}),
        parallel_plan: op.parallel_plan ?? {},
        ...(op.expected.continuation_limit !== undefined
          ? { continuation_limit: op.expected.continuation_limit }
          : {}),
      },
      created_at: now,
      updated_at: now,
      last_operation_id: op.operation_id,
    };
    if (op.kind === "handoff" && op.handoff) {
      const source = object(op.handoff.source_session);
      task.lineage = {
        kind: "handoff",
        handoff_id: op.handoff.handoff_id,
        handoff_operation_id: op.operation_id,
        packet_sha256: object(op.handoff.packet).sha256,
        source_session_kind: source.kind,
        source_session_id: source.opaque_id,
        source_session_identity: source.identity_assurance,
        relationship: "continues_user_task",
      };
    }
    return task;
  }
  private setLast(taskId: string, id: string): Task {
    return this.store.updateTask(taskId, (value) => ({
      ...value,
      last_operation_id: id,
    }));
  }
  private fail(op: Operation, error: AgentLordError): Operation {
    const updated = this.store.updateOperation(op.operation_id, (value) => {
      value.status = error.requires_authorization ? "needs_decision" : "failed";
      value.error = error.asRecord();
      value.completed_at = utcNow();
      if (value.provider === "mcode-cli") {
        if (value.active_attempt) value.last_attempt = value.active_attempt;
        value.active_attempt = null;
        value.observed = {
          ...value.observed,
          supervision: {
            ...object(value.observed.supervision),
            state: "provider_failed",
            active_tool_count: 0,
            active_tools: [],
          },
        };
      }
      if (value.artifact) {
        value.invalidated_artifact = value.artifact;
        value.artifact = null;
      }
      return value;
    });
    this.store.event(
      op.task_id,
      "operation-failed",
      error.asRecord() as unknown as Data,
      op.operation_id,
    );
    return updated;
  }
  private terminalize(
    op: Operation,
    error: AgentLordError,
    exhausted = false,
  ): [Operation, AgentLordError] {
    const recovery =
      op.provider === "mcode-cli" ? this.mcodeContinuation(op, error) : null;
    const terminal = new AgentLordError(error.code, error.message, {
      retryable: exhausted ? false : recovery !== null || error.retryable,
      safe_recovery: exhausted
        ? undefined
        : recovery
          ? "CONTINUE_SAME_SESSION"
          : error.safe_recovery,
      requires_authorization: error.requires_authorization,
      details: {
        ...error.details,
        ...(recovery ? { recovery } : {}),
        attempts: op.attempt_history ?? [],
        retry_exhausted: exhausted,
      },
      exit_code: error.exit_code,
    });
    return [this.fail(op, terminal), terminal];
  }
  private raiseFailure(
    op: Operation,
    error: AgentLordError,
    exhausted = false,
  ): never {
    const [failed, terminal] = this.terminalize(op, error, exhausted);
    throw new AgentLordError(terminal.code, terminal.message, {
      ...terminal,
      details: {
        ...terminal.details,
        operation_id: failed.operation_id,
        task_id: failed.task_id,
      },
    });
  }
  private sameStart(
    op: Operation,
    kind: string,
    provider: Provider,
    target: string,
    message: string,
    expected: Expected,
    source: Source,
    readOnly: boolean,
    workspace: Workspace | undefined,
    plan: Data,
    opts: StartOptions,
    handoff?: Data,
  ): boolean {
    return (
      op.kind === kind &&
      op.provider === provider &&
      op.target === target &&
      op.message_sha256 === sha256(message) &&
      equal(op.expected, expected) &&
      equal(op.source, source) &&
      op.read_only === readOnly &&
      equal(op.workspace ?? {}, workspace ?? {}) &&
      (handoff
        ? object(op.handoff).handoff_id === handoff.handoff_id &&
          object(object(op.handoff).packet).sha256 ===
            object(handoff.packet).sha256
        : equal(op.parallel_plan ?? {}, plan) &&
          sameDeliveryRequest(
            op,
            opts.required_files,
            Boolean(opts.require_commit),
          ))
    );
  }
  async start(
    taskId: string,
    rawProvider: string,
    rawTarget: string | null,
    message: string,
    opts: StartOptions = {},
  ): Promise<Envelope> {
    validateIdentifier("task_id", taskId);
    const requestId = opts.request_id
      ? validateIdentifier("request_id", opts.request_id)
      : undefined;
    const invocation = resolveInvocation(opts.invocation);
    const provider = normalizeProvider(rawProvider);
    providerConfig(provider);
    const cli = provider !== "codex-app";
    const readOnly = Boolean(opts.read_only);
    if (!cli && (opts.required_files?.length || opts.require_commit))
      throw usageError(
        "delivery requirements apply only to local CLI providers",
      );
    const [model, effort] = resolveExecutionDefaults(
      provider,
      opts.model,
      opts.effort,
    );
    const retries =
      opts.retry_plan ?? resolveRetryPlan(provider, model, opts.retry_attempts);
    if (typeof message !== "string" || !message)
      throw usageError("message must be non-empty");
    const source = validateSource(opts.head_sha, opts.base_sha);
    let workspace: Workspace | undefined;
    let target = rawTarget;
    let repository: string | undefined;
    if (opts.repository !== undefined) {
      if (target !== null || !cli)
        throw usageError(
          "repository workspace preparation requires a local CLI provider and no target",
        );
      if (
        !opts.repository ||
        !opts.source_branch ||
        opts.source_branch.startsWith("-") ||
        !["reuse-or-create", "shared-readonly", "isolated"].includes(
          opts.workspace_policy ?? "",
        ) ||
        !source.head_sha
      )
        throw usageError(
          "repo workspace preparation requires source-branch, a supported workspace policy, and a full head-sha",
        );
      if (opts.workspace_policy === "shared-readonly" && !readOnly)
        throw usageError(
          "shared-readonly workspace policy requires --read-only",
        );
      if (opts.workspace_policy === "isolated") {
        if (
          readOnly ||
          !opts.workspace_branch ||
          opts.workspace_branch === opts.source_branch ||
          opts.workspace_branch.startsWith("-")
        )
          throw usageError(
            "isolated workspace policy requires a writable task and a distinct workspace-branch",
          );
      } else if (opts.workspace_branch !== undefined)
        throw usageError(
          "workspace-branch is accepted only with isolated workspace policy",
        );
      repository = resolvePath(opts.repository);
      git(repository, ["check-ref-format", "--branch", opts.source_branch]);
      if (opts.workspace_branch)
        git(repository, [
          "check-ref-format",
          "--branch",
          opts.workspace_branch,
        ]);
      workspace = {
        policy: opts.workspace_policy!,
        repository,
        source_branch: opts.source_branch,
        ...(opts.workspace_branch
          ? { workspace_branch: opts.workspace_branch }
          : {}),
      };
    } else {
      if (
        [
          opts.source_branch,
          opts.workspace_policy,
          opts.workspace_branch,
          opts.worktree_root,
        ].some((v) => v !== undefined)
      )
        throw usageError(
          "source-branch, workspace-policy, workspace-branch, and worktree-root require repo workspace preparation",
        );
      if (!target) throw usageError("target must be non-empty");
      if (cli) {
        target = resolvePath(target);
        workspace = { policy: "exact-target" };
        verifyCheckout(target, source);
      }
    }
    if (
      cli &&
      (opts.codex_environment !== undefined ||
        opts.starting_branch !== undefined)
    )
      throw usageError(
        "codex-environment and starting-branch apply only to the codex-app provider",
        { provider },
      );
    if (
      !cli &&
      opts.codex_environment &&
      !["local", "worktree"].includes(opts.codex_environment)
    )
      throw usageError("Codex environment must be worktree or local");
    let group: Lease | undefined;
    let prepare: Lease | undefined;
    let writes: Lease | undefined;
    let controller: Lease | undefined;
    let operation: Operation | undefined;
    let action: Action | undefined;
    try {
      if (opts.parallel_group)
        group = await acquireLease(
          "parallel-group",
          leaseId("group", opts.parallel_group),
          this.root,
          this.control,
          "another member of this parallel write group is being journaled",
        );
      const plan = this.workspaces.parallelPlan(
        taskId,
        readOnly,
        workspace ?? { policy: "exact-target" },
        opts,
      );
      const expected = this.expected(
        provider,
        model,
        effort,
        readOnly,
        retries,
      );
      const existing = await withAsyncLock(
        "dispatch",
        leaseId("dispatch", taskId),
        this.root,
        async () => {
          let exists = false;
          if (repository) {
            const branch = opts.workspace_branch || opts.source_branch!;
            prepare = await acquireLease(
              "workspace-prepare",
              leaseId(
                "prepare",
                `${repositoryIdentity(repository)}\0${branch}`,
              ),
              this.root,
              this.control,
              "another task is preparing this repository checkout",
              { repository, checkout_branch: branch },
            );
            [target, exists] = this.workspaces.resolveTarget(
              taskId,
              repository,
              branch,
              opts.worktree_root,
            );
          }
          if (this.store.hasTask(taskId)) {
            const task = this.store.task(taskId);
            const last = task.last_operation_id
              ? this.store.operation(task.last_operation_id)
              : null;
            if (
              last &&
              this.sameStart(
                last,
                "start",
                provider,
                target!,
                message,
                expected,
                source,
                readOnly,
                workspace,
                object(plan),
                opts,
              )
            )
              return this.envelope(last);
            throw new AgentLordError(
              "TASK_EXISTS",
              "task_id already has a durable endpoint",
              { details: { task_id: taskId }, exit_code: 2 },
            );
          }
          const active = this.activeOperation(taskId);
          if (active) {
            if (
              this.sameStart(
                active,
                "start",
                provider,
                target!,
                message,
                expected,
                source,
                readOnly,
                workspace,
                object(plan),
                opts,
              )
            )
              return this.envelope(active);
            throw new AgentLordError(
              "OPERATION_IN_FLIGHT",
              "task_id already has a different start in flight",
              {
                retryable: true,
                safe_recovery: "CHECK_SAME_OPERATION",
                details: {
                  operation_id: active.operation_id,
                  status: active.status,
                },
              },
            );
          }
          if (cli)
            writes = this.workspaces.writeLeases(target!, readOnly, workspace!);
          if (repository) {
            target = this.workspaces.prepare(
              repository,
              opts.source_branch!,
              source.head_sha!,
              target!,
              opts.workspace_policy!,
              opts.workspace_branch,
              exists,
            );
            verifyBase(target, source);
            prepare!.release();
            prepare = undefined;
          }
          const id = this.operationId(taskId, "start");
          if (provider === "claude-cli")
            controller = recordLock(
              "controller-lease",
              leaseId("controller", id),
              this.root,
            );
          operation = this.newOperation(
            taskId,
            provider,
            "start",
            target!,
            message,
            expected,
            source,
            readOnly,
            workspace,
            {
              operation_id: id,
              parallel_plan: plan,
              invocation,
              ...(requestId ? { request_id: requestId } : {}),
              ...(cli ? { controller_pid: process.pid } : {}),
              ...(provider === "claude-cli"
                ? { endpoint_id: randomUUID() }
                : {}),
              delivery_requirements: deliveryRequirements(
                target!,
                opts.required_files,
                Boolean(opts.require_commit),
              ),
              resume: false,
            },
          );
          if (!cli) {
            action = this.app.create(
              operation,
              opts.codex_environment ?? "worktree",
              opts.starting_branch,
            );
            operation = this.setStatus(id, "awaiting_action", {
              action_id: action.action_id,
            });
          }
          return undefined;
        },
      );
      group?.release();
      group = undefined;
      if (existing) return existing;
      if (cli) return await this.finishCli(operation!, false);
      this.store.event(
        taskId,
        "action-required",
        { action_id: action!.action_id, tool: action!.tool },
        operation!.operation_id,
      );
      return this.envelope(operation!, action);
    } finally {
      group?.release();
      prepare?.release();
      controller?.release();
      writes?.release();
    }
  }
  async handoff(
    taskId: string,
    packetFile: string,
    opts: StartOptions & {
      provider?: string;
      target?: string;
      validate_only?: boolean;
    } = {},
  ): Promise<Envelope> {
    validateIdentifier("task_id", taskId);
    const invocation = resolveInvocation(opts.invocation);
    const packet = loadHandoffPacket(packetFile);
    const digest = validateHandoffPacket(packet);
    if (object(packet.continuation).task_id !== taskId)
      throw handoffConflict(
        "handoff packet is bound to a different continuation task",
        {
          packet_task_id: object(packet.continuation).task_id,
          task_id: taskId,
        },
      );
    const requested = resolveContractRequest(
      packet,
      opts.provider ? normalizeProvider(opts.provider) : undefined,
      opts.model,
      opts.effort,
    );
    const provider = normalizeProvider(requested[0]);
    if (!HANDOFF_PROVIDERS.includes(provider))
      throw usageError(
        "handoff can only start a local CLI continuation endpoint",
        { provider, allowed: HANDOFF_PROVIDERS },
      );
    providerConfig(provider);
    const readOnly = Boolean(opts.read_only);
    const auth = object(packet.authorization);
    if (Boolean(auth.workspace_writes) === readOnly)
      throw handoffConflict(
        "packet workspace-write authorization contradicts the requested permission posture",
        { workspace_writes: auth.workspace_writes, read_only: readOnly },
      );
    if (provider === "mcode-cli") {
      resolveExecutionDefaults(provider, requested[1], requested[2]);
      permissionPolicy(provider, readOnly);
    }
    const sourceSession = sourceSessionRecord(packet);
    if (opts.validate_only)
      return {
        version: 1,
        status: "SUCCEEDED",
        task_id: taskId,
        provider,
        handoff: {
          schema: packet.schema,
          handoff_id: packet.handoff_id,
          relationship: "continues_user_task",
          source_session: sourceSession,
          packet_sha256: digest.sha256,
          packet_bytes: digest.bytes,
          validated_only: true,
        },
      };
    if (!opts.target)
      throw usageError(
        "handoff requires --target: the continuation runs in the exact existing workspace",
      );
    const target = resolvePath(opts.target);
    const workspace: Workspace = { policy: "exact-target" };
    const source = validateSource(opts.head_sha, opts.base_sha);
    const [model, effort] = resolveExecutionDefaults(
      provider,
      requested[1],
      requested[2],
    );
    const expected = this.expected(
      provider,
      model,
      effort,
      readOnly,
      resolveRetryPlan(provider, model, opts.retry_attempts),
    );
    const message = renderHandoffPrompt(packet, digest.sha256, expected);
    let writes: Lease | undefined;
    let controller: Lease | undefined;
    let operation: Operation | undefined;
    try {
      const existing = await withAsyncLock(
        "dispatch",
        leaseId("dispatch", taskId),
        this.root,
        async () => {
          const previousTask = this.store.hasTask(taskId)
            ? this.store.task(taskId)
            : null;
          const previous = previousTask?.last_operation_id
            ? this.store.operation(previousTask.last_operation_id)
            : this.activeOperation(taskId);
          if (previous) {
            if (
              this.sameStart(
                previous,
                "handoff",
                provider,
                target,
                message,
                expected,
                source,
                readOnly,
                workspace,
                {},
                opts,
                {
                  handoff_id: packet.handoff_id,
                  packet: { sha256: digest.sha256 },
                },
              )
            )
              return this.envelope(previous);
            if (previous.kind === "handoff")
              throw handoffConflict(
                "continuation task already exists with a different handoff fingerprint",
                { task_id: taskId, packet_sha256: digest.sha256 },
              );
            throw new AgentLordError(
              previousTask ? "TASK_EXISTS" : "OPERATION_IN_FLIGHT",
              "task_id already has a different operation",
              {
                details: {
                  task_id: taskId,
                  operation_id: previous.operation_id,
                },
              },
            );
          }
          if (previousTask)
            throw new AgentLordError(
              "TASK_EXISTS",
              "task_id already has a durable endpoint",
              { details: { task_id: taskId }, exit_code: 2 },
            );
          verifyCheckout(target, source);
          const snapshot = snapshotExactTarget(target);
          writes = this.workspaces.writeLeases(target, readOnly, workspace);
          const id = this.operationId(taskId, "handoff");
          if (provider === "claude-cli")
            controller = recordLock(
              "controller-lease",
              leaseId("controller", id),
              this.root,
            );
          const artifact = writeArtifact(
            taskId,
            id,
            digest.canonical_bytes.toString("utf8"),
            this.root,
            ".handoff-v1.json",
          );
          operation = this.newOperation(
            taskId,
            provider,
            "handoff",
            target,
            message,
            expected,
            source,
            readOnly,
            workspace,
            {
              operation_id: id,
              controller_pid: process.pid,
              invocation,
              ...(provider === "claude-cli"
                ? { endpoint_id: randomUUID() }
                : {}),
              resume: false,
              handoff: {
                version: 1,
                schema: packet.schema,
                handoff_id: packet.handoff_id,
                relationship: "continues_user_task",
                source_session: sourceSession,
                packet: artifact,
                workspace_snapshot: snapshot,
              },
            },
          );
          const observed = snapshotExactTarget(target);
          if (!equal(snapshot, observed)) {
            const error = new AgentLordError(
              "SOURCE_MISMATCH",
              "continuation workspace changed between the handoff snapshot and dispatch",
              {
                retryable: true,
                safe_recovery: "RETRY_SAME_COMMAND",
                details: {
                  target,
                  snapshot_sha256: snapshot.sha256,
                  observed_sha256: observed.sha256,
                },
              },
            );
            this.fail(operation, error);
            throw error;
          }
          this.store.event(
            taskId,
            "handoff-accepted",
            {
              handoff_id: packet.handoff_id,
              packet_sha256: digest.sha256,
              source_session: sourceSession,
            },
            id,
          );
          return undefined;
        },
      );
      return existing ?? (await this.finishCli(operation!, false));
    } finally {
      controller?.release();
      writes?.release();
    }
  }
  async turn(
    taskId: string,
    message: string,
    opts: Pick<
      StartOptions,
      "required_files" | "require_commit" | "invocation" | "request_id"
    > & {
      recovery_from?: string;
    } = {},
  ): Promise<Envelope> {
    validateIdentifier("task_id", taskId);
    const requestId = opts.request_id
      ? validateIdentifier("request_id", opts.request_id)
      : undefined;
    const invocation = resolveInvocation(
      opts.invocation,
      Boolean(opts.recovery_from),
    );
    if (typeof message !== "string" || !message)
      throw usageError("message must be non-empty");
    let writes: Lease | undefined;
    let controller: Lease | undefined;
    let operation: Operation | undefined;
    let action: Action | undefined;
    try {
      const existing = await withAsyncLock(
        "dispatch",
        leaseId("dispatch", taskId),
        this.root,
        async () => {
          let task = this.store.task(taskId);
          const cli = task.provider !== "codex-app";
          if (!cli && (opts.required_files?.length || opts.require_commit))
            throw usageError(
              "delivery requirements apply only to local CLI providers",
            );
          let continuation: Data | undefined;
          let delivery: DeliveryRequirements | null | undefined;
          if (opts.recovery_from) {
            const child = this.store
              .operations(taskId)
              .find(
                (op) =>
                  op.continuation?.parent_operation_id === opts.recovery_from,
              );
            if (child) return this.envelope(child);
            [continuation, message] = this.prepareContinuation(
              task,
              opts.recovery_from,
            );
            delivery = this.store.operation(
              opts.recovery_from,
            ).delivery_requirements;
          }
          if (task.legacy_version === 1)
            throw new AgentLordError(
              "EXECUTION_CONTRACT_REQUIRED",
              "version 1 task must be explicitly upgraded before another turn",
              {
                requires_authorization: true,
                details: {
                  task_id: taskId,
                  recovery: "node core/dist/task-store.js upgrade",
                },
                exit_code: 2,
              },
            );
          const active = this.activeOperation(taskId);
          if (active) {
            if (
              active.message_sha256 === sha256(message) &&
              sameDeliveryRequest(
                active,
                opts.required_files,
                Boolean(opts.require_commit),
              )
            )
              return this.envelope(active);
            throw new AgentLordError(
              "OPERATION_IN_FLIGHT",
              "the previous turn has not reached a terminal state",
              {
                retryable: true,
                safe_recovery: "CHECK_SAME_OPERATION",
                details: {
                  operation_id: active.operation_id,
                  status: active.status,
                },
              },
            );
          }
          let contract = task.contract;
          let source = contract.source;
          const workspace = contract.workspace?.policy
            ? contract.workspace
            : ({ policy: "exact-target" } as Workspace);
          if (cli) {
            const branch = managedBranch(contract);
            if (!branch) verifyCheckout(task.target, source);
            else {
              const advanced = verifyManagedAdvance(
                task.target,
                source,
                branch,
              );
              if (advanced) {
                source = { ...source, verified_head_sha: advanced };
                task = this.store.updateTask(taskId, (value) => ({
                  ...value,
                  contract: { ...value.contract, source },
                }));
                contract = task.contract;
                this.store.event(taskId, "source-head-advanced", {
                  frozen_head: source.head_sha,
                  verified_head: advanced,
                  branch,
                });
              }
            }
            writes = this.workspaces.writeLeases(
              task.target,
              contract.read_only,
              workspace,
            );
          }
          const expected = this.expected(
            task.provider,
            contract.model,
            contract.effort,
            contract.read_only,
            contract.retry_plan,
            contract.permission_mode,
            contract.continuation_limit ?? 0,
          );
          const id = this.operationId(taskId, "turn");
          if (task.provider === "claude-cli")
            controller = recordLock(
              "controller-lease",
              leaseId("controller", id),
              this.root,
            );
          operation = this.newOperation(
            taskId,
            task.provider,
            "turn",
            task.target,
            message,
            expected,
            source,
            contract.read_only,
            workspace,
            {
              operation_id: id,
              invocation,
              ...(requestId ? { request_id: requestId } : {}),
              ...(cli
                ? { controller_pid: process.pid, endpoint_id: task.endpoint_id }
                : {}),
              parallel_plan: contract.parallel_plan ?? {},
              resume: true,
              ...(continuation ? { continuation } : {}),
              delivery_requirements: opts.recovery_from
                ? delivery
                : deliveryRequirements(
                    task.target,
                    opts.required_files,
                    Boolean(opts.require_commit),
                  ),
            },
          );
          if (continuation)
            this.store.event(taskId, "operation-continued", continuation, id);
          if (!cli) {
            action = this.app.send(operation, task);
            operation = this.setStatus(id, "awaiting_action", {
              action_id: action.action_id,
            });
          }
          this.setLast(taskId, id);
          return undefined;
        },
      );
      if (existing) return existing;
      return operation!.provider === "codex-app"
        ? this.envelope(operation!, action)
        : await this.finishCli(operation!, true);
    } finally {
      controller?.release();
      writes?.release();
    }
  }
  recover(
    taskId: string,
    id: string,
    opts: Pick<StartOptions, "invocation"> = {},
  ): Promise<Envelope> {
    validateIdentifier("operation_id", id);
    return this.turn(taskId, "continue", { ...opts, recovery_from: id });
  }
  private ensureMcodeTask(id: string, endpoint: string): Task {
    const op = this.store.operation(id);
    let task: Task;
    if (this.store.hasTask(op.task_id)) task = this.store.task(op.task_id);
    else {
      try {
        return this.store.createTask(this.taskRecord(op, endpoint, null));
      } catch (error) {
        if (
          !(error instanceof AgentLordError) ||
          error.code !== "IDENTITY_CONFLICT"
        )
          throw error;
        task = this.store.task(op.task_id);
      }
    }
    if (task.endpoint_id !== endpoint || task.last_operation_id !== id)
      throw new AgentLordError(
        "IDENTITY_CONFLICT",
        "existing task handle does not match the observed MCode Session",
        {
          details: {
            task_id: op.task_id,
            expected_endpoint_id: endpoint,
            observed_endpoint_id: task.endpoint_id,
          },
        },
      );
    return task;
  }
  private async publish(
    op: Operation,
    result: ProviderResult,
    resume: boolean,
  ): Promise<Envelope> {
    const lease = await acquireLease(
      "finalize",
      leaseId("finalize", op.operation_id),
      this.root,
      this.control,
      "another process is finalizing this operation",
    );
    try {
      const current = this.store.operation(op.operation_id);
      if (current.status === "succeeded") return this.envelope(current);
      if (TERMINAL_STATES.has(current.status))
        throw new AgentLordError(
          "STATE_CONFLICT",
          "CLI operation was finalized with a different terminal result",
          {
            details: { operation_id: op.operation_id, status: current.status },
          },
        );
      const artifact = writeArtifact(
        op.task_id,
        op.operation_id,
        result.assistant_text,
        this.root,
      );
      if (!resume) {
        if (this.store.hasTask(op.task_id)) {
          const task = this.store.task(op.task_id);
          if (
            task.endpoint_id !== result.endpoint_id ||
            task.last_operation_id !== op.operation_id
          )
            throw new AgentLordError(
              "IDENTITY_CONFLICT",
              "existing task handle does not match the recovered CLI start",
            );
        } else
          this.store.createTask(
            this.taskRecord(current, result.endpoint_id, null),
          );
      } else this.setLast(op.task_id, op.operation_id);
      const updated = this.setStatus(op.operation_id, "succeeded", {
        delivery: verifyDelivery(current),
        observed: object(result.observed),
        artifact,
        error: null,
        provider_command: result.command,
        stdout_path: result.stdout_path,
        stderr_path: result.stderr_path,
        endpoint_id: result.endpoint_id,
        active_attempt: null,
        ...(result.result_path ? { result_path: result.result_path } : {}),
      });
      this.store.event(
        op.task_id,
        "operation-succeeded",
        { artifact },
        op.operation_id,
      );
      return this.envelope(updated);
    } finally {
      lease.release();
    }
  }
  private async finishCli(op: Operation, resume: boolean): Promise<Envelope> {
    if (op.provider === "claude-cli") return this.finishClaude(op, resume);
    try {
      const result =
        op.provider === "mcode-cli"
          ? await runMcode(this.store, op, this.control, (id) =>
              this.ensureMcodeTask(op.operation_id, id),
            )
          : await runCodex(this.store, op);
      return await this.publish(op, result, resume);
    } catch (error) {
      if (!(error instanceof AgentLordError) || error.code === "STATE_BUSY")
        throw error;
      const current = this.store.operation(op.operation_id);
      if (op.provider === "mcode-cli" && current.endpoint_id)
        this.ensureMcodeTask(op.operation_id, current.endpoint_id);
      return this.raiseFailure(current, error);
    }
  }
  private retryModels(op: Operation): string[] {
    return op.expected.retry_plan.flatMap((stage) =>
      stage.model ? Array<string>(stage.attempts).fill(stage.model) : [],
    );
  }
  private claudeDeliveryRequiresContinuation(op: Operation): boolean {
    return [...(op.attempt_history ?? []), object(op.active_attempt)].some(
      (attempt) =>
        ["delivery-unknown", "stdin-attached"].includes(
          String(attempt.prompt_delivery),
        ),
    );
  }
  private recordClaudeAttempt(
    op: Operation,
    number: number,
    model: string,
    status: string,
    opts: {
      error?: AgentLordError;
      sessionObserved?: boolean;
      retrying?: boolean;
      claim?: boolean;
      warnings?: Data[];
    } = {},
  ): Operation {
    const warnings = (opts.warnings ?? []).map((v) =>
      Object.fromEntries(
        ["code", "source", "model"].filter((k) => k in v).map((k) => [k, v[k]]),
      ),
    );
    const updated = this.store.updateOperation(op.operation_id, (value) => {
      const active = object(value.active_attempt);
      const entry: Data = { number, model, status };
      for (const key of [
        "attempt_id",
        "prompt_kind",
        "recovery_marker",
        "prompt_delivery",
        "prompt_delivered_at_ms",
        "progress_seq",
      ])
        if (active[key] != null) entry[key] = active[key];
      if (opts.error) entry.error = opts.error.asRecord();
      if (opts.sessionObserved !== undefined)
        entry.session_observed = opts.sessionObserved;
      if (warnings.length) entry.warnings = warnings;
      value.attempt_history = [...(value.attempt_history ?? []), entry];
      if (status === "failed") {
        value.active_attempt = null;
        if (opts.retrying) {
          value.status = "recovering";
          value.controller_pid = value.recovery_controller_pid =
            opts.claim === false ? null : process.pid;
        }
        value.observed = {
          ...value.observed,
          supervision: {
            state: opts.retrying
              ? "recovering"
              : opts.error?.code !== "PROVIDER_STALLED"
                ? "provider_failed"
                : "suspected_stall",
            attempt: number,
            error_code: opts.error?.code ?? null,
          },
        };
      }
      return value;
    });
    this.store.event(
      op.task_id,
      `provider-attempt-${status}`,
      { attempt: number, model, error: opts.error?.asRecord() ?? null },
      op.operation_id,
    );
    for (const warning of warnings)
      this.store.event(
        op.task_id,
        "provider-attempt-warning",
        { attempt: number, ...warning },
        op.operation_id,
      );
    return updated;
  }
  private async finishClaude(
    op: Operation,
    resume: boolean,
  ): Promise<Envelope> {
    const models = this.retryModels(op);
    if (!models.length)
      throw new AgentLordError(
        "STATE_CORRUPT",
        "Claude operation has no retry plan",
      );
    let current = this.store.operation(op.operation_id);
    const start = (current.attempt_history ?? []).length;
    let attemptResume =
      resume ||
      (start > 0 && claudeSessionObserved(current)) ||
      this.claudeDeliveryRequiresContinuation(current);
    let reason =
      string(object(current.attempt_history?.at(-1)?.error).code) ||
      "PROVIDER_FAILED";
    for (let index = start; index < models.length; index++) {
      const model = models[index];
      let prompt = op.message;
      let kind = "original";
      let marker: string | null = null;
      if (index > 0 && attemptResume) {
        marker = `agent-lord-recovery:${op.operation_id}:${index + 1}`;
        kind = "continuation";
        prompt = `[${marker}]\nContinue the same task in this existing Claude session after the previous provider attempt ended with ${reason}. Inspect the conversation and current worktree first, do not repeat work that is already complete, then finish the original request and return its final answer.\n`;
        current = this.setStatus(op.operation_id, "recovering", {
          recovery_controller_pid: process.pid,
          observed: {
            ...current.observed,
            supervision: {
              state: "recovering",
              attempt: index + 1,
              reason,
              recovery_marker: marker,
            },
          },
        });
        this.store.event(
          op.task_id,
          "provider-recovery-query-prepared",
          { attempt: index + 1, reason, recovery_marker: marker },
          op.operation_id,
        );
      }
      let result: ProviderResult;
      try {
        result = await runClaude(
          this.store,
          op,
          this.control,
          model,
          index + 1,
          attemptResume,
          prompt,
          kind,
          marker,
        );
      } catch (error) {
        if (!(error instanceof AgentLordError) || error.code === "STATE_BUSY")
          throw error;
        current = this.store.operation(op.operation_id);
        const sessionObserved = claudeSessionObserved(current);
        attemptResume ||=
          sessionObserved || this.claudeDeliveryRequiresContinuation(current);
        const retrying = error.retryable && index + 1 < models.length;
        current = this.recordClaudeAttempt(
          current,
          index + 1,
          model,
          "failed",
          { error, sessionObserved, retrying },
        );
        reason = error.code;
        if (!retrying)
          return this.raiseFailure(current, error, error.retryable);
        continue;
      }
      current = this.recordClaudeAttempt(op, index + 1, model, "succeeded", {
        warnings: records(object(result.observed).warnings),
      });
      result.observed = {
        ...object(result.observed),
        attempts: current.attempt_history!.length,
        attempt_history: current.attempt_history,
        requested_model: op.expected.model,
        fallback_used: model !== op.expected.model,
      };
      return this.publish(current, result, resume);
    }
    throw new AgentLordError(
      "STATE_CORRUPT",
      "Claude retry plan was exhausted without a terminal result",
    );
  }
  private mcodeContinuation(op: Operation, error: AgentLordError): Data | null {
    const d = error.details;
    const providerError = object(d.provider_error);
    const limit = op.expected.continuation_limit ?? 0;
    const chain = op.continuation ?? {};
    const used = chain.attempt ?? 0;
    if (
      op.provider !== "mcode-cli" ||
      error.code !== "PROVIDER_FAILED" ||
      error.requires_authorization ||
      !["failed", "timeout"].includes(String(d.provider_status)) ||
      providerError.retryable !== true ||
      providerError.category !== "runtime" ||
      d.model_verified !== true ||
      d.return_code !== 4 ||
      op.provider_return_code !== 4 ||
      !op.endpoint_id ||
      d.session_id !== op.endpoint_id ||
      !integer(limit) ||
      limit <= 0 ||
      limit > 5 ||
      !integer(used) ||
      used < 0 ||
      used >= limit
    )
      return null;
    const attempt = op.active_attempt || object(op.last_attempt);
    const pid = attempt.pid || op.pid;
    if (!integer(pid) || pid <= 0 || groupAlive(pid, attempt.process_group_id))
      return null;
    return {
      kind: "continue_same_session",
      task_id: op.task_id,
      operation_id: op.operation_id,
      root_operation_id: chain.root_operation_id ?? op.operation_id,
      attempt: used + 1,
      limit,
    };
  }
  private prepareContinuation(task: Task, parentId: string): [Data, string] {
    const parent = this.store.operation(parentId);
    const c = task.contract;
    if (parent.task_id !== task.task_id || parent.provider !== "mcode-cli")
      throw new AgentLordError(
        "STATE_CONFLICT",
        "continuation does not belong to this MCode task",
      );
    if (task.last_operation_id !== parentId || parent.status !== "failed")
      throw new AgentLordError(
        "STATE_CONFLICT",
        "only the latest failed operation can be continued",
      );
    const keys = [
      "model",
      "effort",
      "permission_mode",
      "retry_plan",
      "continuation_limit",
    ] as const;
    if (
      parent.endpoint_id !== task.endpoint_id ||
      parent.target !== task.target ||
      keys.some((k) => !equal(parent.expected[k], c[k])) ||
      ["head_sha", "base_sha"].some(
        (k) => !equal(object(parent.source)[k], object(c.source)[k]),
      ) ||
      !equal(parent.workspace ?? {}, c.workspace ?? {}) ||
      !equal(parent.parallel_plan ?? {}, c.parallel_plan ?? {}) ||
      parent.read_only !== c.read_only
    )
      throw new AgentLordError(
        "STATE_CONFLICT",
        "continuation cannot change the saved execution contract",
      );
    let plan: Data | null = null;
    try {
      recoverMcode(parent);
    } catch (error) {
      if (!(error instanceof AgentLordError)) throw error;
      plan = this.mcodeContinuation(parent, error);
    }
    if (!plan)
      throw new AgentLordError(
        "RECOVERY_UNAVAILABLE",
        "operation has no remaining verified same-session continuation",
      );
    return [
      { ...plan, parent_operation_id: parentId },
      `[agent-lord-continuation:${plan.root_operation_id}:${plan.attempt}]\nContinue the original task in this same session after the previous verified run ended with a transient provider failure. Inspect the existing conversation, current worktree, completed commands and any background work first. Preserve completed work and finish only the remaining authorized requirements. Do not repeat already completed actions. Return the final result and verification evidence.\n`,
    ];
  }
  private appObservation(op: Operation, fields: Data): Data {
    return {
      execution_contract: "model-effort-tool-arguments",
      permission_mode: op.expected.permission_mode,
      permission_enforcement: op.expected.permission_enforcement,
      ...fields,
    };
  }
  private markAction(
    id: string,
    status: Action["status"],
    result: unknown = null,
    error: AgentLordError | null = null,
  ): Action {
    return this.store.updateAction(id, (value) => ({
      ...value,
      status,
      result_sha256: result === null ? null : sha256(stringifyJson(result)),
      error: error?.asRecord() ?? null,
      completed_at: utcNow(),
    }));
  }
  private rebindTask(id: string, host: string, reason: string): Task {
    return this.store.updateTask(id, (value) => {
      const route = value.route;
      if (route.host_id !== host)
        route.history.push({
          host_id: host,
          observed_at: utcNow(),
          reason,
          previous_host_id: route.host_id,
        });
      route.host_id = host;
      route.resolved_at = utcNow();
      return value;
    });
  }
  accept(actionId: string, raw: unknown, autoRead = false): Envelope {
    const initial = this.store.action(actionId);
    return withLock(
      "operation-control",
      leaseId("control", initial.operation_id),
      this.root,
      () => {
        const action = this.store.action(actionId);
        const op = this.store.operation(action.operation_id);
        if (action.status !== "pending") return this.envelope(op);
        const result = unwrapResult(raw);
        const providerError = appError(result);
        const failed = (error: AgentLordError, accepted = false): Envelope => {
          const updated = this.fail(op, error);
          this.markAction(
            actionId,
            accepted ? "accepted" : "failed",
            accepted ? result : null,
            error,
          );
          return this.envelope(updated);
        };
        const follow = (
          next: Action,
          error: AgentLordError | null = null,
        ): Envelope =>
          this.envelope(
            this.setStatus(op.operation_id, "awaiting_action", {
              action_id: next.action_id,
              error: error?.asRecord() ?? null,
            }),
            next,
          );
        if (providerError) {
          if (
            providerError.includes(ROUTE_STALE_FRAGMENT) &&
            ["codex.send", "codex.read"].includes(action.kind)
          ) {
            const error = new AgentLordError(
              "ENDPOINT_ROUTE_STALE",
              "Codex endpoint route is stale; resolving the same thread before retry",
              {
                retryable: true,
                safe_recovery: "RESOLVE_SAME_ENDPOINT_AND_RETRY",
                details: { provider_error: providerError },
              },
            );
            this.markAction(actionId, "failed", null, error);
            const envelope = follow(
              this.app.list(op, actionId, action.kind),
              error,
            );
            this.store.event(
              op.task_id,
              "route-stale",
              object(error.asRecord()),
              op.operation_id,
            );
            return envelope;
          }
          if (action.kind === "codex.send") {
            const error = new AgentLordError(
              "DELIVERY_UNKNOWN",
              "Codex send failed without a trustworthy delivery receipt",
              {
                retryable: true,
                safe_recovery: "CHECK_SAME_ENDPOINT_BEFORE_RESEND",
                details: { provider_error: providerError },
              },
            );
            this.markAction(actionId, "uncertain", null, error);
            return follow(
              this.app.read(op, this.store.task(op.task_id)),
              error,
            );
          }
          if (action.kind === "codex.list" && string(action.resume_action_id)) {
            const attempts = this.store
              .actions(op.operation_id)
              .filter(
                (v) => v.kind === "codex.list" && v.status === "failed",
              ).length;
            if (attempts + 1 < 3) {
              const error = new AgentLordError(
                "PROVIDER_FAILED",
                "Codex thread listing failed transiently; retrying the same route recovery",
                {
                  retryable: true,
                  safe_recovery: "RETRY_SAME_HOST_TOOL_ACTION",
                  details: {
                    provider_error: providerError,
                    list_attempt: attempts + 1,
                  },
                },
              );
              this.markAction(actionId, "failed", null, error);
              const envelope = follow(
                this.app.list(
                  op,
                  String(action.resume_action_id),
                  String(action.resume_kind),
                ),
                error,
              );
              this.store.event(
                op.task_id,
                "route-list-retry",
                object(error.asRecord()),
                op.operation_id,
              );
              return envelope;
            }
          }
          return failed(
            new AgentLordError(
              "PROVIDER_FAILED",
              "Codex host tool returned an error",
              {
                retryable: action.kind === "codex.read",
                safe_recovery:
                  action.kind === "codex.read"
                    ? "RETRY_CHECK_SAME_ENDPOINT"
                    : undefined,
                details: { provider_error: providerError },
              },
            ),
          );
        }
        if (action.kind === "codex.create") {
          const [endpoint, host] = endpointIdentity(result);
          if (!endpoint || !host)
            return failed(
              new AgentLordError(
                "RESULT_INVALID",
                "Codex create result lacks a real threadId and hostId",
              ),
            );
          const task = this.store.createTask(
            this.taskRecord(op, endpoint, host),
          );
          this.markAction(actionId, "accepted", result);
          const next = autoRead ? this.app.read(op, task) : undefined;
          const updated = this.setStatus(
            op.operation_id,
            next ? "awaiting_action" : "submitted",
            {
              endpoint_id: endpoint,
              observed: this.appObservation(op, { host_id: host }),
              error: null,
              ...(next ? { action_id: next.action_id } : {}),
            },
          );
          this.store.event(
            op.task_id,
            "endpoint-created",
            { endpoint_id: endpoint, host_id: host },
            op.operation_id,
          );
          return this.envelope(updated, next);
        }
        let task = this.store.task(op.task_id);
        if (action.kind === "codex.send") {
          const [endpoint, host] = endpointIdentity(result);
          if (endpoint && endpoint !== task.endpoint_id)
            return failed(
              new AgentLordError(
                "ENDPOINT_MISMATCH",
                "Codex send receipt belongs to a different thread",
                { details: { expected: task.endpoint_id, observed: endpoint } },
              ),
            );
          if (host) task = this.rebindTask(task.task_id, host, "send-receipt");
          this.markAction(actionId, "accepted", result);
          const next = autoRead ? this.app.read(op, task) : undefined;
          const updated = this.setStatus(
            op.operation_id,
            next ? "awaiting_action" : "submitted",
            {
              observed: this.appObservation(op, {
                host_id: task.route.host_id,
              }),
              error: null,
              ...(next ? { action_id: next.action_id } : {}),
            },
          );
          this.store.event(
            op.task_id,
            "message-accepted",
            { action_id: actionId },
            op.operation_id,
          );
          return this.envelope(updated, next);
        }
        if (action.kind === "codex.list") {
          const host = string(findThread(result, task.endpoint_id)?.hostId);
          if (!host)
            return failed(
              new AgentLordError(
                "ENDPOINT_GONE",
                "the original Codex thread was not found on any current host",
                {
                  requires_authorization: true,
                  details: { endpoint_id: task.endpoint_id },
                },
              ),
              true,
            );
          task = this.rebindTask(task.task_id, host, "host-rediscovery");
          this.markAction(actionId, "accepted", result);
          const prior = this.store.action(String(action.resume_action_id));
          const next =
            action.resume_kind === "codex.send"
              ? this.app.send(op, task, String(prior.arguments.prompt))
              : this.app.read(op, task);
          const envelope = follow(next);
          this.store.event(
            op.task_id,
            "route-rebound",
            { host_id: host },
            op.operation_id,
          );
          return envelope;
        }
        if (action.kind === "codex.read") {
          this.markAction(actionId, "accepted", result);
          const marker = operationMarker(op.operation_id);
          let text = "";
          try {
            text = extractCodexResult(result, marker);
          } catch (error) {
            if (!(error instanceof AgentLordError)) throw error;
          }
          const observed = this.appObservation(op, {
            thread_status: threadStatus(result, task.endpoint_id),
          });
          if (text) {
            const artifact = writeArtifact(
              op.task_id,
              op.operation_id,
              text,
              this.root,
            );
            const updated = this.setStatus(op.operation_id, "succeeded", {
              artifact,
              observed,
              error: null,
            });
            this.store.event(
              op.task_id,
              "operation-succeeded",
              { artifact },
              op.operation_id,
            );
            return this.envelope(updated);
          }
          if (
            op.error?.code === "DELIVERY_UNKNOWN" &&
            !stringifyJson(result).includes(marker)
          )
            return this.envelope(
              this.fail(
                op,
                new AgentLordError(
                  "DELIVERY_UNKNOWN",
                  "the operation marker is absent from the bounded transcript; resend requires an explicit decision",
                  {
                    requires_authorization: true,
                    details: { operation_id: op.operation_id },
                  },
                ),
              ),
            );
          const next = autoRead ? this.app.read(op, task) : undefined;
          return this.envelope(
            this.setStatus(
              op.operation_id,
              next ? "awaiting_action" : "submitted",
              { observed, ...(next ? { action_id: next.action_id } : {}) },
            ),
            next,
          );
        }
        return this.envelope(
          this.fail(
            op,
            new AgentLordError("RESULT_INVALID", "unknown Codex action kind", {
              details: { kind: action.kind },
            }),
          ),
        );
      },
    );
  }
  check(taskId: string): Envelope {
    const task = this.store.task(taskId);
    const id = task.last_operation_id;
    if (!id)
      return {
        version: 1,
        status: "IDLE",
        task_id: taskId,
        provider: task.provider,
        endpoint_id: task.endpoint_id,
      };
    return withLock(
      "operation-control",
      leaseId("control", id),
      this.root,
      () => {
        const op = this.store.operation(id);
        const action = this.store.pendingAction(id);
        if (action || TERMINAL_STATES.has(op.status))
          return this.envelope(op, action);
        if (task.provider === "codex-app") {
          const next = this.app.read(op, task);
          return this.envelope(
            this.setStatus(id, "awaiting_action", {
              action_id: next.action_id,
            }),
            next,
          );
        }
        const result = this.envelope(op);
        const pid =
          task.provider === "claude-cli"
            ? this.claudeController(op)
            : op.controller_pid;
        if (pid != null && !pidAlive(pid))
          result.observed = {
            ...op.observed,
            supervision: {
              ...object(op.observed.supervision),
              controller_state: "exited",
              recovery_command: "checkpoint",
            },
          };
        return result;
      },
    );
  }
  exportArtifact(
    taskId: string,
    operationId: string,
    sourceFile: string,
    format: string,
  ): Envelope {
    const op = this.store.operation(operationId);
    if (op.task_id !== taskId)
      throw new AgentLordError(
        "ENDPOINT_MISMATCH",
        "operation does not belong to task_id",
      );
    if (op.provider === "mcode-cli")
      throw usageError(
        "mcode-stream-json does not contain a verifiable Agent Lord operation marker; auxiliary MCode import is refused",
        { source_format: format, operation_id: operationId },
      );
    if (op.provider === "claude-cli") {
      if (format !== "claude-jsonl")
        throw usageError(
          "a claude-cli operation can only be proven by its own claude-jsonl session log",
          { source_format: format },
        );
      if (!op.endpoint_id)
        throw new AgentLordError(
          "ENDPOINT_MISMATCH",
          "cannot bind a Claude transcript without the saved session identity",
          { details: { operation_id: operationId } },
        );
    }
    const extracted = extractJsonlWithMetadata(
      resolvePath(sourceFile),
      format,
      op.provider === "claude-cli" ? undefined : operationMarker(operationId),
      op.provider === "claude-cli" ? op.endpoint_id! : undefined,
    );
    const observed = extracted.observed;
    const models = strings(observed.models);
    const model = op.expected.model;
    const effort = op.expected.effort;
    const reject = (code: string, message: string, details: Data): never => {
      const error = new AgentLordError(code, message, {
        retryable: true,
        safe_recovery: "RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
        details,
      });
      if (!TERMINAL_STATES.has(op.status)) this.fail(op, error);
      throw error;
    };
    if (
      model &&
      (!models.length ||
        !models.every((v) =>
          op.provider === "claude-cli"
            ? expectedModelMatches(model, v)
            : model.toLowerCase() === v.toLowerCase(),
        ))
    )
      reject(
        models.length ? "MODEL_MISMATCH" : "MODEL_UNVERIFIED",
        "provider log does not satisfy the saved model contract",
        { expected: model, observed: models },
      );
    if (effort) {
      if (observed.effort && observed.effort !== effort)
        reject(
          "EFFORT_MISMATCH",
          "provider log does not satisfy the saved reasoning-effort contract",
          { expected: effort, observed: observed.effort },
        );
      if (!observed.effort) {
        if (format !== "claude-jsonl")
          reject(
            "EFFORT_UNVERIFIED",
            "provider log does not satisfy the saved reasoning-effort contract",
            { expected: effort, observed: observed.effort ?? null },
          );
        observed.warnings = [
          ...records(observed.warnings),
          {
            code: "EFFORT_UNVERIFIABLE_FORMAT",
            source_format: format,
            expected_effort: effort,
          },
        ];
      }
    }
    const artifact = writeArtifact(
      taskId,
      operationId,
      extracted.text,
      this.root,
    );
    const updated = this.setStatus(operationId, op.status, {
      artifact,
      observed,
    });
    this.store.event(taskId, "artifact-exported", artifact, operationId);
    return this.envelope(updated);
  }
  envelope(op: Operation, supplied?: Action, resolveAction = true): Envelope {
    const action =
      supplied ??
      (resolveAction ? this.store.pendingAction(op.operation_id) : undefined);
    const status: Envelope["status"] =
      op.status === "succeeded"
        ? "SUCCEEDED"
        : op.status === "failed"
          ? "ERROR"
          : op.status === "needs_decision"
            ? "NEEDS_DECISION"
            : op.status === "awaiting_action" && action
              ? "ACTION_REQUIRED"
              : "RUNNING";
    const result: Envelope = {
      version: 1,
      status,
      task_id: op.task_id,
      operation_id: op.operation_id,
      provider: op.provider,
      operation_status: op.status,
      expected: op.expected,
      observed: op.observed,
      source: op.source,
      workspace: op.workspace ?? {},
      parallel_plan: op.parallel_plan ?? {},
      ...(op.invocation ? { invocation: op.invocation } : {}),
      provider_return_code:
        typeof op.provider_return_code === "number"
          ? op.provider_return_code
          : null,
      timing: {
        created_at_ms: Date.parse(op.created_at),
        completed_at_ms:
          typeof op.completed_at === "string"
            ? Date.parse(op.completed_at)
            : null,
      },
    };
    if (op.handoff) {
      const h = op.handoff;
      result.handoff = {
        schema: h.schema,
        handoff_id: h.handoff_id,
        relationship: h.relationship,
        source_session: h.source_session,
        packet_sha256: object(h.packet).sha256,
        packet_bytes: object(h.packet).bytes,
        workspace_snapshot: h.workspace_snapshot,
      };
    }
    if (this.store.hasTask(op.task_id)) {
      const task = this.store.task(op.task_id);
      result.endpoint_id = task.endpoint_id;
      result.route = task.route;
      result.target = task.target;
    }
    if (op.artifact) result.artifact = op.artifact;
    if (op.status === "succeeded")
      result.delivery = op.delivery ?? {
        status: "unverified",
        scope: "declared-files-and-commit",
        checks: [],
      };
    if (op.continuation) result.continuation = op.continuation;
    if (op.error) result.error = op.error;
    if (records(op.observed.warnings).length)
      result.warnings = op.observed.warnings;
    if (action) result.action = actionPublic(action);
    return result;
  }
  /** Opt-in, operation-bound final text; no provider calls or additional status transitions. */
  withResponse(envelope: Envelope): Envelope {
    if (envelope.actionable)
      return {
        ...envelope,
        actionable: envelope.actionable.map((item) => this.withResponse(item)),
      };
    if (envelope.status !== "SUCCEEDED" || !envelope.operation_id)
      return envelope;
    const op = this.store.operation(envelope.operation_id);
    if (
      op.task_id !== envelope.task_id ||
      op.status !== "succeeded" ||
      !op.artifact
    )
      throw usageError("final response is not bound to a succeeded operation");
    let text: string;
    try {
      const expected = path.join(
        realpathSync(this.root),
        "artifacts",
        op.task_id,
        `${op.operation_id}.md`,
      );
      if (
        realpathSync(op.artifact.path) !== expected ||
        realpathSync(expected) !== expected
      )
        throw new Error("artifact path mismatch");
      const bytes = readFileSync(expected);
      if (
        bytes.length !== op.artifact.bytes ||
        sha256(bytes) !== op.artifact.sha256
      )
        throw new Error("artifact integrity mismatch");
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new AgentLordError(
        "ARTIFACT_INVALID",
        "cannot read the canonical final response",
        {
          details: {
            operation_id: op.operation_id,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    return { ...envelope, response: { text, read_at_ms: Date.now() } };
  }
  // Checkpoint takes over only after the original controller has released its lease.
  private claudeController(op: Operation): unknown {
    return (
      object(op.active_attempt).controller_pid ||
      op.recovery_controller_pid ||
      op.controller_pid
    );
  }
  private retryOrTerminalizeClaude(
    op: Operation,
    error: AgentLordError,
    sessionObserved: boolean,
  ): [Operation | null, Envelope | null] {
    const active = object(op.active_attempt);
    const models = this.retryModels(op);
    if (!integer(active.number) || !string(active.model))
      return [null, this.envelope(this.terminalize(op, error)[0])];
    const retrying =
      error.retryable && (op.attempt_history ?? []).length + 1 < models.length;
    const updated = this.recordClaudeAttempt(
      op,
      active.number,
      String(active.model),
      "failed",
      { error, sessionObserved, retrying, claim: false },
    );
    return retrying
      ? [updated, null]
      : [
          null,
          this.envelope(this.terminalize(updated, error, error.retryable)[0]),
        ];
  }
  async recoverClaudeOperation(operationId: string): Promise<Envelope> {
    validateIdentifier("operation_id", operationId);
    const lease = await acquireLease(
      "controller-lease",
      leaseId("controller", operationId),
      this.root,
      this.control,
      "another controller owns this recovery",
    );
    try {
      let op = this.store.operation(operationId);
      if (TERMINAL_STATES.has(op.status)) return this.envelope(op);
      if (op.provider !== "claude-cli" || op.status !== "recovering")
        throw new AgentLordError(
          "STATE_CONFLICT",
          "operation is not awaiting Claude recovery",
          { details: { operation_id: operationId, status: op.status } },
        );
      if (op.recovery_controller_pid !== process.pid) {
        if (pidAlive(op.recovery_controller_pid)) return this.envelope(op);
        op = this.setStatus(operationId, "recovering", {
          recovery_controller_pid: process.pid,
          controller_pid: process.pid,
        });
      }
      let writes: Lease | undefined;
      try {
        writes = this.workspaces.writeLeases(
          op.target,
          op.read_only,
          op.workspace ?? { policy: "exact-target" },
          operationId,
        );
        return await this.finishClaude(op, op.kind === "turn");
      } catch (error) {
        const current = this.store.operation(operationId);
        if (TERMINAL_STATES.has(current.status)) return this.envelope(current);
        if (
          error instanceof AgentLordError &&
          [
            "STATE_BUSY",
            "WORKSPACE_WRITE_CONFLICT",
            "BRANCH_WRITE_CONFLICT",
          ].includes(error.code)
        )
          return this.envelope(current);
        throw error;
      } finally {
        writes?.release();
      }
    } finally {
      lease.release();
    }
  }
  private async launchClaudeRecovery(
    operationId: string,
  ): Promise<Envelope | null> {
    try {
      return await withAsyncLock(
        "controller-lease",
        leaseId("controller", operationId),
        this.root,
        async () => {
          const op = this.store.operation(operationId);
          if (TERMINAL_STATES.has(op.status)) return this.envelope(op);
          if (
            op.provider !== "claude-cli" ||
            op.status !== "recovering" ||
            pidAlive(op.recovery_controller_pid)
          )
            return null;
          const budget = this.retryModels(op).length;
          const attempts = (op.attempt_history ?? []).length;
          const launches =
            integer(op.recovery_controller_launches) &&
            op.recovery_controller_launches >= 0
              ? op.recovery_controller_launches
              : 0;
          if (attempts >= budget || launches >= Math.max(1, budget))
            return this.envelope(
              this.terminalize(
                op,
                new AgentLordError(
                  "PROVIDER_FAILED",
                  "Claude recovery budget is exhausted",
                  {
                    details: {
                      attempts,
                      retry_budget: budget,
                      controller_launches: launches,
                    },
                  },
                ),
                true,
              )[0],
            );
          if (!op.endpoint_id)
            return this.envelope(
              this.terminalize(
                op,
                new AgentLordError(
                  "PROCESS_EXITED_WITHOUT_RESULT",
                  "Claude recovery cannot continue without the original session identity",
                  { details: { operation_id: operationId } },
                ),
              )[0],
            );
          const source = import.meta.url.endsWith(".ts");
          const worker = fileURLToPath(
            new URL(
              source ? "./recovery-worker.ts" : "./recovery-worker.js",
              import.meta.url,
            ),
          );
          // Resolve the development loader before changing the worker's working directory.
          const args = [
            ...(source
              ? ["--import", createRequire(import.meta.url).resolve("tsx")]
              : []),
            worker,
            "--state-dir",
            this.root,
            "--operation-id",
            operationId,
          ];
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(process.execPath, args, {
              stdio: "ignore",
              detached: process.platform !== "win32",
              windowsHide: true,
            });
            await new Promise<void>((resolve, reject) => {
              child.once("spawn", resolve);
              child.once("error", reject);
            });
          } catch (error) {
            return this.envelope(
              this.terminalize(
                op,
                new AgentLordError(
                  "PROVIDER_UNAVAILABLE",
                  "cannot launch the deterministic Claude recovery controller",
                  { details: { error: String(error) } },
                ),
              )[0],
            );
          }
          this.setStatus(operationId, "recovering", {
            recovery_controller_pid: child.pid!,
            controller_pid: child.pid!,
            recovery_controller_launches: launches + 1,
          });
          this.store.event(
            op.task_id,
            "provider-recovery-controller-launched",
            { controller_pid: child.pid, launch: launches + 1 },
            operationId,
          );
          child.unref();
          return null;
        },
      );
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "STATE_BUSY")
        return null;
      throw error;
    }
  }
  private async superviseClaude(initial: Operation): Promise<Envelope | null> {
    const id = initial.operation_id;
    if (initial.status === "recovering" && !initial.active_attempt)
      return this.launchClaudeRecovery(id);
    if (pidAlive(this.claudeController(initial))) return null;
    let recovery: Operation | null = null;
    try {
      const envelope = await withAsyncLock(
        "controller-lease",
        leaseId("controller", id),
        this.root,
        async (): Promise<Envelope | null> => {
          let op = this.store.operation(id);
          if (TERMINAL_STATES.has(op.status)) return this.envelope(op);
          if (pidAlive(this.claudeController(op))) return null;
          const active = object(op.active_attempt);
          const pid = active.pid || op.pid;
          let failure: AgentLordError | null = null;
          const terminal = (error: AgentLordError) =>
            this.envelope(this.terminalize(op, error)[0]);
          const fence = () =>
            terminateProcess(
              pid,
              active.process_group_id,
              this.control.claude_terminate_grace_seconds,
            );
          if (op.status === "preparing") {
            const delivery = active.prompt_delivery;
            if (
              ["delivery-unknown", "stdin-attached"].includes(
                String(delivery),
              ) &&
              !integer(pid)
            )
              return terminal(
                new AgentLordError(
                  "DELIVERY_UNKNOWN",
                  "Claude may have received the prompt but its provider process cannot be fenced",
                  { details: { operation_id: id, prompt_delivery: delivery } },
                ),
              );
            try {
              if (integer(pid) && pidAlive(pid)) await fence();
            } catch (error) {
              if (error instanceof AgentLordError) return terminal(error);
              throw error;
            }
            if (Object.keys(active).length)
              failure = new AgentLordError(
                "CONTROLLER_EXITED_DURING_DELIVERY",
                "Claude controller exited before attempt delivery was resolved",
                {
                  retryable: true,
                  safe_recovery:
                    delivery === "not-delivered"
                      ? "RETRY_ORIGINAL_PROMPT"
                      : "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                  details: { prompt_delivery: delivery },
                },
              );
            else if (this.retryModels(op).length && op.endpoint_id) {
              recovery = this.setStatus(id, "recovering", {
                controller_pid: null,
                recovery_controller_pid: null,
              });
              return null;
            } else
              return terminal(
                new AgentLordError(
                  "PROCESS_EXITED_WITHOUT_RESULT",
                  "Claude controller exited before a recoverable attempt was prepared",
                ),
              );
          } else if (pidAlive(pid)) {
            const activity = claudeOutputActivityMs(op);
            const stall =
              active.progress_state === "tool_wait"
                ? this.control.claude_tool_stall_seconds
                : this.control.claude_stall_seconds;
            if (activity === null || Date.now() - activity < stall * 1000)
              return null;
            this.setStatus(id, op.status, {
              observed: {
                ...op.observed,
                supervision: {
                  state: "suspected_stall",
                  attempt: active.number,
                  last_progress_at_ms: activity,
                  controller_state: "dead",
                },
              },
            });
            try {
              await fence();
            } catch (error) {
              if (error instanceof AgentLordError) return terminal(error);
              throw error;
            }
            failure = new AgentLordError(
              "PROVIDER_STALLED",
              "Claude controller disappeared and the live provider attempt stopped making progress",
              {
                retryable: true,
                safe_recovery: "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                details: { provider_pid: pid },
              },
            );
          } else {
            try {
              if (integer(pid)) await fence();
            } catch (error) {
              if (error instanceof AgentLordError) return terminal(error);
              throw error;
            }
            let result: ProviderResult | undefined;
            try {
              result = recoverClaude(op);
            } catch (error) {
              if (!(error instanceof AgentLordError)) throw error;
              failure = error;
              if (error.code === "RESULT_INVALID") {
                if (this.resultGrace(op)) return null;
                failure = new AgentLordError(
                  "PROCESS_EXITED_WITHOUT_RESULT",
                  "Claude process exited without publishing a recoverable terminal result",
                  {
                    retryable: true,
                    safe_recovery:
                      "RESUME_SAME_ENDPOINT_WITH_CONTINUATION_QUERY",
                    details: { provider_error: error.asRecord() },
                  },
                );
              }
            }
            if (result) {
              if (!result.endpoint_id)
                return terminal(
                  new AgentLordError(
                    "RESULT_INVALID",
                    "recovered Claude result lacks endpoint identity",
                  ),
                );
              if (integer(active.number) && string(active.model))
                op = this.recordClaudeAttempt(
                  op,
                  active.number,
                  String(active.model),
                  "succeeded",
                  { warnings: records(object(result.observed).warnings) },
                );
              result.observed = {
                ...object(result.observed),
                attempts: (op.attempt_history ?? []).length,
                attempt_history: op.attempt_history ?? [],
                requested_model: op.expected.model,
                fallback_used:
                  !!string(active.model) && active.model !== op.expected.model,
              };
              return this.publish(op, result, op.kind === "turn");
            }
          }
          const [claim, terminalEnvelope] = this.retryOrTerminalizeClaude(
            op,
            failure!,
            claudeSessionObserved(op),
          );
          recovery = claim;
          return terminalEnvelope;
        },
      );
      if (envelope) return envelope;
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "STATE_BUSY")
        return null;
      throw error;
    }
    return recovery ? this.launchClaudeRecovery(id) : null;
  }
  private resultGrace(op: Operation): boolean {
    const seen = op.dead_process_observed_at_ms;
    if (!integer(seen)) {
      this.setStatus(op.operation_id, op.status, {
        dead_process_observed_at_ms: Date.now(),
      });
      return true;
    }
    return (
      Date.now() - seen < this.control.dead_process_result_grace_seconds * 1000
    );
  }
  private async superviseMcode(initial: Operation): Promise<Envelope | null> {
    if (pidAlive(initial.controller_pid)) return null;
    const id = initial.operation_id;
    try {
      return await withAsyncLock(
        "operation-control",
        leaseId("control", id),
        this.root,
        async () => {
          const op = this.store.operation(id);
          if (TERMINAL_STATES.has(op.status)) return this.envelope(op);
          if (pidAlive(op.controller_pid)) return null;
          const a = object(op.active_attempt);
          const pid = a.pid || op.pid;
          const group = a.process_group_id;
          const fail = (error: AgentLordError) =>
            this.envelope(this.fail(op, error));
          if (op.status === "preparing" && !op.provider_command)
            return fail(
              new AgentLordError(
                "PROCESS_EXITED_WITHOUT_RESULT",
                "MCode controller exited before its provider attempt was prepared",
                {
                  retryable: true,
                  safe_recovery: "RETRY_SAME_COMMAND",
                  details: { operation_id: id },
                },
              ),
            );
          if (op.status === "preparing" && !integer(pid))
            return fail(
              new AgentLordError(
                "DELIVERY_UNKNOWN",
                "MCode controller exited while launching its provider attempt and no operation process can be fenced",
                {
                  requires_authorization: true,
                  details: {
                    operation_id: id,
                    prompt_delivery: a.prompt_delivery,
                  },
                },
              ),
            );
          if (integer(pid) && groupAlive(pid, group)) {
            if (
              !processIdentityMatches(
                pid,
                group,
                a.result_path || op.result_path,
              )
            )
              return fail(
                new AgentLordError(
                  "PROCESS_FENCE_FAILED",
                  "MCode operation process identity cannot be bound to this journal before fencing",
                  { details: { pid, process_group_id: group } },
                ),
              );
            try {
              await terminateProcess(
                pid,
                group,
                this.control.mcode_terminate_grace_seconds,
              );
            } catch (error) {
              if (error instanceof AgentLordError) return fail(error);
              throw error;
            }
          }
          let result: ProviderResult;
          try {
            result = recoverMcode(op);
          } catch (error) {
            if (!(error instanceof AgentLordError)) throw error;
            let failure = error;
            const current = this.store.operation(id);
            if (current.endpoint_id)
              this.ensureMcodeTask(id, current.endpoint_id);
            if (
              error.code === "RESULT_INVALID" &&
              (error.message.includes("exactly one final exec.completed") ||
                error.message === "MCode stream is empty")
            ) {
              if (this.resultGrace(current)) return null;
              failure = new AgentLordError(
                "DELIVERY_UNKNOWN",
                "MCode operation ended without a complete terminal record; the prompt will not be resent",
                {
                  requires_authorization: true,
                  details: {
                    operation_id: id,
                    endpoint_id: current.endpoint_id ?? null,
                    provider_error: error.asRecord(),
                  },
                },
              );
            }
            return this.envelope(this.terminalize(current, failure)[0]);
          }
          if (!result.endpoint_id)
            return fail(
              new AgentLordError(
                "RESULT_INVALID",
                "recovered MCode result lacks Session identity",
              ),
            );
          this.ensureMcodeTask(id, result.endpoint_id);
          return this.publish(op, result, op.kind === "turn");
        },
      );
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "STATE_BUSY")
        return null;
      throw error;
    }
  }
  private async superviseCodex(initial: Operation): Promise<Envelope | null> {
    if (
      initial.status === "preparing"
        ? pidAlive(initial.controller_pid)
        : pidAlive(initial.pid)
    )
      return null;
    const id = initial.operation_id;
    try {
      return await withAsyncLock(
        "operation-control",
        leaseId("control", id),
        this.root,
        async () => {
          const op = this.store.operation(id);
          const fail = (error: AgentLordError) =>
            this.envelope(this.fail(op, error));
          if (op.status === "preparing") {
            if (pidAlive(op.controller_pid) || pidAlive(op.pid)) return null;
            return fail(
              op.provider_command
                ? new AgentLordError(
                    "DELIVERY_UNKNOWN",
                    "Codex CLI controller exited while launching its provider attempt",
                    {
                      requires_authorization: true,
                      details: { operation_id: id },
                    },
                  )
                : new AgentLordError(
                    "PROCESS_EXITED_WITHOUT_RESULT",
                    "Codex CLI controller exited before its provider attempt was launched",
                    {
                      retryable: true,
                      safe_recovery: "RETRY_SAME_COMMAND",
                      details: { operation_id: id },
                    },
                  ),
            );
          }
          if (op.status !== "running" || pidAlive(op.pid)) return null;
          let result: ProviderResult;
          try {
            result = recoverCodex(op);
          } catch (error) {
            if (!(error instanceof AgentLordError)) throw error;
            let failure = error;
            if (error.code === "RESULT_INVALID") {
              if (this.resultGrace(op)) return null;
              failure = new AgentLordError(
                "PROCESS_EXITED_WITHOUT_RESULT",
                "Codex CLI process exited without publishing a recoverable terminal result",
                {
                  retryable: true,
                  safe_recovery: "INSPECT_LOGS_THEN_RETRY_SAME_ENDPOINT",
                  details: { provider_error: error.asRecord() },
                },
              );
            }
            return fail(failure);
          }
          if (!result.endpoint_id)
            return fail(
              new AgentLordError(
                "RESULT_INVALID",
                "recovered Codex CLI result lacks endpoint identity",
              ),
            );
          return this.publish(op, result, op.kind === "turn");
        },
      );
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "STATE_BUSY")
        return null;
      throw error;
    }
  }
  private checkpointBatch(
    envelopes: Envelope[],
    active: ActiveOperation[],
  ): Envelope {
    const ids = new Set(envelopes.map((v) => v.operation_id));
    return {
      version: 1,
      status: "CHECKPOINT_ACTIONABLE",
      actionable: envelopes,
      active: compactActive(
        active.filter((v) => !ids.has(v.operation.operation_id)),
      ),
    };
  }
  async checkpoint(
    taskIds: string[] | undefined,
    seconds: number,
    startingIds?: string[],
  ): Promise<[Envelope, boolean]> {
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw usageError("checkpoint seconds must be greater than zero");
    taskIds?.forEach((v) => validateIdentifier("task_id", v));
    startingIds?.forEach((v) => validateIdentifier("starting_task_id", v));
    const known = taskIds ? [...new Set(taskIds)] : undefined;
    const starting = startingIds ? [...new Set(startingIds)] : [];
    const both = starting.filter((id) => known?.includes(id));
    if (both.length)
      throw usageError(
        "a task_id must be selected either as known or as starting, not both",
        { task_ids: both },
      );
    const explicit =
      known || starting.length ? [...(known ?? []), ...starting] : undefined;
    const scan = new CheckpointScan(this.store);
    scan.tick(explicit);
    let active = scan.active(explicit, starting);
    const selected = explicit ?? active.map((v) => v.task_id);
    /** Starting ids are reported every return so pending is never silent. */
    const report = (envelope: Envelope): Envelope =>
      starting.length
        ? {
            ...envelope,
            starting: starting.map((id) => scan.observedPhase(id)),
          }
        : envelope;
    const actionable = () => {
      const envelopes = scan
        .latest(selected)
        .filter(
          (op) =>
            TERMINAL_STATES.has(op.status) || scan.action(op.operation_id),
        )
        .map((op) => this.envelope(op, scan.action(op.operation_id), false));
      return envelopes.length ? this.checkpointBatch(envelopes, active) : null;
    };
    let result = actionable();
    if (result) return [report(result), false];
    const quiet = (): [Envelope, boolean] => [
      report({
        version: 1,
        status: "CHECKPOINT_QUIET",
        seconds,
        active: compactActive(active),
      }),
      true,
    ];
    if (!selected.length) return quiet();
    const deadline = performance.now() + seconds * 1000;
    while (performance.now() < deadline) {
      scan.tick(selected);
      active = scan.active(selected, starting);
      result = actionable();
      if (result) return [report(result), false];
      const supervised: Envelope[] = [];
      for (const { operation: op } of active) {
        let envelope: Envelope | null = null;
        try {
          if (op.provider === "claude-cli")
            envelope = await this.superviseClaude(op);
          else if (["preparing", "running"].includes(op.status))
            envelope =
              op.provider === "mcode-cli"
                ? await this.superviseMcode(op)
                : op.provider === "codex-cli"
                  ? await this.superviseCodex(op)
                  : null;
        } catch (error) {
          // Never drop envelopes already collected in this tick. The failing
          // operation stays active and is supervised again on the next
          // checkpoint tick, where a persistent error still propagates.
          if (!supervised.length) throw error;
          continue;
        }
        if (envelope) supervised.push(envelope);
      }
      if (supervised.length)
        return [report(this.checkpointBatch(supervised, active)), false];
      await delay(
        Math.min(
          250,
          Math.max(50, this.control.claude_progress_poll_interval_ms),
          Math.max(0, deadline - performance.now()),
        ),
      );
    }
    scan.tick(selected);
    active = scan.active(selected, starting);
    result = actionable();
    return result ? [report(result), false] : quiet();
  }
}
