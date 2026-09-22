import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { AgentLord } from "./engine.js";
import {
  type Data,
  type Envelope,
  type Operation,
  type StartOptions,
  type DeliveryRequirements,
  TERMINAL_STATES,
  isObject,
  records,
  string,
  strings,
} from "./contracts.js";
import { sha256, stringifyJson } from "./json.js";
import { AgentLordError } from "./errors.js";
import {
  atomicWrite,
  readJson,
  writeJson,
  withLock,
  validateIdentifier,
  utcNow,
  type Lease,
  recordLock,
} from "./state.js";
import { controlConfig } from "./config.js";
import { resolvePath } from "./paths.js";
import {
  WorkspaceManager,
  git,
  refHead,
  repositoryIdentity,
  targetIdentity,
} from "./workspace.js";
import {
  BRANCH_LOCK_KIND,
  WORKSPACE_LOCK_KIND,
  branchLockId,
  claimForBranch,
  claimForTarget,
  claimsForRun,
  claimConflictError,
  leaseId,
  newClaim,
  releaseClaims,
  workspaceLockId,
  writeClaim,
} from "./workspace-claims.js";
import { TaskSets } from "./task-sets.js";
import { groupAlive, pidAlive } from "./process.js";
import { verifyPublication } from "./publication.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
/** Module delivery is the only barrier input; a worker never publishes its own MR. */
export type ModuleState = "pending" | "dispatched" | "delivered" | "failed";
export interface PlanRepository {
  repository: string;
  source_branch: string;
  head_sha: string;
  delivery_branch: string;
}
export interface PlanModule {
  module_id: string;
  repository: string;
  responsibility: string;
  acceptance: string[];
  depends_on: string[];
  owned_paths: string[];
  verification: string[];
}
export interface ImplementationPlan {
  version: 1;
  plan_id: string;
  goal: string;
  repositories: PlanRepository[];
  modules: PlanModule[];
}
interface ModuleRecord {
  state: ModuleState;
  task_id: string | null;
  provider: string | null;
  model: string | null;
  operation_id: string | null;
  commit_sha: string | null;
  note: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
}
interface PlannerRecord {
  task_id: string;
  operation_id: string;
  provider: string | null;
  model: string | null;
  plan_path: string;
  accepted_at: string;
}
interface IntegrationWorkspace {
  repository: string;
  branch: string;
  target: string;
  claim_id: string;
  /** Current checkout accepted at handover; the plan's source SHA stays frozen. */
  head_sha?: string;
}
interface ReportRecord {
  canonical_path: string;
  source_path: string;
  bytes: number;
  sha256: string;
  reported_at: string;
}
interface IntegrationRecord {
  state: "pending" | "dispatched" | "reported";
  task_id: string | null;
  provider: string | null;
  model: string | null;
  operation_id: string | null;
  workspaces: IntegrationWorkspace[];
  merge_requests: Array<{
    repository: string;
    url: string;
    head_sha: string;
    recorded_at: string;
    verification?: VerificationReceipt;
  }>;
  report: ReportRecord | null;
  handover?: { from: string; to: string };
}
interface VerificationReceipt {
  head_sha: string;
  checks: Array<{
    name: string;
    status: "passed" | "accepted_failure";
    evidence: string;
    reason?: string;
  }>;
}
interface PlanRun {
  version: 1;
  run_id: string;
  plan_sha256: string;
  plan: ImplementationPlan;
  planner: PlannerRecord;
  modules: Record<string, ModuleRecord>;
  integration: IntegrationRecord;
  journal: Data[];
  created_at: string;
  updated_at: string;
}
function planError(message: string, details: Data = {}): AgentLordError {
  return new AgentLordError("PLAN_INVALID", message, { details, exit_code: 2 });
}
function barrierError(message: string, details: Data = {}): AgentLordError {
  return new AgentLordError("PLAN_BARRIER", message, { details, exit_code: 2 });
}
function unverified(message: string, details: Data = {}): AgentLordError {
  return new AgentLordError("ENDPOINT_UNVERIFIED", message, {
    details,
    exit_code: 2,
  });
}
/** Normalize an owned path so prefix comparison cannot be defeated by `./` or a trailing slash. */
function normalizeOwnedPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.replace(/^\.\//u, "").replace(/\/+$/u, "");
}
/**
 * An owned path must stay a plain relative path inside the repository after
 * normalization. The repository root (`.`, `./`, empty) and `..` escapes are
 * rejected outright: they would silently bypass the pairwise overlap check
 * instead of declaring ownership of everything.
 */
function ownedPath(value: string, module_id: string): string {
  const normalized = normalizeOwnedPath(value);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  )
    throw planError(
      "owned_paths must be relative paths inside the repository; to own everything, list explicit top-level paths",
      { module_id, owned_path: value },
    );
  return normalized;
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
/**
 * Validate an authored plan into the frozen shape the run state machine trusts.
 * Every rule here is a barrier the scheduling caller would otherwise have to
 * re-check by hand before each dispatch.
 */
