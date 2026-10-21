#!/usr/bin/env node
// SEC-101 content gate for CI. Scans every tracked text file for raw transcript/
// agent content (ADR-112). Runs in CI so the pre-commit content scan cannot be
// bypassed with `git commit --no-verify`. Whole-tree scan (not diff-only): the
// invariant is that the committed tree never holds developer transcript content,
// so any hit fails the job regardless of which commit introduced it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ingestFixtureViolations } from "./assert-ingest-fixtures.mjs";
import { decodeText, rawContentReasons } from "./content-signatures.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const hits = [];
for (const file of files) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(root, file));
  } catch {
    continue;
  }
  const text = decodeText(buf);
  if (text === null) continue; // binary
  for (const { line, reason } of rawContentReasons(text, file)) {
    hits.push(`${file}:${line}  → ${reason}`);
  }
}

// W-A backstop: the carve-out roots must hold only synthetic fixtures (NEW-1).
const fixtureViolations = ingestFixtureViolations(root);

if (hits.length || fixtureViolations.length) {
  if (hits.length) {
    console.error(
      "SEC-101 content gate FAILED — raw transcript/agent content in the tracked tree:",
    );
    for (const h of hits) console.error(`  ${h}`);
  }
  if (fixtureViolations.length) {
    console.error("SEC-101 content gate FAILED — non-synthetic content in the ingest carve-out:");
    for (const v of fixtureViolations) console.error(`  ${v}`);
  }
  console.error(
    "\nDeveloper transcript content must never be committed. Remove it; committed test data must be\n" +
      "a small, structurally synthetic fixture. See docs/adr/ADR-112-sec101-distribution-boundary.md.",
  );
  process.exit(1);
}
console.log(
  `SEC-101 content gate: ${files.length} tracked file(s) scanned, 0 hits; ingest fixtures synthetic`,
);
