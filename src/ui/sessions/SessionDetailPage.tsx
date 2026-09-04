import { useEffect, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PagedList, SessionSummary, TurnRow } from "../../query/api/overview";
import type { SessionSpendPercentile } from "../../query/api/self-percentiles";
import type { SessionDriver, SessionDrivers } from "../../query/api/session-drivers";
import type { ApiResponse } from "../../query/envelope";
import {
  fetchSession,
  fetchSessionDrivers,
  fetchSpendPercentile,
  fetchTurnTimeline,
} from "../api/client";
import { shortId } from "../lib/short-id";
import { type WorkspaceLabelInput, workspaceLabel } from "../lib/workspace-label";
import { CustomTooltip, gridProps, seriesPalette } from "../overview/chart-theme";
import { buildSessionDriversPrompt } from "../recommendations/prompt-templates";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock } from "../shell/Skeleton";
import { FrictionCell, type FrictionCounts } from "./FrictionCell";
import { SpendPercentileChip } from "./SpendPercentileChip";

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
  return workspaceLabel({
    workspace_id: session.workspace_id,
    repo_owner: session.repo_owner ?? null,
    repo_name: session.repo_name ?? null,
    repo_path: session.repo_path ?? null,
    repo_canonical: session.repo_canonical ?? null,
  });
}

function claimChip(turn: TurnRow) {
  if (turn.provisional) return <Chip kind="LIVE" label="LIVE" />;
  if (turn.cost_claim === "LIST_EQUIV_STALE") {
    return <Chip kind="LIST_EQUIV_STALE" label={turn.cost_claim} />;
  }
  if (turn.cost_claim === "LIST_EQUIV") {
    return <Chip kind="LIST_EQUIV" label={turn.cost_claim} />;
  }
  return <span>{turn.cost_claim}</span>;
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
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <span
        className="driver-severity-dot"
        aria-label={`severity ${driver.share !== null ? Math.round(driver.share * 100) : 0}%`}
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: severityColor(driver.share),
          flexShrink: 0,
          marginTop: 3,
        }}
      />
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 600, fontSize: 12 }}>{driver.label}</span>
        {driver.share !== null && (
          <span
            className="driver-share"
            style={{ marginLeft: 8, fontSize: 11, color: "var(--text-muted)" }}
          >
            {Math.round(driver.share * 100)}% share
          </span>
        )}
        <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-muted)" }}>
          {measureEntries.map(([key, val]) => (
            <span key={key} style={{ marginRight: 12 }}>
              {key}: {fmtMeasuredValue(val)}
            </span>
          ))}
        </div>
        {driver.approx_usd !== undefined && (
          <div
            className="driver-approx-usd"
            style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}
          >
            ≈${driver.approx_usd.toFixed(2)}/wk (this driver only)
          </div>
        )}
      </div>
      <a
        href={routeHref}
        className={`driver-chip driver-chip-${driver.routing}`}
        data-testid={`driver-route-${driver.routing}`}
        data-rec-id={driver.routing === "rec_card" ? driver.rec_id : undefined}
        style={{
          fontSize: 11,
          padding: "2px 8px",
          borderRadius: 4,
          border: "1px solid var(--line)",
          textDecoration: "none",
          color: "var(--text)",
          flexShrink: 0,
        }}
      >
        {routeLabel}
      </a>
    </div>
  );
}

function CostDriversPanel({ drivers }: { drivers: SessionDrivers }) {
  const prompt = buildSessionDriversPrompt(drivers);
  const [copied, setCopied] = useState(false);

  function onCopy() {
    copyText(prompt.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card" data-testid="cost-drivers-panel" style={{ marginBottom: 13 }}>
      <div className="section-head">
        <h2>
          Cost drivers{" "}
          <InfoTip
            label="What the cost-drivers panel shows"
            content="Breaks this session's modeled cost into where the tokens went — context re-reads, cache writes, and model choice. The largest slice is your best lever."
          />
        </h2>
        <div className="chips">
          <Chip kind="OBS_PROXY" />
          <span className="section-meta">p{drivers.percentile.toFixed(0)}</span>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>
        {drivers.drivers.map((driver) => (
          <DriverRow key={driver.detector_id} driver={driver} />
        ))}
      </div>
      <div style={{ padding: "12px 16px 8px" }}>
        <p className="kpi-fn" style={{ margin: "0 0 8px" }}>
          Per-driver figures are observed proxies — never summed.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
            GUIDED prompt
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={onCopy}
            data-testid="copy-drivers-prompt"
            style={{ fontSize: 11, padding: "2px 10px" }}
          >
            {copied ? "Copied!" : "Copy prompt"}
          </button>
        </div>
        <pre
          className="driver-prompt-preview"
          data-testid="driver-prompt-text"
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            background: "var(--panel2)",
            border: "1px solid var(--line)",
            borderRadius: 4,
            padding: "8px 10px",
            marginTop: 6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {prompt.text}
        </pre>
      </div>
    </div>
  );
}

interface ContextGrowthRow extends TurnRow {
  idx: number;
  cache_write_total: number;
}

function contextGrowthRows(turns: TurnRow[]): ContextGrowthRow[] {
  return turns.map((turn, index) => ({
    ...turn,
    idx: index + 1,
    cache_write_total: turn.cache_write_5m + turn.cache_write_1h + turn.cache_write_other,
  }));
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
      {`Turn ${row.idx} — Context: ${fmtTokensCompact(row.context_tokens)} | Cache write: ${
        row.cache_write_total > 0 ? "yes" : "no"
      }`}
    </div>
  );
}

