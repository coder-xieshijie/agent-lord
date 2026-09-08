/** Enumerate family names on the observer host. Never read or serve font files. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FontCatalog } from "../shared/types.js";

const run = promisify(execFile);

export async function discoverFonts(platform = process.platform): Promise<FontCatalog> {
  try {
    let families: unknown;
    const options = { encoding: "utf8" as const, timeout: 8_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
    if (platform === "darwin") {
      const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e",
        'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))',
      ], options);
      families = JSON.parse(stdout);
    } else if (platform === "linux") {
      const { stdout } = await run("fc-list", ["--format", "%{family}\\n"], options);
      families = stdout.split(/[\n,]/);
    } else if (platform === "win32") {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; $fonts = New-Object System.Drawing.Text.InstalledFontCollection; ConvertTo-Json -Compress -InputObject @($fonts.Families | ForEach-Object { $_.Name })',
      ], options);
      families = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    } else {
      return { families: [], available: false, message: "当前系统暂不支持字体检测，可继续使用系统默认字体。" };
    }
    if (!Array.isArray(families)) throw new Error("Invalid font catalog");
    const names = [...new Set(families.filter((name): name is string => typeof name === "string")
      .map((name) => name.trim()).filter((name) => name.length > 0 && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name)))];
    if (!names.length) throw new Error("Empty font catalog");
    return { families: names.sort((a, b) => a.localeCompare(b)), available: true };
  } catch {
    return { families: [], available: false, message: "未能读取本机字体，请稍后重试；系统默认字体仍可使用。" };
  }
}

/** Share in-flight reads and cache briefly so every browser does not spawn a process. */
export function createFontCatalog(read = discoverFonts, now = Date.now): () => Promise<FontCatalog> {
  let pending: Promise<FontCatalog> | undefined;
  let expires = 0;
  return () => {
    if (!pending || now() >= expires) {
      expires = Infinity;
      pending = read().then((catalog) => {
        expires = now() + 30_000;
        return catalog;
      }, () => {
        expires = now() + 30_000;
        return { families: [], available: false, message: "未能读取本机字体，系统默认字体仍可使用。" };
      });
    }
    return pending;
  };
}
