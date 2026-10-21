/**
 * test/ingest/enrichment-epoch-guard.test.ts: a new job that rewrites ledger-input rows must not
 * forget the enrichment epoch. Any source file under src/ (migrations excluded) with an
 * UPDATE / DELETE / INSERT on a ledger-input table has to import the epoch helper, or be listed
 * below with the reason the fingerprint already sees its writes. Grep-based on purpose: it is
 * the check that fires when someone adds the next backfill.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../src");
const TABLES = [
  "tool_events",
  "ingest_metric_events",
  "turns",
  "subagent_meta",
  "tool_event_metadata",
  "tool_event_skills",
  "tool_event_content",
];
const HELPER = "enrichment-epoch.js";

/** Files that write these tables with the fingerprint already covering it. */
const ALLOWLIST: Record<string, string> = {
  "ingest/reconcile.ts":
    "turns.provisional and sessions.state flips: both are in ledgerFingerprint (SUM(provisional), SUM(state = 'RECONCILED'))",
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "migrations" && entry.name !== "ui") out.push(...sources(full));
    } else if (/\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WRITE = new RegExp(
  `\\b(?:UPDATE|DELETE\\s+FROM|INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO)\\s+(?:(?:${TABLES.join("|")})\\b|\\$\\{)`,
  "gi",
);

/**
 * Write statements to a ledger-input table per file: literal, or interpolated next to a quoted
 * table name. Pinned (below) so a new writer in a file that already imports the helper still has
 * to be looked at.
 */
function writerCounts(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of sources(SRC)) {
    const text = stripComments(fs.readFileSync(file, "utf8"));
    const hits = [...text.matchAll(WRITE)].map((m) => m[0]);
    const dynamicOk = TABLES.some((t) => text.includes(`"${t}"`));
    const n = hits.filter((h) => !h.endsWith("${") || dynamicOk).length;
    if (n > 0) found[path.relative(SRC, file).replaceAll("\\", "/")] = n;
  }
  return found;
}

/**
 * Expected number of ledger-input write statements per file. Adding a statement fails the pin
 * test: decide whether it needs bumpEnrichmentEpoch / bumpEnrichmentEpochIfClosed (or is covered
 * by the fingerprint's count / rowid / flag signals), then update the number here.
 */
const PINNED: Record<string, number> = {
  "ingest/agent-id-backfill.ts": 1,
  "ingest/canary-purge.ts": 3,
  "ingest/commit-linker.ts": 1,
  "ingest/compaction-boundaries.ts": 2,
  "ingest/destructive-relabel.ts": 1,
  "ingest/ingestor.ts": 14,
  "ingest/interrupt-relabel.ts": 1,
  "ingest/reconcile.ts": 1,
  "ingest/reprice.ts": 1,
  "ingest/session-attribution-repair.ts": 5,
  "ingest/test-command-repair.ts": 2,
  "ingest/tool-error-repair.ts": 1,
  "ingest/worktree-workspace-merge.ts": 1,
  "query/settings-store.ts": 1,
};

describe("enrichment epoch guard", () => {
  const counts = writerCounts();
  const found = Object.keys(counts).sort();

  it("pins the number of ledger-input write statements per file", () => {
    expect(counts).toEqual(PINNED);
  });

  it("finds the known writers (the scan itself works)", () => {
    expect(found).toEqual(
      expect.arrayContaining(["ingest/ingestor.ts", "ingest/tool-error-repair.ts"]),
    );
  });

  it("every file that writes a ledger-input table bumps the epoch or is allowlisted", () => {
    const missing = found.filter(
      (rel) =>
        !(rel in ALLOWLIST) && !fs.readFileSync(path.join(SRC, rel), "utf8").includes(HELPER),
    );
    expect(
      missing,
      "These files write a ledger-input table without enrichment-epoch.js. Call bumpEnrichmentEpoch / bumpEnrichmentEpochIfClosed, or allowlist the file with a reason.",
    ).toEqual([]);
  });

  it("the allowlist holds no stale entries", () => {
    expect(Object.keys(ALLOWLIST).filter((rel) => !found.includes(rel))).toEqual([]);
  });
});
