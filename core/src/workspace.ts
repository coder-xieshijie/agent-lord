import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Contract,
  type Data,
  type ParallelPlan,
  type Source,
  type StartOptions,
  type Workspace,
  TERMINAL_STATES,
  integer,
  object,
  string,
  strings,
} from "./contracts.js";
import { type Control } from "./config.js";
import { AgentLordError, usageError } from "./errors.js";
import { sha256 } from "./json.js";
import { resolvePath } from "./paths.js";
import {
  type Lease,
  StateStore,
  recordLock,
  sharedLocksSupported,
  validateIdentifier,
} from "./state.js";
export function git(
  repository: string,
  args: string[],
  check = true,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (check && (result.error || result.status !== 0))
    throw new AgentLordError(
      "SOURCE_UNVERIFIED",
      "git could not prepare the requested source worktree",
      {
        details: {
          repository,
          arguments: args,
          error: result.stderr?.trim() || result.error?.message,
        },
      },
    );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
export function validateSource(head?: string, base?: string): Source {
  const source: Source = {};
  for (const [key, value] of [
    ["head_sha", head],
    ["base_sha", base],
  ] as const)
    if (value) {
      if (!/^[0-9a-fA-F]{40}$/.test(value) || value.length !== 40)
        throw usageError(`${key} must be a full 40-character git SHA`, {
          [key]: value,
        });
      source[key] = value.toLowerCase();
    }
  return source;
}
export function refHead(repository: string, ref: string): string | null {
  const result = git(
    repository,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    false,
  );
  return result.status === 0 ? result.stdout.trim().toLowerCase() : null;
}
export function verifyBase(target: string, source: Source): void {
  if (
    source.base_sha &&
    git(target, ["cat-file", "-e", `${source.base_sha}^{commit}`], false)
      .status !== 0
  )
    throw new AgentLordError(
      "SOURCE_UNVERIFIED",
      "fixed base commit is not available in the requested checkout",
      { details: { target, expected_base: source.base_sha } },
    );
}
export function verifyCheckout(target: string, source: Source): void {
  if (source.head_sha) {
    const observed = refHead(target, "HEAD");
    if (!observed)
      throw new AgentLordError(
        "SOURCE_UNVERIFIED",
        "cannot verify the requested source checkout",
        { details: { target, expected_head: source.head_sha } },
      );
    if (observed !== source.head_sha)
      throw new AgentLordError(
        "SOURCE_MISMATCH",
        "working directory is not at the requested fixed head",
        {
          details: {
            target,
            expected_head: source.head_sha,
            observed_head: observed,
          },
        },
      );
  }
  verifyBase(target, source);
}
export function managedBranch(contract: Contract): string | null {
  if (contract.read_only) return null;
  const workspace = contract.workspace;
  return workspace?.policy === "isolated"
    ? (workspace.workspace_branch ?? null)
    : workspace?.policy === "reuse-or-create"
      ? (workspace.source_branch ?? null)
      : null;
}
export function verifyManagedAdvance(
  target: string,
  source: Source,
  branch: string,
): string | null {
  const expected = source.verified_head_sha ?? source.head_sha;
  verifyBase(target, source);
  if (!expected) return null;
  const observed = refHead(target, "HEAD");
  if (!observed)
    throw new AgentLordError(
      "SOURCE_UNVERIFIED",
      "cannot verify the requested source checkout",
      { details: { target, expected_head: expected } },
    );
  if (observed === expected) return null;
  const details = {
    target,
    expected_head: expected,
    observed_head: observed,
    contract_branch: branch,
  };
  const checked = git(
    target,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    false,
  );
  if (checked.status !== 0 || checked.stdout.trim() !== branch)
    throw new AgentLordError(
      "SOURCE_MISMATCH",
      "writable checkout left its contract branch",
      {
        details: { ...details, observed_branch: checked.stdout.trim() || null },
      },
    );
  if (
    git(target, ["merge-base", "--is-ancestor", expected, observed], false)
      .status !== 0
  )
    throw new AgentLordError(
      "SOURCE_MISMATCH",
      "writable checkout is not a descendant of its verified head",
      { details },
    );
  return observed;
}
export function leaseId(prefix: string, value: string): string {
  return `${prefix}-${sha256(value).slice(0, 32)}`;
}
export function targetIdentity(target: string): string {
  const result = git(target, ["rev-parse", "--show-toplevel"], false);
  return resolvePath(result.status === 0 ? result.stdout.trim() : target);
}
export function repositoryIdentity(repository: string): string {
  const result = git(
    repository,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    false,
  );
  return resolvePath(result.status === 0 ? result.stdout.trim() : repository);
}
export async function acquireLease(
  kind: string,
  id: string,
  root: string,
  control: Control,
  message: string,
  details: Data = {},
): Promise<Lease> {
  for (let i = 0; i < control.finalize_lock_attempts; i++) {
    try {
      return recordLock(kind, id, root);
    } catch (error) {
      if (!(error instanceof AgentLordError) || error.code !== "STATE_BUSY")
        throw error;
    }
    if (i + 1 < control.finalize_lock_attempts)
      await delay(control.finalize_lock_retry_interval_ms);
  }
  throw new AgentLordError("STATE_BUSY", message, {
    retryable: true,
    safe_recovery: "RETRY_SAME_COMMAND",
    details,
  });
}
export class WorkspaceManager {
  constructor(
    readonly store: StateStore,
    readonly control: Control,
  ) {}
  resolveTarget(
    taskId: string,
    repository: string,
    branch: string,
    worktreeRoot?: string,
  ): [string, boolean] {
    const trees = git(repository, ["worktree", "list", "--porcelain"])
      .stdout.trim()
      .split("\n\n")
      .map((record) =>
        Object.fromEntries(
          record
            .split("\n")
            .filter((line) => line.includes(" "))
            .map((line) => [
              line.slice(0, line.indexOf(" ")),
              line.slice(line.indexOf(" ") + 1),
            ]),
        ),
      );
    const matches = trees.filter(
      (tree) => tree.branch === `refs/heads/${branch}`,
    );
    if (matches.length > 1)
      throw new AgentLordError(
        "SOURCE_UNVERIFIED",
        "checkout branch is bound to more than one worktree",
        {
          details: {
            checkout_branch: branch,
            worktrees: matches.map((t) => t.worktree),
          },
        },
      );
    return matches.length
      ? [resolvePath(matches[0].worktree), true]
      : [
          resolvePath(
            path.join(
              worktreeRoot
                ? resolvePath(worktreeRoot)
                : path.join(this.store.root, "worktrees"),
              taskId,
            ),
          ),
          false,
        ];
  }
  prepare(
    repository: string,
    sourceBranch: string,
    head: string,
    target: string,
    policy: string,
    workspaceBranch: string | undefined,
    existing: boolean,
  ): string {
    const branch = policy === "isolated" ? workspaceBranch! : sourceBranch;
    if (!existing) {
      if (existsSync(target))
        throw new AgentLordError(
          "SOURCE_UNVERIFIED",
          "planned worktree path already exists",
          { details: { target } },
        );
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const local = refHead(repository, `refs/heads/${branch}`);
      let args: string[];
      if (local && local !== head)
        throw new AgentLordError(
          "SOURCE_MISMATCH",
          "local checkout branch is not at the requested fixed head",
          {
            details: {
              checkout_branch: branch,
              expected_head: head,
              observed_head: local,
            },
          },
        );
      if (local) args = ["worktree", "add", target, branch];
      else if (policy === "isolated") {
        if (!refHead(repository, head))
          throw new AgentLordError(
            "SOURCE_UNVERIFIED",
            "fixed source commit is not available in the local repository",
            { details: { repository, expected_head: head } },
          );
        args = ["worktree", "add", "-b", branch, target, head];
      } else {
        const remoteRef = `refs/remotes/origin/${sourceBranch}`;
        const remote = refHead(repository, remoteRef);
        if (remote && remote !== head)
          throw new AgentLordError(
            "SOURCE_MISMATCH",
            "local remote-tracking source branch is not at the requested fixed head",
            {
              details: {
                source_branch: sourceBranch,
                expected_head: head,
                observed_head: remote,
              },
            },
          );
        if (remote)
          args = [
            "worktree",
            "add",
            "--track",
            "-b",
            sourceBranch,
            target,
            remoteRef,
          ];
        else {
          if (!refHead(repository, head))
            throw new AgentLordError(
              "SOURCE_UNVERIFIED",
              "fixed source commit is not available in the local repository",
              { details: { repository, expected_head: head } },
            );
          args = ["worktree", "add", "-b", sourceBranch, target, head];
        }
      }
      git(repository, args);
    }
    if (
      git(target, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]).stdout.trim()
    )
      throw new AgentLordError(
        "SOURCE_MISMATCH",
        "source worktree has uncommitted changes",
        { details: { target } },
      );
    const observed = refHead(target, "HEAD");
    if (observed !== head)
      throw new AgentLordError(
        "SOURCE_MISMATCH",
        "source worktree is not at the requested fixed head",
        { details: { target, expected_head: head, observed_head: observed } },
      );
    return target;
  }
  writeLeases(
    target: string,
    readOnly: boolean,
    workspace: Workspace,
    exclude?: string,
  ): Lease {
    const identity = targetIdentity(target);
    const leases: Lease[] = [];
    const release = () => {
      for (const lease of leases.reverse()) lease.release();
    };
    const conflict = (
      code: string,
      message: string,
      details: Data = {},
      recovery = "WAIT_FOR_WRITER_OR_USE_ISOLATED_WORKTREE",
    ) =>
      new AgentLordError(code, message, {
        retryable: true,
        safe_recovery: recovery,
        details,
      });
    try {
      if (readOnly && !sharedLocksSupported()) return { release };
      try {
        leases.push(
          recordLock(
            "workspace-write",
            leaseId("workspace", identity),
            this.store.root,
            readOnly,
          ),
        );
      } catch (error) {
        if (!(error instanceof AgentLordError) || error.code !== "STATE_BUSY")
          throw error;
        throw conflict(
          "WORKSPACE_WRITE_CONFLICT",
          readOnly
            ? "a writable task owns this worktree"
            : "another writable task owns this worktree",
          { target: identity, ...(readOnly ? { requested: "read-only" } : {}) },
        );
      }
      if (readOnly) return { release };
      const identities = new Map<string, string>();
      const unfenced = this.store.operations().find((op) => {
        if (
          TERMINAL_STATES.has(op.status) ||
          op.read_only ||
          op.provider === "codex-app" ||
          op.operation_id === exclude ||
          !op.target
        )
          return false;
        if (!identities.has(op.target))
          identities.set(op.target, targetIdentity(op.target));
        return identities.get(op.target) === identity;
      });
      if (unfenced)
        throw conflict(
          "WORKSPACE_WRITE_CONFLICT",
          "an unfenced writable operation still owns this worktree",
          {
            target: identity,
            operation_id: unfenced.operation_id,
            operation_status: unfenced.status,
            task_id: unfenced.task_id,
          },
          "RUN_CHECKPOINT_TO_FENCE_THEN_RETRY",
        );
      const branch = workspace.workspace_branch ?? workspace.source_branch;
      if (workspace.repository && branch) {
        try {
          leases.push(
            recordLock(
              "branch-write",
              leaseId(
                "branch",
                `${repositoryIdentity(workspace.repository)}\0${branch}`,
              ),
              this.store.root,
            ),
          );
        } catch (error) {
          if (!(error instanceof AgentLordError) || error.code !== "STATE_BUSY")
            throw error;
          throw conflict(
            "BRANCH_WRITE_CONFLICT",
            "another writable task owns this checkout branch",
            { repository: workspace.repository, branch },
          );
        }
      }
      return { release };
    } catch (error) {
      release();
      throw error;
    }
  }
  parallelPlan(
    taskId: string,
    readOnly: boolean,
    workspace: Workspace,
    opts: StartOptions,
  ): ParallelPlan | Data {
    const {
      parallel_group: group,
      integration_role: role,
      integration_target_branch: target,
      integrator_task_id: integrator,
      integration_order: order,
      integration_workers: workers,
    } = opts;
    if (
      [
        group,
        role,
        target,
        integrator,
        order,
        workers?.length ? workers : undefined,
      ].every((v) => v == null)
    )
      return {};
    if (readOnly)
      throw usageError(
        "parallel integration metadata is only valid for writable tasks",
      );
    const fail = (message: string, details: Data = {}) =>
      new AgentLordError("PARALLEL_WRITE_PLAN_INCOMPLETE", message, {
        requires_authorization: true,
        details: { task_id: taskId, ...details },
        exit_code: 2,
      });
    if (!group || !["worker", "integrator"].includes(role ?? "") || !target)
      throw fail(
        "parallel writes require a group, role, and MR source integration target",
      );
    validateIdentifier("parallel_group", group);
    if (target !== workspace.source_branch)
      throw fail(
        "integration target must equal the declared MR source branch",
        {
          source_branch: workspace.source_branch,
          integration_target_branch: target,
        },
      );
    if (role === "worker") {
      if (
        workspace.policy !== "isolated" ||
        !workspace.workspace_branch ||
        !integrator ||
        !integer(order) ||
        order < 1 ||
        workers?.length
      )
        throw fail(
          "parallel workers require isolated workspace, integrator task id, and positive integration order",
        );
      validateIdentifier("integrator_task_id", integrator);
      const specs = [
        ...this.store.tasks().map((t) => ({
          task_id: t.task_id,
          plan: object(t.contract.parallel_plan),
          workspace: object(t.contract.workspace),
        })),
        ...this.store.operations().map((op) => ({
          task_id: op.task_id,
          plan: object(op.parallel_plan),
          workspace: object(op.workspace),
        })),
      ];
      for (const spec of specs)
        if (
          spec.task_id !== taskId &&
          spec.plan.group === group &&
          spec.plan.role === "worker" &&
          (spec.plan.integration_order === order ||
            spec.workspace.workspace_branch === workspace.workspace_branch)
        )
          throw fail(
            "parallel workers must have unique integration order and workspace branch",
            { conflicting_task_id: spec.task_id },
          );
      return {
        group,
        role,
        integration_target_branch: target,
        integrator_task_id: integrator,
        integration_order: order,
      };
    }
    if (
      workspace.policy !== "reuse-or-create" ||
      integrator != null ||
      order != null ||
      !workers?.length ||
      new Set(workers).size !== workers.length
    )
      throw fail(
        "integrator requires ordered unique worker task ids on the MR source worktree",
      );
    const heads = new Set<string | undefined>();
    const orders: [number, string][] = [];
    for (const id of workers) {
      validateIdentifier("integration_worker", id);
      let worker;
      try {
        worker = this.store.task(id);
      } catch (error) {
        if (!(error instanceof AgentLordError) || error.code !== "TASK_UNKNOWN")
          throw error;
        throw fail(
          "integrator references a worker without a completed task handle",
          { worker_task_id: id },
        );
      }
      const plan = object(worker.contract.parallel_plan);
      const workerWorkspace = worker.contract.workspace;
      heads.add(worker.contract.source.head_sha);
      const op = worker.last_operation_id
        ? this.store.operation(worker.last_operation_id)
        : null;
      if (
        plan.group !== group ||
        plan.role !== "worker" ||
        plan.integrator_task_id !== taskId ||
        plan.integration_target_branch !== target ||
        !workerWorkspace?.repository ||
        !workspace.repository ||
        repositoryIdentity(workerWorkspace.repository) !==
          repositoryIdentity(workspace.repository) ||
        op?.status !== "succeeded"
      )
        throw fail("integrator worker set is incomplete or inconsistent", {
          worker_task_id: id,
        });
      orders.push([Number(plan.integration_order), id]);
    }
    if (heads.has(undefined) || heads.size !== 1)
      throw fail("parallel workers must share one fixed source head", {
        worker_heads: [...heads].map(String).sort(),
      });
    if (new Set(orders.map(([n]) => n)).size !== orders.length)
      throw fail("integration workers must declare unique integration order");
    const ordered = [...orders].sort(([a], [b]) => a - b).map(([, id]) => id);
    if (ordered.join("\0") !== workers.join("\0"))
      throw fail(
        "integration workers must be listed in declared integration order",
        { expected_order: ordered, observed_order: workers },
      );
    return {
      group,
      role: "integrator",
      integration_target_branch: target,
      integration_workers: workers,
    };
  }
}
