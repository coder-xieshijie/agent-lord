import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { useState } from "react";
import type { ToolItem } from "../../shared/types";
import { cn } from "@/lib/utils";
import { toolSummary, type ToolGroup } from "@/lib/presentation";
import { Tool, ToolContent } from "@/components/ai-elements/tool";
import { CodeBlock, CodeBlockHeader, CodeBlockTitle, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Terminal, TerminalHeader, TerminalTitle, TerminalActions, TerminalCopyButton, TerminalContent } from "@/components/ai-elements/terminal";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export type Expansion = Record<string, boolean>;
export type SetExpanded = (id: string, open: boolean) => void;

function CodeDetail({ code, language, label }: { code: string; language: "json" | "shellscript"; label: string }) {
  return (
    <CodeBlock className="tool-code text-xs [&_pre]:max-h-80 [&_pre]:text-xs" code={code} language={language} showLineNumbers={code.split("\n").length > 3}>
      <CodeBlockHeader className="py-1.5">
        <CodeBlockTitle className="min-w-0 truncate">{label}</CodeBlockTitle>
        <CodeBlockCopyButton aria-label={`复制${label}`} />
      </CodeBlockHeader>
    </CodeBlock>
  );
}

function ToolDetails({ item }: { item: ToolItem }) {
  const [follow, setFollow] = useState(true);
  let input: unknown = item.inputText;
  try { if (item.inputText) input = JSON.parse(item.inputText); } catch { /* text input */ }
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const command = typeof record?.command === "string" ? record.command : typeof record?.cmd === "string" ? record.cmd : null;
  const extraInput = record && Object.keys(record).some((key) => key !== "command" && key !== "cmd");
  const file = typeof record?.file_path === "string" ? record.file_path : typeof record?.path === "string" ? record.path : null;
  return (
    <div className="space-y-3">
      {file ? <p className="break-all font-mono text-xs text-muted-foreground">{file}</p> : null}
      {command ? <CodeDetail code={command} label="命令" language="shellscript" /> : null}
      {item.inputText && (!command || extraInput) ? <CodeDetail
        code={typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        label="参数" language={typeof input === "string" ? "shellscript" : "json"}
      /> : null}
      {item.outputText !== undefined || item.state === "running" ? (
        <Terminal autoScroll={follow} className="tool-terminal" isStreaming={item.state === "running"} output={item.outputText ?? ""}>
          <TerminalHeader className="border-border px-3 py-1.5">
            <TerminalTitle className="text-xs text-muted-foreground">输出</TerminalTitle>
            <TerminalActions>
              {item.state === "running" ? <button aria-pressed={follow} className="px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setFollow((value) => !value)} type="button">{follow ? "跟随输出" : "已暂停跟随"}</button> : null}
              <TerminalCopyButton aria-label="复制输出" className="text-muted-foreground hover:bg-accent hover:text-foreground" />
            </TerminalActions>
          </TerminalHeader>
          <TerminalContent className="max-h-80 p-3 text-xs" onScroll={(event) => {
            const element = event.currentTarget;
            setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
          }} />
        </Terminal>
      ) : null}
      {item.errorText ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-3 font-mono text-xs text-destructive">{item.errorText}</pre> : null}
      {item.exitCode !== undefined ? <p className={cn("text-xs text-muted-foreground", item.exitCode !== 0 && "text-destructive")}>退出码 {item.exitCode}</p> : null}
      {!item.inputText && item.outputText === undefined && !item.errorText && item.state !== "running" ? <p className="text-xs text-muted-foreground">此工具未提供更多详情。</p> : null}
    </div>
  );
}

export function ToolRow({ item, open, onOpenChange }: { item: ToolItem; open: boolean; onOpenChange: (open: boolean) => void }) {
  const status = item.state === "running" ? "运行中" : item.state === "error" ? "执行失败" : "已完成";
  return (
    <Tool className="tool-row mb-0 rounded-none border-0" onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger aria-label={`${item.name} · ${status}`} className="group flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {item.state === "running" ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          : item.state === "error" ? <X className="size-3.5 shrink-0 text-destructive" />
          : <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
        <span className="truncate font-medium">{item.name}</span>
        {item.state === "error" ? <span className="shrink-0 text-destructive">执行失败</span> : null}
      </CollapsibleTrigger>
      <ToolContent className="ml-7 space-y-0 border-l py-2 pr-0 pl-3">
        {open ? <ToolDetails item={item} /> : null}
      </ToolContent>
    </Tool>
  );
}

export function CompletedToolGroup({ group, expanded, setExpanded }: { group: ToolGroup; expanded: Expansion; setExpanded: SetExpanded }) {
  // A tool already opened by the reader stays visible when live completions form a group.
  const open = expanded[group.id] ?? group.tools.some((tool) => expanded[tool.id]);
  return (
    <Collapsible onOpenChange={(value) => setExpanded(group.id, value)} open={open}>
      <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="min-w-0 truncate">{toolSummary(group.tools)}</span>
        <span className="ml-auto shrink-0 text-[11px]">{group.tools.length} 项已完成</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-3 border-l pl-2">
        {group.tools.map((tool) => <ToolRow item={tool} key={tool.id} onOpenChange={(value) => setExpanded(tool.id, value)} open={expanded[tool.id] ?? false} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}
