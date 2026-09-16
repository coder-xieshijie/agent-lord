import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { harness, waitFor } from "./helpers.js";
import { AgentLord } from "../src/engine.js";
import { pidAlive } from "../src/process.js";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

describe("detached execution controller", () => {
  it.each(["mcode-cli", "claude-cli", "codex-cli"])(
    "%s completes after its CLI client exits",
    async (provider) => {
      const release = path.join(h.base, "release");
      h.options({ releaseFile: release, output: "durable final" });
      const prompt = path.join(h.base, "prompt.txt");
      writeFileSync(prompt, "work");
      const client = h.controller([
        "start",
        "--task-id",
        "task",
        "--provider",
        provider,
        "--target",
        h.target,
        "--message-file",
        prompt,
      ]);
      let output = "";
      let closed = false;
      client.once("close", () => {
        closed = true;
      });
      client.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      await waitFor(() => closed);
      expect(client.exitCode).toBe(0);
      const ack = JSON.parse(output);
      expect(ack.status).toBe("RUNNING");
      const op = h.lord.store.operations("task")[0];
      expect(op.controller_pid).not.toBe(client.pid);
      expect(pidAlive(op.execution_worker_pid)).toBe(true);
      writeFileSync(release, "client exited; provider may finish");
      await waitFor(
        () => h.lord.store.operations("task")[0]?.status === "succeeded",
      );
      expect(
        h.lord.withResponse(h.lord.check("task")).response?.text,
      ).toContain("durable final");
      expect(h.calls()).toHaveLength(1);
    },
    15000,
  );
  it("repeated submissions cannot start a second worker or provider", async () => {
    const release = path.join(h.base, "release");
    h.options({ releaseFile: release });
    const lord = new AgentLord(h.root, true);
    const first = await lord.start("task", "mcode", h.target, "work", {
      model: "test/model",
    });
    const second = await lord.start("task", "mcode", h.target, "work", {
      model: "test/model",
    });
    expect(first.operation_id).toBe(second.operation_id);
    writeFileSync(release, "both submissions acknowledged");
    await waitFor(
      () => h.lord.store.operations("task")[0]?.status === "succeeded",
    );
    expect(h.calls()).toHaveLength(1);
    await waitFor(
      () => !pidAlive(h.lord.store.operations("task")[0].execution_worker_pid),
    );
    const turn = await lord.turn("task", "finish remaining checks");
    expect(turn.status).toBe("RUNNING");
    await waitFor(
      () => h.lord.store.operations("task").at(-1)?.status === "succeeded",
    );
    expect(h.calls()).toHaveLength(2);
    expect(h.calls()[1].args).toContain("--session");
  }, 15000);
  it("killing a checkpoint client leaves execution and its terminal receipt intact", async () => {
    const release = path.join(h.base, "release");
    h.options({ releaseFile: release });
    const lord = new AgentLord(h.root, true);
    await lord.start("task", "mcode", h.target, "work", {
      model: "test/model",
    });
    await waitFor(() => h.lord.store.hasTask("task"));
    const waiter = h.controller([
      "checkpoint",
      "--task-id",
      "task",
      "--seconds",
      "30",
    ]);
    await new Promise<void>((resolve) => waiter.once("spawn", resolve));
    waiter.kill("SIGKILL");
    await waitFor(() => waiter.signalCode !== null);
    writeFileSync(release, "waiter terminated; provider may finish");
    await waitFor(
      () => h.lord.store.operations("task")[0]?.status === "succeeded",
    );
    expect(h.lord.store.operations("task")[0].provider_return_code).toBe(0);
    expect(h.calls()).toHaveLength(1);
  }, 15000);
});
