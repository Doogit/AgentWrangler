/**
 * src/ui/api/fixtures.ts — Mock fixture data for dev/test.
 *
 * Provides fixture-shaped ApiResponse<T> objects so the UI renders
 * fully without the daemon. Built against the frozen API contract types.
 *
 * Integration: flip USE_MOCK in client.ts to switch from fixtures to real fetch.
 */

import type { PracticeEntry, PracticesResult } from "../../detector/practice-registry";
import type { OAuthStatus } from "../../oauth/credentials";
import type { GithubTokenStatus } from "../../outcomes/github/credential";
import type { BurnStatus } from "../../query/api/burn-status";
import type { ContextComposition } from "../../query/api/context-composition";
import type { CostPerSuccess } from "../../query/api/cost-per-success";
import type { ClosureProxy } from "../../query/api/effectiveness";
import type { EfficiencyHeadroom } from "../../query/api/efficiency-headroom";
import type { HeadroomTrendData } from "../../query/api/headroom-trend";
import type { HookConfigResponse } from "../../query/api/hook-config";
import type {
  LinkageRateData,
  SuccessRateData,
  WorkspaceOutcomeSummary,
} from "../../query/api/outcomes";
import type {
  BurnForecast,
  ContextPerTurnRow,
  GlobalOverview,
  LiveSessionRow,
  ModelMixRow,
  PagedList,
  SessionSummary,
  TurnRow,
  WindowFilter,
  WorkspaceSummary,
} from "../../query/api/overview";
import type {
  BoundedStep,
  RecommendationCard,
  RecommendationsView,
} from "../../query/api/recommendations";
import type { EffectRow, LedgerEntry, LedgerView } from "../../query/api/recommendations-ledger";
import type { Report } from "../../query/api/reports";
import type { SessionDrivers } from "../../query/api/session-drivers";
import type {
  CalibrateResult,
  ParserHealth,
  QuarantineRow,
  Settings,
  SettingsUpdate,
  WorkspaceMapping,
} from "../../query/api/settings";
import type { FlavorDecomposition, FlavorRow } from "../../query/api/spend-flavor";
import type { CacheWriteBucketRow, CacheWriteTrend, TrendData } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import type { HotSessionRow } from "../../query/spend";
import type { DaemonStatus } from "./client";

// 1 USD = 1,000,000 micro-USD
const MICRO = 1_000_000;

function windowFor(preset: "24h" | "7d" | "30d"): { from: string; to: string; preset: string } {
  const to = new Date("2026-08-23T00:00:00Z");
  const hours = preset === "24h" ? 24 : preset === "7d" ? 168 : 720;
  const from = new Date(to.getTime() - hours * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString(), preset };
}

function baseMeta(
  window: { from: string; to: string; preset?: string },
  n: number,
): {
  n: number;
  window: { from: string; to: string; preset?: string };
  qualification: {
    provisional_excluded: boolean;
    unpriced_turns: number;
    claim_kinds_count: number;
    note: string;
  };
  metric_definition_version: "observe-1";
  claim_kind: "LIST_EQUIV";
  drilldown_ids: Record<string, never>;
} {
  return {
    n,
    window,
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "",
    },
    metric_definition_version: "observe-1",
    claim_kind: "LIST_EQUIV",
    drilldown_ids: {},
  };
}

export function mockGlobalOverview(filter: WindowFilter): ApiResponse<GlobalOverview> {
  const preset = filter.preset ?? "7d";
  const window = windowFor(preset);

  const forecast: BurnForecast = {
    state: "OFF",
    limit_tokens: null,
    tokens_used: 2_450_000_000,
    tokens_per_day: null,
    projected_exhaustion_jd: null,
    warn_threshold_days: 2,
  };

  const context_per_turn: ContextPerTurnRow[] = [
    {
      model: "claude-opus-5",
      n: 8089,
      avg_context_per_turn: 238_000,
      avg_output_per_turn: 1146,
      usd_per_turn: 0.624,
    },
    {
      model: "claude-sonnet-5",
      n: 3767,
      avg_context_per_turn: 248_000,
      avg_output_per_turn: 890,
      usd_per_turn: 0.101,
    },
    {
      model: "claude-fable-5",
      n: 119,
      avg_context_per_turn: 278_000,
      avg_output_per_turn: 620,
      usd_per_turn: 0.018,
    },
  ];

  const model_mix: ModelMixRow[] = [
    { model: "claude-opus-5", turns: 8089 },
    { model: "claude-sonnet-5", turns: 3767 },
    { model: "claude-fable-5", turns: 119 },
  ];

  const data: GlobalOverview = {
    cost_equiv_u: Math.round(5042.23 * MICRO),
    turns: 11_975,
    turns_total: 20_616,
    unpriced_turns: 0,
    live_sessions: 0,
    forecast,
    context_per_turn,
    model_mix,
  };

  return { data, meta: baseMeta(window, 1) };
}

export function mockWorkspaces(filter: WindowFilter): ApiResponse<PagedList<WorkspaceSummary>> {
  const preset = filter.preset ?? "7d";
  const window = windowFor(preset);
  const total = 5042.23 * MICRO;

  const items: WorkspaceSummary[] = [
    {
      workspace_id: "ws-1",
      project_slug: "orbit-api",
      repo_path: "C:/Users/dev/GitHub/orbit-api",
      repo_owner: "acme",
      repo_name: "orbit-api",
      cost_equiv_u: Math.round(1800 * MICRO),
      turns: 4200,
      cost_share: 1800 / 5042.23,
      has_live: false,
      usd_per_turn: 1800 / 4200,
      avg_context_per_turn: 238_000,
      cache_write_pct: 0.12,
      opus_pct: 0.67,
    },
    {
      workspace_id: "ws-2",
      project_slug: "support-portal",
      repo_path: "C:/Users/dev/GitHub/support-portal",
      repo_owner: "acme",
      repo_name: "support-portal",
      cost_equiv_u: Math.round(1200 * MICRO),
      turns: 2800,
      cost_share: 1200 / 5042.23,
      has_live: false,
      usd_per_turn: 1200 / 2800,
      avg_context_per_turn: 180_000,
      cache_write_pct: 0.09,
      opus_pct: 0.45,
    },
    {
      workspace_id: "ws-3",
      project_slug: "data-janitor",
      repo_path: "C:/Users/dev/GitHub/data-janitor",
      repo_owner: "acme",
      repo_name: "data-janitor",
      cost_equiv_u: Math.round(900 * MICRO),
      turns: 2100,
      cost_share: 900 / 5042.23,
      has_live: false,
      usd_per_turn: 900 / 2100,
      avg_context_per_turn: 120_000,
      cache_write_pct: 0.18,
      opus_pct: 0.3,
    },
    {
      workspace_id: "ws-4",
      project_slug: "admin-console",
      repo_path: "C:/Users/dev/GitHub/admin-console",
      repo_owner: "acme",
      repo_name: "admin-console",
      cost_equiv_u: Math.round(700 * MICRO),
      turns: 1630,
      cost_share: 700 / 5042.23,
      has_live: false,
      usd_per_turn: 700 / 1630,
      avg_context_per_turn: 95_000,
      cache_write_pct: 0.07,
      opus_pct: 0.22,
    },
    {
      workspace_id: "ws-5",
      project_slug: "AgentWrangler",
      repo_path: "C:/Users/dev/GitHub/AgentWrangler",
      repo_owner: "acme",
      repo_name: "AgentWrangler",
      cost_equiv_u: Math.round(total - (1800 + 1200 + 900 + 700) * MICRO),
      turns: 1245,
      cost_share: (5042.23 - 4600) / 5042.23,
      has_live: false,
      usd_per_turn: (5042.23 - 4600) / 1245,
      avg_context_per_turn: 210_000,
      cache_write_pct: 0.14,
      opus_pct: 0.55,
    },
  ];

  return {
    data: { items, next_cursor: null },
    meta: baseMeta(window, items.length),
  };
}

