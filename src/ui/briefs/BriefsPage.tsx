import { useEffect, useMemo, useState } from "react";
import type { GlobalOverview, WorkspaceSummary } from "../../query/api/overview";
import type { RecommendationsView } from "../../query/api/recommendations";
import type { CacheWriteTrend } from "../../query/api/trends";
import type { HotSessionRow } from "../../query/spend";
import {
  fetchCacheWriteTrend,
  fetchGlobalOverview,
  fetchHotSessions,
  fetchRecommendations,
  fetchWorkspaces,
} from "../api/client";
import { workspaceLabel } from "../lib/workspace-label";
import InfoTip from "../shell/InfoTip";
import { type Brief, type BriefDelta, briefToMarkdown, buildBrief } from "./buildBrief";

const WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fixed current + prior 7-day windows resolved once per page load. */
interface Windows {
  current: { from: string; to: string };
  prior: { from: string; to: string };
  label: string;
}

function resolveWindows(now: Date = new Date()): Windows {
  const to = now.getTime();
  const currentFrom = to - WINDOW_DAYS * MS_PER_DAY;
  const priorFrom = currentFrom - WINDOW_DAYS * MS_PER_DAY;
  return {
    current: { from: new Date(currentFrom).toISOString(), to: new Date(to).toISOString() },
    prior: { from: new Date(priorFrom).toISOString(), to: new Date(currentFrom).toISOString() },
    label: `${new Date(currentFrom).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`,
  };
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      overview: GlobalOverview;
      workspaces: WorkspaceSummary[];
      cacheTrend: CacheWriteTrend;
      recs: RecommendationsView;
      hotSessions: HotSessionRow[];
      priorOverview: GlobalOverview;
      priorCacheTrend: CacheWriteTrend;
      priorHotSessions: HotSessionRow[];
    };

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatUsd(value: number): string {
  return `$${formatNumber(value)}`;
}

