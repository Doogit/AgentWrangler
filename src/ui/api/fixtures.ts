/**
 * src/ui/api/fixtures.ts — Mock fixture data for dev/test.
 *
 * Provides fixture-shaped ApiResponse<T> objects so the UI renders
 * fully without the daemon. Built against the frozen API contract types.
 *
 * Integration: flip USE_MOCK in client.ts to switch from fixtures to real fetch.
 */

import type { PracticeEntry, PracticesResult } from "../../detector/practice-registry";
import { D1_D10_AVOIDANCE_FRACTION, d1Savings } from "../../detector/savings";
import type { OAuthStatus } from "../../oauth/credentials";
import type { GithubTokenStatus } from "../../outcomes/github/credential";
import type { BurnStatus } from "../../query/api/burn-status";
import type { ContextComposition } from "../../query/api/context-composition";
import type { CostPerSuccess } from "../../query/api/cost-per-success";
import type { DecisionView } from "../../query/api/decision-view-types";
import type { DeliveryMetrics } from "../../query/api/delivery";
import type { DiagnosticCategory, SessionDiagnosticAnchor } from "../../query/api/diagnostics";
import type {
  AvoidableRow,
  DiagnosticsPayload,
  ReliabilityRow,
} from "../../query/api/diagnostics-triage";
import type { ClosureProxy } from "../../query/api/effectiveness";
import type { EfficiencyHeadroom } from "../../query/api/efficiency-headroom";
import type { HeadroomTrendData } from "../../query/api/headroom-trend";
import type { HookConfigResponse } from "../../query/api/hook-config";
import type { HotSessionsPage, HotSessionsPageQuery } from "../../query/api/hot-sessions";
import type { JudgeSetupResponse } from "../../query/api/judge-setup";
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
  WorkspaceNameRow,
  WorkspaceSummary,
} from "../../query/api/overview";
import type { OverviewSection } from "../../query/api/overview-view";
import type {
  BoundedStep,
  RecommendationCard,
  RecommendationsView,
} from "../../query/api/recommendations";
import type { EffectRow, LedgerEntry, LedgerView } from "../../query/api/recommendations-ledger";
import type { Report } from "../../query/api/reports";
import type { SessionBreakdown } from "../../query/api/session-breakdown";
import type { SessionDrivers } from "../../query/api/session-drivers";
import type { SessionStory } from "../../query/api/session-story";
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
import type { StatuslineStatus } from "../../query/limits/statusline";
import type { StatuslinePlan } from "../../query/limits/statusline-install";
import type { LimitsModel, WeightFit } from "../../query/limits/types";
import type { HotSessionRow } from "../../query/spend";
import type { DaemonStatus, OverviewViewResponse, PipelineStatus } from "./client";

// 1 USD = 1,000,000 micro-USD
const MICRO = 1_000_000;

/** Aggregate-only history progress fixture for shell consumers. */
export const mockHistoryPipelineStatus: PipelineStatus = {
  phase: "history",
  weeks_total: 11,
  weeks_done: 3,
  files_total: 100,
  files_completed: 100,
  files_with_new_data: 12,
  detector_runs: 1,
  failed_phase: null,
  events: ["history — week 3 / 11 (2 new findings)"],
};

/**
 * The shared, high-volume UA11 demo scenario. Keep all selected-window
 * spend surfaces derived from these values: the Overview total, workspace rows,
 * and trend buckets must describe the same observation.
 */
export const UA11_SCENARIO = {
  window: { from: "2026-08-17T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z", preset: "7d" },
  spend_u: 3_100_000_000,
  workspace_spend_u: [1_350_000_000, 850_000_000, 450_000_000, 275_000_000, 175_000_000],
  trend_spend_u: [
    410_000_000, 385_000_000, 502_000_000, 340_000_000, 465_000_000, 420_000_000, 578_000_000,
  ],
} as const;

const UA11_WORKSPACE_IDENTITIES = [
  { workspace_id: "ws-1", project_slug: "orbit-api", repo_name: "orbit-api" },
  { workspace_id: "ws-2", project_slug: "support-portal", repo_name: "support-portal" },
  { workspace_id: "ws-3", project_slug: "data-janitor", repo_name: "data-janitor" },
  { workspace_id: "ws-4", project_slug: "admin-console", repo_name: "admin-console" },
  { workspace_id: "ws-5", project_slug: "AgentWrangler", repo_name: "AgentWrangler" },
] as const;

type Ua11Preset = "24h" | "7d" | "30d";
type Ua11DailyObservation = { bucket: string; cost_equiv_u: number; turns: number };

const UA11_OLDER_DAILY_SPEND = Array.from({ length: 23 }, (_, index) => ({
  bucket: new Date(Date.UTC(2026, 6, 25 + index)).toISOString().slice(0, 10),
  cost_equiv_u: 420_000_000,
  turns: 2_600,
}));
const UA11_DAILY_OBSERVATIONS: readonly Ua11DailyObservation[] = [
  ...UA11_OLDER_DAILY_SPEND,
  ...UA11_SCENARIO.trend_spend_u.map((cost_equiv_u, index) => ({
    bucket: new Date(Date.UTC(2026, 7, 17 + index)).toISOString().slice(0, 10),
    cost_equiv_u,
    turns: [3_000, 2_700, 3_300, 2_400, 3_100, 2_800, 2_100][index] ?? 0,
  })),
];

function selectedUa11Days(preset: Ua11Preset): readonly Ua11DailyObservation[] {
  const days = preset === "24h" ? 1 : preset === "7d" ? 7 : 30;
  return UA11_DAILY_OBSERVATIONS.slice(-days);
}

function splitWhole(total: number, weights: readonly number[]): number[] {
  const values = weights.map((weight) => Math.floor(total * weight));
  values[values.length - 1] = total - values.slice(0, -1).reduce((sum, value) => sum + value, 0);
  return values;
}

function selectedUa11Spend(preset: Ua11Preset): number {
  return selectedUa11Days(preset).reduce((sum, day) => sum + day.cost_equiv_u, 0);
}

const UA11_WORKSPACE_WEIGHTS = [
  1_350 / 3_100,
  850 / 3_100,
  450 / 3_100,
  275 / 3_100,
  175 / 3_100,
] as const;
const UA11_WORKSPACE_TURN_WEIGHTS = [0.4, 0.3, 0.13, 0.1, 0.07] as const;
const UA11_WORKSPACE_SESSION_WEIGHTS = [0.4, 0.3, 0.13, 0.1, 0.07] as const;
const UA11_SEVEN_DAY_SESSION_COUNTS = [18, 18, 18, 17, 18, 18, 17] as const;
const UA11_AVG_CONTEXT_TOKENS = 125_581;
const UA11_AVG_OUTPUT_TOKENS = 565;
// Price order matches the production Overview contract; Trends uses the same split.
const UA11_MODELS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;
const UA11_MODEL_TURN_WEIGHTS = [0.04, 0.57, 0.32, 0.07] as const;
const UA11_MODEL_SPEND_WEIGHTS = [0.04, 0.867, 0.075, 0.018] as const;

/** Preserve the stated seven-day workspace totals while keeping every day additive. */
function ua11WorkspaceSpendSplit(day: Ua11DailyObservation): number[] {
  const scenarioDay = Number(day.bucket.slice(-2)) - 17;
  if (day.bucket < "2026-08-17" || scenarioDay < 0 || scenarioDay > 6) {
    return splitWhole(day.cost_equiv_u, UA11_WORKSPACE_WEIGHTS);
  }
  if (scenarioDay < 6) return splitWhole(day.cost_equiv_u, UA11_WORKSPACE_WEIGHTS);
  const assigned = UA11_SCENARIO.trend_spend_u.slice(0, 6).reduce(
    (totals, spend) =>
      totals.map((total, index) => total + (splitWhole(spend, UA11_WORKSPACE_WEIGHTS)[index] ?? 0)),
    Array.from({ length: UA11_WORKSPACE_IDENTITIES.length }, () => 0),
  );
  return UA11_SCENARIO.workspace_spend_u.map((total, index) => total - (assigned[index] ?? 0));
}

function selectedUa11WorkspaceTotals(
  preset: Ua11Preset,
  field: "cost_equiv_u" | "turns",
): number[] {
  return selectedUa11Days(preset).reduce(
    (totals, day) => {
      const values = splitWhole(
        day[field],
        field === "cost_equiv_u" ? UA11_WORKSPACE_WEIGHTS : UA11_WORKSPACE_TURN_WEIGHTS,
      );
      const normalizedValues = field === "cost_equiv_u" ? ua11WorkspaceSpendSplit(day) : values;
      return totals.map((total, index) => total + (normalizedValues[index] ?? 0));
    },
    Array.from({ length: UA11_WORKSPACE_IDENTITIES.length }, () => 0),
  );
}

function selectedUa11ModelTotals(preset: Ua11Preset, field: "cost_equiv_u" | "turns"): number[] {
  return selectedUa11Days(preset).reduce(
    (totals, day) => {
      const values = splitWhole(
        day[field],
        field === "turns" ? UA11_MODEL_TURN_WEIGHTS : UA11_MODEL_SPEND_WEIGHTS,
      );
      return totals.map((total, index) => total + (values[index] ?? 0));
    },
    UA11_MODELS.map(() => 0),
  );
}

const UA11_D1_SOURCE_TOKENS = 10_000;
const UA11_D1_TARGET_TOKENS = 2_000;
const UA11_D1 = d1Savings(
  UA11_D1_SOURCE_TOKENS - UA11_D1_TARGET_TOKENS,
  selectedUa11WorkspaceTotals("7d", "turns")[0] ?? 0,
  0.75,
  D1_D10_AVOIDANCE_FRACTION,
);

