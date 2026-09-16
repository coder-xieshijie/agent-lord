import { execFileSync } from "node:child_process";
import { AgentLordError } from "./errors.js";
import { git } from "./workspace.js";

/** Read publication facts through the authenticated forge CLI; never mutate a PR. */
export function verifyPublication(
  repository: string,
  url: string,
  branch: string,
  target: string,
  head: string,
): void {
  const fail = () =>
    new AgentLordError(
      "ENDPOINT_UNVERIFIED",
      "merge request must match the repository, source, target and final SHA",
      { exit_code: 2 },
    );
  try {
    const remote = git(repository, [
      "remote",
      "get-url",
      "origin",
    ]).stdout.trim();
    const origin = new URL(
      remote.includes("://")
        ? remote
        : remote.replace(/^(?:[^@]+@)?([^:]+):(.+)$/u, "ssh://$1/$2"),
    );
    const mr = new URL(url);
    const project = origin.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    if (
      mr.protocol !== "https:" ||
      mr.host !== origin.host ||
      mr.username ||
      mr.password ||
      mr.search ||
      mr.hash
    )
      throw fail();
    const github = mr.pathname.match(/^\/(.+)\/pull\/(\d+)$/u);
    const gitlab = mr.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)$/u);
    const match = github ?? gitlab;
    if (!match || match[1] !== project) throw fail();
    const args = github
      ? ["api", "--hostname", mr.hostname, `repos/${project}/pulls/${match[2]}`]
      : [
          "api",
          "--hostname",
          mr.hostname,
          `projects/${encodeURIComponent(project)}/merge_requests/${match[2]}`,
        ];
    const data = JSON.parse(
      execFileSync(github ? "gh" : "glab", args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const valid = github
      ? data.state === "open" &&
        data.head?.sha === head &&
        data.head?.ref === branch &&
        data.base?.ref === target &&
        data.head?.repo?.full_name === project &&
        data.base?.repo?.full_name === project
      : data.state === "opened" &&
        data.sha === head &&
        data.source_branch === branch &&
        data.target_branch === target &&
        Number.isSafeInteger(data.source_project_id) &&
        data.source_project_id === data.target_project_id;
    if (!valid) throw fail();
  } catch {
    throw fail();
  } // CLI stderr can contain authentication or remote details.
}