// ---------------------------------------------------------------------------
// Settings fixtures
// ---------------------------------------------------------------------------

const MOCK_PARSER_HEALTH: ParserHealth = {
  files_seen: 42,
  files_parsed: 40,
  lines_quarantined: 2,
  synthetic_excluded: 5,
  duplicate_drops: 3,
  parser_version_mix: { "ingest-1": 40 },
};

/** Aggregate-only first-run status; callers can override individual counters. */
export function mockStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    sessions: 5,
    files_seen: MOCK_PARSER_HEALTH.files_seen,
    files_parsed: MOCK_PARSER_HEALTH.files_parsed,
    ...overrides,
  };
}

const MOCK_WORKSPACE_MAPPINGS: WorkspaceMapping[] = [
  {
    workspace_id: "ws-1",
    project_slug: "orbit-api",
    repo_path: "/home/dev/orbit-api",
    repo_canonical: "acme-corp/orbit-api",
    is_transient: false,
  },
  {
    workspace_id: "ws-2",
    project_slug: "AgentWrangler",
    repo_path: null,
    repo_canonical: null,
    is_transient: true,
    mapping_reason: "No working directory recorded in transcripts yet.",
  },
];

const MOCK_QUARANTINE: QuarantineRow[] = [
  {
    file_path: "/home/user/.claude/projects/example.jsonl",
    line_no: 17,
    error_class: "MalformedJson",
    seen_at: "2026-08-23T23:59:00Z",
  },
];

const MOCK_REPORTS: Report[] = [
  {
    report_id: "weekly-2026-08-17T00:00:00.000Z",
    kind: "weekly",
    period_start: "2026-08-17T00:00:00.000Z",
    period_end: "2026-08-24T00:00:00.000Z",
    generated_at: "2026-08-24T00:00:01.000Z",
    content_json: JSON.stringify({
      spend: { cost_equiv_u: 99125, turns: 9, turns_total: 10, unpriced_turns: 0 },
      top_recommendations: [{ rec_id: "rec-D2-global-1", modeled_savings_u_per_wk: 8969400 }],
      outcomes: {
        terminal_n: 12,
        success_rate: 0.75,
        clean_success_n: 7,
        with_deferrals_n: 2,
        no_ci_success_n: 1,
        linkage_rate: 0.62,
      },
    }),
  },
];

export function mockReports(): Report[] {
  return MOCK_REPORTS.map((report) => ({ ...report }));
}

export function mockReport(id: string): Report | null {
  return mockReports().find((report) => report.report_id === id) ?? null;
}

export function mockSettings(): ApiResponse<Settings> {
  const now = new Date("2026-08-24T00:00:00Z");
  const window = { from: now.toISOString(), to: now.toISOString() };
  const data: Settings = {
    db_path: "/home/user/.agentwrangler/db.sqlite",
    scan_roots: ["/home/user/.claude/projects"],
    port: 47821,
    activity_window_secs: 300,
    limit_tokens: null,
    limit_provenance: null,
    limit_resets_at: null,
    workspace_mappings: MOCK_WORKSPACE_MAPPINGS,
    parser_health: MOCK_PARSER_HEALTH,
    quarantine_rows: MOCK_QUARANTINE,
    last_reset_at: null,
    bytes_per_token_calibration_enabled: false,
    bytes_per_token: null,
    bytes_per_token_provenance: null,
    bytes_per_token_measured_at: null,
  };
  return {
    data,
    meta: {
      n: 1,
      window,
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "",
      },
      metric_definition_version: "observe-1",
      claim_kind: "N_A",
      drilldown_ids: {},
    },
  };
}

export function mockUpdateSettings(update: SettingsUpdate): ApiResponse<Settings> {
  const current = mockSettings();
  const data = current.data;
  if (data === null) return current;
  const updated: Settings = {
    ...data,
    limit_tokens: update.limit_tokens !== undefined ? update.limit_tokens : data.limit_tokens,
    scan_roots: update.scan_roots ?? data.scan_roots,
    activity_window_secs: update.activity_window_secs ?? data.activity_window_secs,
    workspace_mappings:
      update.workspace_mappings === undefined
        ? data.workspace_mappings
        : data.workspace_mappings.map((m) => {
            const u = update.workspace_mappings?.find((x) => x.workspace_id === m.workspace_id);
            return u === undefined
              ? m
              : { ...m, repo_path: u.repo_path ?? null, repo_canonical: u.repo_canonical ?? null };
          }),
  };
  return { ...current, data: updated };
}

export function mockResetDatabase(): ApiResponse<Settings> {
  const current = mockSettings();
  const data = current.data;
  if (data === null) return current;
  const reset: Settings = {
    ...data,
    last_reset_at: new Date().toISOString(),
  };
  return { ...current, data: reset };
}

// ---------------------------------------------------------------------------
// Recommendations fixtures (DetectorEngine WP)
// ---------------------------------------------------------------------------

