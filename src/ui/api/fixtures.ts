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

/**
 * The shared, deliberately small UA11 demo scenario.  Keep all selected-window
 * spend surfaces derived from these values: the Overview total, workspace rows,
 * and trend buckets must describe the same observation.
 */
export const UA11_SCENARIO = {
  window: { from: "2026-08-16T00:00:00.000Z", to: "2026-08-23T00:00:00.000Z", preset: "7d" },
  spend_u: 7_790_000,
  workspace_spend_u: [2_600_000, 1_750_000, 1_200_000, 950_000, 1_290_000],
  trend_spend_u: [1_200_000, 980_000, 2_100_000, 750_000, 1_560_000, 880_000, 320_000],
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
  bucket: new Date(Date.UTC(2026, 6, 24 + index)).toISOString().slice(0, 10),
  cost_equiv_u: 100_000,
  turns: 10,
}));
const UA11_DAILY_OBSERVATIONS: readonly Ua11DailyObservation[] = [
  ...UA11_OLDER_DAILY_SPEND,
  ...UA11_SCENARIO.trend_spend_u.map((cost_equiv_u, index) => ({
    bucket: new Date(Date.UTC(2026, 7, 16 + index)).toISOString().slice(0, 10),
    cost_equiv_u,
    turns: [45, 38, 72, 28, 59, 33, 12][index] ?? 0,
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
  2_600 / 7_790,
  1_750 / 7_790,
  1_200 / 7_790,
  950 / 7_790,
  1_290 / 7_790,
] as const;
const UA11_WORKSPACE_TURN_WEIGHTS = [0.35, 0.23, 0.18, 0.14, 0.1] as const;
// Price order matches the production Overview contract; Trends uses the same split.
const UA11_MODELS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;
const UA11_MODEL_WEIGHTS = [0.1, 0.5, 0.3, 0.1] as const;

/** Preserve the stated seven-day workspace totals while keeping every day additive. */
function ua11WorkspaceSpendSplit(day: Ua11DailyObservation): number[] {
  const scenarioDay = Number(day.bucket.slice(-2)) - 16;
  if (day.bucket < "2026-08-16" || scenarioDay < 0 || scenarioDay > 6) {
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
      const values = splitWhole(day[field], UA11_MODEL_WEIGHTS);
      return totals.map((total, index) => total + (values[index] ?? 0));
    },
    UA11_MODELS.map(() => 0),
  );
}

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
  const days = selectedUa11Days(preset);
  const totalSpend = selectedUa11Spend(preset);
  const totalTurns = days.reduce((sum, day) => sum + day.turns, 0);

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
    avg_context_per_turn: [278_000, 238_000, 248_000, 61_000][index] ?? 0,
    avg_output_per_turn: [620, 1146, 890, 940][index] ?? 0,
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
      avg_context_per_turn: 238_000,
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
      avg_context_per_turn: 180_000,
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
      avg_context_per_turn: 120_000,
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
      avg_context_per_turn: 95_000,
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
      avg_context_per_turn: 210_000,
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

  // Source-backed D1 gives the browser workflow a concrete, workspace-scoped
  // change to copy, attest, and track. Its projection remains separate from
  // the observed measurement that appears after tracking.
  const d1Card: RecommendationCard = {
    rec_id: "rec-D1-ws-1-mock000000000000",
    detector_id: "D1",
    category: "CONTEXT",
    scope_workspace_id: "ws-1",
    lever: "Trim stale instructions from this workspace's CLAUDE.md.",
    modeled_savings_u_per_wk: 2_600_000,
    run_cost_u: null,
    modeled_formula: {
      model: "D1_CONTEXT_FILE_REDUCTION_V1",
      inputs: { tokens_removed: 40_000, sessions_per_week: 4 },
      expression: "tokens_removed * sessions_per_week",
      kind: "MODELED",
    },
    evidence: {
      component: "CLAUDE_MD",
      file_ref: "CLAUDE.md",
      title: "Trim stale CLAUDE.md instructions",
      source_tokens: 80_000,
      delta_context_tokens: 40_000,
    },
    target_metric: "CONTEXT_TOKENS:CLAUDE_MD:CLAUDE.md",
    state: "PROPOSED",
    created_at: window.to,
    dismissed_until: null,
    headroom: { tokens_per_wk_freed: 160_000, tokens_per_session_freed: 40_000 },
    sessions_per_week: 4,
    steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 } satisfies BoundedStep],
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
    // D2 is directional: its cache-read exposure cannot establish avoidable USD.
    modeled_savings_u_per_wk: null,
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
    active: [d2Card, d1Card],
    active_groups: [
      {
        detector_id: "D2",
        label: "Session hygiene",
        recs: [d2Card],
        session_count: 4,
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
  const modelWeights = UA11_MODEL_WEIGHTS;
  const models = UA11_MODELS;
  const data: TrendData = {
    bucket: "day",
    buckets: [...days],
    by_model: days.flatMap((day) => {
      const spend = splitWhole(day.cost_equiv_u, modelWeights);
      const turns = splitWhole(day.turns, modelWeights);
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
  return UA11_WORKSPACE_IDENTITIES.map((workspace, index) => ({
    ...ua11SessionSummary(
      `ua11-session-${day.bucket}-${workspace.workspace_id}`,
      workspace.workspace_id,
    ),
    cost_equiv_u: spend[index] ?? 0,
    turn_count: turns[index] ?? 0,
    first_turn_at: `${day.bucket}T10:00:00.000Z`,
    last_turn_at: new Date(
      Date.parse(`${day.bucket}T10:00:00.000Z`) + Math.max(0, (turns[index] ?? 0) - 1) * 180_000,
    ).toISOString(),
    state: "RECONCILED",
  }));
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
      turns: 45,
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
    first_turn_at: "2026-08-16T10:00:00Z",
    last_turn_at: "2026-08-16T10:03:00Z",
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
      drilldown_ids: { session_id: sessionId, workspace_id: data.workspace_id },
    },
  };
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
    data: { items, next_cursor: null },
    meta: baseMeta(windowFor(preset), items.length),
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
      ts: new Date(Date.parse(session.first_turn_at ?? "") + index * 180_000).toISOString(),
      cost_equiv_u: costs[index] ?? 0,
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
export function mockHotSessions(filter: WindowFilter = { preset: "7d" }): HotSessionRow[] {
  return selectedUa11Days(filter.preset ?? "7d")
    .flatMap(ua11DailySessions)
    .sort((a, b) => b.cost_equiv_u - a.cost_equiv_u)
    .slice(0, 3)
    .map((session) => ({
      session_id: session.session_id,
      workspace_id: session.workspace_id,
      turns: session.turn_count,
      cost_equiv_u: session.cost_equiv_u,
      total_output_tokens: session.turn_count * 400,
      avg_output_tokens: 400,
      total_context_tokens: session.turn_count * 2200,
      avg_context_tokens: 2200,
      model: "claude-sonnet-5",
      last_turn_at: session.last_turn_at ?? "",
      api_error_count: 0,
      compaction_count: 0,
      interrupt_count: 0,
      user_turn_count: 0,
      tool_error_count: 0,
      test_fail_count: 0,
      gap_median_s: null,
      gap_p90_s: null,
      long_gap_count: 0,
      gap_n: 0,
    }));
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
