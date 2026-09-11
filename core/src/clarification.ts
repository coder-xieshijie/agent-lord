import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentLord } from "./engine.js";
import { type Envelope, isObject } from "./contracts.js";
import { AgentLordError, usageError } from "./errors.js";
import { parseJson, sha256, stringifyJson } from "./json.js";
import {
  atomicWrite,
  readJson,
  validateIdentifier,
  withLock,
  writeJson,
} from "./state.js";

type Round = {
  question_operation_id: string;
  answer_operation_id: string;
  assessment_operation_id: string;
};
type RecordedRound = { operations: Round; hashes: string[] };
type Question = {
  id: string;
  parent_id: string | null;
  text: string;
  why: string;
  recommendation?: string;
};
type Answer = {
  question_id: string;
  question_operation_id: string;
  answer: string;
  basis: "evidence" | "recommendation" | "unknown";
  evidence: string[];
  limits: string;
};
type Assessment = {
  question_id: string;
  answer_operation_id: string;
  status: "resolved" | "needs_evidence" | "needs_user" | "needs_validation";
  reason: string;
};
type Exchange = {
  ids: Round;
  hashes: string[];
  question: Question;
  answer: Answer;
  assessment: Assessment;
};

function invalid(message: string): never {
  throw new AgentLordError("CLARIFICATION_INVALID", message, { exit_code: 2 });
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    return invalid(`${name} must be non-empty text`);
  return value;
}
function question(value: unknown): Question {
  if (!isObject(value)) return invalid("next_question must be an object");
  return {
    id: validateIdentifier("question_id", value.id),
    parent_id:
      value.parent_id === null
        ? null
        : validateIdentifier("parent_id", value.parent_id),
    text: text(value.text, "question.text"),
    why: text(value.why, "question.why"),
    ...(value.recommendation === undefined
      ? {}
      : { recommendation: text(value.recommendation, "recommendation") }),
  };
}

/** An operation-reference ledger, not a scheduler or semantic completion gate. */
export class ClarificationLedger {
  constructor(private readonly lord: AgentLord) {}

  private files(runId: string) {
    validateIdentifier("run_id", runId);
    const directory = path.join(this.lord.root, "runs", runId);
    return {
      ledger: path.join(directory, "clarification.json"),
      markdown: path.join(directory, "questions-and-answers.md"),
    };
  }

  private response(operationId: string) {
    const op = this.lord.store.operation(
      validateIdentifier("operation_id", operationId),
    );
    if (op.operation_id !== operationId)
      return invalid("operation identity does not match its filename");
    if (op.status !== "succeeded")
      return invalid(`operation ${operationId} has not succeeded`);
    // Reuse canonical path, operation binding, UTF-8 and digest verification.
    // Reading a recorded response must never poll, recover or call a provider.
    const envelope = this.lord.withResponse({
      version: 1,
      status: "SUCCEEDED",
      task_id: op.task_id,
      operation_id: operationId,
    });
    let value: unknown;
    try {
      value = parseJson(envelope.response!.text);
    } catch {
      return invalid(
        `operation ${operationId} must return one final JSON object`,
      );
    }
    if (!isObject(value))
      return invalid(`operation ${operationId} must return an object`);
    return { op, value };
  }

  private exchange(ids: Round): Exchange {
    if (new Set(Object.values(ids)).size !== 3)
      return invalid(
        "question, answer and assessment must be distinct operations",
      );
    const q = this.response(ids.question_operation_id);
    const b = this.response(ids.answer_operation_id);
    const a = this.response(ids.assessment_operation_id);
    if (b.op.task_id === q.op.task_id || b.op.task_id === a.op.task_id)
      return invalid("the respondent must be distinct from the questioner");
    const asked = question(q.value.next_question);
    const answer = b.value;
    const assessment = a.value.assessment;
    if (
      answer.question_id !== asked.id ||
      answer.question_operation_id !== ids.question_operation_id
    )
      return invalid("answer is not bound to this question operation");
    if (
      !isObject(assessment) ||
      assessment.question_id !== asked.id ||
      assessment.answer_operation_id !== ids.answer_operation_id
    )
      return invalid("assessment is not bound to this answer operation");
    if (
      !["evidence", "recommendation", "unknown"].includes(String(answer.basis))
    )
      return invalid("answer.basis is invalid");
    if (
      !Array.isArray(answer.evidence) ||
      !answer.evidence.every((v) => typeof v === "string" && v.trim())
    )
      return invalid("answer.evidence must be a text array");
    if (answer.basis === "evidence" && !answer.evidence.length)
      return invalid("an evidence-based answer must cite evidence");
    if (
      ![
        "resolved",
        "needs_evidence",
        "needs_user",
        "needs_validation",
      ].includes(String(assessment.status))
    )
      return invalid("assessment.status is invalid");
    if (a.value.next_question !== null) question(a.value.next_question);
    return {
      ids,
      hashes: [
        q.op.artifact!.sha256,
        b.op.artifact!.sha256,
        a.op.artifact!.sha256,
      ],
      question: asked,
      answer: {
        question_id: asked.id,
        question_operation_id: ids.question_operation_id,
        answer: text(answer.answer, "answer.answer"),
        basis: answer.basis as Answer["basis"],
        evidence: answer.evidence as string[],
        limits: text(answer.limits, "answer.limits"),
      },
      assessment: {
        question_id: asked.id,
        answer_operation_id: ids.answer_operation_id,
        status: assessment.status as Assessment["status"],
        reason: text(assessment.reason, "assessment.reason"),
      },
    };
  }

