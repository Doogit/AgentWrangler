import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECS_BOOKKEEPING_CONFIG,
  RECS_INGEST_MARK_KEYS,
} from "../../src/query/api/recommendations.js";

/**
 * Review gate for the recs ingest mark. Each timer-written user_config key either has a recs reader
 * (kept in the mark) or does not (dropped). The map below is the reader audit: every src file that
 * mentions the key. A NEW file mentioning a dropped key fails here, forcing the author to decide
 * whether a recs path now reads it (then add it to RECS_INGEST_MARK_KEYS) or it is another
 * non-recs user (then list it).
 */
const KEPT = ["ledger_enrichment_epoch", "per_model_snapshot"];
const DROPPED = [
  "usage_last_good",
  "detector_pass_marker",
  "detector_pass_completed_at",
  "last_measurement_run_at",
  "outcomes_last_pass_at",
  "turns_agent_id_backfill_v1",
  "gh_watermark:",
  "gh_findings_seen:",
  "gh_e1_check:",
  "gh_e3_diff:",
  "gh_pr_reads:",
  "gh_commit_pulls:",
];

/** term (key, prefix or its exported constant) -> every src file allowed to mention it. */
const READERS: Record<string, string[]> = {
  ledger_enrichment_epoch: ["ingest/enrichment-epoch.ts"], // defines ENRICHMENT_EPOCH_KEY
  ENRICHMENT_EPOCH_KEY: ["ingest/enrichment-epoch.ts", "query/api/ledger-aggregate.ts"], // recs reader: ledgerFingerprint
  per_model_snapshot: [
    "detector/detectors/d4_model_mismatch.ts", // recs reader: seven_day_util + per_model only
    "detector/engine.ts", // comment
    "query/api/burn-status.ts", // writer
    "query/limits/last-good-store.ts", // comment
  ],
  usage_last_good: ["query/limits/last-good-store.ts"], // limits last-good store (not recs)
  detector_pass_marker: ["daemon/boot-state.ts"],
  DETECTOR_PASS_MARKER_KEY: ["daemon/boot-state.ts"],
  detector_pass_completed_at: ["daemon/boot-state.ts"],
  DETECTOR_PASS_COMPLETED_AT_KEY: ["daemon/boot-state.ts"],
  last_measurement_run_at: ["detector/measurement.ts"], // measurement throttle
  outcomes_last_pass_at: ["daemon/outcomes-pass.ts"],
  OUTCOMES_LAST_PASS_KEY: ["daemon/outcomes-pass.ts"],
  turns_agent_id_backfill_v1: ["ingest/agent-id-backfill.ts"],
  AGENT_ID_BACKFILL_KEY: ["ingest/agent-id-backfill.ts"],
  gh_watermark: ["outcomes/findings.ts", "outcomes/linker.ts", "outcomes/sync.ts"],
  gh_findings_seen: ["outcomes/findings.ts"],
  gh_e1_check: ["outcomes/findings.ts"],
  gh_e3_diff: ["outcomes/findings.ts"],
  gh_pr_reads: ["outcomes/linker.ts"],
  gh_commit_pulls: ["outcomes/linker.ts"],
};

// The files that define the key lists themselves.
const OWNERS = ["query/api/recommendations.ts", "daemon/recs-snapshot.ts"];

const SRC = join(__dirname, "..", "..", "src");

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? srcFiles(join(dir, e.name))
      : e.name.endsWith(".ts") || e.name.endsWith(".tsx")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("recs ingest mark: kept vs dropped bookkeeping keys", () => {
  it("lists exactly the kept and dropped keys", () => {
    expect([...RECS_INGEST_MARK_KEYS]).toEqual(KEPT);
    const all = [...RECS_BOOKKEEPING_CONFIG.keys, ...RECS_BOOKKEEPING_CONFIG.prefixes].sort();
    expect([...KEPT, ...DROPPED].sort()).toEqual(all);
  });

  it("only files in the reader audit mention a bookkeeping key (a new reader needs review)", () => {
    const files = srcFiles(SRC)
      .map((f) => ({ rel: relative(SRC, f).split("\\").join("/"), text: readFileSync(f, "utf8") }))
      .filter((f) => !OWNERS.includes(f.rel));
    const found: Record<string, string[]> = {};
    for (const term of Object.keys(READERS)) {
      found[term] = files
        .filter((f) => f.text.includes(term))
        .map((f) => f.rel)
        .sort();
    }
    const expected: Record<string, string[]> = {};
    for (const [term, list] of Object.entries(READERS)) expected[term] = [...list].sort();
    expect(found).toEqual(expected);
  });

  it("each kept key has a recs reader", () => {
    const reader: Record<string, [string, string]> = {
      per_model_snapshot: ["detector/detectors/d4_model_mismatch.ts", "per_model_snapshot"],
      ledger_enrichment_epoch: ["query/api/ledger-aggregate.ts", "ENRICHMENT_EPOCH_KEY"],
    };
    expect(Object.keys(reader).sort()).toEqual([...KEPT].sort());
    for (const [file, term] of Object.values(reader))
      expect(readFileSync(join(SRC, file), "utf8")).toContain(term);
  });
});
