import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolRow } from "../src/web/components/tool-row";
import type { ToolItem } from "../src/shared/types";
const render=(item: Partial<ToolItem>)=>renderToStaticMarkup(createElement(ToolRow,{item:{id:"a",kind:"tool",name:"write",state:"running",ord:0,...item},open:false,onOpenChange:()=>{}}));
describe("tool timing presentation",()=>{
  it("shows preparation separately from execution",()=>{
    expect(render({phase:"preparing"})).toContain("准备参数");
    const html=render({state:"completed",phase:"completed",preparationMs:225000,executionMs:53,errorText:null});
    expect(html).toContain("参数准备 225.00s");expect(html).toContain("执行 0.05s");expect(html).not.toContain("执行失败");
  });
  it("does not invent unavailable timing",()=>{expect(render({state:"completed"})).not.toContain("参数准备");});
});
