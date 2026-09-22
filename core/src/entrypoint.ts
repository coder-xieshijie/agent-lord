import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** True when the invoked script (`argv1`) is the module at `moduleUrl`,
 * resolving symlinks such as package-manager bin shims so wrapped
 * invocations still execute, while plain imports never do. */
export function isMainEntrypoint(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return pathToFileURL(argv1).href === moduleUrl;
  }
}
