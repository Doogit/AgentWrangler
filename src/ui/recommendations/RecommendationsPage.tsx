/**
 * src/ui/recommendations/RecommendationsPage.tsx — Recommendations surface.
 *
 * Renders the live DetectorEngine output:
 *   - Active Proposals (one RecCard per active rec).
 *   - Detector status strip (honest ACTIVE/INACTIVE/BLOCKED/NOT_EVALUATED).
 *   - Adopted — Measured Effect (empty; EffectMeasurer out of scope).
 *   - Dismissed (empty; cool-down note).
 * Read-only. Page-level EXPERIMENTAL label. Standing FR-REC-103 footnote:
 * modeled savings are NEVER summed into achieved.
 *
 * Three distinct UI states (loading ≠ error ≠ ok/empty), mirroring OverviewPage.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  RecommendationCard,
  RecommendationGroup,
  RecommendationsView,
} from "../../query/api/recommendations";
import type { ApiResponse } from "../../query/envelope";
import { fetchRecommendations } from "../api/client";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock } from "../shell/Skeleton";
import DetectorStatusStrip from "./DetectorStatusStrip";
import ImpactLedger from "./ImpactLedger";
import PracticesSection from "./PracticesSection";
import RecCard, { DETECTOR_GROUP_LABELS, confidenceTierLabel } from "./RecCard";
import RecsToolbar, {
  type SortOrder,
  type ToolbarParams,
  collectWorkspaces,
  parseToolbarParams,
  setToolbarParam,
} from "./RecsToolbar";
import { sessionIdsForRecommendation } from "./rec-sessions";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: ApiResponse<RecommendationsView> };

// ---------------------------------------------------------------------------
// Hash-param subscription (URL-synced toolbar state)
// ---------------------------------------------------------------------------
function subscribeToHash(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}
function getHash(): string {
  return window.location.hash;
}
function getHashServer(): string {
  return "";
}

const STANDING_FOOTNOTE =
  "Modeled savings are never counted as achieved; only verified measured effects contribute to the achieved total.";
const WASTE_SOURCE_FOOTNOTE =
  "Ranks compare expected leverage, not achieved savings. Modeled dollars are projections and are not directly comparable across detector methods.";

const DE_MINIMIS_FLOOR_U = 1_000_000;
const MINOR_ITEMS_GROUP_ID = "MINOR_ITEMS";

function deriveUiGroups(active: RecommendationCard[]): RecommendationGroup[] {
  const grouped = new Map<string, RecommendationCard[]>();
  const minorItems: RecommendationCard[] = [];
  for (const rec of active) {
    if (
      rec.modeled_savings_u_per_wk !== null &&
      rec.modeled_savings_u_per_wk < DE_MINIMIS_FLOOR_U
    ) {
      minorItems.push(rec);
      continue;
    }
    const members = grouped.get(rec.detector_id);
    if (members === undefined) grouped.set(rec.detector_id, [rec]);
    else members.push(rec);
  }

  const buildGroup = (detector_id: string, recs: RecommendationCard[]): RecommendationGroup => {
    const sessions = new Set<string>();
    for (const rec of recs) {
      for (const sessionId of sessionIdsForRecommendation(rec)) sessions.add(sessionId);
    }
    return {
      detector_id,
      label: DETECTOR_GROUP_LABELS[detector_id] ?? detector_id,
      recs,
      session_count: sessions.size,
      total_savings_u_per_wk: recs.reduce(
        (total, rec) => total + (rec.modeled_savings_u_per_wk ?? 0),
        0,
      ),
    };
  };

  const groups = [...grouped].map(([detectorId, recs]) => buildGroup(detectorId, recs));
  if (minorItems.length > 0) groups.push(buildGroup(MINOR_ITEMS_GROUP_ID, minorItems));
  return groups;
}

function groupsCoverActive(groups: RecommendationGroup[], active: RecommendationCard[]): boolean {
  const activeIds = new Set(active.map((rec) => rec.rec_id));
  const activeById = new Map(active.map((rec) => [rec.rec_id, rec]));
  const groupIds = groups.flatMap((group) => group.recs.map((rec) => rec.rec_id));
  return (
    groupIds.length === active.length &&
    new Set(groupIds).size === activeIds.size &&
    groupIds.every((recId) => activeIds.has(recId)) &&
    groups.every((group) =>
      group.recs.every((rec) => {
        const activeRec = activeById.get(rec.rec_id);
        return (
          activeRec !== undefined &&
          (activeRec === rec || JSON.stringify(activeRec) === JSON.stringify(rec))
        );
      }),
    )
  );
}

function activeGroupsForView(view: RecommendationsView): RecommendationGroup[] {
  return Array.isArray(view.active_groups) && groupsCoverActive(view.active_groups, view.active)
    ? view.active_groups
    : deriveUiGroups(view.active);
}

// ---------------------------------------------------------------------------
// Toolbar-aware filtering + sorting + grouping
// ---------------------------------------------------------------------------

/** Apply tier, scope, and workspace filters to an array of cards.
 *
 * Filter priority:
 *   1. tier — confidence tier chip (always applied independently)
 *   2. scope — scope strip param: 'global' → null-workspace only; other string → that workspace only
 *   3. ws   — legacy workspace dropdown (only applied when scope is null, for URL backward-compat)
 */
