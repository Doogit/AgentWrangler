/**
 * test/query/rec-actions.test.ts — P4 action handlers: dismiss, adopt, buildSeededPrompt.
 *
 * Dismiss: persists state=DISMISSED + dismissed_until; rec filtered from active on next list.
 * Adopt:   persists state=ADOPTED + adopted_at; rec appears in adopted list.
 * buildSeededPrompt: emits a seeded prompt containing only ids/counts from evidence (SEC-101).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import {
  adoptRecommendation,
  buildSeededPrompt,
  dismissRecommendation,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

let db: Database.Database;

/** Seed 3 qualifying long-context sessions and run detectors so D2 fires. */
function seedD2(target: Database.Database) {
  for (let i = 1; i <= 3; i++) {
    target
      .prepare(
        `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
           state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED', 200, 0, '[]')`,
      )
      .run(`sess-long-action-${i}`, `/fake/action-${i}.jsonl`, RECENT, RECENT);
    const insertTurn = target.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
           cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
           provisional, parser_version)
         VALUES (?, ?, 'ws-alpha', ?, 'claude-sonnet', 0,
           0, 0, 200000, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
    );
    for (let turn = 0; turn <= 150; turn++) {
      insertTurn.run(`msg-long-action-${i}-${turn}`, `sess-long-action-${i}`, RECENT);
    }
  }
  runDetectors(target, { now: NOW });
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  seedD2(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

// ---------------------------------------------------------------------------
// dismissRecommendation
// ---------------------------------------------------------------------------

describe("dismissRecommendation", () => {
  it("sets state=DISMISSED and dismissed_until 30 days out", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    const nowMs = Date.now();
    dismissRecommendation(rec.rec_id, nowMs);

    const row = db
      .prepare<string>("SELECT state, dismissed_until FROM recommendations WHERE rec_id=?")
      .get(rec.rec_id) as { state: string; dismissed_until: string } | undefined;

    expect(row?.state).toBe("DISMISSED");
    const expectedMs = nowMs + 30 * 24 * 60 * 60 * 1000;
    // dismissed_until should be within 1 second of expected
    expect(Math.abs(new Date(row?.dismissed_until ?? "").getTime() - expectedMs)).toBeLessThan(
      1000,
    );
  });

  it("removes the rec from the active list after dismissal", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    dismissRecommendation(rec.rec_id);

    const after = listRecommendations().data;
    expect(after?.active.find((r) => r.rec_id === rec.rec_id)).toBeUndefined();
    expect(after?.dismissed.find((r) => r.rec_id === rec.rec_id)).toBeDefined();
  });

  it("throws if rec_id is not found or not PROPOSED", () => {
    expect(() => dismissRecommendation("rec-nonexistent")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// adoptRecommendation
// ---------------------------------------------------------------------------

describe("adoptRecommendation", () => {
  it("sets state=ADOPTED and adopted_at", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    const nowMs = Date.now();
    adoptRecommendation(rec.rec_id, nowMs);

    const row = db
      .prepare<string>("SELECT state, adopted_at FROM recommendations WHERE rec_id=?")
      .get(rec.rec_id) as { state: string; adopted_at: string } | undefined;

    expect(row?.state).toBe("ADOPTED");
    expect(Math.abs(new Date(row?.adopted_at ?? "").getTime() - nowMs)).toBeLessThan(1000);
  });

  it("moves rec from active to adopted list", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    adoptRecommendation(rec.rec_id);

    const after = listRecommendations().data;
    expect(after?.active.find((r) => r.rec_id === rec.rec_id)).toBeUndefined();
    expect(after?.adopted.find((r) => r.rec_id === rec.rec_id)).toBeDefined();
  });

  it("throws if rec_id is not found or not PROPOSED", () => {
    expect(() => adoptRecommendation("rec-nonexistent")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildSeededPrompt — SEC-101: ids/counts/aggregates only
// ---------------------------------------------------------------------------

describe("buildSeededPrompt", () => {
  it("includes detector_id and lever in the prompt", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    const prompt = buildSeededPrompt(rec);
    expect(prompt).toContain(rec.detector_id);
    expect(prompt).toContain(rec.lever);
    // DR5: the raw category enum (CONTEXT/LIMIT/CACHE…) is intentionally no longer
    // emitted in the seeded prompt (blog taxonomy forbids it as user-facing copy).
    expect(prompt).not.toContain(`"category"`);
  });

  it("includes evidence_pack_hash (provenance) instead of raw evidence keys (SEC-101 hardened)", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    const prompt = buildSeededPrompt(rec);
    // Hardened format: evidence is not emitted raw; only a SHA-256 hash of it appears.
    expect(prompt).toContain("evidence_pack_hash");
    // The hash must be a 64-char hex string (SHA-256).
    const match = prompt.match(/"evidence_pack_hash":\s*"([0-9a-f]{64})"/);
    expect(match).not.toBeNull();
  });

  it("does not contain SQL keywords or file paths (no content leakage)", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    const prompt = buildSeededPrompt(rec);
    // The prompt must not contain SQL
    expect(prompt).not.toMatch(/\bSELECT\b/i);
    expect(prompt).not.toMatch(/\bINSERT INTO\b/i);
    // File path (fake fixture path used in seed) must not appear
    expect(prompt).not.toContain("/fake/action-");
  });

  it("emits null modeled_savings_u_per_wk in payload for warning-class recs", () => {
    const view = listRecommendations().data;
    const rec = view?.active[0];
    if (rec === undefined) throw new Error("no active rec");

    // Hardened format: savings represented as null in the JSON payload (not a text sentence).
    const noSavingsRec = { ...rec, modeled_savings_u_per_wk: null };
    const prompt = buildSeededPrompt(noSavingsRec);
    expect(prompt).toContain('"modeled_savings_u_per_wk": null');
  });
});
