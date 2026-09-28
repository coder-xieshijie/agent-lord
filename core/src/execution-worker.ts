#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AgentLord } from "./engine.js";
import { AgentLordError } from "./errors.js";
import { watchResult } from "./result-alert.js";

// Execution ownership survives the client that submits or waits for the task.
let lord: AgentLord | undefined;
let operationId: string | undefined;
try {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      "operation-id": { type: "string" },
    },
    strict: true,
  });
  if (!values["state-dir"] || !values["operation-id"])
    throw new Error("state-dir and operation-id are required");
  lord = new AgentLord(values["state-dir"]);
  await lord.executeOperation(values["operation-id"]);
  operationId = values["operation-id"];
} catch (error) {
  process.exitCode = error instanceof AgentLordError ? error.exit_code : 1;
}
// Only the worker that owned the execution stays behind to watch its result.
if (lord && operationId) {
  try {
    await watchResult(lord, operationId);
  } catch {
    /* the alert is best effort; the operation's outcome is already durable */
  }
}
