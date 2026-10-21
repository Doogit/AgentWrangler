import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recsIngestMark } from "../../src/daemon/recs-snapshot.js";
import { recommendationsStateKey } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function setConfig(key: string, value: string, at: string): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, at);
}

describe("appended ingest tables move the ingest mark", () => {
  it("ingest_metric_events", () => {
    const m0 = recsIngestMark();
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error, is_interrupt)
       VALUES ('mark-ev-1', 'mark-s-1', NULL, 0, 0, 0, 0)`,
    ).run();
    expect(recsIngestMark()).not.toBe(m0);
  });

  it("tool_event_metadata", () => {
    db.pragma("foreign_keys = OFF");
    const m0 = recsIngestMark();
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
       VALUES ('mark-tev-1', NULL, NULL, 0, 0)`,
    ).run();
    expect(recsIngestMark()).not.toBe(m0);
  });
});

// No recs path reads these (reader map in the guard test below), so rewriting them moves neither
// the state key nor the ingest mark: they no longer cost a rebuild every <= 10 min.
const DROPPED_SAMPLES = [
  "usage_last_good",
  "detector_pass_marker",
  "detector_pass_completed_at",
  "last_measurement_run_at",
  "outcomes_last_pass_at",
  "turns_agent_id_backfill_v1",
  "gh_watermark:o/r",
  "gh_findings_seen:o/r",
  "gh_e1_check:wi-1",
  "gh_e3_diff:wi-1",
  "gh_pr_reads:wi-1",
  "gh_commit_pulls:o/r",
];

function perModel(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    captured_at: "2026-01-03T10:00:00.000Z",
    seven_day_util: 0.5,
    five_hour_util: 0.1,
    per_model: [
      { model: "claude-sonnet-4", utilization: 0.4 },
      { model: "claude-opus-4", utilization: 0.5 },
    ],
    ...over,
  });
}

describe("timer-written user_config keys move neither the state key nor the ingest mark", () => {
  for (const key of DROPPED_SAMPLES) {
    it(`${key}`, () => {
      setConfig(key, "a", "2026-01-03T10:00:00Z");
      const k0 = recommendationsStateKey();
      const m0 = recsIngestMark();
      setConfig(key, "b", "2026-01-03T10:06:00Z");
      expect(recommendationsStateKey()).toBe(k0);
      expect(recsIngestMark()).toBe(m0);
    });
  }

  it("ledger_enrichment_epoch (read by ledgerFingerprint): a bump moves the mark, not the state key", () => {
    setConfig("ledger_enrichment_epoch", "1", "2026-01-03T10:00:00Z");
    const k0 = recommendationsStateKey();
    const m0 = recsIngestMark();
    setConfig("ledger_enrichment_epoch", "2", "2026-01-03T10:06:00Z");
    expect(recsIngestMark()).not.toBe(m0);
    expect(recommendationsStateKey()).toBe(k0);
  });

  it("per_model_snapshot (read by D4): a poll that changes only captured_at / five_hour_util keeps the mark", () => {
    setConfig("per_model_snapshot", perModel(), "2026-01-03T10:00:00Z");
    const k0 = recommendationsStateKey();
    const m0 = recsIngestMark();
    setConfig(
      "per_model_snapshot",
      perModel({ captured_at: "2026-01-03T10:03:00.000Z", five_hour_util: 0.2 }),
      "2026-01-03T10:03:00Z",
    );
    expect(recommendationsStateKey()).toBe(k0);
    expect(recsIngestMark()).toBe(m0);
  });

  it("per_model_snapshot: a change D4 reads moves the mark (not the state key)", () => {
    setConfig("per_model_snapshot", perModel(), "2026-01-03T10:00:00Z");
    const k0 = recommendationsStateKey();
    const m0 = recsIngestMark();
    setConfig("per_model_snapshot", perModel({ seven_day_util: 0.6 }), "2026-01-03T10:03:00Z");
    expect(recsIngestMark()).not.toBe(m0);
    const m1 = recsIngestMark();
    setConfig(
      "per_model_snapshot",
      perModel({ per_model: [{ model: "claude-sonnet-4", utilization: 0.9 }] }),
      "2026-01-03T10:04:00Z",
    );
    expect(recsIngestMark()).not.toBe(m1);
    expect(recommendationsStateKey()).toBe(k0);
  });

  it("per_model_snapshot: a stale snapshot refreshed with the same values moves the mark (D4's 24 h gate)", () => {
    const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    setConfig("per_model_snapshot", perModel({ captured_at: iso(25 * 3_600_000) }), iso(0));
    const m0 = recsIngestMark();
    setConfig("per_model_snapshot", perModel({ captured_at: iso(60_000) }), iso(0));
    expect(recsIngestMark()).not.toBe(m0);
  });

  it("per_model_snapshot: a fresh poll changing only captured_at keeps the mark; an invalid five_hour_util moves it", () => {
    const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    setConfig("per_model_snapshot", perModel({ captured_at: iso(120_000) }), iso(0));
    const m0 = recsIngestMark();
    setConfig("per_model_snapshot", perModel({ captured_at: iso(60_000) }), iso(0));
    expect(recsIngestMark()).toBe(m0);
    setConfig(
      "per_model_snapshot",
      perModel({ captured_at: iso(60_000), five_hour_util: null }),
      iso(0),
    );
    expect(recsIngestMark()).not.toBe(m0);
  });

  it("per_model_snapshot: an unparsable value is tracked verbatim", () => {
    setConfig("per_model_snapshot", "not json", "2026-01-03T10:00:00Z");
    const m0 = recsIngestMark();
    setConfig("per_model_snapshot", "still not json", "2026-01-03T10:01:00Z");
    expect(recsIngestMark()).not.toBe(m0);
  });

  it("a user setting (cap_read_coeff) moves the state key, not the mark", () => {
    const k0 = recommendationsStateKey();
    const m0 = recsIngestMark();
    setConfig("cap_read_coeff", "0.2", "2026-01-03T10:02:00Z");
    expect(recommendationsStateKey()).not.toBe(k0);
    expect(recsIngestMark()).toBe(m0);
  });
});
