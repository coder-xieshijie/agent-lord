import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { git } from "../src/workspace.js";
import { verifyPublication } from "../src/publication.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
vi.mock("../src/workspace.js", async (original) => ({
  ...(await original<typeof import("../src/workspace.js")>()),
  git: vi.fn(),
}));
const sha = "a".repeat(40);
beforeEach(() => {
  vi.resetAllMocks();
});
function remote(value: string): void {
  vi.mocked(git).mockReturnValue({ stdout: value } as ReturnType<typeof git>);
}
function response(value: unknown): void {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(value));
}

describe("authoritative publication identity", () => {
  it("reads a GitLab MR and validates both branches and final SHA", () => {
    remote("git@gitlab.example:org/repo.git");
    response({
      state: "opened",
      sha,
      source_branch: "delivery",
      target_branch: "main",
      source_project_id: 1,
      target_project_id: 1,
    });
    verifyPublication(
      "/repo",
      "https://gitlab.example/org/repo/-/merge_requests/7",
      "delivery",
      "main",
      sha,
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "glab",
      [
        "api",
        "--hostname",
        "gitlab.example",
        "projects/org%2Frepo/merge_requests/7",
      ],
      expect.anything(),
    );
  });
  it("reads GitHub PR facts", () => {
    remote("https://github.com/org/repo.git");
    response({
      state: "open",
      head: { sha, ref: "delivery", repo: { full_name: "org/repo" } },
      base: { ref: "main", repo: { full_name: "org/repo" } },
    });
    verifyPublication(
      "/repo",
      "https://github.com/org/repo/pull/7",
      "delivery",
      "main",
      sha,
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      expect.anything(),
      expect.anything(),
    );
  });
  it.each([
    { sha: "b".repeat(40) },
    { target_branch: "other" },
    { source_branch: "other" },
    { state: "closed" },
    { source_project_id: 2 },
  ])("rejects contradictory remote facts: %j", (change) => {
    remote("git@gitlab.example:org/repo.git");
    response({
      state: "opened",
      sha,
      source_branch: "delivery",
      target_branch: "main",
      source_project_id: 1,
      target_project_id: 1,
      ...change,
    });
    expect(() =>
      verifyPublication(
        "/repo",
        "https://gitlab.example/org/repo/-/merge_requests/7",
        "delivery",
        "main",
        sha,
      ),
    ).toThrow(/must match/);
  });
  it("rejects a foreign host before invoking a CLI", () => {
    remote("git@gitlab.example:org/repo.git");
    expect(() =>
      verifyPublication(
        "/repo",
        "https://foreign.example/org/repo/-/merge_requests/7",
        "delivery",
        "main",
        sha,
      ),
    ).toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("fails closed without exposing authentication errors", () => {
    remote("git@gitlab.example:org/repo.git");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("secret credential");
    });
    expect(() =>
      verifyPublication(
        "/repo",
        "https://gitlab.example/org/repo/-/merge_requests/7",
        "delivery",
        "main",
        sha,
      ),
    ).toThrow(/must match/);
  });
});
