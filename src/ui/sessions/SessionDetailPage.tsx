import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SessionDiagnosticAnchor } from "../../query/api/diagnostics";
import type { EsfObservationCohort } from "../../query/api/esf-observations";
import type { PagedList, SessionSummary, TurnRow } from "../../query/api/overview";
import type { RecommendationCard } from "../../query/api/recommendations";
import type { SessionSpendPercentile } from "../../query/api/self-percentiles";
import type { SessionBreakdown } from "../../query/api/session-breakdown";
import type { SessionDriver, SessionDrivers } from "../../query/api/session-drivers";
import type { SessionStory } from "../../query/api/session-story";
import type { ApiResponse } from "../../query/envelope";
import {
  fetchRecommendations,
  fetchSession,
  fetchSessionBreakdown,
  fetchSessionDiagnostics,
  fetchSessionDrivers,
  fetchSessionStory,
  fetchSpendPercentile,
  fetchTurnTimeline,
} from "../api/client";
import { readSessionSeed } from "../api/drilldown-seed";
import { fetchSessionEsfObservations } from "../api/esf-client";
import { useInViewPrefetch } from "../api/prefetch";
import { queryClient } from "../api/query-client";
import { queryKeys } from "../api/query-keys";
import { shortId } from "../lib/short-id";
import { type WorkspaceLabelInput, workspaceLabel } from "../lib/workspace-label";
import { KpiCard } from "../overview/KpiCard";
import { gridProps, seriesPalette } from "../overview/chart-theme";
import { buildSessionPrompt } from "../recommendations/prompt-templates";
import AsyncErrorState from "../shell/AsyncErrorState";
import Chip from "../shell/Chip";
import { ChartAfterPaint, NextTask } from "../shell/DeferredChart";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock } from "../shell/Skeleton";
import { FRICTION_TOOLTIP, FrictionCell, type FrictionCounts, frictionBand } from "./FrictionCell";
import {
  FilesEditedCard,
  InvestigateCard,
  ObservedEvidenceCard,
  SessionFactsCard,
  type TurnPricing,
} from "./SessionOverview";
import {
  AnomaliesPanel,
  CostBreakdownPanel,
  type PanelState,
  PatternRecommendationsPanel,
  ToolBreakdownPanel,
} from "./SessionPanels";
import {
  ErrorGroupsPanel,
  MoneyCard,
  SessionContextCostChart,
  StoryHeaderDetails,
  turnTicks,
} from "./SessionStory";
import { SessionSwimlane } from "./SessionSwimlane";
import { SpendPercentileChip, topSpendPercent } from "./SpendPercentileChip";

/** A detail read through its query key: reuses a fresh (prefetched) body, dedupes in-flight. */
function detailRead<T>(queryKey: QueryKey, fn: () => Promise<T>): Promise<T> {
  return queryClient.fetchQuery({ queryKey, queryFn: () => Promise.resolve(fn()) });
}

/** null when the session has no turns in the observation set (e.g. still LIVE). */
function toPricing(response: ApiResponse<EsfObservationCohort>): TurnPricing | null {
  const resource = response.data?.resource;
  if (resource === undefined || resource.selected_session_count === 0) return null;
  return {
    priced_turn_count: resource.priced_turn_count,
    unpriced_turn_count: resource.unpriced_turn_count,
  };
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: T };

function usd(value: number | null): string {
  if (value === null) return "N/A";
  return `$${(value / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function tokens(value: number): string {
  return value.toLocaleString("en-US");
}

function fmtTokensCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function duration(first: string | null, last: string | null): string {
  if (first === null || last === null) return "N/A";
  const elapsedMs = Math.max(new Date(last).getTime() - new Date(first).getTime(), 0);
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function labelWorkspace(session: SessionSummary & WorkspaceLabelInput): string {
  const remote = workspaceLabel({
    workspace_id: session.workspace_id,
    repo_owner: session.repo_owner ?? null,
    repo_name: session.repo_name ?? null,
    repo_path: session.repo_path ?? null,
    repo_canonical: session.repo_canonical ?? null,
  });
  const local = session.repo_path?.split(/[\\/]/).filter(Boolean).pop();
  return local && local !== remote && session.repo_owner && session.repo_name
    ? `${local} (${remote})`
    : remote;
}

function claimChip(turn: TurnRow) {
  if (turn.provisional) return <Chip kind="LIVE" label="LIVE" />;
  if (turn.cost_claim === "LIST_EQUIV_STALE") {
    return <Chip kind="LIST_EQUIV_STALE" />;
  }
  if (turn.cost_claim === "LIST_EQUIV") {
    return <Chip kind="LIST_EQUIV" />;
  }
  return <span>{COST_CLAIM_LABEL[turn.cost_claim] ?? turn.cost_claim}</span>;
}

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value);
}

function severityColor(share: number | null): string {
  if (share === null) return "var(--green)";
  if (share >= 0.5) return "var(--red)";
  if (share >= 0.25) return "var(--amber)";
  return "var(--green)";
}

function fmtMeasuredValue(value: number | string | boolean): string {
  if (typeof value === "number") return value.toLocaleString("en-US");
  return String(value);
}

// ---------------------------------------------------------------------------
// Label maps (DUI-15)
// ---------------------------------------------------------------------------

const COST_CLAIM_LABEL: Record<string, string> = {
  PARTIAL: "Partial estimate",
  PROXY: "Proxy estimate",
};

const DRIVER_LABEL: Record<string, string> = {
  CACHE_WRITE_CHURN: "Cache-write churn",
  LOOP_RETRY_WASTE: "Loop / retry waste",
  TOOL_RESULT_BLOAT: "Tool-result bloat",
  SESSION_LONG_FULL_CONTEXT: "Long session near context limit",
};

const MEASURED_FIELD_LABEL: Record<string, string> = {
  churn_event_count: "Cache-write events",
  total_churn_creation_tokens: "Churn tokens written",
  creation_share: "Share of cache-creation cost",
  loop_flagged_turn_count: "Flagged turns",
  repeat_excess_event_count: "Repeated calls",
  total_turn_count: "Turns in workspace pattern",
};

function DriverRow({ driver }: { driver: SessionDriver }) {
  const measureEntries = Object.entries(driver.measured).slice(0, 3);
  const routeHref =
    driver.routing === "rec_card"
      ? `#/recommendations?focus=${encodeURIComponent(driver.rec_id)}`
      : "#/settings";
  const routeLabel = driver.routing === "rec_card" ? "View rec" : "Install hook";

  return (
    <div
      className="cost-driver-row"
      data-testid="cost-driver-row"
      data-detector={driver.detector_id}
    >
      <span
        className="driver-severity-dot"
        aria-label={`severity ${driver.share !== null ? Math.round(driver.share * 100) : 0}%`}
        style={{ background: severityColor(driver.share) }}
      />
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 600, fontSize: 12 }}>
          {DRIVER_LABEL[driver.label] ?? driver.label}
        </span>
        {driver.share !== null && (
          <span className="driver-share">{Math.round(driver.share * 100)}% share</span>
        )}
        <div style={{ color: "var(--text-muted)" }}>
          {driver.session_cost_u === undefined
            ? "—"
            : `$${(driver.session_cost_u / 1_000_000).toFixed(2)} spent on this in this session`}
          <InfoTip
            label="Per-session driver cost"
            content="Sum of this session's estimated turn costs on turns flagged by this detector. Driver amounts can overlap and should not be added together. A dash means this detector has no per-turn cost rule."
          />
        </div>
        <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)" }}>
          {measureEntries.map(([key, val]) => (
            <span key={key} style={{ marginRight: 12 }}>
              {MEASURED_FIELD_LABEL[key] ?? key}
              {key === "total_turn_count" && (
                <InfoTip
                  label="What Turns in workspace pattern counts"
                  content="Counts turns across every session in this workspace pattern, not this session's total."
                />
              )}
              : {fmtMeasuredValue(val)}
            </span>
          ))}
        </div>
      </div>
      <a
        href={routeHref}
        className="btn-secondary driver-route-link"
        data-testid={`driver-route-${driver.routing}`}
        data-rec-id={driver.routing === "rec_card" ? driver.rec_id : undefined}
      >
        {routeLabel}
      </a>
    </div>
  );
}

