/**
 * test/detector/d8-cache-write-churn.test.ts — D8 CACHE_WRITE_CHURN (flagship).
 *
 * A churn event = a resume turn with a ≥50k cache-creation spike after an idle
 * gap past the TTL, with low cache_read (a full re-write, not a warm read).
 * Fires per-session when events ≥ 3/wk OR their creation is ≥ 15% of the
 * session's cap-weighted total.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Window 2027 so fixture (2026) turns never leak in.
const NOW = new Date("2027-01-08T00:00:00.000Z");
const BASE = new Date("2027-01-02T00:00:00.000Z").getTime();

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-churn','ws-churn','2027-01-01T00:00:00.000Z')`,
  ).run();
  // Match opus turns to opus write prices so the savings assertion remains meaningful.
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-opus', 'opus', '[15,75,1.5,18.75,30]', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

function mkSession(id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-churn', ?, '2027-01-02T00:00:00.000Z', '2027-01-02T00:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(id, `/fake/${id}.jsonl`);
}

let seq = 0;
function insTurn(
  sessionId: string,
  offsetMin: number,
  f: {
    input?: number;
    cr?: number;
    cw5m?: number;
    cw1h?: number;
    cwOther?: number;
    model?: string;
    pricingSnapshotId?: string;
  },
): void {
  const {
    input = 0,
    cr = 0,
    cw5m = 0,
    cw1h = 0,
    cwOther = 0,
    model = "claude-sonnet",
    pricingSnapshotId = "snap-sonnet",
  } = f;
  const ts = new Date(BASE + offsetMin * 60_000).toISOString();
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, 'ws-churn', ?, ?,
             0, ?, 0, ?, ?, ?, ?, NULL, ?, 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(
    `msg-churn-${seq++}`,
    sessionId,
    ts,
    model,
    input,
    cr,
    cw5m,
    cw1h,
    cwOther,
    pricingSnapshotId,
  );
}

// ── Window-boundary + provisional edge cases ─────────────────────────────────

function d8Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id='D8' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

describe("D8 — window boundaries and provisional exclusion", () => {
  function insEdgeTurn(
    msgId: string,
    ts: string,
    f: { input?: number; cr?: number; cw5m?: number; provisional?: number },
  ): void {
    const { input = 0, cr = 0, cw5m = 0, provisional = 0 } = f;
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model,
          is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
          provisional, parser_version)
       VALUES (?, 'sess-edge', 'ws-churn', ?, 'claude-sonnet',
               0, ?, 0, ?, ?, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
    ).run(msgId, ts, input, cr, cw5m, provisional);
  }

  it("first turn AT the window start counts, last turn AT the window end does NOT (half-open)", () => {
    // NOW = 2027-01-08T00:00Z → ctx window [2027-01-01T00:00Z, 2027-01-08T00:00Z).
    mkSession("sess-edge");
    // Anchor EXACTLY at the window start (inclusive lower bound).
    insEdgeTurn("msg-edge-anchor", "2027-01-01T00:00:00.000Z", { input: 2000, cr: 5000 });
    // Big warm turn keeps creation share well under the 15% gate so firing
    // depends on the ≥3-events count alone.
    insEdgeTurn("msg-edge-warm", "2027-01-03T00:00:00.000Z", { input: 2_000_000 });
    // Three churn events inside the window.
    insEdgeTurn("msg-edge-e1", "2027-01-07T23:30:00.000Z", { cw5m: 60_000 });
    insEdgeTurn("msg-edge-e2", "2027-01-07T23:40:00.000Z", { cw5m: 60_000 });
    insEdgeTurn("msg-edge-e3", "2027-01-07T23:50:00.000Z", { cw5m: 60_000 });
    // A fourth would-be event EXACTLY at the upper bound — [from, to) excludes it.
    insEdgeTurn("msg-edge-at-now", "2027-01-08T00:00:00.000Z", { cw5m: 60_000 });

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D8")?.status).toBe("ACTIVE");

    const recs = d8Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D8 rec");
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;

    // Exactly 3 events: the at-boundary turn did NOT become a 4th churn event.
    expect(ev.churn_event_count).toBe(3);

    // The window-start anchor IS folded into the session's cap-weighted total:
    //   anchor 2000 + 0.1×5000 = 2500; warm 2_000_000; events 3×60_000 = 180_000.
    expect(ev.session_cap_weighted_tokens).toBe(2_182_500);
  });

  it("provisional turns are excluded from both the churn-event scan and the cap denominator", () => {
    mkSession("sess-edge");
    insEdgeTurn("msg-edgep-warm", "2027-01-05T00:00:00.000Z", { input: 2_000_000 });
    insEdgeTurn("msg-edgep-e1", "2027-01-07T23:30:00.000Z", { cw5m: 60_000 });
    insEdgeTurn("msg-edgep-e2", "2027-01-07T23:40:00.000Z", { cw5m: 60_000 });
    // Provisional spike between e1 and e2 — must be invisible to D8 entirely.
    insEdgeTurn("msg-edgep-prov", "2027-01-07T23:35:00.000Z", { cw5m: 60_000, provisional: 1 });
    insEdgeTurn("msg-edgep-e3", "2027-01-07T23:50:00.000Z", { cw5m: 60_000 });

    runDetectors(db, { now: NOW });

    const recs = d8Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D8 rec");
    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    // Still exactly 3 events; the provisional spike added neither an event nor cap tokens.
    expect(ev.churn_event_count).toBe(3);
    // cap total = 2_000_000 + 3×60_000 (provisional 60_000 excluded)
    expect(ev.session_cap_weighted_tokens).toBe(2_180_000);
  });
});

/** A warm anchor turn + `n` resume-spike churn events (each 10-min gap, 5m-dominant). */
function insChurnSession(sessionId: string, n: number): void {
  mkSession(sessionId);
  insTurn(sessionId, 0, { input: 2000, cr: 5000 }); // warm anchor
  for (let i = 1; i <= n; i++) {
    insTurn(sessionId, i * 10, { cw5m: 60_000, cr: 0 }); // gap 10min > 5, creation 60k, read 0
  }
}

