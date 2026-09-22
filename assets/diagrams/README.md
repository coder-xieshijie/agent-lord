# Agent Lord diagrams

These archived SVG diagrams describe the architecture and two retained original pipelines at the revision recorded below. The `plan-cross-review` pipeline has an inline Mermaid diagram in both root READMEs. Current model/effort defaults are defined by the linked pipeline policies. Labels are Chinese; the [English README](../../README.md) and [中文 README](../../README.zh-CN.md) explain the same workflows.

| Diagram               | Type           | README image                 | Editable source                |
| --------------------- | -------------- | ---------------------------- | ------------------------------ |
| Architecture overview | `architecture` | [SVG](overview.svg)          | [JSON](overview.json)          |
| Cross-review          | `workflow` v2  | [SVG](cross-review.svg)      | [JSON](cross-review.json)      |
| Plan-to-implement     | `workflow` v2  | [SVG](plan-to-implement.svg) | [JSON](plan-to-implement.json) |

Interactive HTML viewers (theme switching, zoom, relationship tracing, export) are **not committed**; regenerate them locally from the JSON sources with the steps below. Each generated viewer is self-contained and needs no external service. The SVG files come from Archify's built-in SVG export and include automatic light/dark styling and font licensing.

## Source of truth

The diagrams were checked against repository revision `1c76e25d6dbc4e840a779aa8ebc2b12b9bbc71b7`:

- Overview: [scheduling ownership](../../SKILL.md#scheduling-ownership), [runtime protocol](../../references/protocol.md), [engine](../../core/src/engine.ts), and [Observer](../../observer/README.md).
- Cross-review: [pipeline policy](../../references/pipelines/cross-review.md). “Two independent reviews” and “mutual cross-exam” each represent a concurrent pair, not one shared reviewer session. The checker is a separate new session.
- Plan-to-implement: [pipeline policy](../../references/pipelines/plan-to-implement.md), [plan runtime](../../core/src/plan.ts), and [CLI commands](../../core/src/cli.ts). The worker/commit stage repeats for each dependency-ready set. The last node combines publication and runtime closure; the integrator publishes, then the caller registers verification and closes the run.

The diagrams summarize responsibilities and barriers. Policies and runtime code retain the full failure/recovery contracts. The common contract is shared infrastructure, not a named pipeline.

## Regeneration

Generated with **Archify 2.17**. Set `ARCHIFY_DIR` to your installed Skill directory, then run from the repository root:

```sh
# Example: regenerate the cross-review diagram.
node "$ARCHIFY_DIR/bin/archify.mjs" validate workflow \
  assets/diagrams/cross-review.json --quality showcase --json
node "$ARCHIFY_DIR/bin/archify.mjs" deliver workflow \
  assets/diagrams/cross-review.json assets/diagrams/cross-review.html \
  --quality showcase --json
node "$ARCHIFY_DIR/bin/archify.mjs" visual-check \
  assets/diagrams/cross-review.html --json
```

Use `architecture` for `overview.json`, and `workflow` for the other two. Run each step only after its predecessor succeeds. Open the delivered HTML and choose **Export → SVG** to replace the corresponding README image. Keep the JSON as the authoring source; do not hand-edit generated HTML or SVG. Preserve the bundled font license in exports. Strip trailing horizontal whitespace from exported SVG text before recording its digest; leave the delivered HTML and source JSON bytes unchanged. Generated HTML viewers stay local: `.gitignore` excludes `assets/diagrams/*.html`.

`visual-check` generates local screenshot, contact-sheet, and receipt sidecars. Inspect its light/dark screenshots, then refresh [validation.json](validation.json) from the current artifact-bound receipts. Screenshot sidecars need not be committed.

## Validation

[validation.json](validation.json) records specification/HTML SHA-256 digests and byte counts, SVG export digests, deterministic delivery checks, browser measurements, and a separate perceptual review record. HTML digests describe the locally generated viewers at validation time; the viewers themselves are not committed.

- **Deterministic artifacts:** all three retained diagrams passed 9/9 showcase checks, with zero composition errors and warnings.
- **Browser evidence:** all three retained diagrams passed containment/readability checks at 1440×900, 1600×1000, 1920×1080, and 2048×1320.
- **Perceptual review:** light screenshots at 2048×1320 and dark screenshots at 1440×900 were inspected for clipping, text fit, relationship clarity, and composition. This is separate from automated browser evidence; it is not a complete interaction test of every viewer feature.

These checks validate the documentation artifacts. They do not run Agent Lord pipelines, paid providers, or application tests.