export function mockRecommendations(): ApiResponse<RecommendationsView> {
  const window = windowFor("7d");

  const d2Card: RecommendationCard = {
    rec_id: "rec-D2-global-mock000000000000",
    detector_id: "D2",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "/clear between unrelated tasks; split long work; avoid mid-task /compact.",
    modeled_savings_u_per_wk: 874_170_000,
    run_cost_u: null,
    modeled_formula: {
      model: "D2_LONG_CONTEXT_CACHE_READ_V1",
      inputs: {
        cache_read_tokens_per_week: 1_766_000_000,
        cache_read_price_usd_per_mtok: 1.5,
        reduction_fraction: 0.33,
      },
      expression:
        "cache_read_tokens_per_week / 1e6 * cache_read_price_usd_per_mtok * reduction_fraction",
      result_usd_per_wk: 874.17,
    },
    evidence: {
      qualifying_session_count: 4,
      session_ids: ["sess-mock-1", "sess-mock-2", "sess-mock-3", "sess-mock-4"],
      turn_count_threshold: 150,
      avg_context_threshold: 180_000,
      raw_context_average_tokens_per_turn: 220_000,
      raw_context_basis: "RAW_USAGE",
      cap_weighted_burn_tokens_per_week: 176_600_000,
      cap_weighted_burn_basis: "CAP_PROXY",
      cache_read_tokens_per_week: 1_766_000_000,
      cache_read_spend_u_per_week: 2_649_000_000,
      cache_read_exposure_tokens_per_week: 1_766_000_000,
      cache_read_exposure_spend_u_per_week: 2_649_000_000,
      cache_read_exposure_spend_basis: "LIST_EQUIV",
      reduction_fraction: 0.33,
    },
    target_metric: "avg_context_per_turn",
    state: "PROPOSED",
    created_at: window.to,
    dismissed_until: null,
    // P2 enrichment
    headroom: null, // D2 evidence lacks delta_context_tokens/turns_per_week
    sessions_per_week: 4,
    steps: [
      {
        kind: "generic",
        description: "/clear between unrelated tasks; split long work; avoid mid-task /compact.",
      } satisfies BoundedStep,
    ],
    cross_workspace: true,
    workspace_multiplier: null,
    file_ref: null,
  };

  const data: RecommendationsView = {
    active: [d2Card],
    active_groups: [
      {
        detector_id: "D2",
        label: "Session hygiene",
        recs: [d2Card],
        session_count: 4,
        total_savings_u_per_wk: d2Card.modeled_savings_u_per_wk ?? 0,
      },
    ],
    limit_warnings: [],
    adopted: [],
    dismissed: [],
    detectors: [
      {
        detector_id: "D1",
        name: "CTX_ALWAYS_LOADED_OVERSIZE",
        status: "NOT_EVALUATED",
        note: "no context_inventory probe (ContextInventoryProbe not shipped in Phase-1a)",
      },
      {
        detector_id: "D2",
        name: "SESSION_LONG_FULL_CONTEXT",
        status: "ACTIVE",
        note: "4 qualifying long-context sessions this week",
      },
      {
        detector_id: "D5",
        name: "LIMIT_BURN_FORECAST",
        status: "BLOCKED",
        note: "Weekly token limit is not configured",
      },
      {
        detector_id: "D4",
        name: "MODEL_MISMATCH",
        status: "INACTIVE",
        note: "no reconciled workspace met the model-mismatch threshold",
      },
      {
        detector_id: "D6",
        name: "TOOL_RESULT_BLOAT",
        status: "INACTIVE",
        note: "no reconciled workspace met the tool-result threshold",
      },
      {
        detector_id: "D7",
        name: "LOOP_RETRY_WASTE",
        status: "INACTIVE",
        note: "no reconciled session met a loop/retry threshold",
      },
      {
        detector_id: "D8",
        name: "CACHE_WRITE_CHURN",
        status: "INACTIVE",
        note: "no reconciled session met the cache-write threshold",
      },
      {
        detector_id: "D9",
        name: "IDLE_BACKGROUND_SESSION",
        status: "INACTIVE",
        note: "no reconciled workspace met the idle-session threshold",
      },
      {
        detector_id: "D10",
        name: "CATALOG_FOOTPRINT",
        status: "NOT_EVALUATED",
        note: "catalog inventory is estimated, but active/deferred tool-load state is not measured",
      },
    ],
  };

  return {
    data,
    meta: {
      n: data.active.length,
      window,
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "",
      },
      metric_definition_version: "observe-1",
      claim_kind: "EXPERIMENTAL",
      drilldown_ids: {},
    },
  };
}

export function mockLedger(): ApiResponse<LedgerView> {
  const effectiveEffect: EffectRow = {
    rec_id: "rec-D1-global-mockledger0001",
    measured_at: "2026-08-20T09:00:00.000Z",
    before_from: "2026-08-18T00:00:00.000Z",
    before_to: "2026-08-20T09:00:00.000Z",
    after_from: "2026-08-20T09:00:00.000Z",
    after_to: "2026-08-24T12:00:00.000Z",
    before_value: 32600,
    after_value: 20200,
    before_n: 6,
    after_n: 4,
    delta_pct: -38.04,
    verdict: "EFFECTIVE",
    qualification: null,
  };

  const measuringEffect: EffectRow = {
    rec_id: "rec-D2-global-mockledger0002",
    measured_at: "2026-08-21T14:30:00.000Z",
    before_from: "2026-08-07T00:00:00.000Z",
    before_to: "2026-08-21T14:30:00.000Z",
    after_from: "2026-08-21T14:30:00.000Z",
    after_to: "2026-09-04T14:30:00.000Z",
    before_value: 187_500,
    after_value: null,
    before_n: 5,
    after_n: null,
    delta_pct: null,
    verdict: null,
    qualification: "EXPERIMENTAL",
  };

  const d1Entry: LedgerEntry = {
    rec_id: "rec-D1-global-mockledger0001",
    detector_id: "D1",
    lever: "Trim the global CLAUDE.md to its load-bearing core.",
    adopted_at: "2026-08-20T09:00:00.000Z",
    state: "MEASURED_EFFECTIVE",
    target_metric: "avg_context_per_turn",
    modeled_savings_u_per_wk: 4_200_000, // $4.20/wk raw
    modeled_cap_weighted_u_per_wk: 420_000, // $0.42/wk cap-weighted
    effects: [effectiveEffect],
    confounded_window: false,
  };

  const d2Entry: LedgerEntry = {
    rec_id: "rec-D2-global-mockledger0002",
    detector_id: "D2",
    lever: "/clear between unrelated tasks; split long work; avoid mid-task /compact.",
    adopted_at: "2026-08-21T14:30:00.000Z",
    state: "MEASURING",
    target_metric: "avg_context_per_turn",
    modeled_savings_u_per_wk: 12_000_000, // $12.00/wk raw
    modeled_cap_weighted_u_per_wk: 1_200_000, // $1.20/wk cap-weighted
    effects: [measuringEffect],
    confounded_window: true,
  };

  const data: LedgerView = {
    entries: [d1Entry, d2Entry],
    cap_read_coeff: 0.1,
  };

  return {
    data,
    meta: {
      n: data.entries.length,
      window: windowFor("7d"),
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "",
      },
      metric_definition_version: "observe-1",
      claim_kind: "EXPERIMENTAL",
      drilldown_ids: {},
    },
  };
}

