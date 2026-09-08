import { useEffect, useState } from "react";
import { Check, Palette, RotateCcw } from "lucide-react";
import type { FontCatalog } from "../../shared/types";
import { fetchFonts } from "@/lib/api";
import { applyAppearance, readAppearance, saveAppearance, THEMES, UI_FONT_SIZES, CODE_FONT_SIZES, DEFAULT_APPEARANCE, type Appearance } from "@/lib/appearance";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

function FontSelect({ label, value, families, onChange }: {
  label: string; value: string; families: string[]; onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
      {label}
      <select aria-label={label} className="appearance-select" onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="system">系统默认{label === "代码字体" ? "等宽字体" : "字体"}</option>
        {value !== "system" && !families.includes(value) ? <option value={value}>{value}（已保存）</option> : null}
        {families.length ? (
          <optgroup label={`本机已安装 · ${families.length} 种`}>
            {families.map((family) => <option key={family} value={family}>{family}</option>)}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

function FontSizeSelect({ label, value, sizes, onChange }: {
  label: string; value: number; sizes: number[]; onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
      {label}
      <select aria-label={label} className="appearance-select" onChange={(event) => onChange(Number(event.target.value))} value={value}>
        {sizes.map((size) => <option key={size} value={size}>{size} px</option>)}
      </select>
    </label>
  );
}

export function AppearanceControls() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try { return readAppearance(localStorage); }
    catch { return { ...DEFAULT_APPEARANCE }; }
  });
  const [catalog, setCatalog] = useState<FontCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(appearance, media.matches);
    apply();
    saveAppearance(appearance);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);

  const detect = async () => {
    setLoading(true);
    try { setCatalog(await fetchFonts()); }
    catch { setCatalog({ families: [], available: false, message: "字体列表暂不可用，可继续使用系统默认字体。" }); }
    finally { setLoading(false); }
  };
  const change = (patch: Partial<Appearance>) => setAppearance((current) => ({ ...current, ...patch }));

  return (
    <Collapsible className="shrink-0 border-b" onOpenChange={(next) => {
      setOpen(next);
      if (next && !catalog && !loading) void detect();
    }} open={open}>
      <div className="flex h-11 items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="font-semibold tracking-tight text-foreground">Agent Lord</span>
          <span className="hidden sm:inline">/</span>
          <span className="truncate">实时观察</span>
        </div>
        <CollapsibleTrigger className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          <Palette className="size-3.5" />
          外观
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="max-h-[45vh] overflow-y-auto border-t bg-card/60 px-4 py-4 sm:px-6">
        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
            主题
            <select aria-label="主题" className="appearance-select" onChange={(event) => change({ theme: event.target.value })} value={appearance.theme}>
              {THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
            </select>
          </label>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
            <FontSelect families={catalog?.families ?? []} label="界面字体" onChange={(font) => change({ font })} value={appearance.font} />
            <FontSizeSelect label="界面字号" onChange={(fontSize) => change({ fontSize })} sizes={UI_FONT_SIZES} value={appearance.fontSize} />
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
            <FontSelect families={catalog?.families ?? []} label="代码字体" onChange={(codeFont) => change({ codeFont })} value={appearance.codeFont} />
            <FontSizeSelect label="代码字号" onChange={(codeFontSize) => change({ codeFontSize })} sizes={CODE_FONT_SIZES} value={appearance.codeFontSize} />
          </div>
        </div>
        <div className="mx-auto mt-3 flex max-w-4xl flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{loading ? "正在检测本机字体…" : catalog?.available ? `已识别 ${catalog.families.length} 种本机字体 · 缺少的字形使用系统回退字体` : catalog?.message}</span>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><Check className="size-3" />自动保存</span>
            <button className="hover:text-foreground" onClick={() => change({ fontSize: DEFAULT_APPEARANCE.fontSize, codeFontSize: DEFAULT_APPEARANCE.codeFontSize })} type="button">恢复默认字号</button>
            <button className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50" disabled={loading} onClick={() => void detect()} type="button">
              <RotateCcw className="size-3" />重新检测
            </button>
          </div>
        </div>
        <div className="mx-auto mt-3 flex max-w-4xl flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-sm">
          <span>字体预览 · 让每一步清晰可见</span>
          <code className="observer-code font-mono text-xs text-muted-foreground">const progress = "running";</code>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
