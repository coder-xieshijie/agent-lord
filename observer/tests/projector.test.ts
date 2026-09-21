import { describe, expect, it } from "vitest";
import { Timeline } from "../src/server/timeline.js";
import { McodeProjector } from "../src/server/projector/mcode.js";
import { CodexProjector } from "../src/server/projector/codex.js";
import { ClaudeProjector } from "../src/server/projector/claude.js";
import type {
  MessageItem,
  OmittedItem,
  ToolItem,
} from "../src/shared/types.js";

const j = (value: unknown): string => JSON.stringify(value);

describe("McodeProjector (fixture stream)", () => {
  it("replays preparation, execution and success without stale errors and separates timings", () => {
    const timeline = new Timeline();
    const projector = new McodeProjector(timeline, "fixture-real-lifecycle");
    for (const [status, ts] of [
      [4, 1000],
      [4, 225800],
      [5, 225803],
      [1, 225884],
      [2, 225935],
      [2, 225937],
    ]) {
      projector.handleLine(
        j({
          type: status === 2 ? "item.completed" : "item.updated",
          timestampMs: ts,
          item: {
            type: "tool_call",
            toolCall: { id: "a", name: "write", status },
          },
        }),
      );
      const tool = timeline.snapshotItems()[0] as ToolItem;
      expect(tool.errorText).toBeNull();
      expect(tool.state).toBe(status === 2 ? "completed" : "running");
    }
    const tool = timeline.snapshotItems()[0] as ToolItem;
    expect(tool.preparationMs).toBe(224884);
    expect(tool.executionMs).toBe(51);
  });
  it("clears an explicit old error when the same tool reports success", () => {
    const timeline = new Timeline();
    const projector = new McodeProjector(timeline, "fixture-error-clear");
    projector.handleLine(
      j({
        type: "item.updated",
        item: {
          type: "tool_call",
          toolCall: {
            id: "a",
            name: "write",
            status: 3,
            error: { message: "old failure" },
          },
        },
      }),
    );
    projector.handleLine(
      j({
        type: "item.completed",
        item: {
          type: "tool_call",
          toolCall: { id: "a", name: "write", status: 2 },
        },
      }),
    );
    expect(timeline.snapshotItems()[0]).toMatchObject({
      state: "completed",
      errorText: null,
    });
  });
  it("keeps unknown nonterminal statuses pending and real errors failed", () => {
    const timeline = new Timeline();
    const projector = new McodeProjector(timeline, "fixture-unknown");
    projector.handleLine(
      j({
        type: "item.updated",
        item: {
          type: "tool_call",
          toolCall: { id: "a", name: "write", status: 99 },
        },
      }),
    );
    expect(timeline.snapshotItems()[0]).toMatchObject({
      state: "running",
      phase: "unknown",
    });
    projector.handleLine(
      j({
        type: "item.completed",
        item: {
          type: "tool_call",
          toolCall: { id: "a", name: "write", status: 3 },
        },
      }),
    );
    expect(timeline.snapshotItems()[0]).toMatchObject({
      state: "error",
      phase: "failed",
    });
  });
  it("honors completed tool status on updates and closes partial output at terminal failure", () => {
    const timeline = new Timeline();
    const projector = new McodeProjector(timeline, "fixture-terminal");
    projector.handleLine(
      j({
        type: "item.started",
        item: {
          type: "tool_call",
          toolCall: {
            id: "a",
            name: "Bash",
            status: 1,
            input: { command: "printf fixture" },
          },
        },
      }),
    );
    projector.handleLine(
      j({
        type: "item.updated",
        item: { type: "tool_call", toolCall: { id: "a", status: 2 } },
      }),
    );
    expect((timeline.snapshotItems()[0] as ToolItem).state).toBe("completed");
    expect((timeline.snapshotItems()[0] as ToolItem).title).toBe(
      "printf fixture",
    );
    expect((timeline.snapshotItems()[0] as ToolItem).inputText).toContain(
      "printf fixture",
    );
    expect((timeline.snapshotItems()[0] as ToolItem).name).toBe("Bash");
    projector.handleLine(
      j({
        type: "item.started",
        item: {
          type: "tool_call",
          toolCall: { id: "b", name: "Read", status: 1 },
        },
      }),
    );
    projector.handleLine(
      j({
        type: "item.updated",
        item: { type: "agent_message", id: "m", contentDelta: "partial" },
      }),
    );
    projector.handleLine(j({ type: "turn.failed", error: "upstream ended" }));
    expect(
      timeline
        .snapshotItems()
        .some((item) => item.kind === "tool" && item.state === "running"),
    ).toBe(false);
    expect(
      (
        timeline
          .snapshotItems()
          .find((item) => item.kind === "message") as MessageItem
      ).streaming,
    ).toBe(false);
    expect(JSON.stringify(timeline.snapshotItems())).toContain(
      "未收到该工具的完成事件",
    );
  });
  it("merges deltas, finalizes messages, and folds tool lifecycle into one card", () => {
    const timeline = new Timeline();
    const projector = new McodeProjector(timeline, "fixture-op-mcode");
    const lines = [
      j({ type: "session.started", sessionId: "mvs_fixture", timestampMs: 1 }),
      j({
        type: "item.started",
        item: { id: "msg_1", type: "agent_message", contentDelta: "你好" },
      }),
      j({
        type: "item.updated",
        item: { id: "msg_1", type: "agent_message", contentDelta: "，世界" },
      }),
      j({
        type: "item.completed",
        item: { id: "msg_1", type: "agent_message", content: "你好，世界！" },
      }),
      j({
        type: "item.started",
        item: {
          id: "call_1",
          type: "tool_call",
          toolCall: {
            id: "call_1",
            name: "bash",
            status: 1,
            input: { command: "ls" },
          },
        },
      }),
      j({
        type: "item.completed",
        item: {
          id: "call_1",
          type: "tool_call",
          toolCall: {
            id: "call_1",
            name: "bash",
            status: 2,
            input: { command: "ls" },
            output: { content: [{ text: "file.txt" }] },
          },
        },
      }),
      j({ type: "item.completed", item: { id: "r1", type: "reasoning" } }),
      "not json at all",
    ];
    for (const line of lines) projector.handleLine(line);

    expect(projector.observedSessionId).toBe("mvs_fixture");
    const items = timeline.snapshotItems();
    const messages = items.filter(
      (item) => item.kind === "message",
    ) as MessageItem[];
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("你好，世界！");
    expect(messages[0].streaming).toBe(false);

    const tools = items.filter((item) => item.kind === "tool") as ToolItem[];
    expect(tools).toHaveLength(1); // started+completed folded into one card
    expect(tools[0].state).toBe("completed");
    expect(tools[0].outputText).toContain("file.txt");
    expect(tools[0].title).toBe("ls");

    const omitted = items.filter(
      (item) => item.kind === "omitted",
    ) as OmittedItem[];
    expect(omitted.some((item) => item.name.includes("reasoning"))).toBe(true);
    expect(omitted.some((item) => item.name === "non-json-line")).toBe(true);
    // Reasoning content must never leak into the timeline.
    expect(JSON.stringify(items)).not.toContain("thinking text");
  });
});