export function mockTrends(_filter: WindowFilter): ApiResponse<TrendData> {
  const window = windowFor("7d");
  const data: TrendData = {
    bucket: "day",
    buckets: [
      { bucket: "2026-08-17", cost_equiv_u: 1_200_000, turns: 45 },
      { bucket: "2026-08-18", cost_equiv_u: 980_000, turns: 38 },
      { bucket: "2026-08-19", cost_equiv_u: 2_100_000, turns: 72 },
      { bucket: "2026-08-20", cost_equiv_u: 750_000, turns: 28 },
      { bucket: "2026-08-21", cost_equiv_u: 1_560_000, turns: 59 },
      { bucket: "2026-08-22", cost_equiv_u: 880_000, turns: 33 },
      { bucket: "2026-08-23", cost_equiv_u: 320_000, turns: 12 },
    ],
    by_model: [
      { bucket: "2026-08-17", model: "claude-opus-5", cost_equiv_u: 900_000, turns: 30 },
      { bucket: "2026-08-17", model: "claude-sonnet-5", cost_equiv_u: 300_000, turns: 15 },
      { bucket: "2026-08-18", model: "claude-opus-5", cost_equiv_u: 700_000, turns: 25 },
      { bucket: "2026-08-18", model: "claude-sonnet-5", cost_equiv_u: 280_000, turns: 13 },
    ],
    by_workspace: [
      {
        bucket: "2026-08-17",
        workspace_id: "ws-1",
        project_slug: "orbit-api",
        cost_equiv_u: 800_000,
        turns: 30,
      },
      {
        bucket: "2026-08-17",
        workspace_id: "ws-2",
        project_slug: "AgentWrangler",
        cost_equiv_u: 400_000,
        turns: 15,
      },
      {
        bucket: "2026-08-18",
        workspace_id: "ws-1",
        project_slug: "orbit-api",
        cost_equiv_u: 600_000,
        turns: 22,
      },
      {
        bucket: "2026-08-18",
        workspace_id: "ws-2",
        project_slug: "AgentWrangler",
        cost_equiv_u: 380_000,
        turns: 16,
      },
    ],
    sessions: [
      {
        session_id: "s1",
        workspace_id: "ws-1",
        project_slug: "orbit-api",
        first_turn_at: "2026-08-17T10:00:00Z",
        cost_equiv_u: 450_000,
      },
      {
        session_id: "s2",
        workspace_id: "ws-2",
        project_slug: "AgentWrangler",
        first_turn_at: "2026-08-18T14:00:00Z",
        cost_equiv_u: 320_000,
      },
      {
        session_id: "s3",
        workspace_id: "ws-1",
        project_slug: "orbit-api",
        first_turn_at: "2026-08-19T09:00:00Z",
        cost_equiv_u: 780_000,
      },
    ],
    cap_weighted: [
      { bucket: "2026-08-17", cap_weighted_tokens: 320_000, turns: 45 },
      { bucket: "2026-08-18", cap_weighted_tokens: 265_000, turns: 38 },
      { bucket: "2026-08-19", cap_weighted_tokens: 580_000, turns: 72 },
      { bucket: "2026-08-20", cap_weighted_tokens: 195_000, turns: 28 },
      { bucket: "2026-08-21", cap_weighted_tokens: 410_000, turns: 59 },
      { bucket: "2026-08-22", cap_weighted_tokens: 230_000, turns: 33 },
      { bucket: "2026-08-23", cap_weighted_tokens: 88_000, turns: 12 },
    ],
    cap_read_coeff: 0.1,
    adoption_markers: [
      {
        rec_id: "rec-adopted-fixture",
        detector_id: "D8",
        lever: "Clear stale sessions before cache expiry",
        adopted_at: "2026-08-20T09:00:00.000Z",
        bucket: "2026-08-20",
      },
    ],
  };
  return { data, meta: baseMeta(window, data.buckets.length) };
}

const HEADROOM_FIXTURE_NOTE =
  "Percent-native headroom: no absolute-cap denominator; the cap-read coefficient is unverified.";

export function mockHeadroomTrendNoLimit(): ApiResponse<HeadroomTrendData> {
  const window = windowFor("7d");
  const base = baseMeta(window, 0);
  return {
    data: { state: "NO_LIMIT" },
    meta: { ...base, qualification: { ...base.qualification, note: HEADROOM_FIXTURE_NOTE } },
  };
}

export function mockHeadroomTrend(_filter: WindowFilter): ApiResponse<HeadroomTrendData> {
  const window = windowFor("7d");
  const points = [
    {
      bucket: "2026-08-17",
      headroom_headline: 0.68,
      headroom_upper: 0.5,
      cap_weighted_headline: 320_000,
      cap_weighted_upper: 500_000,
    },
    {
      bucket: "2026-08-18",
      headroom_headline: 0.735,
      headroom_upper: 0.58,
      cap_weighted_headline: 265_000,
      cap_weighted_upper: 420_000,
    },
  ];
  const data: HeadroomTrendData = {
    state: "OK",
    bucket: "day",
    points,
    cap_read_coeff_headline: 0.1,
    cap_read_coeff_upper: 1.0,
    coefficient_unverified: true,
  };
  const base = baseMeta(window, points.length);
  return {
    data,
    meta: { ...base, qualification: { ...base.qualification, note: HEADROOM_FIXTURE_NOTE } },
  };
}

export function mockLiveSessions(): ApiResponse<PagedList<LiveSessionRow>> {
  const now = new Date().toISOString();
  const window = { from: now, to: now };
  // Return empty — no LIVE sessions in the mock. The strip shows an empty state.
  return {
    data: { items: [], next_cursor: null },
    meta: baseMeta(window, 0),
  };
}

