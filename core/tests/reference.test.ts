import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Data, object } from "../src/contracts.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { AgentLordError } from "../src/errors.js";
import { parseJson } from "../src/json.js";
import { evaluateClaudeAttempt } from "../src/providers/claude-result.js";
import { validateMcodeOutput } from "../src/providers/mcode-result.js";
import { operation } from "./helpers.js";
type Case = { name: string; input: Data; result?: Data; error?: Data };
function fixtures(name: string): Case[] {
  return object(
    parseJson(
      readFileSync(
        new URL(`./fixtures/${name}-reference.json`, import.meta.url),
        "utf8",
      ),
    ),
  ).cases as Case[];
}
function assertReference(test: Case, execute: () => unknown): void {
  if (test.error) {
    try {
      execute();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLordError);
      expect((error as AgentLordError).asRecord()).toEqual(test.error);
      return;
    }
    throw new Error("reference expected an error");
  }
  expect(execute()).toMatchObject(test.result!);
}
beforeAll(() => vi.stubEnv("AGENT_LORD_PROVIDER_CONFIG", DEFAULT_CONFIG));
afterAll(() => vi.unstubAllEnvs());
describe("Python main reference replay (immutable fixtures, no Python runtime)", () => {
  it.each(fixtures("claude"))("$name", (test) => {
    const a = test.input;
    assertReference(test, () =>
      evaluateClaudeAttempt(
        String(a.stdout),
        String(a.stderr),
        String(a.session_id),
        a.expected_model as string | null,
        a.return_code,
      ),
    );
  });
  it.each(fixtures("mcode"))("MCode $name", (test) => {
    const a = test.input;
    const op = operation("mcode-cli", {
      endpoint_id: a.expected_endpoint_id as string | null,
      run_id: a.expected_run_id,
      turn_id: a.expected_turn_id,
      resume: Boolean(a.resume),
      result_reset_at_ns: a.result_reset_at_ns,
      provider_return_code: a.return_code,
    });
    op.expected.model = String(a.model);
    assertReference(test, () =>
      validateMcodeOutput(
        String(a.stdout),
        String(a.stderr),
        String(a.final_text),
        a.final_mtime_ns === null ? null : BigInt(a.final_mtime_ns as bigint),
        op,
      ),
    );
  });
});
