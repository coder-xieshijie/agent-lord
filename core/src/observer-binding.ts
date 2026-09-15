import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Read-only verification of explicitly run-bound observers. Never launches a process or dispatches work. */
export async function verifyRunObservers(
  root: string,
  runId: string,
  tasks: string[],
) {
  const directory = path.join(root, "observer");
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) =>
      /^server-\d+\.json$/.test(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "not_attached", bindings: [] };
    return {
      status: "unverified",
      bindings: [],
      error: "observer metadata unavailable",
    };
  }
  const bindings = [];
  for (const file of files) {
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
    } catch {
      return {
        status: "unverified",
        bindings,
        error: "observer metadata invalid",
      };
    }
    if (!Array.isArray(record.run_ids) || !record.run_ids.includes(runId))
      continue;
    const failure = { port: record.port, binding_verified: false };
    try {
      const url = new URL(record.url);
      if (
        realpathSync(record.state_dir) !== realpathSync(root) ||
        !Number.isInteger(record.port) ||
        record.port < 1 ||
        record.port > 65535 ||
        url.origin !== `http://127.0.0.1:${record.port}` ||
        url.username ||
        url.password ||
        !url.searchParams.get("token")
      )
        throw new Error("invalid observer identity");
      const response = await fetch(`${url.origin}/api/binding`, {
        redirect: "error",
        signal: AbortSignal.timeout(2000),
        headers: { authorization: `Bearer ${url.searchParams.get("token")}` },
      });
      if (!response.ok) throw new Error("binding request failed");
      const body = (await response.json()) as Record<string, unknown>;
      const valid =
        body.instanceId === record.instance_id &&
        body.pid === record.pid &&
        Array.isArray(body.run_ids) &&
        body.run_ids.includes(runId) &&
        Array.isArray(body.task_ids) &&
        tasks.every((id) => (body.task_ids as unknown[]).includes(id)) &&
        typeof body.errors === "object" &&
        body.errors !== null &&
        Object.keys(body.errors).length === 0;
      bindings.push({ port: record.port, binding_verified: valid });
    } catch {
      bindings.push(failure);
    }
  }
  return {
    status: !bindings.length
      ? "not_attached"
      : bindings.every((b) => b.binding_verified)
        ? "verified"
        : "unverified",
    bindings,
  };
}