describe("CodexProjector (fixture stream)", () => {
  it("keeps the unstable-feature startup warning visible without treating it as a provider failure", () => {
    const timeline = new Timeline();
    const projector = new CodexProjector(timeline, "fixture-codex-warning");
    const message =
      "Under-development features enabled: respect_system_proxy. Under-development features are incomplete and may behave unpredictably.";
    projector.handleLine(
      j({
        type: "item.completed",
        item: { id: "warning", type: "error", message },
      }),
    );
    projector.handleLine(j({ type: "turn.completed" }));
    expect(
      timeline.snapshotItems().find((item) => item.kind === "tool"),
    ).toMatchObject({
      name: "配置警告",
      state: "warning",
      errorText: message,
    });
  });

  it("preserves unknown item errors and turn failures even when they mention the warning", () => {
    const timeline = new Timeline();
    const projector = new CodexProjector(timeline, "fixture-codex-errors");
    const message =
      "Request failed after Under-development features enabled: respect_system_proxy.";
    projector.handleLine(
      j({
        type: "item.completed",
        item: { id: "failure", type: "error", message },
      }),
    );
    projector.handleLine(
      j({
        type: "turn.failed",
        error: {
          message: "Under-development features enabled: respect_system_proxy.",
        },
      }),
    );
    const tools = timeline
      .snapshotItems()
      .filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.every((item) => item.state === "error")).toBe(true);
    expect(tools[0]).toMatchObject({
      name: "provider 错误",
      errorText: message,
    });
  });

  it("renders completed messages and command executions at real granularity", () => {
    const timeline = new Timeline();
    const projector = new CodexProjector(timeline, "fixture-op-codex");
    const lines = [
      j({ type: "thread.started", thread_id: "thread_fixture" }),
      j({ type: "turn.started" }),
      j({
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "echo hi",
          status: "in_progress",
        },
      }),
      j({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "echo hi",
          aggregated_output: "hi\n",
          exit_code: 0,
          status: "completed",
        },
      }),
      j({ type: "item.completed", item: { id: "item_1", type: "reasoning" } }),
      j({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "# 结论\n完成" },
      }),
      j({ type: "turn.completed" }),
    ];
    for (const line of lines) projector.handleLine(line);

    expect(projector.observedSessionId).toBe("thread_fixture");
    const items = timeline.snapshotItems();
    const tools = items.filter((item) => item.kind === "tool") as ToolItem[];
    expect(tools).toHaveLength(1);
    expect(tools[0].state).toBe("completed");
    expect(tools[0].outputText).toContain("hi");
    const messages = items.filter(
      (item) => item.kind === "message",
    ) as MessageItem[];
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("# 结论");
  });

  it("marks failed commands as errors with exit code", () => {
    const timeline = new Timeline();
    const projector = new CodexProjector(timeline, "fixture-op-codex2");
    projector.handleLine(
      j({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "false",
          aggregated_output: "",
          exit_code: 1,
          status: "failed",
        },
      }),
    );
    const tool = timeline.snapshotItems()[0] as ToolItem;
    expect(tool.state).toBe("error");
    expect(tool.exitCode).toBe(1);
  });
});

