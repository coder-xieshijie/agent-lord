// Round-trip validation between the published JSON schemas in schemas/ and
// the objects the runtime actually produces. The schemas are documentation
// for external callers; this suite keeps them from drifting away from the
// live envelope, record, and packet shapes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { harness, packet } from "./helpers.js";
import { RequestInbox } from "../src/requests.js";
import { AgentLordError } from "../src/errors.js";
import { type Data, type Envelope } from "../src/contracts.js";
import { stringifyJson } from "../src/json.js";
import { operationMarker } from "../src/providers/codex-app.js";

const schemasDir = fileURLToPath(new URL("../../schemas/", import.meta.url));
// The if/then branches in result-v1 require properties that the parent
// schema defines, which strictRequired cannot see; keep the rest of strict
// mode active.
const schemaFiles = () =>
  readdirSync(schemasDir).filter((file) => file.endsWith(".schema.json"));
const ajv = new Ajv2020({ allErrors: true, strictRequired: false });
for (const file of schemaFiles()) {
  ajv.addSchema(JSON.parse(readFileSync(path.join(schemasDir, file), "utf8")));
}

function validator(name: string): ValidateFunction {
  const compiled = ajv.getSchema(
    `https://agent-lord.local/schemas/${name}.schema.json`,
  );
  if (!compiled) throw new Error(`schema ${name} did not compile`);
  return compiled;
}

function check(name: string, value: unknown): void {
  const compiled = validator(name);
  // The schemas document the serialized JSON that external callers read
  // (CLI stdout, on-disk records), so validate the wire form: stringifyJson
  // writes bigint timestamps as plain integer tokens.
  const wire: unknown = JSON.parse(stringifyJson(value));
  const valid = compiled(wire);
  const errors = JSON.stringify(compiled.errors, null, 1);
  expect(valid, `${name} rejected a live object: ${errors}`).toBe(true);
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const actionId = (result: Envelope) => String(result.action!.action_id);

describe("published schema round-trip", () => {
  it("every schema in schemas/ compiles under draft 2020-12", () => {
    for (const file of schemaFiles()) {
      const name = file.replace(/\.schema\.json$/, "");
      expect(validator(name)).toBeTypeOf("function");
    }
  });

  it("local CLI envelopes and persisted records match their schemas", async () => {
    const first = await h.lord.start("task", "mcode", h.target, "first", {
      model: "test/model#deep",
    });
    expect(first.status).toBe("SUCCEEDED");
    check("result-v1", first);
    const second = await h.lord.turn("task", "second");
    expect(second.status).toBe("SUCCEEDED");
    check("result-v1", second);
    check("result-v1", h.lord.check("task"));
    check("task-v2", h.lord.store.task("task"));
    check("operation-v1", h.lord.store.operation(second.operation_id!));
  });

  it("an ERROR envelope and its failed operation record match their schemas", async () => {
    h.options({ status: "failed" });
    // The engine raises on failure; the CLI surface serializes exactly this
    // public ERROR envelope from the raised error record.
    const raised = await h.lord
      .start("bad", "mcode", h.target, "first", { model: "test/model#deep" })
      .then(() => null)
      .catch((error: AgentLordError) => error);
    expect(raised).toBeInstanceOf(AgentLordError);
    check("result-v1", {
      version: 1,
      status: raised!.requires_authorization ? "NEEDS_DECISION" : "ERROR",
      error: raised!.asRecord(),
    });
    const failed = h.lord.store.operations("bad").at(-1)!;
    expect(failed.status).toBe("failed");
    check("operation-v1", failed);
  });

  it("checkpoint envelopes match the result schema", async () => {
    await h.lord.start("task", "mcode", h.target, "first", {
      model: "test/model#deep",
    });
    const [quiet] = await h.lord.checkpoint(["task"], 1);
    expect(["CHECKPOINT_QUIET", "CHECKPOINT_ACTIONABLE"]).toContain(
      quiet.status,
    );
    check("result-v1", quiet);
  });

  it("codex-app action envelopes match the result and action schemas", async () => {
    const start = await h.lord.start("app", "codex-app", "project", "first");
    expect(start.status).toBe("ACTION_REQUIRED");
    check("result-v1", start);
    check("action-v1", h.lord.store.action(actionId(start)));
    const accepted = h.lord.accept(
      actionId(start),
      { threadId: "thread-app", hostId: "host" },
      true,
    );
    check("result-v1", accepted);
    check("action-v1", h.lord.store.action(actionId(accepted)));
    const final = h.lord.accept(actionId(accepted), {
      turns: [
        {
          items: [
            {
              role: "user",
              content: [
                { type: "text", text: operationMarker(start.operation_id!) },
              ],
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "final report" }],
            },
          ],
        },
      ],
    });
    expect(final.status).toBe("SUCCEEDED");
    check("result-v1", final);
  });

  it("request inbox records match the request schema", () => {
    const registered = new RequestInbox(h.lord).register({
      request_id: "req-1",
      intent: "start",
      task_id: "later",
      message: "do the deferred work",
      user_request: "after the current task, do the deferred work",
      provider: "mcode-cli",
      target: h.target,
      options: { model: "test/model" },
    });
    check("result-v1", registered);
    check("request-v1", registered.request);
    check("request-v1", h.lord.store.requestRecord("req-1"));
  });

  it("a handoff packet accepted by the runtime matches the handoff schema", async () => {
    const seed = await h.lord.start("orig", "mcode", h.target, "first", {
      model: "test/model#deep",
    });
    expect(seed.status).toBe("SUCCEEDED");
    const body = packet("continued");
    check("handoff-v1", body);
    const file = path.join(h.base, "packet.json");
    writeFileSync(file, JSON.stringify(body));
    const validated = await h.lord.handoff("continued", file, {
      provider: "mcode-cli",
      target: h.target,
      model: "test/model#deep",
      validate_only: true,
    });
    expect(validated.error ?? null).toBeNull();
  });

  it("an implementation plan the runtime accepts matches the plan schema", () => {
    const moduleNode = (id: string, repo: string): Data => ({
      module_id: id,
      repository: repo,
      responsibility: `implement the ${id} subsystem`,
      acceptance: [`${id} behaves as specified`],
      depends_on: id === "beta" ? ["alpha"] : [],
      owned_paths: [`src/${id}`],
      verification: ["pnpm test"],
    });
    const repo = h.target;
    check("implementation-plan-v1", {
      version: 1,
      plan_id: "demo",
      goal: "deliver the feature across modules",
      repositories: [
        {
          repository: repo,
          source_branch: "main",
          head_sha: "1e71141af8c836c5f9594536bf63cd6502d819bf",
          delivery_branch: "feature/delivery",
        },
      ],
      modules: [moduleNode("alpha", repo), moduleNode("beta", repo)],
    });
  });
});
