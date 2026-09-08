import path from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
export function resolvePath(value: string): string {
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? path.join(homedir(), value.slice(2))
        : value;
  const absolute = path.resolve(expanded);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    return parent === absolute
      ? absolute
      : path.join(resolvePath(parent), path.basename(absolute));
  }
}
export function within(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
