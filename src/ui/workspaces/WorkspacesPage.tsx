/**
 * src/ui/workspaces/WorkspacesPage.tsx — Workspace spend + efficiency home (RV1a).
 *
 * Leads with a per-workspace table: spend, share bar, trend sparkline, ctx/turn,
 * cache-write %, premium %, $/turn, success (EXP chip). Row click → #/workspaces/:id.
 * Transient workspaces are hidden by default.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceOutcomeSummary } from "../../query/api/outcomes";
import type {
  PagedList,
  WindowFilter,
  WorkspaceNameRow,
  WorkspaceSummary,
} from "../../query/api/overview";
import type { TrendData } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import {
  fetchTrends,
  fetchWorkspaceNames,
  fetchWorkspaceOutcomes,
  fetchWorkspaces,
} from "../api/client";
import { seedWorkspaceHeader } from "../api/drilldown-seed";
import { coverageLabel, historyNoteText, useHistoryStatus } from "../lib/history-status";
import { workspaceLabel } from "../lib/workspace-label";
import AsyncErrorState from "../shell/AsyncErrorState";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonRow } from "../shell/Skeleton";
import StateChip from "../shell/StateChip";
import { scopedHash } from "./workspace-scope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: ApiResponse<T>; recentOnly?: boolean; refreshError?: boolean };

type WorkspaceRow = WorkspaceSummary & {
  repo_owner?: string | null | undefined;
  repo_name?: string | null | undefined;
  repo_path?: string | null | undefined;
  repo_canonical?: string | null | undefined;
  is_transient?: boolean | undefined;
};

type WorkspaceWindow = "7d" | "30d" | "all";

function windowFromHash(): WorkspaceWindow {
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("window");
  return value === "7d" || value === "30d" ? value : "all";
}

function windowFilter(value: WorkspaceWindow): WindowFilter {
  return value === "all" ? { from: "1970-01-01T00:00:00.000Z" } : { preset: value };
}

function setHashWindow(value: WorkspaceWindow): void {
  const hash = window.location.hash;
  const [path, query] = hash.split("?", 2);
  const params = new URLSearchParams(query ?? "");
  params.set("window", value);
  window.location.hash = `${path || "#/workspaces"}?${params}`;
}

function isTransientWorkspace(
  workspace: WorkspaceNameRow & { is_transient?: boolean | undefined },
): boolean {
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
            fill="var(--series-1)"
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
  const [selectedWindow, setSelectedWindow] = useState<WorkspaceWindow>(windowFromHash);
  const [workspaceNames, setWorkspaceNames] = useState<WorkspaceNameRow[]>([]);
  const history = useHistoryStatus();
  const historyNote = historyNoteText(coverageLabel(history.coverage), history);
  const lastRevision = useRef(history.revision);
  const currentRevision = useRef(history.revision);
  currentRevision.current = history.revision;
  const workspaceRequest = useRef(0);
  const trendRequest = useRef(0);
  const fullTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(fullTimer.current), []);

  const loadWorkspaces = useCallback(() => {
    const request = ++workspaceRequest.current;
    clearTimeout(fullTimer.current);
    // This load sees data as of now; only a later revision needs another fetch.
    lastRevision.current = currentRevision.current;
    setWorkspaceState({ status: "loading" });
    const full = () =>
      void fetchWorkspaces(windowFilter(selectedWindow), { fresh: true })
        .then((value) => {
          if (request !== workspaceRequest.current) return;
          setWorkspaceState({ status: "ok", value });
        })
        .catch((e: unknown) => {
          if (request === workspaceRequest.current) {
            setWorkspaceState((previous) =>
              previous.status === "ok"
                ? { ...previous, recentOnly: false, refreshError: true }
                : { status: "error", message: String(e) },
            );
          }
        });
    if (selectedWindow === "7d") {
      full();
    } else {
      void fetchWorkspaces({ preset: "7d" }, { fresh: true, limit: 8 })
        .then((value) => {
          if (request === workspaceRequest.current)
            setWorkspaceState({ status: "ok", value, recentOnly: true });
        })
        .catch(() => {})
        .finally(() => {
          // Let the recent table paint before the broader aggregate occupies the daemon.
          if (request === workspaceRequest.current) fullTimer.current = setTimeout(full, 120);
        });
    }
  }, [selectedWindow]);

  const loadTrends = useCallback(() => {
    const request = ++trendRequest.current;
    setTrendState({ status: "loading" });
    void fetchTrends(windowFilter(selectedWindow), "day")
      .then((v) => {
        if (request === trendRequest.current) setTrendState({ status: "ok", value: v });
      })
      .catch((e: unknown) => {
        if (request === trendRequest.current)
          setTrendState({ status: "error", message: String(e) });
      });
  }, [selectedWindow]);

  const loadOutcomes = useCallback(() => {
    setOutcomeState({ status: "loading" });
    void fetchWorkspaceOutcomes()
      .then((v) => setOutcomeState({ status: "ok", value: v }))
      .catch((e: unknown) => setOutcomeState({ status: "error", message: String(e) }));
  }, []);

  const recentOnly = workspaceState.status === "ok" && workspaceState.recentOnly === true;
  useEffect(() => {
    loadWorkspaces();
    loadTrends();
    loadOutcomes();
  }, [loadOutcomes, loadTrends, loadWorkspaces]);

  useEffect(() => {
    let active = true;
    // Unwindowed names are metadata; request them once after the first spend request.
    void fetchWorkspaceNames()
      .then((names) => {
        if (active) setWorkspaceNames(names);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (history.revision === lastRevision.current) return;
    // The first status is a baseline, not new data (the poller's own scope diff does the same).
    if (lastRevision.current === "pending") {
      lastRevision.current = history.revision;
      return;
    }
    // An in-flight load keeps the revision pending; the effect re-runs when it settles.
    if (workspaceState.status === "loading" || recentOnly) return;
    lastRevision.current = history.revision;
    // Refresh each visible aggregate when new background rows become available.
    const request = ++workspaceRequest.current;
    void fetchWorkspaces(windowFilter(selectedWindow), { fresh: true })
      .then((value) => {
        if (request === workspaceRequest.current) setWorkspaceState({ status: "ok", value });
      })
      .catch(() => {});
    loadTrends();
    loadOutcomes();
  }, [
    history.revision,
    workspaceState.status,
    recentOnly,
    loadTrends,
    loadOutcomes,
    selectedWindow,
  ]);

  useEffect(() => {
    if (
      window.location.hash.split("?")[0] === "#/workspaces" &&
      !new URLSearchParams(window.location.hash.split("?")[1] ?? "").has("window")
    ) {
      setHashWindow(selectedWindow);
    }
    const onHashChange = () => {
      if (window.location.hash.split("?")[0] === "#/workspaces") {
        setSelectedWindow(windowFromHash());
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [selectedWindow]);

  const workspaceData = workspaceState.status === "ok" ? workspaceState.value.data : null;
  const trendData = trendState.status === "ok" ? trendState.value.data : null;
  const outcomeData = outcomeState.status === "ok" ? outcomeState.value.data : null;

  const allRows = (workspaceData?.items as WorkspaceRow[] | undefined) ?? [];
  const visibleRows = allRows.filter((ws) => showTransient || !isTransientWorkspace(ws));
  const activeIds = new Set(allRows.map((ws) => ws.workspace_id));
  const idleRows = recentOnly
    ? []
    : workspaceNames.filter(
        (ws) => !activeIds.has(ws.workspace_id) && (showTransient || !isTransientWorkspace(ws)),
      );

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
          <p className="page-sub">Compare estimated token value across repositories</p>
        </div>
        <div className="page-top-controls">
          {/* biome-ignore lint/a11y/useSemanticElements: segmented button group (C1); <fieldset> semantics differ */}
          <div className="date-range" role="group" aria-label="Workspace activity window">
            {(["7d", "30d", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`date-preset-btn${selectedWindow === value ? " active" : ""}`}
                aria-pressed={selectedWindow === value}
                onClick={() => {
                  setSelectedWindow(value);
                  setHashWindow(value);
                }}
              >
                {value === "all" ? "All history" : value}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isError && <AsyncErrorState resource="workspaces" onRetry={loadWorkspaces} />}
      {trendState.status === "error" && (
        <AsyncErrorState resource="workspaces" onRetry={loadTrends} />
      )}
      {outcomeState.status === "error" && (
        <AsyncErrorState resource="outcomes" onRetry={loadOutcomes} />
      )}
      {workspaceState.status === "ok" && workspaceState.refreshError && (
        <div role="alert">
          Could not load the selected range.{" "}
          <button type="button" className="btn-secondary" onClick={loadWorkspaces}>
            Retry
          </button>
        </div>
      )}

      {workspaceState.status === "ok" && workspaceState.recentOnly && (
        <output>
          Showing up to eight workspaces from the recent seven days while loading{" "}
          {selectedWindow === "all" ? "all history" : selectedWindow}.
          {workspaceState.value.data?.items.length === 0 && " No recent workspace activity."}
        </output>
      )}
      {historyNote !== null && (
        <output>
          <span className="chip history-notice">{historyNote}</span>
        </output>
      )}

      <section className="sec" aria-labelledby="workspaces-table-title">
        <div className="sec-h">
          <h2 id="workspaces-table-title">All workspaces</h2>
          <span className="desc sec-h-controls">
            <label className="sec-h-toggle">
              <input
                type="checkbox"
                checked={showTransient}
                onChange={(event) => setShowTransient(event.target.checked)}
              />
              Show transient workspaces
            </label>
            <Chip kind="LIST_EQUIV" />
          </span>
        </div>
        <div className="card card-padded">
          {isLoading ? (
            <div className="table-wrap" aria-busy="true" aria-label="Loading workspaces">
              <table>
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>Est. value</th>
                    <th>Share of total</th>
                    <th>Trend</th>
                    <th>Context / turn</th>
                    <th>Cache-write share</th>
                    <th>High-cost model use</th>
                    <th>Est. value / turn</th>
                    <th>Outcome signal</th>
                  </tr>
                </thead>
                <tbody>
                  <SkeletonRow cols={numCols} />
                  <SkeletonRow cols={numCols} />
                  <SkeletonRow cols={numCols} />
                </tbody>
              </table>
            </div>
          ) : !isError &&
            visibleRows.length === 0 &&
            idleRows.length === 0 &&
            !(workspaceState.status === "ok" && workspaceState.recentOnly) ? (
            <EmptyState
              headline="No workspaces yet"
              why="No workspace activity has been recorded in this window."
              whatWillAppear="Workspace spend, efficiency metrics, and session history will appear after Claude Code activity is detected."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      Workspace{" "}
                      <InfoTip
                        label="What the amber dot means"
                        content="The amber dot indicates this workspace has at least one live (currently running) Claude Code session. It turns amber when the daemon detects an open session file that has not yet closed."
                      />
                    </th>
                    <th aria-label="Estimated value">
                      Est. value{" "}
                      <InfoTip
                        label="What estimated value means"
                        content="An estimate using public API list prices, not a bill. Use it to find the repositories where a change could matter most."
                      />
                    </th>
                    <th aria-label="Share">
                      Share of total{" "}
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
                    <th aria-label="Context per turn">
                      Context / turn{" "}
                      <InfoTip
                        label="What context per turn means"
                        content="The average context tokens sent again on each turn. A high value can mean it is time to use /clear or split the work."
                      />
                    </th>
                    <th aria-label="Cache-write share">
                      Cache-write share{" "}
                      <InfoTip
                        label="What Cache-write % means"
                        content="Share of all token categories that were cache writes. A high share can be worth investigating; it does not by itself prove the cache was invalidated."
                      />
                    </th>
                    <th aria-label="High-cost model use">
                      High-cost model use{" "}
                      <InfoTip
                        label="What Premium % means"
                        content="Share of turns on premium models (Opus, Fable, or Mythos). Check /usage before moving routine work to Sonnet; your Sonnet limit may already be filling."
                      />
                    </th>
                    <th aria-label="Estimated value per turn">
                      Est. value / turn{" "}
                      <InfoTip
                        label="What $/turn means"
                        content="Modeled cost per turn for this workspace — a size-independent efficiency number. Compare workspaces here rather than on total spend."
                      />
                    </th>
                    <th
                      aria-label="Outcome signal"
                      title="Outcome signal: based on a limited sample and may change."
                    >
                      Outcome signal{" "}
                      <InfoTip
                        label="What outcome signal means"
                        content="Numerator: linked pull requests with a successful observed outcome, including success with deferred work. Denominator: linked pull requests with a closed observed outcome. This early estimate helps spot patterns only."
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
                    const sparkBuckets = recentOnly
                      ? []
                      : (sparklineByWorkspace.get(ws.workspace_id) ?? []);
                    const outcome = outcomeByWorkspace.get(ws.workspace_id);
                    return (
                      <tr key={ws.workspace_id} className="workspace-row">
                        <td>
                          <a
                            href={scopedHash(
                              `#/workspaces/${encodeURIComponent(ws.workspace_id)}`,
                              selectedWindow,
                              window.location.hash,
                            )}
                            className="workspace-row-link"
                            // P1-U6a: the detail header paints from this row while it loads.
                            onClick={() =>
                              seedWorkspaceHeader(selectedWindow, {
                                workspace_id: ws.workspace_id,
                                repo_owner: ws.repo_owner ?? null,
                                repo_name: ws.repo_name ?? null,
                                repo_path: ws.repo_path ?? null,
                                cost_equiv_u: ws.cost_equiv_u,
                                turns: ws.turns,
                                usd_per_turn: ws.usd_per_turn,
                                avg_context_per_turn: ws.avg_context_per_turn,
                                has_live: ws.has_live,
                              })
                            }
                          >
                            {label}
                          </a>
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
                                background: "var(--series-1)",
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
                        <td>{fmtPct(ws.premium_pct ?? ws.opus_pct)}</td>
                        <td>{fmtUsdPerTurn(ws.usd_per_turn)}</td>
                        <td>
                          <Chip
                            kind="EXPERIMENTAL"
                            label={
                              outcome?.success_rate !== null && outcome?.success_rate !== undefined
                                ? `${(outcome.success_rate * 100).toFixed(0)}%`
                                : "—"
                            }
                            title="Outcome signal: based on a limited sample and may change."
                          />{" "}
                          {outcome !== undefined && (
                            <span title="Successful closed outcomes / all closed outcomes">
                              {outcome.success_n}/{outcome.terminal_n}
                            </span>
                          )}{" "}
                          <InfoTip
                            label="What this early estimate means"
                            content="This value uses a method that is still being checked. Use it to spot patterns, not to make precise claims."
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {idleRows.map((ws) => (
                    <tr
                      key={ws.workspace_id}
                      className="workspace-row"
                      style={{ color: "var(--muted)" }}
                    >
                      <td>
                        <a
                          href={scopedHash(
                            `#/workspaces/${encodeURIComponent(ws.workspace_id)}`,
                            selectedWindow,
                            window.location.hash,
                          )}
                          className="workspace-row-link"
                          style={{ color: "var(--muted)" }}
                        >
                          {workspaceLabel(ws)}
                        </a>
                        <div>No activity in window</div>
                      </td>
                      {[
                        "value",
                        "share",
                        "trend",
                        "context",
                        "cache",
                        "model",
                        "per-turn",
                        "outcome",
                      ].map((column) => (
                        <td key={column}>—</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="table-footnotes">
            Estimated value uses public API list prices; it is not billing data. Outcome signal is
            an early estimate based on a limited sample. Interrupts for every workspace:{" "}
            <StateChip kind="UNAVAILABLE" reason="not collected" />. Open a workspace by its name.
          </div>
        </div>
      </section>
    </div>
  );
}
