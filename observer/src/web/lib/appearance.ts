export const THEMES = [
  { id: "system", label: "跟随系统", dark: false },
  { id: "light", label: "简洁浅色", dark: false },
  { id: "dark", label: "简洁深色", dark: true },
  { id: "nord", label: "Nord · 北欧", dark: true },
  { id: "dracula", label: "Dracula · 紫夜", dark: true },
  { id: "catppuccin", label: "Catppuccin · 摩卡", dark: true },
  { id: "solarized-light", label: "Solarized · 浅色", dark: false },
  { id: "solarized-dark", label: "Solarized · 深色", dark: true },
] as const;

export interface Appearance {
  theme: string;
  font: string;
  codeFont: string;
  fontSize: number;
  codeFontSize: number;
}

export const UI_FONT_SIZES = Array.from({ length: 13 }, (_, index) => index + 12);
export const CODE_FONT_SIZES = Array.from({ length: 15 }, (_, index) => index + 10);
const KEY = "observer-appearance";
export const DEFAULT_APPEARANCE: Appearance = { theme: "system", font: "system", codeFont: "system", fontSize: 14, codeFontSize: 12 };
const validFont = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

export function readAppearance(storage: Pick<Storage, "getItem">): Appearance {
  try {
    const saved = storage.getItem(KEY);
    const value: Partial<Appearance> | null = saved ? JSON.parse(saved) as Partial<Appearance> | null
      : { theme: storage.getItem("observer-theme") ?? undefined };
    return {
      theme: THEMES.some((theme) => theme.id === value?.theme) ? value!.theme! : DEFAULT_APPEARANCE.theme,
      font: validFont(value?.font) ? value.font : DEFAULT_APPEARANCE.font,
      codeFont: validFont(value?.codeFont) ? value.codeFont : DEFAULT_APPEARANCE.codeFont,
      fontSize: UI_FONT_SIZES.includes(value?.fontSize ?? NaN) ? value!.fontSize! : DEFAULT_APPEARANCE.fontSize,
      codeFontSize: CODE_FONT_SIZES.includes(value?.codeFontSize ?? NaN) ? value!.codeFontSize! : DEFAULT_APPEARANCE.codeFontSize,
    };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}

export function saveAppearance(value: Appearance): void {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* storage may be disabled */ }
}

export function fontStack(name: string, mono = false): string {
  const fallback = mono
    ? 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace'
    : 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  return name === "system" ? fallback : `${JSON.stringify(name)}, ${fallback}`;
}

export function applyAppearance(value: Appearance, systemDark: boolean): void {
  const theme = THEMES.find((item) => item.id === value.theme) ?? THEMES[0];
  const dark = theme.id === "system" ? systemDark : theme.dark;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.setProperty("--observer-font-sans", fontStack(value.font));
  root.style.setProperty("--observer-font-mono", fontStack(value.codeFont, true));
  // Existing body copy uses text-sm (0.875rem). Scale rem-based UI together so
  // controls and line heights keep fitting; code has its own absolute size.
  root.style.fontSize = `${value.fontSize * 16 / 14}px`;
  root.style.setProperty("--observer-code-font-size", `${value.codeFontSize}px`);
}