describe("D8 — fires on cache-write churn", () => {
  it("fires per session when ≥ 3 churn events occur", () => {
    insChurnSession("sess-churn", 3);
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D8")?.status).toBe("ACTIVE");

    const recs = d8Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D8 rec");
    expect(r.category).toBe("CACHE");
    expect(r.scope_workspace_id).toBe("ws-churn");

    // ── Formula-equality check (computed independently from fixture values) ──
    //
    // insChurnSession: 3 events, each cw5m=60000 tokens.
    // Sonnet cw5m price (snap-sonnet index 3) = $3.75/MTok = 3.75 µUSD/token.
    // write_u per event = 60000 * 3.75 = 225000 µUSD.
    // totalCreation = 3 * 60000 = 180000 tokens.
    // blendedWritePrice = (3 * 225000) / 180000 = 3.75.
    // avoidableCapTokens = 180000 * 0.7 (D8_AVOIDANCE_FRACTION) = 126000.
    // savingsU = round(126000 * 3.75) = round(472500) = 472500 µUSD/wk.
    // result_usd_per_wk = (472500/1e6).toFixed(2) = 0.47.
    const EXPECTED_SAVINGS_U = 472500;
    const EXPECTED_RESULT_USD = 0.47;

    expect(r.modeled_savings_u_per_wk).toBe(EXPECTED_SAVINGS_U);

    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.model).toBe("D8_CACHE_WRITE_CHURN_V1");
    expect(formula.result_usd_per_wk).toBe(EXPECTED_RESULT_USD);

    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.session_id).toBe("sess-churn");
    expect(ev.churn_event_count).toBe(3);
    expect(ev.thresholds_unvalidated).toBe(true);
    expect(ev.modeled_savings_basis).toBe("LIST_EQUIV");
    expect(ev.billed_cost_claim).toBe("UNAVAILABLE");
    expect(Array.isArray(ev.events)).toBe(true);
    expect((ev.events as unknown[]).length).toBe(3);
    expect(ev.regime).toBe("5m"); // all creation is 5m-tier
    expect(ev.cause_facets).toEqual({
      idle_gap: true,
      model_switch: false,
      session_reopen: "UNOBSERVABLE",
      prefix_config_change: "UNOBSERVABLE",
      dynamic_content: "UNOBSERVABLE",
    });
    for (const event of ev.events as Array<Record<string, unknown>>) {
      expect(event.cause_facets).toEqual({
        idle_gap: true,
        model_switch: false,
        session_reopen: "UNOBSERVABLE",
        prefix_config_change: "UNOBSERVABLE",
        dynamic_content: "UNOBSERVABLE",
      });
    }
    expect(r.lever as string).toContain("ENABLE_PROMPT_CACHING_1H");
  });

  it("annotates model-tier switches per churn event without changing the firing contract", () => {
    mkSession("sess-model-switch");
    insTurn("sess-model-switch", 0, { input: 2000, cr: 5000, model: "claude-sonnet" });
    insTurn("sess-model-switch", 10, {
      cw5m: 60_000,
      model: "claude-opus",
      pricingSnapshotId: "snap-opus",
    });
    insTurn("sess-model-switch", 20, {
      cw5m: 60_000,
      model: "claude-opus",
      pricingSnapshotId: "snap-opus",
    });
    insTurn("sess-model-switch", 30, {
      cw5m: 60_000,
      model: "claude-opus",
      pricingSnapshotId: "snap-opus",
    });

    runDetectors(db, { now: NOW });

    const recs = d8Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected D8 rec");
    expect(r.modeled_savings_u_per_wk).toBe(2_362_500);

    const ev = JSON.parse(r.evidence_json as string) as Record<string, unknown>;
    expect(ev.churn_event_count).toBe(3);
    expect(ev.cause_facets).toEqual({
      idle_gap: true,
      model_switch: true,
      session_reopen: "UNOBSERVABLE",
      prefix_config_change: "UNOBSERVABLE",
      dynamic_content: "UNOBSERVABLE",
    });

    const events = ev.events as Array<Record<string, unknown>>;
    expect(events[0]?.cause_facets).toEqual({
      idle_gap: true,
      model_switch: true,
      session_reopen: "UNOBSERVABLE",
      prefix_config_change: "UNOBSERVABLE",
      dynamic_content: "UNOBSERVABLE",
    });
    expect(events[1]?.cause_facets).toEqual({
      idle_gap: true,
      model_switch: false,
      session_reopen: "UNOBSERVABLE",
      prefix_config_change: "UNOBSERVABLE",
      dynamic_content: "UNOBSERVABLE",
    });
    expect(events[2]?.cause_facets).toEqual({
      idle_gap: true,
      model_switch: false,
      session_reopen: "UNOBSERVABLE",
      prefix_config_change: "UNOBSERVABLE",
      dynamic_content: "UNOBSERVABLE",
    });
  });

  it("fires on the creation-share gate with only 2 events (churn dominates the session)", () => {
    insChurnSession("sess-share", 2); // 2 events, but creation ≈ whole session → share ≥ 15%
    runDetectors(db, { now: NOW });
    expect(d8Recs().length).toBe(1);
  });
});

