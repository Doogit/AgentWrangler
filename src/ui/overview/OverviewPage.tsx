/**
 * src/ui/overview/OverviewPage.tsx — Global Overview surface (overview-v2).
 *
 * Section order (operator-settled, docs/plans/Archive/spec-overview-redesign.md):
 *   1. Usage limits (hero)     — UsageLimitsCard, GET /api/query/limits
 *   2. This period (4 KPI tiles)
 *   3. Top Usage Recommendations
 *   4. Most expensive sessions this week
 *   5. Across the dashboard
 *   6. Context per turn by model (table)
 *   7. Where your tokens go (100% bar + weights table, basis toggle)
 *   8. Spend by day (1 chart, 3 tabs)
 *   9. Workspaces (table)
 *  10. Data notes
 *
 * The page reads one GET /api/overview-view (perf plan P1-U4), refetched every 30 s, plus the
 * limits card's own poll. Every "live" indicator (header chip, Sessions tile, Live strip,
 * Workspaces "Active now") reads its one `live` section so they cannot disagree.
 *
 * Each card renders its own section (`safeSection`-validated): ok, pending (a sized skeleton)
 * or error (the WidgetBoundary failure card), so one bad section never blanks the page.
 * The daemon owns pace/burn/projection; the UI only renders.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { LIST_PRICE_WEIGHTS, REF_PRICE_U_PER_TOKEN } from "../../ingest/pricing";
import type { HookConfigResponse } from "../../query/api/hook-config";
import type { LinkageRateData } from "../../query/api/outcomes";
import type {
  ContextPerTurnRow,
  GlobalOverview,
  LiveSessionRow,
  PagedList,
  WorkspaceSummary,
} from "../../query/api/overview";
import type { OverviewSection } from "../../query/api/overview-view";
import type { RecommendationCard } from "../../query/api/recommendations";
import type { FlavorDecomposition } from "../../query/api/spend-flavor";
import type { CacheWriteTrend, TrendData } from "../../query/api/trends";
import type { ForecastFromDbResult } from "../../query/forecast";
import type { WeeklyHistoryWeek, WeeklyMax, WeeklyMaxState } from "../../query/limits/types";
import type { HotSessionRow } from "../../query/spend";
import {
  type OverviewSectionName,
  overviewSectionSchemas,
} from "../../shared/schemas/overview-view";
import { fetchGithubTokenStatus, fetchLimits, fetchOverviewView } from "../api/client";
import type { DaemonStatus, OverviewViewResponse } from "../api/client";
import { safeSection } from "../api/parse";
import { queryClient } from "../api/query-client";
import { OVERVIEW_LIVE_SECTIONS, queryKeys } from "../api/query-keys";
import { PRESET_DAYS, fillDailyBuckets } from "../lib/fill-days";
import { coverageLabel } from "../lib/history-status";
import type { MetricId } from "../lib/metric-copy";
import { headlineSavings } from "../lib/rec-presentation";
import { useForegroundPoll } from "../lib/use-foreground-poll";
import InfoTip from "../shell/InfoTip";
import PartialBadge from "../shell/PartialBadge";
import WidgetBoundary, { WidgetErrorCard } from "../shell/WidgetBoundary";
import { AcrossDashboard } from "./AcrossDashboard";
import { ExpensiveSessions } from "./ExpensiveSessions";
import { KpiCard } from "./KpiCard";
import LiveStrip from "./LiveStrip";
import SetupGradeCard from "./SetupGradeCard";
import { TopRecommendations, TopRecommendationsSkeleton } from "./TopRecommendations";
import UsageLimitsCard, { asOfTime } from "./UsageLimitsCard";
import WorkspaceTable, { type TopRec } from "./WorkspaceTable";

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

type Preset = "24h" | "7d" | "30d" | "all";

/** The legacy types each section's validated `data` is read as (the schema checks the fields read). */
interface SectionTypes {
  kpis: GlobalOverview;
  workspaces: PagedList<WorkspaceSummary>;
  trends: TrendData;
  trends_prior: TrendData;
  flavor: FlavorDecomposition;
  cache_write: CacheWriteTrend;
  weekly_sessions: { rows: HotSessionRow[]; cost_equiv_u: number };
  live: PagedList<LiveSessionRow>;
  status: DaemonStatus;
  top_recs: {
    active: RecommendationCard[];
    adopted: RecommendationCard[];
    active_groups?: unknown[];
  };
  linkage: LinkageRateData;
  hook_config: HookConfigResponse;
}

/** One card's view of its section: `loading` until the page response arrives. */
type SectionState<T> =
  | { state: "loading" }
  | { state: "pending"; progress?: OverviewSection["progress"] }
  | { state: "error" }
  | { state: "ok"; data: T; freshness?: OverviewSection["freshness"] };

type Sections = { [K in OverviewSectionName]: SectionState<SectionTypes[K]> };

function readSection<K extends OverviewSectionName>(
  view: OverviewViewResponse | undefined,
  name: K,
): SectionState<SectionTypes[K]> {
  if (view === undefined) return { state: "loading" };
  const section = view.sections[name];
  if (section === undefined || section.status === "error") return { state: "error" };
  if (section.status === "pending") {
    return section.progress
      ? { state: "pending", progress: section.progress }
      : { state: "pending" };
  }
  const parsed = safeSection(name, overviewSectionSchemas[name], section.data);
  if (!parsed.ok) return { state: "error" };
  const data = parsed.data as SectionTypes[K];
  return section.freshness
    ? { state: "ok", data, freshness: section.freshness }
    : { state: "ok", data };
}

function readSections(view: OverviewViewResponse | undefined): Sections {
  const names = Object.keys(overviewSectionSchemas) as OverviewSectionName[];
  return Object.fromEntries(names.map((name) => [name, readSection(view, name)])) as Sections;
}

function okData<T>(section: SectionState<T>): T | null {
  return section.state === "ok" ? section.data : null;
}

const SKELETON_DELAY_MS = 300;
/** While `top_recs` is pending or recomputing, refetch just that section this often. */
const TOP_RECS_POLL_MS = 2_000;
/** Fetched alongside the page request so the KPI strip does not wait for all 12 sections. */
const KPI_FIRST_SECTIONS: OverviewSectionName[] = ["kpis", "status"];
const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
];

