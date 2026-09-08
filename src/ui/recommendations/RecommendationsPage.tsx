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
import RecCard, { DETECTOR_GROUP_LABELS } from "./RecCard";
import RecsToolbar, {
  type SortOrder,
  type ToolbarParams,
  collectWorkspaces,
  filterRecommendations as applyFilters,
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
  "Possible savings are kept separate from the results measured after a change.";
const WASTE_SOURCE_FOOTNOTE =
  "Estimates show possible reductions, not results. Different suggestion types use different estimation methods.";

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

/** Sort active recs by the toolbar sort order. "confidence" = keep existing article-priority order. */
function applySort(recs: RecommendationCard[], sort: SortOrder): RecommendationCard[] {
  if (sort === "confidence") return recs; // preserve API article-priority order
  if (sort === "savings") {
    // Workspace/minor-item groups can contain different methods. Keep their
    // family policy order; dollar estimates only reorder within a family.
    const familyOrder = new Map<string, number>();
    for (const rec of recs) {
      if (!familyOrder.has(rec.detector_id)) familyOrder.set(rec.detector_id, familyOrder.size);
    }
    return [...recs].sort(
      (a, b) =>
        (familyOrder.get(a.detector_id) ?? 0) - (familyOrder.get(b.detector_id) ?? 0) ||
        (b.modeled_savings_u_per_wk ?? -1) - (a.modeled_savings_u_per_wk ?? -1),
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
function withGroupMembers(
  group: RecommendationGroup,
  recs: RecommendationCard[],
): RecommendationGroup {
  return {
    ...group,
    recs,
    session_count: new Set(recs.flatMap(sessionIdsForRecommendation)).size,
    total_savings_u_per_wk: recs.reduce(
      (total, rec) => total + (rec.modeled_savings_u_per_wk ?? 0),
      0,
    ),
  };
}

function toolbarGroups(view: RecommendationsView, params: ToolbarParams): RecommendationGroup[] {
  const filtered = applyFilters(view.active, params);
  if (params.group === "workspace") {
    return groupByWorkspace(filtered).map((group) => ({
      ...group,
      recs: applySort(group.recs, params.sort),
    }));
  }

  // Default: detector-family groups (respect existing API groups when valid).
  const groups = activeGroupsForView(view);
  // Re-filter groups using the same priority as applyFilters.
  return groups
    .map((group) => {
      const recs = applySort(applyFilters(group.recs, params), params.sort);
      return withGroupMembers(group, recs);
    })
    .filter((group) => group.recs.length > 0);
}

async function fetchSessionToken(): Promise<string> {
  const res = await fetch("/api/token", { signal: AbortSignal.timeout(8_000) });
  if (res.ok) {
    const data = (await res.json()) as { token?: unknown };
    if (typeof data.token === "string" && data.token.length > 0) return data.token;
  }
  throw new Error("Unable to authorize this change. Check the daemon and retry.");
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
  async function handleDismiss(recId: string, snoozeDays?: number): Promise<void> {
    const body: Record<string, unknown> = { rec_id: recId };
    if (snoozeDays !== undefined) {
      body.dismissed_until = new Date(Date.now() + snoozeDays * 24 * 60 * 60 * 1000).toISOString();
    }
    await persistAction("dismiss", body);
  }

  // RecCard invokes this only after its local undo window elapses.
  async function handleAdopt(recId: string): Promise<void> {
    await persistAction("adopt", { rec_id: recId });
  }

  async function persistAction(action: "adopt" | "dismiss", body: Record<string, unknown>) {
    const token = await fetchSessionToken();
    const res = await fetch(`/api/recommendations/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw new Error(`Change was not saved (HTTP ${res.status}). Retry or refresh the page.`);
    }
    refresh();
  }

  const view = state.status === "ok" ? state.value.data : null;
  const visibleWarnings = applyFilters(view?.limit_warnings ?? [], toolbarParams);
  // Confidence tier is a proposed-finding filter. Ignore a stale/manual tier
  // hash parameter for lifecycle lists where that control is not available.
  const lifecycleFilterParams = { ...toolbarParams, tier: null };
  const visibleAdopted = applyFilters(view?.adopted ?? [], lifecycleFilterParams);
  const visibleDismissed = applyFilters(view?.dismissed ?? [], lifecycleFilterParams);
  const hasFilters =
    toolbarParams.scope !== null || toolbarParams.ws !== null || toolbarParams.tier !== null;
  const resetFilters = () => {
    for (const key of ["scope", "ws", "tier"]) setToolbarParam(key, null);
  };

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
            Ways to reduce token use. Review a suggestion, make a change, then check its effect.
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
          {visibleWarnings.length > 0 &&
            (toolbarParams.state === null || toolbarParams.state === "proposed") && (
              <div className="limit-warning-strip">
                {visibleWarnings.map((rec) => (
                  <div key={rec.rec_id} className="banner banner-warn" role="alert">
                    <span>
                      <strong>Limit warning</strong> {rec.lever}
                    </span>
                    <RecCard
                      rec={rec}
                      rank={1}
                      focusRecId={focusRecId}
                      onDismissFocus={clearFocus}
                      onDismiss={handleDismiss}
                      onAdopt={handleAdopt}
                    />
                  </div>
                ))}
              </div>
            )}

          {/* Proposed / active waste sources */}
          {(toolbarParams.state === null || toolbarParams.state === "proposed") &&
            (() => {
              const visibleGroups = toolbarGroups(view, toolbarParams);
              // Put one applicable recommendation first so its action and tracking gate are
              // immediately available. Its siblings remain in their original family and order.
              const visibleRecs = visibleGroups.flatMap((group) => group.recs);
              // A valid deep link must remain visible: if its target would otherwise be
              // nested in the closed remaining queue, promote it to the action card.
              const selectedRec =
                (focusRecId === null
                  ? undefined
                  : visibleRecs.find((rec) => rec.rec_id === focusRecId)) ??
                visibleRecs.find((rec) => rec.detector_id !== "D5");
              const remainingGroups =
                selectedRec === undefined
                  ? visibleGroups
                  : visibleGroups.flatMap((group) => {
                      const recs = group.recs.filter((rec) => rec.rec_id !== selectedRec.rec_id);
                      return recs.length === 0 ? [] : [withGroupMembers(group, recs)];
                    });

              // Scope choices keep the tier filter and include warning proposals.
              const workspaces = collectWorkspaces(view);
              const allProposed = [...view.active, ...view.limit_warnings];
              const scopeCandidates = applyFilters(allProposed, {
                ...toolbarParams,
                scope: null,
                ws: null,
              });
              const globalCount = scopeCandidates.filter(
                (r) => r.scope_workspace_id === null,
              ).length;
              const wsCounts = new Map<string, number>();
              for (const r of scopeCandidates) {
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

              // Count-based family summary and lifecycle totals share the selected filters.
              const allGroups = deriveUiGroups(applyFilters(allProposed, toolbarParams));
              const topFamily =
                allGroups.length > 0
                  ? allGroups.reduce((best, g) => (g.recs.length > best.recs.length ? g : best))
                  : null;
              const filteredForTrio = applyFilters(allProposed, toolbarParams);
              const trioWsCount = filteredForTrio.filter(
                (r) => r.scope_workspace_id !== null,
              ).length;
              const trioGlobalCount = filteredForTrio.filter(
                (r) => r.scope_workspace_id === null,
              ).length;

              return (
                <>
                  {/* FB3: summary header card — hosts scope strip, count, lever, trio */}
                  {allProposed.length > 0 && (
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
                            All <span className="scope-chip-count">({scopeCandidates.length})</span>
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
                          <span className="recs-summary-count-number">
                            {filteredForTrio.length}
                          </span>
                          <span className="recs-summary-count-label"> active recommendations</span>
                        </div>
                        {topFamily !== null && (
                          <p className="recs-summary-lever">
                            Most findings: <strong>{topFamily.label}</strong> —{" "}
                            {topFamily.recs.length} {topFamily.recs.length === 1 ? "rec" : "recs"}{" "}
                            across {topFamily.session_count}{" "}
                            {topFamily.session_count === 1 ? "session" : "sessions"}
                          </p>
                        )}
                        <p className="kpi-fn">Estimates can overlap; do not add them together.</p>
                      </div>
                      <div className="recs-summary-trio" aria-label="Scope and adoption counts">
                        <span>
                          <strong>{trioWsCount}</strong> for a workspace
                        </span>
                        <span>
                          <strong>{trioGlobalCount}</strong> global
                        </span>
                        <span>
                          <strong>{visibleAdopted.length}</strong> adopted
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="section-head">
                    <h2>Where to start</h2>
                  </div>
                  <p className="rec-ranking-explainer">
                    Suggestions are grouped by the kind of change. Savings are estimates.
                    <InfoTip
                      label="How suggestions are ordered"
                      content="Recommended order uses a fixed category order. Categories use different estimation methods, so dollar amounts cannot be compared across them. Newest sorts within each group; estimated savings sorts within each category."
                    />
                  </p>
                  {visibleGroups.length === 0 ? (
                    visibleWarnings.length === 0 ? (
                      <div>
                        <EmptyState
                          headline={
                            hasFilters && allProposed.length > 0
                              ? "No matching recommendations"
                              : "No active recommendations"
                          }
                          why={
                            hasFilters
                              ? "No active recommendations match the current filters."
                              : "No active detector findings in this window."
                          }
                          whatWillAppear="New findings appear here when detectors identify an applicable action."
                        />
                        {hasFilters && (
                          <button type="button" onClick={resetFilters}>
                            Reset filters
                          </button>
                        )}
                      </div>
                    ) : null
                  ) : (
                    <>
                      {selectedRec !== undefined && (
                        <RecCard
                          rec={selectedRec}
                          rank={1}
                          isFlagship={selectedRec.detector_id === "D8"}
                          focusRecId={focusRecId}
                          onDismissFocus={clearFocus}
                          onDismiss={handleDismiss}
                          onAdopt={handleAdopt}
                        />
                      )}
                      {remainingGroups.length > 0 && (
                        <details className="recs-remaining-queue">
                          <summary>
                            More suggestions (
                            {remainingGroups.reduce((n, group) => n + group.recs.length, 0)})
                          </summary>
                          {remainingGroups.map((group, i) => (
                            <RecCard
                              key={group.detector_id}
                              group={group}
                              rank={i + 2}
                              focusRecId={focusRecId}
                              onDismissFocus={clearFocus}
                              onDismiss={handleDismiss}
                              onAdopt={handleAdopt}
                            />
                          ))}
                        </details>
                      )}
                    </>
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
              <details>
                <summary>Published best practices</summary>
                <PracticesSection />
              </details>
            </div>
          )}

          {/* Adopted changes — Measured Effect (W4 Impact Ledger) */}
          {(toolbarParams.state === null || toolbarParams.state === "adopted") && (
            <div className="card" style={{ marginBottom: 13 }}>
              <div className="section-head">
                <h2>Adopted changes — measured effect</h2>
              </div>
              {visibleAdopted.length === 0 ? (
                <p className="kpi-off-hint">
                  No adopted recommendations in this selection. Modeled savings are never summed
                  into achieved — measured effect appears here once an adopted rec is verified.
                </p>
              ) : (
                <ul className="rec-adopted-list">
                  {visibleAdopted.map((rec) => (
                    <li key={rec.rec_id} className="rec-adopted-row">
                      <span className="rec-badge" title={rec.detector_id}>
                        {DETECTOR_GROUP_LABELS[rec.detector_id] ?? rec.detector_id}
                      </span>{" "}
                      {rec.lever} <span className="kpi-off-hint">· {rec.state}</span>
                    </li>
                  ))}
                </ul>
              )}
              <ImpactLedger
                {...(hasFilters ? { visibleRecIds: visibleAdopted.map((rec) => rec.rec_id) } : {})}
              />
            </div>
          )}

          {/* Dismissed — cool-down list (snoozed until dismissed_until) */}
          {(toolbarParams.state === null || toolbarParams.state === "dismissed") && (
            <div className="card" style={{ marginBottom: 13 }}>
              <div className="section-head">
                <h2>Dismissed</h2>
              </div>
              {visibleDismissed.length === 0 ? (
                <p className="kpi-off-hint">
                  <span title="FR-REC-106">
                    None dismissed in this selection. Dismissed recommendations stay hidden through
                    their cool-down period and auto-return when it expires.
                  </span>
                </p>
              ) : (
                <ul className="rec-dismissed-list">
                  {visibleDismissed.map((rec) => (
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
