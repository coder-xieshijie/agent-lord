import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ClarificationLedger } from "../src/clarification.js";
import { main } from "../src/cli.js";
import { writeArtifact } from "../src/artifacts.js";
import type { Data } from "../src/contracts.js";
import { harness, operation } from "./helpers.js";

let h: ReturnType<typeof harness>;
let ledger: ClarificationLedger;
beforeEach(() => {
  h = harness();
  ledger = new ClarificationLedger(h.lord);
});
afterEach(() => h.cleanup());

function result(id: string, task: string, value: unknown) {
  return h.lord.store.createOperation(
    operation(task.startsWith("a") ? "codex-cli" : "mcode-cli", {
      operation_id: id,
      task_id: task,
      status: "succeeded",
      source: { head_sha: "a".repeat(40) },
      artifact: writeArtifact(task, id, JSON.stringify(value), h.root),
    }),
  );
}
function asked(id = "Q1", parent: string | null = null) {
  return {
    id,
    parent_id: parent,
    text: "失败一半后发生什么？\n保留已完成的部分吗？",
    why: "需要写明失败行为。",
    recommendation: "建议保留已完成的部分。",
  };
}
function answered(q = "Q1", qop = "a1") {
  return {
    question_id: q,
    question_operation_id: qop,
    answer: "文档只描述了成功路径。",
    basis: "evidence",
    evidence: ["design.md@abc:42"],
    limits: "未验证运行时行为。",
  };
}
function assessed(q = "Q1", bop = "b1", next: unknown = null) {
  return {
    assessment: {
      question_id: q,
      answer_operation_id: bop,
      status: "needs_evidence",
      reason: "还缺失败后的行为定义。",
    },
    next_question: next,
  };
}
function first() {
  result("a1", "a-task", { assessment: null, next_question: asked() });
  result("b1", "b-task", answered());
  result("a2", "a-task", assessed());
  return {
    question_operation_id: "a1",
    answer_operation_id: "b1",
    assessment_operation_id: "a2",
  };
}
function replace(id: string, value: unknown) {
  h.lord.store.updateOperation(id, (op) => ({
    ...op,
    artifact: writeArtifact(op.task_id, id, JSON.stringify(value), h.root),
  }));
}
const file = () => path.join(h.root, "runs", "review", "clarification.json");

