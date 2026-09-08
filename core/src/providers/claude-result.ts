import { type Data, object, string } from "../contracts.js";
import {
  expectedModelMatches,
  modelReference,
  sameModelIdentity,
} from "../config.js";
import { AgentLordError } from "../errors.js";
import { jsonObjects } from "../artifacts.js";
import { parseJson } from "../json.js";
export interface ClaudeEvaluation {
  result: Data;
  main_model: string;
  main_model_verified: true;
  main_model_evidence: string[];
  auxiliary_models: Data[];
  warnings: Data[];
}
export function lastResult(text: string): Data {
  const result = jsonObjects(text)
    .filter((v) => v.type === "result")
    .at(-1);
  if (!result)
    throw new AgentLordError(
      "RESULT_INVALID",
      "Claude output contains no result object",
    );
  return result;
}
export function evaluateClaudeAttempt(
  stdout: string,
  stderr: string,
  session: string,
  expectedModel: string | null,
  returnCode: unknown,
): ClaudeEvaluation {
  const diagnostics = `${stdout}\n${stderr}`.split(/\r?\n/).flatMap((line) => {
    const match = /^\[claude-code:([a-z0-9_]+)\]\s+(\{.*\})$/.exec(line.trim());
    if (!match) return [];
    try {
      const payload = object(parseJson(match[2]));
      return [
        {
          code: match[1],
          model: String(payload.model || ""),
          source: String(payload.query_source || "unknown"),
        },
      ];
    } catch {
      return [];
    }
  });
  const retry = (code: string, message: string, details: Data = {}) =>
    new AgentLordError(code, message, {
      retryable: true,
      safe_recovery: "RETRY_SAME_ENDPOINT_WITH_SAVED_EXECUTION_CONTRACT",
      details,
    });
  const mainError = diagnostics
    .filter((v) => v.code === "unrecognized_model" && v.source !== "auto_mode")
    .at(-1);
  if (mainError)
    throw retry(
      "MODEL_UNRECOGNIZED",
      "Claude provider did not recognize the requested main model",
      { model: mainError.model, query_source: mainError.source },
    );
  if (returnCode != null && returnCode !== 0)
    throw new AgentLordError(
      "PROVIDER_FAILED",
      "Claude CLI exited unsuccessfully",
      {
        retryable: true,
        safe_recovery: "RETRY_SAME_ENDPOINT",
        details: { return_code: returnCode },
      },
    );
  const events = jsonObjects(stdout);
  const result = events.filter((v) => v.type === "result").at(-1);
  if (!result)
    throw new AgentLordError(
      "RESULT_INVALID",
      "Claude output contains no result object",
    );
  if (result.session_id !== session)
    throw new AgentLordError(
      "ENDPOINT_MISMATCH",
      "Claude result belongs to a different session",
      { details: { expected: session, observed: result.session_id } },
    );
  if (result.is_error !== false)
    throw new AgentLordError(
      "PROVIDER_FAILED",
      "Claude returned an error result",
      {
        retryable: true,
        safe_recovery: "RETRY_SAME_ENDPOINT",
        details: { subtype: result.subtype },
      },
    );
  const authoritative: [string, string][] = [];
  for (const event of events) {
    if (event.session_id !== session) continue;
    if (
      event.type === "system" &&
      event.subtype === "init" &&
      string(event.model)
    )
      authoritative.push(["system.init.model", event.model as string]);
    else if (event.type === "assistant" && string(object(event.message).model))
      authoritative.push([
        "assistant.message.model",
        object(event.message).model as string,
      ]);
  }
  if (string(result.model))
    authoritative.push(["result.model", result.model as string]);
  const models = [...new Set(authoritative.map(([, v]) => v))];
  const evidence = [...new Set(authoritative.map(([v]) => v))];
  const usage = object(result.modelUsage);
  const usageModels = Object.keys(usage).filter(Boolean);
  let main: string;
  if (
    models.length &&
    models.slice(1).some((v) => !sameModelIdentity(models[0], v))
  )
    throw retry(
      "MODEL_MISMATCH",
      "Claude main-model metadata is internally inconsistent",
      { expected: expectedModel, observed: models },
    );
  if (models.length) {
    main = models[0];
    if (usageModels.length) evidence.push("result.modelUsage");
  } else if (usageModels.length) {
    main = usageModels[0];
    evidence.push("result.modelUsage");
    if (usageModels.slice(1).some((v) => !sameModelIdentity(main, v)))
      throw retry(
        "MODEL_UNVERIFIED",
        "Claude result exposed multiple models without authoritative main-model metadata",
        { expected: expectedModel, observed: usageModels },
      );
  } else
    throw retry(
      "MODEL_UNVERIFIED",
      "Claude result did not expose observable main-model metadata",
      { expected: expectedModel },
    );
  if (expectedModel && !expectedModelMatches(expectedModel, main))
    throw retry(
      "MODEL_MISMATCH",
      "Claude used a main model outside the saved execution contract",
      { expected: expectedModel, observed: [main] },
    );
  const unrelated = usageModels.filter((v) => !sameModelIdentity(main, v));
  if (unrelated.length)
    throw retry(
      "MODEL_MISMATCH",
      "Claude model-usage metadata does not belong to the verified main model",
      { expected: expectedModel, observed: unrelated },
    );
  const contexts: [string, number][] = [];
  for (const [source, model] of authoritative) {
    const size = modelReference(model)[1];
    if (size !== null) contexts.push([`${source}.context`, size]);
  }
  for (const [model, value] of Object.entries(usage)) {
    const size = modelReference(model)[1];
    if (size !== null) contexts.push(["result.modelUsage.model.context", size]);
    const record = object(value);
    const canonical = string(record.canonicalModel);
    if (canonical && !sameModelIdentity(main, canonical))
      throw retry(
        "MODEL_MISMATCH",
        "Claude canonical model metadata does not belong to the verified main model",
        { expected: expectedModel, observed: [canonical] },
      );
    if (
      typeof record.contextWindow === "number" &&
      Number.isSafeInteger(record.contextWindow) &&
      record.contextWindow > 0
    )
      contexts.push(["result.modelUsage.contextWindow", record.contextWindow]);
  }
  const windows = [...new Set(contexts.map(([, size]) => size))].sort(
    (a, b) => a - b,
  );
  if (windows.length > 1)
    throw retry(
      "MODEL_MISMATCH",
      "Claude context-capability metadata is internally inconsistent",
      { expected: expectedModel, observed_context_windows: windows },
    );
  const expectedContext = expectedModel
    ? modelReference(expectedModel)[1]
    : null;
  if (expectedContext !== null) {
    if (!windows.length)
      throw retry(
        "MODEL_UNVERIFIED",
        "Claude did not expose evidence for the requested context capability",
        { expected: expectedModel, expected_context_window: expectedContext },
      );
    if (!windows.includes(expectedContext))
      throw retry(
        "MODEL_MISMATCH",
        "Claude used a different context capability than the saved execution contract",
        {
          expected: expectedModel,
          expected_context_window: expectedContext,
          observed_context_windows: windows,
        },
      );
    evidence.push(
      ...contexts
        .filter(([, size]) => size === expectedContext)
        .map(([source]) => source),
    );
  }
  const auxiliary = diagnostics
    .filter((v) => v.source === "auto_mode")
    .map((v) => ({ ...v, status: "failed" }));
  const warnings = auxiliary
    .filter((v) => v.code === "unrecognized_model")
    .map((v) => ({
      code: "AUXILIARY_MODEL_UNRECOGNIZED",
      source: v.source,
      model: v.model,
    }));
  return {
    result,
    main_model: main,
    main_model_verified: true,
    main_model_evidence: [...new Set(evidence)],
    auxiliary_models: auxiliary,
    warnings,
  };
}
