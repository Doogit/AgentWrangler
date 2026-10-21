/**
 * test/query/efficiency-headroom.test.ts — BM2 efficiency headroom.
 *
 * Modeled opportunities remain separate from ledger-owned billed spend.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimProducer } from "../../src/detector/claim-ledger.js";
import { turnKey } from "../../src/detector/turn-claim.js";
import { getEfficiencyHeadroom } from "../../src/query/api/efficiency-headroom.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
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
  seedValidatedRecommendation(db, {
    recId: `rec-${seq++}`,
    templateId: "D2_LONG_FULL_CONTEXT",
    scope: null,
    savings,
    state,
    createdAt: "2027-01-20T00:00:00.000Z",
  });
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

it("returns individual open opportunities and no combined percentage", () => {
  insRec("PROPOSED", 2_000_000); // counts
  insRec("ADOPTED", null); // open but null savings — not summed, not counted
  insRec("DISMISSED", 5_000_000); // excluded entirely
  insSpend(6_000_000);
  insSpend(4_000_000); // total actual = 10_000_000
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(0);
  expect(r?.unclaimed_rec_count).toBe(1);
  expect(r?.actual_u_per_wk).toBe(10_000_000);
  // P3.L L6: headroom_pct = headroom/actual as a % now that actual > 0; no ledger claims
  // land in this fixture (zero-token turns), so headroom stays 0 and the pct is 0, not null.
  expect(r?.headroom_pct).toBe(0);
  expect(r?.open_rec_count).toBe(1);
  expect(r?.opportunities).toEqual([{ rec_id: "rec-0", modeled_savings_u_per_wk: 2_000_000 }]);
});

it("keeps modeled opportunities separate from addressable spend", () => {
  insRec("PROPOSED", 1_500_000);
  insRec("ADOPTED", 2_500_000);
  insSpend(8_000_000);
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(0);
  expect(r?.unclaimed_rec_count).toBe(1);
  expect(r?.open_rec_count).toBe(1);
  // P3.L L6: actual > 0 and headroom is 0 (no ledger claims here), so pct is 0, not null.
  expect(r?.headroom_pct).toBe(0);
  expect(r?.opportunities).toEqual([{ rec_id: "rec-0", modeled_savings_u_per_wk: 1_500_000 }]);
});

it("excludes prior-window and stopped recommendations from Headroom", () => {
  insRec("PROPOSED", 1_000_000);
  insRec("PROPOSED", 2_000_000);
  insRec("PROPOSED", 3_000_000);
  db.prepare(
    `UPDATE recommendations SET evidence_json = json_set(evidence_json,
       '$.facts.weeks_ago', 2, '$.facts.weeks_fired', 1) WHERE rec_id = 'rec-1'`,
  ).run();
  db.prepare(
    `UPDATE recommendations SET evidence_json = json_set(evidence_json,
       '$.facts.weeks_ago', 0, '$.facts.weeks_fired', 0) WHERE rec_id = 'rec-2'`,
  ).run();
  const r = compute();
  expect(r?.open_rec_count).toBe(1);
  expect(r?.opportunities).toEqual([{ rec_id: "rec-0", modeled_savings_u_per_wk: 1_000_000 }]);
});

it("skips malformed persisted evidence without breaking Headroom", () => {
  insRec("PROPOSED", 1_000_000);
  db.prepare("UPDATE recommendations SET evidence_json = '{' WHERE rec_id = 'rec-0'").run();
  expect(compute()?.opportunities).toEqual([]);
});

it("excludes MEASURED_NO_EFFECT / DISMISSED from the ceiling", () => {
  insRec("MEASURED_NO_EFFECT", 9_000_000);
  insRec("DISMISSED", 9_000_000);
  insSpend(5_000_000);
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(0);
  expect(r?.open_rec_count).toBe(0);
  expect(r?.unclaimed_rec_count).toBe(0);
  // P3.L L6: actual (5M) > 0 and headroom is 0, so pct is 0, not null.
  expect(r?.headroom_pct).toBe(0);
});

it("returns null pct on zero spend (no NaN/∞)", () => {
  insRec("PROPOSED", 2_000_000);
  // no turns → actual = 0
  const r = compute();
  expect(r?.actual_u_per_wk).toBe(0);
  expect(r?.headroom_pct).toBeNull();
  expect(Number.isFinite(r?.headroom_pct as number)).toBe(false);
});

it("headroom_pct is 0 (not null) when open recs exist but all savings are null", () => {
  insRec("PROPOSED", null);
  insRec("ADOPTED", null);
  insSpend(7_000_000);
  const r = compute();
  expect(r?.headroom_u_per_wk).toBe(0);
  expect(r?.open_rec_count).toBe(0);
  expect(r?.unclaimed_rec_count).toBe(0);
  // P3.L L6: actual (7M) > 0 and headroom is 0, so pct is 0, not null.
  expect(r?.headroom_pct).toBe(0);
});

it("counts a billed turn once when two producers claim the same cells", () => {
  insRec("PROPOSED", 1_000_000);
  db.prepare(
    `INSERT INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-bm2', 'sonnet-4', '[3,15,0.3,3.75,6]', ?, ?)`,
  ).run(FROM, TO);
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
        cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES ('msg-claimed', 'sess-bm2', ?, ?, 'claude-sonnet-4-6', 0,
             100, 20, 0, 0, 0, 0, 0, 'snap-bm2', 600, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(WS, FROM);
  const producers: ClaimProducer[] = ["D2", "D2"].map((detectorId) => ({
    detectorId,
    produce: () => [
      {
        detectorId,
        workspaceId: WS,
        sessionId: "sess-bm2",
        turnKey: turnKey("sess-bm2", "msg-claimed"),
        component: "input" as const,
        slice: "turn:*",
        tokens: 100,
        // Spec F2 v2: spend-lane claims carry the rec id they price.
        recId: "rec-0",
      },
      {
        detectorId,
        workspaceId: WS,
        sessionId: "sess-bm2",
        turnKey: turnKey("sess-bm2", "msg-claimed"),
        component: "output" as const,
        slice: "turn:*",
        tokens: 20,
        recId: "rec-0",
      },
    ],
  }));
  const result = getEfficiencyHeadroom(db, { from: FROM, to: TO }, producers).data;
  expect(result?.headroom_u_per_wk).toBe(600);
  expect(result?.actual_u_per_wk).toBe(600);
  expect(result?.open_rec_count).toBe(1);
  expect(result?.unclaimed_rec_count).toBe(0);
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
  // P3.L L6: actual (4M) > 0 and headroom is 0 (no ledger claims), so pct is 0, not null.
  expect(r?.headroom_pct).toBe(0);
});

describe("whole spend lane with real priced claims (L6)", () => {
  // Sonnet-4 list prices, µ$/token: input 3, output 15.
  function insPricedTurn(messageId: string, input: number, output: number, costU: number): void {
    db.prepare(
      `INSERT OR IGNORE INTO pricing_snapshots
         (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
       VALUES ('snap-bm2', 'sonnet-4', '[3,15,0.3,3.75,6]', ?, ?)`,
    ).run(FROM, TO);
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain,
          input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
          cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u,
          cost_claim, provisional, parser_version)
       VALUES (?, 'sess-bm2', ?, ?, 'claude-sonnet-4-6', 0, ?, ?, 0, 0, 0, 0, 0, 'snap-bm2', ?,
               'LIST_EQUIV', 0, 'test-v1')`,
    ).run(messageId, WS, new Date(TO_MS - 60_000).toISOString(), input, output, costU);
  }
  const claimOf = (
    recId: string,
    messageId: string,
    component: "input" | "output",
    tokens: number,
  ) => ({
    detectorId: "D2",
    workspaceId: WS,
    sessionId: "sess-bm2",
    turnKey: turnKey("sess-bm2", messageId),
    component,
    slice: "turn:*",
    tokens,
    recId,
  });

  it("counts claims of ADOPTED and DISMISSED recs; exact pct and unclaimed_rec_count", () => {
    insRec("PROPOSED", 1_000_000); // rec-0: open, claims 100 input tokens = 300 µ$
    insRec("ADOPTED", 2_000_000); // rec-1: outside the fresh-PROPOSED set, claims 20 output = 300 µ$
    insRec("DISMISSED", 3_000_000); // rec-2: outside the set, claims 50 input = 150 µ$
    insRec("PROPOSED", 4_000_000); // rec-3: open, spend producer, no claim
    insPricedTurn("msg-a", 100, 0, 300);
    insPricedTurn("msg-b", 0, 20, 300);
    insPricedTurn("msg-c", 50, 0, 150);
    insPricedTurn("msg-d", 0, 0, 250); // billed, unclaimed
    const producers: ClaimProducer[] = [
      {
        detectorId: "D2",
        produce: () => [
          claimOf("rec-0", "msg-a", "input", 100),
          claimOf("rec-1", "msg-b", "output", 20),
          claimOf("rec-2", "msg-c", "input", 50),
        ],
      },
    ];
    const r = getEfficiencyHeadroom(db, { from: FROM, to: TO }, producers).data;
    expect(r?.headroom_u_per_wk).toBe(750); // 300 + 300 + 150: the whole lane, not just rec-0
    expect(r?.actual_u_per_wk).toBe(1000);
    expect(r?.headroom_u_per_wk).toBeLessThanOrEqual(r?.actual_u_per_wk ?? 0);
    expect(r?.headroom_pct).toBe(75);
    expect(r?.open_rec_count).toBe(2); // rec-0 and rec-3 (PROPOSED with savings)
    expect(r?.unclaimed_rec_count).toBe(1); // rec-3 only
  });

  it("excludes reliability-lane claims from headroom", () => {
    insRec("PROPOSED", 1_000_000);
    insPricedTurn("msg-a", 100, 0, 300);
    const producers: ClaimProducer[] = [
      {
        detectorId: "C9",
        produce: () => [
          {
            ...claimOf("rec-0", "msg-a", "input", 100),
            detectorId: "C9",
            lane: "reliability" as const,
          },
        ],
      },
    ];
    const r = getEfficiencyHeadroom(db, { from: FROM, to: TO }, producers).data;
    expect(r?.headroom_u_per_wk).toBe(0);
    expect(r?.headroom_pct).toBe(0);
  });
});
