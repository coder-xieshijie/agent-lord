import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { argumentsFor } from "../src/arguments.js";
import { main, COMMANDS } from "../src/cli.js";
import { main as taskStore } from "../src/task-store.js";
import { harness, operation } from "./helpers.js";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());
describe("CLI protocol", () => {
  it("preserves repeated flags and leaves optional App environment unset", () => {
    const { values } = argumentsFor(
      [
        "start",
        "--task-id",
        "task",
        "--provider",
        "codex",
        "--repo",
        "/repo",
        "--message-file",
        "/prompt",
        "--require-file",
        "a",
        "--require-file",
        "b",
        "--integration-worker",
        "w1",
        "--integration-worker",
        "w2",
        "--integration-order",
        "1",
      ],
      COMMANDS,
    );
    expect(values["require-file"]).toEqual(["a", "b"]);
    expect(values["integration-worker"]).toEqual(["w1", "w2"]);
    expect(values["integration-order"]).toBe(1);
    expect(values["codex-environment"]).toBeUndefined();
  });
  it.each(
    [
      ["check"],
      ["bad"],
      ["checkpoint", "--seconds", "NaN"],
      ["checkpoint", "--seconds", "1.5"],
      ["check", "--task-id", "x", "--wrong"],
      [
        "start",
        "--task-id",
        "x",
        "--provider",
        "unknown",
        "--message-file",
        "file",
      ],
    ].map((args) => ({ args })),
  )(
    "invalid arguments return one structured JSON error: $args",
    async ({ args }) => {
      let stdout = "";
      expect(
        await main(args, (text) => {
          stdout += text;
        }),
      ).toBe(2);
      expect(JSON.parse(stdout)).toMatchObject({
        version: 1,
        status: "ERROR",
        error: { code: "CONFIG_INVALID" },
      });
    },
  );
  it("corrupt configuration returns one JSON error", async () => {
    writeFileSync(path.join(h.base, "providers.json"), "not json");
    let out = "";
    expect(
      await main(["checkpoint", "--seconds", "1"], (text) => {
        out += text;
      }),
    ).toBe(2);
    expect(JSON.parse(out).error.code).toBe("CONFIG_INVALID");
  });
  it("quiet checkpoint exits 124 with compact output", async () => {
    let out = "";
    expect(
      await main(["checkpoint", "--seconds", "1"], (text) => {
        out += text;
      }),
    ).toBe(124);
    expect(JSON.parse(out)).toEqual({
      version: 1,
      status: "CHECKPOINT_QUIET",
      seconds: 1,
      active: [],
    });
  });
  it("CLI accepts the MCode alias and rejects App-only arguments for CLI providers", async () => {
    const prompt = path.join(h.base, "message");
    writeFileSync(prompt, "work");
    let out = "";
    expect(
      await main(
        [
          "start",
          "--task-id",
          "task",
          "--provider",
          "mcode",
          "--model",
          "test/model",
          "--target",
          h.target,
          "--message-file",
          prompt,
        ],
        (text) => {
          out += text;
        },
      ),
    ).toBe(0);
    expect(JSON.parse(out).provider).toBe("mcode-cli");
    out = "";
    expect(
      await main(
        [
          "start",
          "--task-id",
          "other",
          "--provider",
          "codex",
          "--target",
          h.target,
          "--message-file",
          prompt,
          "--codex-environment",
          "local",
        ],
        (text) => {
          out += text;
        },
      ),
    ).toBe(2);
    expect(h.calls()).toHaveLength(1);
  });
  it("task-store supports put/get/remove with MCode alias", () => {
    let out = "";
    const write = (text: string) => {
      out = text;
    };
    const fail = (text: string) => {
      throw new Error(text);
    };
    expect(
      taskStore(
        [
          "put",
          "--task-id",
          "manual",
          "--provider",
          "mcode",
          "--endpoint-id",
          "session",
          "--target",
          h.target,
          "--model",
          "test/model",
        ],
        write,
        fail,
      ),
    ).toBe(0);
    expect(JSON.parse(out).provider).toBe("mcode-cli");
    expect(taskStore(["get", "--task-id", "manual"], write, fail)).toBe(0);
    expect(JSON.parse(out).endpoint_id).toBe("session");
    expect(taskStore(["remove", "--task-id", "manual"], write, fail)).toBe(0);
    expect(h.lord.store.hasTask("manual")).toBe(false);
  });
  it("v1 handles are readable but a turn requires explicit contract upgrade", async () => {
    const now = "2026-09-01T00:00:00+00:00";
    writeFileSync(
      path.join(h.root, "legacy.json"),
      JSON.stringify({
        version: 1,
        task_id: "legacy",
        provider: "codex-app",
        endpoint_id: "thread-legacy",
        host_id: "local",
        target: "project",
        created_at: now,
      }),
    );
    expect(h.lord.store.task("legacy").legacy_version).toBe(1);
    await expect(h.lord.turn("legacy", "next")).rejects.toMatchObject({
      code: "EXECUTION_CONTRACT_REQUIRED",
    });
    let out = "";
    let err = "";
    expect(
      taskStore(
        [
          "upgrade",
          "--task-id",
          "legacy",
          "--model",
          "gpt-5.6-sol",
          "--effort",
          "high",
        ],
        (text) => {
          out = text;
        },
        (text) => {
          err = text;
        },
      ),
      err,
    ).toBe(0);
    expect(JSON.parse(out).legacy_version).toBeUndefined();
    expect((await h.lord.turn("legacy", "next")).status).toBe(
      "ACTION_REQUIRED",
    );
  });
});
