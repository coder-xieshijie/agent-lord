import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentLord } from "./engine.js";
import {
  type Data,
  type Envelope,
  isObject,
  records,
  string,
  strings,
} from "./contracts.js";
import { sha256, stringifyJson } from "./json.js";
import { AgentLordError } from "./errors.js";
import {
  readJson,
  writeJson,
  withLock,
  validateIdentifier,
  utcNow,
} from "./state.js";
import { TaskSets } from "./task-sets.js";

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
  commit_sha: string | null;
  note: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
}
interface IntegrationRecord {
  state: "pending" | "dispatched" | "reported";
  task_id: string | null;
  provider: string | null;
  model: string | null;
  merge_requests: Array<{
    repository: string;
    url: string;
    head_sha: string | null;
    recorded_at: string;
  }>;
  report_path: string | null;
  report_sha256: string | null;
  reported_at: string | null;
}
interface PlanRun {
  version: 1;
  run_id: string;
  plan_sha256: string;
  plan: ImplementationPlan;
  modules: Record<string, ModuleRecord>;
  integration: IntegrationRecord;
  journal: Data[];
  created_at: string;
  updated_at: string;
}
function planError(message: string, details: Data = {}): AgentLordError {
  return new AgentLordError("PLAN_INVALID", message, {
    details,
    exit_code: 2,
  });
}
function barrierError(message: string, details: Data = {}): AgentLordError {
  return new AgentLordError("PLAN_BARRIER", message, {
    details,
    exit_code: 2,
  });
}
/** Normalize an owned path so prefix comparison cannot be defeated by `./` or a trailing slash. */
function normalizeOwnedPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.replace(/^\.\//u, "").replace(/\/+$/u, "");
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
      .map(normalizeOwnedPath);
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
              {
                modules: [left.module_id, right.module_id],
                paths: [a, b],
              },
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
 * Durable plan run: freezes a validated plan, computes the unbounded ready set,
 * enforces the dependency and final-integration barriers, and journals every
 * shareable decision for the process report.
 */
export class PlanRuns {
  constructor(private readonly lord: AgentLord) {}
  private file(id: string): string {
    return path.join(
      this.lord.root,
      "plan-runs",
      `${validateIdentifier("run_id", id)}.json`,
    );
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
  create(id: string, planValue: unknown): Envelope {
    const plan = validatePlan(planValue);
    const digest = sha256(stringifyJson(plan));
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        if (existsSync(this.file(id))) {
          // Idempotent recovery: the same plan replays into the same durable run.
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
          return;
        }
        const now = utcNow();
        const record: PlanRun = {
          version: 1,
          run_id: id,
          plan_sha256: digest,
          plan,
          modules: Object.fromEntries(
            plan.modules.map((module) => [
              module.module_id,
              {
                state: "pending" as ModuleState,
                task_id: null,
                provider: null,
                model: null,
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
            merge_requests: [],
            report_path: null,
            report_sha256: null,
            reported_at: null,
          },
          journal: [],
          created_at: now,
          updated_at: now,
        };
        this.journal(record, "plan_frozen", {
          plan_id: plan.plan_id,
          plan_sha256: digest,
          modules: plan.modules.length,
          repositories: plan.repositories.map((r) => r.repository),
        });
        this.persist(record);
      },
    );
    return this.status(id);
  }
  status(id: string): Envelope {
    const record = this.read(id);
    const ready = this.readySet(record);
    const blockers = this.blockers(record);
    return {
      version: 1,
      status: "PLAN_RECORD",
      plan_run: {
        run_id: record.run_id,
        plan_id: record.plan.plan_id,
        plan_sha256: record.plan_sha256,
        goal: record.plan.goal,
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
        ready: ready,
        ready_count: ready.length,
        blocked: blockers,
        integration_ready: blockers.length === 0,
        integration: record.integration,
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
        if (
          module.state === state &&
          module.commit_sha === (meta.commit_sha ?? null)
        )
          return;
        if (module.state !== "dispatched")
          throw barrierError("only a dispatched module can report delivery", {
            module_id: moduleId,
            state: module.state,
          });
        if (state === "delivered" && !meta.commit_sha)
          throw barrierError(
            "a delivered module must report its local commit sha",
            { module_id: moduleId },
          );
        module.state = state;
        module.commit_sha = meta.commit_sha ?? null;
        module.note = meta.note ?? null;
        module.delivered_at = utcNow();
        this.journal(record, "module_result", {
          module_id: moduleId,
          task_id: module.task_id,
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
  /** Final integration barrier: one integrator, only after every module delivered. */
  integrate(
    id: string,
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
        if (
          record.integration.state !== "pending" &&
          record.integration.task_id === taskId
        )
          return;
        if (record.integration.task_id && record.integration.task_id !== taskId)
          throw barrierError("this run already has a final integrator", {
            integrator_task_id: record.integration.task_id,
          });
        const blockers = this.blockers(record);
        if (blockers.length)
          throw barrierError(
            "final integration starts only after every module is delivered",
            { blocked: blockers },
          );
        record.integration.state = "dispatched";
        record.integration.task_id = taskId;
        record.integration.provider = meta.provider ?? null;
        record.integration.model = meta.model ?? null;
        this.journal(record, "integration_dispatched", {
          task_id: taskId,
          provider: record.integration.provider,
          model: record.integration.model,
          repositories: record.plan.repositories.map((r) => r.repository),
          merged_modules: record.plan.modules.map((m) => m.module_id),
        });
        this.persist(record);
      },
    );
    this.bind(id, taskId);
    return this.status(id);
  }
  /** Record the single MR for one repository; a second distinct URL is a conflict. */
  mergeRequest(
    id: string,
    repository: string,
    url: string,
    headSha: string | null,
  ): Envelope {
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        if (!record.plan.repositories.some((r) => r.repository === repository))
          throw planError("repository is not part of this plan", {
            repository,
          });
        if (record.integration.state === "pending")
          throw barrierError(
            "only the final integrator records a merge request",
            { repository },
          );
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
        if (existing) existing.head_sha = headSha;
        else
          record.integration.merge_requests.push({
            repository,
            url,
            head_sha: headSha,
            recorded_at: utcNow(),
          });
        this.journal(record, "merge_request_recorded", {
          repository,
          url,
          head_sha: headSha,
        });
        this.persist(record);
      },
    );
    return this.status(id);
  }
  /** Close the run with a non-empty process report and one MR per repository. */
  report(id: string, reportPath: string, reportText: string): Envelope {
    withLock(
      "plan-run",
      validateIdentifier("run_id", id),
      this.lord.root,
      () => {
        const record = this.read(id);
        if (record.integration.state === "pending")
          throw barrierError("the final integrator has not started yet");
        if (!reportText.trim())
          throw barrierError("the process report must not be empty");
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
            {
              missing,
            },
          );
        record.integration.state = "reported";
        record.integration.report_path = reportPath;
        record.integration.report_sha256 = sha256(reportText);
        record.integration.reported_at = utcNow();
        this.journal(record, "run_reported", {
          report_path: reportPath,
          report_sha256: record.integration.report_sha256,
          merge_requests: record.integration.merge_requests.map((e) => e.url),
        });
        this.persist(record);
      },
    );
    return this.status(id);
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
