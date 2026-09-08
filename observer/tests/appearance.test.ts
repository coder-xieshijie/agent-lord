import { describe, expect, it } from "vitest";
import { fontStack, readAppearance } from "../src/web/lib/appearance.js";

describe("appearance persistence", () => {
  it("migrates the old light/dark preference", () => {
    expect(readAppearance({ getItem: (key) => key === "observer-theme" ? "dark" : null })).toEqual({ theme: "dark", font: "system", codeFont: "system" });
  });
  it("survives disabled storage and malformed or unsupported saved settings", () => {
    for (const storage of [{ getItem: () => "{broken" }, { getItem: () => { throw new Error("blocked"); } }]) {
      expect(readAppearance(storage).theme).toBe("system");
    }
    expect(readAppearance({ getItem: () => JSON.stringify({ theme: "missing", font: "\u0000bad", codeFont: "Menlo" }) })).toEqual({ theme: "system", font: "system", codeFont: "Menlo" });
  });
  it("quotes family names and preserves a usable fallback stack", () => {
    expect(fontStack('Font "Special"')).toMatch(/^"Font \\"Special\\"", /);
    expect(fontStack("JetBrains Mono", true)).toContain('"JetBrains Mono", ui-monospace');
  });
});
