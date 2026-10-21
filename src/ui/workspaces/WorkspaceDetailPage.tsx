/**
 * src/ui/workspaces/WorkspaceDetailPage.tsx — Per-workspace spend drill-down (RV1b).
 *
 * Composes from existing endpoints only:
 *   KPI header · Top sessions · Context composition · Recs link · Outcomes (EXP)
 *
 * Row-click on sessions navigates to SessionDetail (#/sessions/:id).
 * Honesty invariants: success stays EXP-chipped; modeled-$ never a workspace headline.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ContextComposition } from "../../query/api/context-composition";
import type { CostPerSuccess } from "../../query/api/cost-per-success";
import type { DeliveryMetrics } from "../../query/api/delivery";
import type { ClosureProxy } from "../../query/api/effectiveness";
import type { WorkspaceOutcomeSummary } from "../../query/api/outcomes";
import type {
  PagedList,
  SessionSummary,
  WorkspaceDetail,
  WorkspaceSummary,
} from "../../query/api/overview";
import type { ApiResponse } from "../../query/envelope";
import {
  fetchClosureProxy,
  fetchContextComposition,
  fetchCostPerSuccess,
  fetchWorkspaceDelivery,
  fetchWorkspaceOutcomes,
  fetchWorkspaceSessions,
  fetchWorkspaces,
} from "../api/client";
import { type WorkspaceHeaderSeed, readWorkspaceSeed } from "../api/drilldown-seed";
import { ObservationEvidence } from "../esf/ObservationEvidence";
import { shortId } from "../lib/short-id";
import { workspaceLabel } from "../lib/workspace-label";
import { useWorkspaceNames } from "../lib/workspace-names";
import { KpiCard } from "../overview/KpiCard";
import AsyncErrorState from "../shell/AsyncErrorState";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock, SkeletonKpi, SkeletonRow } from "../shell/Skeleton";
import ContextCompositionPanel from "./ContextCompositionPanel";
import WorkspaceOutcomeTable from "./WorkspaceOutcomeTable";
import {
  currentHash,
  detailScope,
  scopeFilter,
  scopedHash,
  subscribeToScope,
} from "./workspace-scope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: ApiResponse<T>; scope?: string };

const staleWorkspaceList = { status: "loading" } as const;

interface Props {
  workspaceId: string;
  onBack: () => void;
}

type WorkspaceRow = WorkspaceDetail & {
  repo_owner?: string | null | undefined;
  repo_name?: string | null | undefined;
  repo_path?: string | null | undefined;
  repo_canonical?: string | null | undefined;
};

// ---------------------------------------------------------------------------
// Label maps (DUI-15)
// ---------------------------------------------------------------------------

const SESSION_STATE_LABEL: Record<string, string> = {
  RECONCILED: "Reconciled",
  LIVE: "Live now",
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtUsd(u: number): string {
  const usd = u / 1_000_000;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtUsdPerTurn(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toFixed(3)}`;
}

function fmtCtxPerTurn(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n)}`;
}

function fmtDate(iso: string | null): string {
  if (iso === null) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkspaceDetailPage({ workspaceId, onBack }: Props) {
  const { labelFor } = useWorkspaceNames();
  const hash = useSyncExternalStore(subscribeToScope, currentHash, () => "");
  const preset = detailScope(hash);
  const scopedDetailHash = scopedHash(
    `#/workspaces/${encodeURIComponent(workspaceId)}`,
    preset,
    hash,
  );
  const [rawWsListState, setWsListState] = useState<LoadState<PagedList<WorkspaceSummary>>>({
    status: "loading",
  });
  const [sessionsState, setSessionsState] = useState<LoadState<PagedList<SessionSummary>>>({
    status: "loading",
  });
  const [contextState, setContextState] = useState<LoadState<ContextComposition>>({
    status: "loading",
  });
  const [outcomeState, setOutcomeState] = useState<LoadState<WorkspaceOutcomeSummary[]>>({
    status: "loading",
  });
  const [closureProxyState, setClosureProxyState] = useState<LoadState<ClosureProxy>>({
    status: "loading",
  });
  const [costPerSuccessState, setCostPerSuccessState] = useState<LoadState<CostPerSuccess>>({
    status: "loading",
  });
  const [deliveryState, setDeliveryState] = useState<LoadState<DeliveryMetrics>>({
    status: "loading",
  });
  const requestScope = `${workspaceId}\u0000${preset}`;
  const wsListState =
    rawWsListState.status === "ok" && rawWsListState.scope !== requestScope
      ? staleWorkspaceList
      : rawWsListState;
  const currentRequest = useRef<{
    scope: string;
    generation: number;
    mounted: boolean;
  }>({ scope: requestScope, generation: 0, mounted: false });

  useLayoutEffect(() => {
    currentRequest.current.scope = requestScope;
    currentRequest.current.mounted = true;
    return () => {
      currentRequest.current.mounted = false;
      currentRequest.current.generation += 1;
    };
  }, [requestScope]);

  function retryLoad<T>(
    load: () => Promise<ApiResponse<T> | undefined>,
    setState: Dispatch<SetStateAction<LoadState<T>>>,
  ) {
    const generation = currentRequest.current.generation;
    const isCurrent = () =>
      currentRequest.current.mounted && currentRequest.current.generation === generation;
    setState({ status: "loading" });
    void Promise.resolve()
      .then(load)
      .then((value) => {
        if (isCurrent() && value !== undefined)
          setState({ status: "ok", value, scope: requestScope });
      })
      .catch((error: unknown) => {
        if (isCurrent()) setState({ status: "error", message: String(error) });
      });
  }

  useEffect(() => {
    let active = true;
    setWsListState({ status: "loading" });
    setSessionsState({ status: "loading" });
    setContextState({ status: "loading" });
    setOutcomeState({ status: "loading" });
    setClosureProxyState({ status: "loading" });
    setCostPerSuccessState({ status: "loading" });
    setDeliveryState({ status: "loading" });
    fetchWorkspaces(scopeFilter(preset))
      .then((v) => {
        if (!active) return;
        setWsListState({ status: "ok", value: v, scope: requestScope });
      })
      .catch((e: unknown) => {
        if (active) {
          setWsListState({ status: "error", message: String(e) });
        }
      });

    fetchContextComposition(workspaceId)
      .then((v) => {
        if (active) setContextState({ status: "ok", value: v });
      })
      .catch((e: unknown) => {
        if (active) setContextState({ status: "error", message: String(e) });
      });

    fetchWorkspaceOutcomes()
      .then((v) => {
        if (active) setOutcomeState({ status: "ok", value: v });
      })
      .catch((e: unknown) => {
        if (active) setOutcomeState({ status: "error", message: String(e) });
      });

    fetchClosureProxy(workspaceId)
      .then((v) => {
        if (active) setClosureProxyState({ status: "ok", value: v });
      })
      .catch((e: unknown) => {
        if (active) setClosureProxyState({ status: "error", message: String(e) });
      });

    // P1-U6a: these no longer wait for /api/workspaces' meta.window. Each route resolves the
    // same scope itself (drilldown-window-parity.test.ts proves the windows match).
    const window = scopeFilter(preset);
    Promise.resolve(fetchWorkspaceSessions(workspaceId, window))
      .then((value) => {
        if (active && value !== undefined) setSessionsState({ status: "ok", value });
      })
      .catch((error: unknown) => {
        if (active) setSessionsState({ status: "error", message: String(error) });
      });
    Promise.resolve(fetchCostPerSuccess(window, workspaceId))
      .then((value) => {
        if (active && value !== undefined) setCostPerSuccessState({ status: "ok", value });
      })
      .catch((error: unknown) => {
        if (active) setCostPerSuccessState({ status: "error", message: String(error) });
      });
    Promise.resolve(fetchWorkspaceDelivery(workspaceId, window))
      .then((value) => {
        if (active && value !== undefined) setDeliveryState({ status: "ok", value });
      })
      .catch((error: unknown) => {
        if (active) setDeliveryState({ status: "error", message: String(error) });
      });

    return () => {
      active = false;
    };
  }, [workspaceId, preset, requestScope]);

  const wsList: WorkspaceRow[] =
    wsListState.status === "ok" ? ((wsListState.value.data?.items as WorkspaceRow[]) ?? []) : [];
  const workspace = wsList.find((w) => w.workspace_id === workspaceId);
  // P1-U6a: until the list arrives, the clicked Workspaces row (same window) paints the header.
  const seed =
    wsListState.status === "loading" ? readWorkspaceSeed(workspaceId, preset) : undefined;
  const header: (WorkspaceHeaderSeed & { repo_canonical?: string | null }) | undefined =
    workspace ?? seed;
  const label = header
    ? workspaceLabel({
        workspace_id: header.workspace_id,
        repo_owner: header.repo_owner ?? null,
        repo_name: header.repo_name ?? null,
        repo_path: header.repo_path ?? null,
        repo_canonical: header.repo_canonical ?? null,
      })
    : workspaceId;

  const sessions = sessionsState.status === "ok" ? (sessionsState.value.data?.items ?? []) : [];

  const contextData = contextState.status === "ok" ? contextState.value.data : null;

  const outcomeData = outcomeState.status === "ok" ? outcomeState.value.data : null;
  const workspaceOutcome = outcomeData?.find((o) => o.workspace_id === workspaceId) ?? null;
  const outcomeRows = workspaceOutcome !== null ? [workspaceOutcome] : null;
  const closureProxy = closureProxyState.status === "ok" ? closureProxyState.value.data : null;

  const costPerSuccess =
    costPerSuccessState.status === "ok" ? costPerSuccessState.value.data : null;
  const delivery = deliveryState.status === "ok" ? deliveryState.value.data : null;

  return (
    <div>
      {/* Back + header */}
      <button type="button" className="btn-secondary page-back" onClick={onBack}>
        <span aria-hidden="true">← </span>Back to workspaces
      </button>
      <div className="page-top">
        <div className="page-title">
          <h1>
            {label} {header?.has_live && <span className="chip live">● live now</span>}
          </h1>
          <p className="page-sub">Workspace detail · selected {preset} window</p>
        </div>
        <div className="page-top-controls">
          <div className="date-range" aria-label="Workspace date range">
            {(["24h", "7d", "30d", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`date-preset-btn${preset === value ? " active" : ""}`}
                onClick={() => {
                  window.location.hash = scopedHash(
                    hash.split("?")[0] || `#/workspaces/${encodeURIComponent(workspaceId)}`,
                    value,
                    hash,
                  );
                }}
                aria-pressed={preset === value}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI header */}
      <section className="sec" aria-labelledby="workspace-period-title">
        <div className="sec-h">
          <h2 id="workspace-period-title">This period ({preset})</h2>
          <span className="desc">
            <Chip kind="LIST_EQUIV" />
          </span>
        </div>
        <div className="grid g4">
          {wsListState.status === "loading" && seed === undefined && (
            <>
              <SkeletonKpi />
              <SkeletonKpi />
              <SkeletonKpi />
            </>
          )}
          {wsListState.status === "error" && (
            <AsyncErrorState
              resource="workspaces"
              onRetry={() => {
                retryLoad(() => fetchWorkspaces(scopeFilter(preset)), setWsListState);
              }}
            />
          )}
          {wsListState.status !== "error" && header !== undefined && (
            <>
              <KpiCard
                label={`Spend (${preset})`}
                info="Estimated token value for this workspace in the selected window — list prices, not your bill. Use it to compare periods and spot sharp cost increases."
                value={fmtUsd(header.cost_equiv_u)}
                cmp={`${header.turns.toLocaleString()} reconciled turns`}
              />
              <KpiCard
                label="Cost per turn"
                info="Estimated cost per turn — size-independent efficiency for this workspace. A rising value can mean context windows are growing; compare across windows to check for trend."
                value={fmtUsdPerTurn(header.usd_per_turn)}
                cmp={`Context per turn: ${fmtCtxPerTurn(header.avg_context_per_turn)}`}
              />
              <KpiCard
                label={`Sessions (${preset})`}
                info="Exact count of reconciled sessions (Claude Code runs) recorded in the selected window. A session becomes reconciled after its JSONL file closes; live sessions appear separately."
                value={
                  sessionsState.status === "ok"
                    ? String(sessionsState.value.data?.items.length ?? 0)
                    : "…"
                }
                cmp={
                  header.has_live ? (
                    <span className="chip live">● live now</span>
                  ) : (
                    "No live sessions"
                  )
                }
              >
                <div className="chips">
                  <Chip kind="EXACT" />
                </div>
              </KpiCard>
            </>
          )}
          {wsListState.status === "ok" && workspace === undefined && (
            <div className="banner banner-info" role="note">
              <span>
                No spend data found for workspace {labelFor(workspaceId)} in the selected {preset}{" "}
                window.
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Top sessions */}
      <section className="sec" aria-labelledby="workspace-top-sessions-title">
        <div className="sec-h">
          <h2 id="workspace-top-sessions-title">
            <a href={`#/sessions?workspace=${encodeURIComponent(workspaceId)}`}>Top sessions</a>
          </h2>
          <span className="desc sec-h-controls">
            <Chip kind="LIST_EQUIV" />
            <a href={`#/sessions?workspace=${encodeURIComponent(workspaceId)}`}>
              All sessions in this workspace →
            </a>
          </span>
        </div>
        <div className="card card-padded">
          {sessionsState.status === "loading" && (
            <div aria-busy="true" aria-label="Loading sessions">
              <SkeletonBlock />
            </div>
          )}
          {sessionsState.status === "error" && (
            <AsyncErrorState
              resource="workspace-detail-sessions"
              onRetry={() => {
                retryLoad(
                  () => fetchWorkspaceSessions(workspaceId, scopeFilter(preset)),
                  setSessionsState,
                );
              }}
            />
          )}
          {sessionsState.status === "ok" && sessions.length === 0 && (
            <EmptyState
              headline="No sessions found"
              why={`No sessions were recorded for this workspace from ${fmtDate(sessionsState.value.meta.window.from)} to ${fmtDate(sessionsState.value.meta.window.to)}.`}
              whatWillAppear="Session rows will appear after Claude Code activity is detected."
            />
          )}
          {sessionsState.status === "ok" && sessions.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>State</th>
                    <th>Turns</th>
                    <th>Cost</th>
                    <th>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions
                    .slice()
                    .sort((a, b) => (b.cost_equiv_u ?? 0) - (a.cost_equiv_u ?? 0))
                    .slice(0, 10)
                    .map((session) => (
                      <tr key={session.session_id}>
                        <td>
                          <a
                            href={`#/sessions/${encodeURIComponent(session.session_id)}?${new URLSearchParams({ returnTo: scopedDetailHash })}`}
                            title={session.session_id}
                          >
                            {shortId(session.session_id)}
                          </a>
                          {session.state === "LIVE" && <Chip kind="LIVE" label="LIVE" />}
                        </td>
                        <td>{SESSION_STATE_LABEL[session.state] ?? session.state}</td>
                        <td>{session.turn_count}</td>
                        <td>
                          {session.cost_equiv_u !== null ? fmtUsd(session.cost_equiv_u) : "—"}
                        </td>
                        <td>{fmtDate(session.last_turn_at)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Where tokens went */}
      <section className="sec" aria-labelledby="workspace-tokens-title">
        <div className="sec-h">
          <h2 id="workspace-tokens-title">Where tokens went</h2>
          <a href={`#/recommendations?ws=${encodeURIComponent(workspaceId)}`}>
            View workspace recommendations →
          </a>
        </div>
        <div className="card card-padded">
          {contextState.status === "loading" && (
            <div aria-busy="true" aria-label="Loading context composition">
              <SkeletonBlock />
            </div>
          )}
          {contextState.status === "error" && (
            <AsyncErrorState
              resource="context-composition"
              onRetry={() => {
                retryLoad(() => fetchContextComposition(workspaceId), setContextState);
              }}
            />
          )}
          {contextState.status === "ok" && <ContextCompositionPanel data={contextData} />}
        </div>
      </section>

      {/* Outcomes — EXP chipped */}
      <section className="sec" aria-labelledby="workspace-outcomes-title">
        <div className="sec-h">
          <h2 id="workspace-outcomes-title">Outcomes</h2>
          <span className="desc">
            <Chip kind="EXPERIMENTAL" />
          </span>
        </div>
        <div>
          {outcomeState.status === "loading" && (
            <div aria-busy="true" aria-label="Loading outcomes">
              <SkeletonBlock />
            </div>
          )}
          {outcomeState.status === "error" && (
            <AsyncErrorState
              resource="outcomes"
              onRetry={() => {
                retryLoad(() => fetchWorkspaceOutcomes(), setOutcomeState);
              }}
            />
          )}
          {outcomeState.status === "ok" && workspaceOutcome === null && (
            <EmptyState
              headline="No outcome data"
              why="No pull requests are linked to sessions in this workspace."
              whatWillAppear="Outcome signals and pull-request status will appear after linked work is observed."
            />
          )}
          {outcomeState.status === "ok" && workspaceOutcome !== null && (
            <WorkspaceOutcomeTable rows={outcomeRows} />
          )}
        </div>
      </section>

      <section
        className="sec"
        aria-labelledby="workspace-delivery-title"
        data-testid="workspace-delivery-card"
      >
        <div className="sec-h">
          <h2 id="workspace-delivery-title">Observed delivery proxy</h2>
          <span className="desc">
            <Chip kind="OBS_PROXY" />
          </span>
        </div>
        {deliveryState.status === "loading" && (
          <div aria-busy="true" aria-label="Loading delivery metrics">
            <SkeletonBlock />
          </div>
        )}
        {deliveryState.status === "error" && (
          <AsyncErrorState
            resource="delivery-metrics"
            onRetry={() => {
              retryLoad(
                () => fetchWorkspaceDelivery(workspaceId, scopeFilter(preset)),
                setDeliveryState,
              );
            }}
          />
        )}
        {deliveryState.status === "ok" && delivery !== null && (
          <div className="grid g4">
            <KpiCard
              label="Commit-session rate"
              info="Share of reconciled sessions that included at least one observed git commit. A proxy for delivery — most productive sessions end with a commit. Low rates may reflect exploratory or review-only work."
              value={
                delivery.commit_session_rate === null
                  ? "No data"
                  : `${(delivery.commit_session_rate * 100).toFixed(1)}%`
              }
              cmp={`${delivery.commit_session_count}/${delivery.total_session_count} sessions with an observed commit`}
            />
            <KpiCard
              label="Spend per commit session"
              info="Estimated cost averaged over sessions that included an observed commit — excludes sessions with no commit. A rising value can mean sessions are taking more turns before a commit lands."
              value={
                delivery.spend_per_commit_session_u === null
                  ? "—"
                  : fmtUsd(delivery.spend_per_commit_session_u)
              }
              cmp={`${delivery.commit_session_count}/${delivery.total_session_count} commit-session coverage`}
            />
            <KpiCard
              label="Bash/edit activity without an observed commit"
              info="Number of reconciled sessions with Bash or edit-tool activity but no observed commit. Includes exploratory sessions, review-only work, and sessions where git commits are not tracked by the daemon."
              value={`${delivery.no_commit_activity_session_count}/${delivery.total_session_count}`}
              cmp="reconciled activity sessions"
            />
          </div>
        )}
        {deliveryState.status === "ok" && delivery === null && (
          <div className="card card-padded kpi-off">No data</div>
        )}
        {deliveryState.status === "ok" && (
          <p className="foot">{deliveryState.value.meta.qualification.note}</p>
        )}
      </section>

      {/* EF1 — Abandoned spend split */}
      {wsListState.status === "ok" &&
        workspace !== undefined &&
        (workspace.deep_abandoned_spend_u !== undefined ||
          workspace.early_abandoned_spend_u !== undefined) && (
          <section className="sec" data-testid="ef1-abandoned-spend">
            <div className="sec-h">
              <h2>
                Reconciled no-commit activity{" "}
                <InfoTip
                  label="Reconciled no-commit activity"
                  content="Splits reconciled Bash, Edit, Write, and NotebookEdit activity without an observed commit into long sessions with at least 10 user turns and early sessions with fewer than 10. It is activity without a recorded commit, not an abandonment finding; LIVE sessions remain in total spend but are excluded from this cohort."
                />
              </h2>
              <span className="desc">
                <Chip kind="OBS_PROXY" />
              </span>
            </div>
            <div className="card card-padded">
              <dl className="kv-list">
                <dt>Long no-commit activity (10+ user turns)</dt>
                <dd style={{ margin: 0 }} data-testid="deep-abandoned-spend">
                  {workspace.deep_abandoned_spend_u !== undefined
                    ? fmtUsd(workspace.deep_abandoned_spend_u)
                    : "—"}
                </dd>
                <dt>Early no-commit activity (under 10 user turns)</dt>
                <dd style={{ margin: 0 }} data-testid="early-abandoned-spend">
                  {workspace.early_abandoned_spend_u !== undefined
                    ? fmtUsd(workspace.early_abandoned_spend_u)
                    : "—"}
                </dd>
              </dl>
            </div>
          </section>
        )}

      {/* EF2 — Closure proxy */}
      <section className="sec" data-testid="ef2-closure-proxy">
        <div className="sec-h">
          <h2>
            No later workspace session within 48h{" "}
            <InfoTip
              label="No later workspace session within 48h"
              content="This is a workspace-history, as-of-time observation for reconciled no-commit sessions. It is independent of the selected date range. No later workspace session within 48 hours does not establish task resolution; a later session can be unrelated work. Pending means 48 hours has not passed."
            />
          </h2>
          <span className="desc">
            <Chip kind="DIRECTIONAL" />
          </span>
        </div>
        <div className="card card-padded">
          {closureProxyState.status === "loading" && (
            <div aria-busy="true" aria-label="Loading closure proxy">
              <SkeletonBlock />
            </div>
          )}
          {closureProxyState.status === "error" && (
            <AsyncErrorState
              resource="closure-proxy"
              onRetry={() => {
                retryLoad(() => fetchClosureProxy(workspaceId), setClosureProxyState);
              }}
            />
          )}
          {closureProxyState.status === "ok" && closureProxy !== null && (
            <div>
              <div data-testid="closure-proxy-summary" style={{ marginBottom: 8 }}>
                {closureProxy.no_commit_session_count === 0 ? (
                  <span style={{ color: "var(--text-muted)" }}>
                    No no-commit sessions observed.
                  </span>
                ) : (
                  <span>
                    {(closureProxy.no_later_workspace_session_share ??
                      closureProxy.resolved_share) !== null
                      ? `${closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count}/${(closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count) + (closureProxy.later_workspace_session_count ?? closureProxy.unresolved_count)} reconciled no-commit sessions had no later workspace session within 48h (${closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count} of ${(closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count) + (closureProxy.later_workspace_session_count ?? closureProxy.unresolved_count)}; ${Math.round((closureProxy.no_later_workspace_session_share ?? closureProxy.resolved_share ?? 0) * 100)}%)`
                      : `${closureProxy.no_commit_session_count}/${closureProxy.no_commit_session_count} no-commit sessions — all PENDING (48h window not elapsed)`}
                  </span>
                )}
              </div>
              <dl className="kv-list">
                <dt>No later workspace session</dt>
                <dd style={{ margin: 0 }} data-testid="closure-resolved">
                  {closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count}
                </dd>
                <dt>Later workspace session</dt>
                <dd style={{ margin: 0 }} data-testid="closure-unresolved">
                  {closureProxy.later_workspace_session_count ?? closureProxy.unresolved_count}
                </dd>
                <dt>Pending</dt>
                <dd style={{ margin: 0 }} data-testid="closure-pending">
                  {closureProxy.pending_count}
                </dd>
              </dl>
              <p className="kpi-fn" style={{ marginTop: 8, marginBottom: 0 }}>
                A later session can be unrelated work; burst-working operators can false-flag this
                observation. PENDING sessions are excluded from the observation denominator.
              </p>
              <div
                aria-label="48 hour follow-up composition"
                data-testid="closure-follow-up-bar"
                style={{ display: "flex", height: 8, marginTop: 8, overflow: "hidden" }}
              >
                <span
                  style={{
                    background: "var(--series-1)",
                    flexGrow:
                      closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count,
                  }}
                  title={`No later session: ${closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count}`}
                />
                <span
                  style={{
                    background: "var(--amber)",
                    flexGrow:
                      closureProxy.later_workspace_session_count ?? closureProxy.unresolved_count,
                  }}
                  title={`Later session: ${closureProxy.later_workspace_session_count ?? closureProxy.unresolved_count}`}
                />
                <span
                  style={{ background: "var(--muted)", flexGrow: closureProxy.pending_count }}
                  title={`PENDING: ${closureProxy.pending_count}`}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* R4a — Lifecycle cost per delivered outcome */}
      <section className="sec" data-testid="r4a-cost-per-success">
        <div className="sec-h">
          <h2>
            Unique linked-session cost per merged PR{" "}
            <InfoTip
              label="Unique linked-session cost per merged PR"
              content="The terminal-date merged PR cohort counts each linked session once, even if it links to multiple merged PRs. Shared sessions are reported as coverage and are never allocated across PRs. Full linked-session lifecycle cost differs from the separate session-start linkage coverage observation. A merge is a reviewer decision, not proof of quality."
            />
          </h2>
          <span className="desc sec-h-controls">
            <Chip kind="DIRECTIONAL" />
            <Chip kind="OBS_PROXY" />
          </span>
        </div>
        <div className="card card-padded">
          {costPerSuccessState.status === "loading" && (
            <div aria-busy="true" aria-label="Loading cost per delivered outcome">
              <SkeletonBlock />
            </div>
          )}
          {costPerSuccessState.status === "error" && (
            <AsyncErrorState
              resource="cost-per-delivered-outcome"
              onRetry={() => {
                retryLoad(
                  () => fetchCostPerSuccess(scopeFilter(preset), workspaceId),
                  setCostPerSuccessState,
                );
              }}
            />
          )}
          {costPerSuccessState.status === "ok" && costPerSuccess !== null && (
            <div>
              <div data-testid="r4a-summary" style={{ marginBottom: 8 }}>
                {costPerSuccess.merged_pr_count === 0 ? (
                  <span style={{ color: "var(--text-muted)" }}>
                    No merged pull requests are linked in this period, so the value per merged pull
                    request is unavailable.
                  </span>
                ) : (
                  <span>
                    {costPerSuccess.merged_pr_count} merged PR
                    {costPerSuccess.merged_pr_count === 1 ? "" : "s"} at{" "}
                    {costPerSuccess.cost_per_merged_pr_u !== null
                      ? fmtUsd(costPerSuccess.cost_per_merged_pr_u)
                      : "—"}{" "}
                    per merged PR (unique linked-session lifecycle cost).
                  </span>
                )}
              </div>
              <dl className="kv-list">
                <dt>Unique linked-session cost / merged PRs</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-cost-per-merged-pr">
                  {costPerSuccess.cost_per_merged_pr_u !== null
                    ? fmtUsd(costPerSuccess.cost_per_merged_pr_u)
                    : "— (no merged PRs yet)"}
                </dd>
                <dt>Merged pull requests</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-merged-count">
                  {costPerSuccess.merged_pr_count}
                </dd>
                <dt>Unique linked sessions</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-unique-linked-session-count">
                  {costPerSuccess.unique_linked_session_count ?? "— unavailable"}
                </dd>
                <dt>Shared across merged PRs</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-shared-linked-session-count">
                  {costPerSuccess.shared_linked_session_count ?? "— unavailable"}
                </dd>
                <dt>Closed unmerged</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-closed-count">
                  {costPerSuccess.closed_unmerged_count}
                </dd>
                <dt>Est. value per commit session</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-cost-per-commit-session">
                  {costPerSuccess.cost_per_commit_session_u !== null
                    ? fmtUsd(costPerSuccess.cost_per_commit_session_u)
                    : "— (no commit-sessions yet)"}
                </dd>
                <dt>Commit sessions</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-commit-session-count">
                  {costPerSuccess.commit_session_count}
                </dd>
                <dt>In-window sessions linked to pull requests</dt>
                <dd style={{ margin: 0 }} data-testid="r4a-linkage-coverage">
                  {costPerSuccess.linkage_coverage_pct !== null
                    ? `${Math.round(costPerSuccess.linkage_coverage_pct)}%`
                    : "—"}
                </dd>
              </dl>
              <div style={{ marginTop: 8 }} data-testid="r4a-coverage-bar">
                <div
                  style={{ display: "flex", height: 8, overflow: "hidden" }}
                  aria-label="Linked-session coverage"
                >
                  <span
                    style={{
                      background: "var(--series-1)",
                      flexGrow: costPerSuccess.linkage_coverage_pct ?? 0,
                    }}
                    title={`Linked-session coverage: ${costPerSuccess.linkage_coverage_pct ?? "UNAVAILABLE"}`}
                  />
                  <span
                    style={{
                      background: "var(--muted)",
                      flexGrow: 100 - (costPerSuccess.linkage_coverage_pct ?? 0),
                    }}
                    title="unlinked spend excluded — survivorship"
                  />
                </div>
                <div className="kpi-subval" style={{ marginTop: 4 }}>
                  unlinked spend excluded — survivorship
                </div>
              </div>
              <p className="kpi-fn" style={{ marginTop: 8, marginBottom: 0 }}>
                {costPerSuccess.linkage_coverage_pct !== null
                  ? `Only ${Math.round(costPerSuccess.linkage_coverage_pct)}% of in-window sessions are linked to a PR — unlinked spend is excluded. `
                  : "Linkage coverage is unavailable, so the linked-only view cannot be bounded. "}
                Survivorship: heavy-spend sessions that never open a PR are invisible. Merge is a
                reviewer's decision, not a quality guarantee. Full session cost is attributed to the
                PR cohort once (lifecycle attribution); shared sessions are coverage rather than
                allocation.
              </p>
            </div>
          )}
          {costPerSuccessState.status === "ok" && costPerSuccess === null && (
            <div data-testid="r4a-empty">
              <span style={{ color: "var(--text-muted)" }}>
                No cost-per-success data for this workspace in the selected window.
              </span>
            </div>
          )}
        </div>
      </section>

      {/* OV-11 Q3: cohort evidence + reported work sit below the data sections. Mount after the
          sessions request settles: the daemon serves requests one at a time, and the two ~0.6 s
          observation queries otherwise delay the top-sessions table (OV-11 Perf). */}
      {wsListState.status === "ok" && sessionsState.status !== "loading" ? (
        <ObservationEvidence
          workspaceId={workspaceId}
          filter={{
            from: wsListState.value.meta.window.from,
            to: wsListState.value.meta.window.to,
          }}
          title="Evidence by cohort"
        />
      ) : (
        <p className="foot" aria-busy={wsListState.status !== "error"}>
          {wsListState.status !== "error"
            ? "Loading selected cohort…"
            : "Selected cohort unavailable because the workspace request failed."}
        </p>
      )}
    </div>
  );
}