  private read(runId: string): RecordedRound[] {
    const file = this.files(runId).ledger;
    if (!existsSync(file)) return [];
    const data = readJson(
      file,
      "CLARIFICATION_UNKNOWN",
      "clarification ledger is missing",
    );
    if (
      data.version !== 1 ||
      data.run_id !== runId ||
      !Array.isArray(data.rounds)
    )
      return invalid("clarification ledger has an invalid shape");
    return data.rounds.map((value: unknown) => {
      if (
        !isObject(value) ||
        !isObject(value.operations) ||
        Object.keys(value.operations).length !== 3 ||
        !Array.isArray(value.hashes) ||
        value.hashes.length !== 3 ||
        !value.hashes.every(
          (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
        )
      )
        return invalid("clarification round has an invalid shape");
      return {
        hashes: value.hashes as string[],
        operations: {
          question_operation_id: validateIdentifier(
            "question_operation_id",
            value.operations.question_operation_id,
          ),
          answer_operation_id: validateIdentifier(
            "answer_operation_id",
            value.operations.answer_operation_id,
          ),
          assessment_operation_id: validateIdentifier(
            "assessment_operation_id",
            value.operations.assessment_operation_id,
          ),
        },
      };
    });
  }

  private validate(rounds: RecordedRound[]): Exchange[] {
    const exchanges = rounds.map((row) => {
      const exchange = this.exchange(row.operations);
      if (stringifyJson(exchange.hashes) !== stringifyJson(row.hashes))
        return invalid(
          "a canonical artifact changed after this exchange was recorded",
        );
      return exchange;
    });
    const questions = new Set<string>();
    const answers = new Set<string>();
    const assessments = new Set<string>();
    for (const entry of exchanges) {
      const { question: q, ids } = entry;
      if (
        questions.has(q.id) ||
        answers.has(ids.answer_operation_id) ||
        assessments.has(ids.assessment_operation_id)
      )
        return invalid(
          "a question, answer or assessment was already recorded; use a new id for a follow-up",
        );
      if (q.parent_id !== null && !questions.has(q.parent_id))
        return invalid(
          `parent question ${q.parent_id} must already be recorded`,
        );
      questions.add(q.id);
      answers.add(ids.answer_operation_id);
      assessments.add(ids.assessment_operation_id);
    }
    return exchanges;
  }

  record(runId: string, ids: Round): Envelope {
    const files = this.files(runId);
    return withLock("clarification", runId, this.lord.root, () => {
      const rounds = this.read(runId);
      const duplicate = rounds.some(
        (row) => stringifyJson(row.operations) === stringifyJson(ids),
      );
      if (!duplicate)
        rounds.push({ operations: ids, hashes: this.exchange(ids).hashes });
      this.validate(rounds);
      if (!duplicate)
        writeJson(files.ledger, { version: 1, run_id: runId, rounds });
      return {
        version: 1,
        status: "CLARIFICATION_RECORDED",
        run_id: runId,
        duplicate,
        rounds: rounds.length,
        ledger: files.ledger,
      };
    });
  }

  render(runId: string): Envelope {
    const files = this.files(runId);
    return withLock("clarification", runId, this.lord.root, () => {
      const rounds = this.read(runId);
      if (!rounds.length)
        throw usageError("no clarification rounds have been recorded");
      const exchanges = this.validate(rounds);
      const lines = [
        "# Questions and answers",
        "",
        `Run: ${runId}`,
        "",
        "This is the recorded exchange history. Assessments describe each round at that time; the caller's coverage ledger determines current completion. Model agreement does not establish runtime verification.",
        "",
      ];
      for (const { ids, question: q, answer: b, assessment: a } of exchanges) {
        lines.push(`## ${q.id}`, "");
        if (q.parent_id) lines.push(`Follow-up to: ${q.parent_id}`, "");
        lines.push(
          "### Question",
          "",
          q.text,
          "",
          "### Why it matters",
          "",
          q.why,
          "",
          "### Answer",
          "",
          b.answer,
          "",
          `Basis: ${b.basis}`,
          "",
          "### Evidence",
          "",
          ...b.evidence.flatMap((item) => [item, ""]),
          "### Limits",
          "",
          b.limits,
          "",
          "### Assessment at this round",
          "",
          `Status: ${a.status}`,
          "",
          a.reason,
          "",
        );
        if (q.recommendation)
          lines.push(
            "### Questioner's recommendation",
            "",
            q.recommendation,
            "",
          );
        lines.push("### Operation provenance", "");
        for (const [role, id] of Object.entries(ids)) {
          const op = this.lord.store.operation(id);
          // Only existing sanitized contracts/metadata, never raw logs or reasoning.
          lines.push(
            "```json",
            stringifyJson(
              {
                role,
                operation_id: id,
                task_id: op.task_id,
                provider: op.provider,
                source: op.source,
                expected_model: op.expected.model,
                expected_effort: op.expected.effort,
                observed_models: op.observed.models ?? [],
                artifact_sha256: op.artifact!.sha256,
              },
              2,
            ),
            "```",
            "",
          );
        }
      }
      const content = lines.join("\n");
      atomicWrite(files.markdown, content);
      return {
        version: 1,
        status: "CLARIFICATION_RENDERED",
        run_id: runId,
        rounds: rounds.length,
        artifact: {
          path: files.markdown,
          bytes: Buffer.byteLength(content),
          sha256: sha256(content),
        },
      };
    });
  }
}