export function validatePlan(value: unknown): ImplementationPlan {
  if (!isObject(value)) throw planError("plan must be a JSON object");
  if (value.version !== 1) throw planError("plan version must be 1");
  const plan_id = string(value.plan_id);
  if (!plan_id) throw planError("plan_id is required");
  validateIdentifier("plan_id", plan_id);
  const goal = string(value.goal);
  if (!goal) throw planError("goal is required");
  const repositories = records(value.repositories).map((raw) => {
    const repository = string(raw.repository);
    const source_branch = string(raw.source_branch);
    const head_sha = string(raw.head_sha);
    const delivery_branch = string(raw.delivery_branch);
    if (!repository || !path.isAbsolute(repository))
      throw planError("each repository needs an absolute repository path", {
        repository,
      });
    if (!source_branch)
      throw planError("each repository needs a source_branch", { repository });
    if (!head_sha || !SHA_PATTERN.test(head_sha))
      throw planError("each repository needs a fixed 40-hex head_sha", {
        repository,
      });
    if (!delivery_branch)
      throw planError("each repository needs one delivery_branch", {
        repository,
      });
    return { repository, source_branch, head_sha, delivery_branch };
  });
  if (!repositories.length)
    throw planError("plan needs at least one repository");
  const seenRepositories = new Set<string>();
  const seenBranches = new Set<string>();
  for (const repo of repositories) {
    if (seenRepositories.has(repo.repository))
      throw planError(
        "each repository may appear once; one delivery branch and one MR per repository",
        { repository: repo.repository },
      );
    seenRepositories.add(repo.repository);
    const branchKey = `${repo.repository}\0${repo.delivery_branch}`;
    if (seenBranches.has(branchKey))
      throw planError("delivery_branch must be unique per repository", {
        repository: repo.repository,
      });
    seenBranches.add(branchKey);
  }
  const modules = records(value.modules).map((raw) => {
    const module_id = string(raw.module_id);
    if (!module_id) throw planError("each module needs a module_id");
    validateIdentifier("module_id", module_id);
    const repository = string(raw.repository);
    if (!repository || !seenRepositories.has(repository))
      throw planError("module repository must be a declared plan repository", {
        module_id,
        repository,
      });
    const responsibility = string(raw.responsibility);
    if (!responsibility)
      throw planError("each module needs a responsibility", { module_id });
    const acceptance = strings(raw.acceptance).filter(Boolean);
    if (!acceptance.length)
      throw planError("each module needs at least one acceptance criterion", {
        module_id,
      });
    const owned_paths = strings(raw.owned_paths)
      .filter(Boolean)
      .map((value) => ownedPath(value, module_id));
    if (!owned_paths.length)
      throw planError(
        "each module needs owned_paths so write ownership is explicit",
        { module_id },
      );
    if (Object.hasOwn(raw, "merge_request") || Object.hasOwn(raw, "mr_url"))
      throw planError(
        "a module must not declare its own MR; only the integrator publishes one MR per repository",
        { module_id },
      );
    return {
      module_id,
      repository,
      responsibility,
      acceptance,
      depends_on: [...new Set(strings(raw.depends_on).filter(Boolean))],
      owned_paths,
      verification: strings(raw.verification).filter(Boolean),
    };
  });
  if (!modules.length) throw planError("plan needs at least one module");
  const byId = new Map<string, PlanModule>();
  for (const module of modules) {
    if (byId.has(module.module_id))
      throw planError("module_id must be unique", {
        module_id: module.module_id,
      });
    byId.set(module.module_id, module);
  }
  for (const module of modules)
    for (const dependency of module.depends_on) {
      if (dependency === module.module_id)
        throw planError("a module cannot depend on itself", {
          module_id: module.module_id,
        });
      if (!byId.has(dependency))
        throw planError("depends_on must reference a declared module", {
          module_id: module.module_id,
          depends_on: dependency,
        });
    }
  // Ownership overlap is checked per repository: the same path in two repositories is fine.
  for (let i = 0; i < modules.length; i += 1)
    for (let j = i + 1; j < modules.length; j += 1) {
      const left = modules[i]!;
      const right = modules[j]!;
      if (left.repository !== right.repository) continue;
      for (const a of left.owned_paths)
        for (const b of right.owned_paths)
          if (overlaps(a, b))
            throw planError(
              "two modules in one repository cannot own overlapping paths",
              { modules: [left.module_id, right.module_id], paths: [a, b] },
            );
    }
  const cycle = findCycle(modules);
  if (cycle) throw planError("module dependencies must be acyclic", { cycle });
  return { version: 1, plan_id, goal, repositories, modules };
}
/** Depth-first search that returns the first dependency cycle as a readable path. */
function findCycle(modules: PlanModule[]): string[] | null {
  const edges = new Map(modules.map((m) => [m.module_id, m.depends_on]));
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const walk = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const module of modules) {
    const found = walk(module.module_id);
    if (found) return found;
  }
  return null;
}
/**
 * Durable plan run: accepts a plan from a verified planner endpoint, computes
 * the unbounded ready set, holds the dependency and final-integration barriers
 * against real endpoint results, owns the integrator's per-repository workspace
 * claims, and journals every shareable decision for the process report.
 */
