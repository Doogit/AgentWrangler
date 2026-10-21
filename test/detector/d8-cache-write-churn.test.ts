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
import { cardTitle } from "../../src/query/api/rec-actions/index.js";
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
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;

    // Exactly 3 events: the at-boundary turn did NOT become a 4th churn event.
    expect(ev.churn_event_count).toBe(3);

    // The window-start anchor IS folded into the session's cap-weighted total:
    //   anchor 2000 + 0.1×5000 = 2500; warm 2_000_000; events 3×60_000 = 180_000.
    expect(ev.session_cap_weighted_tokens).toBe(2_182_500);
  });

  it("provisional turns are excluded from both the churn-event scan and the cap denominator", () => {
    mkSession("sess-edge");
    // A small first turn sets the fresh-start base (P3.1-T9) so the resumes stay avoidable.
    insEdgeTurn("msg-edgep-first", "2027-01-04T00:00:00.000Z", { input: 2000 });
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
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    // Still exactly 3 events; the provisional spike added neither an event nor cap tokens.
    expect(ev.churn_event_count).toBe(3);
    // cap total = 2000 + 2_000_000 + 3×60_000 (provisional 60_000 excluded)
    expect(ev.session_cap_weighted_tokens).toBe(2_182_000);
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

/** Give the session's warm anchor turn a priced cost, so the workspace has a known 7-day spend. */
function priceAnchor(sessionId: string, costU: number): void {
  db.prepare("UPDATE turns SET cost_equiv_u = ? WHERE session_id = ? AND ts = ?").run(
    costU,
    sessionId,
    new Date(BASE).toISOString(),
  );
}

describe("D8 — floors and gate as a share of spend (U7)", () => {
  it("counts a 20K-token resume when its write-minus-read cost is >= 0.1% of workspace spend", () => {
    mkSession("sess-small");
    insTurn("sess-small", 0, { input: 2000, cr: 5000 });
    for (let i = 1; i <= 3; i++) insTurn("sess-small", i * 10, { cw5m: 20_000, cr: 0 });
    // The old fixed 50K-token floor ignored these; each costs 20,000 x (3.75 - 0.3) = $0.069.
    priceAnchor("sess-small", 5_000_000);
    runDetectors(db, { now: NOW });
    const r = d8Recs()[0];
    if (!r) throw new Error("expected D8 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.churn_event_count).toBe(3);
  });

  it("drops resumes under 0.1% of workspace spend, and the card under 1%", () => {
    insChurnSession("sess-big-spend", 3);
    // $10,000 of priced work this week: three 60K re-writes ($0.21 each) are noise.
    priceAnchor("sess-big-spend", 10_000_000_000);
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D8")?.status).toBe("INACTIVE");
    expect(d8Recs()).toHaveLength(0);
  });

  it("reports an idle-gap histogram of the resumes", () => {
    insChurnSession("sess-hist", 3); // three 10-minute breaks
    runDetectors(db, { now: NOW });
    const r = d8Recs()[0];
    if (!r) throw new Error("expected D8 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.gap_5_15_min_count).toBe(3);
    expect(ev.gap_15_60_min_count).toBe(0);
    expect(ev.gap_60_240_min_count).toBe(0);
    expect(ev.gap_240_plus_min_count).toBe(0);
  });

  it("U9: lists the biggest resumes as session|time|gap|written|net labels", () => {
    insChurnSession("sess-top", 3);
    runDetectors(db, { now: NOW });
    const r = d8Recs()[0];
    if (!r) throw new Error("expected D8 rec");
    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    const rows = ev.top_resumes as string[];
    expect(rows).toHaveLength(3);
    // Each resume wrote 60,000 tokens; the 7,000-token base prompt is netted off.
    for (const row of rows) {
      const [session, at, gap, written, net] = row.split("|");
      expect(session).toBe("sess-top");
      expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number(gap)).toBe(10);
      expect(Number(written)).toBe(60_000);
      expect(Number(net)).toBe(53_000);
    }
  });
});

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
    // Sonnet cw5m price (snap-sonnet index 3) = 3.75 µUSD/token; cache read (index 2) = 0.3.
    // Net avoided price = write − read = 3.45 (a warm cache would have read these tokens).
    // write_u per event = 60000 * 3.45 = 207000 µUSD.
    // totalCreation = 3 * 60000 = 180000 tokens → blended net price = 3.45.
    // avoidableCapTokens = 180000 * 0.64 (D8_AVOIDANCE_FRACTION, operator 2026-09-28) = 115200.
    // P3.1-T9 S6: a fresh start writes the base prompt anyway. Base = the first turn's context,
    // 2000 + 5000 = 7000, so each resume nets 53000 → 159000 tokens.
    // savingsU = round(159000 * 0.64 * 3.45) = 351072 µUSD/wk.
    const EXPECTED_SAVINGS_U = 351072;
    expect(r.modeled_savings_u_per_wk).toBe(EXPECTED_SAVINGS_U);

    const formula = JSON.parse(r.modeled_formula_json as string) as Record<string, unknown>;
    expect(formula.formula_id).toBe("D8_CACHE_WRITE_CHURN_V1");
    expect(formula.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: EXPECTED_SAVINGS_U,
      summable: true,
    });

    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.session_count).toBe(1);
    expect(ev.session_ids).toEqual(["sess-churn"]);
    expect(
      db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get("sess-churn"),
    ).toBeDefined();
    expect(ev.churn_event_count).toBe(3);
    expect(ev.regime).toBe("5m"); // all creation is 5m-tier
    expect(ev.total_churn_creation_tokens).toBe(180_000);
    expect(ev.base_prefix_tokens).toBe(7_000);
    expect(ev.net_churn_creation_tokens).toBe(159_000);
    // The stored lever is the rec contract and stays; card review F8 retitles the card in cardTitle.
    expect(r.lever as string).toContain("/clear or /compact before a break");
    expect(
      cardTitle({ detector_id: "D8", lever: r.lever as string, evidence: {} } as Parameters<
        typeof cardTitle
      >[0]),
    ).toBe(
      "Run /clear (with a handoff if continuing) before a break longer than the cache lifetime.",
    );
  });

  it("keeps the structural firing contract stable across a model-tier switch", () => {
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
    // Net of the 7000-token base per resume (P3.1-T9): 159000 * 0.64 * (opus 18.75 − 1.5) = 1,755,360.
    expect(r.modeled_savings_u_per_wk).toBe(1_755_360);

    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.churn_event_count).toBe(3);
    expect(ev.total_churn_creation_tokens).toBe(180_000);
    expect(ev.regime).toBe("5m");
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

describe("D8 — per-thread gaps and TTL (P3.2)", () => {
  /** `thread`: false = main thread; a string = that subagent's agent_id; null = unattributed sidechain. */
  function insThreadTurn(
    sessionId: string,
    offsetMin: number,
    thread: false | string | null,
    f: { cr?: number; cw5m?: number; cw1h?: number; input?: number },
  ): void {
    const ts = new Date(BASE + offsetMin * 60_000).toISOString();
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model,
          is_sidechain, agent_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
          provisional, parser_version)
       VALUES (?, ?, 'ws-churn', ?, 'claude-sonnet', ?, ?, ?, 0, ?, ?, ?, 0, NULL, 'snap-sonnet', 0,
               'LIST_EQUIV', 0, 'test-v1')`,
    ).run(
      `msg-churn-${seq++}`,
      sessionId,
      ts,
      thread === false ? 0 : 1,
      thread === false ? null : thread,
      f.input ?? 0,
      f.cr ?? 0,
      f.cw5m ?? 0,
      f.cw1h ?? 0,
    );
  }

  it("measures the gap to the same thread, not an interleaved subagent turn", () => {
    mkSession("sess-thread");
    // Main thread on 1h tier: turns 70 min apart (> 60) are real idle churn …
    insThreadTurn("sess-thread", 0, false, { cw1h: 1_000 });
    for (let i = 1; i <= 3; i++) insThreadTurn("sess-thread", i * 70, false, { cw1h: 60_000 });
    // … and a subagent turn 2 min before each resume must not shorten that gap.
    for (let i = 1; i <= 3; i++) insThreadTurn("sess-thread", i * 70 - 2, "agent-a", { cr: 10 });
    runDetectors(db, { now: NOW });
    const r = d8Recs()[0];
    if (!r) throw new Error("expected D8 rec");
    expect(JSON.parse(r.evidence_json as string).facts.churn_event_count).toBe(3);
  });

  it("takes TTL from the thread's prior write tier, not the churn turn's tier", () => {
    mkSession("sess-tier");
    // Thread writes 1h → TTL 60 min, so the first 5m-tier spike 10 min later is inside
    // the TTL. From then on the thread's tier is 5m (TTL 5), so the next two are churn.
    insThreadTurn("sess-tier", 0, false, { cw1h: 1_000 });
    for (let i = 1; i <= 3; i++) insThreadTurn("sess-tier", i * 10, false, { cw5m: 60_000 });
    runDetectors(db, { now: NOW });
    const r = d8Recs()[0];
    if (!r) throw new Error("expected D8 rec");
    expect(JSON.parse(r.evidence_json as string).facts.churn_event_count).toBe(2);
  });

  it("leaves subagent-only churn out: a subagent cannot run /clear (review 3 B6)", () => {
    mkSession("sess-sub");
    insThreadTurn("sess-sub", 0, "agent-a", { cw5m: 1_000 });
    for (let i = 1; i <= 3; i++) insThreadTurn("sess-sub", i * 10, "agent-a", { cw5m: 60_000 });
    runDetectors(db, { now: NOW });
    expect(d8Recs()).toHaveLength(0);
  });

  it("counts only the main thread's resumes when subagents churn in the same session", () => {
    mkSession("sess-agents");
    // Main: 3 resumes 70 min apart (> 1h TTL). agent-a: 3 spikes 10 min apart (> 5m TTL),
    // which the old count added for 6 events.
    insThreadTurn("sess-agents", 0, false, { cw1h: 1_000 });
    insThreadTurn("sess-agents", 0, "agent-a", { cw5m: 1_000 });
    for (let i = 1; i <= 3; i++) {
      insThreadTurn("sess-agents", i * 70, false, { cw1h: 60_000 });
      insThreadTurn("sess-agents", i * 10, "agent-a", { cw5m: 60_000 });
    }
    runDetectors(db, { now: NOW });
    const r = d8Recs()[0];
    if (!r) throw new Error("expected D8 rec");
    const facts = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(facts.churn_event_count).toBe(3);
    expect(facts.total_churn_creation_tokens).toBe(180_000);
  });

  it("stores sessions by how much they wrote again, most first (review 3 B8)", () => {
    mkSession("sess-a-small");
    mkSession("sess-b-large");
    insThreadTurn("sess-a-small", 0, false, { cw1h: 1_000 });
    insThreadTurn("sess-b-large", 0, false, { cw1h: 1_000 });
    for (let i = 1; i <= 2; i++) {
      insThreadTurn("sess-a-small", i * 70, false, { cw1h: 60_000 });
      insThreadTurn("sess-b-large", i * 70, false, { cw1h: 90_000 });
    }
    runDetectors(db, { now: NOW });
    const r = d8Recs()[0];
    if (!r) throw new Error("expected D8 rec");
    expect(JSON.parse(r.evidence_json as string).facts.session_ids).toEqual([
      "sess-b-large",
      "sess-a-small",
    ]);
  });

  it("never measures a gap for unattributed sidechain turns (agent_id NULL)", () => {
    mkSession("sess-unattr");
    insThreadTurn("sess-unattr", 0, null, { cw5m: 1_000 });
    for (let i = 1; i <= 3; i++) insThreadTurn("sess-unattr", i * 10, null, { cw5m: 60_000 });
    runDetectors(db, { now: NOW });
    expect(d8Recs()).toHaveLength(0);
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

// ── Helpers for a second workspace ───────────────────────────────────────────

function mkSessionForWs(id: string, wsId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2027-01-02T00:00:00.000Z', '2027-01-02T00:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(id, wsId, `/fake/${id}.jsonl`);
}

function insTurnForWs(
  sessionId: string,
  wsId: string,
  offsetMin: number,
  f: {
    input?: number;
    cr?: number;
    cw5m?: number;
    model?: string;
    pricingSnapshotId?: string;
  },
): void {
  const {
    input = 0,
    cr = 0,
    cw5m = 0,
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
     VALUES (?, ?, ?, ?, ?,
             0, ?, 0, ?, ?, 0, 0, NULL, ?, 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(`msg-churn-${seq++}`, sessionId, wsId, ts, model, input, cr, cw5m, pricingSnapshotId);
}

function insChurnSessionForWs(sessionId: string, n: number, wsId: string): void {
  mkSessionForWs(sessionId, wsId);
  insTurnForWs(sessionId, wsId, 0, { input: 2000, cr: 5000 });
  for (let i = 1; i <= n; i++) {
    insTurnForWs(sessionId, wsId, i * 10, { cw5m: 60_000 });
  }
}

// ── Workspace-level rollup ────────────────────────────────────────────────────

describe("D8 — workspace-level rollup", () => {
  it("two churn sessions in one workspace emit exactly one D8 rec", () => {
    insChurnSession("sess-a", 3);
    insChurnSession("sess-b", 3);
    runDetectors(db, { now: NOW });

    const recs = d8Recs();
    expect(recs.length).toBe(1);
    const r = recs[0];
    if (!r) throw new Error("expected one D8 rec");

    const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
    expect(ev.session_count).toBe(2);
    expect(ev.session_ids).toEqual(["sess-a", "sess-b"]); // sorted ascending

    // Combined: 6 events; totalCreation = 2 × 3 × 60000 = 360000 tokens.
    expect(ev.churn_event_count).toBe(6);

    // session_cap_weighted_tokens = sum of both sessions' cap-weighted totals.
    // Each insChurnSession(n=3): anchor (input=2000 + 0.1×cr5000=500) + 3×cw5m60000=180000 → 182500.
    // Total = 182500 + 182500 = 365000.
    expect(ev.session_cap_weighted_tokens).toBe(365000);

    // Net of the 7000-token base per resume (P3.1-T9): 6 × 53000 = 318000 tokens.
    // savingsU = 318000 × 0.64 × (3.75 − 0.3) = 702144 µUSD/wk.
    expect(r.modeled_savings_u_per_wk).toBe(702144);
  });

  it("two churn sessions in two workspaces emit exactly two D8 recs", () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-churn2','ws-churn2','2027-01-01T00:00:00.000Z')`,
    ).run();

    insChurnSession("sess-ws1", 3); // goes to ws-churn
    insChurnSessionForWs("sess-ws2", 3, "ws-churn2"); // goes to ws-churn2

    runDetectors(db, { now: NOW });

    const recs = d8Recs();
    expect(recs.length).toBe(2);
    expect((recs.map((r) => r.scope_workspace_id) as string[]).sort()).toEqual([
      "ws-churn",
      "ws-churn2",
    ]);

    for (const r of recs) {
      const ev = JSON.parse(r.evidence_json as string).facts as Record<string, unknown>;
      expect(ev.session_count).toBe(1);
      expect(ev.churn_event_count).toBe(3);
    }
  });
});
