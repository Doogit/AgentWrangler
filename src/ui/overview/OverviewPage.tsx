/**
 * src/ui/overview/OverviewPage.tsx — Global Overview surface.
 *
 * Fetches three independent data sources and manages their load states.
 * Three distinct UI states per section (never conflated):
 *   1. loading   → skeleton (aria-busy, pulsing animation)
 *   2. error     → error banner (role="alert", daemon-unreachable messaging)
 *   3. ok/empty  → real data or explicit N/A — never blank, never silent
 *
 * Date presets: 24h / 7d (default) / 30d — shared filter for overview + workspaces.
 * Live strip refreshes independently every 30 s.
 *
 * Claim chip mapping (from frozen contract):
 *   cost_equiv_u  → LIST_EQUIV (teal)
 *   forecast      → PROXY (red/salmon)  — visually distinct from LIST_EQUIV
 *   context/turn  → OBS_PROXY (cyan)    — visually distinct from LIST_EQUIV
 */

import { useCallback, useEffect, useState } from "react";
import type { BurnStatus } from "../../query/api/burn-status";
import type { HookConfigResponse } from "../../query/api/hook-config";
import type {
  GlobalOverview,
  LiveSessionRow,
  ModelMixRow,
  PagedList,
  WindowFilter,
  WorkspaceSummary,
} from "../../query/api/overview";
import type { RecommendationCard } from "../../query/api/recommendations";
import type {
  CacheEfficiency,
  FlavorDecomposition as FlavorDecompositionData,
} from "../../query/api/spend-flavor";
import type { CacheWriteTrend, TrendData } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import type { ForecastFromDbResult } from "../../query/forecast";
import type { HotSessionRow } from "../../query/spend";
import {
  fetchBurnStatus,
  fetchCacheWriteTrend,
  fetchFlavorDecomposition,
  fetchGithubTokenStatus,
  fetchGlobalOverview,
  fetchHookConfig,
  fetchHotSessions,
  fetchLiveSessions,
  fetchRecommendations,
  fetchStatus,
  fetchTrends,
  fetchWorkspaces,
  getCachedResponse,
  getLastFetchTimestamp,
} from "../api/client";
import type { DaemonStatus } from "../api/client";
import Chip from "../shell/Chip";
import ChipLegend from "../shell/ChipLegend";
import { SkeletonKpi, SkeletonRow } from "../shell/Skeleton";
import BurnForecastCard from "./BurnForecastCard";
import CacheEfficiencyKPI from "./CacheEfficiencyKPI";
import CacheWriteSpikesChart from "./CacheWriteSpikesChart";
import FlavorDecomposition from "./FlavorDecomposition";
import HookTile from "./HookTile";
import LiveStrip from "./LiveStrip";
import RateLimitGauges from "./RateLimitGauges";
import TrendChart from "./TrendChart";
import VerdictBand, { DeltaBadge, TrendSparkline, windowDelta } from "./VerdictBand";
import WorkspaceTable, { type TopRec } from "./WorkspaceTable";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Preset = "24h" | "7d" | "30d";

const CAVEAT_COPY =
  "ℹ List-price equivalents only — Max/Team plans are NOT billed this way. Tokens drive rate limits. Check /usage or the status-line 5h/7d % for your real budget signal.";

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: T };

type OnboardingStatusState =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "ok"; value: DaemonStatus };

const SKELETON_DELAY_MS = 300;

function cachedLoadState<T>(endpoint: string, params?: unknown): LoadState<T> {
  const cached = getCachedResponse<T>(endpoint, params);
  return cached === undefined ? { status: "loading" } : { status: "ok", value: cached };
}

function retainDataWhileRefreshing<T>(
  setState: React.Dispatch<React.SetStateAction<LoadState<T>>>,
): void {
  setState((current) => (current.status === "ok" ? current : { status: "loading" }));
}

