/**
 * test/query/recommendations.test.ts — listRecommendations envelope + grouping.
 *
 * Runs the DetectorEngine over a seeded fixture DB (with qualifying long-context
 * sessions so D2 fires), then asserts the grouped RecommendationsView, the live
 * detectors[] strip, and the EXPERIMENTAL envelope.
 */

import { readdirSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LedgerEntry, buildClaimLedger } from "../../src/detector/claim-ledger.js";
import { a1FindingDescriptor } from "../../src/detector/detectors/a1_tool_result_bloat.js";
import { b1FindingDescriptor } from "../../src/detector/detectors/b1_cache_read_collapse.js";
import { b2FindingDescriptor } from "../../src/detector/detectors/b2_cache_ttl_gap.js";
import { c9FindingDescriptor } from "../../src/detector/detectors/c9_denial_friction.js";
import { h1FindingDescriptor } from "../../src/detector/detectors/h1_destructive_operations.js";
import { runDetectors } from "../../src/detector/index.js";
import {
  type RecommendationPayloadV1,
  type RecommendationTemplateId,
  createFindingEnvelopeV2,
  findingIds,
  recommendationTemplate,
  serializeModeledFormulaV1,
  serializeRecommendationPayloadV1,
} from "../../src/detector/privacy-contract.js";
import { RecEvidenceContext } from "../../src/query/api/rec-evidence.js";
import {
  MINOR_ITEMS_GROUP_ID,
  type ScopeSpendU,
  deMinimisFloorU,
  deriveActiveGroups as deriveActiveGroupsWithSpend,
  dismissRecommendation,
  getRecommendationCard,
  listRecommendations,
} from "../../src/query/api/recommendations.js";

// The floor is 0.2% of the scope's 7d spend. $500 of spend puts it at $1 (1_000_000 µ$),
// the old fixed floor, so the pre-existing cases below keep their meaning.
const SPEND_500: ScopeSpendU = { global: 500_000_000, byWorkspace: new Map() };
const ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U = deMinimisFloorU(SPEND_500.global);
const deriveActiveGroups = (active: RecommendationCard[], spend: ScopeSpendU = SPEND_500) =>
  deriveActiveGroupsWithSpend(active, spend);
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
    pct_of_weekly_spend: null,
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
    actionability_ok: false,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
    ...overrides,
  };
}

const VALID_FACTS: Record<RecommendationTemplateId, Record<string, unknown>> = {
  D1_CONTEXT_ALWAYS_LOADED: {
    component: "CLAUDE_MD",
    source_tokens: 10_000,
    source_target: 5_000,
    delta_context_tokens: 5_000,
    turns_per_week: 100,
    scope: "workspace",
    workspace_multiplier: 1,
  },
  D2_LONG_FULL_CONTEXT: {
    session_ids: [],
    qualifying_session_count: 0,
    qualifying_turn_count: 0,
    raw_context_average_tokens_per_turn: 0,
    cap_weighted_burn_tokens_per_week: 0,
    cache_read_tokens_per_week: 0,
    cap_read_coefficient: 0.1,
  },
  D4_MODEL_MISMATCH: {
    workspace_id: "ws-alpha",
    total_opus_turns_per_week: 0,
    mismatch_turns_per_week: 0,
    opus_subagent_count: 0,
    lookup_subagent_count: 0,
    mismatch_fraction: 0,
    avg_input_tokens: 0,
    avg_output_tokens: 0,
  },
  D5_LIMIT_BURN_DEGRADED: {
    forecast_state: "OFF",
    tokens_used: 0,
    burn_trend: "FLAT",
    recent_cap_weighted_tokens: 0,
    recent_cap_weighted_tokens_per_day: 0,
    baseline_cap_weighted_tokens: 0,
    baseline_cap_weighted_tokens_per_day: 0,
    baseline_window_days: 7,
  },
  D5_LIMIT_BURN_WARNING: {
    forecast_state: "WARNING",
    tokens_used: 1,
    limit_tokens: 10,
    projected_exhaustion_jd: null,
    limit_scale_legacy: false,
  },
  D6_TOOL_RESULT_BLOAT: {
    workspace_id: "ws-alpha",
    session_ids: [],
    session_count: 0,
    tool_result_bytes: 0,
    session_cap_weighted_tokens: 0,
    bloat_share: 0,
    turn_count: 0,
    bytes_per_token: 4,
  },
  D7_CROSS_SESSION_REREAD: {
    workspace_id: "ws-alpha",
    redundant_path_count: 0,
    total_redundant_read_count: 0,
    total_redundant_result_bytes: 0,
    max_path_read_count: 0,
    max_path_session_count: 0,
  },
  D7_RETRY_LOOP: {
    workspace_id: "ws-alpha",
    session_ids: [],
    session_count: 0,
    loop_flagged_event_count: 0,
    loop_flagged_turn_count: 0,
    repeat_excess_event_count: 0,
    repeat_excess_turn_count: 0,
    total_turn_count: 0,
    loop_flagged_turn_share: 0,
    owner_turn_metadata_coverage: 1,
    owner_turn_metadata_covered_event_count: 0,
    owner_turn_metadata_denominator_event_count: 0,
    identical_call_event_count: 0,
    test_fail_event_count: 0,
    redundant_read_event_count: 0,
    three_gram_loop_event_count: 0,
    error_loop_event_count: 0,
    edit_without_prior_read_event_count: 0,
    owner_turn_metadata_coverage_floor: 0.8,
    friction_signals_suppressed_below_coverage_floor: false,
    repeat_excess_turn_cap_weighted_tokens: 0,
  },
  D8_CACHE_WRITE_CHURN: {
    workspace_id: "ws-alpha",
    session_ids: [],
    session_count: 0,
    churn_event_count: 0,
    total_churn_creation_tokens: 0,
    session_cap_weighted_tokens: 0,
    creation_share: 0,
    cache_read_to_creation_ratio: null,
    regime: "5m",
  },
  D9_BACKGROUND_SESSION: {
    workspace_id: "ws-alpha",
    sidechain_cap_weighted_tokens: 0,
    total_cap_weighted_tokens: 0,
    sidechain_share: 0,
    sidechain_turn_count: 0,
    zero_user_turn_sidechain_cap: 0,
    zero_user_turn_sidechain_share: 0,
    zero_user_turn_session_count: 0,
  },
  D10_CATALOG_FOOTPRINT: {
    catalog_item_count: 0,
    always_load_count: 0,
    catalog_tokens: 0,
    catalog_target_tokens: 0,
    delta_context_tokens: 0,
  },
  D11_TOOL_ERROR_RATE: {
    bash_error_ratio: 0,
    powershell_error_ratio: 0,
    bash_call_count: 0,
    powershell_call_count: 0,
    bash_error_count: 0,
    powershell_error_count: 0,
    preferred_tool: "Bash",
    higher_error_tool: "PowerShell",
  },
  D12_SUBAGENT_OVERSPAWN: {
    workspace_id: "ws-alpha",
    sidechain_result_bytes: 0,
    sidechain_turn_count: 0,
    sidechain_session_count: 0,
    session_ids: [],
  },
};

function seedValidatedRec(options: {
  recId: string;
  templateId: RecommendationTemplateId;
  scope?: string | null;
  savings?: number | null;
  facts?: Record<string, unknown>;
  estimate?: { basis: "P" | "E" | "O" | "R" | "X"; rank_value_u_per_wk: number | null };
  createdAt?: string;
  targetDb?: Database.Database;
}): void {
  const payload = {
    version: 1,
    template_id: options.templateId,
    facts: { ...VALID_FACTS[options.templateId], ...options.facts },
  } as RecommendationPayloadV1;
  const definition = recommendationTemplate(options.templateId);
  (options.targetDb ?? db)
    .prepare(
      `INSERT OR IGNORE INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, dismissed_until, contract_version, template_id, contract_status)
     VALUES (?, 'RULE', ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, NULL,
       1, ?, 'V1_VALIDATED')`,
    )
    .run(
      options.recId,
      definition.detector_id,
      definition.category,
      options.scope ?? null,
      definition.lever,
      options.savings ?? null,
      JSON.stringify({
        ...JSON.parse(serializeModeledFormulaV1(payload)),
        ...(options.estimate === undefined
          ? {}
          : { estimate: { ...options.estimate, summable: true, label: "fixture" } }),
      }),
      serializeRecommendationPayloadV1(payload),
      definition.target_metric,
      options.createdAt ?? RECENT,
      options.templateId,
    );
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  // 3 qualifying long-context sessions → D2 fires. Each opens at 20K and then carries 200K, so a
  // split has something to save (review 3 B5 derives the saving from that growth).
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
         0, 0, ?, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
    );
    for (let turn = 0; turn <= 150; turn++) {
      insertTurn.run(
        `msg-long-${i}-${String(turn).padStart(3, "0")}`,
        `sess-long-${i}`,
        RECENT,
        turn === 0 ? 20_000 : 200_000,
      );
    }
  }
  runDetectors(db, { now: NOW });
});

/** One reconciled ws-alpha turn costing `u` µ$ inside the 7d window (the floor's denominator). */
function seedWeeklySpend(u: number): void {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
       input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
       cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
       provisional, parser_version)
     VALUES ('msg-weekly-spend', 'sess-long-1', 'ws-alpha', ?, 'claude-sonnet', 0,
       0, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(RECENT, u);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetQueryDb();
  db.close();
});