function CostDriversPanel({ drivers }: { drivers: SessionDrivers }) {
  return (
    <section className="sec" data-testid="cost-drivers-panel">
      <div className="sec-h">
        <h2>
          Cost drivers{" "}
          <InfoTip
            label="What the cost-drivers panel shows"
            content="Shows where this session's estimated value came from: context sent again, cache writes, and model choice. Start with the largest item."
          />
        </h2>
        <span className="desc sec-h-controls">
          <Chip kind="OBS_PROXY" />
          <span className="section-meta">p{drivers.percentile.toFixed(0)}</span>
        </span>
      </div>
      <div className="card">
        <div style={{ padding: "12px 16px 0" }}>
          {drivers.drivers.map((driver) => (
            <DriverRow key={driver.detector_id} driver={driver} />
          ))}
        </div>
        <div style={{ padding: "12px 16px 16px" }}>
          <p className="kpi-fn" style={{ margin: 0 }}>
            Each figure is a separate signal. Do not add them together. The investigate prompt above
            includes these drivers.
          </p>
        </div>
      </div>
    </section>
  );
}

interface ContextGrowthRow extends TurnRow {
  idx: number;
  cache_write_total: number;
  main_context_tokens: number | null;
  subagent_context_tokens: number | null;
}

interface ContextTestObservation extends ContextGrowthRow {
  observation_key: string;
  observation_kind: "failure" | "pass";
}

const OBSERVED_TEST_EVENT_CAVEAT =
  "Test outcomes are separate from task success or failure. 'Failed then passed' only means a later test pass was observed; it does not link the tests.";

function contextGrowthRows(turns: TurnRow[]): ContextGrowthRow[] {
  return turns.map((turn, index) => ({
    ...turn,
    idx: index + 1,
    cache_write_total: turn.cache_write_5m + turn.cache_write_1h + turn.cache_write_other,
    main_context_tokens: turn.is_sidechain ? null : turn.context_tokens,
    subagent_context_tokens: turn.is_sidechain ? turn.context_tokens : null,
  }));
}

function observedCompletedTestEvents(
  rows: ContextGrowthRow[],
  kind: "failure" | "pass",
): ContextTestObservation[] {
  return rows.flatMap((row) => {
    const count = (kind === "failure" ? row.test_fail_events : row.test_pass_events) ?? 0;
    return count > 0
      ? [{ ...row, observation_key: `${row.message_id}-${kind}`, observation_kind: kind }]
      : [];
  });
}

function ObservedTestEventGlyph({
  cx,
  cy,
  payload,
}: {
  cx: number | undefined;
  cy: number | undefined;
  payload?: unknown;
}) {
  if (cx === undefined || cy === undefined || payload === undefined) return null;
  const observation = payload as ContextTestObservation;
  const points = `${cx},${cy - 4} ${cx + 4},${cy} ${cx},${cy + 4} ${cx - 4},${cy}`;
  const failure = observation.observation_kind === "failure";
  return (
    <g
      data-testid="timeline-observation-marker"
      data-turn={observation.idx}
      data-observation-kind={observation.observation_kind}
      aria-label={`Observed completed-test ${failure ? "failure" : "pass"} at turn ${observation.idx}`}
    >
      <title>{OBSERVED_TEST_EVENT_CAVEAT}</title>
      <polygon
        points={points}
        aria-label={`Observed completed-test ${failure ? "failure" : "pass"} at turn ${observation.idx}`}
        fill={failure ? "var(--text-muted)" : "var(--panel)"}
        stroke="var(--text-muted)"
        strokeWidth={1.5}
      />
    </g>
  );
}

