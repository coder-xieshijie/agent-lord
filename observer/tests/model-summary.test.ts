import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskMeta } from "../src/shared/types.js";
import {
  parseModelRoute,
  summarizeScheduledModel,
} from "../src/web/lib/model-summary.js";
import { ScheduledModel } from "../src/web/components/scheduled-model.js";

const mcodeMeta = {
  provider: "mcode-cli",
  model: "custom_provider:mafia-claude/claude-opus-5",
  effort: "xhigh",
  execution: {
    requestedModel: "custom_provider:mafia-claude/claude-opus-5",
    requestedVariant: null,
    requestedEffort: "xhigh",
    actualModel: null,
    actualVariant: "thinking",
    actualEffort: "xhigh",
    modelVerification: null,
    variantVerification: "not-requested",
    effortVerification: "argument-enforced",
  },
} as unknown as TaskMeta;

describe("scheduled model header summary", () => {
  it("keeps only the final model-name segment and separates the inline variant", () => {
    expect(
      parseModelRoute("custom_provider:mafia-claude/claude-opus-5#xhigh"),
    ).toEqual({ name: "claude-opus-5", variant: "xhigh" });
    expect(parseModelRoute("gpt-5-codex")).toEqual({
      name: "gpt-5-codex",
      variant: null,
    });
    expect(parseModelRoute("provider/fable#")).toEqual({
      name: "fable",
      variant: null,
    });
    expect(parseModelRoute("  ")).toEqual({ name: null, variant: null });
    expect(parseModelRoute(null)).toEqual({ name: null, variant: null });
  });

  it("uses explicit MCode effort and keeps a legacy variant fallback", () => {
    expect(summarizeScheduledModel(mcodeMeta)).toEqual({
      name: "claude-opus-5",
      full: "custom_provider:mafia-claude/claude-opus-5",
      strength: "xhigh",
      strengthSource: "effort",
    });
    const legacy = {
      ...mcodeMeta,
      model: "provider/fable#deep",
      effort: null,
      execution: {
        ...mcodeMeta.execution,
        requestedModel: "provider/fable#deep",
        requestedVariant: null,
        requestedEffort: null,
      },
    } as TaskMeta;
    expect(summarizeScheduledModel(legacy)).toMatchObject({
      strength: "deep",
      strengthSource: "variant",
    });
    // An actual model reported by the runtime must not replace the scheduled one.
    const reported = {
      ...mcodeMeta,
      execution: {
        ...mcodeMeta.execution,
        actualModel: "other-model",
        actualEffort: "high",
      },
    } as TaskMeta;
    expect(summarizeScheduledModel(reported)).toMatchObject({
      name: "claude-opus-5",
      strength: "xhigh",
    });
  });

  it("prefers the explicit effort field for Claude and Codex tasks", () => {
    const codex = {
      provider: "codex-cli",
      model: "gpt-5-codex",
      effort: "high",
      execution: {
        requestedModel: "gpt-5-codex",
        requestedEffort: "xhigh",
        requestedVariant: null,
      },
    } as unknown as TaskMeta;
    expect(summarizeScheduledModel(codex)).toEqual({
      name: "gpt-5-codex",
      full: "gpt-5-codex",
      strength: "xhigh",
      strengthSource: "effort",
    });
    const claude = {
      provider: "claude-code",
      model: "claude-opus-4-6",
      effort: "high",
    } as unknown as TaskMeta;
    expect(summarizeScheduledModel(claude)).toEqual({
      name: "claude-opus-4-6",
      full: "claude-opus-4-6",
      strength: "high",
      strengthSource: "effort",
    });
  });

  it("reports nothing rather than guessing when no model was recorded", () => {
    expect(
      summarizeScheduledModel({
        provider: null,
        model: null,
        effort: null,
      } as unknown as TaskMeta),
    ).toEqual({ name: null, full: null, strength: null, strengthSource: null });
    expect(summarizeScheduledModel(null)).toEqual({
      name: null,
      full: null,
      strength: null,
      strengthSource: null,
    });
    expect(
      renderToStaticMarkup(
        createElement(ScheduledModel, {
          meta: {
            provider: null,
            model: null,
            effort: null,
          } as unknown as TaskMeta,
        }),
      ),
    ).toBe("");
  });

  it("renders the short model and its strength in the always-visible header, keeping the full route in the tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(ScheduledModel, { meta: mcodeMeta }),
    );
    expect(html).toContain(">claude-opus-5<");
    expect(html).toContain(">xhigh<");
    expect(html).toContain(
      'title="custom_provider:mafia-claude/claude-opus-5"',
    );
    expect(html).toContain("请求 Effort");
    // The raw route must not be rendered as visible header text.
    expect(html).not.toContain(">custom_provider:mafia-claude/claude-opus-5<");
    expect(html).toContain("truncate");
    const codexHtml = renderToStaticMarkup(
      createElement(ScheduledModel, {
        meta: {
          provider: "codex-cli",
          model: "gpt-5-codex",
          effort: "high",
        } as unknown as TaskMeta,
      }),
    );
    expect(codexHtml).toContain("请求 Effort");
    expect(codexHtml).toContain(">high<");
  });
});
