/**
 * test/query/rec-cache.test.ts — DR8 detector-status strip cache.
 *
 * The expensive part of listRecommendations() is getDetectorStatuses(), which
 * re-evaluates the whole detector registry live (~1s). DR8 memoizes it per DB,
 * keyed on a cheap ingest-generation marker, while still assembling the
 * recommendation cards live every call. These tests cover: first-call miss,
 * repeat-call hit (no recompute), invalidation after an ingest + detector pass,
 * and that the cards stay live (a dismiss is reflected while the strip is cached).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import {
  __detectorStatusComputeCount,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

let db: Database.Database;

/** Insert `count` qualifying long-context sessions (each 151 cache-read turns) so D2 fires. */
function seedLongSessions(startIndex: number, count: number): void {
  for (let i = startIndex; i < startIndex + count; i++) {
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED', 200, 0, '[]')`,
    ).run(`sess-long-${i}`, `/fake/long-${i}.jsonl`, RECENT, RECENT);
    const insertTurn = db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
         cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
         provisional, parser_version)
       VALUES (?, ?, 'ws-alpha', ?, 'claude-sonnet', 0,
         0, 0, 200000, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
    );
    for (let turn = 0; turn <= 150; turn++) {
      insertTurn.run(`msg-long-${i}-${turn}`, `sess-long-${i}`, RECENT);
    }
  }
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  seedLongSessions(1, 3);
  runDetectors(db, { now: NOW });
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("listRecommendations detector-strip cache (DR8)", () => {
  it("assembles the detector strip on the first call (cache miss)", () => {
    const before = __detectorStatusComputeCount();
    const view = listRecommendations().data;
    expect(view).not.toBeNull();
    expect(view?.detectors.length).toBeGreaterThan(0);
    expect(__detectorStatusComputeCount()).toBe(before + 1);
  });

  it("serves the cached strip on a repeat call with no intervening ingest (no recompute)", () => {
    const first = listRecommendations();
    const afterFirst = __detectorStatusComputeCount();

    const second = listRecommendations();
    // No new assembly ran between the two calls...
    expect(__detectorStatusComputeCount()).toBe(afterFirst);
    // ...and the returned detector strip is identical.
    expect(second.data?.detectors).toEqual(first.data?.detectors);
  });

  it("invalidates and recomputes after an ingest + detector pass", () => {
    listRecommendations(); // prime the cache
    const primed = __detectorStatusComputeCount();
    listRecommendations(); // confirm the baseline is a hit
    expect(__detectorStatusComputeCount()).toBe(primed);

    // New ingest advances the generation marker (more turns + sessions).
    seedLongSessions(4, 2);
    runDetectors(db, { now: NOW });

    listRecommendations();
    expect(__detectorStatusComputeCount()).toBe(primed + 1);
  });

  it("keeps recommendation cards live while the strip stays cached", () => {
    const first = listRecommendations().data;
    const recId = first?.active[0]?.rec_id;
    expect(recId).toBeDefined();
    const stripComputes = __detectorStatusComputeCount();

    // Dismiss the rec directly — no new ingest, so the strip marker is unchanged.
    db.prepare(
      "UPDATE recommendations SET state='DISMISSED', dismissed_until=? WHERE rec_id=?",
    ).run(new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), recId);

    const second = listRecommendations().data;
    // The expensive strip was served from cache (no recompute)...
    expect(__detectorStatusComputeCount()).toBe(stripComputes);
    // ...but the card moved to dismissed live (never served stale).
    expect(second?.active.find((c) => c.rec_id === recId)).toBeUndefined();
    expect(second?.dismissed.some((c) => c.rec_id === recId)).toBe(true);
  });
});