export function mockSession(sessionId: string): ApiResponse<SessionSummary> {
  const data: SessionSummary = {
    session_id: sessionId,
    workspace_id: "ws-1",
    repo_path: "C:/Users/dev/GitHub/orbit-api",
    repo_owner: "acme",
    repo_name: "orbit-api",
    file_path: "sessions/demo.jsonl",
    state: "LIVE",
    turn_count: 2,
    cost_equiv_u: 3_420_000,
    first_turn_at: "2026-08-22T10:00:00Z",
    last_turn_at: "2026-08-22T10:03:00Z",
    hygiene_flags: [],
    compaction_count: 0,
    api_error_count: 0,
    interrupt_count: 0,
    user_turn_count: 0,
    tool_error_count: 0,
    test_fail_count: 0,
    // EF1 delivery signals
    turns_to_first_commit: 4,
    deep_abandoned: false,
    // EF3 gap aggregates
    gap_median_s: 45,
    gap_p90_s: 320,
    long_gap_count: 1,
    gap_n: 3,
  };
  return {
    data,
    meta: {
      ...baseMeta(windowFor("7d"), 1),
      drilldown_ids: { session_id: sessionId, workspace_id: data.workspace_id },
    },
  };
}

export function mockWorkspaceSessions(
  workspaceId: string,
  _filter: WindowFilter,
): ApiResponse<PagedList<SessionSummary>> {
  const session = mockSession("session-demo").data;
  if (session === null) throw new Error("session fixture must have data");
  return {
    data: { items: [{ ...session, workspace_id: workspaceId }], next_cursor: null },
    meta: baseMeta(windowFor("7d"), 1),
  };
}

export function mockTurnTimeline(
  sessionId: string,
  after?: string,
): ApiResponse<PagedList<TurnRow>> {
  const rows: TurnRow[] = [
    {
      message_id: "turn-1",
      session_id: sessionId,
      ts: "2026-08-22T10:00:00Z",
      model: "claude-sonnet-5",
      is_sidechain: false,
      input_tokens: 1200,
      output_tokens: 400,
      thinking_tokens: 80,
      cache_read_tokens: 800,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_other: 0,
      context_tokens: 2200,
      cost_equiv_u: 1_250_000,
      cost_claim: "LIST_EQUIV",
      provisional: true,
      effort: null,
    },
    {
      message_id: "turn-2",
      session_id: sessionId,
      ts: "2026-08-22T10:03:00Z",
      model: "claude-sonnet-5",
      is_sidechain: false,
      input_tokens: 1300,
      output_tokens: 420,
      thinking_tokens: null,
      cache_read_tokens: 860,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_other: 0,
      context_tokens: 2400,
      cost_equiv_u: null,
      cost_claim: "LIST_EQUIV",
      provisional: false,
      effort: "medium",
    },
  ];
  const first = rows[0];
  const second = rows[1];
  if (first === undefined || second === undefined) {
    throw new Error("turn timeline fixture must contain two rows");
  }
  const firstPage = after === undefined;
  const data: PagedList<TurnRow> = firstPage
    ? { items: [first], next_cursor: "mock-page-2" }
    : { items: [second], next_cursor: null };
  return {
    data,
    meta: {
      ...baseMeta(windowFor("7d"), data.items.length),
      drilldown_ids: { session_id: sessionId },
    },
  };
}

// ---------------------------------------------------------------------------
// Spend-Viz-v2 fixtures
// ---------------------------------------------------------------------------

/** Mock token-flavor decomposition — cap-proxy-weighted display. */
export function mockFlavorDecomposition(_filter: WindowFilter): ApiResponse<FlavorDecomposition> {
  const window = windowFor("7d");
  const coeff = 0.1;

  const rawInput = 8_500_000;
  const rawOutput = 1_200_000;
  const rawCw5m = 2_000_000;
  const rawCw1h = 800_000;
  const rawCwOther = 0;
  const rawCr = 14_000_000;

  const totalRaw = rawInput + rawOutput + rawCw5m + rawCw1h + rawCwOther + rawCr;
  const totalWeighted = rawInput + rawOutput + rawCw5m + rawCw1h + rawCwOther + rawCr * coeff;

  const mkRow = (
    flavor: FlavorRow["flavor"],
    label: string,
    weight: number,
    raw: number,
  ): FlavorRow => ({
    flavor,
    label,
    weight,
    raw_tokens: raw,
    weighted_tokens: raw * weight,
    weighted_share: totalWeighted > 0 ? (raw * weight) / totalWeighted : 0,
    raw_share: totalRaw > 0 ? raw / totalRaw : 0,
  });

  const flavors: FlavorRow[] = [
    mkRow("fresh_input", "fresh input", 1.0, rawInput),
    mkRow("output", "output", 1.0, rawOutput),
    mkRow("cache_write_5m", "cache write (5 min)", 1.0, rawCw5m),
    mkRow("cache_write_1h", "cache write (1 hr)", 1.0, rawCw1h),
    mkRow("cache_write_other", "cache write (unspecified)", 1.0, rawCwOther),
    mkRow("cache_read", "cache read", coeff, rawCr),
  ];

  const cacheTotal = rawCr + rawCw5m + rawCw1h;
  const data: FlavorDecomposition = {
    flavors,
    total_raw_tokens: totalRaw,
    total_weighted_tokens: totalWeighted,
    cache_efficiency_ratio: cacheTotal > 0 ? rawCr / cacheTotal : null,
    cache_read_share: cacheTotal > 0 ? rawCr / cacheTotal : null,
    cache_read_tokens: rawCr,
    cache_creation_tokens: rawCw5m + rawCw1h + rawCwOther,
    reuse_band: "REUSE_DOMINANT",
    cap_weighted_tokens: rawInput + rawOutput + rawCw5m + rawCw1h + rawCr * coeff,
    coeff_used: coeff,
    coeff_unverified: true,
    turns: 287,
  };

  return { data, meta: { ...baseMeta(window, 6), claim_kind: "PROXY" } };
}

/** Mock cache-write spike timeline — 7-day series with one spike. */
export function mockCacheWriteTrend(_filter: WindowFilter): ApiResponse<CacheWriteTrend> {
  const window = windowFor("7d");
  const buckets: CacheWriteBucketRow[] = [
    {
      bucket: "2026-08-17",
      cache_creation_tokens: 200_000,
      cache_read_tokens: 1_400_000,
      efficiency_ratio: 0.875,
      turns: 45,
    },
    {
      bucket: "2026-08-18",
      cache_creation_tokens: 180_000,
      cache_read_tokens: 1_260_000,
      efficiency_ratio: 0.875,
      turns: 38,
    },
    {
      bucket: "2026-08-19",
      cache_creation_tokens: 950_000,
      cache_read_tokens: 800_000,
      efficiency_ratio: 0.457,
      turns: 72,
    },
    {
      bucket: "2026-08-20",
      cache_creation_tokens: 175_000,
      cache_read_tokens: 1_225_000,
      efficiency_ratio: 0.875,
      turns: 28,
    },
    {
      bucket: "2026-08-21",
      cache_creation_tokens: 190_000,
      cache_read_tokens: 1_330_000,
      efficiency_ratio: 0.875,
      turns: 59,
    },
    {
      bucket: "2026-08-22",
      cache_creation_tokens: 165_000,
      cache_read_tokens: 1_155_000,
      efficiency_ratio: 0.875,
      turns: 33,
    },
    {
      bucket: "2026-08-23",
      cache_creation_tokens: 70_000,
      cache_read_tokens: 490_000,
      efficiency_ratio: 0.875,
      turns: 12,
    },
  ];
  const data: CacheWriteTrend = { buckets, spike_buckets: ["2026-08-19"] };
  return { data, meta: baseMeta(window, buckets.length) };
}