function formatPercent(share: number): string {
  return `${(share * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function scopeLabel(workspaces: WorkspaceSummary[], workspaceId: string | null): string {
  if (workspaceId === null) return "Global";
  const workspace = workspaces.find((item) => item.workspace_id === workspaceId);
  return workspace === undefined ? workspaceId : workspaceLabel(workspace);
}

/** Renders a delta below a tile's current value: signed change, direction arrow, or "—". */
function DeltaLine({
  delta,
  format,
}: {
  delta: BriefDelta;
  format: (value: number) => string;
}) {
  if (delta.delta === null) {
    return (
      <span
        className="brief-tile-delta brief-tile-delta-none"
        title="No prior-week data to compare"
      >
        — vs prior week
      </span>
    );
  }
  const direction = delta.delta > 0 ? "up" : delta.delta < 0 ? "down" : "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "▬";
  const sign = delta.delta > 0 ? "+" : "";
  return (
    <span className={`brief-tile-delta brief-tile-delta-${direction}`}>
      {arrow} {sign}
      {format(delta.delta)} vs prior week
    </span>
  );
}

function BriefTile({
  label,
  value,
  delta,
  format,
}: {
  label: string;
  value: string;
  delta: BriefDelta;
  format: (value: number) => string;
}) {
  return (
    <div className="brief-tile">
      <div className="brief-tile-label">{label}</div>
      <div className="brief-tile-value">{value}</div>
      <DeltaLine delta={delta} format={format} />
    </div>
  );
}

function AttributionDetails({ brief }: { brief: Brief }) {
  const { cache_mix: cacheMix, hot_sessions: hotSessions } = brief.attribution;
  return (
    <details className="briefs-details">
      <summary>Attribution &amp; hot sessions</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Cost equivalent</td>
              <td>{formatUsd(brief.overview.cost_usd)}</td>
            </tr>
            <tr>
              <td>Reconciled turns</td>
              <td>{formatNumber(brief.overview.turns)}</td>
            </tr>
            <tr>
              <td>Total turns</td>
              <td>{formatNumber(brief.overview.turns_total)}</td>
            </tr>
            <tr>
              <td>Cache write tokens</td>
              <td>{formatNumber(cacheMix.cache_write_tokens)}</td>
            </tr>
            <tr>
              <td>Cache read tokens</td>
              <td>{formatNumber(cacheMix.cache_read_tokens)}</td>
            </tr>
            <tr>
              <td>Hot sessions</td>
              <td>{formatNumber(hotSessions.length)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {hotSessions.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Cost</th>
                <th scope="col">Turns</th>
                <th scope="col">Context / turn</th>
                <th scope="col">Model</th>
              </tr>
            </thead>
            <tbody>
              {hotSessions.map((session) => (
                <tr key={session.session_id}>
                  <td>{session.session_id}</td>
                  <td>{formatUsd(session.usd)}</td>
                  <td>{formatNumber(session.turns)}</td>
                  <td>{formatNumber(session.avg_context_tokens)}</td>
                  <td>{session.model}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

export default function BriefsPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [copiedAction, setCopiedAction] = useState<string | null>(null);
  const windows = useMemo(() => resolveWindows(), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchGlobalOverview(windows.current),
      fetchWorkspaces(windows.current),
      fetchCacheWriteTrend(windows.current),
      fetchRecommendations(),
      fetchHotSessions(windows.current),
      fetchGlobalOverview(windows.prior),
      fetchCacheWriteTrend(windows.prior),
      fetchHotSessions(windows.prior),
    ])
      .then(
        ([
          overviewResponse,
          workspacesResponse,
          cacheTrendResponse,
          recsResponse,
          hotSessions,
          priorOverviewResponse,
          priorCacheTrendResponse,
          priorHotSessions,
        ]) => {
          if (cancelled) return;
          if (
            overviewResponse.data === null ||
            workspacesResponse.data === null ||
            cacheTrendResponse.data === null ||
            recsResponse.data === null ||
            priorOverviewResponse.data === null ||
            priorCacheTrendResponse.data === null
          ) {
            throw new Error("Brief data was unavailable");
          }
          setState({
            status: "ok",
            overview: overviewResponse.data,
            workspaces: workspacesResponse.data.items,
            cacheTrend: cacheTrendResponse.data,
            recs: recsResponse.data,
            hotSessions,
            priorOverview: priorOverviewResponse.data,
            priorCacheTrend: priorCacheTrendResponse.data,
            priorHotSessions,
          });
        },
      )
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [windows]);

  const brief =
    state.status === "ok"
      ? buildBrief({
          scopeLabel: scopeLabel(state.workspaces, workspaceId),
          scopeWorkspaceId: workspaceId,
          overview: state.overview,
          hotSessions: state.hotSessions,
          cacheTrend: state.cacheTrend,
          recs: state.recs.active.filter(
            (rec) =>
              workspaceId === null ||
              rec.scope_workspace_id === null ||
              rec.scope_workspace_id === workspaceId,
          ),
          prior: {
            overview: state.priorOverview,
            hotSessions: state.priorHotSessions,
            cacheTrend: state.priorCacheTrend,
          },
        })
      : null;

  async function copyMarkdown(): Promise<void> {
    if (brief === null) return;
    await navigator.clipboard.writeText(briefToMarkdown(brief));
    setCopiedMarkdown(true);
    window.setTimeout(() => setCopiedMarkdown(false), 2_000);
  }

  async function copyActionPrompt(id: string, prompt: string): Promise<void> {
    await navigator.clipboard.writeText(prompt);
    setCopiedAction(id);
    window.setTimeout(() => setCopiedAction((current) => (current === id ? null : current)), 2_000);
  }

  return (
    <div className="briefs-page">
      <div className="page-top">
        <div className="page-title">
          <h1>Briefs</h1>
          <p className="page-sub">This week in one page: verdict, what changed, what to do</p>
        </div>
      </div>

      {state.status === "loading" && (
        <div className="card" aria-busy="true">
          Loading brief data...
        </div>
      )}
      {state.status === "error" && (
        <div className="banner banner-error" role="alert">
          Could not load brief: {state.message}
        </div>
      )}
      {state.status === "ok" && brief !== null && (
        <>
          <div className="briefs-controls">
            <label className="briefs-scope" htmlFor="briefs-scope">
              Scope
              <select
                id="briefs-scope"
                value={workspaceId ?? ""}
                onChange={(event) => setWorkspaceId(event.target.value || null)}
              >
                <option value="">Global</option>
                {state.workspaces.map((workspace) => (
                  <option key={workspace.workspace_id} value={workspace.workspace_id}>
                    {workspaceLabel(workspace)}
                  </option>
                ))}
              </select>
            </label>
            <span className="briefs-window" title="Rolling seven-day window">
              {windows.label}
            </span>
            <button type="button" className="btn-primary" onClick={() => void copyMarkdown()}>
              {copiedMarkdown ? "Copied" : "Copy as markdown"}
            </button>
          </div>

          <section className="card briefs-verdict" aria-labelledby="briefs-verdict-heading">
            <h2 id="briefs-verdict-heading" className="briefs-verdict-line">
              <strong>{formatUsd(brief.verdict.cost_usd)}</strong>{" "}
              <InfoTip
                label="What cap-weighted equivalent means"
                content="Cost weighted the way your usage cap counts it — cache reads count roughly a tenth of fresh tokens. It's the number that actually moves you toward a limit, not raw token cost."
              >
                cap-weighted equivalent
              </InfoTip>
              <span className="briefs-verdict-sep"> · </span>
              {formatNumber(brief.verdict.hot_session_count)} hot sessions
              <span className="briefs-verdict-sep"> · </span>
              {brief.verdict.peak_friction === null ? (
                <span className="briefs-friction">no friction signal</span>
              ) : (
                <span className={`briefs-friction briefs-friction-${brief.verdict.peak_friction}`}>
                  <InfoTip
                    label="What peak friction means"
                    content="The single worst per-session friction band across this scope's hot sessions, not an average. It flags whether any one session went badly, which an average would hide."
                  >
                    peak friction
                  </InfoTip>{" "}
                  {brief.verdict.peak_friction}
                </span>
              )}
            </h2>
          </section>

          <div className="brief-tiles-head">
            <span className="brief-tiles-heading">Week-over-week changes</span>
            <InfoTip
              label="What the delta tiles show"
              content="Change versus the prior 7 days for spend, cache-write share, and hot-session count. A green delta is improvement; a red one is where this week got worse."
            />
          </div>

          <div className="brief-tiles">
            <BriefTile
              label="Spend equivalent"
              value={formatUsd(brief.deltas.spend_usd.current)}
              delta={brief.deltas.spend_usd}
              format={formatUsd}
            />
            <BriefTile
              label="Cache-write share"
              value={formatPercent(brief.deltas.cache_write_share.current)}
              delta={brief.deltas.cache_write_share}
              format={formatPercent}
            />
            <BriefTile
              label="Hot sessions"
              value={formatNumber(brief.deltas.hot_session_count.current)}
              delta={brief.deltas.hot_session_count}
              format={formatNumber}
            />
          </div>

          <section className="card briefs-actions" aria-labelledby="briefs-actions-heading">
            <div className="section-head">
              <h2 id="briefs-actions-heading">Do these three things</h2>
            </div>
            {brief.actions.length === 0 ? (
              <p className="kpi-off-hint">
                No active recommendations were returned for this scope.
              </p>
            ) : (
              <ol className="briefs-action-list">
                {brief.actions.map((action) => (
                  <li className="briefs-action" key={action.id}>
                    <div className="briefs-action-main">
                      <strong>{action.lever}</strong>
                      <span className="kpi-off-hint">
                        {action.detector_id} · {action.flavor} · modeled savings{" "}
                        {action.modeled_savings_usd_per_wk === null
                          ? "unavailable"
                          : `${formatUsd(action.modeled_savings_usd_per_wk)} / week`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary briefs-action-copy"
                      onClick={() => void copyActionPrompt(action.id, action.prompt)}
                    >
                      {copiedAction === action.id ? "Copied" : "Copy prompt"}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <AttributionDetails brief={brief} />
        </>
      )}
    </div>
  );
}