function applyFilters(recs: RecommendationCard[], params: ToolbarParams): RecommendationCard[] {
  return recs.filter((rec) => {
    if (params.tier !== null && confidenceTierLabel(rec) !== params.tier) return false;
    if (params.scope !== null) {
      if (params.scope === "global") {
        if (rec.scope_workspace_id !== null) return false;
      } else {
        if (rec.scope_workspace_id !== params.scope) return false;
      }
    } else if (params.ws !== null && rec.scope_workspace_id !== params.ws) {
      return false;
    }
    return true;
  });
}

/** Sort active recs by the toolbar sort order. "confidence" = keep existing article-priority order. */
function applySort(recs: RecommendationCard[], sort: SortOrder): RecommendationCard[] {
  if (sort === "confidence") return recs; // preserve API article-priority order
  if (sort === "savings") {
    return [...recs].sort(
      (a, b) => (b.modeled_savings_u_per_wk ?? -1) - (a.modeled_savings_u_per_wk ?? -1),
    );
  }
  // newest: sort by created_at DESC
  return [...recs].sort((a, b) => {
    if (a.created_at < b.created_at) return 1;
    if (a.created_at > b.created_at) return -1;
    return 0;
  });
}

/** Build groups by workspace (scope_workspace_id) instead of detector family. */
function groupByWorkspace(recs: RecommendationCard[]): RecommendationGroup[] {
  const grouped = new Map<string | null, RecommendationCard[]>();
  for (const rec of recs) {
    const key = rec.scope_workspace_id;
    const members = grouped.get(key);
    if (members === undefined) grouped.set(key, [rec]);
    else members.push(rec);
  }
  return [...grouped].map(([wsId, members]) => {
    const sessions = new Set<string>();
    for (const rec of members) {
      for (const sid of sessionIdsForRecommendation(rec)) sessions.add(sid);
    }
    // Use the workspace_id as the detector_id slot to satisfy RecommendationGroup shape.
    const detector_id = wsId ?? "__global__";
    const label = wsId === null ? "Global (cross-workspace)" : wsId;
    return {
      detector_id,
      label,
      recs: members,
      session_count: sessions.size,
      total_savings_u_per_wk: members.reduce(
        (total, rec) => total + (rec.modeled_savings_u_per_wk ?? 0),
        0,
      ),
    };
  });
}

/**
 * Derive the groups to display given the current toolbar state.
 * Applies filters, sort, and group-by before falling back to the existing
 * activeGroupsForView() logic for the default "detector family" grouping.
 */
function toolbarGroups(view: RecommendationsView, params: ToolbarParams): RecommendationGroup[] {
  const filtered = applyFilters(view.active, params);
  const sorted = applySort(filtered, params.sort);

  if (params.group === "workspace") {
    return groupByWorkspace(sorted);
  }

  // Default: detector-family groups (respect existing API groups when valid).
  const groups = activeGroupsForView(view);
  // Re-filter groups using the same priority as applyFilters.
  return groups
    .map((group) => ({ ...group, recs: applyFilters(group.recs, params) }))
    .filter((group) => group.recs.length > 0);
}

/** Lazily-fetched daemon session token. Null until fetched; empty string on fetch failure. */
let cachedSessionToken: string | null = null;

async function fetchSessionToken(): Promise<string> {
  if (cachedSessionToken !== null) return cachedSessionToken;
  try {
    const res = await fetch("/api/token");
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      cachedSessionToken = typeof data.token === "string" ? data.token : "";
    } else {
      cachedSessionToken = "";
    }
  } catch {
    cachedSessionToken = "";
  }
  return cachedSessionToken;
}

