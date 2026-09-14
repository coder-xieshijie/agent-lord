import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { type Data, isObject } from "./contracts.js";
import { AgentLordError } from "./errors.js";
import { sha256 } from "./json.js";
import { readJson, syncDirectory, utcNow, writeJson } from "./state.js";
/**
 * A durable reservation of one repository checkout branch by one task.
 *
 * The runtime already blocks a second writer through per-operation leases and
 * the unfenced-operation scan, but both are bound to a single `op.target`. A
 * claim is the same exclusion expressed durably and independently of any one
 * operation, so one task can own the delivery worktree of several repositories
 * at once. Nothing else about start/turn changes: a claim only adds a conflict.
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
export function claimsDirectory(root: string): string {
  return path.join(root, "workspace-claims");
}
export function claimId(repositoryIdentity: string, branch: string): string {
  return `claim-${sha256(`${repositoryIdentity}\0${branch}`).slice(0, 32)}`;
}
function claimPath(root: string, id: string): string {
  return path.join(claimsDirectory(root), `${id}.json`);
}
export function readClaims(root: string): WorkspaceClaim[] {
  const directory = claimsDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(
      (file) =>
        readJson(
          path.join(directory, file),
          "CLAIM_UNKNOWN",
          "workspace claim disappeared",
        ) as unknown as WorkspaceClaim,
    )
    .filter((claim) => isObject(claim) && claim.version === 1);
}
export function writeClaim(root: string, claim: WorkspaceClaim): void {
  mkdirSync(claimsDirectory(root), { recursive: true, mode: 0o700 });
  writeJson(claimPath(root, claim.claim_id), claim);
}
export function releaseClaims(root: string, runId: string): WorkspaceClaim[] {
  const released = readClaims(root).filter((claim) => claim.run_id === runId);
  for (const claim of released) {
    try {
      unlinkSync(claimPath(root, claim.claim_id));
    } catch {
      /* already released */
    }
  }
  if (released.length) syncDirectory(claimsDirectory(root));
  return released;
}
export function claimsForRun(root: string, runId: string): WorkspaceClaim[] {
  return readClaims(root).filter((claim) => claim.run_id === runId);
}
/**
 * The claim another task holds over this checkout, either through the same
 * worktree or the same repository branch. An owner never conflicts with itself,
 * so an integrator keeps working across the repositories it already claimed.
 */
export function conflictingClaim(
  root: string,
  owner: string | undefined,
  targetIdentity: string,
  repositoryIdentity: string | null,
  branch: string | null,
): WorkspaceClaim | undefined {
  return readClaims(root).find(
    (claim) =>
      claim.task_id !== owner &&
      (claim.target_identity === targetIdentity ||
        (repositoryIdentity !== null &&
          branch !== null &&
          claim.repository_identity === repositoryIdentity &&
          claim.branch === branch)),
  );
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
