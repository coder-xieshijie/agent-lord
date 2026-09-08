// Standalone, erasable TypeScript: fake CLIs use Node's built-in TS support.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1];
const options = JSON.parse(readFileSync(process.env.FAKE_OPTIONS!, "utf8"));
const log = process.env.FAKE_LOG!;
const number = existsSync(log)
  ? readFileSync(log, "utf8").trim().split("\n").length + 1
  : 1;
const prompt = readFileSync(0, "utf8");
appendFileSync(
  log,
  JSON.stringify({
    args,
    prompt,
    pid: process.pid,
    number,
    cwd: process.cwd(),
    provider: process.env.FAKE_PROVIDER,
    route: process.env.ANTHROPIC_BASE_URL,
  }) + "\n",
);
const emit = (value: unknown) => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
const provider = process.env.FAKE_PROVIDER;
const model = flag("--model");
if (provider === "claude-cli") {
  const session = options.wrongSession
    ? "other-session"
    : flag(args.includes("--resume") ? "--resume" : "--session-id");
  if (!options.silent)
    emit({
      type: "system",
      subtype: "init",
      session_id: session,
      model: options.wrongModel || model,
    });
  if (options.auxiliaryWarning)
    process.stderr.write(
      '[claude-code:unrecognized_model] {"model":"auxiliary-model","query_source":"auto_mode"}\n',
    );
  if (options.toolWait)
    emit({
      type: "assistant",
      session_id: session,
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
  if (options.delayMs && (!options.delayFirstOnly || number === 1))
    await sleep(options.delayMs);
  const failed = options.failAll || number <= (options.failAttempts ?? 0);
  if (!(options.silent && failed) && !options.missingTerminal)
    emit({
      type: "result",
      subtype: failed ? "error_during_execution" : "success",
      is_error: !!failed,
      session_id: session,
      model: options.wrongModel || model,
      result: options.output ?? "claude final",
      modelUsage: { [options.wrongModel || model]: {} },
    });
  process.exitCode = failed ? 1 : 0;
} else if (provider === "codex-cli") {
  const session = options.wrongSession
    ? "other-session"
    : args.includes("resume")
      ? args.at(-2)
      : "codex-session";
  emit({ type: "thread.started", thread_id: session });
  if (options.delayMs) await sleep(options.delayMs);
  if (options.failAll) {
    emit({ type: "turn.failed", error: { message: "test failure" } });
    process.exitCode = 1;
  } else if (!options.missingTerminal) {
    writeFileSync(
      flag("--output-last-message"),
      options.final ?? options.output ?? "codex final",
    );
    emit({ type: "turn.completed", usage: {} });
  }
} else {
  const [providerId, part] = model.split("/");
  const [modelId, variant] = part.split("#");
  const metadata = {
    providerId,
    modelId: options.wrongModel ?? modelId,
    ...((options.variant ?? variant)
      ? { variant: options.variant ?? variant }
      : {}),
  };
  const session = args.includes("--session")
    ? flag("--session")
    : "mcode-session";
  const identity = {
    runId: `run-${process.pid}`,
    sessionId: session,
    turnId: `turn-${process.pid}`,
  };
  let sequence = 0;
  const event = (type: string, values: object = {}) =>
    emit({
      schemaVersion: 1,
      sequence: ++sequence,
      timestampMs: Date.now(),
      ...identity,
      type,
      ...values,
    });
  event("exec.started");
  event(args.includes("--session") ? "session.resumed" : "session.started");
  event("turn.started");
  if (options.toolWait)
    event("item.started", {
      item: {
        id: "tool-1",
        type: "tool_call",
        toolCall: { id: "tool-1", name: "Bash", status: 1 },
      },
    });
  if (options.delayMs) await sleep(options.delayMs);
  if (options.crossIdentity) {
    event("item.completed", { sessionId: "wrong-session", item: {} });
  } else if (!options.missingTerminal) {
    if (options.toolWait)
      event("item.completed", {
        item: {
          id: "tool-1",
          type: "tool_call",
          toolCall: { id: "tool-1", name: "Bash", status: 2 },
        },
      });
    const status = options.status ?? "succeeded";
    const output = options.output ?? "mcode final";
    const result = {
      schemaVersion: 1,
      type: "exec.result",
      ...identity,
      status,
      ...(options.noModel ? {} : { model: metadata }),
      durationMs: 1,
    } as Record<string, unknown>;
    if (status === "succeeded") {
      result.output = output;
      writeFileSync(
        flag("--output-last-message"),
        options.final ??
          (typeof output === "string" ? output : JSON.stringify(output)),
      );
      event("turn.completed", { model: metadata, durationMs: 1 });
    } else {
      result.error = {
        category: options.category ?? "runtime",
        code: "TEST",
        message: "test failure",
        retryable: options.retryable === true,
      };
      event("turn.failed", { status, error: result.error, durationMs: 1 });
    }
    event("exec.completed", { result });
    if (options.duplicateTerminal) event("exec.completed", { result });
    process.exitCode = options.exitCode ?? (status === "succeeded" ? 0 : 4);
  }
}
