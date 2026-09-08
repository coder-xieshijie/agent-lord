import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, fontStack, readAppearance } from "../src/web/lib/appearance.js";

describe("appearance persistence", () => {
  it("migrates the old light/dark preference", () => {
    expect(readAppearance({ getItem: (key) => key === "observer-theme" ? "dark" : null })).toEqual({ ...DEFAULT_APPEARANCE, theme: "dark" });
    expect(readAppearance({ getItem: () => JSON.stringify({ theme: "nord", font: "Menlo" }) })).toEqual({ ...DEFAULT_APPEARANCE, theme: "nord", font: "Menlo" });
  });
  it("survives disabled storage and malformed or unsupported saved settings", () => {
    for (const storage of [{ getItem: () => "{broken" }, { getItem: () => { throw new Error("blocked"); } }]) {
      expect(readAppearance(storage).theme).toBe("system");
    }
    expect(readAppearance({ getItem: () => JSON.stringify({ theme: "missing", font: "\u0000bad", codeFont: "Menlo", fontSize: "18", codeFontSize: 999 }) })).toEqual({ ...DEFAULT_APPEARANCE, codeFont: "Menlo" });
  });
  it("quotes family names and preserves a usable fallback stack", () => {
    expect(fontStack('Font "Special"')).toMatch(/^"Font \\"Special\\"", /);
    expect(fontStack("JetBrains Mono", true)).toContain('"JetBrains Mono", ui-monospace');
  });
});