describe("D8 — stays quiet", () => {
  it("does not fire when the idle gap is within the TTL", () => {
    mkSession("sess-fast");
    insTurn("sess-fast", 0, { input: 2000, cr: 5000 });
    for (let i = 1; i <= 3; i++) insTurn("sess-fast", i * 2, { cw5m: 60_000, cr: 0 }); // gap 2min < 5
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D8")?.status).toBe("INACTIVE");
    expect(d8Recs().length).toBe(0);
  });

  it("does not fire when creation is below the spike floor", () => {
    mkSession("sess-small");
    insTurn("sess-small", 0, { input: 2000, cr: 5000 });
    for (let i = 1; i <= 3; i++) insTurn("sess-small", i * 10, { cw5m: 10_000, cr: 0 }); // < 50k
    runDetectors(db, { now: NOW });
    expect(d8Recs().length).toBe(0);
  });

  it("does not fire on a warm read (high cache_read relative to creation)", () => {
    mkSession("sess-warm");
    insTurn("sess-warm", 0, { input: 2000, cr: 5000 });
    for (let i = 1; i <= 3; i++) insTurn("sess-warm", i * 10, { cw5m: 60_000, cr: 55_000 }); // read ≥ 0.2×
    runDetectors(db, { now: NOW });
    expect(d8Recs().length).toBe(0);
  });

  it("does not fire with 2 events when churn creation is a small share", () => {
    mkSession("sess-dilute");
    insTurn("sess-dilute", 0, { input: 10_000_000 }); // huge non-churn volume dilutes the share
    insTurn("sess-dilute", 10, { cw5m: 60_000, cr: 0 });
    insTurn("sess-dilute", 20, { cw5m: 60_000, cr: 0 }); // 2 events, share ≪ 15%
    runDetectors(db, { now: NOW });
    expect(d8Recs().length).toBe(0);
  });
});

describe("D8 — determinism", () => {
  it("two passes over the same frozen DB yield identical rows", () => {
    insChurnSession("sess-det", 3);
    runDetectors(db, { now: NOW });
    const first = d8Recs();
    runDetectors(db, { now: NOW });
    expect(d8Recs()).toEqual(first);
  });
});