describe("ClaudeProjector (fixture stream)", () => {
  it("deduplicates partial stream_events against the full assistant message", () => {
    const timeline = new Timeline();
    const projector = new ClaudeProjector(timeline, "fixture-op-claude");
    const lines = [
      j({
        type: "system",
        subtype: "init",
        session_id: "sess-fixture",
        model: "claude-x",
      }),
      j({
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_abc" } },
      }),
      j({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "部分" },
        },
      }),
      j({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "secret reasoning" },
        },
      }),
      j({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "文本" },
        },
      }),
      j({ type: "stream_event", event: { type: "message_stop" } }),
      j({
        type: "assistant",
        message: {
          id: "msg_abc",
          content: [{ type: "text", text: "部分文本（完整版）" }],
        },
      }),
    ];
    for (const line of lines) projector.handleLine(line);

    expect(projector.observedSessionId).toBe("sess-fixture");
    const messages = timeline
      .snapshotItems()
      .filter((item) => item.kind === "message") as MessageItem[];
    expect(messages).toHaveLength(1); // partial + full merged by message.id
    expect(messages[0].text).toBe("部分文本（完整版）");
    expect(messages[0].streaming).toBe(false);
    expect(JSON.stringify(timeline.snapshotItems())).not.toContain(
      "secret reasoning",
    );
  });

  it("pairs tool_use with tool_result by tool_use_id and reports the final result", () => {
    const timeline = new Timeline();
    const projector = new ClaudeProjector(timeline, "fixture-op-claude2");
    const lines = [
      j({
        type: "assistant",
        message: {
          id: "msg_1",
          content: [
            { type: "thinking", thinking: "hidden" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "/tmp/x" },
            },
          ],
        },
      }),
      j({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "内容行" }],
            },
          ],
        },
      }),
      j({
        type: "result",
        is_error: false,
        duration_ms: 1234,
        result: "最终回答重复文本",
      }),
    ];
    for (const line of lines) projector.handleLine(line);

    const items = timeline.snapshotItems();
    const tools = items.filter((item) => item.kind === "tool") as ToolItem[];
    expect(tools).toHaveLength(1);
    expect(tools[0].state).toBe("completed");
    expect(tools[0].outputText).toBe("内容行");
    const finals = items.filter((item) => item.kind === "final");
    expect(finals).toHaveLength(1);
    // Success-path result text duplicates the last assistant message → omitted.
    expect((finals[0] as { summary?: string }).summary).toBeUndefined();
    expect(JSON.stringify(items)).not.toContain("hidden");
  });

  it("surfaces error results with their message", () => {
    const timeline = new Timeline();
    const projector = new ClaudeProjector(timeline, "fixture-op-claude3");
    projector.handleLine(
      j({
        type: "result",
        is_error: true,
        duration_ms: 10,
        result: "上游错误",
      }),
    );
    const final = timeline.snapshotItems()[0] as {
      ok: boolean;
      summary?: string;
    };
    expect(final.ok).toBe(false);
    expect(final.summary).toBe("上游错误");
  });
});