describe("clarification operation ledger", () => {
  it("records idempotently across caller restarts and renders the original text without provider calls", () => {
    const ids = first();
    const stored = ledger.record("review", ids);
    const before = readFileSync(file(), "utf8");
    expect(stored).toMatchObject({ duplicate: false, rounds: 1 });
    ledger = new ClarificationLedger(h.lord);
    expect(ledger.record("review", ids)).toMatchObject({
      duplicate: true,
      rounds: 1,
    });
    expect(readFileSync(file(), "utf8")).toBe(before);
    const rendered = ledger.render("review");
    const output = readFileSync(
      (rendered.artifact as Data).path as string,
      "utf8",
    );
    for (const original of [
      asked().text,
      asked().why,
      asked().recommendation,
      answered().answer,
      answered().limits,
      "design.md@abc:42",
      assessed().assessment.reason,
    ])
      expect(output).toContain(original);
    expect(output).toContain("Status: needs_evidence");
    expect(output).toContain('"operation_id": "b1"');
    expect(output).toContain('"head_sha": "' + "a".repeat(40));
    expect(ledger.render("review").artifact).toEqual(rendered.artifact);
    expect(h.calls()).toEqual([]);
  });

  it("reuses the assessment operation as the next question and retains replacement attribution", () => {
    const ids = first();
    replace("a2", assessed("Q1", "b1", asked("Q1.1", "Q1")));
    ledger.record("review", ids);
    result("b2", "b-replacement", answered("Q1.1", "a2"));
    result("a3", "a-replacement", assessed("Q1.1", "b2"));
    ledger.record("review", {
      question_operation_id: "a2",
      answer_operation_id: "b2",
      assessment_operation_id: "a3",
    });
    expect(JSON.parse(readFileSync(file(), "utf8")).rounds).toHaveLength(2);
    const output = readFileSync(
      (ledger.render("review").artifact as Data).path as string,
      "utf8",
    );
    expect(output.indexOf("## Q1\n")).toBeLessThan(output.indexOf("## Q1.1\n"));
    expect(output).toContain("Follow-up to: Q1");
    expect(output).toContain('"task_id": "a-replacement"');
    expect(output).toContain('"task_id": "b-replacement"');
  });

  it("does not truncate required clarification after seven primary questions", () => {
    for (let i = 1; i <= 8; i++) {
      result(`q${i}`, "a-task", {
        assessment: null,
        next_question: asked(`Q${i}`),
      });
      result(`b${i}`, "b-task", answered(`Q${i}`, `q${i}`));
      result(`a${i}`, "a-task", assessed(`Q${i}`, `b${i}`));
      ledger.record("review", {
        question_operation_id: `q${i}`,
        answer_operation_id: `b${i}`,
        assessment_operation_id: `a${i}`,
      });
    }
    expect(ledger.render("review")).toMatchObject({ rounds: 8 });
  });

  it.each(["running", "failed", "needs_decision"] as const)(
    "rejects %s output even when a final file exists",
    (status) => {
      const ids = first();
      h.lord.store.updateOperation("b1", (op) => ({ ...op, status }));
      expect(() => ledger.record("review", ids)).toThrow("has not succeeded");
      expect(existsSync(file())).toBe(false);
    },
  );

  it.each([
    "stale-question",
    "stale-answer",
    "same-role",
    "parent-order",
    "no-evidence",
    "missing-limits",
    "invalid-status",
  ])("rejects %s without advancing the ledger", (kind) => {
    const ids = first();
    if (kind === "stale-question") replace("b1", answered("Q1", "old-a"));
    if (kind === "stale-answer") replace("a2", assessed("Q1", "old-b"));
    if (kind === "same-role")
      h.lord.store.updateOperation("b1", (op) => ({
        ...op,
        task_id: "a-task",
        artifact: writeArtifact(
          "a-task",
          "b1",
          JSON.stringify(answered()),
          h.root,
        ),
      }));
    if (kind === "parent-order")
      replace("a1", { assessment: null, next_question: asked("Q1", "Q0") });
    if (kind === "no-evidence") replace("b1", { ...answered(), evidence: [] });
    if (kind === "missing-limits") replace("b1", { ...answered(), limits: "" });
    if (kind === "invalid-status")
      replace("a2", {
        ...assessed(),
        assessment: { ...assessed().assessment, status: "probably" },
      });
    expect(() => ledger.record("review", ids)).toThrow();
    expect(existsSync(file())).toBe(false);
  });

  it("refuses a conflicting answer to an already recorded question", () => {
    const ids = first();
    ledger.record("review", ids);
    const before = readFileSync(file(), "utf8");
    result("b2", "b-task", answered());
    result("a3", "a-task", assessed("Q1", "b2"));
    expect(() =>
      ledger.record("review", {
        ...ids,
        answer_operation_id: "b2",
        assessment_operation_id: "a3",
      }),
    ).toThrow("already recorded");
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("revalidates canonical artifact digests on duplicate recording and rendering", () => {
    const ids = first();
    ledger.record("review", ids);
    writeFileSync(h.lord.store.operation("b1").artifact!.path, "tampered");
    expect(() => ledger.record("review", ids)).toThrow(
      "canonical final response",
    );
    expect(() => ledger.render("review")).toThrow("canonical final response");
    expect(
      existsSync(
        path.join(h.root, "runs", "review", "questions-and-answers.md"),
      ),
    ).toBe(false);
  });

  it("rejects corrupt persisted state and malformed final JSON", () => {
    const ids = first();
    ledger.record("review", ids);
    writeFileSync(file(), "{}");
    expect(() => ledger.render("review")).toThrow("invalid shape");
    h.lord.store.updateOperation("b1", (op) => ({
      ...op,
      artifact: writeArtifact("b-task", "b1", "```json\n{}\n```", h.root),
    }));
    expect(() => ledger.record("other", ids)).toThrow("one final JSON object");
  });

  it("pins accepted content even if a later auxiliary export republishes the operation artifact", () => {
    const ids = first();
    ledger.record("review", ids);
    replace("b1", { ...answered(), answer: "A different answer" });
    expect(() => ledger.record("review", ids)).toThrow("changed after");
    expect(() => ledger.render("review")).toThrow("changed after");
  });

  it("rejects empty runs and traversal IDs", () => {
    expect(() => ledger.render("empty")).toThrow("no clarification rounds");
    expect(() => ledger.render("../escape")).toThrow("run_id must start");
  });

  it("exposes both CLI commands and preserves structured input errors", async () => {
    first();
    const call = async (args: string[]) => {
      let out = "";
      const code = await main(args, (text) => {
        out += text;
      });
      return { code, body: JSON.parse(out) };
    };
    expect(
      await call([
        "clarification-record",
        "--run-id",
        "review",
        "--question-operation-id",
        "a1",
        "--answer-operation-id",
        "b1",
        "--assessment-operation-id",
        "a2",
      ]),
    ).toMatchObject({
      code: 0,
      body: { status: "CLARIFICATION_RECORDED", rounds: 1 },
    });
    expect(
      await call(["clarification-render", "--run-id", "review"]),
    ).toMatchObject({
      code: 0,
      body: { status: "CLARIFICATION_RENDERED", rounds: 1 },
    });
    expect(
      await call(["clarification-record", "--run-id", "review"]),
    ).toMatchObject({
      code: 2,
      body: { status: "ERROR", error: { code: "CONFIG_INVALID" } },
    });
    expect(h.calls()).toEqual([]);
  });
});
