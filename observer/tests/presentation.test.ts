import { describe, expect, it } from "vitest";
import type { TimelineItem, ToolItem } from "../src/shared/types.js";
import { presentTimeline, toolSummary } from "../src/web/lib/presentation.js";

const tool = (id: string, state: ToolItem["state"] = "completed", opId: string | undefined = "fixture-op"): ToolItem => ({
  id, kind: "tool", name: "read", state, opId, ord: 0,
});

describe("reader-facing timeline", () => {
  it("keeps group identity as live completions arrive, without mutating source events", () => {
    const items = [tool("a"), tool("b"), tool("c"), tool("d", "running")];
    const before = presentTimeline(items).rows;
    const after = presentTimeline([...items.slice(0, 3), tool("d")]).rows;
    expect(before.map((row) => row.kind)).toEqual(["tool-group", "tool"]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(items[3].state).toBe("running");
  });

  it("never groups across messages, rounds, hidden lifecycle events or unknown operation identity", () => {
    const items: TimelineItem[] = [
      tool("a"), tool("b"),
      { id: "message", kind: "message", text: "分析", streaming: false, role: "assistant", ord: 0 },
      tool("c"), tool("d"), tool("e", "completed", "other-op"),
      { id: "round", kind: "lifecycle", name: "start", label: "开始", ord: 0 },
      tool("f", "completed", "other-op"), tool("g", "completed", "other-op"),
      { ...tool("h"), opId: undefined }, { ...tool("i"), opId: undefined }, { ...tool("j"), opId: undefined },
    ];
    expect(presentTimeline(items).rows.some((row) => row.kind === "tool-group")).toBe(false);
    expect(presentTimeline(items).details.map((row) => row.id)).toEqual(["round"]);
  });

  it("keeps running tools, failures and history warnings visible", () => {
    const items: TimelineItem[] = [tool("a"), tool("b"), tool("c"), tool("active", "running"), tool("failed", "error"),
      { id: "notice", kind: "notice", text: "历史缺失", ord: 0 },
      { id: "error", kind: "journal", name: "error", label: "连接失败", level: "error", ord: 0 },
      { id: "final", kind: "final", ok: false, summary: "执行失败", ord: 0 },
      { id: "success", kind: "journal", name: "success", label: "操作成功", level: "success", ord: 0 },
    ];
    expect(presentTimeline(items).rows.map((row) => row.id)).toEqual(["group:a", "active", "failed", "notice", "error", "final"]);
    expect(presentTimeline(items).details.map((row) => row.id)).toEqual(["success"]);
    expect(toolSummary([tool("a"), tool("b"), { ...tool("c"), name: "custom_tool" }])).toBe("read ×2 · custom_tool");
  });
});
