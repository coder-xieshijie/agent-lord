#!/usr/bin/env node
// Documentation gates for CI:
// 1. Every relative link and anchor in tracked Markdown files resolves.
// 2. SKILL.md stays under its size budget (agents load it whole into
//    context, so growth is a regression).
// Zero dependencies; run with `node scripts/check-docs.mjs` from anywhere
// inside the repository.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Bytes. Ratchet this DOWN as SKILL.md slims; never raise it casually —
// the whole file ships into every agent context that loads the skill.
const SIZE_BUDGETS = { "SKILL.md": 46080 };

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

/** Strip fenced code blocks, preserving line count. */
function stripFences(text) {
  const lines = text.split("\n");
  let fence = null;
  const kept = lines.map((line) => {
    const open = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length)
        fence = null;
      return "";
    }
    if (open) {
      fence = open[1];
      return "";
    }
    return line;
  });
  return kept.join("\n");
}

/** Strip fenced code blocks and inline code spans, preserving line count. */
function stripCode(text) {
  return stripFences(text)
    .split("\n")
    .map((line) => line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)))
    .join("\n");
}

/** GitHub anchor slug for a heading line's text. */
function slugify(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> label
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // emphasis -> text
    .trim()
    .toLowerCase();
  // Like GitHub's slugger, `code` spans lose the backticks but keep their
  // text (the backtick falls to the character filter below).
  return text.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");
}

/** Anchor set (with GitHub duplicate suffixes) for one Markdown file. */
function anchorsOf(text) {
  const seen = new Map();
  const anchors = new Set();
  // Fence-stripped only: heading text must keep inline-code text so the
  // slug matches GitHub's anchor for headings like `## \`check\` versus …`.
  for (const line of stripFences(text).split("\n")) {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const slug = slugify(m[2]);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

const contents = new Map(
  files.map((f) => [f, readFileSync(path.join(root, f), "utf8")]),
);
const anchorCache = new Map();
const anchorsFor = (file) => {
  if (!anchorCache.has(file))
    anchorCache.set(file, anchorsOf(contents.get(file)));
  return anchorCache.get(file);
};

const errors = [];
const LINK =
  /!?\[[^\]]*\]\(([^()\s]+(?:\([^()]*\)[^()\s]*)?)(?:\s+"[^"]*")?\)/g;

for (const file of files) {
  const stripped = stripCode(contents.get(file));
  const lines = stripped.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(LINK)) {
      const target = match[1];
      if (/^(https?:|mailto:|data:)/i.test(target)) continue;
      const where = `${file}:${index + 1}`;
      const [rawPath, ...anchorParts] = target.split("#");
      const anchor = anchorParts.join("#");
      let targetFile = file;
      if (rawPath) {
        const resolved = path.normalize(
          path.join(path.dirname(file), decodeURIComponent(rawPath)),
        );
        const absolute = path.join(root, resolved);
        if (!existsSync(absolute)) {
          errors.push(
            `${where}: broken link -> ${target} (missing ${resolved})`,
          );
          continue;
        }
        if (anchor && statSync(absolute).isDirectory()) {
          errors.push(`${where}: anchor on a directory -> ${target}`);
          continue;
        }
        targetFile = resolved;
      }
      if (!anchor) continue;
      if (!targetFile.endsWith(".md")) continue;
      if (!contents.has(targetFile)) {
        errors.push(`${where}: anchor into untracked file -> ${target}`);
        continue;
      }
      if (!anchorsFor(targetFile).has(anchor.toLowerCase()))
        errors.push(`${where}: missing anchor -> ${target}`);
    }
  });
}

for (const [file, budget] of Object.entries(SIZE_BUDGETS)) {
  if (!contents.has(file)) {
    errors.push(`${file}: budgeted file is missing`);
    continue;
  }
  const size = Buffer.byteLength(contents.get(file), "utf8");
  if (size > budget)
    errors.push(
      `${file}: ${size} bytes exceeds the ${budget}-byte budget; ` +
        `trim it or consciously raise SIZE_BUDGETS in scripts/check-docs.mjs`,
    );
}

if (errors.length) {
  console.error(`check-docs: ${errors.length} problem(s)`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(
  `check-docs: ${files.length} Markdown files OK (links, anchors, size budgets)`,
);