export default function RecommendationsPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);

  // Subscribe to hash changes to pick up URL-synced toolbar params.
  const hash = useSyncExternalStore(subscribeToHash, getHash, getHashServer);
  const toolbarParams: ToolbarParams = parseToolbarParams(hash);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional re-fetch trigger
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchRecommendations()
      .then((v) => {
        if (!cancelled) setState({ status: "ok", value: v });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  function refresh() {
    setRefreshKey((k) => k + 1);
  }

  // RecCard invokes this only after its local undo window elapses.
  // Pass an optional snoozeDays to set a custom dismissed_until (default: 30d cool-down).
  function handleDismiss(recId: string, snoozeDays?: number): void {
    void fetchSessionToken()
      .then((token) => {
        const body: Record<string, unknown> = { rec_id: recId };
        if (snoozeDays !== undefined) {
          body.dismissed_until = new Date(
            Date.now() + snoozeDays * 24 * 60 * 60 * 1000,
          ).toISOString();
        }
        return fetch("/api/recommendations/dismiss", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify(body),
        });
      })
      .then((res) => {
        if (res.ok) refresh();
      });
  }

  // RecCard invokes this only after its local undo window elapses.
  function handleAdopt(recId: string): void {
    void fetchSessionToken()
      .then((token) => {
        return fetch("/api/recommendations/adopt", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({ rec_id: recId }),
        });
      })
      .then((res) => {
        if (res.ok) refresh();
      });
  }

  const view = state.status === "ok" ? state.value.data : null;

  // RV6 deep-link focus: the top rec is always an active/limit-warning proposal.
  // Known → the target card scrolls/highlights/auto-expands; stale → quiet notice.
  const focus = toolbarParams.focus;
  const focusKnown =
    focus !== null &&
    view !== null &&
    [...view.active, ...view.limit_warnings].some((rec) => rec.rec_id === focus);
  const focusRecId = focusKnown ? focus : null;
  const clearFocus = () => setToolbarParam("focus", null);

  return (
    <div>
      <div className="page-top">
        <div className="page-title">
          <h1>Recommendations</h1>
          <p className="page-sub">
            Waste-source detectors · ranked by type of impact, then estimated savings · estimates
            are not yet validated
          </p>
        </div>
        <div className="chips">
          <Chip kind="EXPERIMENTAL" />
        </div>
      </div>

      {state.status === "error" && (
        <div className="banner banner-error" role="alert" aria-live="assertive">
          <span>⚠ Daemon unreachable — {state.message}</span>
        </div>
      )}

      {state.status === "loading" && (
        <div aria-busy="true" aria-label="Loading recommendations">
          <SkeletonBlock />
          <SkeletonBlock />
        </div>
      )}

      {state.status === "ok" && view !== null && (
        <>
          {/* URL-synced toolbar: filter · sort · group */}
          <RecsToolbar view={view} params={toolbarParams} />

          {/* RV6: a stale/unknown deep-link degrades to the full list with a quiet notice. */}
          {focus !== null && !focusKnown && (
            <output className="recs-focus-notice">
              <span>That recommendation is no longer available — showing the full list.</span>
              <button type="button" className="recs-focus-notice-dismiss" onClick={clearFocus}>
                Dismiss
              </button>
            </output>
          )}

          {/* D5 limit warning alert strip — above waste-source cards (taxonomy §7 IA §4 §2.1) */}
          {view.limit_warnings.length > 0 &&
            (toolbarParams.state === null || toolbarParams.state === "proposed") && (
              <div className="limit-warning-strip">
                {view.limit_warnings.map((rec) => (
                  <div key={rec.rec_id} className="banner banner-warn" role="alert">
                    <span>
                      <strong>Limit warning</strong> {rec.lever}
                    </span>
                  </div>
                ))}
              </div>
            )}

          {/* Proposed / active waste sources */}
          {(toolbarParams.state === null || toolbarParams.state === "proposed") &&
            (() => {
              const visibleGroups = toolbarGroups(view, toolbarParams);

              // Scope strip data — counts over ALL active recs (ignoring current scope filter)
              const workspaces = collectWorkspaces(view);
              const globalCount = view.active.filter((r) => r.scope_workspace_id === null).length;
              const wsCounts = new Map<string, number>();
              for (const r of view.active) {
                if (r.scope_workspace_id !== null) {
                  wsCounts.set(r.scope_workspace_id, (wsCounts.get(r.scope_workspace_id) ?? 0) + 1);
                }
              }
              // Active scope chip: scope param takes priority; ws param is legacy
              const activeScopeChip: string | null =
                toolbarParams.scope !== null
                  ? toolbarParams.scope
                  : toolbarParams.ws !== null
                    ? toolbarParams.ws
                    : null;

              function setScopeChip(value: string | null) {
                if (value === null) {
                  setToolbarParam("scope", null);
                  setToolbarParam("ws", null);
                } else if (value === "global") {
                  setToolbarParam("scope", "global");
                  setToolbarParam("ws", null);
                } else {
                  setToolbarParam("scope", value);
                  setToolbarParam("ws", null);
                }
              }

              const hasMultipleScopes = workspaces.length > 1;

              // FB3: summary header — top family (from all active, unfiltered) + trio (filtered)
              const allGroups = activeGroupsForView(view);
              const topFamily =
                allGroups.length > 0
                  ? allGroups.reduce((best, g) => (g.recs.length > best.recs.length ? g : best))
                  : null;
              const filteredForTrio = applyFilters(view.active, toolbarParams);
              const trioWsCount = filteredForTrio.filter(
                (r) => r.scope_workspace_id !== null,
              ).length;
              const trioGlobalCount = filteredForTrio.filter(
                (r) => r.scope_workspace_id === null,
              ).length;

              return (
                <>
                  {/* FB3: summary header card — hosts scope strip, count, lever, trio */}
                  {view.active.length > 0 && (
                    <div
                      className="recs-summary-header"
                      aria-label="Active recommendations summary"
                    >
                      {/* Scope strip hosted here (FB2 → FB3) */}
                      {hasMultipleScopes && (
                        <div className="scope-strip" aria-label="Filter by scope">
                          <InfoTip
                            label="What the scope badge means"
                            content="Whether this applies everywhere (your ~/.claude config) or just one workspace's repo. It decides where the generated prompt or config change should go."
                          />
                          <button
                            type="button"
                            className={`scope-chip${activeScopeChip === null ? " scope-chip--active" : ""}`}
                            aria-pressed={activeScopeChip === null}
                            onClick={() => setScopeChip(null)}
                          >
                            All <span className="scope-chip-count">({view.active.length})</span>
                          </button>
                          {globalCount > 0 && (
                            <button
                              type="button"
                              className={`scope-chip scope-chip--global${activeScopeChip === "global" ? " scope-chip--active" : ""}`}
                              aria-pressed={activeScopeChip === "global"}
                              onClick={() => setScopeChip("global")}
                            >
                              Global <span className="scope-chip-count">({globalCount})</span>
                            </button>
                          )}
                          {workspaces
                            .filter((ws) => ws.id !== null)
                            .map((ws) => {
                              const wsId = ws.id as string;
                              const count = wsCounts.get(wsId) ?? 0;
                              if (count === 0) return null;
                              return (
                                <button
                                  key={wsId}
                                  type="button"
                                  className={`scope-chip scope-chip--workspace${activeScopeChip === wsId ? " scope-chip--active" : ""}`}
                                  aria-pressed={activeScopeChip === wsId}
                                  onClick={() => setScopeChip(wsId)}
                                >
                                  {ws.label} <span className="scope-chip-count">({count})</span>
                                </button>
                              );
                            })}
                        </div>
                      )}
                      <div className="recs-summary-main">
                        <div className="recs-summary-count">
                          <span className="recs-summary-count-number">{view.active.length}</span>
                          <span className="recs-summary-count-label"> active recommendations</span>
                        </div>
                        {topFamily !== null && (
                          <p className="recs-summary-lever">
                            Biggest lever this week: <strong>{topFamily.label}</strong> —{" "}
                            {topFamily.recs.length} {topFamily.recs.length === 1 ? "rec" : "recs"}{" "}
                            across {topFamily.session_count}{" "}
                            {topFamily.session_count === 1 ? "session" : "sessions"}
                          </p>
                        )}
                        <p className="kpi-fn">Modeled savings are not additive.</p>
                      </div>
                      <div className="recs-summary-trio" aria-label="Scope and adoption counts">
                        <span>
                          <strong>{trioWsCount}</strong> workspace-scoped
                        </span>
                        <span>
                          <strong>{trioGlobalCount}</strong> global
                        </span>
                        <span>
                          <strong>{view.adopted.length}</strong> adopted
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="section-head">
                    <h2>Waste sources · highest-impact types first</h2>
                  </div>
                  <p className="rec-ranking-explainer">
                    The ranking here is not a simple dollar sort. Each category of waste has a fixed
                    position because each one is measured differently — the estimates are not
                    directly comparable across categories. Within one category, the recommendation
                    with the higher estimated savings ranks first. That is why a cache miss with a
                    lower dollar estimate can still rank above a memory trim with a higher one.
                  </p>
                  {visibleGroups.length === 0 ? (
                    <EmptyState
                      headline="No active recommendations"
                      why="No active recommendations match the current filters."
                      whatWillAppear="Adjust the toolbar filters or wait for detector findings."
                    />
                  ) : (
                    visibleGroups.map((group, i) => (
                      <RecCard
                        key={group.detector_id}
                        group={group}
                        rank={i + 1}
                        isFlagship={i === 0 && group.detector_id === "D8"}
                        focusRecId={focusRecId}
                        onDismissFocus={clearFocus}
                        onDismiss={handleDismiss}
                        onAdopt={handleAdopt}
                      />
                    ))
                  )}
                  <p className="kpi-fn" style={{ marginTop: -4, marginBottom: 13 }}>
                    {WASTE_SOURCE_FOOTNOTE}
                  </p>

                  {/* Detector coverage */}
                  <details className="detector-status-details">
                    <summary>
                      Detector coverage (
                      {view.detectors.filter((d) => d.status === "ACTIVE").length} active /{" "}
                      {view.detectors.length} total)
                    </summary>
                    <DetectorStatusStrip detectors={view.detectors} />
                  </details>
                </>
              );
            })()}

          {/* BM1 — Published practice scorecard */}
          {toolbarParams.state === null && (
            <div className="card" style={{ marginBottom: 13 }}>
              <div className="section-head">
                <h2>Published best practices</h2>
              </div>
              <PracticesSection />
            </div>
          )}

          {/* Adopted changes — Measured Effect (W4 Impact Ledger) */}
          {(toolbarParams.state === null || toolbarParams.state === "adopted") && (
            <div className="card" style={{ marginBottom: 13 }}>
              <div className="section-head">
                <h2>Adopted changes — measured effect</h2>
              </div>
              {view.adopted.length === 0 ? (
                <p className="kpi-off-hint">
                  No recommendations adopted yet. Modeled savings are never summed into achieved —
                  measured effect appears here once an adopted rec is verified.
                </p>
              ) : (
                <ul className="rec-adopted-list">
                  {view.adopted.map((rec) => (
                    <li key={rec.rec_id} className="rec-adopted-row">
                      <span className="rec-badge" title={rec.detector_id}>
                        {DETECTOR_GROUP_LABELS[rec.detector_id] ?? rec.detector_id}
                      </span>{" "}
                      {rec.lever} <span className="kpi-off-hint">· {rec.state}</span>
                    </li>
                  ))}
                </ul>
              )}
              <ImpactLedger />
            </div>
          )}

          {/* Dismissed — cool-down list (snoozed until dismissed_until) */}
          {(toolbarParams.state === null || toolbarParams.state === "dismissed") && (
            <div className="card" style={{ marginBottom: 13 }}>
              <div className="section-head">
                <h2>Dismissed</h2>
              </div>
              {view.dismissed.length === 0 ? (
                <p className="kpi-off-hint">
                  <span title="FR-REC-106">
                    None dismissed. Dismissed recommendations stay hidden through their cool-down
                    period and auto-return when it expires.
                  </span>
                </p>
              ) : (
                <ul className="rec-dismissed-list">
                  {view.dismissed.map((rec) => (
                    <li key={rec.rec_id} className="rec-dismissed-row">
                      <span className="rec-badge" title={rec.detector_id}>
                        {DETECTOR_GROUP_LABELS[rec.detector_id] ?? rec.detector_id}
                      </span>{" "}
                      {rec.lever}
                      {rec.dismissed_until !== null && (
                        <span className="kpi-off-hint">
                          {" "}
                          · snoozed until {rec.dismissed_until.slice(0, 10)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      <p className="kpi-fn" style={{ marginTop: 8 }}>
        <span title="FR-REC-103">{STANDING_FOOTNOTE}</span>
      </p>
    </div>
  );
}
