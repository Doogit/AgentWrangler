/**
 * test/query/headroom-overlap-guard.test.ts — the composition guard the per-detector
 * golden structurally cannot provide.
 *
 * The detector pass still assigns modeled economics to B1 rather than B2, and
 * leaves C5 unpriced. Addressable spend follows owned ledger claims in the
 * selected window; these recommendations have none.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b1Detector } from "../../src/detector/detectors/b1_cache_read_collapse.js";
import { b2Detector } from "../../src/detector/detectors/b2_cache_ttl_gap.js";
import { c5Detector } from "../../src/detector/detectors/c5_same_error_loop.js";
import { runDetectors } from "../../src/detector/engine.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { getEfficiencyHeadroom } from "../../src/query/api/efficiency-headroom.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};
const SONNET4_PRICES = "[3,15,0.3,3.75,6]";

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-hg-sonnet', 'sonnet-4', ?, '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run(SONNET4_PRICES);
});
afterEach(() => db.close());

function insWorkspaceSession(workspaceId: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(workspaceId, workspaceId);
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2027-01-02T09:00:00.000Z', '2027-01-02T12:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fixture/${sessionId}.jsonl`);
}

function insTurn(
  workspaceId: string,
  sessionId: string,
  ts: string,
  opts: { cacheReadTokens?: number; cacheWrite5m?: number; outputTokens?: number } = {},
): string {
  const messageId = `msg-hg-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0,
             0, ?, ?, ?, 0, 0, 0, 'snap-hg-sonnet',
             0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    workspaceId,
    ts,
    opts.outputTokens ?? 0,
    opts.cacheReadTokens ?? 0,
    opts.cacheWrite5m ?? 0,
  );
  return messageId;
}

function persistedSavings(detectorId: string): (number | null)[] {
  return (
    db
      .prepare(
        `SELECT modeled_savings_u_per_wk AS s FROM recommendations
          WHERE detector_id = ? AND state = 'PROPOSED'`,
      )
      .all(detectorId) as { s: number | null }[]
  ).map((r) => r.s);
}

describe("headroom overlap guard", () => {
  it("B1/B2 collapse: in-TTL → B1 owns the $, idle → B2 persists null, never both", () => {
    const WS = "ws-hg-collapse";
    const SESS = "hg-collapse-sess";
    insWorkspaceSession(WS, SESS);
    // A fresh session starts by writing only its 30k base prefix; B2 subtracts that as
    // what any fresh start writes anyway.
    insTurn(WS, SESS, "2027-01-02T08:58:00.000Z", { cacheWrite5m: 30_000 });
    // Idle collapse, 70 min apart (> TTL) → B2 only (null label; idle $ is D8's).
    insTurn(WS, SESS, "2027-01-02T09:00:00.000Z", {
      cacheReadTokens: 200_000,
      cacheWrite5m: 100_000,
    });
    // A collapse writes the previous 300k context again (shared predicate: creation ≥ 0.5×
    // previous context, context not shrunk), so both collapse turns re-create 300k.
    insTurn(WS, SESS, "2027-01-02T10:10:00.000Z", {
      cacheReadTokens: 2_000,
      cacheWrite5m: 300_000,
    });
    // In-TTL collapse, 3 min apart → B1 only (P3.2: B1 = prefix change inside the TTL).
    insTurn(WS, SESS, "2027-01-03T09:00:00.000Z", {
      cacheReadTokens: 200_000,
      cacheWrite5m: 100_000,
    });
    insTurn(WS, SESS, "2027-01-03T09:03:00.000Z", {
      cacheReadTokens: 2_000,
      cacheWrite5m: 300_000,
    });

    runDetectors(db, CTX, [b1Detector, b2Detector]);

    const b1 = persistedSavings("B1");
    const b2 = persistedSavings("B2");
    expect(b1).toHaveLength(1);
    expect(b1[0]).not.toBeNull();
    expect(b2).toHaveLength(1);
    expect(b2[0]).toBeNull(); // MED-1: B2 is a null label.
    const anchors = (id: string) =>
      (
        db.prepare("SELECT evidence_json FROM recommendations WHERE detector_id = ?").get(id) as {
          evidence_json: string;
        }
      ).evidence_json;
    expect(anchors("B1")).toContain("2027-01-03T09:03:00.000Z");
    expect(anchors("B1")).not.toContain("2027-01-02T10:10:00.000Z");
    expect(anchors("B2")).toContain("2027-01-02T10:10:00.000Z");

    const headroom = getEfficiencyHeadroom(db, { from: CTX.fromIso, to: CTX.toIso }).data;
    // B1 (P3.L L4) owns the in-TTL collapse turn's cw5m cell, repriced to the read price:
    // round(300k × 0.5) × (3.75 − 0.30) = 517,500 µ$. D8's producer owns the idle resume:
    // round((300k − 30k base) × 0.64) × 3.45 = 172,800 × 3.45 = 596,160 µ$.
    // B2 (null label) owns nothing: 517,500 + 596,160 = 1,113,660.
    expect(headroom?.headroom_u_per_wk).toBe(1_113_660);
    expect(headroom?.open_rec_count).toBe(1);
    expect(headroom?.unclaimed_rec_count).toBe(0);
  });

  it("C5 loop: C5 persists null so it contributes nothing to the headroom SUM", () => {
    const WS = "ws-hg-loop";
    const SESS = "hg-loop-sess";
    insWorkspaceSession(WS, SESS);
    // 5 identical Bash errors, one per turn → C5 loop cluster (D7 owns loop economics).
    // C5 counts distinct owner turns: parallel calls inside one turn are not retries.
    // A shell call that ran reports "Exit code N"; without it C5 F32 treats the call as never-ran.
    const ERR = "Exit code 1\nFile not found: /tmp/target";
    for (let i = 0; i < 5; i++) {
      const msgId = insTurn(WS, SESS, `2027-01-02T10:0${i}:00.000Z`, { outputTokens: 500 });
      const eventId = `evt-hg-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, exit_class,
            tool_error_class, tool_error_classifier_version, input_bytes, result_bytes)
         VALUES (?, ?, '2027-01-02T10:00:00.000Z', 'Bash', 'ERROR',
                 'NOT_FOUND', 'tool-error-1', 17000, 17000)`,
      ).run(eventId, SESS);
      db.prepare(
        `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
         VALUES (?, ?, ?, 0)`,
      ).run(eventId, msgId, i);
      db.prepare(
        `INSERT INTO tool_event_content (event_id, content_json)
         VALUES (?, ?)`,
      ).run(eventId, JSON.stringify({ error: ERR }));
    }

    runDetectors(db, CTX, [c5Detector]);

    const c5 = persistedSavings("C5");
    expect(c5).toHaveLength(1);
    expect(c5[0]).toBeNull(); // MED-3: D7 owns loop economics, C5 is a null label.

    // C5's null keeps it out of the headroom SUM (D7 is the sole loop owner). D7's own
    // pricing of a covered loop is exercised by the d7 integration tests; here the guard
    // is that C5 adds nothing — if C5 regressed to non-null the loop would be counted twice.
    const headroom = getEfficiencyHeadroom(db, { from: CTX.fromIso, to: CTX.toIso }).data;
    expect(headroom?.headroom_u_per_wk).toBe(0);
    expect(headroom?.open_rec_count).toBe(0);
  });
});
