/**
 * src/ui/workspaces/WorkspacesPage.tsx — Workspace spend + efficiency home (RV1a).
 *
 * Leads with a per-workspace table: spend, share bar, trend sparkline, ctx/turn,
 * cache-write %, opus %, $/turn, success (EXP chip). Row click → #/workspaces/:id.
 * Transient workspaces are hidden by default.
 */

import { type ReactNode, useEffect, useState } from "react";
import type { WorkspaceOutcomeSummary } from "../../query/api/outcomes";
import type { PagedList, WorkspaceSummary } from "../../query/api/overview";
import type { TrendData } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import { fetchTrends, fetchWorkspaceOutcomes, fetchWorkspaces } from "../api/client";
import { workspaceLabel } from "../lib/workspace-label";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonRow } from "../shell/Skeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: ApiResponse<T> };

type WorkspaceRow = WorkspaceSummary & {
  repo_owner?: string | null | undefined;
  repo_name?: string | null | undefined;
  repo_path?: string | null | undefined;
  repo_canonical?: string | null | undefined;
  is_transient?: boolean | undefined;
};

function isTransientWorkspace(workspace: WorkspaceRow): boolean {
  if (workspace.workspace_id === "__global__") return true;
  return workspace.is_transient ?? (workspace.repo_owner === null && workspace.repo_name === null);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtUsd(u: number): string {
  const usd = u / 1_000_000;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(1)}%`;
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

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

function renderSparkline(buckets: Array<{ cost_equiv_u: number }>): ReactNode {
  if (buckets.length === 0) return "—";
  const max = Math.max(...buckets.map((b) => b.cost_equiv_u), 1);
  const W = 42;
  const H = 14;
  const BAR_W = 4;
  const GAP = 2;
  const totalW = buckets.length * BAR_W + Math.max(0, buckets.length - 1) * GAP;
  const offsetX = Math.max(0, Math.floor((W - totalW) / 2));
  return (
    <svg width={W} height={H} aria-hidden="true" style={{ display: "block" }}>
      {buckets.map((b, i) => {
        const barH = Math.max(1, Math.round((b.cost_equiv_u / max) * (H - 1)));
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order time buckets, never reordered
            key={i}
            x={offsetX + i * (BAR_W + GAP)}
            y={H - barH}
            width={BAR_W}
            height={barH}
            fill="var(--accent, #4a90e2)"
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkspacesPage() {
  const [workspaceState, setWorkspaceState] = useState<LoadState<PagedList<WorkspaceSummary>>>({
    status: "loading",
  });
  const [trendState, setTrendState] = useState<LoadState<TrendData>>({ status: "loading" });
  const [outcomeState, setOutcomeState] = useState<LoadState<WorkspaceOutcomeSummary[]>>({
    status: "loading",
  });
  const [showTransient, setShowTransient] = useState(false);

  useEffect(() => {
    fetchWorkspaces({ preset: "7d" })
      .then((v) => setWorkspaceState({ status: "ok", value: v }))
      .catch((e: unknown) => setWorkspaceState({ status: "error", message: String(e) }));

    fetchTrends({ preset: "7d" }, "day")
      .then((v) => setTrendState({ status: "ok", value: v }))
      .catch((e: unknown) => setTrendState({ status: "error", message: String(e) }));

    fetchWorkspaceOutcomes()
      .then((v) => setOutcomeState({ status: "ok", value: v }))
      .catch((e: unknown) => setOutcomeState({ status: "error", message: String(e) }));
  }, []);

  const workspaceData = workspaceState.status === "ok" ? workspaceState.value.data : null;
  const trendData = trendState.status === "ok" ? trendState.value.data : null;
  const outcomeData = outcomeState.status === "ok" ? outcomeState.value.data : null;

  const allRows = (workspaceData?.items as WorkspaceRow[] | undefined) ?? [];
  const visibleRows = allRows.filter((ws) => showTransient || !isTransientWorkspace(ws));

  // Sparkline buckets per workspace from trend data
  const sparklineByWorkspace = new Map<string, Array<{ cost_equiv_u: number }>>();
  if (trendData !== null) {
    for (const b of trendData.by_workspace) {
      const existing = sparklineByWorkspace.get(b.workspace_id) ?? [];
      existing.push({ cost_equiv_u: b.cost_equiv_u });
      sparklineByWorkspace.set(b.workspace_id, existing);
    }
  }

  // Outcome map: workspace_id → summary
  const outcomeByWorkspace = new Map<string, WorkspaceOutcomeSummary>();
  if (outcomeData !== null) {
    for (const o of outcomeData) {
      outcomeByWorkspace.set(o.workspace_id, o);
    }
  }

  const isLoading = workspaceState.status === "loading";
  const isError = workspaceState.status === "error";

  const numCols = 9;

  return (
    <div>
      {/* Page header */}
      <div className="page-top">
        <div className="page-title">
          <h1>Workspaces</h1>
          <p className="page-sub">Spend efficiency by repository</p>
        </div>
        <div className="chips">
          <Chip kind="LIST_EQUIV" />
        </div>
      </div>

      {isError && (
        <div className="banner banner-error" role="alert">
          <span>
            Workspace data unavailable —{" "}
            {(workspaceState as { status: "error"; message: string }).message}
          </span>
        </div>
      )}

      <div className="card" style={{ marginBottom: 13 }}>
        {/* Transient toggle */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showTransient}
              onChange={(event) => setShowTransient(event.target.checked)}
            />
            Show transient workspaces
          </label>
        </div>

        {isLoading ? (
          <div className="table-wrap" aria-busy="true" aria-label="Loading workspaces">
            <table>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Spend</th>
                  <th>Share</th>
                  <th>Trend</th>
                  <th>Ctx/turn</th>
                  <th>Cache-write %</th>
                  <th>Opus %</th>
                  <th>$/turn</th>
                  <th>Success</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonRow cols={numCols} />
                <SkeletonRow cols={numCols} />
                <SkeletonRow cols={numCols} />
              </tbody>
            </table>
          </div>
        ) : !isError && visibleRows.length === 0 ? (
          <EmptyState
            headline="No workspaces yet"
            why="No spend data has been recorded for any workspace in the last 7 days."
            whatWillAppear="Workspace spend, efficiency metrics, and session history will appear after Claude Code activity is detected."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th aria-label="Spend">
                    Spend{" "}
                    <InfoTip
                      label="What Spend means"
                      content="Modeled USD-equivalent at list prices for this workspace, not billed spend. Rank workspaces by where the tokens actually go."
                    />
                  </th>
                  <th aria-label="Share">
                    Share{" "}
                    <InfoTip
                      label="What Share means"
                      content="This workspace's percentage of your total modeled spend. A few workspaces usually dominate — start optimizing there."
                    />
                  </th>
                  <th aria-label="Trend">
                    Trend{" "}
                    <InfoTip
                      label="What Trend means"
                      content="Direction of this workspace's spend versus the prior period. A sharp rise is worth opening before it compounds."
                    />
                  </th>
                  <th aria-label="Ctx/turn">
                    Ctx/turn{" "}
                    <InfoTip
                      label="What Ctx/turn means"
                      content="Average context tokens re-read each turn — the biggest cost lever, since context is re-sent every turn. High values point to sessions that should /clear or split."
                    />
                  </th>
                  <th aria-label="Cache-write %">
                    Cache-write %{" "}
                    <InfoTip
                      label="What Cache-write % means"
                      content="Share of tokens written to the prompt cache rather than served from it. Persistently high means the cache keeps getting invalidated — often an editing pattern worth changing."
                    />
                  </th>
                  <th aria-label="Opus %">
                    Opus %{" "}
                    <InfoTip
                      label="What Opus % means"
                      content="Share of turns run on Opus, the most expensive model. If routine work is on Opus, moving it to Sonnet is the fastest saving."
                    />
                  </th>
                  <th aria-label="$/turn">
                    $/turn{" "}
                    <InfoTip
                      label="What $/turn means"
                      content="Modeled cost per turn for this workspace — a size-independent efficiency number. Compare workspaces here rather than on total spend."
                    />
                  </th>
                  <th
                    aria-label="Success"
                    title="Success rate (EXPERIMENTAL): methodology validated at ~73% on a sample corpus."
                  >
                    Success{" "}
                    <InfoTip
                      label="What Success means"
                      content="Share of sessions that reached a clean outcome versus stalling or being abandoned. Low success alongside high spend flags a workflow that's fighting the tools."
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((ws) => {
                  const label = workspaceLabel({
                    workspace_id: ws.workspace_id,
                    repo_owner: ws.repo_owner ?? null,
                    repo_name: ws.repo_name ?? null,
                    repo_path: ws.repo_path ?? null,
                    repo_canonical: ws.repo_canonical ?? null,
                  });
                  const sparkBuckets = sparklineByWorkspace.get(ws.workspace_id) ?? [];
                  const outcome = outcomeByWorkspace.get(ws.workspace_id);
                  return (
                    <tr
                      key={ws.workspace_id}
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        window.location.hash = `#/workspaces/${encodeURIComponent(ws.workspace_id)}`;
                      }}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          window.location.hash = `#/workspaces/${encodeURIComponent(ws.workspace_id)}`;
                        }
                      }}
                      aria-label={`Open ${label} workspace detail`}
                    >
                      <td>
                        {label}
                        {ws.has_live && (
                          <span
                            className="nav-dot"
                            style={{ marginLeft: 6, display: "inline-block" }}
                            aria-label="has live session"
                          />
                        )}
                      </td>
                      <td>{fmtUsd(ws.cost_equiv_u)}</td>
                      <td>
                        <span style={{ whiteSpace: "nowrap" }}>
                          {fmtPct(ws.cost_share)}
                          <span
                            aria-hidden="true"
                            className="share-bar"
                            style={{
                              display: "inline-block",
                              marginLeft: 4,
                              height: 8,
                              width: Math.max(2, Math.round(ws.cost_share * 60)),
                              background: "var(--accent, #4a90e2)",
                              verticalAlign: "middle",
                              borderRadius: 2,
                            }}
                          />
                        </span>
                      </td>
                      <td aria-label={`Trend: ${sparkBuckets.length} buckets`}>
                        {renderSparkline(sparkBuckets)}
                      </td>
                      <td>{fmtCtxPerTurn(ws.avg_context_per_turn)}</td>
                      <td>{fmtPct(ws.cache_write_pct)}</td>
                      <td>{fmtPct(ws.opus_pct)}</td>
                      <td>{fmtUsdPerTurn(ws.usd_per_turn)}</td>
                      <td>
                        <Chip
                          kind="EXPERIMENTAL"
                          label={
                            outcome?.success_rate !== null && outcome?.success_rate !== undefined
                              ? `${(outcome.success_rate * 100).toFixed(0)}%`
                              : "—"
                          }
                          title="Success rate (EXPERIMENTAL): methodology validated at ~73% on a sample corpus."
                        />{" "}
                        <InfoTip
                          label="What the EXP chip means"
                          content="This value comes from a method still under validation, so treat it as directional. Use it to spot patterns, not to make precise claims."
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-footnotes">
          Spend = LIST_EQUIV (list-price equivalent; not billing data). Success = EXPERIMENTAL
          (methodology ~73% validated). Click a row to open the workspace detail.
        </div>
      </div>
    </div>
  );
}