function windowFor(preset: "24h" | "7d" | "30d"): { from: string; to: string; preset: string } {
  const to = new Date("2026-08-24T00:00:00Z");
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
  const days = selectedUa11Days(preset);
  const totalSpend = selectedUa11Spend(preset);
  const totalTurns = days.reduce((sum, day) => sum + day.turns, 0);
  const sessionCount = days.flatMap(ua11DailySessions).length;

  const forecast: BurnForecast = {
    state: "OFF",
    limit_tokens: null,
    tokens_used: totalTurns * 12_000,
    tokens_per_day: null,
    projected_exhaustion_jd: null,
    warn_threshold_days: 2,
  };

  const modelTurns = selectedUa11ModelTotals(preset, "turns");
  const modelSpend = selectedUa11ModelTotals(preset, "cost_equiv_u");
  // Ordered as getGlobalOverview emits them: most-expensive tier first.
  const context_per_turn: ContextPerTurnRow[] = UA11_MODELS.map((model, index) => ({
    model,
    n: modelTurns[index] ?? 0,
    avg_context_per_turn: [128_000, 146_150, 110_000, 28_000][index] ?? 0,
    avg_output_per_turn: [500, 580, 585, 390][index] ?? 0,
    usd_per_turn: (modelSpend[index] ?? 0) / MICRO / (modelTurns[index] || 1),
  }));
  const model_mix: ModelMixRow[] = UA11_MODELS.map((model, index) => ({
    model,
    turns: modelTurns[index] ?? 0,
  }));

  const data: GlobalOverview = {
    cost_equiv_u: totalSpend,
    turns: totalTurns,
    turns_total: totalTurns,
    unpriced_turns: 0,
    live_sessions: 0,
    forecast,
    context_per_turn,
    model_mix,
    // Invented subagent split so the Overview Sessions and Subagent spend tiles render numbers.
    subagent_spend: {
      total_cost_u: totalSpend,
      sidechain_cost_u: Math.round(totalSpend * 0.124),
      share: 0.124,
      sessions_with_sidechain_spend: Math.round(sessionCount * 0.42),
      sessions_in_window: sessionCount,
      haiku_sidechain_turns: Math.round(totalTurns * 0.03),
      by_model_family: [
        { family: "Sonnet", cost_u: Math.round(totalSpend * 0.074) },
        { family: "Haiku", cost_u: Math.round(totalSpend * 0.032) },
        { family: "Opus", cost_u: Math.round(totalSpend * 0.018) },
      ],
    },
  };

  return { data, meta: baseMeta(window, 1) };
}

export function mockWorkspaces(filter: WindowFilter): ApiResponse<PagedList<WorkspaceSummary>> {
  const preset = filter.preset ?? "7d";
  const window = windowFor(preset);
  const total = selectedUa11Spend(preset);
  const workspaceSpend = selectedUa11WorkspaceTotals(preset, "cost_equiv_u");
  const workspaceTurns = selectedUa11WorkspaceTotals(preset, "turns");
  const orbitSpend = workspaceSpend[0] ?? 0;
  const supportSpend = workspaceSpend[1] ?? 0;
  const janitorSpend = workspaceSpend[2] ?? 0;
  const adminSpend = workspaceSpend[3] ?? 0;
  const wranglerSpend = workspaceSpend[4] ?? 0;
  const orbitTurns = workspaceTurns[0] ?? 0;
  const supportTurns = workspaceTurns[1] ?? 0;
  const janitorTurns = workspaceTurns[2] ?? 0;
  const adminTurns = workspaceTurns[3] ?? 0;
  const wranglerTurns = workspaceTurns[4] ?? 0;

  const items: WorkspaceSummary[] = [
    {
      workspace_id: "ws-1",
      project_slug: "orbit-api",
      repo_path: "C:/Users/dev/GitHub/orbit-api",
      repo_owner: "acme",
      repo_name: "orbit-api",
      cost_equiv_u: orbitSpend,
      turns: orbitTurns ?? 0,
      cost_share: orbitSpend / total,
      has_live: false,
      usd_per_turn: orbitSpend / MICRO / (orbitTurns ?? 1),
      avg_context_per_turn: ua11WorkspaceContextMean("ws-1", preset),
      cache_write_pct: 0.12,
      opus_pct: 0.67,
      premium_pct: 0.71,
    },
    {
      workspace_id: "ws-2",
      project_slug: "support-portal",
      repo_path: "C:/Users/dev/GitHub/support-portal",
      repo_owner: "acme",
      repo_name: "support-portal",
      cost_equiv_u: supportSpend,
      turns: supportTurns ?? 0,
      cost_share: supportSpend / total,
      has_live: false,
      usd_per_turn: supportSpend / MICRO / (supportTurns ?? 1),
      avg_context_per_turn: 137_000,
      cache_write_pct: 0.09,
      opus_pct: 0.45,
      premium_pct: 0.45,
    },
    {
      workspace_id: "ws-3",
      project_slug: "data-janitor",
      repo_path: "C:/Users/dev/GitHub/data-janitor",
      repo_owner: "acme",
      repo_name: "data-janitor",
      cost_equiv_u: janitorSpend,
      turns: janitorTurns ?? 0,
      cost_share: janitorSpend / total,
      has_live: false,
      usd_per_turn: janitorSpend / MICRO / (janitorTurns ?? 1),
      avg_context_per_turn: 100_000,
      cache_write_pct: 0.18,
      opus_pct: 0.3,
      premium_pct: 0.34,
    },
    {
      workspace_id: "ws-4",
      project_slug: "admin-console",
      repo_path: "C:/Users/dev/GitHub/admin-console",
      repo_owner: "acme",
      repo_name: "admin-console",
      cost_equiv_u: adminSpend,
      turns: adminTurns ?? 0,
      cost_share: adminSpend / total,
      has_live: false,
      usd_per_turn: adminSpend / MICRO / (adminTurns ?? 1),
      avg_context_per_turn: 75_000,
      cache_write_pct: 0.07,
      opus_pct: 0.22,
      premium_pct: 0.22,
    },
    {
      workspace_id: "ws-5",
      project_slug: "AgentWrangler",
      repo_path: "C:/Users/dev/GitHub/AgentWrangler",
      repo_owner: "acme",
      repo_name: "AgentWrangler",
      cost_equiv_u: wranglerSpend,
      turns: wranglerTurns ?? 0,
      cost_share: wranglerSpend / total,
      has_live: false,
      usd_per_turn: wranglerSpend / MICRO / (wranglerTurns ?? 1),
      avg_context_per_turn: 60_000,
      cache_write_pct: 0.14,
      opus_pct: 0.55,
      premium_pct: 0.58,
    },
  ];

  return {
    data: { items, next_cursor: null },
    meta: baseMeta(window, items.length),
  };
}

/**
 * Unwindowed naming metadata for ALL workspaces (UIR-8) — the mockWorkspaces
 * identity fields plus ws-idle, a workspace absent from every windowed
 * mockWorkspaces response, so tests can prove >30d-idle workspaces still
 * resolve friendly labels.
 */
export function mockWorkspaceNames(): WorkspaceNameRow[] {
  return [
    {
      workspace_id: "ws-1",
      project_slug: "orbit-api",
      repo_path: "C:/Users/dev/GitHub/orbit-api",
      repo_owner: "acme",
      repo_name: "orbit-api",
    },
    {
      workspace_id: "ws-2",
      project_slug: "support-portal",
      repo_path: "C:/Users/dev/GitHub/support-portal",
      repo_owner: "acme",
      repo_name: "support-portal",
    },
    {
      workspace_id: "ws-3",
      project_slug: "data-janitor",
      repo_path: "C:/Users/dev/GitHub/data-janitor",
      repo_owner: "acme",
      repo_name: "data-janitor",
    },
    {
      workspace_id: "ws-4",
      project_slug: "admin-console",
      repo_path: "C:/Users/dev/GitHub/admin-console",
      repo_owner: "acme",
      repo_name: "admin-console",
    },
    {
      workspace_id: "ws-5",
      project_slug: "AgentWrangler",
      repo_path: "C:/Users/dev/GitHub/AgentWrangler",
      repo_owner: "acme",
      repo_name: "AgentWrangler",
    },
    {
      workspace_id: "ws-idle",
      project_slug: "legacy-etl",
      repo_path: "C:/Users/dev/GitHub/legacy-etl",
      repo_owner: "acme",
      repo_name: "legacy-etl",
    },
  ];
}

// ---------------------------------------------------------------------------
// Settings fixtures
// ---------------------------------------------------------------------------

const MOCK_PARSER_HEALTH: ParserHealth = {
  files_seen: 146,
  files_parsed: 124,
  lines_quarantined: 0,
  synthetic_excluded: 0,
  duplicate_drops: 0,
  parser_version_mix: { "ingest-1": 124 },
};

/** Aggregate-only first-run status; callers can override individual counters. */
export function mockStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    sessions: selectedUa11Days("7d").flatMap(ua11DailySessions).length,
    scan_state: "complete",
    lines_quarantined: 0,
    invalid_scan_root_count: 0,
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
      spend: {
        cost_equiv_u: UA11_SCENARIO.spend_u,
        turns: 19_400,
        turns_total: 19_400,
        unpriced_turns: 0,
      },
      top_recommendations: [
        { rec_id: "rec-D1-ws-1-mock000000000000", modeled_savings_u_per_wk: UA11_D1.savingsU },
      ],
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
    port: 2929,
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
    usage_cli_enabled: true,
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
// Decision-view fixtures (RIQ4)
// ---------------------------------------------------------------------------

