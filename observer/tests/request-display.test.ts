import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RequestItem, TaskMeta } from "../src/shared/types.js";
import { RequestRow } from "../src/web/components/request-row.js";
import { ExecutionDetails, callerStatus, elapsed } from "../src/web/components/execution-details.js";
import { selectTask } from "../src/web/lib/task-selection.js";
import { presentTimeline } from "../src/web/lib/presentation.js";

describe("request and execution presentation", () => {
  it("preserves full escaped request text and labels an automatic follow-up with its actual caller", () => {
    const item: RequestItem = { id: "request", kind: "request", role: "caller", text: "<script>not executed</script>" + "完整请求".repeat(400), trigger: "caller_followup", reason: "补齐原始需求", caller: { kind: "codex", session_id: "fixture-caller", turn_id: null, identity_source: "runtime-env" }, originalRecorded: false, opId: "fixture-op", ord: 1 };
    const html = renderToStaticMarkup(createElement(RequestRow, { item }));
    expect(html).toContain("Codex 补充请求");
    expect(html).toContain("fixture-caller");
    expect(html).toContain("补齐原始需求");
    expect(html).toContain("完整请求".repeat(400));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("复制请求");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(presentTimeline([item]).rows).toEqual([item]);
    expect(renderToStaticMarkup(createElement(RequestRow, { item: { ...item, role: "user" } }))).toContain("用户原始请求");
  });

  it("displays requested and actual MCode variants, complete ids and explicit missing metadata", () => {
    const meta = { provider: "mcode-cli", execution: { requestedModel: "provider/fable#xhigh", actualModel: "provider/fable", requestedVariant: "xhigh", actualVariant: "xhigh", modelVerification: "provider-metadata", variantVerification: "provider-metadata" }, caller: { initial: { session_id: "fixture-original-caller-full-id", identity_source: "caller-declared" }, current: { kind: "codex", session_id: "fixture-current-caller-full-id", identity_source: "runtime-env" }, lifecycle: { status: "unknown", turnId: null, note: "未找到记录" } } } as TaskMeta;
    const html = renderToStaticMarkup(createElement(ExecutionDetails, { meta }));
    for (const text of ["请求模型", "实际模型", "provider/fable#xhigh", "xhigh", "fixture-original-caller-full-id", "fixture-current-caller-full-id", "主调度状态未知", "未观测"]) expect(html).toContain(text);
    expect(callerStatus(undefined)).toBe("主调度状态未知");
    expect(elapsed(1000, 1240)).toBe("0.24 秒");
    expect(elapsed(null, 1240)).toBeNull();
    expect(elapsed(2000, 1000)).toBe("时间顺序异常");
    const timed = renderToStaticMarkup(createElement(ExecutionDetails, { meta: { ...meta, timing: { providerCompletedAtMs: 1788928362794, artifactReadyAtMs: null, callerReceivedAtMs: null, callerCompletedAtMs: null } } }));
    expect(timed).toContain("2026");
    expect(timed).toMatch(/\d{2}:\d{2}:\d{2}\.794/);
  });

  it("honors focused URLs, keeps manual selection and never silently substitutes a missing target", () => {
    const tasks = [{ taskId: "fixture-a", running: true }, { taskId: "fixture-b", running: false }] as TaskMeta[];
    expect(selectTask(tasks, null, "?task=fixture-b&token=fixture")).toBe("fixture-b");
    expect(selectTask(tasks, "fixture-a", "?task=fixture-b")).toBe("fixture-a");
    expect(selectTask(tasks, null, "?task=missing")).toBeNull();
    expect(selectTask([], null, "?task=fixture-b")).toBeNull();
    expect(selectTask(tasks, null, "")).toBe("fixture-a");
  });
});