// ---------------------------------------------------------------------------
// Outcomes fixtures (WP5)
// ---------------------------------------------------------------------------

const OUTCOMES_METHODOLOGY_NOTE =
  "73% (validation corpus): linkage methodology validated on a sample corpus. " +
  "Live linkage rate is per-workspace and shown separately in getLinkageRate. " +
  "All findings are EXPERIMENTAL and excluded from gated denominators (COND-1).";

function experimentalMeta(n: number) {
  const now = new Date("2026-08-24T00:00:00Z").toISOString();
  return {
    n,
    window: { from: now, to: now },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: OUTCOMES_METHODOLOGY_NOTE,
    },
    metric_definition_version: "observe-1" as const,
    claim_kind: "EXPERIMENTAL" as const,
    drilldown_ids: {} as Record<string, never>,
  };
}

/** Mock global success rate — EXPERIMENTAL, with 73% disclosure note. */
export function mockSuccessRate(): ApiResponse<SuccessRateData> {
  const data: SuccessRateData = {
    terminal_n: 12,
    success_rate: 0.75,
    clean_success_n: 7,
    with_deferrals_n: 2,
    no_ci_success_n: 1,
    linkage_rate: 0.62,
    methodology_note: OUTCOMES_METHODOLOGY_NOTE,
  };
  return { data, meta: experimentalMeta(12) };
}

/** Mock per-workspace outcome summaries — EXPERIMENTAL. */
export function mockWorkspaceOutcomes(): ApiResponse<WorkspaceOutcomeSummary[]> {
  const data: WorkspaceOutcomeSummary[] = [
    {
      workspace_id: "ws-1",
      project_slug: "orbit-api",
      total_n: 8,
      in_progress_n: 2,
      terminal_n: 6,
      success_n: 5,
      failure_n: 1,
      success_rate: 5 / 6,
      linkage_rate: 0.71,
      adherence_score: 86,
    },
    {
      workspace_id: "ws-2",
      project_slug: "support-portal",
      total_n: 4,
      in_progress_n: 0,
      terminal_n: 4,
      success_n: 2,
      failure_n: 2,
      success_rate: 0.5,
      linkage_rate: 0.55,
      adherence_score: 67,
    },
  ];
  return { data, meta: experimentalMeta(data.length) };
}

export function mockContextComposition(workspaceId: string): ApiResponse<ContextComposition> {
  const alwaysLoaded = 18_000;
  const residual = 72_000;
  const data: ContextComposition = {
    workspace_id: workspaceId,
    observed_context_tokens: alwaysLoaded + residual,
    observed_turns: 42,
    inventory_rows: 2,
    rows: [
      { key: "always_loaded", label: "always loaded", tokens: alwaysLoaded, share: 0.2 },
      {
        key: "session_residual",
        label: "session history + tool outputs (not itemized in v1)",
        tokens: residual,
        share: 0.8,
      },
    ],
  };
  return {
    data,
    meta: {
      ...baseMeta(windowFor("7d"), data.observed_turns),
      claim_kind: "OBS_PROXY",
      drilldown_ids: { workspace_id: workspaceId },
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Provisional turns are included.",
      },
    },
  };
}

/** Mock linkage rate — EXPERIMENTAL, COND-1 excluded example shown. */
export function mockLinkageRate(): ApiResponse<LinkageRateData> {
  const data: LinkageRateData = {
    linkage_rate: 0.62,
    denominator_n: 21,
    methodology_note:
      "Live per-workspace linkage rate. Denominator: RECONCILED sessions with ≥1 Bash tool_event. " +
      "See also the fixed 73% validation corpus disclosure in getSuccessRate.",
  };
  return { data, meta: experimentalMeta(21) };
}

export function mockCalibrateLimit(): ApiResponse<CalibrateResult> {
  const now = new Date();
  const window = { from: now.toISOString(), to: now.toISOString() };
  const date = now.toISOString().slice(0, 10);
  const result: CalibrateResult = {
    ok: true,
    limit_tokens: 8_000_000_000,
    provenance: `calibrated ${date} @ 25.0%`,
  };
  return {
    data: result,
    meta: {
      n: 1,
      window,
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "",
      },
      metric_definition_version: "observe-1",
      claim_kind: "N_A",
      drilldown_ids: {},
    },
  };
}

/** Default mock for the oauth/status endpoint — not authenticated. */
export function mockOAuthStatus(): OAuthStatus {
  return {
    authenticated: false,
    tier: null,
    reason: "Credentials file not found — re-login to Claude Code.",
  };
}

/** Default mock for the outcomes/token-status endpoint — no token configured. */
export function mockGithubTokenStatus(): GithubTokenStatus {
  return {
    configured: false,
    source: null,
    reason: "outcomes sync: no GitHub token — set AW_GITHUB_TOKEN",
  };
}

/** Signed-in burn-status fixture (5h at 45%, 7d at 72%). */
export function mockBurnStatus(): ApiResponse<BurnStatus> {
  return {
    data: {
      available: true,
      five_hour: { utilization: 0.45, resets_at: "2026-09-02T18:00:00Z" },
      seven_day: { utilization: 0.72, resets_at: "2026-09-09T00:00:00Z" },
    },
    meta: mockSettings().meta,
  };
}

/** Signed-out / unavailable burn-status fixture. */
export function mockBurnStatusSignedOut(): ApiResponse<BurnStatus> {
  return {
    data: { available: false, reason: "Credentials file not found — re-login to Claude Code." },
    meta: mockSettings().meta,
  };
}

/** Hook config response fixture (installed or not). */
export function mockHookConfigResponse(installed: boolean): ApiResponse<HookConfigResponse> {
  return {
    data: {
      context_window: 200_000,
      soft_pct: 0.6,
      hard_pct: 0.8,
      stale_s: 300,
      d7_fail_count: 3,
      d7_window_turns: 10,
      d9_idle_seconds: 1800,
      installed,
    },
    meta: mockSettings().meta,
  };
}