/** Synthetic ranked decisions for test/dev. SEC-101: all text is enum labels or structural anchors. */
export function mockDecisionViews(): DecisionView[] {
  return [
    {
      rank: 1,
      decision_identity: "fixture:family1:ev-alpha",
      family: "EXPLAIN_USAGE_CHANGE",
      next_step: { kind: "INVESTIGATION", description: "Investigate context-size growth pattern" },
      why_ranked: ["GUARDRAIL_SAFE", "MATERIALITY_LARGE", "GOAL_PRIMARY"],
      required_caveats: ["Evidence window is seven days; longer trends may differ"],
      alternative_explanations: ["Growth may reflect genuinely larger tasks"],
      linked_observations: [{ family: "EXPLAIN_USAGE_CHANGE", evidence_ids: ["obs-f1-001"] }],
      materiality_band: "LARGE",
      cause_effect: { cause: "VOLUME_TERM_INCREASE", effect: "OBSERVED_INCREASE" },
      projected_effect: {
        basis: "MODELED",
        expression: "DIRECTION",
        label: "reduces input-token share",
      },
      track_capability: { mode: "MANUAL", reason: "NO_VALIDATED_METHOD" },
      effect_cycle: null,
    },
    {
      rank: 2,
      decision_identity: "fixture:family2:ev-beta",
      family: "TOOL_OUTPUT_RETRY_CONCENTRATION",
      next_step: { kind: "INVESTIGATION", description: "Review tool-output byte concentration" },
      why_ranked: ["GUARDRAIL_SAFE", "MATERIALITY_MODERATE", "GOAL_SECONDARY"],
      required_caveats: [],
      alternative_explanations: [],
      linked_observations: [],
      materiality_band: "MODERATE",
      cause_effect: { cause: "TOOL_CONCENTRATION_HIGH_BYTE_SHARE", effect: "OBSERVED_INCREASE" },
      projected_effect: {
        basis: "MODELED",
        expression: "QUALITATIVE_BAND",
        label: "moderate reduction in tool-result byte share",
      },
      track_capability: { mode: "MANUAL", reason: "NO_VALIDATED_METHOD" },
      effect_cycle: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Recommendations fixtures (DetectorEngine WP)
// ---------------------------------------------------------------------------

export function mockRecommendations(): ApiResponse<RecommendationsView> {
  const window = windowFor("7d");

  // Source-backed D1 gives the browser workflow a concrete, workspace-scoped
  // change to copy, attest, and track. Its projection remains separate from
  // the observed measurement that appears after tracking.
  const d1Card: RecommendationCard = {
    rec_id: "rec-D1-ws-1-mock000000000000",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: "ws-1",
    lever: "Trim stale instructions from this workspace's CLAUDE.md.",
    actions: {
      primary: {
        option_id: "primary",
        kind: "EDIT",
        summary: "Trim stale workspace instructions",
        detail: [],
        copy_text: "Review this workspace's CLAUDE.md and trim stale instructions.",
        file_ref: "CLAUDE.md",
        target_metric: "CONTEXT_TOKENS:CLAUDE_MD:CLAUDE.md",
      },
      alternatives: [],
    },
    action_validation: { primary: { ok: true }, alternatives: {} },
    modeled_savings_u_per_wk: UA11_D1.savingsU,
    // P3.L L6: D1 has a spend-lane producer; this fixture's allocated figure equals the
    // standalone modeled one (no overlap to net out here).
    allocated_u_per_wk: UA11_D1.savingsU,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: {
      ...UA11_D1.formula,
      kind: "MODELED",
    },
    evidence: {
      component: "CLAUDE_MD",
      file_ref: "CLAUDE.md",
      title: "Trim stale CLAUDE.md instructions",
      source_tokens: UA11_D1_SOURCE_TOKENS,
      source_target: UA11_D1_TARGET_TOKENS,
      delta_context_tokens: UA11_D1_SOURCE_TOKENS - UA11_D1_TARGET_TOKENS,
      turns_per_week: selectedUa11WorkspaceTotals("7d", "turns")[0] ?? 0,
    },
    target_metric: "CONTEXT_TOKENS:CLAUDE_MD:CLAUDE.md",
    state: "PROPOSED",
    created_at: window.to,
    dismissed_until: null,
    headroom: {
      tokens_per_wk_freed:
        (UA11_D1_SOURCE_TOKENS - UA11_D1_TARGET_TOKENS) *
        (selectedUa11WorkspaceTotals("7d", "turns")[0] ?? 0),
      tokens_per_session_freed: UA11_D1_SOURCE_TOKENS - UA11_D1_TARGET_TOKENS,
    },
    sessions_per_week: selectedUa11Days("7d")
      .flatMap(ua11DailySessions)
      .filter((session) => session.workspace_id === "ws-1").length,
    steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 } satisfies BoundedStep],
    actionability_ok: true,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: "CLAUDE.md",
  };

  const d2Card: RecommendationCard = {
    rec_id: "rec-D2-global-mock000000000000",
    detector_id: "D2",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "/clear between unrelated tasks; split long work; avoid mid-task /compact.",
    actions: {
      primary: {
        option_id: "primary",
        kind: "HABIT",
        summary: "Use /clear between unrelated tasks",
        detail: [],
        copy_text: "Use /clear between unrelated tasks and split long work.",
        file_ref: null,
        target_metric: "avg_context_per_turn",
      },
      alternatives: [],
    },
    action_validation: { primary: { ok: true }, alternatives: {} },
    // D2 is directional: its cache-read exposure cannot establish avoidable USD.
    modeled_savings_u_per_wk: null,
    pct_of_weekly_spend: null,
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
      kind: "DIRECTIONAL",
    },
    evidence: {
      qualifying_session_count: ua11D2QualifyingSessions().length,
      session_ids: ua11D2QualifyingSessions().map((session) => session.session_id),
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
    sessions_per_week: ua11D2QualifyingSessions().length,
    steps: [
      {
        kind: "generic",
        description: "/clear between unrelated tasks; split long work; avoid mid-task /compact.",
      } satisfies BoundedStep,
    ],
    actionability_ok: false,
    cross_workspace: true,
    workspace_multiplier: null,
    file_ref: null,
  };

  const adoptedD1Card: RecommendationCard = {
    ...d1Card,
    rec_id: "rec-D1-global-mockledger0001",
    scope_workspace_id: null,
    lever: "Trim the global CLAUDE.md to its load-bearing core.",
    state: "ADOPTED",
  };
  const adoptedD2Card: RecommendationCard = {
    ...d2Card,
    rec_id: "rec-D2-global-mockledger0002",
    state: "ADOPTED",
  };
  const adoptedD5Card: RecommendationCard = {
    rec_id: "rec-D5-global-mockledger-warning",
    detector_id: "D5",
    category: "LIMIT",
    scope_workspace_id: null,
    lever: "Configure a weekly token limit.",
    modeled_savings_u_per_wk: null,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "none", inputs: {}, kind: "WARNING" },
    evidence: {},
    target_metric: "limit_configuration",
    state: "ADOPTED",
    created_at: window.to,
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [{ kind: "generic", description: "Configure a weekly token limit." }],
    actionability_ok: false,
    cross_workspace: true,
    workspace_multiplier: null,
    file_ref: null,
  };

  const h1PinnedCard: RecommendationCard = {
    rec_id: "rec-H1-global-mock000000000000",
    detector_id: "H1",
    category: "TOOLING",
    scope_workspace_id: null,
    lever:
      "Add a destructive-operation guard to your CLAUDE.md to prevent accidental file deletion.",
    // No effect handler measures destructive_operation_count, so the action is valid but unmeasured.
    actions: {
      primary: {
        option_id: "h1-confirm-destructive-database-operation",
        kind: "EDIT",
        summary: "Require confirmation for 2 reported drop tables.",
        detail: [],
        copy_text:
          "Add to CLAUDE.md: Stop and ask for explicit confirmation before running any drop table statement.",
        file_ref: "CLAUDE.md",
        target_metric: "destructive_operation_count",
      },
      alternatives: [],
    },
    action_validation: { primary: { ok: true, measured: false }, alternatives: {} },
    modeled_savings_u_per_wk: null,
    // P3.L L6: H1 has no spend-lane producer — "not estimated", never $0.
    allocated_u_per_wk: null,
    run_cost_u: null,
    modeled_formula: { model: "H1_DESTRUCTIVE_GUARD_V1", inputs: {}, kind: "SAFETY" },
    evidence: { guard_present: false },
    target_metric: "destructive_operation_count",
    state: "PROPOSED",
    created_at: window.to,
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [{ kind: "generic", description: "Add a destructive-operation guard to CLAUDE.md." }],
    actionability_ok: true,
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: "CLAUDE.md",
    pct_of_weekly_spend: null,
  };

  const frictionCard: RecommendationCard = {
    rec_id: "rec-D2-friction-mock000000000",
    detector_id: "D2",
    category: "CONTEXT",
    scope_workspace_id: null,
    lever: "Split long tasks and use /clear between unrelated topics to reduce context size.",
    modeled_savings_u_per_wk: null,
    run_cost_u: null,
    modeled_formula: {
      model: "D2_LONG_CONTEXT_CACHE_READ_V1",
      inputs: {
        cache_read_tokens_per_week: 500_000_000,
        cache_read_price_usd_per_mtok: 1.5,
        reduction_fraction: 0.2,
      },
      expression:
        "cache_read_tokens_per_week / 1e6 * cache_read_price_usd_per_mtok * reduction_fraction",
      kind: "DIRECTIONAL",
    },
    evidence: { qualifying_session_count: 2, session_ids: ["s-friction-01", "s-friction-02"] },
    target_metric: "avg_context_per_turn",
    state: "PROPOSED",
    created_at: window.to,
    dismissed_until: null,
    headroom: null,
    sessions_per_week: 2,
    steps: [{ kind: "generic", description: "Use /clear between unrelated tasks." }],
    actionability_ok: false,
    cross_workspace: true,
    workspace_multiplier: null,
    file_ref: null,
    pct_of_weekly_spend: null,
  };

  const data: RecommendationsView = {
    active: [d2Card, d1Card, h1PinnedCard, frictionCard],
    active_groups: [
      {
        detector_id: "D2",
        label: "Session hygiene",
        recs: [d2Card],
        session_count: ua11D2QualifyingSessions().length,
        total_savings_u_per_wk: 0,
      },
      {
        detector_id: "D1",
        label: "CLAUDE.md / memory",
        recs: [d1Card],
        session_count: 0,
        total_savings_u_per_wk: d1Card.modeled_savings_u_per_wk ?? 0,
      },
    ],
    limit_warnings: [],
    adopted: [adoptedD1Card, adoptedD2Card, adoptedD5Card],
    dismissed: [],
    history: [],
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
        note: `${ua11D2QualifyingSessions().length} qualifying long-context sessions this week`,
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
    rank_warnings: [],
    overflow_count: 0,
    excluded: [{ subject: "CONTEXT_CACHE_BEHAVIOR", reason: "HEALTHY" }],
    ranking_goal: "PRESERVE_QUALITY",
    packet_identity_hash: "fixture-packet-hash",
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
    measured_at: "2026-08-24T00:00:00.000Z",
    before_from: "2026-07-27T00:00:00.000Z",
    before_to: "2026-08-10T00:00:00.000Z",
    after_from: "2026-08-10T00:00:00.000Z",
    after_to: "2026-08-24T00:00:00.000Z",
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
    adopted_at: "2026-08-10T00:00:00.000Z",
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
    modeled_savings_u_per_wk: null,
    modeled_cap_weighted_u_per_wk: null,
    effects: [measuringEffect],
    confounded_window: true,
  };

  // A worsening raw D2 value remains NO_EFFECT: direction is visible, but it
  // must never be converted into achieved or modeled savings.
  const noEffectEntry: LedgerEntry = {
    rec_id: "rec-D2-global-mockledger-no-effect",
    detector_id: "D2",
    lever: "Keep unrelated work in separate sessions.",
    adopted_at: "2026-08-06T09:00:00.000Z",
    state: "MEASURED_NO_EFFECT",
    target_metric: "avg_context_per_turn",
    modeled_savings_u_per_wk: null,
    modeled_cap_weighted_u_per_wk: null,
    effects: [
      {
        rec_id: "rec-D2-global-mockledger-no-effect",
        measured_at: "2026-08-22T09:00:00.000Z",
        before_from: "2026-08-01T00:00:00.000Z",
        before_to: "2026-08-06T09:00:00.000Z",
        after_from: "2026-08-06T09:00:00.000Z",
        after_to: "2026-08-20T09:00:00.000Z",
        before_value: 187_500,
        after_value: 225_000,
        before_n: 5,
        after_n: 5,
        delta_pct: 20,
        verdict: "NO_EFFECT",
        qualification: "EXPERIMENTAL",
      },
    ],
    confounded_window: false,
  };

  const inconclusiveEntry: LedgerEntry = {
    rec_id: "rec-D8-global-mockledger-inconclusive",
    detector_id: "D8",
    lever: "Avoid cache rewrites after idle gaps.",
    adopted_at: "2026-08-04T09:00:00.000Z",
    state: "MEASURED_NO_EFFECT",
    target_metric: "cache_read_to_creation_ratio",
    modeled_savings_u_per_wk: null,
    modeled_cap_weighted_u_per_wk: null,
    effects: [
      {
        rec_id: "rec-D8-global-mockledger-inconclusive",
        measured_at: "2026-08-22T09:00:00.000Z",
        before_from: "2026-08-01T00:00:00.000Z",
        before_to: "2026-08-04T09:00:00.000Z",
        after_from: "2026-08-04T09:00:00.000Z",
        after_to: "2026-08-18T09:00:00.000Z",
        before_value: 1.2,
        after_value: 1.1,
        before_n: 4,
        after_n: 4,
        delta_pct: -8.33,
        verdict: "INCONCLUSIVE",
        qualification: null,
      },
    ],
    confounded_window: true,
  };

  const warningEntry: LedgerEntry = {
    rec_id: "rec-D5-global-mockledger-warning",
    detector_id: "D5",
    lever: "Configure a weekly token limit.",
    adopted_at: "2026-08-03T09:00:00.000Z",
    state: "ADOPTED",
    target_metric: "limit_configuration",
    modeled_savings_u_per_wk: null,
    modeled_cap_weighted_u_per_wk: null,
    effects: [],
    confounded_window: false,
  };

  const data: LedgerView = {
    entries: [d1Entry, d2Entry, noEffectEntry, inconclusiveEntry, warningEntry],
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

export function mockTrends(filter: WindowFilter): ApiResponse<TrendData> {
  const preset = filter.preset ?? "7d";
  const window = windowFor(preset);
  const days = selectedUa11Days(preset);
  const models = UA11_MODELS;
  const data: TrendData = {
    bucket: "day",
    buckets: [...days],
    by_model: days.flatMap((day) => {
      const spend = splitWhole(day.cost_equiv_u, UA11_MODEL_SPEND_WEIGHTS);
      const turns = splitWhole(day.turns, UA11_MODEL_TURN_WEIGHTS);
      return models.map((model, index) => ({
        bucket: day.bucket,
        model,
        cost_equiv_u: spend[index] ?? 0,
        turns: turns[index] ?? 0,
      }));
    }),
    by_workspace: days.flatMap((day) => {
      const spend = ua11WorkspaceSpendSplit(day);
      const turns = splitWhole(day.turns, UA11_WORKSPACE_TURN_WEIGHTS);
      return UA11_WORKSPACE_IDENTITIES.map((workspace, index) => ({
        bucket: day.bucket,
        workspace_id: workspace.workspace_id,
        project_slug: workspace.project_slug,
        cost_equiv_u: spend[index] ?? 0,
        turns: turns[index] ?? 0,
      }));
    }),
    sessions: days.flatMap(ua11DailySessions).map((session) => ({
      session_id: session.session_id,
      workspace_id: session.workspace_id,
      project_slug: session.repo_name ?? "",
      first_turn_at: session.first_turn_at ?? "",
      cost_equiv_u: session.cost_equiv_u,
    })),
    cap_weighted: days.map((day) => ({
      bucket: day.bucket,
      cap_weighted_tokens: day.turns * 8_000,
      turns: day.turns,
    })),
    cap_read_coeff: 0.1,
    adoption_markers: [
      {
        rec_id: "rec-adopted-fixture",
        detector_id: "D8",
        lever: "Clear stale sessions before cache expiry",
        adopted_at: "2026-08-20T09:00:00.000Z",
        bucket: "2026-08-20",
      },
    ].filter((marker) => marker.adopted_at >= window.from && marker.adopted_at < window.to),
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

function ua11DailySessions(day: Ua11DailyObservation): SessionSummary[] {
  const spend = ua11WorkspaceSpendSplit(day);
  const turns = splitWhole(day.turns, UA11_WORKSPACE_TURN_WEIGHTS);
  const scenarioDay = Number(day.bucket.slice(-2)) - 17;
  const sessionCount =
    day.bucket >= "2026-08-17" &&
    scenarioDay >= 0 &&
    scenarioDay < UA11_SEVEN_DAY_SESSION_COUNTS.length
      ? (UA11_SEVEN_DAY_SESSION_COUNTS[scenarioDay] ?? 17)
      : 17;
  const sessionsByWorkspace = splitWhole(sessionCount, UA11_WORKSPACE_SESSION_WEIGHTS);
  return UA11_WORKSPACE_IDENTITIES.flatMap((workspace, workspaceIndex) => {
    const count = sessionsByWorkspace[workspaceIndex] ?? 0;
    const spendBySession = splitWhole(
      spend[workspaceIndex] ?? 0,
      Array.from({ length: count }, () => 1 / count),
    );
    const turnsBySession = splitWhole(
      turns[workspaceIndex] ?? 0,
      Array.from({ length: count }, () => 1 / count),
    );
    return Array.from({ length: count }, (_, sessionIndex) => {
      const start = new Date(
        Date.parse(`${day.bucket}T08:00:00.000Z`) + (workspaceIndex * 3 + sessionIndex) * 1_800_000,
      );
      const sessionTurns = turnsBySession[sessionIndex] ?? 0;
      return {
        ...ua11SessionSummary(
          `ua11-session-${day.bucket}-${workspace.workspace_id}-${sessionIndex + 1}`,
          workspace.workspace_id,
        ),
        cost_equiv_u: spendBySession[sessionIndex] ?? 0,
        turn_count: sessionTurns,
        first_turn_at: start.toISOString(),
        last_turn_at: new Date(
          start.getTime() + Math.max(0, sessionTurns - 1) * 30_000,
        ).toISOString(),
        state: "RECONCILED" as const,
      };
    });
  });
}

function isUa11D2Candidate(session: SessionSummary): boolean {
  return (
    session.workspace_id === "ws-1" &&
    session.session_id.endsWith("-1") &&
    ["2026-08-17", "2026-08-18", "2026-08-19"].some((date) => session.session_id.includes(date))
  );
}

function ua11SessionContextTokens(session: SessionSummary): number {
  if (isUa11D2Candidate(session)) return 220_000;
  // Baselines offset the three 220K D2 sessions so every workspace summary
  // remains the turn-weighted mean of its public session timelines.
  return (
    {
      "ws-1": 144_458,
      "ws-2": 137_000,
      "ws-3": 100_000,
      "ws-4": 75_000,
      "ws-5": 60_000,
    }[session.workspace_id] ?? UA11_AVG_CONTEXT_TOKENS
  );
}

function ua11WorkspaceContextMean(workspaceId: string, preset: Ua11Preset): number {
  const sessions = selectedUa11Days(preset)
    .flatMap(ua11DailySessions)
    .filter((session) => session.workspace_id === workspaceId);
  const turns = sessions.reduce((sum, session) => sum + session.turn_count, 0);
  const context = sessions.reduce(
    (sum, session) => sum + ua11SessionContextTokens(session) * session.turn_count,
    0,
  );
  return turns === 0 ? 0 : Math.round(context / turns);
}
function ua11D2QualifyingSessions(): SessionSummary[] {
  return selectedUa11Days("7d")
    .flatMap(ua11DailySessions)
    .filter((session) => session.turn_count > 150 && ua11SessionContextTokens(session) > 180_000);
}

function ua11SessionSummary(sessionId: string, workspaceId: string): SessionSummary {
  const workspace = UA11_WORKSPACE_IDENTITIES.find(
    (candidate) => candidate.workspace_id === workspaceId,
  );
  if (workspace === undefined) throw new Error(`unknown UA11 workspace fixture: ${workspaceId}`);
  const detailSpend =
    ua11WorkspaceSpendSplit({
      bucket: "2026-08-16",
      cost_equiv_u: UA11_SCENARIO.trend_spend_u[0],
      turns: 3_000,
    })[UA11_WORKSPACE_IDENTITIES.indexOf(workspace)] ?? 0;
  const data: SessionSummary = {
    session_id: sessionId,
    workspace_id: workspace.workspace_id,
    repo_path: `C:/Users/dev/GitHub/${workspace.repo_name}`,
    repo_owner: "acme",
    repo_name: workspace.repo_name,
    file_path: "sessions/demo.jsonl",
    state: "LIVE",
    turn_count: 2,
    cost_equiv_u: detailSpend,
    first_turn_at: "2026-08-17T10:00:00Z",
    last_turn_at: "2026-08-17T10:00:30Z",
    hygiene_flags: [],
    compaction_count: 0,
    compaction_turn_indices: [],
    api_error_count: 0,
    interrupt_count: 0,
    interrupts_supported: false,
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
  return data;
}

export function mockSession(sessionId: string): ApiResponse<SessionSummary> {
  const canonical = UA11_DAILY_OBSERVATIONS.flatMap(ua11DailySessions).find(
    (session) => session.session_id === sessionId,
  );
  // Arbitrary IDs remain useful for focused UI tests; public drilldowns use canonical IDs.
  const workspaceId = sessionId.startsWith("workspace-session-")
    ? sessionId.replace("workspace-session-", "")
    : "ws-1";
  const data = canonical ?? ua11SessionSummary(sessionId, workspaceId);
  return {
    data,
    meta: {
      ...baseMeta(windowFor("7d"), 1),
      metric_definition_version: "esf-1",
      drilldown_ids: { session_id: sessionId, workspace_id: data.workspace_id },
    },
  };
}

export function mockSessionDiagnostics(sessionId: string): ApiResponse<SessionDiagnosticAnchor[]> {
  return {
    data: [
      {
        session_id: sessionId,
        category: "errors",
        label: "Tool error",
        turn_index: 1,
        timestamp: "2026-01-01T00:01:00Z",
        ceu: null,
      },
    ],
    meta: { ...baseMeta(windowFor("7d"), 1), drilldown_ids: { session_id: sessionId } },
  };
}

export function mockSessionBreakdown(sessionId: string): ApiResponse<SessionBreakdown> {
  return {
    data: {
      cost_rows: [
        {
          model: "synthetic-model",
          is_sidechain: false,
          turn_count: 2,
          cost_u: 120000,
          input_tokens: 1200,
          output_tokens: 200,
          cache_read_tokens: 300,
          cache_write_5m: 40,
          cache_write_1h: 10,
          cache_write_other: 0,
        },
      ],
      tools: [
        {
          tool_name: "Read",
          calls: 2,
          errors: 1,
          total_result_bytes: 2048,
          max_result_bytes: 1536,
          first_error_at: "2026-01-01T00:01:00Z",
          last_error_at: "2026-01-01T00:01:00Z",
          first_error_turn_index: 1,
          error_breakdown: [{ tool_error_class: "NOT_FOUND", bash_command_family: null, count: 1 }],
        },
      ],
      tool_error_turn_indices: [1],
      loop_turn_indices: [],
    },
    meta: { ...baseMeta(windowFor("7d"), 2), drilldown_ids: { session_id: sessionId } },
  };
}

/**
 * Synthetic session story: a main lane and two subagent lanes, an idle gap over 30 minutes
 * (the swimlane compresses it), one compaction, tool errors with stored text, two commits.
 */
export function mockSessionStory(sessionId: string): SessionStory {
  const start = Date.parse(mockSession(sessionId).data?.first_turn_at ?? "2026-08-22T10:00:00Z");
  const at = (min: number) => new Date(start + min * 60_000).toISOString();
  // Canonical sessions: scale the story's dollars to the session's own cost so the list row,
  // the header and the story agree. Arbitrary test ids keep the fixed $3.62 story.
  const k = sessionId.startsWith("ua11-session-")
    ? (mockSession(sessionId).data?.cost_equiv_u ?? 3_620_000) / 3_620_000
    : 1;
  const s = (u: number) => Math.round(u * k);
  const turns: SessionStory["turns"] = [];
  const push = (lane: string, model: string, min: number, i: number) =>
    turns.push({
      ts: at(min),
      lane_id: lane,
      model,
      context: 20_000 + i * 6_000,
      cost_u: s(lane === "main" ? 90_000 : 140_000),
      compaction: lane === "main" && i === 12,
      error: i % 7 === 3,
    });
  for (let i = 0; i < 20; i++) push("main", "claude-sonnet-5", i < 10 ? i * 2 : 60 + i * 2, i);
  for (let i = 0; i < 8; i++) push("agent-explore", "claude-opus-4-8", 4 + i, i);
  for (let i = 0; i < 5; i++) push("agent-plan", "claude-haiku-4-5", 70 + i, i);
  turns.sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    session_id: sessionId,
    title: "Add a story view to the session page",
    first_prompt: "Show what this session did and where the money went.",
    transcript_available: true,
    files_touched: [
      { path: "src/ui/sessions/SessionDetailPage.tsx", edits: 6 },
      { path: "src/ui/api/client.ts", edits: 2 },
    ],
    commits: [
      { sha: "a1b2c3d4e5f6a7b8c9d0", ts: at(18) },
      { sha: "0f9e8d7c6b5a4f3e2d1c", ts: at(98) },
    ],
    total_cost_u: s(3_620_000),
    spend: [
      { chain: "main", model: "claude-sonnet-5", turns: 20, cost_u: s(1_800_000) },
      { chain: "subagent", model: "claude-opus-4-8", turns: 8, cost_u: s(1_120_000) },
      { chain: "subagent", model: "claude-haiku-4-5", turns: 5, cost_u: s(700_000) },
    ],
    headline: {
      text: "Opus subagents were 31% of this session's cost.",
      detail: "8 Explore turns ran on Opus 4.8.",
      savings_u: s(670_000),
    },
    lanes: [
      {
        lane_id: "main",
        label: "Main",
        is_main: true,
        first_ts: at(0),
        last_ts: at(98),
        turns: 20,
        cost_u: s(1_800_000),
        models: ["claude-sonnet-5"],
      },
      {
        lane_id: "agent-explore",
        label: "Explore",
        is_main: false,
        first_ts: at(4),
        last_ts: at(11),
        turns: 8,
        cost_u: s(1_120_000),
        models: ["claude-opus-4-8"],
      },
      {
        lane_id: "agent-plan",
        label: "Plan",
        is_main: false,
        first_ts: at(70),
        last_ts: at(74),
        turns: 5,
        cost_u: s(700_000),
        models: ["claude-haiku-4-5"],
      },
    ],
    turns,
    error_groups: [
      {
        tool: "Bash",
        command: "npm run test",
        other_commands: 2,
        signature: "Error: exit code N",
        count: 4,
        sample_command: "npm run test -- --run",
        sample_error: "Error: exit code 1",
        first_ts: at(6),
        last_ts: at(80),
      },
    ],
    errors_without_text: 0,
  };
}

/**
 * The canonical daily split gives every session in a workspace-day the same cost and turns, which
 * reads as clones in the workspace "Top sessions" table. Spread cost and turns unevenly (a
 * deterministic multiplier per session id, rescaled so the list still sums to the same totals),
 * stagger the end times, and return the rows costliest first.
 */
function varySessionList(items: SessionSummary[]): SessionSummary[] {
  const mult = (id: string, salt: number): number => {
    // FNV-1a plus a final avalanche, so ids that differ in one character get unrelated values.
    let h = (2166136261 ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
    for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    const u = h / 4294967296;
    // Salt 1 (cost): heavy-tailed so the costliest rows differ visibly. Others: mild spread.
    return salt === 1 ? 0.12 + 6 * u ** 3 : 0.4 + 1.6 * u;
  };
  // Rescale to the original total exactly (the largest entry absorbs rounding).
  const rescale = (values: number[], total: number): number[] => {
    const sum = values.reduce((a, b) => a + b, 0) || 1;
    const out = values.map((v) => Math.max(1, Math.round((v / sum) * total)));
    const big = out.indexOf(Math.max(...out));
    if (big >= 0) out[big] = (out[big] ?? 0) + total - out.reduce((a, b) => a + b, 0);
    return out;
  };
  const costs = rescale(
    items.map((s) => s.cost_equiv_u * mult(s.session_id, 1)),
    items.reduce((a, s) => a + s.cost_equiv_u, 0),
  );
  // The D2 evidence sessions keep their turns; the rest (one shared context level per
  // workspace) trade turns among themselves, so turn-weighted context means do not move.
  const movable = items.filter((s) => !isUa11D2Candidate(s));
  const movedTurns = rescale(
    movable.map((s) => s.turn_count * mult(s.session_id, 7)),
    movable.reduce((a, s) => a + s.turn_count, 0),
  );
  const turnsById = new Map(movable.map((s, i) => [s.session_id, movedTurns[i] ?? s.turn_count]));
  return items
    .map((s, i) => {
      const n = turnsById.get(s.session_id) ?? s.turn_count;
      const startMs = Date.parse(s.first_turn_at ?? "");
      return {
        ...s,
        cost_equiv_u: costs[i] ?? s.cost_equiv_u,
        turn_count: n,
        ...(Number.isNaN(startMs)
          ? {}
          : { last_turn_at: new Date(startMs + Math.max(0, n - 1) * 30_000).toISOString() }),
      };
    })
    .sort((a, b) => b.cost_equiv_u - a.cost_equiv_u);
}

export function mockWorkspaceSessions(
  workspaceId: string,
  filter: WindowFilter,
): ApiResponse<PagedList<SessionSummary>> {
  const preset = filter.preset ?? "7d";
  const items = selectedUa11Days(preset)
    .flatMap(ua11DailySessions)
    .filter((session) => session.workspace_id === workspaceId);
  return {
    data: { items: varySessionList(items), next_cursor: null },
    meta: { ...baseMeta(windowFor(preset), items.length), metric_definition_version: "esf-1" },
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
      cost_equiv_u: 720_000,
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
      cost_equiv_u: 480_000,
      cost_claim: "LIST_EQUIV",
      provisional: false,
      effort: "medium",
    },
  ];
  const session = mockSession(sessionId).data;
  if (!session) throw new Error("turn timeline requires a session");
  const costs = splitWhole(
    session.cost_equiv_u,
    Array.from({ length: session.turn_count }, () => 1 / session.turn_count),
  );
  const timeline = Array.from({ length: session.turn_count }, (_, index) => {
    const template = rows[index % rows.length];
    if (!template) throw new Error("turn template missing");
    return {
      ...template,
      message_id: `turn-${index + 1}`,
      ts: new Date(Date.parse(session.first_turn_at ?? "") + index * 30_000).toISOString(),
      cost_equiv_u: costs[index] ?? 0,
      output_tokens: sessionId.startsWith("ua11-session-")
        ? UA11_AVG_OUTPUT_TOKENS
        : template.output_tokens,
      context_tokens: sessionId.startsWith("ua11-session-")
        ? ua11SessionContextTokens(session)
        : template.context_tokens,
      provisional: sessionId.startsWith("ua11-session-") ? false : index === 0,
    };
  });
  const firstPage = after === undefined;
  const data: PagedList<TurnRow> = firstPage
    ? { items: timeline.slice(0, 1), next_cursor: timeline.length > 1 ? "mock-page-2" : null }
    : { items: timeline.slice(1), next_cursor: null };
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

const UA11_CACHE_CREATION_BY_BUCKET: Readonly<Record<string, number>> = {
  "2026-08-17": 24_000_000,
  "2026-08-18": 22_000_000,
  "2026-08-19": 110_000_000,
  "2026-08-20": 21_000_000,
  "2026-08-21": 25_000_000,
  "2026-08-22": 23_000_000,
  "2026-08-23": 18_000_000,
};

function ua11CacheCreationTokens(bucket: string): number {
  return UA11_CACHE_CREATION_BY_BUCKET[bucket] ?? 20_000_000;
}

/** Mock token-flavor decomposition — cap-proxy-weighted display. */
export function mockFlavorDecomposition(filter: WindowFilter): ApiResponse<FlavorDecomposition> {
  const preset = filter.preset ?? "7d";
  const window = windowFor(preset);
  const turns = selectedUa11Days(preset).reduce((sum, day) => sum + day.turns, 0);
  const scale = turns / 19_400;
  const coeff = 0.1;

  const rawInput = Math.round(900_000_000 * scale);
  const rawOutput = turns * UA11_AVG_OUTPUT_TOKENS;
  const cacheCreation = selectedUa11Days(preset).reduce(
    (sum, day) => sum + ua11CacheCreationTokens(day.bucket),
    0,
  );
  const rawCw5m = Math.round(cacheCreation * 0.82);
  const rawCw1h = cacheCreation - rawCw5m;
  const rawCwOther = 0;
  const rawCr = Math.round(1_766_000_000 * scale);

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
    turns,
  };

  return { data, meta: { ...baseMeta(window, 6), claim_kind: "PROXY" } };
}

/** Mock cache-write spike timeline — 7-day series with one spike. */
export function mockCacheWriteTrend(filter: WindowFilter): ApiResponse<CacheWriteTrend> {
  const preset = filter.preset ?? "7d";
  const window = windowFor(preset);
  const buckets: CacheWriteBucketRow[] = selectedUa11Days(preset).map((day) => {
    const cache_creation_tokens = ua11CacheCreationTokens(day.bucket);
    const cache_read_tokens = day.turns * 91_000;
    return {
      bucket: day.bucket,
      cache_creation_tokens,
      cache_read_tokens,
      efficiency_ratio: cache_read_tokens / (cache_read_tokens + cache_creation_tokens),
      turns: day.turns,
    };
  });
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
  // Both context averages include provisional turns over seven days. The demo
  // has no provisional turns, so its observed count also matches summary.turns.
  const summary = mockWorkspaces({ preset: "7d" });
  const workspace = summary.data?.items.find((row) => row.workspace_id === workspaceId);
  const observedContext = workspace?.avg_context_per_turn ?? null;
  const alwaysLoaded = 18_000;
  const residual = observedContext === null ? 0 : Math.max(observedContext - alwaysLoaded, 0);
  const total = observedContext === null ? 0 : alwaysLoaded + residual;
  const share = (tokens: number): number | null => (total > 0 ? tokens / total : null);
  const data: ContextComposition = {
    workspace_id: workspaceId,
    observed_context_tokens: observedContext,
    observed_turns: workspace?.turns ?? 0,
    inventory_rows: 2,
    rows: [
      {
        key: "always_loaded",
        label: "always loaded",
        tokens: alwaysLoaded,
        share: share(alwaysLoaded),
      },
      {
        key: "session_residual",
        label: "session history + tool outputs (not itemized in v1)",
        tokens: residual,
        share: share(residual),
      },
    ],
  };
  return {
    data,
    meta: {
      ...baseMeta(summary.meta.window, data.observed_turns),
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

/** Default mock for the statusline-limits status endpoint — not set up. */
export function mockStatuslineStatus(): StatuslineStatus {
  return {
    state: "not-set-up",
    ageSec: null,
    snippet: "agentwrangler statusline",
    installed: false,
  };
}

/** Mock preview/apply result for the statusline install flow (mock mode, no existing statusLine). */
export function mockStatuslineChange(action: "install" | "uninstall"): {
  ok: true;
  plan: StatuslinePlan;
} {
  const entry = JSON.stringify(
    { type: "command", command: '"node" "agentwrangler.js" statusline' },
    null,
    2,
  );
  return {
    ok: true,
    plan: {
      action,
      settingsPath: "~/.claude/settings.json",
      before: action === "install" ? null : entry,
      after: action === "install" ? entry : null,
      changed: true,
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

/**
 * Usage-limits card model fixture (overview-v2 §1). Connected state with a
 * session row (ahead of pace), a weekly all-models row (on pace), and one
 * per-model row (headroom), mirroring the live /api/query/limits shape.
 */
export function mockLimits(): LimitsModel {
  const now = Date.now();
  const iso = (hoursFromNow: number) => new Date(now + hoursFromNow * 3_600_000).toISOString();
  return {
    state: "connected",
    asOf: new Date(now).toISOString(),
    stale: false,
    rows: [
      {
        id: "session",
        label: "Current session",
        windowHours: 5,
        usedPct: 33,
        resetsAt: iso(3.78),
        hoursUntilReset: 3.78,
        elapsedHours: 1.22,
        pacePct: 24.4,
        burnRate: 27,
        budgetRate: 20,
        paceState: "ahead",
        projection: { kind: "hits-limit-in", hours: 2.48 },
      },
      {
        id: "weekly",
        label: "Weekly · all models",
        windowHours: 168,
        usedPct: 52,
        resetsAt: iso(70),
        hoursUntilReset: 70,
        elapsedHours: 98,
        pacePct: 58.3,
        burnRate: 12.7,
        budgetRate: 14.29,
        paceState: "on",
        projection: { kind: "ends-at", pct: 89 },
      },
      {
        id: "weekly:fable",
        label: "Weekly · Fable",
        windowHours: 168,
        usedPct: 20,
        resetsAt: iso(70),
        hoursUntilReset: 70,
        elapsedHours: 98,
        pacePct: 58.3,
        burnRate: 4.9,
        budgetRate: 14.29,
        paceState: "on",
        projection: { kind: "ends-at", pct: 34 },
        headroomMultiple: 3,
      },
    ],
    estimateVsActual: { modelPct: 37, actualPct: 52, deltaPts: -15 },
    localHistory: {
      basis: "cap-weighted",
      fiveHourTokens: 420_000,
      sevenDayTokens: 2_500_000,
      tokensPerDay: 510_000,
      weeklyLimitTokens: null,
      weeklyUtilizationPct: null,
      projectedExhaustionAt: null,
      forecastState: "OFF",
    },
    live: { sessions: 3, runningSpendUsd: 36.98 },
  };
}

/** Default 0.2.0 install: a fresh reading from the user's own `claude -p /usage` (background reader on). */
export function mockLimitsCli(): LimitsModel {
  return { ...mockLimits(), asOf: new Date(Date.now() - 2 * 60_000).toISOString(), source: "cli" };
}

/**
 * OV-12: mockLimits() plus a weeklyMax in the given state. Opt-in, so mockLimits() keeps its
 * exact payload for existing tests. "ok" = $40 spent at 25% → $160 / 80M; two per-model rows.
 */
export function mockLimitsWithWeeklyMax(
  state: "ok" | "low-confidence" | "too-early" | "stale" | "unavailable",
): LimitsModel {
  const base = mockLimits();
  const resetsAt = base.rows.find((r) => r.id === "weekly")?.resetsAt ?? base.asOf;
  const usedPct = state === "low-confidence" ? 5 : state === "too-early" ? 1.5 : 25;
  const maxU = state === "too-early" ? null : 40e6 / (usedPct / 100);
  if (state === "unavailable") {
    base.weeklyMax = {
      weekStart: null,
      resetsAt: null,
      usedPct: null,
      spendSoFarU: null,
      impliedMaxSpendU: null,
      impliedMaxPwTokens: null,
      stale: false,
      state: "unavailable",
    };
    return base;
  }
  base.weeklyMax = {
    weekStart: new Date(Date.parse(resetsAt) - 168 * 3_600_000).toISOString(),
    resetsAt,
    usedPct,
    spendSoFarU: 40e6,
    impliedMaxSpendU: maxU,
    impliedMaxPwTokens: maxU === null ? null : maxU / 2,
    stale: state === "stale",
    state: state === "stale" ? "ok" : state,
    perModel: [
      {
        id: "weekly:fable",
        label: "Fable",
        usedPct: 20,
        impliedMaxSpendU: 50e6,
        impliedMaxPwTokens: 25e6,
        state: "ok",
      },
      {
        id: "weekly:opus",
        label: "Opus",
        usedPct: 1,
        impliedMaxSpendU: null,
        impliedMaxPwTokens: null,
        state: "too-early",
      },
    ],
  };
  if (state === "stale") base.stale = true;
  return base;
}

/**
 * OV-12 U5: mockLimitsWithWeeklyMax(state) plus past weeks, in the live 2026-10-04 shape relative
 * to this week's reset: last week has no reading; two weeks back $1,156 (100%, limit hit; 2 readings
 * ≥ 50%, $1,156–$1,180); three weeks back $1,130 (20%, calibration). vsLastWeek follows the
 * server rule (vs the latest week with a max; clear when |change| > noisePct).
 */
export function mockLimitsWithHistory(
  state: "ok" | "low-confidence" | "too-early",
  thisWeekMaxU?: number,
): LimitsModel {
  const base = mockLimitsWithWeeklyMax(state);
  const wm = base.weeklyMax;
  if (wm?.resetsAt == null) return base;
  const H = 3_600_000;
  const cur = Math.round(Date.parse(wm.resetsAt) / H) * H;
  const week = (k: number) => new Date(cur - k * 7 * 24 * H).toISOString();
  wm.history = [
    {
      resetsAt: week(2),
      impliedMaxSpendU: 1156e6,
      impliedMaxPwTokens: 578e6,
      usedPctAtSample: 100,
      source: "limit-hit",
      spread: { readings: 2, pct: 2.05, minSpendU: 1156e6, maxSpendU: 1180e6 },
    },
    {
      resetsAt: week(3),
      impliedMaxSpendU: 1130e6,
      impliedMaxPwTokens: 565e6,
      usedPctAtSample: 20,
      source: "calibration-backup",
    },
  ];
  wm.noisePct = 3;
  if (thisWeekMaxU !== undefined) {
    wm.impliedMaxSpendU = thisWeekMaxU;
    wm.impliedMaxPwTokens = thisWeekMaxU / 2;
  }
  if (wm.state === "ok" && wm.impliedMaxSpendU !== null) {
    const pct = ((wm.impliedMaxSpendU - 1156e6) / 1156e6) * 100;
    wm.vsLastWeek = { pct, clear: Math.abs(pct) > 3, resetsAt: week(2), impliedMaxSpendU: 1156e6 };
  }
  return base;
}

/**
 * OV-12 U5: model weight check. "not-ready" = the live 2026-10-04 state (3 readings, 2 weeks);
 * "ready" = an example fit (Opus 0.96×, Fable 0.72×, Haiku too little use).
 */
export function mockWeightFit(state: "not-ready" | "ready"): WeightFit {
  const ready = state === "ready";
  return {
    readings: ready ? 7 : 3,
    weeks: ready ? 4 : 2,
    variedMix: true,
    ready,
    families: [
      { family: "Opus", listWeight: [2, 2.5], multiplier: ready ? 0.96 : null, status: "fitted" },
      { family: "Sonnet", listWeight: [1, 1.5], multiplier: 1, status: "reference" },
      { family: "Fable", listWeight: [5, 5], multiplier: ready ? 0.72 : null, status: "fitted" },
      { family: "Haiku", listWeight: [0.5, 0.5], multiplier: null, status: "too-little-use" },
    ],
    spreadListPct: ready ? 4.4 : 2.1,
    spreadFittedPct: ready ? 1.9 : null,
  };
}

/** Hook config response fixture (installed or not). */
export function mockHookConfigResponse(installed: boolean): ApiResponse<HookConfigResponse> {
  return {
    data: {
      context_window: 200_000,
      soft_pct: 0.2,
      hard_pct: 0.3,
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
const UA11_LIST_CACHE_HIT = [0.74, 0.68, 0.81] as const;
const UA11_LIST_SIDECHAIN = [0.502, 0.18, 0.06] as const;

export function mockHotSessions(filter: WindowFilter = { preset: "7d" }): HotSessionRow[] {
  return selectedUa11Days(filter.preset ?? "7d")
    .flatMap(ua11DailySessions)
    .sort((a, b) => b.cost_equiv_u - a.cost_equiv_u)
    .slice(0, 3)
    .map((session, index) => ({
      session_id: session.session_id,
      workspace_id: session.workspace_id,
      title: null,
      turns: session.turn_count,
      cost_equiv_u: session.cost_equiv_u,
      total_output_tokens: session.turn_count * UA11_AVG_OUTPUT_TOKENS,
      avg_output_tokens: UA11_AVG_OUTPUT_TOKENS,
      total_context_tokens: session.turn_count * ua11SessionContextTokens(session),
      avg_context_tokens: ua11SessionContextTokens(session),
      max_context_tokens: ua11SessionContextTokens(session),
      // Row 0 is the session whose detail story shows subagents at 50% of its cost (31% + 19%).
      sum_cache_read_tokens: Math.round(
        session.turn_count *
          ua11SessionContextTokens(session) *
          (UA11_LIST_CACHE_HIT[index] ?? 0.7),
      ),
      sidechain_cost_u: Math.round(session.cost_equiv_u * (UA11_LIST_SIDECHAIN[index] ?? 0.05)),
      active_time_s: Math.round(session.turn_count * 30 * 0.55),
      wall_time_s: session.turn_count * 30,
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      last_turn_at: session.last_turn_at ?? "",
      api_error_count: 0,
      compaction_count: 0,
      interrupt_count: 0,
      interrupts_supported: false,
      user_turn_count: 0,
      tool_error_count: 0,
      test_fail_count: 0,
      gap_median_s: null,
      gap_p90_s: null,
      long_gap_count: 0,
      gap_n: 0,
    }));
}

/** Synthetic paged list used by the offline dashboard. */
export function mockHotSessionsPage(query: HotSessionsPageQuery = {}): HotSessionsPage {
  const withIssues = mockHotSessions({ preset: "30d" })
    .filter((row) => query.workspace === undefined || row.workspace_id === query.workspace)
    .filter((row) => query.model === undefined || row.models.includes(query.model))
    .filter((row) => query.q === undefined || row.session_id.startsWith(query.q))
    .map((row, index) => {
      const categories: DiagnosticCategory[] =
        index === 0 ? ["loops"] : index === 1 ? ["errors"] : [];
      return {
        ...row,
        repo_owner: null as string | null,
        repo_name: null as string | null,
        spend_percentile: [0.94, 0.61, 0.27][index] ?? null,
        spend_percentile_n: 12,
        issues: {
          top_driver:
            index === 0
              ? ({
                  detector_id: "D7" as const,
                  label: "LOOP_RETRY_WASTE",
                  session_cost_u: Math.floor(row.cost_equiv_u / 3),
                } as const)
              : null,
          categories,
        },
      };
    });
  const rows =
    query.category !== undefined && query.category.length > 0
      ? withIssues.filter((row) =>
          row.issues.categories.some((cat) =>
            (query.category as DiagnosticCategory[]).includes(cat),
          ),
        )
      : withIssues;
  const offset = Number(query.cursor ?? 0);
  const limit = query.limit ?? 50;
  return {
    rows: rows.slice(offset, offset + limit),
    next_cursor: offset + limit < rows.length ? String(offset + limit) : null,
  };
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
            tool_result_bytes: 2_100_000,
            bloat_share: 0.41,
            attributed_tool: "Bash",
            turn_count: 210,
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

/** JMS U5: a graded setup held at Operator by an unmet gate; one priced check, one unpriced. */
export function mockJudgeSetup(): JudgeSetupResponse {
  const window = { from: "2026-09-12T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" };
  return {
    grade: {
      window,
      checks: [
        {
          check_id: "long_session_share",
          category: "context_hygiene",
          severity: "important",
          result: "FAIL",
          value: 0.22,
          sample: 40,
          reason: null,
          needs: null,
        },
        {
          check_id: "verify_test_loop",
          category: "verification_practice",
          severity: "critical",
          result: "PARTIAL",
          value: 0.45,
          sample: 30,
          reason: null,
          needs: null,
        },
      ],
      categories: [
        {
          category: "context_hygiene",
          label: "Context hygiene",
          weight: 3,
          status: "scored",
          score: 62,
          scored_checks: 4,
          total_checks: 5,
        },
      ],
      coverage: 1,
      overall: 66,
      tier_by_score: "Operator",
      tier: "Operator",
      gates: [
        {
          gate_id: "G-verify",
          check_id: "verify_test_loop",
          boundary: "Conductor",
          satisfied: false,
          holding: false,
          message:
            "Edited sessions are not reliably followed by a test run (verify_test_loop: PARTIAL)",
        },
      ],
      caps: [],
      data_needed: null,
      next_tier: {
        tier: "Conductor",
        items: [
          {
            kind: "gate",
            check_id: "verify_test_loop",
            message: "Edited sessions are not reliably followed by a test run",
          },
          {
            kind: "check",
            check_id: "long_session_share",
            message: "Too many sessions run long, so stale context is re-sent on every turn",
          },
        ],
      },
    },
    delta: null,
    recorded: false,
    rubric: {
      version: "cc-docs-2026-09",
      tier_names: ["Drifter", "Practitioner", "Operator", "Conductor", "God-tier"],
      tier_floors: [0, 40, 60, 75, 90],
      min_coverage: 0.5,
      min_category_checks: 2,
      severity_weights: { critical: 3, important: 2, minor: 1 },
      categories: [{ category: "context_hygiene", label: "Context hygiene", weight: 3 }],
      gates: [
        {
          gate_id: "G-verify",
          check_id: "verify_test_loop",
          boundary: "Conductor",
          unmet: "Edited sessions are not reliably followed by a test run",
        },
      ],
      checks: [
        {
          check_id: "long_session_share",
          category: "context_hygiene",
          severity: "important",
          statement: "Start a fresh session (or run /clear) between unrelated tasks.",
          source_url: "https://code.claude.com/docs/en/costs",
          source_date: "2026-09-02",
          version_tag: "cc-docs-2026-09",
          version_date: "2026-09-02",
          stale_after_days: 365,
          scoring: { direction: "lower", pass: 0.05, partial: 0.15 },
          cap: null,
        },
        {
          check_id: "verify_test_loop",
          category: "verification_practice",
          severity: "critical",
          statement:
            "Ask Claude to run the tests after every edit, and say what a pass looks like.",
          source_url: "https://code.claude.com/docs/en/best-practices",
          source_date: "2026-09-02",
          version_tag: "cc-docs-2026-09",
          version_date: "2026-09-02",
          stale_after_days: 365,
          scoring: { direction: "higher", pass: 0.8, partial: 0.4 },
          cap: null,
        },
      ],
    },
    dollars: {
      per_check: [
        {
          check_id: "long_session_share",
          dollars_per_week: 18.4,
          detector_id: "D2",
          rec_ids: ["rec-d2-fixture"],
        },
        { check_id: "verify_test_loop", dollars_per_week: null, detector_id: null, rec_ids: [] },
      ],
      next_tier_gap: {
        tier: "Conductor",
        dollars_per_week: 18.4,
        measured_items: 1,
        total_items: 2,
        label: "measured items only",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// BM2 — Efficiency headroom fixtures
// ---------------------------------------------------------------------------

/** Individual modeled opportunities; overlap and time horizons prevent a combined ratio. */
export function mockEfficiencyHeadroom(): ApiResponse<EfficiencyHeadroom> {
  const window = windowFor("7d");
  const active = mockRecommendations().data?.active ?? [];
  const opportunities = active.flatMap((recommendation) =>
    recommendation.modeled_savings_u_per_wk === null
      ? []
      : [
          {
            rec_id: recommendation.rec_id,
            modeled_savings_u_per_wk: recommendation.modeled_savings_u_per_wk,
          },
        ],
  );
  // P3.L L6: headroom is the whole spend lane, not only claims of these open recs — it can
  // include spend already attributed to adopted/history recs. This open opportunity stays
  // unclaimed here on purpose, so the honest "not yet on the claim ledger" coverage still
  // has something real to point at.
  const headroom_u_per_wk = 930_000_000; // 30% of UA11_SCENARIO.spend_u
  const actual_u_per_wk = UA11_SCENARIO.spend_u;
  const data: EfficiencyHeadroom = {
    opportunities,
    headroom_u_per_wk,
    actual_u_per_wk,
    headroom_pct: (headroom_u_per_wk / actual_u_per_wk) * 100,
    open_rec_count: opportunities.length,
    unclaimed_rec_count: opportunities.length,
    from: window.from,
    to: window.to,
  };
  return {
    data,
    meta: {
      n: data.open_rec_count,
      window,
      qualification: {
        provisional_excluded: true,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Addressable spend: the whole spend lane on the claim ledger in this window (each token counted once, net of overlaps, so it cannot exceed actual spend) — not only claims of currently open recommendations. Recommendations without ledger claims count 0. Failure-family claims are a separate reliability lane and are not counted.",
      },
      metric_definition_version: "esf-1",
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
        note: "Workspace-history observation as of the response time, independent of the selected spend window. A later session may concern different work; no later session does not prove resolution. Pending until 48h elapses.",
      },
      metric_definition_version: "esf-1",
      drilldown_ids: { workspace_id: workspaceId },
    },
  };
}

// ---------------------------------------------------------------------------
// R4a — lifecycle cost-per-success fixture
// ---------------------------------------------------------------------------

const COST_PER_SUCCESS_NOTE =
  "Directional (OBS_PROXY): survivorship bias (heavy-spend sessions that never open a PR are invisible); reviewer-dependence (merge is a human decision, not a quality guarantee); linkage-coverage cap (only linkage_coverage_pct% of in-window sessions are linked to a PR, so unlinked spend is excluded). cost_per_merged_pr_u uses lifecycle attribution: each linked session is counted once across the merged-PR cohort, including sessions linked to multiple PRs. Full lifecycle cost is not allocated per PR. Narrowing the window changes the terminal-date PR population; linkage coverage instead uses session-start dates.";

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
    unique_linked_session_count: 10,
    shared_linked_session_count: 2,
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
      metric_definition_version: "esf-1",
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
    unclaimed_rec_count: 0,
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
        note: "Addressable spend: billed spend in this window owned by open recommendations on the claim ledger (each token counted once, so it cannot exceed actual spend). Recommendations without ledger claims count 0. Failure-family claims are a separate reliability lane and are not counted.",
      },
      metric_definition_version: "esf-1",
      claim_kind: "EXPERIMENTAL",
      drilldown_ids: {},
    },
  };
}

/**
 * GET /api/overview-view (P1-U2) composed from the legacy fixtures above, the way the daemon
 * composes the same query functions: each section's `data` is the legacy envelope's `.data`
 * (`status` is the raw body; `weekly_sessions` and `top_recs` are composed).
 */
export function mockOverviewView(preset: "24h" | "7d" | "30d" = "7d"): OverviewViewResponse {
  const ok = (data: unknown): OverviewSection => ({ status: "ok", data, ms: 1 });
  const trends = mockTrends({ preset });
  const { from, to } = trends.meta.window;
  const prior = mockTrends({
    from: new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from))).toISOString(),
    to: from,
  });
  const recs = mockRecommendations().data;
  return {
    data_version: 1,
    consistent: true,
    window: windowFor(preset),
    sections: {
      kpis: ok(mockGlobalOverview({ preset }).data),
      workspaces: ok(mockWorkspaces({ preset }).data),
      trends: ok(trends.data),
      trends_prior: ok(prior.data),
      flavor: ok(mockFlavorDecomposition({ preset }).data),
      cache_write: ok(mockCacheWriteTrend({ preset }).data),
      weekly_sessions: ok({
        rows: mockHotSessions({ preset: "7d" }).slice(0, 5),
        cost_equiv_u: mockGlobalOverview({ preset: "7d" }).data?.cost_equiv_u ?? 0,
      }),
      live: ok(mockLiveSessions().data),
      status: ok(mockStatus()),
      top_recs: ok({
        active: recs?.active ?? [],
        adopted: recs?.adopted ?? [],
        ...(recs?.active_groups === undefined ? {} : { active_groups: recs.active_groups }),
      }),
      linkage: ok(mockLinkageRate().data),
      hook_config: ok(mockHookConfigResponse(false).data),
    },
  };
}

/** GET /api/workspaces/:id/delivery: invented commit-session figures for the workspace detail page. */
export function mockWorkspaceDelivery(
  workspaceId: string,
  filter: WindowFilter,
): ApiResponse<DeliveryMetrics> {
  const window = windowFor(filter.preset ?? "7d");
  const total = 22;
  const commits = 14;
  const noCommit = 5;
  const data: DeliveryMetrics = {
    commit_session_count: commits,
    total_session_count: total,
    commit_session_rate: commits / total,
    spend_per_commit_session_u: 2_350_000,
    abandoned_spend_u: 6_200_000,
    abandoned_spend_share: 0.11,
    no_commit_activity_session_count: noCommit,
    no_commit_activity_spend_u: 6_200_000,
    no_commit_activity_spend_share: 0.11,
    live_session_excluded_from_no_commit_activity_count: 0,
    from: window.from,
    to: window.to,
    workspace_id: workspaceId,
  };
  return {
    data,
    meta: {
      ...baseMeta(window, total),
      claim_kind: "OBS_PROXY",
      qualification: {
        provisional_excluded: true,
        unpriced_turns: 0,
        claim_kinds_count: 1,
        note: "Delivery is inferred from observed git commits; sessions without commit tracking count as no commit.",
      },
    },
  };
}

/** GET /api/diagnostics: a ready Usage patterns snapshot with invented causes and sessions. */
export function mockDiagnostics(windowDays: 7 | 14 | 30 = 7): ApiResponse<DiagnosticsPayload> {
  const window = windowFor("7d");
  const sess = (n: number, title: string | null, occurrences: number) => ({
    session_id: `ua11-ses-demo-${n}`,
    title,
    occurrences,
  });
  const base = {
    trend_basis: "spend_share" as const,
    handoff: null,
    patterns: [],
    sessions_affected_is_lower_bound: false,
    count_unit: "occurrences",
  };
  const avoidable = (
    row: Pick<
      AvoidableRow,
      "cause_id" | "name" | "explanation" | "rank" | "trend" | "share" | "avoidable_u"
    > &
      Pick<AvoidableRow, "occurrences" | "sessions_affected" | "sessions"> &
      Partial<AvoidableRow>,
  ): AvoidableRow => ({
    ...base,
    featured: false,
    coverage: "ALL",
    folded: false,
    when: { buckets: [1, 2, 3, 3, 4, 5], weight: "occurrences", heaviest: "late" },
    example: null,
    ...row,
  });
  const reliab = (
    row: Pick<
      ReliabilityRow,
      "cause_id" | "name" | "explanation" | "rank" | "trend" | "share" | "occurrences"
    > &
      Pick<ReliabilityRow, "count_unit" | "sessions_affected" | "sessions"> &
      Partial<ReliabilityRow>,
  ): ReliabilityRow => ({
    ...base,
    trend_basis: "session_rate",
    featured: false,
    breakdown: [],
    top_commands: [],
    cost: { wait_ms: null, replan_u: null },
    ...row,
  });
  const data: DiagnosticsPayload = {
    window_days: windowDays,
    as_of: window.to,
    built_at: window.to,
    partial: false,
    tiles: {
      spend_u: 2_450_000_000,
      session_count: 36,
      avoidable_u: 18_400_000,
      avoidable_share: 0.0075,
      friction_sessions: 5,
      friction_share: 0.14,
      fix_ready: { n: 2, m: 3 },
    },
    avoidable: {
      banner: null,
      causes: [
        avoidable({
          cause_id: "A",
          name: "Long sessions carry stale context",
          explanation:
            "Context keeps growing before it is cleared, so every turn re-sends old material.",
          rank: 1,
          featured: true,
          trend: "rising",
          share: 0.0045,
          avoidable_u: 11_000_000,
          occurrences: 14,
          sessions_affected: 5,
          sessions: [sess(1, "Add a story view to the session page", 9), sess(2, null, 5)],
          handoff: { rec_id: "rec-D1-ws-1-mock000000000000", label: "Fix: clear between tasks" },
        }),
        avoidable({
          cause_id: "B",
          name: "The cache is rebuilt mid-session",
          explanation: "Idle gaps let the cache expire, so the same context is written again.",
          rank: 2,
          trend: "steady",
          share: 0.003,
          avoidable_u: 7_400_000,
          occurrences: 8,
          sessions_affected: 3,
          sessions: [sess(3, "Refactor the billing export", 5), sess(4, null, 3)],
        }),
      ],
      silent: [],
    },
    reliability: {
      causes: [
        reliab({
          cause_id: "LOOP_RETRY",
          name: "The agent repeats the same error",
          explanation: "The same failing step is retried several times in a row.",
          rank: 1,
          featured: true,
          trend: "steady",
          share: 0.09,
          occurrences: 11,
          count_unit: "loops",
          sessions_affected: 3,
          sessions: [
            sess(1, "Add a story view to the session page", 6),
            sess(3, "Refactor the billing export", 5),
          ],
        }),
        reliab({
          cause_id: "SHELL_BURST",
          name: "Shell commands fail in bursts",
          explanation: "Several commands fail one after another in the same stretch.",
          rank: 2,
          trend: "falling",
          share: 0.05,
          occurrences: 6,
          count_unit: "bursts",
          sessions_affected: 2,
          sessions: [sess(2, null, 4), sess(4, null, 2)],
        }),
      ],
      risk: null,
      silent: [],
    },
  };
  return {
    data,
    meta: {
      ...baseMeta(window, 0),
      claim_kind: "OBS_PROXY",
      window: { ...window, from: "2026-08-17T00:00:00.000Z" },
    },
  };
}
