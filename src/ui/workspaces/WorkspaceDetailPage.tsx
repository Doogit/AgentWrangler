/**
 * src/ui/workspaces/WorkspaceDetailPage.tsx — Per-workspace spend drill-down (RV1b).
 *
 * Composes from existing endpoints only:
 *   KPI header · Top sessions · Context composition · Recs link · Outcomes (EXP)
 *
 * Row-click on sessions navigates to SessionDetail (#/sessions/:id).
 * Honesty invariants: success stays EXP-chipped; modeled-$ never a workspace headline.
 */

import { useEffect, useState } from "react";
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
import { ObservationEvidence } from "../esf/ObservationEvidence";
import { workspaceLabel } from "../lib/workspace-label";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock, SkeletonKpi, SkeletonRow } from "../shell/Skeleton";
import ContextCompositionPanel from "./ContextCompositionPanel";
import WorkspaceOutcomeTable from "./WorkspaceOutcomeTable";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: ApiResponse<T> };

type Preset = "24h" | "7d" | "30d";

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
  const [preset, setPreset] = useState<Preset>("7d");
  const [wsListState, setWsListState] = useState<LoadState<PagedList<WorkspaceSummary>>>({
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

  useEffect(() => {
    let active = true;
    setWsListState({ status: "loading" });
    setSessionsState({ status: "loading" });
    setContextState({ status: "loading" });
    setOutcomeState({ status: "loading" });
    setClosureProxyState({ status: "loading" });
    setCostPerSuccessState({ status: "loading" });
    setDeliveryState({ status: "loading" });
    fetchWorkspaces({ preset })
      .then((v) => {
        if (!active) return;
        setWsListState({ status: "ok", value: v });
        const selectedWindow = { from: v.meta.window.from, to: v.meta.window.to };
        fetchWorkspaceSessions(workspaceId, selectedWindow)
          .then((v) => {
            if (active) setSessionsState({ status: "ok", value: v });
          })
          .catch((e: unknown) => {
            if (active) setSessionsState({ status: "error", message: String(e) });
          });

        fetchCostPerSuccess(selectedWindow, workspaceId)
          .then((v) => {
            if (active) setCostPerSuccessState({ status: "ok", value: v });
          })
          .catch((e: unknown) => {
            if (active) setCostPerSuccessState({ status: "error", message: String(e) });
          });

        Promise.resolve(fetchWorkspaceDelivery(workspaceId, selectedWindow))
          .then((v) => {
            if (active && v !== undefined) setDeliveryState({ status: "ok", value: v });
          })
          .catch((e: unknown) => {
            if (active) setDeliveryState({ status: "error", message: String(e) });
          });
      })
      .catch((e: unknown) => {
        if (active) {
          setWsListState({ status: "error", message: String(e) });
          setSessionsState({ status: "error", message: "Selected cohort unavailable" });
          setCostPerSuccessState({ status: "error", message: "Selected cohort unavailable" });
          setDeliveryState({ status: "error", message: "Selected cohort unavailable" });
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

    return () => {
      active = false;
    };
  }, [workspaceId, preset]);

  const wsList =
    wsListState.status === "ok" ? ((wsListState.value.data?.items as WorkspaceRow[]) ?? []) : [];
  const workspace = wsList.find((w) => w.workspace_id === workspaceId);
  const label = workspace
    ? workspaceLabel({
        workspace_id: workspace.workspace_id,
        repo_owner: workspace.repo_owner ?? null,
        repo_name: workspace.repo_name ?? null,
        repo_path: workspace.repo_path ?? null,
        repo_canonical: workspace.repo_canonical ?? null,
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
      <div className="page-top">
        <div className="page-title">
          <button
            type="button"
            className="btn-ghost"
            onClick={onBack}
            aria-label="Back to workspaces"
            style={{ marginRight: 8 }}
          >
            ← Back
          </button>
          <h1 style={{ display: "inline" }}>{label}</h1>
          <p className="page-sub">Workspace detail · selected {preset} window</p>
        </div>
        <div className="chips">
          <div className="date-range" aria-label="Workspace date range">
            {(["24h", "7d", "30d"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`date-preset-btn${preset === value ? " active" : ""}`}
                onClick={() => setPreset(value)}
                aria-pressed={preset === value}
              >
                {value}
              </button>
            ))}
          </div>
          <Chip kind="LIST_EQUIV" />
        </div>
      </div>

      {/* KPI header */}
      <div className="kpi-grid">
        {wsListState.status === "loading" && (
          <>
            <SkeletonKpi />
            <SkeletonKpi />
            <SkeletonKpi />
          </>
        )}
        {wsListState.status === "error" && (
          <div className="banner banner-error" role="alert">
            <span>Workspace data unavailable — {wsListState.message}</span>
          </div>
        )}
        {wsListState.status === "ok" && workspace !== undefined && (
          <>
            <div className="kpi card">
              <div className="kpi-label">SPEND ({preset})</div>
              <div className="kpi-value">{fmtUsd(workspace.cost_equiv_u)}</div>
              <div className="kpi-subval">{workspace.turns.toLocaleString()} reconciled turns</div>
              <div className="chips">
                <Chip kind="LIST_EQUIV" />
              </div>
            </div>
            <div className="kpi card">
              <div className="kpi-label">$/TURN</div>
              <div className="kpi-value">{fmtUsdPerTurn(workspace.usd_per_turn)}</div>
              <div className="kpi-subval">
                Ctx/turn: {fmtCtxPerTurn(workspace.avg_context_per_turn)}
              </div>
              <div className="chips">
                <Chip kind="LIST_EQUIV" />
              </div>
            </div>
            <div className="kpi card">
              <div className="kpi-label">SESSIONS ({preset})</div>
              <div className="kpi-value">
                {sessionsState.status === "ok"
                  ? (sessionsState.value.data?.items.length ?? 0)
                  : "…"}
              </div>
              <div className="kpi-subval">
                {workspace.has_live ? "● live now" : "No live sessions"}
              </div>
              <div className="chips">
                <Chip kind="EXACT" />
              </div>
            </div>
          </>
        )}
        {wsListState.status === "ok" && workspace === undefined && (
          <div className="banner banner-info" role="note">
            <span>
              No spend data found for workspace <code>{workspaceId}</code> in the selected {preset}{" "}
              window.
            </span>
          </div>
        )}
      </div>

      {wsListState.status === "ok" ? (
        <ObservationEvidence
          workspaceId={workspaceId}
          filter={{
            from: wsListState.value.meta.window.from,
            to: wsListState.value.meta.window.to,
          }}
          title="Evidence by cohort"
        />
      ) : (
        <p aria-busy={wsListState.status === "loading"}>
          {wsListState.status === "loading"
            ? "Loading selected cohort?"
            : "Selected cohort unavailable because the workspace request failed."}
        </p>
      )}

      {/* Top sessions */}
      <div className="card" style={{ marginBottom: 13 }}>
        <div className="section-head">
          <h2>Top sessions</h2>
          <span className="section-meta">
            <Chip kind="LIST_EQUIV" />
          </span>
        </div>

        {sessionsState.status === "loading" && (
          <div aria-busy="true" aria-label="Loading sessions">
            <SkeletonBlock />
          </div>
        )}
        {sessionsState.status === "error" && (
          <div className="banner banner-error" role="alert">
            <span>Sessions unavailable — {sessionsState.message}</span>
          </div>
        )}
        {sessionsState.status === "ok" && sessions.length === 0 && (
          <EmptyState
            headline="No sessions found"
            why={`No sessions were recorded for this workspace in [${sessionsState.value.meta.window.from}, ${sessionsState.value.meta.window.to}).`}
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
                    <tr
                      key={session.session_id}
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        window.location.hash = `#/sessions/${encodeURIComponent(session.session_id)}`;
                      }}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          window.location.hash = `#/sessions/${encodeURIComponent(session.session_id)}`;
                        }
                      }}
                      aria-label={`Open session ${session.session_id}`}
                    >
                      <td>
                        <code style={{ fontSize: 11 }}>{session.session_id.slice(-12)}</code>
                        {session.state === "LIVE" && <Chip kind="LIVE" label="LIVE" />}
                      </td>
                      <td>{session.state}</td>
                      <td>{session.turn_count}</td>
                      <td>{session.cost_equiv_u !== null ? fmtUsd(session.cost_equiv_u) : "—"}</td>
                      <td>{fmtDate(session.last_turn_at)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Where tokens went */}
      <div className="card" style={{ marginBottom: 13 }}>
        <div className="section-head">
          <h2>Where tokens went</h2>
        </div>
        <div style={{ marginBottom: 8 }}>
          <a
            href={`#/recommendations?ws=${encodeURIComponent(workspaceId)}`}
            style={{ fontSize: 13 }}
          >
            View workspace recommendations →
          </a>
        </div>
        {contextState.status === "loading" && (
          <div aria-busy="true" aria-label="Loading context composition">
            <SkeletonBlock />
          </div>
        )}
        {contextState.status === "error" && (
          <div className="banner banner-error" role="alert">
            <span>Context composition unavailable — {contextState.message}</span>
          </div>
        )}
        {contextState.status === "ok" && <ContextCompositionPanel data={contextData} />}
      </div>

      {/* Outcomes — EXP chipped */}
      <div className="card" style={{ marginBottom: 13 }}>
        <div className="section-head">
          <h2>Outcomes</h2>
          <div className="chips">
            <Chip kind="EXPERIMENTAL" />
          </div>
        </div>
        {outcomeState.status === "loading" && (
          <div aria-busy="true" aria-label="Loading outcomes">
            <SkeletonBlock />
          </div>
        )}
        {outcomeState.status === "error" && (
          <div className="banner banner-error" role="alert">
            <span>Outcomes unavailable — {outcomeState.message}</span>
          </div>
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

      <div className="card" style={{ marginBottom: 13 }} data-testid="workspace-delivery-card">
        <div className="section-head">
          <h2>Observed delivery proxy</h2>
          <div className="chips">
            <Chip kind="OBS_PROXY" />
          </div>
        </div>
        {deliveryState.status === "loading" && (
          <div aria-busy="true" aria-label="Loading delivery metrics">
            <SkeletonBlock />
          </div>
        )}
        {deliveryState.status === "error" && (
          <div className="banner banner-error" role="alert">
            <span>Delivery metrics unavailable — {deliveryState.message}</span>
          </div>
        )}
        {deliveryState.status === "ok" && delivery !== null && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 10,
              padding: "8px 16px 12px",
            }}
          >
            <div className="kpi card">
              <div className="kpi-label">Commit-session rate</div>
              <div className="kpi-value">
                {delivery.commit_session_rate === null
                  ? "UNAVAILABLE"
                  : `${(delivery.commit_session_rate * 100).toFixed(1)}%`}
              </div>
              <div className="kpi-subval">
                {delivery.commit_session_count}/{delivery.total_session_count} sessions with an
                observed commit
              </div>
            </div>
            <div className="kpi card">
              <div className="kpi-label">Spend per commit session</div>
              <div className="kpi-value">
                {delivery.spend_per_commit_session_u === null
                  ? "UNAVAILABLE"
                  : fmtUsd(delivery.spend_per_commit_session_u)}
              </div>
              <div className="kpi-subval">
                {delivery.commit_session_count}/{delivery.total_session_count} commit-session
                coverage
              </div>
            </div>
            <div className="kpi card">
              <div className="kpi-label">Bash/edit activity without an observed commit</div>
              <div className="kpi-value">
                {delivery.no_commit_activity_session_count}/{delivery.total_session_count}
              </div>
              <div className="kpi-subval">reconciled activity sessions</div>
            </div>
          </div>
        )}
        {deliveryState.status === "ok" && delivery === null && (
          <div className="kpi-off" style={{ padding: "8px 16px 12px" }}>
            UNAVAILABLE
          </div>
        )}
        {deliveryState.status === "ok" && (
          <p className="kpi-fn" style={{ margin: "0 16px 12px" }}>
            {deliveryState.value.meta.qualification.note}
          </p>
        )}
      </div>

      {/* EF1 — Abandoned spend split */}
      {wsListState.status === "ok" &&
        workspace !== undefined &&
        (workspace.deep_abandoned_spend_u !== undefined ||
          workspace.early_abandoned_spend_u !== undefined) && (
          <div className="card" style={{ marginBottom: 13 }} data-testid="ef1-abandoned-spend">
            <div className="section-head">
              <h2>
                Reconciled no-commit activity{" "}
                <InfoTip
                  label="Reconciled no-commit activity"
                  content="Splits reconciled Bash, Edit, Write, and NotebookEdit activity without an observed commit into long sessions with at least 10 user turns and early sessions with fewer than 10. It is activity without a recorded commit, not an abandonment finding; LIVE sessions remain in total spend but are excluded from this cohort."
                />
              </h2>
              <div className="chips">
                <Chip kind="OBS_PROXY" />
              </div>
            </div>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content 1fr",
                gap: "3px 16px",
                margin: "8px 16px 12px",
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
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
        )}

      {/* EF2 — Closure proxy */}
      <div className="card" style={{ marginBottom: 13 }} data-testid="ef2-closure-proxy">
        <div className="section-head">
          <h2>
            No later workspace session within 48h{" "}
            <InfoTip
              label="No later workspace session within 48h"
              content="This is a workspace-history, as-of-time observation for reconciled no-commit sessions. It is independent of the selected date range. No later workspace session within 48 hours does not establish task resolution; a later session can be unrelated work. Pending means 48 hours has not passed."
            />
          </h2>
          <div className="chips">
            <Chip kind="DIRECTIONAL" />
          </div>
        </div>
        {closureProxyState.status === "loading" && (
          <div aria-busy="true" aria-label="Loading closure proxy">
            <SkeletonBlock />
          </div>
        )}
        {closureProxyState.status === "error" && (
          <div className="banner banner-error" role="alert">
            <span>Closure proxy unavailable — {closureProxyState.message}</span>
          </div>
        )}
        {closureProxyState.status === "ok" && closureProxy !== null && (
          <div style={{ padding: "8px 16px 12px", fontSize: 13 }}>
            <div data-testid="closure-proxy-summary" style={{ marginBottom: 8 }}>
              {closureProxy.no_commit_session_count === 0 ? (
                <span style={{ color: "var(--text-muted)" }}>No no-commit sessions observed.</span>
              ) : (
                <span>
                  {(closureProxy.no_later_workspace_session_share ??
                    closureProxy.resolved_share) !== null
                    ? `${closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count}/${(closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count) + (closureProxy.later_workspace_session_count ?? closureProxy.unresolved_count)} reconciled no-commit sessions had no later workspace session within 48h (${closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count} of ${(closureProxy.no_later_workspace_session_count ?? closureProxy.resolved_count) + (closureProxy.later_workspace_session_count ?? closureProxy.unresolved_count)}; ${Math.round((closureProxy.no_later_workspace_session_share ?? closureProxy.resolved_share ?? 0) * 100)}%)`
                    : `${closureProxy.no_commit_session_count}/${closureProxy.no_commit_session_count} no-commit sessions — all PENDING (48h window not elapsed)`}
                </span>
              )}
            </div>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content 1fr",
                gap: "3px 16px",
                margin: 0,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
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

      {/* R4a — Lifecycle cost per delivered outcome */}
      <div className="card" style={{ marginBottom: 13 }} data-testid="r4a-cost-per-success">
        <div className="section-head">
          <h2>
            Unique linked-session cost per merged PR{" "}
            <InfoTip
              label="Unique linked-session cost per merged PR"
              content="The terminal-date merged PR cohort counts each linked session once, even if it links to multiple merged PRs. Shared sessions are reported as coverage and are never allocated across PRs. Full linked-session lifecycle cost differs from the separate session-start linkage coverage observation. A merge is a reviewer decision, not proof of quality."
            />
          </h2>
          <div className="chips">
            <Chip kind="DIRECTIONAL" />
            <Chip kind="OBS_PROXY" />
          </div>
        </div>
        {costPerSuccessState.status === "loading" && (
          <div aria-busy="true" aria-label="Loading cost per delivered outcome">
            <SkeletonBlock />
          </div>
        )}
        {costPerSuccessState.status === "error" && (
          <div className="banner banner-error" role="alert">
            <span>Cost per delivered outcome unavailable — {costPerSuccessState.message}</span>
          </div>
        )}
        {costPerSuccessState.status === "ok" && costPerSuccess !== null && (
          <div style={{ padding: "8px 16px 12px", fontSize: 13 }}>
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
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content 1fr",
                gap: "3px 16px",
                margin: 0,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
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
          <div style={{ padding: "8px 16px 12px", fontSize: 13 }} data-testid="r4a-empty">
            <span style={{ color: "var(--text-muted)" }}>
              No cost-per-success data for this workspace in the selected window.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