/**
 * Add spend-lane claims (recId → µ$ values) on top of the REAL ledger for the request window.
 * A seam for exact-value tests: the fixture has no turn data that makes D8's producer fire.
 */
function addSpendClaims(claims: Array<{ recId: string; detectorId: string; value_u: number }>) {
  const original = RecEvidenceContext.prototype.ledger;
  return vi.spyOn(RecEvidenceContext.prototype, "ledger").mockImplementation(function (
    this: RecEvidenceContext,
    window,
  ) {
    const real = original.call(this, window);
    const extra = claims.map(
      (claim, i) =>
        ({
          ...claim,
          lane: "spend",
          workspaceId: "ws-alpha",
          sessionId: `sess-stub-${i}`,
          turnKey: `stub-turn-${i}`,
          component: "cw5m",
          slice: "*",
          tokens: 1,
          raw_tokens: 1,
          requested_tokens: 1,
          unpriced: false,
        }) as LedgerEntry,
    );
    return { ...real, claims: [...real.claims, ...extra] };
  });
}

/** Σ spend-lane claim value_u for one rec, from an independently built ledger. */
function ledgerSumForRec(recId: string): number {
  const to = new Date();
  const ledger = buildClaimLedger(db, {
    now: to,
    fromIso: new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    toIso: to.toISOString(),
  });
  return ledger.claims
    .filter((claim) => claim.lane === "spend" && claim.recId === recId)
    .reduce((sum, claim) => sum + claim.value_u, 0);
}

function seedLiveSessionFor(id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at,
       last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED', 10, 0, '[]')`,
  ).run(id, `/fake/${id}.jsonl`, RECENT, RECENT);
}