function fmtUsd0(usd: number): string {
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: usd >= 1000 ? 0 : 2,
    maximumFractionDigits: usd >= 1000 ? 0 : 2,
  })}`;
}

/** Task 9: how concentrated a window's session spend is. Costs are micro-USD. */
function sessionConcentration(sessions: { cost_equiv_u: number }[]): {
  top3Share: number | null;
  median_u: number;
  avg_u: number;
  /** Top 3 costs then the rest summed; empty below 4 sessions. */
  segments: number[];
} | null {
  if (sessions.length === 0) return null;
  const costs = sessions.map((s) => s.cost_equiv_u).sort((a, b) => b - a);
  const total = costs.reduce((sum, c) => sum + c, 0);
  const mid = Math.floor(costs.length / 2);
  const median_u =
    costs.length % 2 === 1 ? (costs[mid] ?? 0) : ((costs[mid - 1] ?? 0) + (costs[mid] ?? 0)) / 2;
  const hasStrip = costs.length >= 4 && total > 0;
  const top3 = costs.slice(0, 3);
  const top3Sum = top3.reduce((sum, c) => sum + c, 0);
  return {
    top3Share: hasStrip ? top3Sum / total : null,
    median_u,
    avg_u: total / costs.length,
    segments: hasStrip ? [...top3, total - top3Sum] : [],
  };
}

function fmtModel(m: string): string {
  const stripped = m.replace("claude-", "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function fmtTokensCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function fmtPct1(fraction: number): string {
  if (fraction > 0 && fraction < 0.001) return "<0.1%";
  return `${(fraction * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Onboarding (unchanged behaviour — first-run + scan status)
// ---------------------------------------------------------------------------

function ScanStatus({ status }: { status: DaemonStatus }) {
  if (status.scan_state === "failed") {
    return (
      <p role="alert">
        Initial scan failed. Review <a href="#/settings?section=parser-health">parser health</a> and
        restart the daemon.
      </p>
    );
  }
  if ((status.invalid_scan_root_count ?? 0) > 0) {
    return (
      <p role="alert">
        {status.invalid_scan_root_count} scan root(s) are missing or unreadable. Review{" "}
        <a href="#/settings?section=scan-roots">scan roots</a>, save corrections, and restart the
        daemon.
      </p>
    );
  }
  if (status.scan_state === "scanning") {
    return (
      <p>
        Scanning… {status.files_parsed} of {status.files_seen} files
      </p>
    );
  }
  if ((status.lines_quarantined ?? 0) > 0) {
    return (
      <p role="alert">
        {status.lines_quarantined} transcript line(s) could not be parsed. Review{" "}
        <a href="#/settings?section=parser-health">parser health</a>.
      </p>
    );
  }
  if (status.scan_state === "complete" && status.sessions === 0) {
    return (
      <p>
        Scan complete — no readable sessions found. Run a Claude Code session or review{" "}
        <a href="#/settings?section=scan-roots">scan roots</a>.
      </p>
    );
  }
  if (status.scan_state === undefined) {
    return (
      <p>
        Scan completion status is unavailable. Restart with the updated daemon to see scan progress.
      </p>
    );
  }
  return null;
}

function FirstRunWelcome({
  status,
  limitCalibrated,
  tokenConfigured,
  hookInstalled,
}: {
  status: DaemonStatus;
  limitCalibrated: boolean;
  tokenConfigured: boolean;
  hookInstalled: boolean;
}) {
  const sessionIngested = status.sessions > 0;
  const steps = [
    { label: "Daemon running", complete: true },
    { label: "First session ingested", complete: sessionIngested },
  ];
  const completeCount = steps.filter((step) => step.complete).length;

  const activationItems = [
    {
      key: "calibrate",
      show: !limitCalibrated,
      text: "Calibrate your weekly limit from usage so burn forecasts have a real ceiling to project against.",
      href: "#/settings?section=calibration",
      cta: "Calibrate in Settings →",
      testid: "first-run-calibrate",
    },
    {
      key: "token",
      show: !tokenConfigured,
      text: "Optionally install the gh CLI and set a read-only AW_GITHUB_TOKEN to cross-check local work with GitHub outcomes.",
      href: "#/settings?section=outcomes-sync",
      cta: "Configure token in Settings →",
      testid: "first-run-token",
    },
    {
      key: "hook",
      show: !hookInstalled,
      text: "Install the context-budget hook to get warned in-session before a costly auto-compact.",
      href: "#/settings?section=in-session-guards",
      cta: "Install in Settings →",
      testid: "first-run-hook",
    },
  ].filter((item) => item.show);

  return (
    <section className="settings-onboarding-card" aria-labelledby="first-run-welcome-title">
      <h2 id="first-run-welcome-title">Welcome to AgentWrangler</h2>
      <p>Turn local Claude Code activity into clear, actionable guidance.</p>
      <p aria-label={`${completeCount} of 2 onboarding steps complete`}>{completeCount} of 2</p>
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
      <ScanStatus status={status} />
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
// §3 — KPI strip
// ---------------------------------------------------------------------------

/** OV-12 Q6: dotted day-boundary line, shared by the sparkline and Spend by day. */
function DayDivider({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return (
    <line
      x1={x.toFixed(1)}
      y1={y1}
      x2={x.toFixed(1)}
      y2={y2}
      stroke="var(--muted)"
      strokeOpacity={0.35}
      strokeDasharray="2 3"
      vectorEffect="non-scaling-stroke"
    />
  );
}

/** Small daily sparkline: current window solid --cyan, prior dashed --muted. No endpoint labels. */
function Sparkline({
  current,
  prior,
  dayDividers = false,
}: {
  current: number[];
  prior: number[];
  dayDividers?: boolean;
}) {
  const W = 200;
  const H = 34;
  const all = [...current, ...prior];
  const max = Math.max(1, ...all);
  const toPoints = (vals: number[]): string => {
    if (vals.length === 0) return "";
    const step = vals.length === 1 ? 0 : W / (vals.length - 1);
    return vals
      .map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 4) - 2).toFixed(1)}`)
      .join(" ");
  };
  const step = current.length > 1 ? W / (current.length - 1) : 0;
  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ margin: "6px 0 2px" }}
    >
      {dayDividers &&
        step > 0 &&
        current
          .slice(1)
          .map((_, i) => (i + 0.5) * step)
          .map((x) => <DayDivider key={x} x={x} y1={0} y2={H} />)}
      {prior.length > 0 && (
        <polyline
          points={toPoints(prior)}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      )}
      {current.length > 0 && (
        <polyline points={toPoints(current)} fill="none" stroke="var(--cyan)" strokeWidth={2} />
      )}
    </svg>
  );
}

type SpendUnit = "usd" | "tokens";

/** "≈ $1,285" or "≈ 642.5M tokens" for a µUSD max. */
function fmtMax(maxU: number, unit: SpendUnit): string {
  return unit === "usd"
    ? `≈ $${Math.round(maxU / 1_000_000).toLocaleString("en-US")}`
    : `≈ ${fmtTokensCompact(maxU / REF_PRICE_U_PER_TOKEN)} tokens`;
}

/** Local "Thu 11:00 PM". */
function fmtReset(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtPct(pct: number): string {
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** One per-model row value, by the same state rules as the all-models line. */
function perModelValue(
  m: { state: WeeklyMaxState; usedPct: number; impliedMaxSpendU: number | null },
  unit: SpendUnit,
) {
  if (m.state === "too-early") return <>Too early ({fmtPct(m.usedPct)})</>;
  if (m.state === "unavailable" || m.impliedMaxSpendU === null) return <>Unavailable</>;
  return (
    <>
      {fmtMax(m.impliedMaxSpendU, unit)} · {fmtPct(m.usedPct)}
      {m.state === "low-confidence" && (
        <>
          {" "}
          <span className="chip est">Low confidence</span>
        </>
      )}
    </>
  );
}

/** OV-12: "Max spend this week" line under the spend card; nothing when unavailable/absent. */
function WeeklyMaxLine({
  max,
  asOf,
  unit,
}: {
  max: WeeklyMax | undefined;
  asOf: string | null;
  unit: SpendUnit;
}) {
  if (max === undefined || max.state === "unavailable" || max.usedPct === null) return null;
  const sub = `${fmtPct(max.usedPct)} used · resets ${max.resetsAt === null ? "" : fmtReset(max.resetsAt)}`;
  const perModel = max.perModel ?? [];
  return (
    <div className="wmax" data-testid="weekly-max">
      {max.state === "too-early" || max.impliedMaxSpendU === null ? (
        <div className="wmax-early">Too early in the week to estimate a max</div>
      ) : (
        <div className="wmax-v">
          <span>
            Max spend this week <b>{fmtMax(max.impliedMaxSpendU, unit)}</b>
          </span>
          {max.state === "low-confidence" && <span className="chip est">Low confidence</span>}
          {max.stale && asOf !== null && (
            <span className="chip unv">Stale · as of {asOfTime(asOf)}</span>
          )}
          <InfoTip label="About max spend this week" metricId="spend.weekly_max" />
        </div>
      )}
      <div className="wmax-s">{sub}</div>
      <VsLastWeek max={max} unit={unit} />
      <PastWeeks max={max} unit={unit} />
      {perModel.length > 0 && (
        <details data-testid="weekly-max-per-model">
          <summary>Show per-model max ({perModel.length})</summary>
          <div className="pm-list">
            {perModel.map((m) => (
              <div className="pm-row" key={m.id}>
                <span className="k">Weekly · {m.label}</span>
                <span>{perModelValue(m, unit)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// OV-12 U5: past limit weeks under the max line. The server sends weeks with a max (newest first);
// the card lays them on 11 fixed past-week slots so gaps show.
const WEEK_MS = 7 * 864e5;
const HOUR_MS = 36e5;
const PAST_SLOTS = 11;
const SOURCE_LABEL: Record<string, string> = {
  api: "Live",
  "api-backup": "Live",
  statusline: "Status line",
  "calibration-backup": "Calibration",
  "limit-hit": "Limit hit",
};

/** "$1,156" or "578.0M": a history value, no "≈" or unit word. */
function fmtVal(maxU: number, unit: SpendUnit): string {
  return unit === "usd"
    ? `$${Math.round(maxU / 1_000_000).toLocaleString("en-US")}`
    : fmtTokensCompact(maxU / REF_PRICE_U_PER_TOKEN);
}

/** Local "Thu Sep 24" for a week's reset. */
function fmtWeekTo(resetMs: number): string {
  const d = new Date(resetMs);
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${fmtDay(resetMs)}`;
}
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const roundHour = (iso: string) => Math.round(Date.parse(iso) / HOUR_MS) * HOUR_MS;

/**
 * The 11 past-week slots before this week, newest first. Each week goes to its nearest slot, so
 * weeks still line up if the reset time moved; history is newest first, so the newest week wins a slot.
 */
function pastSlots(max: WeeklyMax): { resetMs: number; week?: WeeklyHistoryWeek }[] {
  const cur = roundHour(max.resetsAt ?? "");
  const bySlot = new Map<number, WeeklyHistoryWeek>();
  for (const h of max.history ?? []) {
    const i = Math.round((cur - roundHour(h.resetsAt)) / WEEK_MS) - 1;
    if (i >= 0 && i < PAST_SLOTS && !bySlot.has(i)) bySlot.set(i, h);
  }
  return Array.from({ length: PAST_SLOTS }, (_, i) => {
    const week = bySlot.get(i);
    return week === undefined
      ? { resetMs: cur - (i + 1) * WEEK_MS }
      : { resetMs: roundHour(week.resetsAt), week };
  });
}

/** "↑12% vs last week ($1,156)" / "vs last week: no clear change"; hidden when too early. */
function VsLastWeek({ max, unit }: { max: WeeklyMax; unit: SpendUnit }) {
  if (max.state === "too-early") return null;
  const v = max.vsLastWeek;
  let text: ReactNode;
  if ((max.history ?? []).length === 0) text = "vs last week: no past weeks yet";
  else if (v === undefined) text = "vs last week: compare once this week passes 10%";
  else {
    const prev = roundHour(max.resetsAt ?? "") - WEEK_MS;
    const ref = roundHour(v.resetsAt);
    const label = ref === prev ? "last week" : `week to ${fmtDay(ref)}`;
    text = v.clear ? (
      <>
        <b>
          {v.pct > 0 ? "↑" : "↓"}
          {Math.round(Math.abs(v.pct))}%
        </b>{" "}
        vs {label} ({fmtVal(v.impliedMaxSpendU, unit)})
      </>
    ) : (
      `vs ${label}: no clear change`
    );
  }
  return (
    <div className="wcmp" data-testid="weekly-max-vs">
      {text}
    </div>
  );
}

/** 12-slot dot strip: 11 past weeks + this week (hollow, once ≥ 10%), shaded noise band. */
function WeeklyTrend({ max, unit }: { max: WeeklyMax; unit: SpendUnit }) {
  const [hover, setHover] = useState<number | null>(null);
  const slots = pastSlots(max).reverse(); // oldest first
  const thisWeek = max.state === "ok" ? max.impliedMaxSpendU : null;
  const pts = [...slots.map((s) => s.week?.impliedMaxSpendU ?? null), thisWeek];
  let first = -1;
  let latest = -1;
  slots.forEach((s, i) => {
    if (s.week === undefined) return;
    if (first < 0) first = i;
    latest = i;
  });
  if (latest < 0) return null;
  const ref = slots[latest]?.week?.impliedMaxSpendU as number;
  const noise = (max.noisePct ?? 3) / 100;
  const vals = pts.filter((p): p is number => p !== null);
  const lo = Math.min(...vals, ref * (1 - noise));
  const hi = Math.max(...vals, ref * (1 + noise));
  const d0 = lo - (hi - lo) * 0.1;
  const d1 = hi + (hi - lo) * 0.1;
  const x = (i: number) => 10 + 20 * i;
  const y = (v: number) => 56 - ((v - d0) / (d1 - d0)) * 48;
  const hovered = hover === null ? null : { i: hover, slot: slots[hover], v: pts[hover] };
  const tip =
    hovered === null
      ? null
      : hovered.i === PAST_SLOTS
        ? thisWeek === null
          ? "This week · under 10% so far"
          : `This week so far · ${fmtVal(thisWeek, unit)} · ${fmtPct(max.usedPct ?? 0)} used`
        : hovered.slot?.week !== undefined
          ? `Week to ${fmtWeekTo(hovered.slot.resetMs)} · ${fmtVal(hovered.slot.week.impliedMaxSpendU, unit)} · read at ${fmtPct(hovered.slot.week.usedPctAtSample)} · ${SOURCE_LABEL[hovered.slot.week.source] ?? hovered.slot.week.source}`
          : `Week to ${fmtWeekTo(hovered.slot?.resetMs ?? 0)} · no reading ≥ 10%`;
  const label = slots
    .filter((s) => s.week !== undefined)
    .map((s) => `week to ${fmtDay(s.resetMs)} ${fmtVal(s.week?.impliedMaxSpendU ?? 0, unit)}`)
    .join("; ");
  return (
    <div className="wtrend" data-testid="weekly-max-trend">
      <div className="wtrend-h">
        <span>Weekly max · 12 weeks</span>
        <span className="wtrend-r">
          {fmtVal(d0, unit)} – {fmtVal(d1, unit)}
        </span>
      </div>
      <svg viewBox="0 0 240 64" role="img" aria-label={`Weekly max by week: ${label}`}>
        <rect
          x={0}
          y={y(ref * (1 + noise))}
          width={240}
          height={y(ref * (1 - noise)) - y(ref * (1 + noise))}
          fill="var(--tint-cyan)"
        />
        <line x1={0} y1={60} x2={240} y2={60} stroke="var(--line)" />
        {pts.map((_, i) => (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 12-slot axis
            key={`t${i}`}
            x1={x(i)}
            y1={58}
            x2={x(i)}
            y2={62}
            stroke="var(--muted)"
            strokeOpacity={0.45}
          />
        ))}
        {slots.map((s, i) =>
          s.week === undefined && i > first ? (
            <line
              key={`g${s.resetMs}`}
              x1={x(i)}
              y1={8}
              x2={x(i)}
              y2={56}
              stroke="var(--muted)"
              strokeOpacity={0.6}
              strokeDasharray="2 3"
            />
          ) : null,
        )}
        {pts.slice(0, -1).map((p, i) => {
          const q = pts[i + 1];
          if (p === null || q === null || q === undefined) return null;
          return (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 12-slot axis
              key={`s${i}`}
              x1={x(i)}
              y1={y(p)}
              x2={x(i + 1)}
              y2={y(q)}
              stroke="var(--cyan)"
              strokeWidth={2}
              strokeDasharray={i + 1 === PAST_SLOTS ? "3 3" : undefined}
            />
          );
        })}
        {pts.map((p, i) =>
          p === null ? null : (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 12-slot axis
              key={`p${i}`}
              cx={x(i)}
              cy={y(p)}
              r={4}
              fill={i === PAST_SLOTS ? "var(--inset)" : "var(--cyan)"}
              stroke={
                i === PAST_SLOTS ? "var(--cyan)" : hover === i ? "var(--text)" : "var(--inset)"
              }
              strokeWidth={2}
            />
          ),
        )}
        <text x={x(latest)} y={y(ref) - 8} textAnchor="middle" fontSize={10} fill="var(--text)">
          {fmtVal(ref, unit)}
        </text>
        {pts.map((_, i) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 12-slot axis
            key={`h${i}`}
            x={x(i) - 10}
            y={0}
            width={20}
            height={64}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {tip !== null && hovered !== null && (
        <output className={`wtrend-tip${hovered.i > 5 ? " right" : ""}`}>{tip}</output>
      )}
      <div className="wtrend-x">
        <span>{fmtDay(slots[0]?.resetMs ?? 0)}</span>
        <span>This week</span>
      </div>
      <div className="wtrend-k">
        Shaded = noise (±{Math.round(noise * 100)}%) around the latest week · dashed = no reading
      </div>
    </div>
  );
}

/** "Show past weeks (N)": the trend strip, then one row per week down to the oldest with a max. */
function PastWeeks({ max, unit }: { max: WeeklyMax; unit: SpendUnit }) {
  const [all, setAll] = useState(false);
  const slots = pastSlots(max);
  let oldest = -1;
  slots.forEach((s, i) => {
    if (s.week !== undefined) oldest = i;
  });
  if (oldest < 0) {
    return max.state === "too-early" ? null : (
      <div className="wmax-empty">Past weeks appear once a week's reading reaches 10%.</div>
    );
  }
  const rows = slots.slice(0, oldest + 1);
  return (
    <details data-testid="weekly-max-history">
      <summary>Show past weeks ({rows.length})</summary>
      <div className="pm-list">
        <WeeklyTrend max={max} unit={unit} />
        {(all ? rows : rows.slice(0, 3)).map((s) => (
          <div key={s.resetMs} className="pm-week">
            <div className="pm-row">
              <span className="k">Week to {fmtWeekTo(s.resetMs)}</span>
              {s.week === undefined ? (
                <span className="pm-gap">No reading ≥ 10%</span>
              ) : (
                <span>
                  ≈ <b>{fmtVal(s.week.impliedMaxSpendU, unit)}</b> ·{" "}
                  {fmtPct(s.week.usedPctAtSample)}{" "}
                  <span className={`chip${s.week.source === "limit-hit" ? " unv" : ""}`}>
                    {SOURCE_LABEL[s.week.source] ?? s.week.source}
                  </span>
                </span>
              )}
            </div>
            {s.week?.spread !== undefined && (
              <div className="pm-sub">
                {s.week.spread.readings} readings, {Math.round(s.week.spread.pct)}% apart (
                {fmtVal(s.week.spread.minSpendU, unit)} – {fmtVal(s.week.spread.maxSpendU, unit)})
              </div>
            )}
          </div>
        ))}
        {rows.length > 3 && (
          <button type="button" className="btn-ghost pm-more" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${rows.length} weeks`}
          </button>
        )}
        <div className="pm-note">
          Changes under {Math.round(max.noisePct ?? 3)}% read "no clear change" (the spread between
          readings in one week, at least 3%).
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// §6 — Spend by day (1 chart, 3 tabs)
// ---------------------------------------------------------------------------

type SpendTab = "spend" | "cap" | "writes";

function bucketShort(bucket: string): string {
  // "2026-09-13" -> "09-13"; leave week/month keys as-is.
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(bucket);
  return m ? `${m[1]}-${m[2]}` : bucket;
}

function SpendByDayCard({
  trend,
  cacheWrite,
  workspaceLabels,
  tab,
  setTab,
  preset,
  now,
  d8SavingsU,
}: {
  trend: TrendData | null;
  cacheWrite: CacheWriteTrend | null;
  workspaceLabels: Map<string, string>;
  tab: SpendTab;
  setTab: (tab: SpendTab) => void;
  preset: Preset;
  /** Server clock of the page response; null leaves days unfilled. */
  now: Date | null;
  /** Largest active D8 (cache-miss) fix, µ$/wk; shown on the Cache writes tab. */
  d8SavingsU: number | null;
}) {
  // OV-12 Q7: a day with no turns is a zero bar, not a missing one (all 3 tabs key off this).
  const rawDays = trend?.buckets.map((b) => ({ bucket: b.bucket })) ?? [];
  const buckets = (
    now === null ? rawDays : fillDailyBuckets(rawDays, preset, now, (bucket) => ({ bucket }))
  ).map((b) => b.bucket);
  const chip =
    tab === "spend" ? (
      <span className="chip est">Estimate</span>
    ) : tab === "cap" ? (
      <span className="chip unv">Unverified</span>
    ) : (
      <span className="chip exact">Exact · raw tokens</span>
    );

  // Build per-bucket stacked segments.
  const wsByBucket = new Map<string, { id: string; value: number }[]>();
  if (trend) {
    for (const row of trend.by_workspace) {
      const list = wsByBucket.get(row.bucket) ?? [];
      list.push({ id: row.workspace_id, value: row.cost_equiv_u / 1_000_000 });
      wsByBucket.set(row.bucket, list);
    }
  }
  const wsIds = [...new Set(trend?.by_workspace.map((r) => r.workspace_id) ?? [])];
  const capByBucket = new Map(
    trend?.cap_weighted.map((r) => [r.bucket, r.cap_weighted_tokens]) ?? [],
  );
  const writeByBucket = new Map(
    cacheWrite?.buckets.map((r) => [r.bucket, r.cache_creation_tokens]) ?? [],
  );

  const totals = buckets.map((b) => {
    if (tab === "spend") return (wsByBucket.get(b) ?? []).reduce((s, x) => s + x.value, 0);
    if (tab === "cap") return capByBucket.get(b) ?? 0;
    return writeByBucket.get(b) ?? 0;
  });
  const max = Math.max(1, ...totals);

  const W = 1000;
  const H = 180;
  const padL = 8;
  const padB = 22;
  const plotW = W - padL * 2;
  const plotH = H - padB;
  const barW = buckets.length > 0 ? (plotW / buckets.length) * 0.7 : 0;
  const gap = buckets.length > 0 ? plotW / buckets.length : 0;
  // Over 31 days ("All") the date labels collide; label every k-th day so at most 31 show.
  const labelEvery = Math.ceil(buckets.length / 31);

  const readingKey =
    tab === "spend"
      ? "Bar = one day · color = workspace · ① = a recommendation was applied"
      : tab === "cap"
        ? "Bar = one day · cap-weighted tokens that count toward your limit"
        : "Bar = one day · cache-write tokens (spikes = likely cache misses)";

  return (
    <section className="sec" id="spend-by-day" aria-labelledby="spend-by-day-title">
      <div className="sec-h">
        <h2 id="spend-by-day-title">
          Spend by day <InfoTip label="About spend by day" metricId="chart.spend_by_day" />
        </h2>
        <span className="desc">{chip}</span>
      </div>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div className="seg">
            <button
              type="button"
              className={tab === "spend" ? "on" : ""}
              onClick={() => setTab("spend")}
            >
              Spend $
            </button>
            <button
              type="button"
              className={tab === "cap" ? "on" : ""}
              onClick={() => setTab("cap")}
            >
              Cap-weighted tokens
            </button>
            <button
              type="button"
              className={tab === "writes" ? "on" : ""}
              onClick={() => setTab("writes")}
            >
              Cache writes
            </button>
          </div>
          <span className="lbl">{readingKey}</span>
          {tab === "writes" && d8SavingsU !== null && (
            <span className="chip est">Fix worth up to {fmtUsd0(d8SavingsU / 1_000_000)}/wk</span>
          )}
        </div>
        {buckets.length === 0 ? (
          <p className="foot">No spend in this window yet.</p>
        ) : (
          <div style={{ minHeight: 180, marginTop: 12 }}>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              width="100%"
              height={H}
              role="img"
              aria-label="Spend by day"
            >
              <line x1={padL} y1={plotH} x2={W - padL} y2={plotH} stroke="var(--line)" />
              {(preset === "7d" || preset === "30d") &&
                buckets
                  .slice(1)
                  .map((b, i) => <DayDivider key={b} x={padL + (i + 1) * gap} y1={0} y2={plotH} />)}
              {buckets.map((b, i) => {
                const x = padL + i * gap + (gap - barW) / 2;
                if (tab === "spend") {
                  const segs = wsByBucket.get(b) ?? [];
                  let y = plotH;
                  return (
                    <g key={b} data-day={b}>
                      {segs.map((seg) => {
                        const h = (seg.value / max) * (plotH - 4);
                        y -= h;
                        const idx = wsIds.indexOf(seg.id);
                        return (
                          <rect
                            key={seg.id}
                            x={x}
                            y={y}
                            width={barW}
                            height={Math.max(0, h)}
                            fill={SERIES[idx % SERIES.length]}
                          />
                        );
                      })}
                      {i % labelEvery === 0 && (
                        <text
                          x={x + barW / 2}
                          y={H - 6}
                          textAnchor="middle"
                          fontSize={11}
                          fill="var(--muted)"
                        >
                          {bucketShort(b)}
                        </text>
                      )}
                    </g>
                  );
                }
                const h = ((totals[i] ?? 0) / max) * (plotH - 4);
                return (
                  <g key={b} data-day={b}>
                    <rect
                      x={x}
                      y={plotH - h}
                      width={barW}
                      height={Math.max(0, h)}
                      fill="var(--series-1)"
                    />
                    {i % labelEvery === 0 && (
                      <text
                        x={x + barW / 2}
                        y={H - 6}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--muted)"
                      >
                        {bucketShort(b)}
                      </text>
                    )}
                  </g>
                );
              })}
              {(trend?.adoption_markers ?? []).map((marker, i) => {
                const bi = buckets.indexOf(marker.bucket);
                if (bi === -1) return null;
                const x = padL + bi * gap + gap / 2;
                return (
                  <g key={marker.rec_id}>
                    <line
                      x1={x}
                      y1={6}
                      x2={x}
                      y2={plotH}
                      stroke="var(--amber)"
                      strokeDasharray="3 3"
                    />
                    <circle cx={x} cy={8} r={7} fill="var(--amber)" />
                    <text
                      x={x}
                      y={12}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={700}
                      fill="var(--accent-ink)"
                    >
                      {i + 1}
                    </text>
                  </g>
                );
              })}
            </svg>
            {tab === "spend" && wsIds.length > 0 && (
              <div className="legend">
                {wsIds.map((id, i) => (
                  <span key={id}>
                    <i style={{ background: SERIES[i % SERIES.length] }} />
                    {workspaceLabels.get(id) ?? id}
                  </span>
                ))}
                {(trend?.adoption_markers ?? []).map((marker, i) => (
                  <span key={marker.rec_id}>
                    <i style={{ background: "var(--amber)", borderRadius: "50%" }} />①{i + 1}{" "}
                    <a href={`#/recommendations?applied=${encodeURIComponent(marker.rec_id)}`}>
                      {marker.lever} (before/after →)
                    </a>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §5 — Where your tokens go
// ---------------------------------------------------------------------------

type Basis = "raw" | "list" | "cap";

interface TokenTypeRow {
  key: string;
  label: string;
  raw: number;
  listWeight: number;
  capWeight: number;
  capUnverified: boolean;
}

function buildTokenRows(flavor: FlavorDecomposition): TokenTypeRow[] {
  const coeff = flavor.coeff_used;
  const byKey = new Map(flavor.flavors.map((f) => [f.flavor, f]));
  const order: {
    key: string;
    label: string;
    listWeight: number;
    capWeight: number;
    capUnverified: boolean;
  }[] = [
    {
      key: "cache_read",
      label: "cache read",
      listWeight: LIST_PRICE_WEIGHTS.cacheRead,
      capWeight: coeff,
      capUnverified: true,
    },
    {
      key: "cache_write_5m",
      label: "cache write (5 min)",
      listWeight: LIST_PRICE_WEIGHTS.cacheWrite5m,
      capWeight: 1,
      capUnverified: true,
    },
    {
      key: "cache_write_1h",
      label: "cache write (1 hr)",
      listWeight: LIST_PRICE_WEIGHTS.cacheWrite1h,
      capWeight: 1,
      capUnverified: true,
    },
    {
      key: "output",
      label: "output",
      listWeight: LIST_PRICE_WEIGHTS.output,
      capWeight: 1,
      capUnverified: true,
    },
    {
      key: "fresh_input",
      label: "fresh input",
      listWeight: LIST_PRICE_WEIGHTS.input,
      capWeight: 1,
      capUnverified: false,
    },
  ];
  return order.map((o) => ({
    ...o,
    raw: byKey.get(o.key as FlavorDecomposition["flavors"][number]["flavor"])?.raw_tokens ?? 0,
  }));
}

function TokensGoSection({ flavor }: { flavor: FlavorDecomposition | null }) {
  const [basis, setBasis] = useState<Basis>("raw");

  const chip =
    basis === "raw" ? (
      <span className="chip exact">Exact · raw tokens</span>
    ) : basis === "list" ? (
      <span className="chip est">Estimate · list price</span>
    ) : (
      <span className="chip unv">Unverified · cap-weighted</span>
    );

  const rows = flavor ? buildTokenRows(flavor) : [];
  const weightFor = (r: TokenTypeRow): number =>
    basis === "raw" ? 1 : basis === "list" ? r.listWeight : r.capWeight;
  const weighted = rows.map((r) => r.raw * weightFor(r));
  const total = weighted.reduce((s, v) => s + v, 0);

  return (
    <section className="sec" aria-labelledby="tokens-go-title">
      <div className="sec-h">
        <h2 id="tokens-go-title">
          Where your tokens go{" "}
          <InfoTip label="About where your tokens go" metricId="chart.tokens_by_type" />
        </h2>
        <span className="desc">Same window · one basis toggle for the whole section</span>
      </div>
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div className="seg">
            <button
              type="button"
              className={basis === "raw" ? "on" : ""}
              onClick={() => setBasis("raw")}
            >
              Raw tokens
            </button>
            <button
              type="button"
              className={basis === "list" ? "on" : ""}
              onClick={() => setBasis("list")}
            >
              List price $
            </button>
            <button
              type="button"
              className={basis === "cap" ? "on" : ""}
              onClick={() => setBasis("cap")}
            >
              Cap-weighted
            </button>
          </div>
          {chip}
        </div>
        {flavor === null || total === 0 ? (
          <p className="foot">No token activity in this window yet.</p>
        ) : (
          <>
            <div className="stack num" style={{ marginTop: 14 }}>
              {rows.map((r, i) => {
                const share = (r.raw * weightFor(r)) / total;
                if (share <= 0) return null;
                return (
                  <div
                    key={r.key}
                    style={{ flex: share * 100, background: SERIES[i % SERIES.length] }}
                  />
                );
              })}
            </div>
            <div className="legend num">
              {rows.map((r, i) => {
                const share = (r.raw * weightFor(r)) / total;
                return (
                  <span key={r.key}>
                    <i style={{ background: SERIES[i % SERIES.length] }} />
                    {r.label} {(share * 100).toFixed(1)}%
                  </span>
                );
              })}
            </div>
            <div className="table-wrap">
              <table className="num" style={{ marginTop: 14 }}>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Raw tokens</th>
                    <th>
                      List-price weight{" "}
                      <InfoTip label="About list-price weights" metricId="weight.listprice" />
                    </th>
                    <th>
                      Cap weight <InfoTip label="About cap weights" metricId="weight.cap" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td>{fmtTokensCompact(r.raw)}</td>
                      <td>{r.listWeight}×</td>
                      <td>
                        {r.capWeight}×{" "}
                        {r.capUnverified && <span className="chip unv">unverified</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="foot">
              Weights stated per basis so a "1×" is never silently wrong. List-price weights are
              published API multipliers; the Fable/Mythos 5.1 family caches reads at 0.025× (not
              0.1×).
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §4 — Context per turn by model (table)
// ---------------------------------------------------------------------------

function ContextPerTurnTable({
  rows,
  totalUsd,
}: {
  rows: ContextPerTurnRow[];
  totalUsd: number;
}) {
  return (
    <section
      className="sec"
      aria-labelledby="context-per-turn-title"
      data-testid="context-per-turn-section"
    >
      <div className="sec-h">
        <h2 id="context-per-turn-title">
          Context per turn by model{" "}
          <InfoTip label="About context per turn" metricId="table.context_per_turn" />
        </h2>
        <span className="desc">
          <span className="chip est">Estimate</span>
        </span>
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <p className="foot">No context-per-turn data in this window.</p>
        ) : (
          <div className="table-wrap">
            <table className="num">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Avg context</th>
                  <th>Avg output</th>
                  <th>Output share</th>
                  <th>Share of spend</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const outShare =
                    row.avg_context_per_turn > 0
                      ? row.avg_output_per_turn / row.avg_context_per_turn
                      : 0;
                  const perModelUsd = (row.usd_per_turn ?? 0) * row.n;
                  const spendShare = totalUsd > 0 ? perModelUsd / totalUsd : 0;
                  return (
                    <tr key={row.model}>
                      <td>
                        <i className="dot" style={{ background: SERIES[i % SERIES.length] }} />
                        {fmtModel(row.model)}
                      </td>
                      <td>{fmtTokensCompact(row.avg_context_per_turn)}</td>
                      <td>{fmtTokensCompact(row.avg_output_per_turn)}</td>
                      <td className={outShare < 0.01 ? "bad" : undefined}>
                        {fmtPct1(outShare)}
                        <small className="metric-operands">
                          {fmtTokensCompact(row.avg_output_per_turn)} output /{" "}
                          {fmtTokensCompact(row.avg_context_per_turn)} context
                        </small>
                      </td>
                      <td>{fmtPct1(spendShare)}</td>
                      <td>
                        <a href={`#/sessions?model=${encodeURIComponent(row.model)}`}>sessions →</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="foot">
          Output share below 1% means each turn is mostly re-reading history — consider{" "}
          <code>/clear</code> between tasks.
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §8 — Data notes
// ---------------------------------------------------------------------------

function DataNotes({ flavor }: { flavor: FlavorDecomposition | null }) {
  const readShare = flavor?.cache_read_share ?? null;
  const reads = flavor?.cache_read_tokens ?? 0;
  const writes = flavor?.cache_creation_tokens ?? 0;
  const ratio = writes > 0 ? reads / writes : null;

  return (
    <section className="sec" id="data-notes" aria-labelledby="data-notes-title">
      <div className="sec-h">
        <h2 id="data-notes-title">Data notes</h2>
        <span className="desc">
          Every caveat once, here — cards link to it instead of repeating it
        </span>
      </div>
      <div className="card" style={{ fontSize: "var(--font-sm)", color: "var(--soft)" }}>
        <div className="notice warn" style={{ marginBottom: 10 }}>
          ⚠{" "}
          <span>
            <b>Cache TTL unknown for this window.</b> 5-minute vs 1-hour caching changes both the
            list-price weights and the cache-miss threshold. Run <code>/usage</code> in Claude Code
            once to confirm; the setting is read on the next ingest.
          </span>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>
            <b>Spend-equivalent</b> = tokens × API list price. A comparison figure, not billing
            data.
          </li>
          <li>
            <b>Cap weight</b> = share of the subscription limit per token type. 0.1× for cache reads
            is unverified; calibrate it against the Usage limits card&apos;s estimate-vs-actual
            delta.
          </li>
          <li>
            <b>Cache-read share</b>{" "}
            {readShare === null
              ? "unavailable for this window."
              : `${(readShare * 100).toFixed(1)}% (${fmtTokensCompact(reads)} reads : ${fmtTokensCompact(writes)} writes${ratio !== null ? ` = ${ratio.toFixed(1)}×` : ""}). Diagnostic; a high share is normal for long sessions and is not by itself good or bad.`}
          </li>
          <li>
            <b>Provisional turns</b> (sessions still open) are excluded from all window totals and
            included in the live 5-hour burn.
          </li>
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function OverviewPage({
  onSelectSession,
}: { onSelectSession?: (sessionId: string) => void }) {
  const [preset, setPreset] = useState<Preset>("7d");
  const [showInitialSkeletons, setShowInitialSkeletons] = useState(false);
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [usageSource, setUsageSource] = useState<
    "api" | "cli" | "statusline" | "unavailable" | null
  >(null);
  const [calibrationDriftPoints, setCalibrationDriftPoints] = useState<number | null>(null);
  const [limits, setLimits] = useState<{ weeklyMax: WeeklyMax | undefined; asOf: string } | null>(
    null,
  );
  const [spendUnit, setSpendUnit] = useState<SpendUnit>("usd");
  const [spendTab, setSpendTab] = useState<SpendTab>(() =>
    new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab") === "writes"
      ? "writes"
      : "spend",
  );

  useEffect(() => {
    const id = window.setTimeout(() => setShowInitialSkeletons(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  // One page request (P1-U4). It refetches only when the status poller sees one of its data
  // scopes move (P2-U5).
  const query = useQuery(
    {
      queryKey: queryKeys.overviewView(preset),
      queryFn: ({ signal }) => fetchOverviewView(preset, signal),
      placeholderData: keepPreviousData,
    },
    queryClient,
  );
  const view = query.data;
  // P2-U5: a `live` scope change (tail commits) refetches only these two sections, never the
  // page. Seeded from the page response, so mounting it costs no request.
  const liveQuery = useQuery(
    {
      queryKey: queryKeys.overviewViewSections(preset, OVERVIEW_LIVE_SECTIONS),
      queryFn: ({ signal }) => fetchOverviewView(preset, signal, [...OVERVIEW_LIVE_SECTIONS]),
      enabled: view !== undefined,
      initialData: view,
      initialDataUpdatedAt: query.dataUpdatedAt,
      staleTime: Number.POSITIVE_INFINITY,
    },
    queryClient,
  );
  const liveView = liveQuery.dataUpdatedAt > query.dataUpdatedAt ? liveQuery.data : undefined;
  // G-P1 (M5 on L): the page request yields between its 12 sections, and during boot each yield
  // waits behind boot work, so the KPIs first ask for just `kpis,status` and render the KPI strip
  // from it until the page lands. Only the strip uses it; every other card waits for the page.
  const kpiFirstQuery = useQuery(
    {
      queryKey: queryKeys.overviewViewSections(preset, KPI_FIRST_SECTIONS),
      queryFn: ({ signal }) => fetchOverviewView(preset, signal, KPI_FIRST_SECTIONS),
      enabled: view === undefined && !query.isError,
      refetchInterval: false,
    },
    queryClient,
  );
  const early = view === undefined ? kpiFirstQuery.data : undefined;
  const sections = useMemo(() => {
    const all = readSections(view);
    if (liveView !== undefined) {
      return {
        ...all,
        live: readSection(liveView, "live"),
        status: readSection(liveView, "status"),
      };
    }
    if (early === undefined) return all;
    const kpis = readSection(early, "kpis");
    const status = readSection(early, "status");
    return kpis.state === "ok" && status.state === "ok" ? { ...all, kpis, status } : all;
  }, [view, early, liveView]);
  const refetch = () => void query.refetch();

  // A cold recs build answers `top_recs: pending`, a rebuild behind the snapshot `recomputing`;
  // poll just that section until either resolves.
  const topRecsBusy = (section: OverviewSection | undefined) =>
    section?.status === "pending" || section?.freshness?.status === "recomputing";
  const topRecsWaiting =
    sections.top_recs.state === "pending" ||
    (sections.top_recs.state === "ok" && sections.top_recs.freshness?.status === "recomputing");
  const topRecsQuery = useQuery(
    {
      queryKey: queryKeys.overviewViewSections(preset, ["top_recs"]),
      queryFn: ({ signal }) => fetchOverviewView(preset, signal, ["top_recs"]),
      enabled: topRecsWaiting,
      refetchInterval: (q) =>
        topRecsBusy(q.state.data?.sections.top_recs) ? TOP_RECS_POLL_MS : false,
    },
    queryClient,
  );
  const polledTopRecs = useMemo(
    () => readSection(topRecsQuery.data, "top_recs"),
    [topRecsQuery.data],
  );
  // Only a poll newer than the page response wins (a cached poll from an earlier wait is older).
  const topRecs =
    topRecsWaiting &&
    polledTopRecs.state !== "loading" &&
    topRecsQuery.dataUpdatedAt >= query.dataUpdatedAt
      ? polledTopRecs
      : sections.top_recs;
  // Arrival: rows fade up once when a build that kept the section pending lands.
  const [topRecsWasPending, setTopRecsWasPending] = useState(false);
  const [topRecsEntering, setTopRecsEntering] = useState(false);
  useEffect(() => {
    if (topRecs.state === "pending") setTopRecsWasPending(true);
    else if (topRecs.state === "ok" && topRecsWasPending) {
      setTopRecsWasPending(false);
      setTopRecsEntering(true);
    }
  }, [topRecs.state, topRecsWasPending]);
  useEffect(() => {
    if (!topRecsEntering) return;
    const id = window.setTimeout(() => setTopRecsEntering(false), 1_000);
    return () => window.clearTimeout(id);
  }, [topRecsEntering]);

  const recs = useMemo(() => {
    const active = topRecs.state === "ok" ? topRecs.data.active : [];
    // Active is ordered by shown $, which can differ from d8Value (legacy range fallback), so the
    // first D8 is not always the largest. Pick the D8 with the largest net headline; a $0 D8 only wins if none is > 0.
    const d8Value = (rec: RecommendationCard): number | null =>
      headlineSavings(rec) ??
      (rec.allocated_u_per_wk === undefined ? (rec.range_u_per_wk?.[1] ?? null) : null);
    let d8SavingsU: number | null = null;
    for (const rec of active) {
      if (rec.detector_id !== "D8") continue;
      const value = d8Value(rec);
      if (value !== null && (d8SavingsU === null || value > d8SavingsU)) d8SavingsU = value;
    }
    const topRecByWorkspace = new Map<string, TopRec>();
    for (const rec of active) {
      if (rec.scope_workspace_id === null) continue;
      const existing = topRecByWorkspace.get(rec.scope_workspace_id);
      const savings = headlineSavings(rec) ?? -1;
      if (existing === undefined || savings > (existing.savings ?? -1)) {
        topRecByWorkspace.set(rec.scope_workspace_id, {
          detector_id: rec.detector_id,
          state: rec.state,
          savings,
        });
      }
    }
    return { d8SavingsU, topRecByWorkspace };
  }, [topRecs]);
  const { d8SavingsU, topRecByWorkspace } = recs;

  // Re-read every 180 s while visible (OV-12 E8) so the spend card's "Y% used" tracks the limits
  // card. Same request + cadence as UsageLimitsCard, so useForegroundPoll shares its fetch.
  useForegroundPoll(
    fetchLimits,
    180_000,
    (model) => {
      setUsageSource(
        model.state === "connected"
          ? (model.source ?? "api")
          : model.state === "error"
            ? "unavailable"
            : null,
      );
      setCalibrationDriftPoints(model.estimateVsActual?.deltaPts ?? null);
      setLimits({ weeklyMax: model.weeklyMax, asOf: model.asOf });
    },
    () => setUsageSource("unavailable"),
  );

  // Every page-body read below goes through a validated section (P0-U6 / P1-U1): a malformed
  // field fails only its own section, never the whole page.
  const overviewData = okData(sections.kpis);
  const trendData = okData(sections.trends);
  const priorTrendData = okData(sections.trends_prior);
  const flavorData = okData(sections.flavor);
  const cacheWriteData = okData(sections.cache_write);
  const spendCurrent =
    trendData?.buckets.reduce((total, bucket) => total + bucket.cost_equiv_u, 0) ?? null;
  const spendPrior =
    priorTrendData?.buckets.reduce((total, bucket) => total + bucket.cost_equiv_u, 0) ?? null;
  // OV-12 Q7: zero-fill days against the server's clock (the response window's end).
  const serverNowMs = Date.parse((view ?? early)?.window.to ?? "");
  const serverNow = Number.isNaN(serverNowMs) ? null : new Date(serverNowMs);
  const dailySpend = (buckets: TrendData["buckets"] | undefined, now: Date | null): number[] => {
    const rows = (buckets ?? []).map((b) => ({ bucket: b.bucket, cost_equiv_u: b.cost_equiv_u }));
    return (
      now === null
        ? rows
        : fillDailyBuckets(rows, preset, now, (bucket) => ({ bucket, cost_equiv_u: 0 }))
    ).map((b) => b.cost_equiv_u);
  };
  const sparkCurrent = dailySpend(trendData?.buckets, serverNow);
  // "All" has no prior window to draw.
  const sparkPrior =
    preset === "all"
      ? []
      : dailySpend(
          priorTrendData?.buckets,
          serverNow === null
            ? null
            : new Date(serverNow.getTime() - PRESET_DAYS[preset] * 86_400_000),
        );

  const workspaceItems = okData(sections.workspaces)?.items ?? [];
  const workspaceLabels = new Map(
    workspaceItems.map((w) => [w.workspace_id, w.repo_name ?? w.project_slug ?? w.workspace_id]),
  );

  const liveSessions = okData(sections.live)?.items ?? [];
  const liveWorkspaceIds = new Set(liveSessions.map((s) => s.workspace_id));
  const liveWorkspaceItems =
    sections.live.state === "ok"
      ? workspaceItems.map((w) => ({ ...w, has_live: liveWorkspaceIds.has(w.workspace_id) }))
      : workspaceItems;
  const onboardingStatus = okData(sections.status);
  const isOnboardingStatusPending = sections.status.state === "loading" && !query.isError;
  const isFirstRun = onboardingStatus?.sessions === 0;
  const hookConfig = okData(sections.hook_config);
  const linkageRate = okData(sections.linkage)?.linkage_rate ?? null;

  // The GitHub token only matters to the first-run checklist; don't spend a request otherwise.
  useEffect(() => {
    if (!isFirstRun) return;
    void Promise.resolve(fetchGithubTokenStatus())
      .then((s) => setGithubTokenConfigured(s?.configured ?? false))
      .catch(() => setGithubTokenConfigured(false));
  }, [isFirstRun]);

  const isOverviewPending = view === undefined;
  const isOverviewLoading = isOverviewPending && !query.isError && showInitialSkeletons;
  const isLiveLoading = isOverviewLoading;
  // A failed page request with nothing to show; a failed background refetch keeps the last view.
  const daemonError = query.isError && view === undefined ? String(query.error) : null;
  const liveRefreshError = query.isError && view !== undefined ? String(query.error) : null;

  // KPI derived values
  const totalUsd = (overviewData?.cost_equiv_u ?? 0) / 1_000_000;
  const spendDeltaPct =
    spendCurrent !== null && spendPrior !== null && spendPrior > 0
      ? ((spendCurrent - spendPrior) / spendPrior) * 100
      : null;
  // Sessions with turns in this window; /api/status `sessions` is the all-time count.
  const sessionsCount = overviewData?.subagent_spend?.sessions_in_window ?? null;
  // Task 9: concentration and the count delta come from the reconciled-session lists.
  const concentration = sessionConcentration(trendData?.sessions ?? []);
  const priorSessionCount = priorTrendData?.sessions.length ?? 0;
  const sessionDeltaPct =
    trendData && priorSessionCount > 0
      ? ((trendData.sessions.length - priorSessionCount) / priorSessionCount) * 100
      : null;
  // The expensive-sessions table is always the 7-day top 5; other presets open Sessions by cost.
  const expensiveHref =
    preset === "7d"
      ? "#/overview"
      : preset === "all"
        ? "#/sessions?sort=cost&direction=desc"
        : `#/sessions?from=${new Date(Date.now() - PRESET_DAYS[preset] * 86_400_000).toISOString().slice(0, 10)}&sort=cost&direction=desc`;
  const presetLabel = preset === "all" ? "all time" : preset;

  const unconfirmedModels = overviewData?.unconfirmed_models ?? [];
  const ctxRows = overviewData?.context_per_turn ?? [];
  const subagentSpend = overviewData?.subagent_spend;

  // The page response is in and this is not a first run: each card then shows its own section.
  const showMetrics = !isOnboardingStatusPending && !isFirstRun && !isOverviewPending;
  // The KPI strip alone, from the KPI-first subset, while the page request is still in flight.
  const showEarlyKpis =
    isOverviewPending && !isOnboardingStatusPending && !isFirstRun && overviewData !== null;

  // U5: partial-data affordances — pipeline is incomplete when it exists and hasn't finished.
  const pipelineIsIncomplete =
    onboardingStatus?.pipeline != null && onboardingStatus.pipeline.phase !== "done";
  // P2-U7: a preset wider than the history read so far says how many of its days are in.
  // "All" counts against the planned history instead of a fixed window.
  const periodCoverage = coverageLabel(
    onboardingStatus?.history_coverage,
    preset === "all" ? undefined : PRESET_DAYS[preset],
  );

  return (
    <div>
      <div className="page-top">
        <div className="page-title">
          <h1>
            Overview{" "}
            {liveSessions.length > 0 && (
              <span className="chip live" data-testid="overview-live-chip">
                ● {liveSessions.length} live
              </span>
            )}
          </h1>
          <p className="page-sub">Limits, spend, and the one thing to do next.</p>
        </div>
        <div className="page-top-controls">
          <div className="date-range" aria-label="Date range">
            {(["24h", "7d", "30d", "all"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`date-preset-btn${preset === p ? " active" : ""}`}
                onClick={() => setPreset(p)}
                aria-pressed={preset === p}
              >
                {p === "all" ? "All" : p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {daemonError !== null && (
        <div className="banner banner-error" role="alert" aria-live="assertive">
          <span>⚠ Daemon unreachable — {daemonError}</span>
          <button className="banner-retry" type="button" onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {unconfirmedModels.length > 0 && (
        <div className="banner banner-info" role="note" data-testid="unconfirmed-models-banner">
          <span>
            {unconfirmedModels
              .map((m) =>
                m.tier === null
                  ? `New model ${m.model} is not priced: prices not confirmed.`
                  : `New model ${m.model} priced as ${m.tier}: prices not confirmed.`,
              )
              .join(" ")}
          </span>
        </div>
      )}

      {/* §1 Usage limits hero — always the first section, self-contained polling. */}
      <WidgetBoundary label="usage-limits">
        <UsageLimitsCard />
      </WidgetBoundary>

      {!isFirstRun && !showEarlyKpis && (isOnboardingStatusPending || isOverviewLoading) ? (
        <div
          className="grid g4 g4-lead"
          aria-busy="true"
          aria-label="Loading overview metrics"
          data-section-status="pending"
          style={{ marginTop: 24 }}
        >
          <div className="card kpi skeleton" style={{ height: 120 }} />
          <div className="card kpi skeleton" style={{ height: 120 }} />
          <div className="card kpi skeleton" style={{ height: 120 }} />
          <div className="card kpi skeleton" style={{ height: 120 }} />
        </div>
      ) : null}

      {/* §3 KPI strip */}
      {showMetrics && sections.kpis.state === "error" && (
        <WidgetErrorCard label="kpis" onRetry={refetch} />
      )}
      {(showMetrics || showEarlyKpis) && overviewData !== null && (
        <WidgetBoundary label="kpis">
          <section
            className="sec"
            aria-labelledby="this-period-title"
            aria-busy={query.isPlaceholderData}
          >
            <div className="sec-h">
              <h2 id="this-period-title">This period ({presetLabel})</h2>
              <span className="desc">
                {periodCoverage !== null && (
                  <span className="chip chip-plain" data-testid="coverage-chip">
                    {periodCoverage}
                  </span>
                )}{" "}
                <span className="chip est">Estimate · list price</span>
              </span>
            </div>
            <div className="grid g4 g4-lead">
              <KpiCard
                label={spendUnit === "usd" ? "Spend-equivalent" : "Token Spend"}
                metricId={spendUnit === "usd" ? "spend.equiv" : "spend.tokens"}
                dataMetric="spend.equiv"
                value={
                  spendUnit === "usd"
                    ? fmtUsd0(totalUsd)
                    : fmtTokensCompact((overviewData.cost_equiv_u ?? 0) / REF_PRICE_U_PER_TOKEN)
                }
                headerExtra={
                  <div className="seg seg-sm">
                    {(["usd", "tokens"] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        className={spendUnit === u ? "on" : ""}
                        aria-pressed={spendUnit === u}
                        onClick={() => setSpendUnit(u)}
                      >
                        {u === "usd" ? "$" : "Tokens"}
                      </button>
                    ))}
                  </div>
                }
                moreHref="#/overview"
                moreLabel="Spend by day ↓"
                onMoreClick={(event) => {
                  event.preventDefault();
                  setSpendTab("spend");
                  document.getElementById("spend-by-day")?.scrollIntoView?.();
                }}
                cmp={
                  preset === "all" ? (
                    "All recorded history"
                  ) : spendDeltaPct === null ? (
                    showEarlyKpis ? (
                      "Loading prior window…"
                    ) : (
                      "Prior window unavailable"
                    )
                  ) : (
                    <>
                      <span className={spendDeltaPct <= 0 ? "ok" : "bad"}>
                        {spendDeltaPct <= 0 ? "↓" : "↑"}
                        {Math.abs(Math.round(spendDeltaPct))}% vs prior {preset}
                      </span>{" "}
                      {spendPrior !== null &&
                        `(${
                          spendUnit === "usd"
                            ? fmtUsd0(spendPrior / 1_000_000)
                            : fmtTokensCompact(spendPrior / REF_PRICE_U_PER_TOKEN)
                        })`}
                    </>
                  )
                }
              >
                <Sparkline
                  current={sparkCurrent}
                  prior={sparkPrior}
                  dayDividers={preset === "7d"}
                />
                <div className="foot" style={{ marginTop: 0 }}>
                  Daily{spendUnit === "tokens" && " · weighted by model price"}
                  {preset !== "all" && ` · dashed = prior ${preset}`}
                  {preset === "7d" && " · dotted = day boundary"}
                </div>
                <WeeklyMaxLine
                  max={limits?.weeklyMax}
                  asOf={limits?.asOf ?? null}
                  unit={spendUnit}
                />
              </KpiCard>

              <KpiCard
                label="Sessions"
                metricId="sessions.count"
                dataMetric="sessions.count"
                value={sessionsCount === null ? "—" : sessionsCount.toLocaleString()}
                moreHref={expensiveHref}
                moreLabel="Most expensive →"
                {...(preset === "7d"
                  ? {
                      onMoreClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
                        event.preventDefault();
                        document.getElementById("expensive-sessions-title")?.scrollIntoView?.();
                      },
                    }
                  : {})}
                cmp={
                  preset === "all" ? (
                    "All recorded history"
                  ) : sessionDeltaPct === null ? (
                    showEarlyKpis ? (
                      "Loading prior window…"
                    ) : (
                      "Prior window unavailable"
                    )
                  ) : Math.round(sessionDeltaPct) === 0 ? (
                    `Flat vs prior ${preset}`
                  ) : (
                    <span>
                      {sessionDeltaPct < 0 ? "↓" : "↑"}
                      {Math.abs(Math.round(sessionDeltaPct))}% vs prior {preset}
                    </span>
                  )
                }
              >
                {concentration !== null && (
                  <>
                    {concentration.segments.length > 0 && (
                      <div
                        data-testid="sessions-cost-strip"
                        aria-label="Session spend, costliest first"
                        style={{
                          display: "flex",
                          height: 8,
                          overflow: "hidden",
                          borderRadius: "var(--r)",
                          marginTop: "var(--space-3)",
                        }}
                      >
                        {concentration.segments.map((cost, index) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 4-slot strip
                            key={index}
                            style={{
                              width: `${(cost / concentration.segments.reduce((a, b) => a + b, 0)) * 100}%`,
                              background: index < 3 ? SERIES[index] : "var(--muted)",
                              opacity: index < 3 ? 1 : 0.35,
                            }}
                          />
                        ))}
                      </div>
                    )}
                    <div className="foot">
                      {concentration.top3Share !== null &&
                        `Top 3 = ${Math.round(concentration.top3Share * 100)}% of spend · `}
                      median {fmtUsd0(concentration.median_u / 1_000_000)} (avg{" "}
                      {fmtUsd0(concentration.avg_u / 1_000_000)})
                    </div>
                  </>
                )}
              </KpiCard>

              <KpiCard
                label="Subagent spend"
                info="Sidechain turns are subagent and background calls. A larger share means more of this window's estimated cost came from those calls; open Sessions to inspect them."
                dataMetric="subagent.spend"
                value={subagentSpend ? fmtPct1(subagentSpend.share) : "—"}
                moreHref="#/sessions?sort=subagent&direction=desc"
                moreLabel="Sessions by subagent cost →"
                cmp={
                  subagentSpend
                    ? `${fmtUsd0(subagentSpend.sidechain_cost_u / 1_000_000)} of ${fmtUsd0(subagentSpend.total_cost_u / 1_000_000)} · in ${subagentSpend.sessions_with_sidechain_spend} of ${subagentSpend.sessions_in_window} sessions`
                    : "No spend data"
                }
              >
                {subagentSpend && subagentSpend.sidechain_cost_u > 0 && (
                  <>
                    <div
                      aria-label="Subagent spend by model family"
                      style={{
                        display: "flex",
                        height: 8,
                        overflow: "hidden",
                        borderRadius: "var(--r)",
                        marginTop: "var(--space-3)",
                      }}
                    >
                      {subagentSpend.by_model_family.map((row, index) => (
                        <span
                          key={row.family}
                          style={{
                            width: `${(row.cost_u / subagentSpend.sidechain_cost_u) * 100}%`,
                            background: SERIES[index % SERIES.length],
                          }}
                        />
                      ))}
                    </div>
                    <div
                      className="foot"
                      style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}
                    >
                      {subagentSpend.by_model_family.map((row, index) => (
                        <span key={row.family}>
                          <span aria-hidden="true" style={{ color: SERIES[index % SERIES.length] }}>
                            ●
                          </span>{" "}
                          {row.family} {fmtUsd0(row.cost_u / 1_000_000)}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </KpiCard>

              <SetupGradeCard />
            </div>
          </section>
        </WidgetBoundary>
      )}

      {/* Ranked recommendations */}
      {showMetrics &&
        (topRecs.state === "ok" ? (
          <WidgetBoundary label="recommendations">
            <TopRecommendations
              recommendations={topRecs.data.active}
              groupCount={topRecs.data.active_groups?.length}
              pipelineIsIncomplete={pipelineIsIncomplete}
              freshness={topRecs.freshness}
              entering={topRecsEntering}
              onEffectMutated={() =>
                void queryClient.invalidateQueries({ queryKey: ["overview-view"] })
              }
            />
          </WidgetBoundary>
        ) : topRecs.state === "error" ? (
          <WidgetErrorCard label="recommendations" onRetry={refetch} />
        ) : (
          <TopRecommendationsSkeleton
            load={
              topRecs.state === "pending"
                ? {
                    kind: "building",
                    label: "Building recommendations",
                    startedAt: topRecs.progress?.started_at,
                    expectedMs: topRecs.progress?.expected_ms,
                  }
                : null
            }
          />
        ))}

      {/* Most expensive sessions this week */}
      {showMetrics &&
        (sections.weekly_sessions.state === "ok" ? (
          <WidgetBoundary label="expensive-sessions">
            <ExpensiveSessions
              sessions={sections.weekly_sessions.data.rows}
              windowCostU={sections.weekly_sessions.data.cost_equiv_u}
            />
          </WidgetBoundary>
        ) : (
          <WidgetErrorCard label="expensive-sessions" onRetry={refetch} />
        ))}

      {/* Across the dashboard */}
      {showMetrics &&
        (overviewData === null ? (
          <WidgetErrorCard label="across-dashboard" onRetry={refetch} />
        ) : topRecs.state === "pending" ? (
          <section
            className="sec"
            aria-busy="true"
            aria-label="Loading the dashboard summary"
            data-section-status="pending"
          >
            <div className="card skeleton" style={{ height: 120 }} />
          </section>
        ) : (
          <WidgetBoundary label="across-dashboard">
            <AcrossDashboard
              overview={overviewData}
              adopted={topRecs.state === "ok" ? topRecs.data.adopted : []}
              usageSource={usageSource}
              linkageRate={linkageRate}
              calibrationDriftPoints={calibrationDriftPoints}
              haikuSidechainTurns={overviewData.subagent_spend?.haiku_sidechain_turns ?? null}
            />
          </WidgetBoundary>
        ))}

      {showMetrics && overviewData !== null && overviewData.cost_equiv_u === 0 && (
        <output className="banner banner-info">
          <span>
            No metrics for this window yet — try a wider window or check back after more sessions
            are ingested.
          </span>
        </output>
      )}

      {/* §4 Context per turn */}
      {showMetrics &&
        (overviewData === null ? (
          <WidgetErrorCard label="context-per-turn" onRetry={refetch} />
        ) : (
          <WidgetBoundary label="context-per-turn">
            <ContextPerTurnTable rows={ctxRows} totalUsd={totalUsd} />
          </WidgetBoundary>
        ))}

      {/* §5 Where your tokens go */}
      {showMetrics &&
        (sections.flavor.state === "error" ? (
          <WidgetErrorCard label="token-breakdown" onRetry={refetch} />
        ) : (
          <WidgetBoundary label="token-breakdown">
            <TokensGoSection flavor={flavorData} />
          </WidgetBoundary>
        ))}

      {/* §6 Spend by day */}
      {showMetrics && sections.trends.state === "error" && (
        <WidgetErrorCard label="trends" onRetry={refetch} />
      )}
      {showMetrics && sections.trends.state !== "error" && (
        <WidgetBoundary label="trends">
          <SpendByDayCard
            trend={trendData}
            cacheWrite={cacheWriteData}
            workspaceLabels={workspaceLabels}
            tab={spendTab}
            setTab={setSpendTab}
            preset={preset}
            now={serverNow}
            d8SavingsU={d8SavingsU}
          />
        </WidgetBoundary>
      )}

      {/* Live strip */}
      <WidgetBoundary label="live-sessions">
        <LiveStrip
          sessions={liveSessions}
          isLoading={isLiveLoading}
          isPending={isOverviewPending}
          error={
            liveRefreshError ??
            (sections.live.state === "error" ? "Live sessions unavailable" : null)
          }
          lastFetchedAt={
            query.dataUpdatedAt === 0
              ? undefined
              : Math.max(query.dataUpdatedAt, liveQuery.dataUpdatedAt)
          }
          onSelectSession={onSelectSession}
        />
      </WidgetBoundary>

      {/* Onboarding / scan status */}
      {!isFirstRun && onboardingStatus !== null && <ScanStatus status={onboardingStatus} />}
      {isFirstRun && onboardingStatus !== null && (
        <FirstRunWelcome
          status={onboardingStatus}
          limitCalibrated={
            ((overviewData?.forecast as unknown as ForecastFromDbResult | undefined)?.state ??
              "OFF") !== "OFF"
          }
          tokenConfigured={githubTokenConfigured}
          hookInstalled={hookConfig?.installed ?? false}
        />
      )}

      {/* §7 Workspaces */}
      {showMetrics && sections.workspaces.state === "error" && (
        <WidgetErrorCard label="workspaces" onRetry={refetch} />
      )}
      {showMetrics && sections.workspaces.state === "ok" && (
        <WidgetBoundary label="workspaces">
          <section className="sec" aria-labelledby="workspaces-title">
            <div className="sec-h">
              <h2 id="workspaces-title">
                <a href="#/workspaces">Workspaces</a>
              </h2>
              <span className="desc">
                <span className="chip est">Estimate</span>
                {pipelineIsIncomplete && <PartialBadge variant="may-change" />}
              </span>
            </div>
            <WorkspaceTable
              workspaces={liveWorkspaceItems.slice(0, 3)}
              globalCostU={overviewData?.cost_equiv_u ?? 0}
              globalTurns={overviewData?.turns ?? 0}
              isLoading={false}
              topRecByWorkspace={topRecByWorkspace}
              teaser
              hideHeader
            />
          </section>
        </WidgetBoundary>
      )}

      {/* §8 Data notes */}
      {showMetrics && (
        <WidgetBoundary label="data-notes">
          <DataNotes flavor={flavorData} />
        </WidgetBoundary>
      )}
    </div>
  );
}
