#!/usr/bin/env node
// SEC-101 W-A fixture-provenance backstop (re-review NEW-1, ADR-112).
//
// The W-B content gate carves out test/fixtures/ingest/ so synthetic
// transcript-shaped JSON may live there — which re-opens the risk of a REAL
// transcript being pasted into that root below the oversized/entropy thresholds.
// UUID-shape alone cannot tell a real transcript from a synthetic fixture that
// deliberately uses a UUID session directory, so this backstop uses a reviewed
// MANIFEST instead (mirrors the u12 committed-artifact gate): every committed
// fixture must be registered by its git blob SHA in ingest-fixtures-manifest.json.
// A new/edited fixture changes its blob SHA and fails until a reviewer updates
// the manifest — making any pasted content a visible, reviewed diff, never silent.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every content-gate fixture carve-out (content-signatures.mjs) must be listed here.
const FIXTURE_PREFIXES = ["test/fixtures/ingest/", "test/fixtures/detector-health/"];
const MANIFEST_REL = "scripts/hooks/ingest-fixtures-manifest.json";

/** Compare committed blob entries to the manifest (pure; git-independent). */
export function manifestViolations(entries, manifest) {
  const violations = [];
  const seen = new Set();
  for (const { sha, file } of entries) {
    seen.add(file);
    if (!(file in manifest)) {
      violations.push(`${file}  → unregistered ingest fixture (add its blob SHA to the manifest)`);
    } else if (manifest[file] !== sha) {
      violations.push(
        `${file}  → content changed (manifest ${manifest[file].slice(0, 12)} != ${sha.slice(0, 12)}) — re-review + update the manifest`,
      );
    }
  }
  for (const file of Object.keys(manifest)) {
    if (!seen.has(file)) {
      violations.push(`${file}  → manifest entry has no committed fixture (stale — remove it)`);
    }
  }
  return violations;
}

/** Committed fixtures under the carve-out, as {file, sha} git blob entries. */
export function committedFixtureEntries(root) {
  const out = execFileSync("git", ["ls-files", "-s", "--", ...FIXTURE_PREFIXES], {
    cwd: root,
    encoding: "utf8",
  });
  const entries = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    // format: "<mode> <sha> <stage>\t<path>"
    const [meta, file] = line.split("\t");
    const sha = meta.split(/\s+/)[1];
    entries.push({ sha, file });
  }
  return entries;
}

/** Return manifest-provenance violations for the committed ingest fixtures. */
export function ingestFixtureViolations(root) {
  const manifestPath = path.join(root, MANIFEST_REL);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return [`${MANIFEST_REL}  → missing or invalid ingest-fixture manifest`];
  }
  return manifestViolations(committedFixtureEntries(root), manifest);
}

// Standalone runner.
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const violations = ingestFixtureViolations(root);
  if (violations.length) {
    console.error("SEC-101 ingest-fixture provenance gate FAILED:");
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      `\n${FIXTURE_PREFIXES.join(" and ")} hold ONLY reviewed synthetic fixtures. Regenerate the manifest with\n` +
        "`node scripts/hooks/ingest-fixtures-manifest.gen.mjs` after a deliberate, reviewed change.\n" +
        "See docs/adr/ADR-112-sec101-distribution-boundary.md.",
    );
    process.exit(1);
  }
  console.log("SEC-101 ingest-fixture provenance gate: 0 violations");
}