/** Three hot sessions for overview teaser. */
export function mockHotSessions(): HotSessionRow[] {
  return [
    {
      session_id: "hot-session-1",
      workspace_id: "ws-alpha",
      turns: 24,
      cost_equiv_u: 5_200_000,
      total_output_tokens: 48_000,
      avg_output_tokens: 2_000,
      total_context_tokens: 1_200_000,
      avg_context_tokens: 50_000,
      model: "claude-opus-5",
      last_turn_at: "2026-09-02T14:30:00Z",
      api_error_count: 2,
      compaction_count: 1,
      interrupt_count: 0,
      user_turn_count: 6,
      tool_error_count: 3,
      test_fail_count: 1,
      gap_median_s: 38,
      gap_p90_s: 420,
      long_gap_count: 2,
      gap_n: 5,
    },
    {
      session_id: "hot-session-2",
      workspace_id: "ws-beta",
      turns: 12,
      cost_equiv_u: 2_100_000,
      total_output_tokens: 18_000,
      avg_output_tokens: 1_500,
      total_context_tokens: 480_000,
      avg_context_tokens: 40_000,
      model: "claude-sonnet-5",
      last_turn_at: "2026-09-02T13:00:00Z",
      api_error_count: 0,
      compaction_count: 0,
      interrupt_count: 0,
      user_turn_count: 3,
      tool_error_count: 1,
      test_fail_count: 0,
      gap_median_s: 60,
      gap_p90_s: 185,
      long_gap_count: 0,
      gap_n: 2,
    },
    {
      session_id: "hot-session-3",
      workspace_id: "ws-gamma",
      turns: 8,
      cost_equiv_u: 980_000,
      total_output_tokens: 9_600,
      avg_output_tokens: 1_200,
      total_context_tokens: 240_000,
      avg_context_tokens: 30_000,
      model: "claude-sonnet-5",
      last_turn_at: "2026-09-02T12:00:00Z",
      api_error_count: 0,
      compaction_count: 0,
      interrupt_count: 0,
      user_turn_count: 2,
      tool_error_count: 0,
      test_fail_count: 0,
      gap_median_s: null,
      gap_p90_s: null,
      long_gap_count: 0,
      gap_n: 0,
    },
  ];
}

const DRIVERS_NOTE = "Per-driver figures are observed proxies; never summed.";

function driversMeta(sessionId: string, n: number) {
  return {
    n,
    window: windowFor("7d"),
    qualification: {
      provisional_excluded: false,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: DRIVERS_NOTE,
    },
    metric_definition_version: "observe-1" as const,
    claim_kind: "OBS_PROXY" as const,
    drilldown_ids: { session_id: sessionId, workspace_id: "ws-1" },
  };
}

/**
 * Seeded session drivers fixture — p80, two drivers (D8 cache churn + D6 tool bloat).
 * Pass cheap=true to return an empty-driver fixture at p30 (no panel expected).
 */
export function mockSessionDrivers(sessionId: string, cheap = false): ApiResponse<SessionDrivers> {
  if (cheap) {
    return {
      data: {
        session_id: sessionId,
        workspace_id: "ws-1",
        percentile: 30,
        drivers: [],
      },
      meta: driversMeta(sessionId, 0),
    };
  }
  return {
    data: {
      session_id: sessionId,
      workspace_id: "ws-1",
      percentile: 80,
      drivers: [
        {
          detector_id: "D8",
          label: "CACHE_WRITE_CHURN",
          measured: {
            churn_event_count: 5,
            total_churn_creation_tokens: 48_000,
            creation_share: 0.62,
            regime: "IDLE_GAP",
          },
          share: 0.62,
          rec_id: "rec-d8-1",
          routing: "hook",
        },
        {
          detector_id: "D6",
          label: "TOOL_RESULT_BLOAT",
          measured: {
            tool_result_bytes: 120_000,
            bloat_share: 0.41,
            attributed_tool: "Bash",
            turn_count: 12,
          },
          share: 0.41,
          rec_id: "rec-d6-1",
          routing: "rec_card",
          approx_usd: 0.15,
        },
      ],
    },
    meta: driversMeta(sessionId, 2),
  };
}

// ---------------------------------------------------------------------------
// BM1 — Practice scorecard fixtures
// ---------------------------------------------------------------------------

/**
 * Eight realistic practice rows covering PASS / ATTENTION / NO_DATA statuses.
 * At least one ATTENTION row carries a non-null artifact_link; trend-only rows
 * (threshold.value === null) represent the DIRECTIONAL chip path.
 */
export function mockPractices(): PracticesResult {
  const window = { from: "2026-08-16T00:00:00Z", to: "2026-08-23T00:00:00Z" };
  const practices: PracticeEntry[] = [
    {
      practice_id: "P1",
      statement:
        "Watch cache-read health — a few points of cache-miss rate dramatically affect cost and latency.",
      source_url:
        "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
      source_date: "2026-04-30",
      threshold: {
        value: 10,
        rationale:
          "ATTENTION when this week's cache-read ratio is >10 pts below the trailing-8-week median; NO_DATA under minimum weekly volume.",
      },
      signal: "cache_read_ratio_wk",
      status: "PASS",
      artifact_link: null,
    },
    {
      practice_id: "P2",
      statement: "Don't switch models mid-session — switching forces a cache rebuild.",
      source_url:
        "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
      source_date: "2026-04-30",
      threshold: {
        value: 20,
        rationale:
          "ATTENTION when >20% of the week's non-trivial sessions (≥5 non-sidechain turns) used more than one model.",
      },
      signal: "distinct_model_per_session_wk",
      status: "ATTENTION",
      artifact_link: "/recommendations",
    },
    {
      practice_id: "P3",
      statement:
        "Respect the cache-TTL cadence — an idle gap longer than the TTL re-writes the whole context at base price.",
      source_url:
        "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
      source_date: "2026-04-30",
      threshold: {
        value: null,
        rationale:
          "Detector-owned threshold: status follows the D8 CACHE_WRITE_CHURN detector, which flags TTL-crossing cache-write spikes.",
      },
      signal: "D8",
      status: "PASS",
      artifact_link: "/settings",
    },
    {
      practice_id: "P4",
      statement: "Use /clear between tasks — stale context bills on every subsequent message.",
      source_url: "https://code.claude.com/docs/en/costs",
      source_date: "2026-09-02",
      threshold: {
        value: null,
        rationale:
          "Binary: ATTENTION whenever the D2 SESSION_LONG_FULL_CONTEXT detector is firing in-window.",
      },
      signal: "D2",
      status: "ATTENTION",
      artifact_link: "/recommendations",
    },
    {
      practice_id: "P5",
      statement:
        "Keep CLAUDE.md lean — the docs recommend under 200 lines; it loads into context every session.",
      source_url: "https://code.claude.com/docs/en/costs",
      source_date: "2026-09-02",
      threshold: {
        value: 200,
        rationale:
          "PASS at or below the official 200-line CLAUDE.md ceiling (Source C), ATTENTION above it.",
      },
      signal: "claude_md_line_count",
      status: "PASS",
      artifact_link: null,
    },
    {
      practice_id: "P6",
      statement:
        "Right-size the model — Opus costs ~5× more than Sonnet per token; reserve it for complex tasks.",
      source_url: "https://code.claude.com/docs/en/costs",
      source_date: "2026-09-02",
      threshold: {
        value: null,
        rationale: "Binary: ATTENTION whenever the D4 MODEL_MISMATCH detector is firing in-window.",
      },
      signal: "D4",
      status: "NO_DATA",
      artifact_link: "/recommendations",
    },
    {
      practice_id: "P7",
      statement:
        "Offload to subagents — specialized subagents return 1–2k-token summaries despite consuming tens of thousands internally.",
      source_url:
        "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
      source_date: "2025-09-29",
      threshold: {
        value: null,
        rationale:
          "Trend-only: the source gives a shape, not a target, so no threshold is claimed — the observed offload share is rendered alongside the citation.",
      },
      signal: "getOffloadShare",
      status: "PASS",
      artifact_link: null,
    },
    {
      practice_id: "P8",
      statement:
        "Keep the tool catalog stable and small — any tool-set change invalidates the cache.",
      source_url:
        "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything",
      source_date: "2026-04-30",
      threshold: {
        value: null,
        rationale:
          "Partial: status is computed from the installed tool-catalog footprint only (D10 CATALOG_FOOTPRINT, config-state).",
      },
      signal: "D10",
      status: "NO_DATA",
      artifact_link: null,
    },
  ];
  return { practices, window };
}