export class PlanRuns {
  private taskPlan(
    taskId: string,
  ):
    | { record: PlanRun; repo: PlanRepository; integration: boolean }
    | undefined {
    const directory = path.join(this.lord.root, "plan-runs");
    if (!existsSync(directory)) return;
    const found = readdirSync(directory)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const record = this.read(f.slice(0, -5));
        if (
          record.integration.task_id === taskId ||
          record.integration.handover?.to === taskId
        ) {
          const primary = record.plan.repositories[0];
          return [{ record, repo: primary, integration: true }];
        }
        const module = record.plan.modules.find(
          (m) => record.modules[m.module_id]?.task_id === taskId,
        );
        return module
          ? [
              {
                record,
                repo: this.repository(record, module.repository),
                integration: false,
              },
            ]
          : [];
      });
    if (found.length > 1)
      throw barrierError("task belongs to more than one plan run", {
        task_id: taskId,
      });
    return found[0];
  }
  /** Role requirements come from the accepted plan, not optional CLI flags. */
  executionContract(
    taskId: string,
    opts: StartOptions,
    target: string | null,
  ): StartOptions | undefined {
    const found = this.taskPlan(taskId);
    if (!found) return;
    const { record, repo, integration } = found;
    if (record.integration.state === "reported")
      throw barrierError(
        "completed plan roles require a new task or run for further work",
      );
    if (record.integration.handover)
      throw barrierError(
        "integration handover is incomplete; repeat plan-integration-resume",
      );
    const claimed = integration
      ? record.integration.workspaces.find(
          (w) => w.repository === repo.repository,
        )
      : undefined;
    if (
      target &&
      (!claimed || targetIdentity(target) !== targetIdentity(claimed.target))
    )
      throw barrierError(
        "plan task must use its declared repository workspace",
      );
    const expected = {
      repository: repo.repository,
      source_branch: repo.source_branch,
      head_sha: claimed?.head_sha ?? repo.head_sha,
      workspace_policy: "isolated",
      ...(integration ? { workspace_branch: repo.delivery_branch } : {}),
    };
    for (const [key, value] of Object.entries(expected)) {
      const given = (opts as Data)[key];
      if (given !== undefined && given !== value)
        throw barrierError("dispatch differs from the frozen plan", {
          field: key,
          expected: value,
          observed: given,
        });
    }
    if (opts.read_only)
      throw barrierError("implementation roles require writable execution");
    // Plan runs carry their own role provenance, unlike ordinary task sets.
    if (opts.workflow_run_id && opts.workflow_run_id !== record.run_id)
      throw barrierError("dispatch names another run");
    return {
      ...opts,
      ...expected,
      workflow_run_id: undefined,
      require_commit: true,
    } as StartOptions;
  }
  executionDelivery(
    taskId: string,
    delivery: DeliveryRequirements | null | undefined,
  ): DeliveryRequirements | null {
    const found = this.taskPlan(taskId);
    if (!found) return delivery ?? null;
    if (found.record.integration.state === "reported")
      throw barrierError(
        "completed plan roles require a new task or run for further work",
      );
    if (found.record.integration.handover)
      throw barrierError(
        "integration handover is incomplete; repeat plan-integration-resume",
      );
    return {
      files: delivery?.files ?? [],
      require_commit: true,
      base_head: found.repo.head_sha,
    };
  }
  constructor(private readonly lord: AgentLord) {}
  private file(id: string): string {
    return path.join(
      this.lord.root,
      "plan-runs",
      `${validateIdentifier("run_id", id)}.json`,
    );
  }
  private reportFile(id: string): string {
    return path.join(this.lord.root, "plan-reports", `${id}.md`);
  }
  private read(id: string): PlanRun {
    const raw = readJson(
      this.file(id),
      "PLAN_RUN_UNKNOWN",
      "plan run does not exist",
    );
    if (raw.version !== 1 || raw.run_id !== id || !isObject(raw.modules))
      throw new AgentLordError("STATE_CORRUPT", "invalid plan run record");
    const record = raw as unknown as PlanRun;
    if (sha256(stringifyJson(record.plan)) !== record.plan_sha256)
      throw new AgentLordError(
        "STATE_CORRUPT",
        "plan run no longer matches its frozen plan digest",
      );
    return record;
  }
  private persist(record: PlanRun): void {
    mkdirSync(path.dirname(this.file(record.run_id)), {
      recursive: true,
      mode: 0o700,
    });
    writeJson(this.file(record.run_id), { ...record, updated_at: utcNow() });
  }
  private journal(record: PlanRun, event: string, details: Data): void {
    record.journal.push({
      seq: record.journal.length + 1,
      at: utcNow(),
      event,
      ...details,
    });
  }
  private module(record: PlanRun, moduleId: string): ModuleRecord {
    const module = record.modules[validateIdentifier("module_id", moduleId)];
    if (!module)
      throw new AgentLordError(
        "MODULE_UNKNOWN",
        "module is not part of this plan run",
        { details: { module_id: moduleId }, exit_code: 2 },
      );
    return module;
  }
  /**
   * The task's current result. A task can hold several operations across
   * retries and recoveries; only the one the task itself points at counts, so
   * an older success can never stand in for a failed current attempt.
   */
  private currentOperation(taskId: string, role: string): Operation {
    validateIdentifier("task_id", taskId);
    if (!this.lord.store.hasTask(taskId))
      throw unverified(`${role} has no durable Agent Lord task`, {
        task_id: taskId,
      });
    const task = this.lord.store.task(taskId);
    const operation = task.last_operation_id
      ? this.lord.store.operation(task.last_operation_id)
      : this.lord.store.operations(taskId).at(-1);
    if (!operation)
      throw unverified(`${role} task has no operation to verify`, {
        task_id: taskId,
      });
    if (operation.status !== "succeeded")
      throw unverified(`${role} current operation did not succeed`, {
        task_id: taskId,
        operation_id: operation.operation_id,
        operation_status: operation.status,
      });
    return operation;
  }
  /** A successful endpoint whose declared delivery the runtime actually verified. */
  private verifiedOperation(
    taskId: string,
    role: string,
    requireCommit: boolean,
  ): Operation {
    const operation = this.currentOperation(taskId, role);
    const requirements = operation.delivery_requirements;
    if (requireCommit && !requirements?.require_commit)
      throw unverified(
        `${role} must be dispatched with --require-commit so its commit can be verified`,
        { task_id: taskId, operation_id: operation.operation_id },
      );
    if (requirements && operation.delivery?.status !== "verified")
      throw unverified(`${role} declared delivery is not verified`, {
        task_id: taskId,
        operation_id: operation.operation_id,
        delivery_status: operation.delivery?.status ?? "unverified",
      });
    return operation;
  }
  /** Bind the endpoint to the existing task-set run so observers show it under this run. */
  private bind(runId: string, taskId: string): void {
    const sets = new TaskSets(this.lord);
    try {
      sets.create(runId, [taskId], true);
    } catch (error) {
      if (error instanceof AgentLordError && error.code === "RUN_UNKNOWN")
        sets.create(runId, [taskId], false);
      else throw error;
    }
  }
  private readySet(record: PlanRun): string[] {
    // No concurrency cap: every dependency-satisfied module is returned at once.
    return record.plan.modules
      .filter((module) => {
        if (record.modules[module.module_id]?.state !== "pending") return false;
        return module.depends_on.every(
          (dependency) => record.modules[dependency]?.state === "delivered",
        );
      })
      .map((module) => module.module_id);
  }
  private blockers(record: PlanRun): Data[] {
    return record.plan.modules
      .map((module) => ({
        module_id: module.module_id,
        state: record.modules[module.module_id]!.state,
      }))
      .filter((entry) => entry.state !== "delivered");
  }
  private repository(record: PlanRun, repository: string): PlanRepository {
    const declared = record.plan.repositories.find(
      (entry) => entry.repository === repository,
    );
    if (!declared)
      throw planError("repository is not part of this plan", { repository });
    return declared;
  }
  /**
   * Accept a validated plan from a successful planner endpoint. The plan file
   * must be one of that planner's verified delivery files, so a run can never
   * start from an arbitrary local JSON document.
   */
  create(id: string, planPath: string, plannerTaskId: string): Envelope {
    const resolved = resolvePath(planPath);
    const operation = this.verifiedOperation(plannerTaskId, "planner", false);
    const base = resolvePath(operation.target);
    const declared = (operation.delivery?.checks ?? [])
      .filter((check) => check.kind === "file" && check.ok && check.path)
      .map((check) => resolvePath(path.join(base, check.path!)));
    if (!declared.includes(resolved))
      throw unverified(
        "plan file is not a verified delivery file of the planner endpoint",
        {
          task_id: plannerTaskId,
          operation_id: operation.operation_id,
          plan_file: resolved,
          verified_files: declared,
        },
      );
    const plan = validatePlan(
      JSON.parse(readPlanText(resolved)) as unknown as Data,
    );
    const digest = sha256(stringifyJson(plan));
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        if (existsSync(this.file(id))) {
          // Idempotent recovery: the same plan and planner replay into one run.
          const existing = this.read(id);
          if (existing.plan_sha256 !== digest)
            throw new AgentLordError(
              "RUN_EXISTS",
              "plan run already exists with a different plan; use a new run-id",
              {
                details: {
                  run_id: id,
                  existing_plan_sha256: existing.plan_sha256,
                },
                exit_code: 2,
              },
            );
          if (existing.planner.task_id !== plannerTaskId)
            throw new AgentLordError(
              "RUN_EXISTS",
              "plan run already has a different planner endpoint",
              {
                details: {
                  run_id: id,
                  existing_planner_task_id: existing.planner.task_id,
                },
                exit_code: 2,
              },
            );
          return;
        }
        const now = utcNow();
        const record: PlanRun = {
          version: 1,
          run_id: id,
          plan_sha256: digest,
          plan,
          planner: {
            task_id: plannerTaskId,
            operation_id: operation.operation_id,
            provider: operation.provider,
            model: operation.expected?.model ?? null,
            plan_path: resolved,
            accepted_at: now,
          },
          modules: Object.fromEntries(
            plan.modules.map((module) => [
              module.module_id,
              {
                state: "pending" as ModuleState,
                task_id: null,
                provider: null,
                model: null,
                operation_id: null,
                commit_sha: null,
                note: null,
                dispatched_at: null,
                delivered_at: null,
              },
            ]),
          ),
          integration: {
            state: "pending",
            task_id: null,
            provider: null,
            model: null,
            operation_id: null,
            workspaces: [],
            merge_requests: [],
            report: null,
          },
          journal: [],
          created_at: now,
          updated_at: now,
        };
        this.journal(record, "planner_accepted", {
          task_id: plannerTaskId,
          operation_id: operation.operation_id,
          provider: operation.provider,
          model: record.planner.model,
          plan_id: plan.plan_id,
          plan_sha256: digest,
          modules: plan.modules.length,
          repositories: plan.repositories.map((r) => r.repository),
        });
        this.persist(record);
      },
    );
    this.bind(id, plannerTaskId);
    return this.status(id);
  }
  status(id: string): Envelope {
    const record = this.read(id);
    const ready = this.readySet(record);
    const blockers = this.blockers(record);
    const report = record.integration.report;
    return {
      version: 1,
      status: "PLAN_RECORD",
      plan_run: {
        run_id: record.run_id,
        plan_id: record.plan.plan_id,
        plan_sha256: record.plan_sha256,
        goal: record.plan.goal,
        planner: record.planner,
        repositories: record.plan.repositories,
        modules: record.plan.modules.map((module) => ({
          module_id: module.module_id,
          repository: module.repository,
          depends_on: module.depends_on,
          owned_paths: module.owned_paths,
          acceptance: module.acceptance,
          verification: module.verification,
          ...record.modules[module.module_id]!,
        })),
        ready,
        ready_count: ready.length,
        blocked: blockers,
        integration_ready: blockers.length === 0,
        integration: {
          ...record.integration,
          report: report
            ? { ...report, available: existsSync(report.canonical_path) }
            : null,
        },
        claims: claimsForRun(this.lord.root, record.run_id),
        journal: record.journal,
      },
    };
  }
  dispatch(
    id: string,
    moduleId: string,
    taskId: string,
    meta: { provider?: string | null; model?: string | null } = {},
  ): Envelope {
    validateIdentifier("task_id", taskId);
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        const module = this.module(record, moduleId);
        if (module.state === "dispatched" && module.task_id === taskId) return;
        if (module.state !== "pending")
          throw barrierError("module is not pending", {
            module_id: moduleId,
            state: module.state,
            task_id: module.task_id,
          });
        const plan = record.plan.modules.find((m) => m.module_id === moduleId)!;
        const unmet = plan.depends_on.filter(
          (dependency) => record.modules[dependency]?.state !== "delivered",
        );
        if (unmet.length)
          throw barrierError("module dependencies are not delivered yet", {
            module_id: moduleId,
            waiting_for: unmet,
          });
        const conflict = Object.entries(record.modules).find(
          ([other, state]) => other !== moduleId && state.task_id === taskId,
        );
        if (conflict)
          throw barrierError("task_id is already bound to another module", {
            task_id: taskId,
            module_id: conflict[0],
          });
        module.state = "dispatched";
        module.task_id = taskId;
        module.provider = meta.provider ?? null;
        module.model = meta.model ?? null;
        module.dispatched_at = utcNow();
        this.journal(record, "module_dispatched", {
          module_id: moduleId,
          task_id: taskId,
          repository: plan.repository,
          provider: module.provider,
          model: module.model,
          waited_for: plan.depends_on,
        });
        this.persist(record);
      },
    );
    this.bind(id, taskId);
    return this.status(id);
  }
  /**
   * Record a module result. `delivered` is not a caller assertion: the bound
   * endpoint must have a successful current operation with a runtime-verified
   * commit, and that commit is what unlocks the dependent modules.
   */
  deliver(
    id: string,
    moduleId: string,
    state: "delivered" | "failed",
    meta: { commit_sha?: string | null; note?: string | null } = {},
  ): Envelope {
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        const module = this.module(record, moduleId);
        if (module.state === state && state === "failed") return;
        if (module.state !== "dispatched") {
          if (module.state === "delivered" && state === "delivered") return;
          throw barrierError("only a dispatched module can report delivery", {
            module_id: moduleId,
            state: module.state,
          });
        }
        if (state === "delivered") {
          const operation = this.verifiedOperation(
            module.task_id!,
            `module ${moduleId}`,
            true,
          );
          const observed = operation.delivery?.commit_sha?.toLowerCase();
          if (!observed || !SHA_PATTERN.test(observed))
            throw unverified("module delivery has no verified commit", {
              module_id: moduleId,
              task_id: module.task_id,
              operation_id: operation.operation_id,
            });
          const claimed = meta.commit_sha?.toLowerCase();
          if (claimed && claimed !== observed)
            throw unverified(
              "reported commit does not match the verified delivery commit",
              {
                module_id: moduleId,
                reported_commit: claimed,
                verified_commit: observed,
              },
            );
          module.commit_sha = observed;
          module.operation_id = operation.operation_id;
        } else module.commit_sha = null;
        module.state = state;
        module.note = meta.note ?? null;
        module.delivered_at = utcNow();
        this.journal(record, "module_result", {
          module_id: moduleId,
          task_id: module.task_id,
          operation_id: module.operation_id,
          state,
          commit_sha: module.commit_sha,
          note: module.note,
        });
        this.persist(record);
      },
    );
    return this.status(id);
  }
  /** Reset one failed module so a replacement endpoint can retry it. */
  reset(id: string, moduleId: string, reason: string | null): Envelope {
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        const module = this.module(record, moduleId);
        if (module.state === "delivered")
          throw barrierError("a delivered module cannot be reset", {
            module_id: moduleId,
          });
        const previous = { state: module.state, task_id: module.task_id };
        module.state = "pending";
        module.task_id = null;
        module.operation_id = null;
        module.commit_sha = null;
        module.dispatched_at = null;
        module.delivered_at = null;
        this.journal(record, "module_reset", {
          module_id: moduleId,
          previous,
          reason,
        });
        this.persist(record);
      },
    );
    return this.status(id);
  }
  /**
   * Open the single final integration endpoint. Every declared repository's
   * delivery worktree is prepared at the frozen head and claimed for this one
   * integrator task, so it owns real, runtime-enforced write exclusion in each
   * repository instead of only the one repository a task targets.
   */
  integrate(
    id: string,
    taskId: string,
    meta: {
      provider?: string | null;
      model?: string | null;
      worktree_root?: string;
    } = {},
  ): Envelope {
    validateIdentifier("task_id", taskId);
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        if (record.integration.task_id === taskId) return;
        if (record.integration.task_id)
          throw barrierError("this run already has a final integrator", {
            integrator_task_id: record.integration.task_id,
          });
        const blockers = this.blockers(record);
        if (blockers.length)
          throw barrierError(
            "final integration starts only after every module is delivered",
            { blocked: blockers },
          );
        const workspaces = new WorkspaceManager(
          this.lord.store,
          controlConfig(),
        );
        const claimed: IntegrationWorkspace[] = [];
        const worktreeRoot =
          meta.worktree_root ??
          path.join(this.lord.store.root, "plan-worktrees", id);
        try {
          // Deterministic repository order, then the same lock order every
          // ordinary writer uses: prepare, workspace-write, branch-write.
          const ordered = [...record.plan.repositories].sort((a, b) =>
            repositoryIdentity(a.repository).localeCompare(
              repositoryIdentity(b.repository),
            ),
          );
          for (const repo of ordered)
            claimed.push(
              this.claimRepository(id, taskId, repo, workspaces, worktreeRoot),
            );
        } catch (error) {
          releaseClaims(this.lord.root, id);
          throw error;
        }
        record.integration.state = "dispatched";
        record.integration.task_id = taskId;
        record.integration.provider = meta.provider ?? null;
        record.integration.model = meta.model ?? null;
        record.integration.workspaces = claimed;
        this.journal(record, "integration_dispatched", {
          task_id: taskId,
          provider: record.integration.provider,
          model: record.integration.model,
          workspaces: claimed,
          merged_modules: record.plan.modules.map((m) => m.module_id),
        });
        this.persist(record);
      },
    );
    this.bind(id, taskId);
    return this.status(id);
  }
  /**
   * Prepare and claim one repository's delivery worktree inside the same
   * per-resource critical sections an ordinary writable start uses, so the
   * check and the write cannot be split by another run or another writer.
   */
  private claimRepository(
    runId: string,
    taskId: string,
    repo: PlanRepository,
    workspaces: WorkspaceManager,
    worktreeRoot: string,
  ): IntegrationWorkspace {
    const identity = repositoryIdentity(repo.repository);
    // One worktree path per repository, so a single integrator task can hold a
    // distinct checkout in each of them.
    const [target, exists] = workspaces.resolveTarget(
      taskId,
      repo.repository,
      repo.delivery_branch,
      path.join(worktreeRoot, sha256(identity).slice(0, 16)),
    );
    const planned = targetIdentity(target);
    return withLock(
      "workspace-prepare",
      leaseId("prepare", `${identity}\0${repo.delivery_branch}`),
      this.lord.root,
      () =>
        withLock(
          WORKSPACE_LOCK_KIND,
          workspaceLockId(planned),
          this.lord.root,
          () =>
            withLock(
              BRANCH_LOCK_KIND,
              branchLockId(identity, repo.delivery_branch),
              this.lord.root,
              () => {
                const held =
                  claimForBranch(
                    this.lord.root,
                    taskId,
                    identity,
                    repo.delivery_branch,
                  ) ?? claimForTarget(this.lord.root, taskId, planned);
                if (held) throw claimConflictError(held);
                const prepared = workspaces.prepare(
                  repo.repository,
                  repo.source_branch,
                  repo.head_sha,
                  target,
                  "isolated",
                  repo.delivery_branch,
                  exists,
                );
                const settled = targetIdentity(prepared);
                if (settled !== planned)
                  throw barrierError(
                    "prepared integration worktree moved outside its claimed identity",
                    { repository: repo.repository, planned, observed: settled },
                  );
                const claim = newClaim({
                  run_id: runId,
                  task_id: taskId,
                  repository: repo.repository,
                  repository_identity: identity,
                  target: prepared,
                  target_identity: settled,
                  branch: repo.delivery_branch,
                });
                writeClaim(this.lord.root, claim);
                return {
                  repository: repo.repository,
                  branch: repo.delivery_branch,
                  target: prepared,
                  claim_id: claim.claim_id,
                };
              },
            ),
        ),
    );
  }
  /** Release every claim and return integration to pending for a replacement. */
  private requireStopped(taskId: string | null): void {
    if (!taskId) return;
    const active = this.lord.store
      .operations(taskId)
      .find(
        (op) =>
          !TERMINAL_STATES.has(op.status) ||
          pidAlive(op.execution_worker_pid) ||
          groupAlive(
            op.pid,
            op.active_attempt?.process_group_id ?? op.process_group_id,
          ),
      );
    if (active)
      throw barrierError(
        "integration owner must be terminal and its processes stopped before handover",
        {
          task_id: taskId,
          operation_id: active.operation_id,
          status: active.status,
        },
      );
  }
  /** Transfer ownership, never reconstruct a delivery checkout from the plan base. */
  integrationResume(id: string, taskId: string, reason: string): Envelope {
    validateIdentifier("task_id", taskId);
    if (!reason.trim()) throw planError("integration resume requires a reason");
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        if (record.integration.state !== "dispatched")
          throw barrierError("only a dispatched integration can resume");
        const previous = record.integration.task_id;
        if (
          previous === taskId &&
          record.journal.some(
            (entry) =>
              entry.event === "integration_resumed" && entry.task_id === taskId,
          )
        )
          return; // Lost acknowledgement: rebind the observer set below, without resetting the new attempt.
        if (
          record.integration.handover &&
          record.integration.handover.to !== taskId
        )
          throw barrierError(
            "complete the recorded handover before choosing another owner",
          );
        const leases: Lease[] = [];
        try {
          for (const owner of [
            ...new Set(
              [previous, taskId].filter((s): s is string => Boolean(s)),
            ),
          ].sort())
            leases.push(
              recordLock(
                "dispatch",
                leaseId("dispatch", owner),
                this.lord.root,
              ),
            );
          this.requireStopped(previous);
          if (
            taskId !== previous &&
            (this.lord.store.hasTask(taskId) ||
              this.lord.store.operations(taskId).length ||
              (!record.integration.handover && this.taskPlan(taskId)))
          )
            throw barrierError("replacement task id is already in use", {
              task_id: taskId,
            });
          const workspaces = [...record.integration.workspaces].sort((a, b) =>
            a.claim_id.localeCompare(b.claim_id),
          );
          if (workspaces.length !== record.plan.repositories.length)
            throw barrierError("integration workspaces are incomplete");
          for (const workspace of workspaces) {
            leases.push(
              recordLock(
                WORKSPACE_LOCK_KIND,
                workspaceLockId(targetIdentity(workspace.target)),
                this.lord.root,
              ),
            );
            leases.push(
              recordLock(
                BRANCH_LOCK_KIND,
                branchLockId(
                  repositoryIdentity(workspace.repository),
                  workspace.branch,
                ),
                this.lord.root,
              ),
            );
          }
          const claims = claimsForRun(this.lord.root, id);
          // Validate every repository before changing any owner; keep all locks until persisted.
          for (const workspace of workspaces) {
            const claim = claims.find((c) => c.claim_id === workspace.claim_id);
            if (
              !claim ||
              ![previous, taskId].includes(claim.task_id) ||
              claim.target_identity !== targetIdentity(workspace.target)
            )
              throw barrierError(
                "integration claim is missing or belongs to another owner",
              );
            const repo = this.repository(record, workspace.repository);
            const head = refHead(workspace.target, "HEAD");
            if (
              !head ||
              git(workspace.target, ["status", "--porcelain"]).stdout.trim() ||
              git(workspace.target, [
                "branch",
                "--show-current",
              ]).stdout.trim() !== workspace.branch ||
              repositoryIdentity(workspace.target) !==
                repositoryIdentity(repo.repository) ||
              git(
                workspace.target,
                [
                  "merge-base",
                  "--is-ancestor",
                  workspace.head_sha ?? repo.head_sha,
                  head,
                ],
                false,
              ).status !== 0
            )
              throw barrierError(
                "integration checkout must be clean and retain its recorded history",
                { target: workspace.target },
              );
            workspace.head_sha = head;
          }
          record.integration.handover = { from: previous!, to: taskId };
          this.persist(record); // A crash during claim transfer blocks both owners until replay.
          for (const claim of claims)
            writeClaim(this.lord.root, { ...claim, task_id: taskId });
          record.integration.task_id = taskId;
          delete record.integration.handover;
          record.integration.operation_id = null;
          record.integration.provider = null;
          record.integration.model = null;
          this.journal(record, "integration_resumed", {
            previous_task_id: previous,
            task_id: taskId,
            reason,
            workspaces,
          });
          this.persist(record);
        } finally {
          for (const lease of leases.reverse()) lease.release();
        }
      },
    );
    this.bind(id, taskId);
    return this.status(id);
  }
  integrationReset(id: string, reason: string | null): Envelope {
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        if (record.integration.state === "reported")
          throw barrierError("a reported run cannot reset its integrator");
        if (record.integration.state === "pending")
          throw barrierError("this run has no integrator to reset");
        const previous = record.integration.task_id;
        if (record.integration.handover)
          throw barrierError(
            "complete the recorded handover before resetting integration",
          );
        const ownerLease = recordLock(
          "dispatch",
          leaseId("dispatch", previous!),
          this.lord.root,
        );
        try {
          this.requireStopped(previous);
          const released = releaseClaims(this.lord.root, id);
          record.integration.state = "pending";
          record.integration.task_id = null;
          record.integration.operation_id = null;
          record.integration.workspaces = [];
          record.integration.merge_requests = [];
          this.journal(record, "integration_reset", {
            previous_task_id: previous,
            released_claims: released.map((claim) => claim.claim_id),
            reason,
          });
          this.persist(record);
        } finally {
          ownerLease.release();
        }
      },
    );
    return this.status(id);
  }
  /**
   * Record the one MR for one repository, against the integrator's verified
   * success and the real local delivery branch head. The scheduling caller
   * runs this after the integrator returns, never the integrator mid-run.
   */
  mergeRequest(
    id: string,
    repository: string,
    url: string,
    headSha: string,
    verification?: unknown,
  ): Envelope {
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        const declared = this.repository(record, repository);
        if (record.integration.state === "pending")
          throw barrierError(
            "only the final integrator records a merge request",
            {
              repository,
            },
          );
        const head = headSha.toLowerCase();
        if (!SHA_PATTERN.test(head))
          throw planError("merge request head must be a full 40-hex sha", {
            repository,
            head_sha: headSha,
          });
        const operation = this.verifiedOperation(
          record.integration.task_id!,
          "integrator",
          true,
        );
        const claim = claimsForRun(this.lord.root, id).find(
          (entry) => entry.repository === repository,
        );
        if (!claim)
          throw barrierError(
            "this run holds no workspace claim for that repository",
            { repository },
          );
        const observed = refHead(
          repository,
          `refs/heads/${declared.delivery_branch}`,
        );
        if (observed !== head)
          throw unverified(
            "merge request head does not match the local delivery branch",
            {
              repository,
              delivery_branch: declared.delivery_branch,
              reported_head: head,
              observed_head: observed,
            },
          );
        const own = operation.workspace?.repository;
        if (
          own &&
          repositoryIdentity(own) === repositoryIdentity(repository) &&
          operation.delivery_requirements?.require_commit &&
          operation.delivery?.commit_sha?.toLowerCase() !== head
        )
          throw unverified(
            "integrator delivery commit does not match the recorded merge request head",
            {
              repository,
              verified_commit: operation.delivery?.commit_sha ?? null,
              reported_head: head,
            },
          );
        record.integration.operation_id = operation.operation_id;
        const existing = record.integration.merge_requests.find(
          (entry) => entry.repository === repository,
        );
        if (existing && existing.url !== url)
          throw new AgentLordError(
            "MR_CONFLICT",
            "each repository has exactly one merge request in this run",
            {
              details: { repository, existing_url: existing.url, url },
              exit_code: 2,
            },
          );
        verifyPublication(
          repository,
          url,
          declared.delivery_branch,
          declared.source_branch,
          head,
        );
        const receipt =
          verification === undefined
            ? undefined
            : this.verification(record, repository, head, verification);
        if (existing) {
          if (receipt || existing.head_sha !== head)
            existing.verification = receipt;
          existing.head_sha = head;
        } else
          record.integration.merge_requests.push({
            repository,
            url,
            head_sha: head,
            recorded_at: utcNow(),
            verification: receipt,
          });
        this.journal(record, "merge_request_recorded", {
          repository,
          url,
          head_sha: head,
          delivery_branch: declared.delivery_branch,
          integrator_operation_id: operation.operation_id,
        });
        this.persist(record);
      },
    );
    return this.status(id);
  }
  private verification(
    record: PlanRun,
    repository: string,
    head: string,
    value: unknown,
  ): VerificationReceipt {
    if (
      !isObject(value) ||
      value.head_sha !== head ||
      !Array.isArray(value.checks)
    )
      throw barrierError("verification receipt must name the final SHA", {
        repository,
        head_sha: head,
      });
    const checks = records(value.checks);
    const required = new Set([
      "ci",
      ...record.plan.modules
        .filter((m) => m.repository === repository)
        .flatMap((m) => m.verification),
    ]);
    if (
      checks.length !== value.checks.length ||
      checks.some(
        (c) =>
          !string(c.name)?.trim() ||
          !string(c.evidence)?.trim() ||
          !["passed", "accepted_failure"].includes(String(c.status)) ||
          (c.status === "accepted_failure" && !string(c.reason)?.trim()),
      ) ||
      new Set(checks.map((c) => c.name)).size !== checks.length ||
      [...required].some((name) => !checks.some((c) => c.name === name))
    )
      throw barrierError(
        "verification must cover CI and every declared check, with evidence and reasons for user-accepted exceptions",
        {
          repository,
          required_checks: [...required],
        },
      );
    return {
      head_sha: head,
      checks: checks.map((c) => ({
        name: String(c.name),
        status: c.status as "passed" | "accepted_failure",
        evidence: String(c.evidence),
        ...(c.reason ? { reason: String(c.reason) } : {}),
      })),
    };
  }
  private verifyFinalRepository(record: PlanRun, repo: PlanRepository): void {
    const workspace = record.integration.workspaces.find(
      (w) => w.repository === repo.repository,
    );
    const publication = record.integration.merge_requests.find(
      (m) => m.repository === repo.repository,
    );
    if (!workspace || !publication)
      throw barrierError("final repository delivery is missing");
    const claim = claimsForRun(this.lord.root, record.run_id).find(
      (c) => c.claim_id === workspace.claim_id,
    );
    if (
      !claim ||
      claim.task_id !== record.integration.task_id ||
      claim.target_identity !== targetIdentity(workspace.target)
    )
      throw barrierError("final delivery no longer owns its workspace claim");
    const head = refHead(workspace.target, "HEAD");
    if (
      !head ||
      head !== publication.head_sha ||
      head === repo.head_sha ||
      git(workspace.target, ["status", "--porcelain"]).stdout.trim() ||
      git(workspace.target, ["branch", "--show-current"]).stdout.trim() !==
        repo.delivery_branch ||
      git(
        workspace.target,
        ["merge-base", "--is-ancestor", repo.head_sha, head],
        false,
      ).status !== 0
    )
      throw barrierError(
        "final checkout changed or is not a clean delivery descendant",
        { repository: repo.repository },
      );
    for (const module of record.plan.modules.filter(
      (m) => m.repository === repo.repository,
    )) {
      const commit = record.modules[module.module_id]?.commit_sha;
      // git cherry accepts both merged commits and patch-equivalent cherry-picks.
      if (
        !commit ||
        git(workspace.target, ["cherry", head, commit, repo.head_sha])
          .stdout.split("\n")
          .some((line) => line.startsWith("+"))
      )
        throw barrierError("final delivery omits module commits", {
          module_id: module.module_id,
        });
    }
    this.verification(record, repo.repository, head, publication.verification);
    verifyPublication(
      repo.repository,
      publication.url,
      repo.delivery_branch,
      repo.source_branch,
      head,
    );
  }
  /**
   * Close the run: save the integrator's report inside Agent Lord state so it
   * survives the caller's temporary files, then release the workspace claims.
   */
  report(id: string, sourcePath: string, reportText: string): Envelope {
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        if (record.integration.state === "pending")
          throw barrierError("the final integrator has not started yet");
        if (record.integration.handover)
          throw barrierError(
            "complete the recorded handover before closing integration",
          );
        if (!reportText.trim())
          throw barrierError("the process report must not be empty");
        const digest = sha256(reportText);
        const canonical = this.reportFile(id);
        const current = record.integration.report;
        if (current && record.integration.state === "reported") {
          if (current.sha256 === digest && existsSync(current.canonical_path)) {
            releaseClaims(this.lord.root, id);
            return;
          }
          if (current.sha256 !== digest)
            throw new AgentLordError(
              "REPORT_CONFLICT",
              "this run is already closed with a different process report",
              {
                details: {
                  run_id: id,
                  stored_sha256: current.sha256,
                  stored_path: current.canonical_path,
                  submitted_sha256: digest,
                },
                exit_code: 2,
              },
            );
        }
        const ownerLease = recordLock(
          "dispatch",
          leaseId("dispatch", record.integration.task_id!),
          this.lord.root,
        );
        try {
          this.requireStopped(record.integration.task_id);
          const operation = this.verifiedOperation(
            record.integration.task_id!,
            "integrator",
            true,
          );
          const missing = record.plan.repositories
            .map((r) => r.repository)
            .filter(
              (repository) =>
                !record.integration.merge_requests.some(
                  (entry) => entry.repository === repository,
                ),
            );
          if (missing.length)
            throw barrierError(
              "every repository needs its merge request recorded",
              { missing },
            );
          for (const repo of record.plan.repositories)
            this.verifyFinalRepository(record, repo);
          const primary = record.integration.workspaces.find(
            (w) =>
              targetIdentity(w.target) === targetIdentity(operation.target),
          );
          const publication = record.integration.merge_requests.find(
            (m) => m.repository === primary?.repository,
          );
          if (
            !publication ||
            operation.delivery?.commit_sha !== publication.head_sha
          )
            throw unverified(
              "current integrator result does not cover the final primary SHA",
            );
          mkdirSync(path.dirname(canonical), { recursive: true, mode: 0o700 });
          atomicWrite(canonical, reportText);
          record.integration.state = "reported";
          record.integration.report = {
            canonical_path: canonical,
            source_path: resolvePath(sourcePath),
            bytes: statSync(canonical).size,
            sha256: digest,
            reported_at: utcNow(),
          };
          this.journal(record, "run_reported", {
            canonical_path: canonical,
            report_sha256: digest,
            bytes: record.integration.report.bytes,
            merge_requests: record.integration.merge_requests.map((e) => e.url),
          });
          this.persist(record);
          releaseClaims(this.lord.root, id); // Replay releases leftover claims if the caller dies after commit.
        } finally {
          ownerLease.release();
        }
      },
    );
    return this.status(id);
  }
}
function readPlanText(file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } catch (error) {
    throw planError("cannot read the planner plan file", {
      path: file,
      error: String(error),
    });
  }
}
export function planValidationEnvelope(value: unknown): Envelope {
  const plan = validatePlan(value);
  return {
    version: 1,
    status: "PLAN_VALID",
    plan: {
      plan_id: plan.plan_id,
      plan_sha256: sha256(stringifyJson(plan)),
      goal: plan.goal,
      repositories: plan.repositories.length,
      modules: plan.modules.length,
      initial_ready: plan.modules
        .filter((module) => !module.depends_on.length)
        .map((module) => module.module_id),
    },
  };
}
