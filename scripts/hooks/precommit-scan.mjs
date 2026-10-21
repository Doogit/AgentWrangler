#!/usr/bin/env node
// SEC-101 pre-commit guard. Two checks over staged files:
//   1. Path shapes  — agent scratch / leaked absolute paths (the class of commit
//      6998f78). scripts/hooks/leak-signatures.mjs.
//   2. Raw content  — developer transcript material (transcript-shaped JSON,
//      high-entropy blobs, flat dumps) in the staged text (ADR-112 / SEC-101
//      distribution-boundary). scripts/hooks/content-signatures.mjs.
// Break-glass: git commit --no-verify — which is why the same content scan also
// runs in CI (scripts/hooks/content-scan-ci.mjs) where it can't be skipped.
import { execFileSync } from "node:child_process";
import { decodeText, rawContentReasons } from "./content-signatures.mjs";
import { structuralLeakReasons } from "./leak-signatures.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const staged = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "-z", "--diff-filter=AM"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const pathHits = [];
const contentHits = [];
for (const file of staged) {
  const reasons = structuralLeakReasons(file);
  if (reasons.length) pathHits.push({ file, reasons });

  // Scan the STAGED blob content (index version), not the working tree.
  let buf;
  try {
    buf = execFileSync("git", ["show", `:${file}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    continue; // deleted/renamed edge — nothing to scan
  }
  const text = decodeText(buf);
  if (text === null) continue; // binary
  const hits = rawContentReasons(text, file);
  if (hits.length) contentHits.push({ file, hits });
}

if (pathHits.length || contentHits.length) {
  console.error("\n✖ SEC-101 pre-commit guard blocked this commit.\n");
  if (pathHits.length) {
    console.error("These staged paths look like agent scratch / leaked absolute paths:\n");
    for (const { file, reasons } of pathHits) {
      console.error(`  ${file}`);
      for (const r of reasons) console.error(`      → ${r}`);
    }
    console.error("");
  }
  if (contentHits.length) {
    console.error("These staged files contain raw transcript/agent content (SEC-101):\n");
    for (const { file, hits } of contentHits) {
      for (const { line, reason } of hits) console.error(`  ${file}:${line}  → ${reason}`);
    }
    console.error(
      "\nDeveloper transcript content must never be committed. Committed test data must be a\n" +
        "small, structurally synthetic fixture — not a copy of a real ~/.claude transcript or db dump.",
    );
  }
  if (pathHits.length) {
    console.error("\nFix (paths): this belongs in the OS temp scratchpad, not the repo.");
    console.error("  git restore --staged <path>   then remove it from the tree");
  }
  console.error("\nBreak-glass (discouraged, also re-checked in CI): git commit --no-verify\n");
  process.exit(1);
}
