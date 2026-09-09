import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "./ui/button";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setStatus("已复制"); }
    catch { setStatus("复制失败，请手动选择"); }
  };
  return <Button className="h-7 gap-1.5 px-2 text-xs" onClick={copy} size="sm" variant="outline" aria-label={label}>
    <Copy className="size-3" />{status ?? label}
  </Button>;
}
