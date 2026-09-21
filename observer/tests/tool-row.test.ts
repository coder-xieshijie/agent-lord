import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolRow } from "../src/web/components/tool-row";
import type { ToolItem } from "../src/shared/types";
import { CodexProjector } from "../src/server/projector/codex";
import { Timeline } from "../src/server/timeline";
import { presentTimeline } from "../src/web/lib/presentation";
const render=(item: Partial<ToolItem>)=>renderToStaticMarkup(createElement(ToolRow,{item:{id:"a",kind:"tool",name:"write",state:"running",ord:0,...item},open:false,onOpenChange:()=>{}}));
describe("tool timing presentation",()=>{
  it("renders a projected startup warning in amber with its full detail and keeps it out of successful tool groups", () => {
    const timeline = new Timeline();
    const projector = new CodexProjector(timeline, "fixture-warning-ui");
    const message = "Under-development features enabled: respect_system_proxy. Under-development features are incomplete and may behave unpredictably.";
    projector.handleLine(JSON.stringify({ type: "item.completed", item: { id: "warning", type: "error", message } }));
    for (const id of ["a", "b", "c"]) {
      projector.handleLine(JSON.stringify({ type: "item.completed", item: { id, type: "command_execution", command: "true", exit_code: 0 } }));
    }
    const { rows } = presentTimeline(timeline.snapshotItems());
    expect(rows.map((row) => row.kind)).toEqual(["tool", "tool-group"]);
    const html = renderToStaticMarkup(createElement(ToolRow, { item: rows[0] as ToolItem, open: true, onOpenChange: () => {} }));
    expect(html).toContain("配置警告 · 警告");
    expect(html).toContain(message);
    expect(html).toContain("text-amber-700");
    expect(html).not.toContain("执行失败");
    expect(html).not.toContain("text-destructive");
  });
  it("shows preparation separately from execution",()=>{
    expect(render({phase:"preparing"})).toContain("准备参数");
    const html=render({state:"completed",phase:"completed",preparationMs:225000,executionMs:53,errorText:null});
    expect(html).toContain("参数准备 225.00s");expect(html).toContain("执行 0.05s");expect(html).not.toContain("执行失败");
  });
  it("does not invent unavailable timing",()=>{expect(render({state:"completed"})).not.toContain("参数准备");});
});
