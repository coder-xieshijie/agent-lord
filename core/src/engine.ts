import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Action,
  type Data,
  type DeliveryRequirements,
  type Envelope,
  type Operation,
  type StartOptions,
  type Task,
  type Workspace,
  TERMINAL_STATES,
  object,
  string,
} from "./contracts.js";
import {
  controlConfig,
  type Control,
  normalizeProvider,
  permissionPolicy,
  providerConfig,
  resolveExecutionDefaults,
  resolveRetryPlan,
} from "./config.js";
import { AgentLordError, usageError } from "./errors.js";
import { equal, sha256 } from "./json.js";
import {
  type Lease,
  StateStore,
  recordLock,
  readJson,
  stateDir,
  validateIdentifier,
  withAsyncLock,
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
import { operationResultKey } from "./result-key.js";
import { inspectInputs, sameInputs } from "./inputs.js";
import { resolveInvocation } from "./invocation.js";
import { workflowNodes } from "./workflow-nodes.js";
import { PlanRuns } from "./plan.js";
import { deliveryRequirements, sameDeliveryRequest } from "./delivery.js";
import { writeArtifact } from "./artifacts.js";
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
import { CodexAppAdapter } from "./providers/codex-app.js";
import { runCodex } from "./providers/codex-cli.js";
import { recoverMcode, runMcode } from "./providers/mcode-cli.js";
import { pidAlive } from "./process.js";
import {
  CheckpointScan,
  compactActive,
  type ActiveOperation,
} from "./checkpoint-scan.js";
import { OperationKernel } from "./engine/operations.js";
import { ClaudeFlows } from "./engine/claude.js";
import { McodeFlows } from "./engine/mcode.js";
import { CodexAppFlows } from "./engine/codex-app.js";
import { Reporting } from "./engine/reporting.js";

export class AgentLord {
  readonly store: StateStore;
  readonly control: Control;
  readonly workspaces: WorkspaceManager;
  readonly app: CodexAppAdapter;
  /** @internal Subsystem seam; external callers use the public facade methods. */
  readonly ops: OperationKernel;
  /** @internal Subsystem seam; external callers use the public facade methods. */
  readonly claude: ClaudeFlows;
  /** @internal Subsystem seam; external callers use the public facade methods. */
  readonly mcode: McodeFlows;
  /** @internal Subsystem seam; external callers use the public facade methods. */
  readonly codexApp: CodexAppFlows;
  /** @internal Subsystem seam; external callers use the public facade methods. */
  readonly reporting: Reporting;
  constructor(
    root = stateDir(),
    readonly background = false,
  ) {
    this.store = new StateStore(root);
    this.control = controlConfig();
    this.workspaces = new WorkspaceManager(this.store, this.control);
    this.app = new CodexAppAdapter(this.store);
    this.ops = new OperationKernel(this);
    this.claude = new ClaudeFlows(this);
    this.mcode = new McodeFlows(this);
    this.codexApp = new CodexAppFlows(this);
    this.reporting = new Reporting(this);
  }
  get root(): string {
    return this.store.root;
  }
  async start(
    taskId: string,
    rawProvider: string,
    rawTarget: string | null,
    message: string,
    opts: StartOptions = {},
  ): Promise<Envelope> {
    validateIdentifier("task_id", taskId);
    const planned = new PlanRuns(this).executionContract(
      taskId,
      opts,
      rawTarget,
    );
    if (planned) {
      opts = planned;
      rawTarget = null;
    }
    const requestId = opts.request_id
      ? validateIdentifier("request_id", opts.request_id)
      : undefined;
    const invocation = resolveInvocation(opts.invocation);
    let workflow: Data | undefined;
    if (opts.workflow_run_id) {
      const runId = validateIdentifier("run_id", opts.workflow_run_id);
      const run = readJson(
        path.join(this.root, "task-sets", `${runId}.json`),
        "RUN_UNKNOWN",
        "task set does not exist",
      );
      const nodes = workflowNodes(run.nodes);
      if (
        run.run_id !== runId ||
        !Array.isArray(run.task_ids) ||
        !run.task_ids.includes(taskId) ||
        !nodes[taskId]
      )
        throw usageError(
          "task requires declared run membership and node provenance before dispatch",
        );
      const node = nodes[taskId]!;
      if (node.source.kind === "replacement") {
        const old = this.store.task(node.source.task_id!);
        const oldOperation = this.store.operation(old.last_operation_id!);
        if (!TERMINAL_STATES.has(oldOperation.status))
          throw usageError(
            "replacement source operation must be terminal before dispatch",
          );
      }
      workflow = { run_id: runId, node, provenance_status: "caller-declared" };
    }
    const provider = normalizeProvider(rawProvider);
    providerConfig(provider);
    const cli = provider !== "codex-app";
    const readOnly = Boolean(opts.read_only);
    if (
      !cli &&
      (opts.required_files?.length ||
        opts.require_commit ||
        opts.required_inputs?.length)
    )
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
    let source = validateSource(opts.head_sha, opts.base_sha);
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
      (opts.takeover || opts.delivery_base_head != null) &&
      (!repository || readOnly)
    )
      throw usageError(
        "takeover replacement dispatch requires managed writable workspace preparation",
      );
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
      const expected = this.ops.expected(
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
              this.ops.sameStart(
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
          const active = this.ops.activeOperation(taskId);
          if (active) {
            if (
              this.ops.sameStart(
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
            writes = this.workspaces.writeLeases(
              target!,
              readOnly,
              workspace!,
              undefined,
              taskId,
            );
          if (repository) {
            const takeover = Boolean(opts.takeover);
            target = this.workspaces.prepare(
              repository,
              opts.source_branch!,
              source.head_sha!,
              target!,
              opts.workspace_policy!,
              opts.workspace_branch,
              exists,
              takeover,
            );
            if (takeover) {
              // The stopped predecessor may have committed progress on the
              // frozen branch; adopt it only as a verified descendant and
              // record the advance beside the untouched frozen source.
              const branch = opts.workspace_branch || opts.source_branch!;
              const advanced = verifyManagedAdvance(target, source, branch);
              if (advanced) {
                source = { ...source, verified_head_sha: advanced };
                this.store.event(taskId, "source-head-advanced", {
                  frozen_head: source.head_sha,
                  verified_head: advanced,
                  branch,
                });
              }
            } else verifyBase(target, source);
            prepare!.release();
            prepare = undefined;
          }
          const inputEvidence = inspectInputs(target!, opts.required_inputs);
          const id = this.ops.operationId(taskId, "start");
          if (provider === "claude-cli")
            controller = recordLock(
              "controller-lease",
              leaseId("controller", id),
              this.root,
            );
          operation = this.ops.newOperation(
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
              ...(workflow ? { workflow } : {}),
              ...(requestId ? { request_id: requestId } : {}),
              ...(cli ? { controller_pid: process.pid } : {}),
              ...(provider === "claude-cli"
                ? { endpoint_id: randomUUID() }
                : {}),
              delivery_requirements: new PlanRuns(this).executionDelivery(
                taskId,
                deliveryRequirements(
                  target!,
                  opts.required_files,
                  Boolean(opts.require_commit),
                  // A takeover keeps the lineage root's delivery base so the
                  // adopted commits still count as this lineage's delivery.
                  opts.takeover ? opts.delivery_base_head : undefined,
                ),
              ),
              input_evidence: inputEvidence,
              resume: false,
            },
          );
          if (!cli) {
            action = this.app.create(
              operation,
              opts.codex_environment ?? "worktree",
              opts.starting_branch,
            );
            operation = this.ops.setStatus(id, "awaiting_action", {
              action_id: action.action_id,
            });
          }
          return undefined;
        },
      );
      group?.release();
      group = undefined;
      if (existing) return existing;
      if (cli) {
        if (this.background) {
          controller?.release();
          controller = undefined;
          writes?.release();
          writes = undefined;
          return await this.launchExecution(operation!);
        }
        return await this.finishCli(operation!, false);
      }
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
    const expected = this.ops.expected(
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
            : this.ops.activeOperation(taskId);
          if (previous) {
            if (
              this.ops.sameStart(
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
          if (new PlanRuns(this).executionDelivery(taskId, null))
            throw new AgentLordError(
              "PLAN_BARRIER",
              "plan roles must use start after role registration, not a handoff contract",
              { exit_code: 2 },
            );
          verifyCheckout(target, source);
          const snapshot = snapshotExactTarget(target);
          writes = this.workspaces.writeLeases(
            target,
            readOnly,
            workspace,
            undefined,
            taskId,
          );
          const id = this.ops.operationId(taskId, "handoff");
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
          operation = this.ops.newOperation(
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
            this.ops.fail(operation, error);
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
      if (existing) return existing;
      if (this.background) {
        controller?.release();
        controller = undefined;
        writes?.release();
        writes = undefined;
        return await this.launchExecution(operation!);
      }
      return await this.finishCli(operation!, false);
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
      | "required_files"
      | "required_inputs"
      | "require_commit"
      | "invocation"
      | "request_id"
    > & {
      recovery_from?: string;
    } = {},
  ): Promise<Envelope> {
    validateIdentifier("task_id", taskId);
    if (new PlanRuns(this).executionDelivery(taskId, null)?.require_commit)
      opts = { ...opts, require_commit: true };
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
          if (
            !cli &&
            (opts.required_files?.length ||
              opts.require_commit ||
              opts.required_inputs?.length)
          )
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
          const active = this.ops.activeOperation(taskId);
          if (active) {
            if (
              active.message_sha256 === sha256(message) &&
              sameInputs(active, opts.required_inputs) &&
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
              undefined,
              task.task_id,
            );
          }
          const expected = this.ops.expected(
            task.provider,
            contract.model,
            contract.effort,
            contract.read_only,
            contract.retry_plan,
            contract.permission_mode,
            contract.continuation_limit ?? 0,
          );
          const inputEvidence = opts.recovery_from
            ? (this.store.operation(opts.recovery_from).input_evidence ?? [])
            : inspectInputs(task.target, opts.required_inputs);
          const id = this.ops.operationId(taskId, "turn");
          const workflow = task.last_operation_id
            ? this.store.operation(task.last_operation_id).workflow
            : undefined;
          if (task.provider === "claude-cli")
            controller = recordLock(
              "controller-lease",
              leaseId("controller", id),
              this.root,
            );
          operation = this.ops.newOperation(
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
              ...(workflow ? { workflow } : {}),
              ...(requestId ? { request_id: requestId } : {}),
              ...(cli
                ? { controller_pid: process.pid, endpoint_id: task.endpoint_id }
                : {}),
              parallel_plan: contract.parallel_plan ?? {},
              input_evidence: inputEvidence,
              resume: true,
              ...(continuation ? { continuation } : {}),
              delivery_requirements: new PlanRuns(this).executionDelivery(
                taskId,
                opts.recovery_from
                  ? delivery
                  : deliveryRequirements(
                      task.target,
                      opts.required_files,
                      Boolean(opts.require_commit),
                    ),
              ),
            },
          );
          if (continuation)
            this.store.event(taskId, "operation-continued", continuation, id);
          if (!cli) {
            action = this.app.send(operation, task);
            operation = this.ops.setStatus(id, "awaiting_action", {
              action_id: action.action_id,
            });
          }
          this.ops.setLast(taskId, id);
          return undefined;
        },
      );
      if (existing) return existing;
      if (this.background && operation!.provider !== "codex-app") {
        controller?.release();
        controller = undefined;
        writes?.release();
        writes = undefined;
        return await this.launchExecution(operation!);
      }
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
  /** The journal reserves the workspace before its leases pass to the worker. */
  private async launchExecution(op: Operation): Promise<Envelope> {
    const source = import.meta.url.endsWith(".ts");
    const worker = fileURLToPath(
      new URL(
        source ? "./execution-worker.ts" : "./execution-worker.js",
        import.meta.url,
      ),
    );
    const args = [
      ...(source
        ? ["--import", createRequire(import.meta.url).resolve("tsx")]
        : []),
      worker,
      "--state-dir",
      this.root,
      "--operation-id",
      op.operation_id,
    ];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      return this.ops.raiseFailure(
        op,
        new AgentLordError(
          "PROVIDER_UNAVAILABLE",
          "cannot launch execution controller",
          {
            details: { error: String(error) },
            retryable: true,
          },
        ),
      );
    }
    const updated = this.ops.setStatus(op.operation_id, "preparing", {
      controller_pid: child.pid!,
      execution_worker_pid: child.pid!,
    });
    child.unref();
    return this.envelope(updated);
  }
  /** Private entry: only the process named by the durable dispatch may execute. */
  async executeOperation(id: string): Promise<Envelope> {
    validateIdentifier("operation_id", id);
    const deadline = Date.now() + 5000;
    let op = this.store.operation(id);
    while (op.execution_worker_pid !== process.pid && Date.now() < deadline) {
      if (TERMINAL_STATES.has(op.status) || !pidAlive(op.controller_pid))
        throw new AgentLordError(
          "STATE_CONFLICT",
          "execution worker was not assigned this operation",
        );
      await delay(20);
      op = this.store.operation(id);
    }
    if (op.execution_worker_pid !== process.pid || op.provider === "codex-app")
      throw new AgentLordError(
        "STATE_CONFLICT",
        "execution worker identity mismatch",
      );
    return withAsyncLock(
      "controller-lease",
      leaseId("controller", id),
      this.root,
      async () => {
        const current = this.store.operation(id);
        if (TERMINAL_STATES.has(current.status)) return this.envelope(current);
        if (current.provider_command || current.controller_pid !== process.pid)
          throw new AgentLordError(
            "STATE_CONFLICT",
            "execution already started or ownership changed",
          );
        let writes: Lease | undefined;
        try {
          writes = this.workspaces.writeLeases(
            current.target,
            current.read_only,
            current.workspace ?? { policy: "exact-target" },
            id,
            current.task_id,
          );
          const branch =
            current.workspace?.workspace_branch ??
            current.workspace?.source_branch;
          if (branch && !current.read_only)
            verifyManagedAdvance(current.target, current.source, branch);
          else verifyCheckout(current.target, current.source);
          return await this.finishCli(current, Boolean(current.resume));
        } catch (error) {
          // Unknown failures retain a nonterminal journal for checkpoint fencing.
          if (!(error instanceof AgentLordError) || error.code === "STATE_BUSY")
            throw error;
          const latest = this.store.operation(id);
          if (TERMINAL_STATES.has(latest.status)) return this.envelope(latest);
          return this.envelope(this.ops.fail(latest, error));
        } finally {
          writes?.release();
        }
      },
    );
  }
  private async finishCli(op: Operation, resume: boolean): Promise<Envelope> {
    if (op.provider === "claude-cli")
      return this.claude.finishClaude(op, resume);
    try {
      const result =
        op.provider === "mcode-cli"
          ? await runMcode(this.store, op, this.control, (id) =>
              this.mcode.ensureMcodeTask(op.operation_id, id),
            )
          : await runCodex(this.store, op);
      return await this.ops.publish(op, result, resume);
    } catch (error) {
      if (!(error instanceof AgentLordError) || error.code === "STATE_BUSY")
        throw error;
      const current = this.store.operation(op.operation_id);
      if (op.provider === "mcode-cli" && current.endpoint_id)
        this.mcode.ensureMcodeTask(op.operation_id, current.endpoint_id);
      return this.ops.raiseFailure(current, error);
    }
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
    let recoveryHint = "";
    try {
      recoverMcode(parent);
    } catch (error) {
      if (!(error instanceof AgentLordError)) throw error;
      plan = this.mcode.mcodeContinuation(parent, error);
      if (
        plan &&
        /stream ended before message_stop/i.test(
          string(object(error.details.provider_error).message) ?? "",
        )
      ) {
        recoveryHint =
          "The previous provider response stream ended before its completion marker. If a large write was interrupted, consider smaller writes or incremental edits after checking what is already saved, so progress survives another interruption. Choose the tools, chunk sizes, and recovery approach yourself; no fixed size or implementation method is required.\n";
      }
    }
    if (!plan)
      throw new AgentLordError(
        "RECOVERY_UNAVAILABLE",
        "operation has no remaining verified same-session continuation",
      );
    return [
      { ...plan, parent_operation_id: parentId },
      `[agent-lord-continuation:${plan.root_operation_id}:${plan.attempt}]\nContinue the original task in this same session after the previous verified run ended with a transient provider failure. Inspect the existing conversation, current worktree, completed commands and any background work first. Preserve completed work and finish only the remaining authorized requirements. Do not repeat already completed actions. Return the final result and verification evidence.\n${recoveryHint}`,
    ];
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
    acknowledged?: ReadonlySet<string>,
    // A caller that also builds run status may pass its scan so one
    // supervision pass shares the parsed-operation cache end to end.
    scan: CheckpointScan = new CheckpointScan(this.store),
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
            (TERMINAL_STATES.has(op.status) &&
              !acknowledged?.has(operationResultKey(op))) ||
            scan.action(op.operation_id),
        )
        .map((op) => ({
          ...this.envelope(op, scan.action(op.operation_id), false),
          ...(acknowledged && TERMINAL_STATES.has(op.status)
            ? { result_key: operationResultKey(op) }
            : {}),
        }));
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
    if (
      !selected.length ||
      (acknowledged &&
        !active.length &&
        scan.latest(selected).length === selected.length)
    )
      return quiet();
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
            envelope = await this.claude.superviseClaude(op);
          else if (["preparing", "running"].includes(op.status))
            envelope =
              op.provider === "mcode-cli"
                ? await this.mcode.superviseMcode(op)
                : op.provider === "codex-cli"
                  ? await this.codexApp.superviseCodex(op)
                  : null;
        } catch (error) {
          // Never drop envelopes already collected in this tick. The failing
          // operation stays active and is supervised again on the next
          // checkpoint tick, where a persistent error still propagates.
          if (!supervised.length) throw error;
          continue;
        }
        if (envelope) {
          const current = this.store.operation(op.operation_id);
          if (acknowledged && TERMINAL_STATES.has(current.status))
            envelope.result_key = operationResultKey(current);
          supervised.push(envelope);
        }
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
  envelope(op: Operation, supplied?: Action, resolveAction = true): Envelope {
    return this.reporting.envelope(op, supplied, resolveAction);
  }
  withResponse(envelope: Envelope): Envelope {
    return this.reporting.withResponse(envelope);
  }
  check(taskId: string): Envelope {
    return this.reporting.check(taskId);
  }
  exportArtifact(
    taskId: string,
    operationId: string,
    sourceFile: string,
    format: string,
  ): Envelope {
    return this.reporting.exportArtifact(
      taskId,
      operationId,
      sourceFile,
      format,
    );
  }
  accept(actionId: string, raw: unknown, autoRead = false): Envelope {
    return this.codexApp.accept(actionId, raw, autoRead);
  }
  recoverClaudeOperation(operationId: string): Promise<Envelope> {
    return this.claude.recoverClaudeOperation(operationId);
  }
}