export function ContextGrowthChart({
  turns,
  compactionCount = 0,
}: {
  turns: TurnRow[];
  compactionCount?: number;
}) {
  if (turns.length === 0) return null;

  const rows = contextGrowthRows(turns);
  const cacheWriteRows = rows.filter((row) => row.cache_write_total > 0);
  const compactionNote = compactionCount > 0 ? ` · ${compactionCount} compaction(s)` : "";

  return (
    <div className="card" data-testid="context-growth-chart" style={{ marginBottom: 13 }}>
      <div className="section-head">
        <h2>
          Context per turn{" "}
          <InfoTip
            label="What the context-growth chart shows"
            content="Context size per turn over the session; every turn re-reads the whole thing, so a rising line means rising cost. A steep climb is a cue to /clear or split the task."
          />
        </h2>
        <div className="chips">
          <Chip kind="OBS_PROXY" />
        </div>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid {...gridProps.grid} />
          <XAxis
            dataKey="idx"
            type="number"
            allowDecimals={false}
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            tickCount={gridProps.tickCount}
            interval={gridProps.preserveStartEnd ? "preserveStartEnd" : 0}
            minTickGap={24}
            tickFormatter={(value: number) => `Turn ${value}`}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            dataKey="context_tokens"
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            tickFormatter={fmtTokensCompact}
            width={54}
          />
          <Tooltip
            content={
              <CustomTooltip
                labelFormatter={(label) => `Turn ${String(label)}`}
                valueFormatter={(value) =>
                  typeof value === "number" ? fmtTokensCompact(value) : String(value ?? "N/A")
                }
              />
            }
          />
          <Line
            type="monotone"
            dataKey="context_tokens"
            name="Context"
            stroke={seriesPalette[0]}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {cacheWriteRows.length > 0 && (
            <Scatter
              data={cacheWriteRows}
              dataKey="context_tokens"
              name="Cache write"
              fill="var(--amber)"
              isAnimationActive={false}
            />
          )}
          <ReferenceLine
            y={160_000}
            stroke="var(--red)"
            strokeDasharray="4 4"
            ifOverflow="extendDomain"
            label={{ value: "160K warning", fill: "var(--red)", position: "insideTopRight" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <p className="kpi-fn" style={{ margin: "0 16px 12px" }}>
        {`Context per turn · amber dots = cache write event (potential miss) · red line = 80% of 200K window${compactionNote}`}
      </p>
    </div>
  );
}

export default function SessionDetailPage({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
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
  const [spendPercentile, setSpendPercentile] = useState<SessionSpendPercentile | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSessionState({ status: "loading" });
    setTimelineState({ status: "loading" });
    setTurns([]);
    setVisibleCount(100);
    setNextCursor(null);
    setPaginationError(null);
    setDriversData(null);
    setSpendPercentile(null);

    void (async () => {
      try {
        const sessionValue = await fetchSession(sessionId);
        if (cancelled) return;
        setSessionState({ status: "ok", value: sessionValue });
        if (sessionValue.data === null) return;
      } catch (error: unknown) {
        if (!cancelled) {
          setSessionState({ status: "error", message: String(error) });
        }
        return;
      }

      try {
        const timelineValue = await fetchTurnTimeline(sessionId);
        if (cancelled) return;
        setTimelineState({ status: "ok", value: timelineValue });
        setTurns(timelineValue.data?.items ?? []);
        setNextCursor(timelineValue.data?.next_cursor ?? null);
      } catch (error: unknown) {
        if (!cancelled) {
          setTimelineState({ status: "error", message: String(error) });
        }
      }

      try {
        const driversValue = await fetchSessionDrivers(sessionId);
        if (cancelled) return;
        setDriversData(driversValue.data ?? null);
      } catch {
        // Drivers fetch failure is non-fatal — panel simply absent.
      }

      try {
        const percentileValue = await fetchSpendPercentile(sessionId);
        if (cancelled) return;
        setSpendPercentile(percentileValue);
      } catch {
        // Percentile fetch failure is non-fatal — chip simply absent.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const loadMore = () => {
    if (visibleCount < turns.length) {
      setVisibleCount((count) => count + 100);
      return;
    }
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setPaginationError(null);
    fetchTurnTimeline(sessionId, { after: nextCursor })
      .then((value) => {
        setTurns((prior) => [...prior, ...(value.data?.items ?? [])]);
        setNextCursor(value.data?.next_cursor ?? null);
      })
      .catch((error: unknown) => setPaginationError(String(error)))
      .finally(() => setLoadingMore(false));
  };

  if (sessionState.status === "loading") {
    return (
      <div className="session-detail" aria-busy="true" aria-label="Loading session detail">
        <SkeletonBlock height={180} />
      </div>
    );
  }
  if (sessionState.status === "error") {
    return (
      <div className="banner banner-error" role="alert">
        Could not load session: {sessionState.message}
      </div>
    );
  }

  const session = sessionState.value.data;
  if (session === null) {
    return (
      <div className="empty-state session-detail-empty">
        <span className="empty-state-text">Session not found.</span>
        <button type="button" className="btn-secondary" onClick={onBack}>
          Back to overview
        </button>
      </div>
    );
  }

  const cacheWrite = (turn: TurnRow) =>
    turn.cache_write_5m + turn.cache_write_1h + turn.cache_write_other;
  const visibleTurns = turns.slice(0, visibleCount);
  const sharedCostClaim =
    turns.length > 0 && turns.every((turn) => turn.cost_claim === turns[0]?.cost_claim)
      ? turns[0]?.cost_claim
      : null;
  const sharedClaimTurn = sharedCostClaim === null ? null : (turns[0] ?? null);

  return (
    <section className="session-detail">
      <button type="button" className="btn-secondary session-back" onClick={onBack}>
        Back to overview
      </button>
      <div className="page-top">
        <div className="page-title">
          <h1>Session detail</h1>
          <p className="page-sub">
            {labelWorkspace(session as SessionSummary & WorkspaceLabelInput)} ·{" "}
            <button
              type="button"
              className="live-session-link"
              onClick={() => copyText(session.session_id)}
              title={session.session_id}
              aria-label={`Copy session ${session.session_id}`}
            >
              {shortId(session.session_id)}
            </button>
          </p>
          <button
            type="button"
            className="live-session-link page-sub"
            onClick={() => copyText(session.file_path)}
            title={session.file_path}
          >
            Copy source path
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <Chip kind={session.state === "LIVE" ? "LIVE" : "LIST_EQUIV"} label={session.state} />
          {spendPercentile != null && (
            <SpendPercentileChip
              percentile={spendPercentile.percentile}
              n={spendPercentile.n}
              windowDays={spendPercentile.window_days}
            />
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 0 4px" }}>
        <InfoTip
          label="What these KPIs summarize"
          content="The session's headline numbers — turns, modeled cost, context, and outcome — at a glance. Open the panels below to see what drove each one."
        />
      </div>
      <div className="session-kpis">
        <div>
          <span>Turns</span>
          <b>{tokens(session.turn_count)}</b>
        </div>
        <div>
          <span>Session cost</span>
          <b>{usd(session.cost_equiv_u)}</b>
        </div>
        <div>
          <span>Duration</span>
          <b>{duration(session.first_turn_at, session.last_turn_at)}</b>
        </div>
        <div>
          <span>Started</span>
          <b>{session.first_turn_at ? new Date(session.first_turn_at).toLocaleString() : "N/A"}</b>
        </div>
        <div>
          <span>Last turn</span>
          <b>{session.last_turn_at ? new Date(session.last_turn_at).toLocaleString() : "N/A"}</b>
        </div>
        <div>
          <span>Hygiene flags</span>
          <b>{session.hygiene_flags.length > 0 ? session.hygiene_flags.join(", ") : "None"}</b>
        </div>
        <div>
          <span>
            Turns to first commit{" "}
            <InfoTip
              label="EF1 — turns to first commit"
              content="Count of non-sidechain turns (is_sidechain=0) up to and including the first commit turn. Null when no commit occurred in the session. OBS_PROXY tier."
            />
          </span>
          <b data-testid="turns-to-first-commit">
            {session.turns_to_first_commit !== undefined
              ? session.turns_to_first_commit !== null
                ? String(session.turns_to_first_commit)
                : "—/no commit"
              : "—"}
          </b>
        </div>
        <div>
          <span>
            Deep abandoned{" "}
            <InfoTip
              label="EF1 — deep abandoned"
              content="True when: ≥10 user turns, no commit, and state is RECONCILED. A deep-abandoned session consumed significant effort without a commit outcome. OBS_PROXY tier."
            />
          </span>
          <b data-testid="deep-abandoned">
            {session.deep_abandoned === true ? (
              <Chip kind="ATTENTION" label="DEEP ABANDONED" />
            ) : (
              "No"
            )}
          </b>
        </div>
      </div>

      {driversData !== null &&
        (driversData.percentile >= 75 || driversData.drivers.length >= 1) && (
          <CostDriversPanel drivers={driversData} />
        )}

      <div className="card" data-testid="friction-strip" style={{ marginBottom: 13 }}>
        <div className="section-head">
          <h2>
            Friction signals{" "}
            <InfoTip
              label="What the friction band means"
              content="A coarse low/medium/high rating of how much this session stalled on errors, retries, and dead ends — not a precision score. The components below show what drove it."
            />
          </h2>
          <div className="chips">
            <Chip kind="DIRECTIONAL" />
          </div>
        </div>
        <div style={{ padding: "8px 16px 12px" }}>
          <InfoTip
            label="What the friction components are"
            content="The observed signals that set the band: error rate, retries, and abandoned turns. A single dominant component tells you what to fix first."
          />
          <FrictionCell
            counts={{
              api_error_count: session.api_error_count,
              tool_error_count: session.tool_error_count,
              test_fail_count: session.test_fail_count,
              compaction_count: session.compaction_count,
              interrupt_count: session.interrupt_count,
              user_turn_count: session.user_turn_count,
              turn_count: session.turn_count,
              gap_median_s: session.gap_median_s,
              gap_p90_s: session.gap_p90_s,
              long_gap_count: session.long_gap_count,
              gap_n: session.gap_n,
            }}
            variant="strip"
          />
        </div>
      </div>

      <ContextGrowthChart turns={turns} compactionCount={session.compaction_count} />

      <div className="card session-timeline">
        <div className="section-head">
          <h2>Turn timeline</h2>
          <div className="chips">
            <span className="section-meta">Oldest first</span>
            {sharedClaimTurn !== null && (
              <span>Claim: {claimChip({ ...sharedClaimTurn, provisional: false })}</span>
            )}
          </div>
        </div>
        {timelineState.status === "loading" && (
          <div className="table-wrap" aria-busy="true">
            <SkeletonBlock height={90} />
          </div>
        )}
        {timelineState.status === "error" && (
          <div className="banner banner-error" role="alert">
            Could not load turns: {timelineState.message}
          </div>
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
                  <th>Cost</th>
                  <th>Claim</th>
                </tr>
              </thead>
              <tbody>
                {visibleTurns.map((turn) => (
                  <tr key={turn.message_id}>
                    <td>{new Date(turn.ts).toLocaleTimeString()}</td>
                    <td>{turn.model}</td>
                    <td>
                      {turn.is_sidechain === true && <span className="chip chip-na">side</span>}
                    </td>
                    <td>{tokens(turn.input_tokens)}</td>
                    <td>{tokens(turn.output_tokens)}</td>
                    <td>{turn.thinking_tokens === null ? "N/A" : tokens(turn.thinking_tokens)}</td>
                    <td>{tokens(turn.cache_read_tokens)}</td>
                    <td>{tokens(cacheWrite(turn))}</td>
                    <td>{tokens(turn.context_tokens)}</td>
                    <td>{usd(turn.cost_equiv_u)}</td>
                    <td>
                      {turn.provisional || turn.cost_claim !== sharedCostClaim
                        ? claimChip(turn)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {timelineState.status === "ok" &&
          turns.length > 0 &&
          (visibleCount < turns.length || nextCursor !== null) && (
            <div className="session-load-more">
              <p className="section-meta">
                showing {Math.min(visibleCount, turns.length)} of {turns.length} turns
              </p>
              {paginationError !== null && (
                <div className="banner banner-error" role="alert">
                  Could not load more turns: {paginationError}
                </div>
              )}
              <button
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
    </section>
  );
}