interface ContextGrowthTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ContextGrowthRow }>;
}

function ContextGrowthTooltip({ active, payload }: ContextGrowthTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || row === undefined) return null;

  return (
    <div
      style={{
        background: "var(--panel2)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "6px 8px",
        color: "var(--text)",
        fontSize: 11,
      }}
    >
      {`Turn ${row.idx} (${row.is_sidechain ? "subagent" : "main"}) — Context: ${fmtTokensCompact(row.context_tokens)} | Cache write: ${
        row.cache_write_total > 0 ? "yes" : "no"
      }`}
    </div>
  );
}

function SignalGlyph({
  cx,
  cy,
  payload,
  kind,
}: {
  cx?: number | undefined;
  cy?: number | undefined;
  payload?: unknown;
  kind: "tool-error" | "loop";
}) {
  if (cx === undefined || cy === undefined || payload === undefined) return null;
  const row = payload as ContextGrowthRow;
  const color = kind === "tool-error" ? "var(--red)" : "var(--amber)";
  return (
    <g
      data-testid="session-chart-marker"
      data-kind={kind}
      data-turn={row.idx}
      aria-label={`${kind === "tool-error" ? "Tool error" : "Loop"} at turn ${row.idx}`}
    >
      <title>
        {kind === "tool-error" ? "Tool error" : "Loop flagged"} at turn {row.idx}
      </title>
      <circle
        cx={cx}
        cy={cy}
        r={5}
        aria-label={`${kind === "tool-error" ? "Tool error" : "Loop"} marker at turn ${row.idx}`}
        fill="var(--panel)"
        stroke={color}
        strokeWidth={2}
      />
      {kind === "tool-error" ? (
        <path
          d={`M${cx - 2},${cy - 2}l4,4m0,-4l-4,4`}
          aria-label={`Tool error at turn ${row.idx}`}
          stroke={color}
          strokeWidth={1.5}
        />
      ) : (
        <circle cx={cx} cy={cy} r={2} aria-label={`Loop at turn ${row.idx}`} fill={color} />
      )}
    </g>
  );
}