function FirstRunWelcome({
  status,
  hasRecommendation,
  limitCalibrated,
  tokenConfigured,
  hookInstalled,
}: {
  status: DaemonStatus;
  hasRecommendation: boolean;
  limitCalibrated: boolean;
  tokenConfigured: boolean;
  hookInstalled: boolean;
}) {
  const sessionIngested = status.sessions > 0;
  const steps = [
    { label: "Daemon running", complete: true },
    { label: "First session ingested", complete: sessionIngested },
    { label: "First recommendation generated", complete: hasRecommendation },
  ];
  const completeCount = steps.filter((step) => step.complete).length;

  // Activation items surface only while their feature is inactive. Each carries
  // one specific sentence and a deep link to the Settings panel that turns it on.
  const activationItems = [
    {
      key: "calibrate",
      show: !limitCalibrated,
      text: "Calibrate your weekly limit from usage so burn forecasts have a real ceiling to project against.",
      href: "#/settings",
      cta: "Calibrate in Settings →",
      testid: "first-run-calibrate",
    },
    {
      key: "token",
      show: !tokenConfigured,
      text: "Set AW_GITHUB_TOKEN so outcomes sync can tell finished work from abandoned and feed the Success metric.",
      href: "#/settings",
      cta: "Configure token in Settings →",
      testid: "first-run-token",
    },
    {
      key: "hook",
      show: !hookInstalled,
      text: "Install the context-budget hook to get warned in-session before a costly auto-compact.",
      href: "#/settings",
      cta: "Install in Settings →",
      testid: "first-run-hook",
    },
  ].filter((item) => item.show);

  return (
    <section className="settings-onboarding-card" aria-labelledby="first-run-welcome-title">
      <h2 id="first-run-welcome-title">Welcome to AgentWrangler</h2>
      <p>Turn local Claude Code activity into clear, actionable guidance.</p>
      <p aria-label={`${completeCount} of 3 onboarding steps complete`}>{completeCount} of 3</p>
      <ol>
        {steps.map((step) => (
          <li key={step.label}>
            <label>
              <input type="checkbox" checked={step.complete} readOnly /> {step.label}
            </label>
            {step.label === "First session ingested" && !sessionIngested && (
              <p className="first-run-step-hint" data-testid="first-run-ingest-hint">
                Run any <code>claude</code> session — the daemon tails its transcript live.
              </p>
            )}
          </li>
        ))}
      </ol>
      <p>
        ingesting… {status.files_parsed} of {status.files_seen} files
      </p>
      {activationItems.length > 0 && (
        <div className="first-run-activation" data-testid="first-run-activation">
          <h3 className="first-run-activation-title">Activate the rest</h3>
          <ul>
            {activationItems.map((item) => (
              <li key={item.key} data-testid={item.testid}>
                <span>{item.text}</span> <a href={item.href}>{item.cta}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="first-run-glossary-link">
        New to these numbers?{" "}
        <a href="#/glossary" data-testid="first-run-glossary-link">
          How to read this dashboard →
        </a>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtUsd(u: number): string {
  const usd = u / 1_000_000;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtModel(m: string): string {
  // "claude-opus-5" → "Opus 5", "claude-sonnet-5" → "Sonnet 5"
  const stripped = m.replace("claude-", "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function fmtTokensCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// Sub-sections (inlined, tightly coupled to GlobalOverview shape)
// ---------------------------------------------------------------------------

function SpendCard({
  overview,
  preset,
  trends,
  priorTrends,
}: {
  overview: GlobalOverview;
  preset: Preset;
  trends: TrendData | null;
  priorTrends: TrendData | null;
}) {
  const currentCost =
    trends?.buckets.reduce((total, bucket) => total + bucket.cost_equiv_u, 0) ?? null;
  const priorCost =
    priorTrends?.buckets.reduce((total, bucket) => total + bucket.cost_equiv_u, 0) ?? null;
  return (
    <div className="kpi kpi-secondary card">
      <div className="kpi-label-row">
        <div className="kpi-label">{preset.toUpperCase()} SPEND-EQUIV</div>
        <DeltaBadge delta={windowDelta(currentCost, priorCost)} />
      </div>
      <div className="kpi-value">{fmtUsd(overview.cost_equiv_u)}</div>
      <TrendSparkline
        values={trends?.buckets.map((bucket) => bucket.cost_equiv_u) ?? []}
        label={`${preset} spend trend`}
      />
      <div className="kpi-subval">
        {overview.turns.toLocaleString()} in-window turns · {overview.turns_total.toLocaleString()}{" "}
        total
      </div>
      {overview.unpriced_turns > 0 && (
        <div className="kpi-subval" style={{ color: "var(--amber)" }}>
          ⚠ {overview.unpriced_turns} unpriced turns
        </div>
      )}
      <div className="chips">
        <Chip kind="LIST_EQUIV" />
      </div>
    </div>
  );
}

function ModelMixFootnote({ rows }: { rows: ModelMixRow[] }) {
  const total = rows.reduce((s, r) => s + r.turns, 0);
  if (total === 0 || rows.length === 0) return null;
  return (
    <p className="kpi-fn" style={{ marginTop: 4 }}>
      Model mix:{" "}
      {rows.map((r) => `${fmtModel(r.model)} ${((r.turns / total) * 100).toFixed(1)}%`).join(" · ")}{" "}
      · <Chip kind="EXACT" label="EXACT" />
    </p>
  );
}

function ContextPerTurnSection({ rows }: { rows: GlobalOverview["context_per_turn"] }) {
  return (
    <div
      className="card"
      data-testid="context-per-turn-section"
      style={{ padding: "16px 18px", marginBottom: 13 }}
    >
      <div className="section-head">
        <h2>Context / Turn</h2>
        <div className="chips">
          <Chip kind="OBS_PROXY" />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="banner banner-info">
          <span>No context-per-turn data in this window.</span>
        </div>
      ) : (
        <>
          <div
            data-testid="context-per-turn-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 14,
            }}
          >
            {rows.slice(0, 3).map((row, index) => {
              const model = fmtModel(row.model);
              const ratio =
                row.avg_context_per_turn > 0
                  ? (row.avg_output_per_turn / row.avg_context_per_turn) * 100
                  : 0;
              const fill = Math.max(0, Math.min(ratio, 100));

              return (
                <div
                  key={row.model}
                  data-testid="context-per-turn-cell"
                  style={{
                    background: "var(--panel2)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    padding: "12px 14px",
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      color: "var(--soft)",
                      fontSize: 12,
                      fontWeight: 600,
                      marginBottom: 6,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: ["var(--teal)", "var(--amber)", "var(--purple)"][index],
                        marginRight: 6,
                      }}
                    />
                    {model}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em" }}>
                    {fmtTokensCompact(row.avg_context_per_turn)}
                    <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 4 }}>ctx</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--soft)", margin: "2px 0 8px" }}>
                    {fmtTokensCompact(row.avg_output_per_turn)} out
                  </div>
                  <div
                    role="progressbar"
                    tabIndex={0}
                    aria-label={`Output is ${ratio.toFixed(1)}% of context for ${model}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={fill}
                    style={{
                      height: 10,
                      borderRadius: 5,
                      background: "rgba(132,146,166,.18)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      aria-hidden="true"
                      style={{
                        width: `${fill}%`,
                        minWidth: fill > 0 ? 3 : 0,
                        height: "100%",
                        background: ["var(--teal)", "var(--amber)", "var(--purple)"][index],
                        borderRadius: "5px 0 0 5px",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 5 }}>
                    output = {ratio.toFixed(1)}% of context
                  </div>
                  <div className="chips" style={{ marginTop: 6 }}>
                    <Chip kind="OBS_PROXY" />
                  </div>
                </div>
              );
            })}
          </div>
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 12.5,
              color: "var(--soft)",
              borderLeft: "3px solid var(--teal)",
              paddingLeft: 10,
            }}
          >
            Context : Output ratio — if output is a small fraction of context, you're paying mostly
            to re-read history, not to generate. Consider more frequent /clear.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function OverviewPage({
  onSelectSession,
}: { onSelectSession?: (sessionId: string) => void }) {
  const [isCaveatVisible, setIsCaveatVisible] = useState(() => {
    try {
      return (
        typeof window === "undefined" || window.localStorage.getItem("aw-caveat-dismissed") !== "1"
      );
    } catch {
      return true;
    }
  });
  const [preset, setPreset] = useState<Preset>("7d");
  // Keep the range that produced each response alongside the response. A
  // preset change can occur before the first request resolves; the prior
  // range must not briefly render as the newly selected range.
  const [overviewDataPreset, setOverviewDataPreset] = useState<Preset>(preset);
  const [workspacesDataPreset, setWorkspacesDataPreset] = useState<Preset>(preset);
  const [overviewState, setOverviewState] = useState<LoadState<ApiResponse<GlobalOverview>>>(() =>
    cachedLoadState("/api/overview", { preset: overviewDataPreset }),
  );
  const [workspacesState, setWorkspacesState] = useState<
    LoadState<ApiResponse<PagedList<WorkspaceSummary>>>
  >(() => cachedLoadState("/api/workspaces", { preset: workspacesDataPreset }));
  const [liveState, setLiveState] = useState<LoadState<ApiResponse<PagedList<LiveSessionRow>>>>(
    () => cachedLoadState("/api/live"),
  );
  const [statusState, setStatusState] = useState<OnboardingStatusState>({ status: "pending" });
  const [showInitialSkeletons, setShowInitialSkeletons] = useState(false);
  const [liveLastFetchedAt, setLiveLastFetchedAt] = useState(() =>
    getLastFetchTimestamp("/api/live"),
  );
  // Burn status — live 5h/7d utilization (non-fatal on failure, non-blocking)
  const [burnStatus, setBurnStatus] = useState<BurnStatus | null>(null);
  const [burnStatusLoading, setBurnStatusLoading] = useState(true);
  // Hook config — installed state (non-fatal on failure)
  const [hookConfig, setHookConfig] = useState<HookConfigResponse | null>(null);
  const [hookConfigLoading, setHookConfigLoading] = useState(true);
  // GitHub token status — outcomes-sync activation signal (non-fatal on failure)
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  // Hot sessions top-3 (non-fatal on failure)
  const [hotSessions, setHotSessions] = useState<HotSessionRow[]>([]);
  const [hotSessionsLoading, setHotSessionsLoading] = useState(true);
  // Top waste source per workspace (additive; feeds WorkspaceTable's rec column).
  // Failure is non-fatal — the column falls back to "—".
  const [topRecByWorkspace, setTopRecByWorkspace] = useState<Map<string, TopRec>>(new Map());
  // Spend-over-time trends (additive; non-fatal on failure)
  const [trendsState, setTrendsState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; value: ApiResponse<TrendData> }
  >({ status: "loading" });
  const [priorTrendsState, setPriorTrendsState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; value: ApiResponse<TrendData> }
  >({ status: "loading" });
  const [topRecommendation, setTopRecommendation] = useState<RecommendationCard | null>(null);
  const [hasRecommendation, setHasRecommendation] = useState(false);
  // Spend-Viz-v2 — separate LoadState per surface, all non-fatal
  const [flavorState, setFlavorState] = useState<LoadState<ApiResponse<FlavorDecompositionData>>>({
    status: "loading",
  });
  const [cacheEffState, setCacheEffState] = useState<LoadState<ApiResponse<CacheEfficiency>>>({
    status: "loading",
  });
  const [cacheWriteState, setCacheWriteState] = useState<LoadState<ApiResponse<CacheWriteTrend>>>({
    status: "loading",
  });

  useEffect(() => {
    const id = window.setTimeout(() => setShowInitialSkeletons(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  // Fetch overview + workspaces when preset changes
  const loadMain = useCallback((p: Preset) => {
    const filter: WindowFilter = { preset: p };
    retainDataWhileRefreshing(setOverviewState);
    retainDataWhileRefreshing(setWorkspacesState);

    fetchGlobalOverview(filter)
      .then((v) => {
        setOverviewState({ status: "ok", value: v });
        setOverviewDataPreset(p);
      })
      .catch((e: unknown) => {
        setOverviewState({ status: "error", message: String(e) });
        setOverviewDataPreset(p);
      });

    fetchWorkspaces(filter)
      .then((v) => {
        setWorkspacesState({ status: "ok", value: v });
        setWorkspacesDataPreset(p);
      })
      .catch((e: unknown) => {
        setWorkspacesState({ status: "error", message: String(e) });
        setWorkspacesDataPreset(p);
      });

    // Spend-over-time trends (non-fatal)
    retainDataWhileRefreshing(setTrendsState);
    retainDataWhileRefreshing(setPriorTrendsState);
    fetchTrends(filter)
      .then((v) => {
        setTrendsState({ status: "ok", value: v });
        const { from, to } = v.meta.window;
        const duration = Date.parse(to) - Date.parse(from);
        return fetchTrends({
          from: new Date(Date.parse(from) - duration).toISOString(),
          to: from,
        })
          .then((prior) => setPriorTrendsState({ status: "ok", value: prior }))
          .catch((e: unknown) => setPriorTrendsState({ status: "error", message: String(e) }));
      })
      .catch((e: unknown) => {
        setTrendsState({ status: "error", message: String(e) });
        setPriorTrendsState({ status: "error", message: String(e) });
      });

    // Spend-Viz-v2 — flavor decomposition (also derives cacheEffState)
    retainDataWhileRefreshing(setFlavorState);
    retainDataWhileRefreshing(setCacheEffState);
    fetchFlavorDecomposition(filter)
      .then((v) => {
        setFlavorState({ status: "ok", value: v });
        // Reuse the query-provided selected-window diagnostic (no browser classifier).
        const fd = v.data;
        if (fd !== null) {
          const effData: CacheEfficiency = {
            ratio: fd.cache_read_share,
            cache_read_tokens: fd.cache_read_tokens,
            cache_creation_tokens: fd.cache_creation_tokens,
            reuse_band: fd.reuse_band,
            cap_weighted_tokens: fd.cap_weighted_tokens,
            coeff_used: fd.coeff_used,
            coeff_unverified: fd.coeff_unverified,
            turns: fd.turns,
          };
          setCacheEffState({
            status: "ok",
            value: { ...v, data: effData },
          });
        } else {
          setCacheEffState({ status: "ok", value: { ...v, data: null } });
        }
      })
      .catch((e: unknown) => {
        setFlavorState({ status: "error", message: String(e) });
        setCacheEffState({ status: "error", message: String(e) });
      });

    // Spend-Viz-v2 — cache-write spike timeline (non-fatal)
    retainDataWhileRefreshing(setCacheWriteState);
    fetchCacheWriteTrend(filter)
      .then((v) => setCacheWriteState({ status: "ok", value: v }))
      .catch((e: unknown) => setCacheWriteState({ status: "error", message: String(e) }));

    // Top-rec column: highest-modeled active rec per workspace. Non-fatal.
    fetchRecommendations()
      .then((v) => {
        const active = v.data?.active ?? [];
        const d = v.data;
        setHasRecommendation(
          d != null &&
            d.active.length + d.limit_warnings.length + d.adopted.length + d.dismissed.length > 0,
        );
        setTopRecommendation(
          active.reduce<RecommendationCard | null>(
            (top, rec) =>
              top === null ||
              (rec.modeled_savings_u_per_wk ?? -1) > (top.modeled_savings_u_per_wk ?? -1)
                ? rec
                : top,
            null,
          ),
        );
        const map = new Map<string, TopRec>();
        for (const rec of active) {
          if (rec.scope_workspace_id === null) continue;
          const existing = map.get(rec.scope_workspace_id);
          const savings = rec.modeled_savings_u_per_wk ?? -1;
          if (existing === undefined || savings > (existing.savings ?? -1)) {
            map.set(rec.scope_workspace_id, {
              detector_id: rec.detector_id,
              state: rec.state,
              savings,
            });
          }
        }
        setTopRecByWorkspace(map);
      })
      .catch(() => {
        setTopRecByWorkspace(new Map());
        setTopRecommendation(null);
        setHasRecommendation(false);
      });
  }, []);

  useEffect(() => {
    loadMain(preset);
  }, [preset, loadMain]);

  // Onboarding is resolved once per page mount. It must settle before the
  // normal KPI branch can render, so first-run users never see it flash.
  useEffect(() => {
    let cancelled = false;

    void Promise.resolve(fetchStatus())
      .then((value) => {
        if (cancelled) return;
        if (value === undefined) {
          setStatusState({ status: "error", message: "Status response was empty" });
          return;
        }
        setStatusState({ status: "ok", value });
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatusState({ status: "error", message: String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Live strip — independent 30 s refresh cadence
  useEffect(() => {
    const doFetch = () => {
      fetchLiveSessions()
        .then((v) => {
          setLiveState({ status: "ok", value: v });
          setLiveLastFetchedAt(getLastFetchTimestamp("/api/live"));
        })
        .catch((e: unknown) => setLiveState({ status: "error", message: String(e) }));
    };
    doFetch();
    const id = setInterval(doFetch, 30_000);
    return () => clearInterval(id);
  }, []);

  // Burn status, hook config, hot sessions — fetch once on mount (non-fatal each)
  useEffect(() => {
    fetchBurnStatus()
      .then((v) => setBurnStatus(v.data))
      .catch(() => setBurnStatus(null))
      .finally(() => setBurnStatusLoading(false));

    fetchHookConfig()
      .then((v) => setHookConfig(v.data))
      .catch(() => setHookConfig(null))
      .finally(() => setHookConfigLoading(false));

    fetchHotSessions()
      .then((rows) => setHotSessions(rows.slice(0, 3)))
      .catch(() => setHotSessions([]))
      .finally(() => setHotSessionsLoading(false));

    void Promise.resolve(fetchGithubTokenStatus())
      .then((s) => setGithubTokenConfigured(s?.configured ?? false))
      .catch(() => setGithubTokenConfigured(false));
  }, []);

  const handleRetry = () => loadMain(preset);

  const dismissCaveat = () => {
    try {
      window.localStorage.setItem("aw-caveat-dismissed", "1");
    } catch {
      // Continue hiding the banner when storage is unavailable.
    }
    setIsCaveatVisible(false);
  };

  // ---------------------------------------------------------------------------
  // Derived values from OK states
  // ---------------------------------------------------------------------------

  const hasOverviewForPreset = overviewDataPreset === preset;
  const hasWorkspacesForPreset = workspacesDataPreset === preset;
  const overviewData =
    hasOverviewForPreset && overviewState.status === "ok" ? overviewState.value.data : null;
  const trendData = trendsState.status === "ok" ? trendsState.value.data : null;
  const priorTrendData = priorTrendsState.status === "ok" ? priorTrendsState.value.data : null;

  const workspaceItems =
    hasWorkspacesForPreset && workspacesState.status === "ok"
      ? (workspacesState.value.data?.items ?? [])
      : [];

  const liveSessions = liveState.status === "ok" ? (liveState.value.data?.items ?? []) : [];
  const onboardingStatus = statusState.status === "ok" ? statusState.value : null;
  const isOnboardingStatusPending = statusState.status === "pending";
  const isFirstRun = onboardingStatus?.sessions === 0;

  const isOverviewPending = overviewState.status === "loading" || !hasOverviewForPreset;
  const isWorkspacesPending = workspacesState.status === "loading" || !hasWorkspacesForPreset;
  const isLivePending = liveState.status === "loading";
  const isOverviewLoading = isOverviewPending && showInitialSkeletons;
  const isWorkspacesLoading = isWorkspacesPending && showInitialSkeletons;
  const isLiveLoading = isLivePending && showInitialSkeletons;

  const overviewError =
    hasOverviewForPreset && overviewState.status === "error" ? overviewState.message : null;
  const workspacesError =
    hasWorkspacesForPreset && workspacesState.status === "error" ? workspacesState.message : null;
  const liveError = liveState.status === "error" ? liveState.message : null;

  // Aggregate error for the top-level daemon-unreachable banner
  const daemonError = overviewError ?? workspacesError;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Page header */}
      <div className="page-top">
        <div className="page-title">
          <h1>Overview</h1>
          <p className="page-sub">Where your tokens go · burn forecast · live sessions</p>
        </div>
        <div className="page-top-controls">
          <div className="date-range" aria-label="Date range">
            {(["24h", "7d", "30d"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`date-preset-btn${preset === p ? " active" : ""}`}
                onClick={() => setPreset(p)}
                aria-pressed={preset === p}
              >
                {p}
              </button>
            ))}
          </div>
          {isCaveatVisible && (
            <div className="banner banner-info">
              <span>{CAVEAT_COPY}</span>
              <button
                className="banner-dismiss"
                type="button"
                aria-label="Dismiss usage caveat"
                onClick={dismissCaveat}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>

      <ChipLegend />

      {/* Daemon-unreachable error banner — distinct from loading and N/A */}
      {daemonError !== null && (
        <div className="banner banner-error" role="alert" aria-live="assertive">
          <span>⚠ Daemon unreachable — {daemonError}</span>
          <button className="banner-retry" type="button" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}

      <VerdictBand
        preset={preset}
        trend={trendData}
        priorTrend={priorTrendData}
        isLoading={trendsState.status === "loading" || priorTrendsState.status === "loading"}
        topRecommendation={topRecommendation}
      />

      {/* RV7 tile row — rate-limit gauges · hook status · hot sessions top-3 */}
      <div
        data-testid="rv7-tile-row"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 2fr",
          gap: 12,
          marginBottom: 13,
        }}
      >
        <RateLimitGauges burnStatus={burnStatus} isLoading={burnStatusLoading} />
        <HookTile hookConfig={hookConfig} isLoading={hookConfigLoading} />
        <div className="card" data-testid="hot-sessions-tile" style={{ padding: "14px 16px" }}>
          <div style={{ marginBottom: 10, fontWeight: 700, fontSize: 13, color: "var(--soft)" }}>
            HOT SESSIONS
          </div>
          {hotSessionsLoading && (
            <div
              className="skeleton"
              style={{ height: 64, borderRadius: 6 }}
              aria-label="Loading hot sessions"
            />
          )}
          {!hotSessionsLoading && hotSessions.length === 0 && (
            <div className="kpi-off-hint" style={{ fontSize: 12 }}>
              No sessions yet.
            </div>
          )}
          {!hotSessionsLoading && hotSessions.length > 0 && (
            <div>
              {hotSessions.map((s) => (
                <button
                  key={s.session_id}
                  type="button"
                  data-testid={`hot-session-row-${s.session_id}`}
                  onClick={() => onSelectSession?.(s.session_id)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    width: "100%",
                    padding: "5px 0",
                    background: "none",
                    border: "none",
                    borderBottom: "1px solid var(--line)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 12, color: "var(--text)", fontFamily: "monospace" }}>
                    {s.session_id.slice(0, 12)}…
                  </span>
                  <span style={{ fontSize: 12, color: "var(--amber)", fontWeight: 600 }}>
                    ${(s.cost_equiv_u / 1_000_000).toFixed(2)}
                  </span>
                </button>
              ))}
              <div style={{ textAlign: "right", marginTop: 6 }}>
                <a href="#/sessions" style={{ fontSize: 12, color: "var(--teal)" }}>
                  All sessions →
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* KPI grid — loading skeleton / error / data */}
      {isFirstRun && onboardingStatus !== null && (
        <FirstRunWelcome
          status={onboardingStatus}
          hasRecommendation={hasRecommendation}
          limitCalibrated={
            ((overviewData?.forecast as unknown as ForecastFromDbResult | undefined)?.state ??
              "OFF") !== "OFF"
          }
          tokenConfigured={githubTokenConfigured}
          hookInstalled={hookConfig?.installed ?? false}
        />
      )}

      {!isFirstRun && (isOnboardingStatusPending || isOverviewLoading) ? (
        <div className="kpi-grid" aria-busy="true" aria-label="Loading overview data">
          <SkeletonKpi />
          <SkeletonKpi />
          <SkeletonKpi />
          <SkeletonKpi />
        </div>
      ) : null}

      {!isOnboardingStatusPending && !isFirstRun && !isOverviewPending && overviewData !== null && (
        <>
          <div className="section-head">
            <h2>Two meters, several tanks</h2>
          </div>
          <p className="section-subtitle">
            Watch spend and your configured limit together; each answers a different question.
          </p>
          <p className="kpi-fn" style={{ marginTop: 2, marginBottom: 8 }}>
            Absolute cap values are unpublished (Anthropic publishes only relative multipliers).
            Which cap you're hitting is visible only in /usage.
          </p>
          <div className="kpi-grid overview-secondary-kpis">
            <SpendCard
              overview={overviewData}
              preset={preset}
              trends={trendData}
              priorTrends={priorTrendData}
            />
            <BurnForecastCard
              forecast={overviewData.forecast as unknown as ForecastFromDbResult}
              burnStatus={burnStatus}
            />
          </div>
          <ModelMixFootnote rows={overviewData.model_mix} />
          <ContextPerTurnSection rows={overviewData.context_per_turn} />
        </>
      )}

      {/* Empty / null data state (distinct from loading and error) */}
      {!isOnboardingStatusPending &&
        !isFirstRun &&
        !isOverviewPending &&
        overviewError === null &&
        overviewData === null && (
          <div className="banner banner-info">
            <span>No spend data in this window.</span>
          </div>
        )}

      {/* Live strip — independent state */}
      <LiveStrip
        sessions={liveSessions}
        isLoading={isLiveLoading}
        isPending={isLivePending}
        error={liveError}
        lastFetchedAt={liveLastFetchedAt}
        onSelectSession={onSelectSession}
      />

      <div className="section-head">
        <h2>Where your tokens go</h2>
      </div>
      <p className="section-subtitle">
        Use these breakdowns to see which usage patterns are driving the total.
      </p>

      {/* Spend-Viz-v2 — "Where your tokens go" section (taxonomy §4 Section 1.2) */}
      <CacheEfficiencyKPI state={cacheEffState} forecast={overviewData?.forecast ?? null} />
      <FlavorDecomposition state={flavorState} />
      <CacheWriteSpikesChart state={cacheWriteState} />

      {/* Workspace table */}
      {isWorkspacesLoading ? (
        <div className="card" style={{ marginBottom: 13 }}>
          <div className="section-head">
            <h2>Top Workspaces</h2>
          </div>
          <div className="table-wrap" aria-busy="true" aria-label="Loading workspace data">
            <table>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Spend</th>
                  <th>Share</th>
                  <th>Live now</th>
                  <th>$/turn</th>
                  <th>Top waste source</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonRow cols={6} />
                <SkeletonRow cols={6} />
                <SkeletonRow cols={6} />
              </tbody>
            </table>
          </div>
        </div>
      ) : isWorkspacesPending ? null : (
        <WorkspaceTable
          workspaces={workspaceItems.slice(0, 3)}
          globalCostU={overviewData?.cost_equiv_u ?? 0}
          globalTurns={overviewData?.turns ?? 0}
          isLoading={false}
          topRecByWorkspace={topRecByWorkspace}
          teaser
        />
      )}

      {/* Spend-over-time trend chart */}
      <TrendChart state={trendsState} />
    </div>
  );
}
