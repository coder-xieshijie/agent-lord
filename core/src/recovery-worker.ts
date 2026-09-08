#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AgentLord } from "./engine.js";
import { AgentLordError } from "./errors.js";
// Private worker: the journal and controller lease contain the recovery authority.
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
  await new AgentLord(values["state-dir"]).recoverClaudeOperation(
    values["operation-id"],
  );
} catch (error) {
  process.exitCode = error instanceof AgentLordError ? error.exit_code : 1;
}