export function ContextGrowthChart({
  turns,
  compactionCount = 0,
  totalTurns,
  partial = false,
  compactionTurnIndices = [],
  toolErrorTurnIndices = [],
  loopTurnIndices = [],
}: {
  turns: TurnRow[];
  compactionCount?: number;
  totalTurns?: number;
  partial?: boolean;
  compactionTurnIndices?: number[];
  toolErrorTurnIndices?: number[];
  loopTurnIndices?: number[];
}) {
  if (turns.length === 0) return null;

  const rows = contextGrowthRows(turns);
  const cacheWriteRows = rows.filter((row) => row.cache_write_total > 0);
  const testFailureRows = observedCompletedTestEvents(rows, "failure");
  const testPassRows = observedCompletedTestEvents(rows, "pass");
  const loaded = (indices: number[]) =>
    [...new Set(indices)].filter(
      (index) => Number.isInteger(index) && index >= 0 && index < rows.length,
    );
  const errorRows = loaded(toolErrorTurnIndices).map((index) => rows[index]);
  const loopRows = loaded(loopTurnIndices).map((index) => rows[index]);
  const compactionRows = loaded(compactionTurnIndices);
  const hasSubagents = rows.some((row) => row.is_sidechain);
  const hasMain = rows.some((row) => !row.is_sidechain);
  const compactionNote = compactionCount > 0 ? ` · ${compactionCount} compaction(s)` : "";

  return (
    <section className="sec" id="session-context-chart" data-testid="context-growth-chart">
      <div className="sec-h">
        <h2>
          Context per turn{" "}
          <InfoTip
            label="What the context-growth chart shows"
            content="Context size for each turn. Main and subagent turns have separate lines because their contexts are independent. A steep climb in either line can be a reason to use /clear or split the task."
          />
        </h2>
        <span className="desc">
          <Chip kind="OBS_PROXY" />
        </span>
      </div>
      <div className="card">
        <ChartAfterPaint height={130}>
          {(width) => (
            <ComposedChart
              width={width}
              height={130}
              data={rows}
              margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid {...gridProps.grid} />
              <XAxis
                dataKey="idx"
                type="number"
                allowDecimals={false}
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                ticks={turnTicks(rows.length, width)}
                interval={0}
                tickFormatter={(value: number) => `Turn ${value}`}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                dataKey="context_tokens"
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                tickFormatter={fmtTokensCompact}
                interval={0}
                width={54}
              />
              <NextTask>
                <Tooltip content={<ContextGrowthTooltip />} />
                {compactionRows.map((index) => (
                  <ReferenceLine
                    key={`compaction-${index}`}
                    x={index + 1}
                    stroke="var(--violet)"
                    strokeDasharray="4 4"
                    label={{ value: "Compact", fill: "var(--violet)", position: "insideTopLeft" }}
                  />
                ))}
                {hasMain && (
                  <Line
                    type="monotone"
                    dataKey="main_context_tokens"
                    name="Main context"
                    stroke={seriesPalette[0]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
                {hasSubagents && (
                  <Line
                    type="monotone"
                    dataKey="subagent_context_tokens"
                    name="Subagent context"
                    stroke="var(--violet)"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
                {cacheWriteRows.length > 0 && (
                  <Scatter
                    data={cacheWriteRows}
                    dataKey="context_tokens"
                    name="Cache write"
                    fill="var(--amber)"
                    isAnimationActive={false}
                  />
                )}
                {testFailureRows.length > 0 && (
                  <Scatter
                    data={testFailureRows}
                    dataKey="context_tokens"
                    name="Observed completed-test failure"
                    fill="var(--text-muted)"
                    shape={ObservedTestEventGlyph}
                    isAnimationActive={false}
                  />
                )}
                {testPassRows.length > 0 && (
                  <Scatter
                    data={testPassRows}
                    dataKey="context_tokens"
                    name="Observed completed-test pass"
                    fill="var(--text-muted)"
                    shape={ObservedTestEventGlyph}
                    isAnimationActive={false}
                  />
                )}
                {errorRows.length > 0 && (
                  <Scatter
                    data={errorRows}
                    dataKey="context_tokens"
                    name="Tool error"
                    shape={(props: {
                      cx?: number | undefined;
                      cy?: number | undefined;
                      payload?: unknown;
                    }) => <SignalGlyph {...props} kind="tool-error" />}
                    isAnimationActive={false}
                  />
                )}
                {loopRows.length > 0 && (
                  <Scatter
                    data={loopRows}
                    dataKey="context_tokens"
                    name="Loop"
                    shape={(props: {
                      cx?: number | undefined;
                      cy?: number | undefined;
                      payload?: unknown;
                    }) => <SignalGlyph {...props} kind="loop" />}
                    isAnimationActive={false}
                  />
                )}
              </NextTask>
              <ReferenceLine
                y={160_000}
                stroke="var(--red)"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={{ value: "160K warning", fill: "var(--red)", position: "insideTopRight" }}
              />
            </ComposedChart>
          )}
        </ChartAfterPaint>
        {partial && totalTurns !== undefined && (
          <p className="section-meta">
            Chart covers {turns.length} of {totalTurns} turns
          </p>
        )}
        <p className="kpi-fn" style={{ margin: "0 16px 12px" }}>
          {`Context per turn · ${hasMain ? "solid: main" : ""}${hasMain && hasSubagents ? " · " : ""}${hasSubagents ? "dashed violet: subagent" : ""} · red line marks 80% of the 200K context window${compactionNote}`}
          {cacheWriteRows.length > 0 && <span> · amber dots: cache write</span>}
          {(testFailureRows.length > 0 || testPassRows.length > 0) && (
            <span data-testid="timeline-observation-legend">
              {testFailureRows.length > 0 && " · ◆ observed completed-test failure"}
              {testPassRows.length > 0 && " · ◇ observed completed-test pass"}
              {" — observations, not task outcomes"}
            </span>
          )}
          {compactionRows.length > 0 && <span> · vertical violet: compaction</span>}
          {errorRows.length > 0 && <span> · red: tool error</span>}
          {loopRows.length > 0 && <span> · amber ring: loop</span>}
        </p>
      </div>
    </section>
  );
}

export default function SessionDetailPage({
  sessionId,
  onBack,
  backLabel = "Back",
  anchorMessageId = null,
  anchorTurnIndex = null,
}: {
  sessionId: string;
  onBack: () => void;
  backLabel?: string;
  anchorMessageId?: string | null;
  anchorTurnIndex?: number | null;
}) {
  const [sessionState, setSessionState] = useState<LoadState<ApiResponse<SessionSummary>>>({
    status: "loading",
  });
  const [timelineState, setTimelineState] = useState<LoadState<ApiResponse<PagedList<TurnRow>>>>({
    status: "loading",
  });
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [visibleCount, setVisibleCount] = useState(100);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [driversData, setDriversData] = useState<SessionDrivers | null>(null);
  const [diagnosticsState, setDiagnosticsState] = useState<PanelState<SessionDiagnosticAnchor[]>>({
    status: "loading",
  });
  const [breakdownState, setBreakdownState] = useState<PanelState<SessionBreakdown | null>>({
    status: "loading",
  });
  const [recommendationsState, setRecommendationsState] = useState<
    PanelState<RecommendationCard[]>
  >({ status: "loading" });
  const [spendPercentile, setSpendPercentile] = useState<SessionSpendPercentile | null>(null);
  const [storyState, setStoryState] = useState<PanelState<SessionStory | null>>({
    status: "loading",
  });
  const [pricingState, setPricingState] = useState<PanelState<TurnPricing | null>>({
    status: "loading",
  });
  const [showTurns, setShowTurns] = useState(false);
  const anchorRowRef = useRef<HTMLTableRowElement>(null);
  const requestScopeRef = useRef<{ cancelled: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const requestScope = { cancelled: false };
    requestScopeRef.current = requestScope;
    setSessionState({ status: "loading" });
    setTimelineState({ status: "loading" });
    setTurns([]);
    setVisibleCount(100);
    setNextCursor(null);
    setPaginationError(null);
    setDriversData(null);
    setDiagnosticsState({ status: "loading" });
    setBreakdownState({ status: "loading" });
    setRecommendationsState({ status: "loading" });
    setSpendPercentile(null);
    setStoryState({ status: "loading" });
    setPricingState({ status: "loading" });
    setShowTurns(false);

    void Promise.resolve(fetchSessionDiagnostics(sessionId))
      .then((value) => {
        if (!cancelled) setDiagnosticsState({ status: "ok", value: value?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setDiagnosticsState({ status: "error" });
      });
    void Promise.resolve(fetchSessionBreakdown(sessionId))
      .then((value) => {
        if (!cancelled) setBreakdownState({ status: "ok", value: value?.data ?? null });
      })
      .catch(() => {
        if (!cancelled) setBreakdownState({ status: "error" });
      });
    void Promise.resolve(fetchRecommendations())
      .then((value) => {
        if (!cancelled) setRecommendationsState({ status: "ok", value: value?.data?.active ?? [] });
      })
      .catch(() => {
        if (!cancelled) setRecommendationsState({ status: "error" });
      });

    // P1-U6a: the four reads start together (no session → turns → drivers → percentile chain),
    // through the detail query keys so a row's hover/focus prefetch is reused.
    void detailRead(queryKeys.session(sessionId), () => fetchSession(sessionId))
      .then((value) => {
        if (!cancelled) setSessionState({ status: "ok", value });
      })
      .catch((error: unknown) => {
        if (!cancelled) setSessionState({ status: "error", message: String(error) });
      });

    // An anchor deep link reads every turn through the anchor's page in one request; if the
    // anchor is unknown it falls back to the first page (the walk below then continues).
    const seek =
      anchorMessageId !== null
        ? { anchor: anchorMessageId }
        : anchorTurnIndex !== null
          ? { turn_index: anchorTurnIndex }
          : null;
    const firstPage = () =>
      detailRead(queryKeys.sessionTurns(sessionId, "first"), () => fetchTurnTimeline(sessionId));
    const timeline =
      seek === null
        ? firstPage()
        : detailRead(
            queryKeys.sessionTurns(
              sessionId,
              "anchor" in seek ? `anchor:${seek.anchor}` : `index:${seek.turn_index}`,
            ),
            () => fetchTurnTimeline(sessionId, seek),
          ).catch(firstPage);
    void timeline
      .then((timelineValue) => {
        if (cancelled) return;
        setTimelineState({ status: "ok", value: timelineValue });
        setTurns(timelineValue.data?.items ?? []);
        setNextCursor(timelineValue.data?.next_cursor ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTimelineState({ status: "error", message: String(error) });
      });

    void detailRead(queryKeys.sessionDrivers(sessionId), () => fetchSessionDrivers(sessionId))
      .then((driversValue) => {
        if (!cancelled) setDriversData(driversValue?.data ?? null);
      })
      .catch(() => {
        // Drivers fetch failure is non-fatal — panel simply absent.
      });

    void detailRead(queryKeys.sessionPercentile(sessionId), () => fetchSpendPercentile(sessionId))
      .then((percentileValue) => {
        if (!cancelled) setSpendPercentile(percentileValue);
      })
      .catch(() => {
        // Percentile fetch failure is non-fatal — chip simply absent.
      });

    void detailRead(queryKeys.sessionStory(sessionId), () => fetchSessionStory(sessionId))
      .then((story) => {
        if (!cancelled) setStoryState({ status: "ok", value: story });
      })
      .catch(() => {
        if (!cancelled) setStoryState({ status: "error" });
      });

    void fetchSessionEsfObservations(sessionId)
      .then((value) => {
        if (!cancelled) setPricingState({ status: "ok", value: toPricing(value) });
      })
      .catch(() => {
        if (!cancelled) setPricingState({ status: "error" });
      });

    return () => {
      cancelled = true;
      requestScope.cancelled = true;
    };
  }, [sessionId, anchorMessageId, anchorTurnIndex]);

  const loadMore = () => {
    if (visibleCount < turns.length) {
      setVisibleCount((count) => count + 100);
      return;
    }
    if (nextCursor === null || loadingMore) return;
    const after = nextCursor;
    setLoadingMore(true);
    setPaginationError(null);
    detailRead(queryKeys.sessionTurns(sessionId, `after:${after}`), () =>
      fetchTurnTimeline(sessionId, { after }),
    )
      .then((value) => {
        setTurns((prior) => [...prior, ...(value.data?.items ?? [])]);
        setNextCursor(value.data?.next_cursor ?? null);
      })
      .catch((error: unknown) => setPaginationError(String(error)))
      .finally(() => setLoadingMore(false));
  };
  // P1-U6a: once every loaded turn is shown, "Load more" prefetches the next cursor in view.
  const loadMoreRef = useInViewPrefetch(
    () =>
      nextCursor === null || visibleCount < turns.length
        ? null
        : [
            {
              queryKey: queryKeys.sessionTurns(sessionId, `after:${nextCursor}`),
              queryFn: (signal) => fetchTurnTimeline(sessionId, { after: nextCursor }, signal),
            },
          ],
    `${nextCursor}|${visibleCount >= turns.length}`,
  );

  const anchoredTurnIndex =
    anchorMessageId !== null
      ? turns.findIndex((turn) => turn.message_id === anchorMessageId)
      : anchorTurnIndex !== null && anchorTurnIndex < turns.length
        ? anchorTurnIndex
        : -1;
  useEffect(() => {
    const hasAnchor = anchorMessageId !== null || anchorTurnIndex !== null;
    if (!hasAnchor || anchoredTurnIndex >= 0 || nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setPaginationError(null);
    fetchTurnTimeline(sessionId, { after: nextCursor })
      .then((value) => {
        setTurns((prior) => [...prior, ...(value.data?.items ?? [])]);
        setNextCursor(value.data?.next_cursor ?? null);
      })
      .catch((error: unknown) => {
        setPaginationError(String(error));
        setNextCursor(null);
      })
      .finally(() => setLoadingMore(false));
  }, [anchorMessageId, anchorTurnIndex, anchoredTurnIndex, loadingMore, nextCursor, sessionId]);
  useEffect(() => {
    if (anchoredTurnIndex < 0) return;
    if (visibleCount <= anchoredTurnIndex) {
      setVisibleCount(anchoredTurnIndex + 1);
      return;
    }
    const target = anchorRowRef.current;
    if (target === null) return;
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
  }, [anchoredTurnIndex, visibleCount]);

  if (sessionState.status === "loading") {
    // P1-U6a: the clicked row's values paint the header at once; the rest stays a skeleton.
    const seed = readSessionSeed(sessionId);
    if (seed !== undefined) {
      return (
        <section aria-busy="true" aria-label="Loading session detail">
          <button type="button" className="btn-secondary page-back" onClick={onBack}>
            <span aria-hidden="true">← </span>
            {backLabel}
          </button>
          <div className="page-top">
            <div className="page-title">
              <h1>{shortId(seed.session_id)}</h1>
              <p className="page-sub">
                <a href={`#/workspaces/${encodeURIComponent(seed.workspace_id)}`}>
                  {workspaceLabel({
                    workspace_id: seed.workspace_id,
                    repo_owner: seed.repo_owner,
                    repo_name: seed.repo_name,
                  })}
                </a>
              </p>
            </div>
          </div>
          <div className="grid g4">
            <KpiCard
              label="Turns"
              info="The number of main-conversation turns in this session. More turns is not worse on its own — read it alongside estimated cost and context to judge effort."
              value={tokens(seed.turn_count)}
            />
            <KpiCard
              label="Estimated cost"
              info="Estimated cost at public API list prices, not your bill. Use it to compare session costs and decide which are worth improving first."
              value={usd(seed.cost_equiv_u)}
            />
            <KpiCard
              label="Duration"
              info="Wall-clock time between the first and last observed turn. Idle gaps can inflate it, so it is not a measure of effort or cost."
              value={duration(seed.first_turn_at, seed.last_turn_at)}
            />
            <KpiCard
              label="Cost percentile"
              info="How this session's estimated cost compares with your other sessions in the same workspace over the past 90 days. Not a bill; use it to spot standout sessions."
              value="—"
            />
          </div>
          <SkeletonBlock height={180} />
        </section>
      );
    }
    return (
      <div className="session-detail" aria-busy="true" aria-label="Loading session detail">
        <SkeletonBlock height={180} />
      </div>
    );
  }
  if (sessionState.status === "error") {
    return (
      <AsyncErrorState
        resource="session-detail"
        onRetry={() => {
          const requestScope = requestScopeRef.current;
          if (!requestScope || requestScope.cancelled) return;
          setSessionState({ status: "loading" });
          void fetchSession(sessionId)
            .then((value) => {
              if (!requestScope.cancelled) setSessionState({ status: "ok", value });
            })
            .catch((error: unknown) => {
              if (!requestScope.cancelled) {
                setSessionState({ status: "error", message: String(error) });
              }
            });
        }}
      />
    );
  }

  const session = sessionState.value.data;
  if (session === null) {
    return (
      <div className="empty-state session-detail-empty">
        <span className="empty-state-text">Session not found.</span>
        <button type="button" className="btn-secondary" onClick={onBack}>
          {backLabel}
        </button>
      </div>
    );
  }

  const story = storyState.status === "ok" ? storyState.value : null;
  const loopTurnIndices =
    breakdownState.status === "ok" ? (breakdownState.value?.loop_turn_indices ?? []) : [];
  const cacheWrite = (turn: TurnRow) =>
    turn.cache_write_5m + turn.cache_write_1h + turn.cache_write_other;
  const visibleTurns = turns.slice(0, visibleCount);
  const matchedRecommendations =
    recommendationsState.status === "ok"
      ? recommendationsState.value.filter(
          (rec) =>
            (rec.scope_workspace_id === null ||
              rec.scope_workspace_id === driversData?.workspace_id) &&
            driversData?.drivers.some((driver) => driver.detector_id === rec.detector_id),
        )
      : [];
  const retryDiagnostics = () => {
    const requestScope = requestScopeRef.current;
    if (!requestScope || requestScope.cancelled) return;
    setDiagnosticsState({ status: "loading" });
    void fetchSessionDiagnostics(sessionId)
      .then((value) => {
        if (!requestScope.cancelled) setDiagnosticsState({ status: "ok", value: value.data ?? [] });
      })
      .catch(() => {
        if (!requestScope.cancelled) setDiagnosticsState({ status: "error" });
      });
  };
  const retryBreakdown = () => {
    const requestScope = requestScopeRef.current;
    if (!requestScope || requestScope.cancelled) return;
    setBreakdownState({ status: "loading" });
    void fetchSessionBreakdown(sessionId)
      .then((value) => {
        if (!requestScope.cancelled) setBreakdownState({ status: "ok", value: value.data });
      })
      .catch(() => {
        if (!requestScope.cancelled) setBreakdownState({ status: "error" });
      });
  };
  const retryRecommendations = () => {
    const requestScope = requestScopeRef.current;
    if (!requestScope || requestScope.cancelled) return;
    setRecommendationsState({ status: "loading" });
    void fetchRecommendations()
      .then((value) => {
        if (!requestScope.cancelled) {
          setRecommendationsState({ status: "ok", value: value.data?.active ?? [] });
        }
      })
      .catch(() => {
        if (!requestScope.cancelled) setRecommendationsState({ status: "error" });
      });
  };
  const retryPricing = () => {
    const requestScope = requestScopeRef.current;
    if (!requestScope || requestScope.cancelled) return;
    setPricingState({ status: "loading" });
    void fetchSessionEsfObservations(sessionId)
      .then((value) => {
        if (!requestScope.cancelled) setPricingState({ status: "ok", value: toPricing(value) });
      })
      .catch(() => {
        if (!requestScope.cancelled) setPricingState({ status: "error" });
      });
  };
  const sharedCostClaim =
    turns.length > 0 && turns.every((turn) => turn.cost_claim === turns[0]?.cost_claim)
      ? turns[0]?.cost_claim
      : null;
  const sharedClaimTurn = sharedCostClaim === null ? null : (turns[0] ?? null);
  const showClaimColumn = visibleTurns.some(
    (turn) => turn.provisional || turn.cost_claim !== sharedCostClaim,
  );
  // A deep link to a turn keeps the table open; otherwise it sits behind "Show all turns".
  const hasAnchor = anchorMessageId !== null || anchorTurnIndex !== null;
  const turnsOpen = showTurns || hasAnchor;

  const frictionCounts: FrictionCounts = {
    api_error_count: session.api_error_count,
    tool_error_count: session.tool_error_count,
    test_fail_count: session.test_fail_count,
    compaction_count: session.compaction_count,
    interrupt_count: session.interrupt_count,
    interrupts_supported: session.interrupts_supported,
    api_error_eligible_request_count: session.api_error_eligible_request_count,
    api_error_rate: session.api_error_rate,
    tool_completed_count: session.tool_completed_count,
    tool_completed_error_count: session.tool_completed_error_count,
    tool_error_rate: session.tool_error_rate,
    test_completed_count: session.test_completed_count,
    test_pass_count: session.test_pass_count,
    test_outcome: session.test_outcome,
    user_turn_count: session.user_turn_count,
    turn_count: session.turn_count,
    gap_median_s: session.gap_median_s,
    gap_p90_s: session.gap_p90_s,
    long_gap_count: session.long_gap_count,
    gap_n: session.gap_n,
  };

  const percentileValue =
    spendPercentile == null
      ? "—"
      : spendPercentile.percentile === null
        ? "Not enough data"
        : `Top ${topSpendPercent(spendPercentile.percentile)}%`;
  // Loading or failed fetch: no cmp line. Only the API's null percentile means "fewer than 20".
  const percentileCmp =
    spendPercentile == null ? undefined : spendPercentile.percentile !== null ? (
      <SpendPercentileChip
        percentile={spendPercentile.percentile}
        n={spendPercentile.n}
        windowDays={spendPercentile.window_days}
      />
    ) : (
      "Fewer than 20 sessions in this workspace"
    );

  return (
    <section>
      <button type="button" className="btn-secondary page-back" onClick={onBack}>
        <span aria-hidden="true">← </span>
        {backLabel}
      </button>
      <div className="page-top">
        <div className="page-title">
          <h1>
            {story?.title ?? shortId(session.session_id)}{" "}
            <Chip kind={session.state === "LIVE" ? "LIVE" : "LIST_EQUIV"} label={session.state} />
          </h1>
          <p className="page-sub">
            <a href={`#/workspaces/${encodeURIComponent(session.workspace_id)}`}>
              {labelWorkspace(session as SessionSummary & WorkspaceLabelInput)}
            </a>{" "}
            ·{" "}
            <button
              type="button"
              className="live-session-link"
              onClick={() => copyText(session.session_id)}
              title={session.session_id}
              aria-label={`Copy session ${session.session_id}`}
            >
              {shortId(session.session_id)}
            </button>{" "}
            ·{" "}
            <button
              type="button"
              className="live-session-link"
              onClick={() => copyText(session.file_path)}
              title={session.file_path}
            >
              Copy source path
            </button>
          </p>
          {story !== null && <StoryHeaderDetails story={story} />}
        </div>
      </div>

      <div className="grid g4">
        <KpiCard
          label="Turns"
          info="The number of main-conversation turns in this session. More turns is not worse on its own — read it alongside estimated cost and context to judge effort."
          value={tokens(session.turn_count)}
        />
        <KpiCard
          label="Estimated cost"
          info="Estimated cost at public API list prices, not your bill. Use it to compare session costs and decide which are worth improving first."
          value={usd(session.cost_equiv_u)}
        />
        <KpiCard
          label="Duration"
          info="Wall-clock time between the first and last observed turn. Idle gaps can inflate it, so it is not a measure of effort or cost."
          value={duration(session.first_turn_at, session.last_turn_at)}
        />
        <KpiCard
          label="Cost percentile"
          info="How this session's estimated cost compares with your other sessions in the same workspace over the past 90 days. Not a bill; use it to spot standout sessions."
          value={percentileValue}
          cmp={percentileCmp}
        />
      </div>

      <div className="grid g2 session-glance">
        <SessionFactsCard session={session} story={story} />
        <FilesEditedCard story={story} />
      </div>

      {/* Cost: where the money went, then what drove it. */}
      {story !== null && <MoneyCard story={story} />}
      {driversData !== null && driversData.drivers.length >= 1 && (
        <CostDriversPanel drivers={driversData} />
      )}
      <CostBreakdownPanel state={breakdownState} retry={retryBreakdown} />

      {/* Timeline: how the session unfolded. */}
      {story !== null && <SessionSwimlane story={story} />}
      {story !== null ? (
        <SessionContextCostChart
          story={story}
          loadedTurns={turns}
          loopTurnIndices={loopTurnIndices}
        />
      ) : (
        <ContextGrowthChart
          turns={turns}
          compactionCount={session.compaction_count}
          compactionTurnIndices={session.compaction_turn_indices}
          toolErrorTurnIndices={
            breakdownState.status === "ok"
              ? (breakdownState.value?.tool_error_turn_indices ?? [])
              : []
          }
          loopTurnIndices={loopTurnIndices}
          totalTurns={session.turn_count}
          partial={nextCursor !== null}
        />
      )}
      {story !== null && (
        <ErrorGroupsPanel story={story} toolErrorCount={session.tool_error_count} />
      )}
      {(story === null || story.errors_without_text > 0) && (
        <ToolBreakdownPanel state={breakdownState} retry={retryBreakdown} sessionId={sessionId} />
      )}

      <section className="sec" data-testid="friction-strip">
        <div className="sec-h">
          <h2>
            Friction signals{" "}
            <InfoTip
              label="What the friction band means"
              content="A heuristic band based on observed errors, test outcomes, and interaction/context signals; not a health or quality rating. Each tile is shown separately: a test failure followed by a later pass is not task failure or proof that the same test recovered. The tool-error count matches the grouped errors above. Interrupt telemetry and API request exposure are unavailable."
            />
          </h2>
          <span className="desc">
            <Chip
              kind="DIRECTIONAL"
              label={frictionBand(frictionCounts)}
              title={FRICTION_TOOLTIP}
            />
          </span>
        </div>
        <div className="card card-padded">
          <FrictionCell counts={frictionCounts} variant="strip" />
        </div>
      </section>

      <ObservedEvidenceCard
        session={session}
        pricing={pricingState}
        errorGroupsShown={story !== null && story.error_groups.length > 0}
        onRetry={retryPricing}
      />
      <AnomaliesPanel state={diagnosticsState} retry={retryDiagnostics} />

      {/* Act: after all the evidence, hand it to an agent and show matching fixes. */}
      <InvestigateCard
        loading={
          storyState.status === "loading" ||
          recommendationsState.status === "loading" ||
          pricingState.status === "loading"
        }
        prompt={buildSessionPrompt({
          session,
          story,
          drivers: driversData,
          percentile: spendPercentile,
          anchors: diagnosticsState.status === "ok" ? diagnosticsState.value : [],
          recommendations: matchedRecommendations,
          unpricedTurns:
            pricingState.status === "ok"
              ? (pricingState.value?.unpriced_turn_count ?? null)
              : pricingState.status === "error"
                ? "unknown"
                : null,
        })}
      />
      {driversData !== null && driversData.drivers.length > 0 && (
        <PatternRecommendationsPanel
          state={
            recommendationsState.status === "ok"
              ? { status: "ok", value: matchedRecommendations }
              : recommendationsState
          }
          retry={retryRecommendations}
        />
      )}

      <section className="sec" data-testid="turn-timeline">
        <div className="sec-h">
          <h2>Turn timeline</h2>
          <span className="desc sec-h-controls">
            {turnsOpen && <span className="section-meta">Oldest first</span>}
            {turnsOpen && sharedClaimTurn !== null && (
              <span>Claim: {claimChip({ ...sharedClaimTurn, provisional: false })}</span>
            )}
            <button
              type="button"
              className="btn-secondary"
              aria-expanded={turnsOpen}
              aria-controls="turn-timeline-body"
              onClick={() => setShowTurns((v) => !v)}
              disabled={hasAnchor}
            >
              {turnsOpen ? "Hide turns" : `Show all ${tokens(session.turn_count)} turns`}
            </button>
          </span>
        </div>
        {/* A load failure shows even while collapsed; otherwise it hides behind "Show all turns". */}
        {(turnsOpen || timelineState.status === "error") && (
          <div className="card" id="turn-timeline-body">
            {timelineState.status === "loading" && (
              <div className="table-wrap" aria-busy="true">
                <SkeletonBlock height={90} />
              </div>
            )}
            {timelineState.status === "error" && (
              <AsyncErrorState
                resource="session-detail"
                onRetry={() => {
                  const requestScope = requestScopeRef.current;
                  if (!requestScope || requestScope.cancelled) return;
                  setTimelineState({ status: "loading" });
                  void fetchTurnTimeline(sessionId)
                    .then((value) => {
                      if (requestScope.cancelled) return;
                      setTimelineState({ status: "ok", value });
                      setTurns(value.data?.items ?? []);
                      setNextCursor(value.data?.next_cursor ?? null);
                    })
                    .catch((error: unknown) => {
                      if (!requestScope.cancelled) {
                        setTimelineState({ status: "error", message: String(error) });
                      }
                    });
                }}
              />
            )}
            {timelineState.status === "ok" && turns.length === 0 && (
              <EmptyState
                headline="No turns recorded for this session"
                why="No turns have been recorded for this session."
                whatWillAppear="Per-turn token, context, and cost aggregates will appear when the daemon observes them."
              />
            )}
            {timelineState.status === "ok" && turns.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Model</th>
                      <th>Chain</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Thinking</th>
                      <th>Cache read</th>
                      <th>Cache write</th>
                      <th>Context</th>
                      <th>Estimated value</th>
                      {showClaimColumn && <th>How it is estimated</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTurns.map((turn, index) => {
                      const isAnchor = index === anchoredTurnIndex;
                      return (
                        <tr
                          key={turn.message_id}
                          ref={isAnchor ? anchorRowRef : undefined}
                          data-diagnostic-anchor={isAnchor ? "true" : undefined}
                          style={isAnchor ? { outline: "2px solid var(--accent)" } : undefined}
                        >
                          <td>{new Date(turn.ts).toLocaleTimeString()}</td>
                          <td>{turn.model}</td>
                          <td>
                            {turn.is_sidechain === true && (
                              <span className="chip chip-na">side</span>
                            )}
                          </td>
                          <td>{tokens(turn.input_tokens)}</td>
                          <td>{tokens(turn.output_tokens)}</td>
                          <td>
                            {turn.thinking_tokens === null ? "N/A" : tokens(turn.thinking_tokens)}
                          </td>
                          <td>{tokens(turn.cache_read_tokens)}</td>
                          <td>{tokens(cacheWrite(turn))}</td>
                          <td>{tokens(turn.context_tokens)}</td>
                          <td>{usd(turn.cost_equiv_u)}</td>
                          {showClaimColumn && (
                            <td>
                              {turn.provisional || turn.cost_claim !== sharedCostClaim
                                ? claimChip(turn)
                                : "—"}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {timelineState.status === "ok" &&
              turns.length > 0 &&
              (visibleCount < turns.length || nextCursor !== null) && (
                <div className="session-load-more">
                  <p className="section-meta">
                    showing {Math.min(visibleCount, turns.length)} of {session.turn_count} turns
                    {nextCursor !== null && " — load more below"}
                  </p>
                  {paginationError !== null && (
                    <AsyncErrorState resource="session-detail" onRetry={loadMore} />
                  )}
                  <button
                    ref={loadMoreRef}
                    type="button"
                    className="btn-secondary"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore
                      ? "Loading…"
                      : paginationError === null
                        ? "Load more"
                        : "Retry loading turns"}
                  </button>
                </div>
              )}
          </div>
        )}
      </section>
    </section>
  );
}
