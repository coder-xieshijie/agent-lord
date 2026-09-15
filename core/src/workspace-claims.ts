import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { type Data, isObject } from "./contracts.js";
import { AgentLordError } from "./errors.js";
import { sha256 } from "./json.js";
import {
  readJson,
  syncDirectory,
  utcNow,
  withLock,
  writeJson,
} from "./state.js";
/**
 * A durable reservation of one repository checkout branch by one task.
 *
 * The runtime already blocks a second writer through per-operation leases and
 * the unfenced-operation scan, but both are bound to a single `op.target`. A
 * claim is the same exclusion expressed durably and independently of any one
 * operation, so one task can own the delivery worktree of several repositories
 * at once. Nothing else about start/turn changes: a claim only adds a conflict.
 *
 * Claims are serialized by the same `workspace-write` and `branch-write` locks
 * ordinary writers take, and in the same order, so acquiring, checking and
 * releasing a claim is atomic against both another plan run and a normal start.
 */
export interface WorkspaceClaim extends Data {
  version: 1;
  claim_id: string;
  run_id: string;
  task_id: string;
  repository: string;
  repository_identity: string;
  target: string;
  target_identity: string;
  branch: string;
  created_at: string;
}
export function leaseId(prefix: string, value: string): string {
  return `${prefix}-${sha256(value).slice(0, 32)}`;
}
/** The exact lock ordinary writable operations take for this checkout branch. */
export const BRANCH_LOCK_KIND = "branch-write";
export const WORKSPACE_LOCK_KIND = "workspace-write";
export function branchLockId(
  repositoryIdentity: string,
  branch: string,
): string {
  return leaseId("branch", `${repositoryIdentity}\0${branch}`);
}
export function workspaceLockId(targetIdentity: string): string {
  return leaseId("workspace", targetIdentity);
}
export function claimsDirectory(root: string): string {
  return path.join(root, "workspace-claims");
}
export function claimId(repositoryIdentity: string, branch: string): string {
  return `claim-${sha256(`${repositoryIdentity}\0${branch}`).slice(0, 32)}`;
}
function claimPath(root: string, id: string): string {
  return path.join(claimsDirectory(root), `${id}.json`);
}
function readClaimFile(root: string, id: string): WorkspaceClaim | undefined {
  const file = claimPath(root, id);
  if (!existsSync(file)) return undefined;
  const value = readJson(
    file,
    "CLAIM_UNKNOWN",
    "workspace claim disappeared",
  ) as unknown as WorkspaceClaim;
  return isObject(value) && value.version === 1 ? value : undefined;
}
export function readClaims(root: string): WorkspaceClaim[] {
  const directory = claimsDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readClaimFile(root, path.basename(file, ".json")))
    .filter((claim): claim is WorkspaceClaim => claim !== undefined);
}
export function writeClaim(root: string, claim: WorkspaceClaim): void {
  mkdirSync(claimsDirectory(root), { recursive: true, mode: 0o700 });
  writeJson(claimPath(root, claim.claim_id), claim);
}
export function claimsForRun(root: string, runId: string): WorkspaceClaim[] {
  return readClaims(root).filter((claim) => claim.run_id === runId);
}
/**
 * The claim another task holds over this worktree. Callers check it while they
 * hold that worktree's `workspace-write` lock, so no writer can observe an
 * empty result and then be overtaken by a new claim.
 */
export function claimForTarget(
  root: string,
  owner: string | undefined,
  targetIdentity: string,
): WorkspaceClaim | undefined {
  return readClaims(root).find(
    (claim) =>
      claim.task_id !== owner && claim.target_identity === targetIdentity,
  );
}
/** The claim another task holds over this repository branch, checked under `branch-write`. */
export function claimForBranch(
  root: string,
  owner: string | undefined,
  repositoryIdentity: string,
  branch: string,
): WorkspaceClaim | undefined {
  const claim = readClaimFile(root, claimId(repositoryIdentity, branch));
  return claim && claim.task_id !== owner ? claim : undefined;
}
export function claimConflictError(claim: WorkspaceClaim): AgentLordError {
  return new AgentLordError(
    "WORKSPACE_CLAIM_CONFLICT",
    "another task holds a durable workspace claim on this checkout",
    {
      retryable: true,
      safe_recovery: "WAIT_FOR_CLAIM_RELEASE_OR_USE_ISOLATED_WORKTREE",
      details: {
        claim_id: claim.claim_id,
        owner_task_id: claim.task_id,
        run_id: claim.run_id,
        repository: claim.repository,
        branch: claim.branch,
        target: claim.target,
      },
    },
  );
}
export function newClaim(value: {
  run_id: string;
  task_id: string;
  repository: string;
  repository_identity: string;
  target: string;
  target_identity: string;
  branch: string;
}): WorkspaceClaim {
  return {
    version: 1,
    claim_id: claimId(value.repository_identity, value.branch),
    created_at: utcNow(),
    ...value,
  };
}
/**
 * Release this run's claims. Each file is re-read while its `branch-write`
 * lock is held and removed only when it still belongs to this run, so a
 * replacement owner's claim on the same deterministic path survives.
 */
export function releaseClaims(root: string, runId: string): WorkspaceClaim[] {
  const released: WorkspaceClaim[] = [];
  for (const candidate of claimsForRun(root, runId)) {
    withLock(
      BRANCH_LOCK_KIND,
      branchLockId(candidate.repository_identity, candidate.branch),
      root,
      () => {
        const current = readClaimFile(root, candidate.claim_id);
        if (!current) return;
        if (current.run_id !== runId) return;
        unlinkSync(claimPath(root, current.claim_id));
        released.push(current);
      },
    );
  }
  if (released.length) syncDirectory(claimsDirectory(root));
  return released;
}
