import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFontCatalog, discoverFonts } from "../src/server/fonts.js";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  // Node's execFile promisifier returns both named streams, unlike generic callbacks.
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      execFile(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error); else resolve({ stdout, stderr });
      });
    }),
  });
  return { execFile };
});
const respond = (text: string, error: Error | null = null) => {
  vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _options: unknown, callback: Function) => {
    callback(error, text, "");
  }) as typeof execFile);
};
beforeEach(() => vi.clearAllMocks());

describe("host font catalog", () => {
  it("returns sorted unique macOS family names through a bounded fixed command", async () => {
    respond('["Menlo", "PingFang SC", "Menlo", "", null, "bad\\u0000font"]');
    expect(await discoverFonts("darwin")).toEqual({ available: true, families: ["Menlo", "PingFang SC"] });
    expect(execFile).toHaveBeenCalledWith("/usr/bin/osascript", expect.any(Array), expect.objectContaining({ timeout: 8000 }), expect.any(Function));
    expect(vi.mocked(execFile).mock.calls[0][2]).not.toHaveProperty("shell");
  });
  it("handles fontconfig aliases and Windows UTF-8 output", async () => {
    respond("Noto Sans,思源黑体\nJetBrains Mono\n");
    const linux = await discoverFonts("linux");
    expect(linux.families).toEqual(expect.arrayContaining(["Noto Sans", "思源黑体", "JetBrains Mono"]));
    respond('\uFEFF["Consolas"]');
    expect((await discoverFonts("win32")).families).toEqual(["Consolas"]);
  });
  it("degrades on unavailable commands, malformed output or unsupported hosts", async () => {
    respond("", new Error("command unavailable"));
    expect((await discoverFonts("linux")).available).toBe(false);
    respond("not json");
    expect((await discoverFonts("darwin")).available).toBe(false);
    expect((await discoverFonts("freebsd")).available).toBe(false);
  });
  it("shares concurrent discovery and retries after the cache expires", async () => {
    let time = 0;
    const read = vi.fn().mockResolvedValue({ available: true, families: ["Fixture Mono"] });
    const fonts = createFontCatalog(read, () => time);
    await Promise.all([fonts(), fonts()]);
    expect(read).toHaveBeenCalledTimes(1);
    time = 30_001;
    await fonts();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