// ---------------------------------------------------------------------------
// BM2 — Efficiency headroom fixtures
// ---------------------------------------------------------------------------

/** Efficiency headroom fixture — 3 open recs, ~35% modeled headroom. */
export function mockEfficiencyHeadroom(): ApiResponse<EfficiencyHeadroom> {
  const window = windowFor("7d");
  const headroom_u_per_wk = 2_450_000; // ~$2.45/wk
  const actual_u_per_wk = 7_000_000; // ~$7.00/wk
  const data: EfficiencyHeadroom = {
    headroom_u_per_wk,
    actual_u_per_wk,
    headroom_pct: headroom_u_per_wk / actual_u_per_wk,
    open_rec_count: 3,
    from: window.from,
    to: window.to,
  };
  return {
    data,
    meta: {
      n: 3,
      window,
      qualification: {
        provisional_excluded: true,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Modeled headroom — if every open recommendation were applied; built from unvalidated per-detector fractions.",
      },
      metric_definition_version: "observe-1",
      claim_kind: "EXPERIMENTAL",
      drilldown_ids: {},
    },
  };
}

// ---------------------------------------------------------------------------
// EF2 — Closure proxy fixture
// ---------------------------------------------------------------------------

/** Realistic matured closure proxy for a workspace. */
export function mockClosureProxy(workspaceId: string): ApiResponse<ClosureProxy> {
  const data: ClosureProxy = {
    no_commit_session_count: 12,
    resolved_count: 7,
    unresolved_count: 3,
    pending_count: 2,
    resolved_share: 7 / 10, // 0.7 over the 10 matured sessions
    window_hours: 48,
    workspace_id: workspaceId,
  };
  const now = new Date("2026-09-03T00:00:00Z").toISOString();
  return {
    data,
    meta: {
      claim_kind: "EXPERIMENTAL",
      n: data.no_commit_session_count,
      window: { from: now, to: now },
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Directional: a re-open within 48h may be unrelated work; burst-working operators will false-flag as unresolved. PENDING until the window elapses.",
      },
      metric_definition_version: "observe-1",
      drilldown_ids: { workspace_id: workspaceId },
    },
  };
}

// ---------------------------------------------------------------------------
// R4a — lifecycle cost-per-success fixture
// ---------------------------------------------------------------------------

const COST_PER_SUCCESS_NOTE =
  "Directional (OBS_PROXY): survivorship bias (heavy-spend sessions that never open a PR are invisible); reviewer-dependence (merge is a human decision, not a quality guarantee); linkage-coverage cap (only linkage_coverage_pct% of in-window sessions are linked to a PR, so unlinked spend is excluded). cost_per_merged_pr_u uses lifecycle attribution: each merged PR carries the full cost of every linked session whenever it ran, so narrowing the window changes the PR population, not the per-PR cost.";

/** Realistic populated cost-per-success proxy for a workspace (or global when id omitted). */
export function mockCostPerSuccess(
  filter: WindowFilter,
  workspaceId?: string,
): ApiResponse<CostPerSuccess> {
  const window = windowFor(
    filter.preset === "24h" || filter.preset === "30d" ? filter.preset : "7d",
  );
  const data: CostPerSuccess = {
    merged_pr_count: 8,
    closed_unmerged_count: 2,
    cost_per_merged_pr_u: 4_250_000, // ~$4.25 per merged PR
    commit_session_count: 5,
    cost_per_commit_session_u: 6_800_000, // ~$6.80 per commit-session
    linkage_coverage_pct: 42.5,
    n: 8,
    window: { from: window.from, to: window.to },
  };
  return {
    data,
    meta: {
      claim_kind: "OBS_PROXY",
      n: data.merged_pr_count,
      window,
      qualification: {
        provisional_excluded: false,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: COST_PER_SUCCESS_NOTE,
      },
      metric_definition_version: "observe-1",
      drilldown_ids: workspaceId === undefined ? {} : { workspace_id: workspaceId },
    },
  };
}

/** Null-headroom fixture — zero spend scenario (headroom_pct === null). */
export function mockEfficiencyHeadroomNull(): ApiResponse<EfficiencyHeadroom> {
  const window = windowFor("7d");
  const data: EfficiencyHeadroom = {
    headroom_u_per_wk: 0,
    actual_u_per_wk: 0,
    headroom_pct: null,
    open_rec_count: 0,
    from: window.from,
    to: window.to,
  };
  return {
    data,
    meta: {
      n: 0,
      window,
      qualification: {
        provisional_excluded: true,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Modeled headroom — if every open recommendation were applied; built from unvalidated per-detector fractions.",
      },
      metric_definition_version: "observe-1",
      claim_kind: "EXPERIMENTAL",
      drilldown_ids: {},
    },
  };
}
