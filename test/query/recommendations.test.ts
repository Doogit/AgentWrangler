/**
 * test/query/recommendations.test.ts — listRecommendations envelope + grouping.
 *
 * Runs the DetectorEngine over a seeded fixture DB (with qualifying long-context
 * sessions so D2 fires), then asserts the grouped RecommendationsView, the live
 * detectors[] strip, and the EXPERIMENTAL envelope.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import {
  ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U,
  MINOR_ITEMS_GROUP_ID,
  deriveActiveGroups,
  dismissRecommendation,
  getRecommendationCard,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import type { RecommendationCard } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// The detectors[] strip is evaluated live (at real `now`), so seed the qualifying
// sessions inside the live trailing-7d window (2 days ago) and run the persist
// pass at the same `now` — so both the persisted rec and the live D2 status agree.
const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

let db: Database.Database;

function makeRecommendation(overrides: Partial<RecommendationCard> = {}): RecommendationCard {
  return {
    rec_id: "rec-test",
    detector_id: "D2",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "Test recommendation",
    modeled_savings_u_per_wk: 2_000_000,
    run_cost_u: null,
    modeled_formula: { model: "TEST", inputs: {} },
    evidence: {},
    target_metric: "test_metric",
    state: "PROPOSED",
    created_at: RECENT,
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  // 3 qualifying long-context sessions → D2 fires.
  for (let i = 1; i <= 3; i++) {
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
  runDetectors(db, { now: NOW });
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("listRecommendations", () => {
  it("groups active recs and attaches the EXPERIMENTAL envelope", () => {
    const res = listRecommendations();
    expect(res.meta.claim_kind).toBe("EXPERIMENTAL");
    expect(res.meta.metric_definition_version).toBe("observe-1");

    const view = res.data;
    if (view === null) throw new Error("null data");
    expect(view.active.length).toBe(1);
    expect(view.adopted).toEqual([]);
    expect(view.dismissed).toEqual([]);
    expect(res.meta.n).toBe(1);

    const d2 = view.active[0];
    if (d2 === undefined) throw new Error("missing active rec");
    expect(d2.detector_id).toBe("D2");
    expect(d2.state).toBe("PROPOSED");
    expect(d2.modeled_savings_u_per_wk).toBe(8_969_400);
    expect(d2.modeled_formula.model).toBe("D2_LONG_CONTEXT_CACHE_READ_V1");
    expect(d2.modeled_formula.inputs.reduction_fraction).toBe(0.33);
    expect(Array.isArray(d2.evidence.session_ids)).toBe(true);
    // title-from-evidence: D2 emits title in evidence; toCard() surfaces it.
    expect(d2.title).toBe("Shorten sessions: 3 long-context runs this week");

    expect(view.active_groups).toHaveLength(1);
    expect(view.active_groups[0]).toMatchObject({
      detector_id: "D2",
      label: "Session hygiene",
      recs: [d2],
      session_count: 3,
      total_savings_u_per_wk: 8_969_400,
    });
  });

  it("groups same-detector session recs, preserves family order, and floors minor savings", () => {
    const insert = db.prepare(
      `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES (?, 'RULE', ?, ?, 'ws-alpha', ?, ?, '{"model":"X","inputs":{}}', ?,
          'metric', 'PROPOSED', datetime('now'), NULL)`,
    );
    insert.run(
      "rec-d8-session-1",
      "D8",
      "CACHE",
      "Avoid the first cache rewrite",
      1_500_000,
      '{"session_id":"sess-d8-1"}',
    );
    insert.run(
      "rec-d8-session-2",
      "D8",
      "CACHE",
      "Avoid another cache rewrite",
      2_500_000,
      '{"session_id":"sess-d8-2"}',
    );
    insert.run(
      "rec-d8-minor",
      "D8",
      "CACHE",
      "Small cache rewrite",
      999_999,
      '{"session_id":"sess-d8-minor"}',
    );

    const view = listRecommendations("ws-alpha").data;
    if (view === null) throw new Error("null data");

    const d8 = view.active_groups.find((group) => group.detector_id === "D8");
    expect(d8).toMatchObject({
      detector_id: "D8",
      label: "Cache misses",
      session_count: 2,
      total_savings_u_per_wk: 4_000_000,
    });
    expect(d8?.recs.map((rec) => rec.rec_id)).toEqual(["rec-d8-session-2", "rec-d8-session-1"]);

    expect(view.active.map((rec) => rec.rec_id)).toContain("rec-d8-minor");
    // Minor (sub-floor) items are segregated into their own MINOR_ITEMS group
    // within active_groups — not mixed into the real detector group.
    const minorGroup = view.active_groups.find((group) => group.detector_id === "MINOR_ITEMS");
    expect(minorGroup?.recs.map((rec) => rec.rec_id)).toEqual(["rec-d8-minor"]);
    expect(d8?.recs.map((rec) => rec.rec_id)).not.toContain("rec-d8-minor");

    // D8 is the first detector family in the existing article-priority order;
    // the additive grouping retains that order rather than sorting labels.
    expect(view.active_groups[0]?.detector_id).toBe("D8");
  });

  it("reports the live detector status strip with D7 evaluated and D3 retired", () => {
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    const byId = Object.fromEntries(view.detectors.map((d) => [d.detector_id, d]));
    expect(byId.D2?.status).toBe("ACTIVE");
    expect(byId.D1?.status).toBe("NOT_EVALUATED"); // no context_inventory
    expect(byId.D5?.status).toBe("ACTIVE"); // AU5: no limit + burn history → degraded trend (not bare BLOCKED)
    // These are evaluated detectors; the plain fixture DB trips none → INACTIVE.
    for (const id of ["D4", "D6", "D8", "D9"]) {
      expect(byId[id]?.status).toBe("INACTIVE");
    }
    expect(byId.D7?.status).toBe("NOT_EVALUATED");
    // Retired spec-D3 no longer appears.
    expect(byId.D3).toBeUndefined();
  });

  it("scopes to a workspace + global recs when a scope is given", () => {
    // D2 is global (scope null) → always included under a workspace scope.
    const res = listRecommendations("ws-alpha");
    expect(res.meta.drilldown_ids.workspace_id).toBe("ws-alpha");
    expect(res.data?.active.length).toBe(1);
  });

  it("surfaces numeric and zero run costs while preserving null for unlinked or unmetered runs", () => {
    const recId = listRecommendations().data?.active[0]?.rec_id;
    if (recId === undefined) throw new Error("missing active rec");

    expect(getRecommendationCard(recId)?.run_cost_u).toBeNull();

    db.prepare(
      `INSERT INTO analysis_runs
         (run_id, scope, model, prompt_version, evidence_pack_hash, content_included,
          input_tokens, output_tokens, cost_equiv_u, contract_valid, ran_at)
       VALUES ('run-cost-test', 'GLOBAL', 'claude-sonnet', 'test-v1', 'hash', 0,
               NULL, NULL, NULL, 1, ?)`,
    ).run(RECENT);
    db.prepare("UPDATE recommendations SET analysis_run_id = 'run-cost-test' WHERE rec_id = ?").run(
      recId,
    );

    expect(getRecommendationCard(recId)?.run_cost_u).toBeNull();

    db.prepare("UPDATE analysis_runs SET cost_equiv_u = 0 WHERE run_id = 'run-cost-test'").run();
    expect(getRecommendationCard(recId)?.run_cost_u).toBe(0);

    db.prepare(
      "UPDATE analysis_runs SET cost_equiv_u = 1250000 WHERE run_id = 'run-cost-test'",
    ).run();
    expect(getRecommendationCard(recId)?.run_cost_u).toBe(1_250_000);
    expect(listRecommendations().data?.active[0]?.run_cost_u).toBe(1_250_000);
  });
});

describe("active recommendation grouping", () => {
  it("groups recommendations by detector and keeps the active cards unchanged", () => {
    const d2a = makeRecommendation({
      rec_id: "rec-d2-a",
      detector_id: "D2",
      evidence: { session_ids: ["session-1", "session-2"] },
      modeled_savings_u_per_wk: 2_000_000,
    });
    const d2b = makeRecommendation({
      rec_id: "rec-d2-b",
      detector_id: "D2",
      evidence: { session_id: "session-2" },
      modeled_savings_u_per_wk: 3_000_000,
    });
    const d8 = makeRecommendation({
      rec_id: "rec-d8",
      detector_id: "D8",
      evidence: { session_id: "session-3" },
      modeled_savings_u_per_wk: 4_000_000,
    });
    const active = [d2a, d2b, d8];

    const groups = deriveActiveGroups(active);

    expect(active).toEqual([d2a, d2b, d8]);
    expect(groups.map((group) => group.detector_id)).toEqual(["D2", "D8"]);
    expect(groups[0]).toMatchObject({
      label: "Session hygiene",
      recs: [d2a, d2b],
      session_count: 2,
      total_savings_u_per_wk: 5_000_000,
    });
    expect(groups[1]).toMatchObject({
      label: "Cache misses",
      recs: [d8],
      session_count: 1,
      total_savings_u_per_wk: 4_000_000,
    });
  });

  it("puts only modeled values below the floor into the final minor-items group", () => {
    const belowFloor = makeRecommendation({
      rec_id: "rec-below-floor",
      detector_id: "D1",
      modeled_savings_u_per_wk: ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U - 1,
    });
    const atFloor = makeRecommendation({
      rec_id: "rec-at-floor",
      detector_id: "D2",
      modeled_savings_u_per_wk: ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U,
    });
    const directional = makeRecommendation({
      rec_id: "rec-directional",
      detector_id: "D6",
      modeled_savings_u_per_wk: null,
    });

    const groups = deriveActiveGroups([belowFloor, atFloor, directional]);
    const minor = groups.find((group) => group.detector_id === MINOR_ITEMS_GROUP_ID);

    expect(minor).toMatchObject({
      label: "Minor items",
      recs: [belowFloor],
      total_savings_u_per_wk: ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U - 1,
    });
    expect(groups.map((group) => group.detector_id)).toEqual(["D2", "D6", MINOR_ITEMS_GROUP_ID]);
  });

  it("preserves first-seen detector-family order and appends minor items last", () => {
    const active = [
      makeRecommendation({ rec_id: "rec-d8", detector_id: "D8" }),
      makeRecommendation({ rec_id: "rec-d1", detector_id: "D1" }),
      makeRecommendation({ rec_id: "rec-d8-second", detector_id: "D8" }),
      makeRecommendation({ rec_id: "rec-d2", detector_id: "D2" }),
      makeRecommendation({
        rec_id: "rec-minor",
        detector_id: "D4",
        modeled_savings_u_per_wk: ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U - 1,
      }),
    ];

    expect(deriveActiveGroups(active).map((group) => group.detector_id)).toEqual([
      "D8",
      "D1",
      "D2",
      MINOR_ITEMS_GROUP_ID,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ranking rework: D8 > D1 standing test (taxonomy R3 / D8 design §5.1)
// ---------------------------------------------------------------------------

describe("D8 vs D1 ranking", () => {
  it("D8 (cache-miss, #1 waste lever) ranks above D1 (trim, #8 secondary lever) when both fire", () => {
    // Seed a D1 rec — category CONTEXT, has delta_context_tokens (cache-read model).
    db.prepare(
      `INSERT OR IGNORE INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES ('rec-rank-d1', 'RULE', 'D1', 'CONTEXT', 'ws-rank',
         'Trim CLAUDE.md', 500,
         '{"model":"D1_CTX_ALWAYS_LOADED_V1","inputs":{}}',
         '{"delta_context_tokens":5000,"turns_per_week":100}',
         'avg_context_per_turn', 'PROPOSED', datetime('now'), NULL)`,
    ).run();

    // Seed a D8 rec — category CACHE, no delta_context_tokens (cache-write model).
    // D8 savings (write at 1.25–2× weight) intentionally lower than D1 in µUSD to
    // verify that priority-order sort wins over savings sort: D8 must still rank first.
    db.prepare(
      `INSERT OR IGNORE INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES ('rec-rank-d8', 'RULE', 'D8', 'CACHE', 'ws-rank',
         '/clear before idling past TTL', 200,
         '{"model":"D8_CACHE_WRITE_CHURN_V1","inputs":{}}',
         '{"churn_event_count":5,"total_churn_creation_tokens":250000}',
         'cache_read_to_creation_ratio', 'PROPOSED', datetime('now'), NULL)`,
    ).run();

    // Scope to ws-rank (includes NULL-scope global recs too, but they're D2 which is priority 2).
    const view = listRecommendations("ws-rank").data;
    if (view === null) throw new Error("null data");
    const active = view.active;

    const d8Idx = active.findIndex((r) => r.rec_id === "rec-rank-d8");
    const d1Idx = active.findIndex((r) => r.rec_id === "rec-rank-d1");
    expect(d8Idx).toBeGreaterThanOrEqual(0);
    expect(d1Idx).toBeGreaterThanOrEqual(0);
    // D8 (#1 waste lever per A1 §07) must rank above D1 (#8 secondary lever).
    // This holds even when D8's modeled_savings_u_per_wk is lower than D1's,
    // because article priority (detector rank) is the primary sort key.
    expect(d8Idx).toBeLessThan(d1Idx);
    // Flagship guarantee (taxonomy §5): D8 is the ABSOLUTE first waste source
    // when it fires, not merely ahead of D1.
    expect(d8Idx).toBe(0);
  });

  it("ranks WARNING confidence above higher modeled savings within one detector bucket", () => {
    db.prepare(
      `INSERT OR IGNORE INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES ('rec-hi-conf', 'RULE', 'D2', 'CONTEXT', 'ws-confidence',
         'Address session warning', 1000000,
         '{"model":"D2_WARNING_V1","inputs":{},"kind":"WARNING"}',
         '{}',
         'avg_context_per_turn', 'PROPOSED', datetime('now'), NULL)`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES ('rec-lo-conf', 'RULE', 'D2', 'CONTEXT', 'ws-confidence',
         'Address modeled savings', 9000000,
         '{"model":"D2_MODELED_V1","inputs":{}}',
         '{}',
         'avg_context_per_turn', 'PROPOSED', datetime('now'), NULL)`,
    ).run();

    const view = listRecommendations("ws-confidence").data;
    if (view === null) throw new Error("null data");
    const hiConfidenceIdx = view.active.findIndex((r) => r.rec_id === "rec-hi-conf");
    const lowConfidenceIdx = view.active.findIndex((r) => r.rec_id === "rec-lo-conf");

    expect(hiConfidenceIdx).toBeGreaterThanOrEqual(0);
    expect(lowConfidenceIdx).toBeGreaterThanOrEqual(0);
    expect(hiConfidenceIdx).toBeLessThan(lowConfidenceIdx);
  });
});

// ---------------------------------------------------------------------------
// P2 payload enrichment tests
// ---------------------------------------------------------------------------

describe("P2 headroom enrichment", () => {
  it("D2 card has sessions_per_week, steps fallback, and cross_workspace flag", () => {
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    const d2 = view.active[0];
    if (d2 === undefined) throw new Error("missing active rec");

    // sessions_per_week: 3 sessions inserted in beforeEach + baseline fixture sessions
    expect(typeof d2.sessions_per_week).toBe("number");
    expect((d2.sessions_per_week ?? 0) >= 3).toBe(true);

    // D2 evidence has no delta_context_tokens/turns_per_week → headroom null
    expect(d2.headroom).toBeNull();

    // steps fallback to [{ kind:"generic", description: lever }] since D2 evidence has no steps array
    expect(Array.isArray(d2.steps)).toBe(true);
    expect(d2.steps.length).toBeGreaterThanOrEqual(1);
    const firstStep = d2.steps[0];
    expect(firstStep).not.toBeUndefined();
    expect(firstStep).toMatchObject({ kind: "generic", description: d2.lever });

    // D2 is global (scope_workspace_id null) → cross_workspace true
    expect(d2.cross_workspace).toBe(true);
    expect(d2.scope_workspace_id).toBeNull();
  });

  it("headroom is correctly derived when evidence has delta_context_tokens and turns_per_week", () => {
    // Seed a CONTEXT rec with known delta_context_tokens and turns_per_week.
    const evidence = JSON.stringify({
      delta_context_tokens: 5_000,
      turns_per_week: 100,
      workspace_multiplier: 3,
      steps: ["Open the file", "Remove stale rules", "Re-measure"],
    });
    db.prepare(
      `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES ('rec-d1-test', 'RULE', 'D1', 'CONTEXT', NULL,
         'Trim global CLAUDE.md', 12345,
         '{"model":"D1_CTX_ALWAYS_LOADED_V1","inputs":{}}',
         ?, 'avg_context_per_turn', 'PROPOSED', datetime('now'), NULL)`,
    ).run(evidence);

    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");

    const d1 = view.active.find((r) => r.rec_id === "rec-d1-test");
    if (d1 === undefined) throw new Error("D1 rec not in active list");

    // headroom = delta × turns = 5000 × 100 = 500_000. workspace_multiplier (3) is
    // DISPLAY-ONLY and must NOT be a math factor here — turns_per_week already aggregates
    // the cross-workspace footprint, so multiplying would double-count by N (BLOCKER fix).
    expect(d1.headroom).not.toBeNull();
    expect(d1.headroom?.tokens_per_wk_freed).toBe(500_000);

    // per-session: 500_000 / sessions_per_week (guard: sessions_per_week > 0)
    if (d1.sessions_per_week !== null && d1.sessions_per_week > 0) {
      expect(d1.headroom?.tokens_per_session_freed).toBe(500_000 / d1.sessions_per_week);
    } else {
      expect(d1.headroom?.tokens_per_session_freed).toBeNull();
    }

    // steps from evidence.steps — coerced to BoundedStep[] in toCard()
    expect(d1.steps).toEqual([
      { kind: "generic", description: "Open the file" },
      { kind: "generic", description: "Remove stale rules" },
      { kind: "generic", description: "Re-measure" },
    ]);

    // title fallback: evidence has no 'title' field → toCard falls back to lever.
    expect(d1.title).toBe(d1.lever);

    // cross_workspace: scope_workspace_id is null
    expect(d1.cross_workspace).toBe(true);
    expect(d1.workspace_multiplier).toBe(3);
  });

  it("divide-by-zero guard: tokens_per_session_freed is null when sessions_per_week is 0", () => {
    // Use a fresh in-memory DB. The fixture sessions have timestamps from 2026-01-xx,
    // which is outside the trailing-7d window, so sessions_per_week = 0.
    const freshDb = createInMemoryFixtureDb();
    const ev = JSON.stringify({ delta_context_tokens: 1000, turns_per_week: 50 });
    freshDb
      .prepare(
        `INSERT INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES ('rec-div0', 'RULE', 'D1', 'CONTEXT', NULL, 'trim', 0,
         '{"model":"X","inputs":{}}', ?, 'ctx', 'PROPOSED', datetime('now'), NULL)`,
      )
      .run(ev);
    // sessions_per_week = 0 since fixture sessions are from 2026-01-xx (> 7d ago)
    setQueryDb(freshDb);
    const view = listRecommendations().data;
    setQueryDb(db); // restore main db so afterEach close works correctly
    freshDb.close();
    if (view === null) throw new Error("null data");
    const rec = view.active.find((r) => r.rec_id === "rec-div0");
    if (rec === undefined) throw new Error("rec not found");
    // headroom computed: 1000 × 50 × 1 = 50_000 tokens/wk
    expect(rec.headroom?.tokens_per_wk_freed).toBe(50_000);
    // sessions_per_week = 0 → tokens_per_session_freed null (divide-by-zero guard)
    expect(rec.headroom?.tokens_per_session_freed).toBeNull();
  });

  it("ranked by savings DESC within priority group; LIMIT recs appear in limit_warnings", () => {
    // Deliberately decouple savings from headroom so the tiebreak sort key (savings DESC)
    // is tested independently of headroom. rec-ctx-hi has HIGH headroom (50K) but LOW
    // savings (50); rec-ctx-lo has LOW headroom (20K) but HIGH savings (200).
    // Under byArticlePriority: both use D5 → priority 99 each; savings DESC puts
    // rec-ctx-lo first. Under the old headroom-based sort rec-ctx-hi would win — this
    // fixture detects a regression to headroom ordering.
    const ctx1Ev = JSON.stringify({ delta_context_tokens: 2_000, turns_per_week: 10 }); // headroom=20_000
    const ctx2Ev = JSON.stringify({ delta_context_tokens: 5_000, turns_per_week: 10 }); // headroom=50_000
    const limitEv = JSON.stringify({});
    for (const [id, cat, ev, savings] of [
      ["rec-ctx-lo", "CONTEXT", ctx1Ev, 200], // low headroom, HIGH savings → should rank first
      ["rec-ctx-hi", "CONTEXT", ctx2Ev, 50], // high headroom, LOW savings → should rank second
      ["rec-limit-1", "LIMIT", limitEv, 0],
    ] as const) {
      db.prepare(
        `INSERT OR IGNORE INTO recommendations
           (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
            modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
            target_metric, state, created_at, dismissed_until)
         VALUES (?, 'RULE', 'D5', ?, NULL, 'lever', ?,
           '{"model":"X","inputs":{}}', ?, 'metric', 'PROPOSED', datetime('now'), NULL)`,
      ).run(id, cat, savings, ev);
    }
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    const active = view.active;

    // LIMIT recs are partitioned into limit_warnings, not active (taxonomy §7 IA §4 §2.1).
    expect(active.filter((r) => r.category === "LIMIT")).toHaveLength(0);
    expect(view.limit_warnings.find((r) => r.rec_id === "rec-limit-1")).not.toBeUndefined();

    // Within CONTEXT (same D5 priority group=99), savings DESC is the tiebreak.
    // rec-ctx-lo (savings=200) must rank BEFORE rec-ctx-hi (savings=50),
    // even though rec-ctx-hi has higher headroom (50K > 20K).
    const ctxRecs = active.filter((r) => r.category === "CONTEXT");
    const hiIdx = ctxRecs.findIndex((r) => r.rec_id === "rec-ctx-hi");
    const loIdx = ctxRecs.findIndex((r) => r.rec_id === "rec-ctx-lo");
    if (hiIdx !== -1 && loIdx !== -1) {
      expect(loIdx).toBeLessThan(hiIdx); // higher savings (200) wins over higher headroom (50K)
    }
  });
});

// ---------------------------------------------------------------------------
// Snooze / auto-expiry tests (RV5)
// ---------------------------------------------------------------------------

describe("dismissRecommendation + snooze auto-expiry", () => {
  const PAST_DATE = "2020-01-01T00:00:00.000Z"; // well before now
  const FUTURE_DATE = "2099-01-01T00:00:00.000Z"; // well after now

  function seedProposedRec(recId: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO recommendations
         (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
          modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
          target_metric, state, created_at, dismissed_until)
       VALUES (?, 'RULE', 'D2', 'CONTEXT', NULL, 'test lever', 2000000,
         '{"model":"X","inputs":{}}', '{}',
         'avg_context_per_turn', 'PROPOSED', datetime('now'), NULL)`,
    ).run(recId);
  }

  it("re-proposes a dismissed rec when dismissed_until is in the past (snooze expired)", () => {
    seedProposedRec("rec-snooze-past");

    // Manually set state=DISMISSED with a past dismissed_until (expired snooze).
    db.prepare(
      "UPDATE recommendations SET state='DISMISSED', dismissed_until=? WHERE rec_id=?",
    ).run(PAST_DATE, "rec-snooze-past");

    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");

    // Expired snooze → re-appears in active list, not dismissed.
    const inActive = view.active.some((r) => r.rec_id === "rec-snooze-past");
    const inDismissed = view.dismissed.some((r) => r.rec_id === "rec-snooze-past");
    expect(inActive).toBe(true);
    expect(inDismissed).toBe(false);
  });

  it("keeps a dismissed rec in the dismissed list when dismissed_until is in the future", () => {
    seedProposedRec("rec-snooze-future");

    db.prepare(
      "UPDATE recommendations SET state='DISMISSED', dismissed_until=? WHERE rec_id=?",
    ).run(FUTURE_DATE, "rec-snooze-future");

    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");

    const inActive = view.active.some((r) => r.rec_id === "rec-snooze-future");
    const inDismissed = view.dismissed.some((r) => r.rec_id === "rec-snooze-future");
    expect(inActive).toBe(false);
    expect(inDismissed).toBe(true);
  });

  it("keeps a dismissed rec with null dismissed_until in the dismissed list (permanent dismiss)", () => {
    seedProposedRec("rec-perm-dismiss");

    db.prepare(
      "UPDATE recommendations SET state='DISMISSED', dismissed_until=NULL WHERE rec_id=?",
    ).run("rec-perm-dismiss");

    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");

    const inActive = view.active.some((r) => r.rec_id === "rec-perm-dismiss");
    const inDismissed = view.dismissed.some((r) => r.rec_id === "rec-perm-dismiss");
    expect(inActive).toBe(false);
    expect(inDismissed).toBe(true);
  });

  it("dismissRecommendation with dismissedUntilOverride sets the custom date", () => {
    seedProposedRec("rec-custom-snooze");

    dismissRecommendation("rec-custom-snooze", Date.now(), FUTURE_DATE);

    const row = db
      .prepare("SELECT state, dismissed_until FROM recommendations WHERE rec_id=?")
      .get("rec-custom-snooze") as { state: string; dismissed_until: string } | undefined;

    expect(row?.state).toBe("DISMISSED");
    expect(row?.dismissed_until).toBe(FUTURE_DATE);
  });

  it("dismissRecommendation default (no override) still uses 30-day cooldown", () => {
    seedProposedRec("rec-default-dismiss");
    const before = Date.now();
    dismissRecommendation("rec-default-dismiss");
    const after = Date.now();

    const row = db
      .prepare("SELECT dismissed_until FROM recommendations WHERE rec_id=?")
      .get("rec-default-dismiss") as { dismissed_until: string } | undefined;

    expect(row?.dismissed_until).not.toBeNull();
    const dismissedUntil = new Date(row?.dismissed_until ?? "").getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    // dismissed_until should be approximately now + 30 days
    expect(dismissedUntil).toBeGreaterThanOrEqual(before + thirtyDays - 1000);
    expect(dismissedUntil).toBeLessThanOrEqual(after + thirtyDays + 1000);
  });
});
