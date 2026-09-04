/**
 * test/query/efficiency-headroom.test.ts — BM2 efficiency headroom.
 *
 * Behavioral tests over a fixture DB: the ratio sums modeled savings across open
 * recs (PROPOSED|ADOPTED, non-null) over trailing-window spend; DISMISSED is
 * excluded; zero-spend and all-null render as null (never NaN/∞).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEfficiencyHeadroom } from "../../src/query/api/efficiency-headroom.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const WS = "ws-bm2";
const TO = "2027-02-01T00:00:00.000Z";
const TO_MS = new Date(TO).getTime();
const FROM = new Date(TO_MS - 7 * 24 * 60 * 60 * 1000).toISOString();

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = migratedMemDb();
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, 'bm2', '2027-01-01T00:00:00.000Z')`,
  ).run(WS);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('sess-bm2', ?, '/f.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(WS, FROM, TO);
  seq = 0;
});
afterEach(() => db.close());

function insRec(state: string, savings: number | null): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at)
     VALUES (?, 'RULE', 'D2', 'CONTEXT', NULL, 'lever',
             ?, '{}', '{}', 'm', ?, '2027-01-20T00:00:00.000Z')`,
  ).run(`rec-${seq++}`, savings, state);
}

/** Insert one in-window turn with the given cost. */
function insSpend(costU: number): void {
  const ts = new Date(TO_MS - 24 * 60 * 60 * 1000).toISOString(); // 1 day before `to`
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, 'sess-bm2', ?, ?, 'claude-sonnet-5', 0, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, 'LIST_EQUIV', 0, 'v1')`,
  ).run(`msg-${seq++}`, WS, ts, costU);
}

function compute() {
  return getEfficiencyHeadroom(db, { from: FROM, to: TO }).data;
}

it("computes the exact pct from open recs over window spend; DISMISSED excluded", () => {
  insRec("PROPOSED", 2_000_000); // counts
  insRec("ADOPTED", null); // open but null savings — not summed, not counted
  insRec("DISMISSED", 5_000_000); // excluded entirely
  insSpend(6_000_000);
  insSpend(4_000_000); // total actual = 10_000_000
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(2_000_000);
  expect(r?.actual_u_per_wk).toBe(10_000_000);
  expect(r?.headroom_pct).toBeCloseTo(0.2, 10);
  expect(r?.open_rec_count).toBe(1);
});

it("sums PROPOSED and ADOPTED savings together", () => {
  insRec("PROPOSED", 1_500_000);
  insRec("ADOPTED", 2_500_000);
  insSpend(8_000_000);
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(4_000_000);
  expect(r?.open_rec_count).toBe(2);
  expect(r?.headroom_pct).toBeCloseTo(0.5, 10);
});

it("excludes MEASURED_NO_EFFECT / DISMISSED from the ceiling", () => {
  insRec("MEASURED_NO_EFFECT", 9_000_000);
  insRec("DISMISSED", 9_000_000);
  insSpend(5_000_000);
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(0);
  expect(r?.open_rec_count).toBe(0);
  expect(r?.headroom_pct).toBe(0); // nothing open → 0% headroom, not null
});

it("returns null pct on zero spend (no NaN/∞)", () => {
  insRec("PROPOSED", 2_000_000);
  // no turns → actual = 0
  const r = compute();
  expect(r?.actual_u_per_wk).toBe(0);
  expect(r?.headroom_pct).toBeNull();
  expect(Number.isFinite(r?.headroom_pct as number)).toBe(false);
});

it("returns null pct when open recs exist but all savings are null", () => {
  insRec("PROPOSED", null);
  insRec("ADOPTED", null);
  insSpend(7_000_000);
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(0);
  expect(r?.open_rec_count).toBe(0);
  expect(r?.headroom_pct).toBeNull();
});

it("ignores spend outside the window", () => {
  insRec("PROPOSED", 1_000_000);
  insSpend(4_000_000); // in-window
  // out-of-window turn (before FROM)
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES ('msg-old', 'sess-bm2', ?, '2027-01-01T00:00:00.000Z', 'claude-sonnet-5',
             0, 0, 0, 0, 0, 0, 0, NULL, NULL, 999_000_000, 'LIST_EQUIV', 0, 'v1')`,
  ).run(WS);
  const r = compute();
  expect(r?.actual_u_per_wk).toBe(4_000_000);
  expect(r?.headroom_pct).toBeCloseTo(0.25, 10);
});
