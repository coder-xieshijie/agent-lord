import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { type Data, integer, string } from "./contracts.js";
import { AgentLordError, errorCode, errorMessage } from "./errors.js";
import { atomicWrite } from "./state.js";
export function pidAlive(pid: unknown): boolean {
  if (!integer(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}
export function groupAlive(pid: unknown, group: unknown): boolean {
  if (!integer(pid) || pid <= 0) return false;
  if (process.platform === "win32" || !integer(group) || group <= 0)
    return pidAlive(pid);
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}
export function processIdentityMatches(
  pid: unknown,
  group: unknown,
  resultPath: unknown,
): boolean {
  if (!integer(pid) || pid <= 0 || !string(resultPath)) return false;
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    return result.status === 0 && result.stdout.includes(resultPath as string);
  }
  if (group !== pid) return false;
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "pgid=", "-o", "command="],
    { encoding: "utf8", timeout: 2000 },
  );
  return (
    result.status === 0 &&
    Number(result.stdout.trim().split(/\s+/, 1)[0]) === group &&
    result.stdout.includes(resultPath as string)
  );
}
export async function terminateProcess(
  pid: unknown,
  group: unknown,
  graceSeconds: number,
): Promise<void> {
  if (!integer(pid) || pid <= 0) return;
  const alive = () => groupAlive(pid, group);
  const gone = async (seconds: number) => {
    const until = performance.now() + Math.max(50, seconds * 1000);
    while (performance.now() < until) {
      if (!alive()) return true;
      await delay(50);
    }
    return !alive();
  };
  if (!alive()) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: Math.max(1000, graceSeconds * 1000),
      windowsHide: true,
    });
    if (result.status !== 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* verify below */
      }
    }
    if (await gone(Math.max(1, graceSeconds))) return;
  } else {
    const target = integer(group) && group > 0 ? -group : pid;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(target, signal);
      } catch (error) {
        if (errorCode(error) === "ESRCH") return;
        throw new AgentLordError(
          "PROCESS_FENCE_FAILED",
          "cannot signal the provider operation process group",
          {
            details: {
              pid,
              process_group_id: group,
              error: errorMessage(error),
            },
          },
        );
      }
      if (
        await gone(
          signal === "SIGTERM" ? graceSeconds : Math.max(1, graceSeconds),
        )
      )
        return;
    }
  }
  throw new AgentLordError(
    "PROCESS_FENCE_FAILED",
    "provider operation process group did not terminate",
    { details: { pid, process_group_id: group } },
  );
}
export function readText(file: string, optional = false): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } catch (error) {
    if (optional && errorCode(error) === "ENOENT") return "";
    throw new AgentLordError("RESULT_INVALID", "cannot read provider output", {
      details: { path: file, error: errorMessage(error) },
    });
  }
}
export class LogTail {
  private offset = 0;
  private remainder = "";
  private decoder: TextDecoder;
  constructor(
    readonly file: string,
    strict = false,
  ) {
    this.decoder = new TextDecoder("utf-8", { fatal: strict });
  }
  read(final = false): { lines: string[]; bytes: number } {
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { lines: [], bytes: 0 };
      throw error;
    }
    let bytes = 0;
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let n: number;
      while ((n = readSync(fd, buffer, 0, buffer.length, this.offset)) > 0) {
        this.offset += n;
        bytes += n;
        this.remainder += this.decoder.decode(buffer.subarray(0, n), {
          stream: true,
        });
      }
      if (final) this.remainder += this.decoder.decode();
      const lines = this.remainder.split("\n");
      this.remainder = lines.pop()!;
      if (final && this.remainder) {
        lines.push(this.remainder);
        this.remainder = "";
      }
      return {
        lines: lines.map((line) =>
          line.endsWith("\r") ? line.slice(0, -1) : line,
        ),
        bytes,
      };
    } finally {
      closeSync(fd);
    }
  }
}
export function filesystemTimeNs(root: string): bigint {
  // Both timestamps come from the same filesystem clock; hrtime is not epoch time.
  const file = path.join(root, "tmp", `clock-${randomUUID()}`);
  atomicWrite(file, "");
  try {
    return statSync(file, { bigint: true }).mtimeNs;
  } finally {
    unlinkSync(file);
  }
}
export interface ChildSpec {
  command: string[];
  target: string;
  prompt: string;
  stdout: string;
  stderr: string;
  root: string;
  env?: NodeJS.ProcessEnv;
  detached: boolean;
  exclusive?: boolean;
  pollMs?: number;
  graceSeconds?: number;
  prepared?: () => void;
  launched: (pid: number) => void;
  notDelivered: () => void;
  observe?: (final: boolean) => void | Promise<void>;
  exited: (code: number) => void;
}
/** Children write directly to durable files so a dead controller cannot break a pipe. */
export async function runChild(spec: ChildSpec): Promise<number> {
  const prompt = path.join(spec.root, "tmp", `prompt-${randomUUID()}.txt`);
  const descriptors: number[] = [];
  let child: ChildProcess | undefined;
  let finished = false;
  atomicWrite(prompt, spec.prompt);
  try {
    descriptors.push(openSync(prompt, "r"));
    descriptors.push(openSync(spec.stdout, spec.exclusive ? "wx" : "w", 0o600));
    descriptors.push(openSync(spec.stderr, spec.exclusive ? "wx" : "w", 0o600));
    spec.prepared?.();
    let resolveExit!: (value: number) => void;
    const exit = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    try {
      child = spawn(spec.command[0], spec.command.slice(1), {
        cwd: spec.target,
        env: spec.env,
        stdio: descriptors as [number, number, number],
        detached: spec.detached && process.platform !== "win32",
        windowsHide: true,
      });
      child.once("exit", (code, signal) => {
        finished = true;
        resolveExit(
          code ??
            -(constants.signals[signal as keyof typeof constants.signals] ?? 1),
        );
      });
      await new Promise<void>((resolve, reject) => {
        child!.once("spawn", resolve);
        child!.once("error", reject);
      });
    } catch (error) {
      spec.notDelivered();
      throw new AgentLordError(
        "PROVIDER_UNAVAILABLE",
        "cannot launch provider CLI",
        {
          retryable: true,
          safe_recovery: "RETRY_SAME_COMMAND",
          details: { binary: spec.command[0], error: errorMessage(error) },
        },
      );
    }
    spec.launched(child.pid!);
    while (!finished) {
      await spec.observe?.(false);
      if (!finished) await Promise.race([exit, delay(spec.pollMs ?? 100)]);
    }
    await spec.observe?.(true);
    const code = await exit;
    spec.exited(code);
    return code;
  } catch (error) {
    if (child?.pid && !finished)
      await terminateProcess(
        child.pid,
        spec.detached ? child.pid : null,
        spec.graceSeconds ?? 1,
      );
    throw error;
  } finally {
    for (const fd of descriptors) closeSync(fd);
    try {
      unlinkSync(prompt);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