describe("listRecommendations", () => {
  it("orders mixed bases in one active list and leaves deprecated lanes empty", () => {
    const cases = [
      { recId: "rank-risk", basis: "R" as const, rank_value_u_per_wk: 300 },
      { recId: "rank-priced", basis: "P" as const, rank_value_u_per_wk: 500 },
      { recId: "rank-overlap", basis: "O" as const, rank_value_u_per_wk: 200 },
      { recId: "rank-estimated", basis: "E" as const, rank_value_u_per_wk: 400 },
      { recId: "rank-x", basis: "X" as const, rank_value_u_per_wk: null },
    ];
    for (const item of cases) {
      seedValidatedRec({
        recId: item.recId,
        templateId: "D1_CONTEXT_ALWAYS_LOADED",
        estimate: { basis: item.basis, rank_value_u_per_wk: item.rank_value_u_per_wk },
      });
    }
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    expect(
      view.active.filter((rec) => rec.rec_id.startsWith("rank-")).map((rec) => rec.rec_id),
    ).toEqual(["rank-priced", "rank-estimated", "rank-risk", "rank-overlap", "rank-x"]);
    // U5.4: the always-empty deprecated lanes are gone from the payload.
    expect(view).not.toHaveProperty("pinned_safety");
    expect(view).not.toHaveProperty("friction_safety");
    expect(view).not.toHaveProperty("next_decisions");
  });

  it("renders V1 fact numbers in card actions and carries recency", () => {
    seedValidatedRec({
      recId: "rec-d1-actions",
      templateId: "D1_CONTEXT_ALWAYS_LOADED",
      facts: {
        source_tokens: 12_345,
        last_seen_week_start: "2026-09-07T00:00:00.000Z",
        weeks_ago: 2,
        weeks_fired: 3,
        weeks_evaluated: 4,
      },
    });
    const view = listRecommendations().data;
    const card = view?.history.find((rec) => rec.rec_id === "rec-d1-actions");
    expect(view?.active.some((rec) => rec.rec_id === "rec-d1-actions")).toBe(false);
    expect(card?.actions?.primary.summary).toContain("12,345");
    expect(card?.actions?.primary.summary).not.toContain("current tokens");
    expect(card).toMatchObject({
      last_seen_week_start: "2026-09-07T00:00:00.000Z",
      weeks_ago: 2,
      weeks_fired: 3,
      weeks_evaluated: 4,
    });
  });

  it("renders a V2 B1 metric in card actions", () => {
    const payload = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: b1FindingDescriptor.rule_id,
        label: "CACHE_READ_UNDER_10_PERCENT_OF_PREVIOUS",
        assessment: b1FindingDescriptor.defaults.assessment,
        routing: b1FindingDescriptor.defaults.routing,
        window: { from: RECENT, to: NOW.toISOString() },
        anchors: [
          {
            session_id: findingIds.session("b1-session"),
            timestamp: RECENT,
            message_id: findingIds.message("b1-message"),
          },
        ],
        session_ids: ["b1-session"],
        impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics: {
          PREVIOUS_CACHE_READ_TOKENS: { kind: "TOKENS", value: 20_000 },
          CURRENT_CACHE_READ_TOKENS: { kind: "TOKENS", value: 5_000 },
          CURRENT_TO_PREVIOUS_RATIO: { kind: "RATIO", value: 0.25 },
          CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: 15_000 },
          COLLAPSE_EVENT_COUNT: { kind: "COUNT", value: 1 },
          RAPID_COLLAPSE_COUNT: { kind: "COUNT", value: 0 },
        },
      },
      b1FindingDescriptor,
    );
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, contract_version, contract_status, rule_id)
      VALUES (?, 'RULE', ?, ?, ?, ?, 100, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
      "rec-b1-actions",
      "B1",
      b1FindingDescriptor.presentation.category,
      "ws-alpha",
      b1FindingDescriptor.presentation.lever,
      JSON.stringify(payload),
      b1FindingDescriptor.presentation.target_metric,
      RECENT,
      b1FindingDescriptor.rule_id,
    );
    const card = listRecommendations().data?.active.find((rec) => rec.rec_id === "rec-b1-actions");
    expect(card?.actions?.primary.summary).toContain("25% of the previous turn");
    expect(card?.trigger?.session_ids).toContain("b1-session");
  });

  // R2.8 folded B2's break into D8; review 3 B6 keeps the fold but D8 shows only its own resumes.
  it("F26: B2 renders its own card only where no active D8 card covers its workspace", () => {
    const payload = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: b2FindingDescriptor.rule_id,
        label: "UNKNOWN_CONSERVATIVE_1H",
        assessment: b2FindingDescriptor.defaults.assessment,
        routing: b2FindingDescriptor.defaults.routing,
        window: { from: RECENT, to: NOW.toISOString() },
        anchors: [
          {
            session_id: findingIds.session("b2-session"),
            timestamp: RECENT,
            message_id: findingIds.message("b2-message"),
          },
        ],
        session_ids: ["b2-session"],
        impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics: {
          GAP_DURATION_MS: { kind: "DURATION_MS", value: 36.5 * 3_600_000 },
          CONSERVATIVE_TTL_DURATION_MS: { kind: "DURATION_MS", value: 3_600_000 },
          PREVIOUS_CACHE_READ_TOKENS: { kind: "TOKENS", value: 1_500_000 },
          CURRENT_CACHE_READ_TOKENS: { kind: "TOKENS", value: 64_000 },
          CURRENT_CACHE_CREATION_TOKENS: { kind: "TOKENS", value: 900_000 },
          RESUME_COUNT: { kind: "COUNT", value: 3 },
        },
      },
      b2FindingDescriptor,
    );
    // ws-cache also has an active D8 card (hidden there); ws-b2only has none (shown).
    for (const [recId, ws] of [
      ["rec-b2-fold", "ws-cache"],
      ["rec-b2-alone", "ws-b2only"],
    ])
      db.prepare(`INSERT INTO recommendations
        (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
         modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
         state, created_at, contract_version, contract_status, rule_id)
        VALUES (?, 'RULE', 'B2', ?, ?, ?, NULL, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
        recId,
        b2FindingDescriptor.presentation.category,
        ws,
        b2FindingDescriptor.presentation.lever,
        JSON.stringify(payload),
        b2FindingDescriptor.presentation.target_metric,
        RECENT,
        b2FindingDescriptor.rule_id,
      );
    seedValidatedRec({
      recId: "rec-d8-fold",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-cache",
      savings: 200,
      facts: { churn_event_count: 5, total_churn_creation_tokens: 250_000 },
    });
    seedValidatedRec({
      recId: "rec-d8-alone",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 200,
      facts: { churn_event_count: 5, total_churn_creation_tokens: 250_000 },
    });

    const active = listRecommendations().data?.active ?? [];
    expect(active.some((card) => card.rec_id === "rec-b2-fold")).toBe(false);
    const b2 = active.find((card) => card.rec_id === "rec-b2-alone");
    expect(b2?.modeled_savings_u_per_wk).toBeNull();
    expect(b2?.trigger?.problem).toMatch(
      /^3 resumes came after a break past the cache lifetime; the longest break was 36\.5 hours \(cache lifetime /,
    );
    expect(b2?.trigger?.facts.map((fact) => fact.label)).toContain(
      "Cache reads, summed over 3 resumes",
    );
    const d8 = active.find((card) => card.rec_id === "rec-d8-fold");
    expect(d8?.trigger?.problem).toBeDefined();
    expect(d8?.trigger?.problem).not.toMatch(/36\.5 hours|1\.5M/);
    expect(d8?.trigger?.facts.map((fact) => fact.label)).not.toContain("Longest break");
  });

  it("puts the rm -rf fix into the guard of a workspace with a guard-block card (P3.1-T9)", () => {
    const insertV2 = (
      recId: string,
      workspaceId: string,
      descriptor: typeof c9FindingDescriptor | typeof h1FindingDescriptor,
      label: string,
      metrics: Record<string, { kind: "ENUM" | "COUNT"; value: string | number }>,
    ) => {
      const payload = createFindingEnvelopeV2(
        {
          version: 2,
          rule_id: descriptor.rule_id,
          label,
          assessment: descriptor.defaults.assessment,
          routing: descriptor.defaults.routing,
          window: { from: RECENT, to: NOW.toISOString() },
          anchors: [
            {
              session_id: findingIds.session(`${recId}-session`),
              timestamp: RECENT,
              event_id: findingIds.event(`${recId}-event`),
            },
          ],
          session_ids: [`${recId}-session`],
          impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
          verdict: { value: "CONFIRMED", method: "RULE" },
          metrics,
        } as never,
        descriptor as never,
      );
      db.prepare(`INSERT INTO recommendations
        (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
         modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
         state, created_at, contract_version, contract_status, rule_id)
        VALUES (?, 'RULE', ?, ?, ?, ?, NULL, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
        recId,
        descriptor.owner_detector_id,
        descriptor.presentation.category,
        workspaceId,
        descriptor.presentation.lever,
        JSON.stringify(payload),
        descriptor.presentation.target_metric,
        RECENT,
        descriptor.rule_id,
      );
    };
    const rmRf = {
      DESTRUCTIVE_OPERATION: { kind: "ENUM", value: "RM_RF" },
      OPERATION_COUNT: { kind: "COUNT", value: 4 },
    } as const;
    insertV2("rec-c9-guard", "ws-guard", c9FindingDescriptor, "HOOK_BLOCK", {
      DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
      COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: "NONE" },
      DENIAL_COUNT: { kind: "COUNT", value: 12 },
    });
    insertV2(
      "rec-h1-guard",
      "ws-guard",
      h1FindingDescriptor,
      "DESTRUCTIVE_OPERATION_REPORTED",
      rmRf,
    );
    insertV2(
      "rec-h1-plain",
      "ws-plain",
      h1FindingDescriptor,
      "DESTRUCTIVE_OPERATION_REPORTED",
      rmRf,
    );

    const cards = [...(listRecommendations().data?.active ?? [])];
    const guarded = cards.find((card) => card.rec_id === "rec-h1-guard");
    const plain = cards.find((card) => card.rec_id === "rec-h1-plain");
    expect(guarded?.title).toMatch(/PreToolUse guard/);
    expect(guarded?.actions?.primary.option_id).toBe("h1-add-to-guard");
    expect(plain?.title).not.toMatch(/PreToolUse guard/);
    expect(plain?.actions?.primary.option_id).toBe("h1-ask-destructive-operation");
    // Cross-links (P3.1-T9): the guard and the rm -rf card in one workspace point at each other.
    expect(guarded?.related?.map((link) => link.rec_id)).toEqual(["rec-c9-guard"]);
    expect(cards.find((card) => card.rec_id === "rec-c9-guard")?.related).toEqual([
      expect.objectContaining({ rec_id: "rec-h1-guard" }),
    ]);
    expect(plain?.related).toBeUndefined();
  });

  it("offers D11 a PowerShell matcher only where a guard-block card shows a guard (review 5 M11)", () => {
    const payload = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: c9FindingDescriptor.rule_id,
        label: "HOOK_BLOCK",
        assessment: c9FindingDescriptor.defaults.assessment,
        routing: c9FindingDescriptor.defaults.routing,
        window: { from: RECENT, to: NOW.toISOString() },
        anchors: [
          {
            session_id: findingIds.session("d11-guard-session"),
            timestamp: RECENT,
            event_id: findingIds.event("d11-guard-event"),
          },
        ],
        session_ids: ["d11-guard-session"],
        impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics: {
          DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
          COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: "NONE" },
          DENIAL_COUNT: { kind: "COUNT", value: 12 },
        },
      } as never,
      c9FindingDescriptor as never,
    );
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, contract_version, contract_status, rule_id)
      VALUES (?, 'RULE', 'C9', ?, 'ws-guard', ?, NULL, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
      "rec-c9-d11-guard",
      c9FindingDescriptor.presentation.category,
      c9FindingDescriptor.presentation.lever,
      JSON.stringify(payload),
      c9FindingDescriptor.presentation.target_metric,
      RECENT,
      c9FindingDescriptor.rule_id,
    );
    const shell = { preferred_tool: "Bash", higher_error_tool: "PowerShell" };
    seedValidatedRec({
      recId: "rec-d11-guard",
      templateId: "D11_TOOL_ERROR_RATE",
      scope: "ws-guard",
      facts: shell,
    });
    seedValidatedRec({
      recId: "rec-d11-plain",
      templateId: "D11_TOOL_ERROR_RATE",
      scope: "ws-plain",
      facts: shell,
    });

    const cards = [...(listRecommendations().data?.active ?? [])];
    const matcher = (recId: string) =>
      cards
        .find((card) => card.rec_id === recId)
        ?.actions?.alternatives.some((option) => option.summary.includes("`PowerShell` matcher"));
    expect(matcher("rec-d11-guard")).toBe(true);
    expect(matcher("rec-d11-plain")).toBe(false);
  });

  it("cross-links cards that split one cost, within a workspace or with a global card (P3.1-T9)", () => {
    const seed = (recId: string, templateId: RecommendationTemplateId, scope: string) =>
      seedValidatedRec({
        recId,
        templateId,
        scope,
        savings: 200,
        facts: { workspace_id: scope },
      });
    seed("rec-d8-link", "D8_CACHE_WRITE_CHURN", "ws-link");
    seed("rec-d7-loop", "D7_RETRY_LOOP", "ws-link");
    seed("rec-d7-reread", "D7_CROSS_SESSION_REREAD", "ws-link");
    seed("rec-d7-loop-other", "D7_RETRY_LOOP", "ws-other");

    // A1 is V2-only (no RECOMMENDATION_TEMPLATES entry), so seed it like the C9 example above.
    const a1Payload = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: a1FindingDescriptor.rule_id,
        label: "TOOL_RESULT_OVER_25_KIB",
        assessment: a1FindingDescriptor.defaults.assessment,
        routing: a1FindingDescriptor.defaults.routing,
        window: { from: RECENT, to: NOW.toISOString() },
        anchors: [
          {
            session_id: findingIds.session("a1-link-session"),
            timestamp: RECENT,
            event_id: findingIds.event("a1-link-event"),
          },
        ],
        session_ids: ["a1-link-session"],
        estimate: { basis: "E", rank_value_u_per_wk: 200, summable: true, label: "fixture" },
        impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics: {
          EVENT_COUNT: { kind: "COUNT", value: 3 },
          RESULT_BYTES_TOTAL: { kind: "BYTES", value: 90_000 },
          MAX_RESULT_BYTES: { kind: "BYTES", value: 40_000 },
          THRESHOLD_BYTES: { kind: "BYTES", value: 25 * 1024 },
        },
      } as never,
      a1FindingDescriptor as never,
    );
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, contract_version, contract_status, rule_id)
      VALUES (?, 'RULE', 'A1', ?, 'ws-link', ?, 200, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
      "rec-a1-link",
      a1FindingDescriptor.presentation.category,
      a1FindingDescriptor.presentation.lever,
      JSON.stringify(a1Payload),
      a1FindingDescriptor.presentation.target_metric,
      RECENT,
      a1FindingDescriptor.rule_id,
    );

    const cards = listRecommendations().data?.active ?? [];
    const byId = (id: string) => cards.find((card) => card.rec_id === id);
    const d2 = cards.find((card) => card.detector_id === "D2");
    if (d2 === undefined) throw new Error("missing D2 card");
    const ids = (id: string) => byId(id)?.related?.map((link) => link.rec_id);

    expect(ids("rec-d8-link")).toEqual([d2.rec_id]);
    expect(byId("rec-d8-link")?.related?.[0]?.why).toMatch(/Re-reads within long sessions/);
    // Review 5 M15: D2 <-> D7_REREAD is a new pair, on top of D2 <-> D8.
    expect(ids(d2.rec_id)).toContain("rec-d8-link");
    expect(ids(d2.rec_id)).toContain("rec-d7-reread");
    expect(ids("rec-d7-loop")).toEqual(["rec-d7-reread", "rec-a1-link"]);
    expect(ids("rec-d7-reread")).toEqual(["rec-d7-loop", "rec-a1-link", d2.rec_id]);
    expect(byId("rec-d7-reread")?.related?.[2]?.why).not.toContain("counted there");
    expect(byId("rec-d7-loop-other")?.related).toBeUndefined();
    // U9 r7: D7's ledger producer claims only the re-reads; the loop card's headline is
    // "not estimated" (null), never a $0 next to its own figure.
    expect(byId("rec-d7-loop")?.allocated_u_per_wk).toBeNull();
    expect(typeof byId("rec-d7-reread")?.allocated_u_per_wk).toBe("number");
    // Review 5 folded minor: A1's own outbound related text no longer says "counted there".
    expect(ids("rec-a1-link")).toEqual(["rec-d7-loop", "rec-d7-reread"]);
    for (const link of byId("rec-a1-link")?.related ?? []) {
      expect(link.why).not.toContain("counted there");
      // U7: the false "subagent reads count as zero" claim is gone (A1 prices them).
      expect(link.why).not.toContain("count as zero");
      expect(link.why).toContain("on that card, not this one");
    }
  });

  it("links A1 and D2 only when they share a session (review 6 R6-03)", () => {
    const d2Sessions = (listRecommendations().data?.active ?? []).find(
      (card) => card.detector_id === "D2",
    )?.evidence.session_ids;
    if (!Array.isArray(d2Sessions) || typeof d2Sessions[0] !== "string")
      throw new Error("missing D2 sessions");
    const shared = d2Sessions[0];
    const a1Payload = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: a1FindingDescriptor.rule_id,
        label: "TOOL_RESULT_OVER_25_KIB",
        assessment: a1FindingDescriptor.defaults.assessment,
        routing: a1FindingDescriptor.defaults.routing,
        window: { from: RECENT, to: NOW.toISOString() },
        anchors: [
          {
            session_id: findingIds.session(shared),
            timestamp: RECENT,
            event_id: findingIds.event("a1-shared-event"),
          },
        ],
        session_ids: [shared],
        estimate: { basis: "E", rank_value_u_per_wk: 200, summable: true, label: "fixture" },
        impact: { kind: "TOKEN_WASTE", severity: "MEDIUM", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics: {
          EVENT_COUNT: { kind: "COUNT", value: 3 },
          RESULT_BYTES_TOTAL: { kind: "BYTES", value: 90_000 },
          MAX_RESULT_BYTES: { kind: "BYTES", value: 40_000 },
          THRESHOLD_BYTES: { kind: "BYTES", value: 25 * 1024 },
        },
      } as never,
      a1FindingDescriptor as never,
    );
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, contract_version, contract_status, rule_id)
      VALUES (?, 'RULE', 'A1', ?, NULL, ?, 200, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
      "rec-a1-shared",
      a1FindingDescriptor.presentation.category,
      a1FindingDescriptor.presentation.lever,
      JSON.stringify(a1Payload),
      a1FindingDescriptor.presentation.target_metric,
      RECENT,
      a1FindingDescriptor.rule_id,
    );

    const cards = listRecommendations().data?.active ?? [];
    const a1 = cards.find((card) => card.rec_id === "rec-a1-shared");
    const d2 = cards.find((card) => card.detector_id === "D2");
    if (d2 === undefined) throw new Error("missing D2 card");
    const a1ToD2 = a1?.related?.find((link) => link.rec_id === d2.rec_id);
    expect(a1ToD2?.why).toMatch(/don't add the two/);
    expect(d2.related?.map((link) => link.rec_id)).toContain("rec-a1-shared");
  });

  it("groups active recs and attaches the EXPERIMENTAL envelope", () => {
    seedWeeklySpend(500_000_000); // 0.2% floor = $1; the fixture turns otherwise cost 0
    const res = listRecommendations();
    expect(res.meta.claim_kind).toBe("EXPERIMENTAL");
    expect(res.meta.metric_definition_version).toBe("observe-1");

    const view = res.data;
    if (view === null) throw new Error("null data");
    expect(view.active.filter((rec) => rec.detector_id === "D2")).toHaveLength(1);
    expect(view.adopted).toEqual([]);
    expect(view.dismissed).toEqual([]);
    expect(res.meta.n).toBe(view.active.length);

    const d2 = view.active.find((rec) => rec.detector_id === "D2");
    if (d2 === undefined) throw new Error("missing active rec");
    expect(d2.detector_id).toBe("D2");
    expect(d2.state).toBe("PROPOSED");
    // Review 3 B5 (hand-derived): base 20K (each session's first call). One split halves each
    // 151-call session: calls 76–150 (75) avoid 200,000 − 22,000 = 178,000 of the
    // 20,000 + 150 × 200,000 = 30,020,000 read: 0.44471 → 0.4447. Spend 3 × 30,020,000 × $0.3/MTok
    // = 27,018,000; gross × 0.4447 = 12,014,905; − 3 splits × 22,000 × 3.75 = 247,500 → 11,767,405.
    expect(d2.modeled_savings_u_per_wk).toBe(11_767_405);
    expect(d2.modeled_formula.model).toBe("D2_LONG_CONTEXT_CACHE_READ_V1");
    expect(d2.modeled_formula.inputs.cap_read_coefficient).toBe(0.1);
    expect(Array.isArray(d2.evidence.session_ids)).toBe(true);
    // title-from-evidence: D2 emits title in evidence; toCard() surfaces it.
    expect(d2.title).toBe(recommendationTemplate("D2_LONG_FULL_CONTEXT").lever);
    // P3.L L6: the card headline is the ledger's allocated figure, computed independently
    // of the detector's own modeled formula above — a few µUSD apart from rounding at the
    // per-claim (token) level vs. the formula's own rounding is expected and real.
    expect(
      Math.abs((d2.allocated_u_per_wk ?? 0) - (d2.modeled_savings_u_per_wk ?? 0)),
    ).toBeLessThan(10);
    // Exact: allocated == round(Σ this rec's spend claims) from an independently built ledger.
    const d2Sum = ledgerSumForRec(d2.rec_id);
    expect(d2Sum).toBeGreaterThan(11_000_000);
    expect(d2.allocated_u_per_wk).toBe(Math.round(d2Sum));
    // Not a reliability family: no reliability headline.
    expect(d2.reliability_u_per_wk).toBeNull();

    expect(view.active_groups.length).toBeGreaterThanOrEqual(1);
    expect(view.active_groups[0]).toMatchObject({
      detector_id: "D2",
      label: "Long sessions",
      recs: [d2],
      session_count: 3,
      total_savings_u_per_wk: Math.round(d2Sum),
    });
  });

  it("groups same-detector session recs, preserves family order, and floors minor savings", () => {
    seedWeeklySpend(500_000_000); // 0.2% floor = $1; the fixture turns otherwise cost 0
    seedValidatedRec({
      recId: "rec-d8-session-1",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 1_500_000,
      facts: { session_ids: ["sess-d8-1"], session_count: 1 },
    });
    seedValidatedRec({
      recId: "rec-d8-session-2",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 2_500_000,
      facts: { session_ids: ["sess-d8-2"], session_count: 1 },
    });
    seedValidatedRec({
      recId: "rec-d8-minor",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 999_999,
      facts: { session_ids: ["sess-d8-minor"], session_count: 1 },
    });
    // High standalone estimate, but almost fully overlapped: its net headline is below the floor.
    seedValidatedRec({
      recId: "rec-d8-overlapped",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 5_000_000,
      facts: { session_ids: ["sess-d8-overlapped"], session_count: 1 },
    });

    // PP1: session-scoped recs are retired unless at least one evidence session is live
    // (last_turn_at within 7d). Seed the referenced sessions as live so this test exercises
    // grouping/ranking rather than retirement.
    for (const sid of ["sess-d8-1", "sess-d8-2", "sess-d8-minor", "sess-d8-overlapped"]) {
      seedLiveSessionFor(sid);
    }
    // Net headlines (µ$) differ from the standalone savings above. Session-1 has two claims.
    addSpendClaims([
      { recId: "rec-d8-session-1", detectorId: "D8", value_u: 700_000 },
      { recId: "rec-d8-session-1", detectorId: "D8", value_u: 500_000 },
      { recId: "rec-d8-session-2", detectorId: "D8", value_u: 2_000_000 },
      { recId: "rec-d8-minor", detectorId: "D8", value_u: 300_000 },
      { recId: "rec-d8-overlapped", detectorId: "D8", value_u: 100_000 },
    ]);

    const view = listRecommendations("ws-alpha").data;
    if (view === null) throw new Error("null data");
    const byId = new Map(view.active.map((rec) => [rec.rec_id, rec]));

    // allocated == Σ that rec's claims (exact), while modeled_savings_u_per_wk is unchanged.
    expect(byId.get("rec-d8-session-1")?.allocated_u_per_wk).toBe(1_200_000);
    expect(byId.get("rec-d8-session-1")?.modeled_savings_u_per_wk).toBe(1_500_000);
    expect(byId.get("rec-d8-session-2")?.allocated_u_per_wk).toBe(2_000_000);
    expect(byId.get("rec-d8-overlapped")?.allocated_u_per_wk).toBe(100_000);
    expect(byId.get("rec-d8-overlapped")?.modeled_savings_u_per_wk).toBe(5_000_000);

    // The group floor and totals follow the headline: session-1 (1.2M) and session-2 (2.0M) are
    // above the $1M floor; minor (0.3M) and overlapped (0.1M, despite a $5M standalone) are below.
    const d8 = view.active_groups.find((group) => group.detector_id === "D8");
    expect(d8?.recs.map((rec) => rec.rec_id).sort()).toEqual([
      "rec-d8-session-1",
      "rec-d8-session-2",
    ]);
    expect(d8?.total_savings_u_per_wk).toBe(
      (d8?.recs ?? []).reduce((sum, rec) => sum + (rec.allocated_u_per_wk ?? 0), 0),
    );
    expect(d8?.total_savings_u_per_wk).toBe(3_200_000);

    expect(view.active.map((rec) => rec.rec_id)).toContain("rec-d8-minor");
    const minorGroup = view.active_groups.find((group) => group.detector_id === "MINOR_ITEMS");
    expect(minorGroup?.recs.map((rec) => rec.rec_id).sort()).toEqual([
      "rec-d8-minor",
      "rec-d8-overlapped",
    ]);
    expect(minorGroup?.total_savings_u_per_wk).toBe(400_000);

    // B5: groups follow the ranked spine — ordered by their members' absolute $/wk
    // DESC, not by detector family. The base global D2 rec ($8.97/wk) outranks the
    // workspace D8 recs, so D2 is the first group.
    expect(view.active_groups[0]?.detector_id).toBe("D2");
  });

  it("emits pct_of_weekly_spend (0–100) for workspace recs, null for null-scope and zero-spend", () => {
    // Null-scope rec (base D2, scope null): no single-workspace denominator → null badge.
    const base = listRecommendations().data;
    if (base === null) throw new Error("null data");
    const d2 = base.active.find((rec) => rec.detector_id === "D2");
    expect(d2?.scope_workspace_id).toBeNull();
    expect(d2?.pct_of_weekly_spend).toBeNull();

    // Workspace-scoped D8 rec with a live evidence session so PP1 keeps it active.
    seedValidatedRec({
      recId: "rec-d8-pct",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 2_500_000,
      facts: { session_ids: ["sess-d8-pct"], session_count: 1 },
    });
    db.prepare(
      `INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at,
         last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-d8-pct', 'ws-alpha', '/fake/sess-d8-pct.jsonl', ?, ?, 'RECONCILED', 10, 0, '[]')`,
    ).run(RECENT, RECENT);
    // A real allocated headline: two spend claims summing to 2_000_000 µ$ (standalone: 2_500_000).
    addSpendClaims([
      { recId: "rec-d8-pct", detectorId: "D8", value_u: 1_250_000 },
      { recId: "rec-d8-pct", detectorId: "D8", value_u: 750_000 },
    ]);

    // ws-alpha's seeded turns all cost 0 → zero weekly spend → badge suppressed.
    const zeroSpend = listRecommendations("ws-alpha").data?.active.find(
      (rec) => rec.rec_id === "rec-d8-pct",
    );
    expect(zeroSpend?.modeled_savings_u_per_wk).toBe(2_500_000);
    expect(zeroSpend?.allocated_u_per_wk).toBe(2_000_000);
    expect(zeroSpend?.pct_of_weekly_spend).toBeNull();
    // No spend anywhere → no total-spend percentage either.
    expect(zeroSpend?.pct_of_total_weekly_spend).toBeNull();

    // Give ws-alpha 10_000_000 µUSD of reconciled weekly spend. P3.L L6: pct_of_weekly_spend
    // follows allocated_u_per_wk (2_000_000), not modeled_savings_u_per_wk (2_500_000):
    // 2_000_000 / 10_000_000 × 100 = 20, not 25.
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
         cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
         provisional, parser_version)
       VALUES ('msg-pct-spend', 'sess-d8-pct', 'ws-alpha', ?, 'claude-sonnet', 0,
         0, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', 10000000, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(RECENT);
    // Ingest-only changes may reuse the cached response for 60 s; read after that window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const withSpend = listRecommendations("ws-alpha").data?.active.find(
      (rec) => rec.rec_id === "rec-d8-pct",
    );
    const all = listRecommendations().data;
    vi.useRealTimers();
    expect(withSpend?.pct_of_weekly_spend).toBeCloseTo(20, 9);
    // Layout review 2 item 1 (operator 2026-09-26): % of total weekly spend across all
    // workspaces. Only ws-alpha has spend (10M), so the total-spend share is the same 20.
    expect(withSpend?.pct_of_total_weekly_spend).toBeCloseTo(20, 9);
    const d2All = all?.active.find((rec) => rec.detector_id === "D2");
    // Global recs now carry their share of total weekly spend (the scope's denominator).
    expect(d2All?.pct_of_weekly_spend).toBeCloseTo(
      d2All?.pct_of_total_weekly_spend ?? Number.NaN,
      9,
    );
    // P3.L L6: pct_of_total_weekly_spend follows allocated_u_per_wk, not
    // modeled_savings_u_per_wk — the base D2 rec is fired by real long-context session
    // data (beforeEach), so its allocated figure may differ from the standalone model.
    expect(d2All?.pct_of_total_weekly_spend).toBeCloseTo(
      ((d2All?.allocated_u_per_wk ?? 0) / 10_000_000) * 100,
      6,
    );
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
    expect(res.data?.active.filter((rec) => rec.detector_id === "D2")).toHaveLength(1);
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
      label: "Long sessions",
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

  it("scales the floor with the scope's 7d spend: 0.2%, workspace vs global, zero spend", () => {
    // $0.30/wk: under the old fixed $1 floor, but 0.6% of a $50 week, so it stays a card.
    const small = makeRecommendation({
      rec_id: "rec-small-low-spend",
      detector_id: "D2",
      modeled_savings_u_per_wk: 300_000,
    });
    const lowSpend: ScopeSpendU = { global: 50_000_000, byWorkspace: new Map() };
    expect(deriveActiveGroups([small], lowSpend).map((g) => g.detector_id)).toEqual(["D2"]);

    // $3/wk: over the old fixed $1 floor, but 0.06% of a $5,000 week, so it is minor.
    const big = makeRecommendation({
      rec_id: "rec-big-high-spend",
      detector_id: "D2",
      modeled_savings_u_per_wk: 3_000_000,
    });
    const highSpend: ScopeSpendU = { global: 5_000_000_000, byWorkspace: new Map() };
    expect(deriveActiveGroups([big], highSpend).map((g) => g.detector_id)).toEqual([
      MINOR_ITEMS_GROUP_ID,
    ]);

    // A workspace rec is judged against its own workspace's spend, not the global total.
    const wsRec = makeRecommendation({
      rec_id: "rec-ws",
      detector_id: "D8",
      scope_workspace_id: "ws-small",
      modeled_savings_u_per_wk: 300_000,
    });
    const scoped: ScopeSpendU = {
      global: 5_000_000_000,
      byWorkspace: new Map([["ws-small", 50_000_000]]),
    };
    expect(deriveActiveGroups([wsRec], scoped).map((g) => g.detector_id)).toEqual(["D8"]);
    expect(
      deriveActiveGroups([{ ...wsRec, scope_workspace_id: null }], scoped).map(
        (g) => g.detector_id,
      ),
    ).toEqual([MINOR_ITEMS_GROUP_ID]);

    // Exactly at 0.2% is not below the floor; no spend means nothing is above it.
    expect(deMinimisFloorU(1_000_000_000)).toBe(2_000_000);
    const zero: ScopeSpendU = { global: 0, byWorkspace: new Map() };
    expect(deriveActiveGroups([big], zero).map((g) => g.detector_id)).toEqual([
      MINOR_ITEMS_GROUP_ID,
    ]);
  });

  // Amended 2026-10-13 (operator): cache cards no longer have a stricter 1% gate.
  it("applies the same 0.2% floor to cache cards (B1-B4) as to other detectors", () => {
    // $500 of spend: the floor is $1 (1_000_000 µ$) for every detector.
    const b1Above = makeRecommendation({
      rec_id: "rec-b1-above",
      detector_id: "B1",
      modeled_savings_u_per_wk: 1_000_000,
    });
    const b3Under = makeRecommendation({
      rec_id: "rec-b3-under",
      detector_id: "B3",
      modeled_savings_u_per_wk: 999_999,
    });
    const d8Under = makeRecommendation({
      rec_id: "rec-d8-under",
      detector_id: "D8",
      modeled_savings_u_per_wk: 999_999,
    });

    const groups = deriveActiveGroups([b1Above, b3Under, d8Under]);

    expect(groups.map((group) => [group.detector_id, group.recs])).toEqual([
      ["B1", [b1Above]],
      [MINOR_ITEMS_GROUP_ID, [b3Under, d8Under]],
    ]);
  });

  it("routes a range whose top is under the floor to minor items (review 6 R6-17)", () => {
    const smallRange = makeRecommendation({
      rec_id: "rec-small-range",
      detector_id: "D11",
      modeled_savings_u_per_wk: null,
      range_u_per_wk: [76_043, 161_302],
    });
    const bigRange = makeRecommendation({
      rec_id: "rec-big-range",
      detector_id: "D7",
      modeled_savings_u_per_wk: null,
      range_u_per_wk: [900_000, 1_200_000],
    });

    const groups = deriveActiveGroups([smallRange, bigRange]);

    expect(groups.map((group) => [group.detector_id, group.recs])).toEqual([
      ["D7", [bigRange]],
      [MINOR_ITEMS_GROUP_ID, [smallRange]],
    ]);
  });

  it("labels every detector group with a name, not an id (review 6 R6-16)", () => {
    const ids = readdirSync(new URL("../../src/detector/detectors/", import.meta.url))
      .map((file) => /^([a-z]\d+)_/.exec(file)?.[1]?.toUpperCase())
      .filter((id): id is string => id !== undefined);
    const groups = deriveActiveGroups(
      // $10 clears every floor, including the 1% cache gate, so each detector keeps its group.
      ids.map((detector_id) =>
        makeRecommendation({
          rec_id: `rec-${detector_id}`,
          detector_id,
          modeled_savings_u_per_wk: 10_000_000,
        }),
      ),
    );
    expect(groups).toHaveLength(ids.length);
    for (const group of groups) expect(group.label).not.toMatch(/^[A-Z]\d+$/);
    const label = (id: string) => groups.find((group) => group.detector_id === id)?.label;
    expect(label("A1")).toBe("Large tool results");
    expect(label("C1")).toBe("Failed tool calls");
    expect(label("C9")).toBe("Guard blocks");
    expect(label("D11")).toBe("Shell errors");
  });

  it("orders detector families by group total $, appends minor items last", () => {
    const active = [
      makeRecommendation({
        rec_id: "a1-big",
        detector_id: "A1",
        modeled_savings_u_per_wk: 5_000_000,
      }),
      makeRecommendation({
        rec_id: "d6-a",
        detector_id: "D6",
        modeled_savings_u_per_wk: 4_000_000,
      }),
      makeRecommendation({
        rec_id: "d6-b",
        detector_id: "D6",
        modeled_savings_u_per_wk: 3_000_000,
      }),
      makeRecommendation({ rec_id: "d4", detector_id: "D4", modeled_savings_u_per_wk: 2_000_000 }),
      makeRecommendation({
        rec_id: "rec-minor",
        detector_id: "D8",
        modeled_savings_u_per_wk: ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U - 1,
      }),
    ];

    // D6 totals $7 (best card $4) and so leads A1 ($5, one card).
    expect(deriveActiveGroups(active).map((group) => group.detector_id)).toEqual([
      "D6",
      "A1",
      "D4",
      MINOR_ITEMS_GROUP_ID,
    ]);
  });

  it("ranks a standalone-lane card (E1) by the modeled $ its meter shows", () => {
    const standalone = {
      basis: "E" as const,
      rank_value_u_per_wk: 1,
      summable: false,
      label: "e1",
    };
    const active = [
      makeRecommendation({ rec_id: "d6", detector_id: "D6", modeled_savings_u_per_wk: 7_000_000 }),
      makeRecommendation({
        rec_id: "e1",
        detector_id: "E1",
        allocated_u_per_wk: null,
        reliability_u_per_wk: null,
        modeled_savings_u_per_wk: 8_000_000,
        estimate: standalone,
      }),
    ];

    expect(deriveActiveGroups(active).map((group) => group.detector_id)).toEqual(["E1", "D6"]);
  });

  it("orders a standalone-lane group by its largest card, not the overlapping sum", () => {
    const standalone = {
      basis: "E" as const,
      rank_value_u_per_wk: 1,
      summable: false,
      label: "e1",
    };
    const e1 = (rec_id: string, modeled: number) =>
      makeRecommendation({
        rec_id,
        detector_id: "E1",
        allocated_u_per_wk: null,
        reliability_u_per_wk: null,
        modeled_savings_u_per_wk: modeled,
        estimate: standalone,
      });
    const active = [
      e1("e1-a", 8_000_000),
      e1("e1-b", 5_000_000),
      makeRecommendation({ rec_id: "d8", detector_id: "D8", modeled_savings_u_per_wk: 10_000_000 }),
    ];

    // E1 sums to $13 but its estimates overlap, so it ranks at $8, after D8 ($10).
    expect(deriveActiveGroups(active).map((group) => group.detector_id)).toEqual(["D8", "E1"]);
  });

  it("keeps first-seen detector-family order when group totals tie", () => {
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

describe("$/wk ranking spine (B5)", () => {
  it("ranks by absolute $/wk DESC across detector families, not by detector priority", () => {
    // D1 rec — category CONTEXT — with the HIGHER modeled $/wk.
    seedValidatedRec({
      recId: "rec-rank-d1",
      templateId: "D1_CONTEXT_ALWAYS_LOADED",
      scope: "ws-rank",
      savings: 500,
    });

    // D8 rec — category CACHE — with a LOWER modeled $/wk than D1. Under the old
    // detector-priority spine D8 always led; under B5 the higher $/wk wins.
    seedValidatedRec({
      recId: "rec-rank-d8",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-rank",
      savings: 200,
      facts: { churn_event_count: 5, total_churn_creation_tokens: 250_000 },
    });

    const view = listRecommendations("ws-rank").data;
    if (view === null) throw new Error("null data");
    const active = view.active;

    const d8Idx = active.findIndex((r) => r.rec_id === "rec-rank-d8");
    const d1Idx = active.findIndex((r) => r.rec_id === "rec-rank-d1");
    expect(d8Idx).toBeGreaterThanOrEqual(0);
    expect(d1Idx).toBeGreaterThanOrEqual(0);
    // B5: absolute $/wk is the GLOBAL primary key — D1 (µUSD 500) ranks above D8 (200),
    // reversing the old detector-priority spine where D8 always led regardless of $/wk.
    expect(d1Idx).toBeLessThan(d8Idx);
  });

  it("ranks WARNING confidence above higher modeled savings within one detector bucket", () => {
    seedValidatedRec({
      recId: "rec-hi-conf",
      templateId: "D2_LONG_FULL_CONTEXT",
      scope: "ws-confidence",
      savings: 1_000_000,
    });
    seedValidatedRec({
      recId: "rec-lo-conf",
      templateId: "D2_LONG_FULL_CONTEXT",
      scope: "ws-confidence",
      savings: 9_000_000,
    });

    const view = listRecommendations("ws-confidence").data;
    if (view === null) throw new Error("null data");
    const hiConfidenceIdx = view.active.findIndex((r) => r.rec_id === "rec-hi-conf");
    const lowConfidenceIdx = view.active.findIndex((r) => r.rec_id === "rec-lo-conf");

    expect(hiConfidenceIdx).toBeGreaterThanOrEqual(0);
    expect(lowConfidenceIdx).toBeGreaterThanOrEqual(0);
    expect(hiConfidenceIdx).toBeLessThan(lowConfidenceIdx);
  });
});

describe("D11 tool routing actionability", () => {
  it("persists and returns a typed route_tool step with actionability enabled", () => {
    const insert = db.prepare(
      `INSERT INTO tool_events
         (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha)
       VALUES (?, 'sess-long-1', ?, ?, 1, NULL, NULL, ?, NULL)`,
    );
    for (let index = 0; index < 100; index++) {
      insert.run(`d11-bash-${index}`, RECENT, "Bash", index < 7 ? "ERROR" : "OK");
    }
    for (let index = 0; index < 60; index++) {
      insert.run(`d11-powershell-${index}`, RECENT, "PowerShell", index < 18 ? "ERROR" : "OK");
    }
    // D11 counts only failures the shell caused (review 3 B3).
    const content = db.prepare(
      "INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)",
    );
    for (let index = 0; index < 18; index++) {
      content.run(
        `d11-powershell-${index}`,
        JSON.stringify({
          error: `Exit code 1\nx${index} : The term 'x${index}' is not recognized as the name of a cmdlet.`,
        }),
      );
      if (index < 7)
        content.run(
          `d11-bash-${index}`,
          JSON.stringify({
            error: `Exit code 127\n/usr/bin/bash: line 1: x${index}: command not found`,
          }),
        );
    }
    runDetectors(db, { now: NOW });

    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    // B5: D11 (tool-routing, directional / null-$/wk) lives in the Track-D friction lane,
    // not the ranked $/wk list.
    const d11 = view.active.find((rec) => rec.detector_id === "D11");
    if (d11 === undefined) throw new Error("expected D11 recommendation");
    expect(d11.actionability_ok).toBe(true);
    expect(d11.actions?.primary.summary).toBeTruthy();
    expect(d11.state).toBe("PROPOSED");
    // Reliability lane: a number (here $0: these events have no owner turn), never the spend headline.
    expect(d11.reliability_u_per_wk).toBe(0);
    expect(d11.allocated_u_per_wk).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P2 payload enrichment tests
// ---------------------------------------------------------------------------

describe("P2 headroom enrichment", () => {
  it("D2 card has sessions_per_week, actions, and cross_workspace flag", () => {
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    const d2 = view.active[0];
    if (d2 === undefined) throw new Error("missing active rec");

    // sessions_per_week: 3 sessions inserted in beforeEach + baseline fixture sessions
    expect(typeof d2.sessions_per_week).toBe("number");
    expect((d2.sessions_per_week ?? 0) >= 3).toBe(true);

    // D2 evidence has no delta_context_tokens/turns_per_week → headroom null
    expect(d2.headroom).toBeNull();

    expect(d2.actions?.primary.summary).toBeTruthy();

    // D2 is global (scope_workspace_id null) → cross_workspace true
    expect(d2.cross_workspace).toBe(true);
    expect(d2.scope_workspace_id).toBeNull();
  });

  it("headroom is correctly derived when evidence has delta_context_tokens and turns_per_week", () => {
    // Seed a CONTEXT rec with known delta_context_tokens and turns_per_week.
    seedValidatedRec({
      recId: "rec-d1-test",
      templateId: "D1_CONTEXT_ALWAYS_LOADED",
      savings: 12_345,
      facts: { delta_context_tokens: 5_000, turns_per_week: 100, workspace_multiplier: 3 },
    });

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

    expect(d1.actions?.primary.kind).toBe("EDIT");

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
    seedValidatedRec({
      recId: "rec-div0",
      templateId: "D1_CONTEXT_ALWAYS_LOADED",
      savings: 0,
      facts: { delta_context_tokens: 1_000, turns_per_week: 50 },
      targetDb: freshDb,
    });
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

  it("lists a D4 card again now that it counts only lookup subagents (review 1 R2.14)", () => {
    seedValidatedRec({
      recId: "rec-d4-subagents",
      templateId: "D4_MODEL_MISMATCH",
      scope: "ws-alpha",
      facts: {
        total_opus_turns_per_week: 100,
        mismatch_turns_per_week: 60,
        opus_subagent_count: 10,
        lookup_subagent_count: 4,
        mismatch_fraction: 0.6,
        avg_input_tokens: 80_000,
        avg_output_tokens: 120,
      },
    });
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    const card = view.active.find((r) => r.rec_id === "rec-d4-subagents");
    expect(card?.trigger?.problem).toContain("4 of 10 Opus subagents");
  });

  it("ranked by savings DESC within priority group; D5 limit warnings show in the strip", () => {
    // Deliberately decouple savings from headroom so the tiebreak sort key (savings DESC)
    // is tested independently of headroom. rec-ctx-hi has HIGH headroom (50K) but LOW
    // savings (50); rec-ctx-lo has LOW headroom (20K) but HIGH savings (200).
    // Under byArticlePriority: both use D5 → priority 99 each; savings DESC puts
    // rec-ctx-lo first. Under the old headroom-based sort rec-ctx-hi would win — this
    // fixture detects a regression to headroom ordering.
    seedValidatedRec({
      recId: "rec-ctx-lo",
      templateId: "D1_CONTEXT_ALWAYS_LOADED",
      savings: 200,
      facts: { delta_context_tokens: 2_000, turns_per_week: 10 },
    });
    seedValidatedRec({
      recId: "rec-ctx-hi",
      templateId: "D1_CONTEXT_ALWAYS_LOADED",
      savings: 50,
      facts: { delta_context_tokens: 5_000, turns_per_week: 10 },
    });
    seedValidatedRec({ recId: "rec-limit-1", templateId: "D5_LIMIT_BURN_WARNING", savings: 0 });
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    const active = view.active;

    // LIMIT recs never join active (taxonomy §7 IA §4 §2.1). U7: D5 is no longer hidden; it
    // forecasts from the API's used_pct readings, and renders once, in the warning strip.
    expect(active.filter((r) => r.category === "LIMIT")).toHaveLength(0);
    expect(view.limit_warnings.find((r) => r.rec_id === "rec-limit-1")).toBeDefined();
    expect(view.history.find((r) => r.rec_id === "rec-limit-1")).toBeUndefined();

    // Within CONTEXT (same D5 priority group=99), savings DESC is the tiebreak.
    // rec-ctx-lo (savings=200) must rank BEFORE rec-ctx-hi (savings=50),
    // even though rec-ctx-hi has higher headroom (50K > 20K).
    const ctxRecs = active.filter((r) => r.category === "CONTEXT");
    const hiIdx = ctxRecs.findIndex((r) => r.rec_id === "rec-ctx-hi");
    const loIdx = ctxRecs.findIndex((r) => r.rec_id === "rec-ctx-lo");
    if (hiIdx !== -1 && loIdx !== -1) {
      expect(hiIdx).toBeLessThan(loIdx); // unestimated rows use the created_at and rec_id tiebreak
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
    seedValidatedRec({ recId, templateId: "D2_LONG_FULL_CONTEXT", savings: 2_000_000 });
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

describe("P2H — per-session recency remains visible", () => {
  const LIVE_TS = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2d ago (in 7d window)
  const DEAD_TS = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30d ago (out of window)

  function seedSession(sessionId: string, lastTurnAt: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at,
         last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED', 10, 0, '[]')`,
    ).run(sessionId, `/fake/${sessionId}.jsonl`, lastTurnAt, lastTurnAt);
  }

  function seedRec(
    recId: string,
    templateId: RecommendationTemplateId,
    facts: Record<string, unknown>,
  ): void {
    seedValidatedRec({ recId, templateId, scope: "ws-alpha", facts });
  }

  function activeIds(): string[] {
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    return view.active.map((r) => r.rec_id);
  }

  it("keeps a per-session rec whose only evidence session is outside the 7d window", () => {
    seedSession("sess-dead", DEAD_TS);
    seedRec("rec-D7-dead", "D7_RETRY_LOOP", { session_ids: ["sess-dead"], session_count: 1 });
    expect(activeIds()).toContain("rec-D7-dead");
  });

  it("keeps a per-session rec whose evidence session is still live", () => {
    seedSession("sess-live", LIVE_TS);
    seedRec("rec-D7-live", "D7_RETRY_LOOP", { session_ids: ["sess-live"], session_count: 1 });
    expect(activeIds()).toContain("rec-D7-live");
  });

  it("keeps a zero-session rec (no session_id in evidence) — not session-testable", () => {
    seedRec("rec-D1-zerosession", "D1_CONTEXT_ALWAYS_LOADED", {});
    expect(activeIds()).toContain("rec-D1-zerosession");
  });

  it("keeps a multi-session rec when at least one session_id is still live", () => {
    seedSession("sess-mix-dead", DEAD_TS);
    seedSession("sess-mix-live", LIVE_TS);
    seedRec("rec-D8-mixed", "D8_CACHE_WRITE_CHURN", {
      session_ids: ["sess-mix-dead", "sess-mix-live"],
      session_count: 2,
    });
    expect(activeIds()).toContain("rec-D8-mixed");
  });

  it("keeps a multi-session rec when every session_id is outside the window", () => {
    seedSession("sess-md-1", DEAD_TS);
    seedSession("sess-md-2", DEAD_TS);
    seedRec("rec-D8-alldead", "D8_CACHE_WRITE_CHURN", {
      session_ids: ["sess-md-1", "sess-md-2"],
      session_count: 2,
    });
    expect(activeIds()).toContain("rec-D8-alldead");
  });

  it("does not change the persisted state of a stale rec", () => {
    seedSession("sess-dead2", DEAD_TS);
    seedRec("rec-D7-dead2", "D7_RETRY_LOOP", { session_ids: ["sess-dead2"], session_count: 1 });
    listRecommendations();
    const row = db
      .prepare("SELECT state FROM recommendations WHERE rec_id=?")
      .get("rec-D7-dead2") as { state: string } | undefined;
    expect(row?.state).toBe("PROPOSED");
  });

  it("restores a stale rec to active when its snooze expires", () => {
    seedSession("sess-dead3", DEAD_TS);
    seedRec("rec-D7-dead3", "D7_RETRY_LOOP", { session_ids: ["sess-dead3"], session_count: 1 });
    db.prepare(
      "UPDATE recommendations SET state='DISMISSED', dismissed_until=? WHERE rec_id=?",
    ).run("2020-01-01T00:00:00.000Z", "rec-D7-dead3"); // expired snooze
    const view = listRecommendations().data;
    if (view === null) throw new Error("null data");
    expect(view.active.some((r) => r.rec_id === "rec-D7-dead3")).toBe(true);
    expect(view.dismissed.some((r) => r.rec_id === "rec-D7-dead3")).toBe(false);
  });

  it("breaks equal unranked estimates by created_at and rec_id", () => {
    const NEWER = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1d ago
    const OLDER = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(); // 6d ago (still live)
    seedSession("sess-newer", NEWER);
    seedSession("sess-older", OLDER);
    // rec_ids are chosen so the rec_id ASC tiebreak alone would put the OLDER rec first
    // (aaa < zzz). Only the recency term can flip the newer rec ahead — so this test fails
    // if the recency tiebreak is removed.
    seedRec("rec-D7-aaa-older", "D7_RETRY_LOOP", { session_ids: ["sess-older"], session_count: 1 });
    seedRec("rec-D7-zzz-newer", "D7_RETRY_LOOP", { session_ids: ["sess-newer"], session_count: 1 });

    const active = activeIds();
    const iNewer = active.indexOf("rec-D7-zzz-newer");
    const iOlder = active.indexOf("rec-D7-aaa-older");
    expect(iNewer).toBeGreaterThanOrEqual(0);
    expect(iOlder).toBeGreaterThanOrEqual(0);
    expect(iOlder).toBeLessThan(iNewer);
  });
});

describe("P3.L L6 card allocation", () => {
  it("spend-producer rec with claims: allocated == round(Σ its claims); modeled is unchanged", () => {
    seedValidatedRec({
      recId: "rec-d8-frac",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 4_000_000,
      facts: { session_ids: ["sess-frac"], session_count: 1 },
    });
    seedLiveSessionFor("sess-frac");
    addSpendClaims([
      { recId: "rec-d8-frac", detectorId: "D8", value_u: 1_000_000.4 },
      { recId: "rec-d8-frac", detectorId: "D8", value_u: 1_500_000.4 },
      { recId: "rec-other", detectorId: "D8", value_u: 9_000_000 },
    ]);
    const card = listRecommendations("ws-alpha").data?.active.find(
      (rec) => rec.rec_id === "rec-d8-frac",
    );
    expect(card?.allocated_u_per_wk).toBe(2_500_001);
    expect(card?.modeled_savings_u_per_wk).toBe(4_000_000);
  });

  it("spend-producer rec with no claims is a real $0; a no-producer rec (D12) is null", () => {
    seedValidatedRec({
      recId: "rec-d8-none",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 3_000_000,
      facts: { session_ids: ["sess-none"], session_count: 1 },
    });
    seedValidatedRec({
      recId: "rec-d12",
      templateId: "D12_SUBAGENT_OVERSPAWN",
      scope: "ws-alpha",
      savings: 3_000_000,
      facts: { session_ids: ["sess-none"] },
    });
    seedLiveSessionFor("sess-none");
    const active = listRecommendations("ws-alpha").data?.active ?? [];
    const d8 = active.find((rec) => rec.rec_id === "rec-d8-none");
    const d12 = active.find((rec) => rec.rec_id === "rec-d12");
    expect(d8?.allocated_u_per_wk).toBe(0);
    expect(d8?.modeled_savings_u_per_wk).toBe(3_000_000);
    expect(d12?.allocated_u_per_wk).toBeNull();
    expect(d12?.modeled_savings_u_per_wk).toBe(3_000_000);
  });

  it("a C-family (C9) rec has a null headline even when claims exist for its id", () => {
    const payload = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: c9FindingDescriptor.rule_id,
        label: "HOOK_BLOCK",
        assessment: c9FindingDescriptor.defaults.assessment,
        routing: c9FindingDescriptor.defaults.routing,
        window: { from: RECENT, to: NOW.toISOString() },
        anchors: [
          {
            session_id: findingIds.session("c9-null-session"),
            timestamp: RECENT,
            event_id: findingIds.event("c9-null-event"),
          },
        ],
        session_ids: ["c9-null-session"],
        impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics: {
          DENIAL_CLASS: { kind: "ENUM", value: "HOOK_BLOCK" },
          COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: "NONE" },
          DENIAL_COUNT: { kind: "COUNT", value: 12 },
        },
      } as never,
      c9FindingDescriptor as never,
    );
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, contract_version, contract_status, rule_id)
      VALUES ('rec-c9-null', 'RULE', 'C9', ?, 'ws-alpha', ?, 700000, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
      c9FindingDescriptor.presentation.category,
      c9FindingDescriptor.presentation.lever,
      JSON.stringify(payload),
      c9FindingDescriptor.presentation.target_metric,
      RECENT,
      c9FindingDescriptor.rule_id,
    );
    addSpendClaims([{ recId: "rec-c9-null", detectorId: "C9", value_u: 5_000_000 }]);
    const card = listRecommendations("ws-alpha").data?.active.find(
      (rec) => rec.rec_id === "rec-c9-null",
    );
    expect(card).toBeDefined();
    expect(card?.allocated_u_per_wk).toBeNull();
    expect(card?.modeled_savings_u_per_wk).toBe(700_000);
  });

  it("getRecommendationCard(actionsOnly) builds no ledger and leaves allocated unset", () => {
    // One evidence session: card assembly itself never needs the ledger, so any ledger build on
    // this path would come from the headline allocation.
    seedValidatedRec({
      recId: "rec-d8-actions",
      templateId: "D8_CACHE_WRITE_CHURN",
      scope: "ws-alpha",
      savings: 3_000_000,
      facts: { session_ids: ["sess-actions"], session_count: 1 },
    });
    seedLiveSessionFor("sess-actions");
    const ledger = addSpendClaims([
      { recId: "rec-d8-actions", detectorId: "D8", value_u: 1_234_567 },
    ]);
    const actions = getRecommendationCard("rec-d8-actions", true);
    expect(ledger).not.toHaveBeenCalled();
    expect(actions).not.toBeNull();
    expect(actions?.allocated_u_per_wk).toBeUndefined();
    // The full path still sets the headline.
    const full = getRecommendationCard("rec-d8-actions");
    expect(ledger).toHaveBeenCalled();
    expect(full?.allocated_u_per_wk).toBe(1_234_567);
  });
});

describe("deriveActiveGroups minor/major floor for a null headline (L6)", () => {
  it("decides by the standalone modeled/range figure when allocated is null", () => {
    const below = makeRecommendation({
      rec_id: "c-below",
      detector_id: "C9",
      allocated_u_per_wk: null,
      modeled_savings_u_per_wk: ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U - 1,
    });
    const belowRange = makeRecommendation({
      rec_id: "c-below-range",
      detector_id: "C9",
      allocated_u_per_wk: null,
      modeled_savings_u_per_wk: null,
      range_u_per_wk: [0, ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U - 1],
    });
    const above = makeRecommendation({
      rec_id: "c-above",
      detector_id: "C9",
      allocated_u_per_wk: null,
      modeled_savings_u_per_wk: ACTIVE_RECOMMENDATION_DE_MINIMIS_FLOOR_U * 5,
    });
    const groups = deriveActiveGroups([below, belowRange, above]);
    const minor = groups.find((g) => g.detector_id === MINOR_ITEMS_GROUP_ID);
    expect(minor?.recs.map((r) => r.rec_id)).toEqual(["c-below", "c-below-range"]);
    expect(groups.find((g) => g.detector_id === "C9")?.recs.map((r) => r.rec_id)).toEqual([
      "c-above",
    ]);
    // A null headline adds nothing to a group total.
    expect(groups.every((g) => g.total_savings_u_per_wk === 0)).toBe(true);
  });
});

describe("safety lane (F5, operator 2026-10-04): H1 and C9 guard blocks show a count, never a $", () => {
  function insertV2(
    recId: string,
    descriptor: typeof c9FindingDescriptor | typeof h1FindingDescriptor,
    label: string,
    metrics: Record<string, { kind: "ENUM" | "COUNT"; value: string | number }>,
  ) {
    const payload = createFindingEnvelopeV2(
      {
        version: 2,
        rule_id: descriptor.rule_id,
        label,
        assessment: descriptor.defaults.assessment,
        routing: descriptor.defaults.routing,
        window: { from: RECENT, to: NOW.toISOString() },
        anchors: [
          {
            session_id: findingIds.session(`${recId}-session`),
            timestamp: RECENT,
            event_id: findingIds.event(`${recId}-event`),
          },
        ],
        session_ids: [`${recId}-session`],
        impact: { kind: "FRICTION", severity: "MEDIUM", direction: "REDUCE" },
        verdict: { value: "CONFIRMED", method: "RULE" },
        metrics,
      } as never,
      descriptor as never,
    );
    db.prepare(`INSERT INTO recommendations
      (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
       modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
       state, created_at, contract_version, contract_status, rule_id)
      VALUES (?, 'RULE', ?, ?, 'ws-alpha', ?, NULL, '{}', ?, ?, 'PROPOSED', ?, 2, 'V2_VALIDATED', ?)`).run(
      recId,
      descriptor.owner_detector_id,
      descriptor.presentation.category,
      descriptor.presentation.lever,
      JSON.stringify(payload),
      descriptor.presentation.target_metric,
      RECENT,
      descriptor.rule_id,
    );
  }
  const c9 = (denialClass: string) =>
    ({
      DENIAL_CLASS: { kind: "ENUM", value: denialClass },
      COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: "NONE" },
      DENIAL_COUNT: { kind: "COUNT", value: 12 },
    }) as const;
  const h1 = (operation: string, runs: number) =>
    ({
      DESTRUCTIVE_OPERATION: { kind: "ENUM", value: operation },
      OPERATION_COUNT: { kind: "COUNT", value: runs },
    }) as const;

  it("marks H1 and C9 HOOK_BLOCK as safety cards with no reliability $; other C9 keep theirs", () => {
    insertV2("rec-c9-guard", c9FindingDescriptor, "HOOK_BLOCK", c9("HOOK_BLOCK"));
    insertV2("rec-c9-rejected", c9FindingDescriptor, "USER_REJECTED", c9("USER_REJECTED"));
    insertV2("rec-h1-rm", h1FindingDescriptor, "DESTRUCTIVE_OPERATION_REPORTED", h1("RM_RF", 4));
    const active = listRecommendations().data?.active ?? [];
    const byId = (id: string) => active.find((card) => card.rec_id === id);
    expect(byId("rec-c9-guard")).toMatchObject({ safety_lane: true, reliability_u_per_wk: null });
    expect(byId("rec-c9-guard")?.trigger?.problem).not.toMatch(/\$/);
    const guardAction = byId("rec-c9-guard")?.actions?.primary;
    expect(guardAction?.summary).toContain("never weaken or remove a guard rule");
    expect(`${guardAction?.summary} ${guardAction?.copy_text}`).not.toMatch(/or the guard\b/);
    expect(byId("rec-h1-rm")?.safety_lane).toBe(true);
    expect(byId("rec-c9-rejected")?.safety_lane).toBeUndefined();
    expect(byId("rec-c9-rejected")?.reliability_u_per_wk).toBe(0);
  });

  it("orders safety cards by irreversibility, then count, not by rec id or session spend", () => {
    // rec ids sort the wrong way round, so only the safety order can put rm -rf first.
    insertV2(
      "rec-h1-a-truncate",
      h1FindingDescriptor,
      "DESTRUCTIVE_OPERATION_REPORTED",
      h1("TRUNCATE", 9),
    );
    insertV2(
      "rec-h1-b-clean",
      h1FindingDescriptor,
      "DESTRUCTIVE_OPERATION_REPORTED",
      h1("GIT_CLEAN", 4),
    );
    insertV2("rec-h1-c-rm", h1FindingDescriptor, "DESTRUCTIVE_OPERATION_REPORTED", h1("RM_RF", 4));
    insertV2("rec-a-c9-guard", c9FindingDescriptor, "HOOK_BLOCK", c9("HOOK_BLOCK"));
    const safety = (listRecommendations().data?.active ?? [])
      .filter((card) => card.safety_lane)
      .map((card) => card.rec_id);
    expect(safety).toEqual([
      "rec-h1-c-rm",
      "rec-h1-b-clean",
      "rec-h1-a-truncate",
      "rec-a-c9-guard",
    ]);
  });
});
