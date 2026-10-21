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

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type {
  RecommendationCard,
  RecommendationGroup,
  RecommendationsView,
} from "../../query/api/recommendations";
import type { ApiResponse } from "../../query/envelope";
import { fetchRecommendations } from "../api/client";
import { EFFECT_NOT_MEASURED_HELP, headlineSavings, meterBounds } from "../lib/rec-presentation";
import { useWorkspaceNames } from "../lib/workspace-names";
import AsyncErrorState from "../shell/AsyncErrorState";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import InfoTip from "../shell/InfoTip";
import { SkeletonBlock } from "../shell/Skeleton";
import DetectorStatusStrip from "./DetectorStatusStrip";
import ImpactLedger from "./ImpactLedger";
import PracticesSection from "./PracticesSection";
import RecCard, { DETECTOR_GROUP_LABELS, recTargetLabel } from "./RecCard";
import RecsToolbar, {
  type SortOrder,
  type ToolbarParams,
  collectWorkspaces,
  filterRecommendations as applyFilters,
  lifecycleListParams,
  parseToolbarParams,
  resetToolbarParams,
  setToolbarParam,
} from "./RecsToolbar";
import { sessionIdsForRecommendation } from "./rec-sessions";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
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

const LIMIT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

function limitTime(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-US", LIMIT_TIME_FORMAT);
}

/**
 * The limit-strip sentence, from the D5 forecast facts (used % of the weekly limit, the pace over
 * the last day, and the hours left to the reset). Falls back to the card's lever for an older
 * record that has none of them.
 */
function limitWarningText(
  rec: RecommendationCard,
  labelFor: (workspaceId: string) => string,
): string {
  const facts = rec.evidence;
  const used = facts.used_pct;
  const projected = facts.projected_pct;
  const reset = limitTime(facts.resets_at);
  if (typeof used !== "number" || typeof projected !== "number" || reset === null) return rec.lever;
  const hit = limitTime(facts.projected_limit_hit_at);
  const cut = facts.required_cut_pct;
  const topWorkspace = facts.top_workspace_id;
  const share = facts.top_workspace_share;
  const windowHours = facts.pace_window_hours;
  const paceBasis =
    typeof windowHours === "number" && windowHours < 23.5
      ? "the pace since the weekly reset"
      : "the pace of the last day";
  const parts = [
    facts.forecast_state === "EXCEEDED"
      ? `${Math.round(used)}% of the weekly limit is used; it resets ${reset}.`
      : `${Math.round(used)}% of the weekly limit is used. At ${paceBasis}, about ${Math.round(projected)}% by the reset on ${reset}${hit === null ? "." : `; the limit would be reached about ${hit}.`}`,
  ];
  if (typeof cut === "number" && cut > 0)
    parts.push(`Cutting use by about ${cut}% from now keeps you under it.`);
  if (typeof topWorkspace === "string" && typeof share === "number")
    parts.push(
      `${labelFor(topWorkspace)} is ${Math.round(share * 100)}% of this week's cost-equivalent spend.`,
    );
  return parts.join(" ");
}

const RANKING_WARNING_COPY: Record<string, string> = {
  PACKET_EXPIRED: "Some evidence is no longer current. Refresh after new activity is available.",
  MISSING_EVIDENCE:
    "Some recommendations could not be ranked because supporting evidence is unavailable.",
};

function rankingWarningCopy(code: string): string {
  return RANKING_WARNING_COPY[code] ?? "Some recommendations could not be ranked right now.";
}

// Humanize the excluded-decision enums at the UI boundary (SEC-101 structural
// strings). The backend keeps
// emitting the enums; no raw code reaches the reader.
const EXCLUDED_REASON_COPY: Record<string, string> = {
  HEALTHY: "Healthy — no action needed",
  NO_CHANGE: "No significant change",
  PACKET_EXPIRED: "Evidence expired",
  MALFORMED_CANDIDATE: "Skipped — data issue",
  COOLDOWN_ACTIVE: "Recently acted on — cooling down",
};
function excludedReasonCopy(reason: string): string {
  return EXCLUDED_REASON_COPY[reason] ?? reason.toLowerCase().replace(/_/g, " ");
}
function excludedSubjectCopy(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// History repeats one card per window and workspace, so it folds into one row per detector,
// newest detector first; each row keeps the caller's card order.
function groupHistory(
  recs: RecommendationCard[],
): { detector_id: string; label: string; newest: string; recs: RecommendationCard[] }[] {
  const grouped = new Map<string, RecommendationCard[]>();
  for (const rec of recs)
    grouped.set(rec.detector_id, [...(grouped.get(rec.detector_id) ?? []), rec]);
  return [...grouped]
    .map(([detector_id, members]) => ({
      detector_id,
      label:
        DETECTOR_GROUP_LABELS[detector_id] === undefined
          ? detector_id
          : `${detector_id} · ${DETECTOR_GROUP_LABELS[detector_id]}`,
      newest: members.reduce((max, rec) => (rec.created_at > max ? rec.created_at : max), ""),
      recs: members,
    }))
    .sort((a, b) => b.newest.localeCompare(a.newest));
}

function deriveUiGroups(active: RecommendationCard[]): RecommendationGroup[] {
  const grouped = new Map<string, RecommendationCard[]>();
  for (const rec of active) {
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
      total_savings_u_per_wk: recs.reduce((total, rec) => total + (headlineSavings(rec) ?? 0), 0),
    };
  };

  return [...grouped].map(([detectorId, recs]) => buildGroup(detectorId, recs));
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

/** The $ the card headline shows (what SavingsMeter renders); the lowest value when it shows none. */
function shownRank(rec: RecommendationCard): number {
  const shown =
    rec.allocated_u_per_wk === null
      ? typeof rec.reliability_u_per_wk === "number"
        ? rec.reliability_u_per_wk
        : isStandaloneShown(rec)
          ? rec.modeled_savings_u_per_wk
          : null
      : headlineSavings(rec);
  return shown ?? -Number.MAX_VALUE; // finite, so two "no $" cards compare equal (not NaN)
}

/** Standalone lane (E1/E2): the meter shows the modeled figure, kept out of the page total. */
function isStandaloneShown(rec: RecommendationCard): boolean {
  return (
    rec.allocated_u_per_wk === null &&
    typeof rec.reliability_u_per_wk !== "number" &&
    typeof rec.modeled_savings_u_per_wk === "number" &&
    rec.modeled_savings_u_per_wk > 0 &&
    rec.estimate?.summable === false
  );
}

/** Sort recommendations by the toolbar sort order. "confidence" preserves the API order. */
function applySort(recs: RecommendationCard[], sort: SortOrder): RecommendationCard[] {
  if (sort === "confidence") return recs; // preserve API article-priority order
  if (sort === "savings") {
    // The $ each card shows (as the server ranks it); cards that show no $ are last.
    return [...recs].sort((a, b) => shownRank(b) - shownRank(a));
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
        (total, rec) => total + (headlineSavings(rec) ?? 0),
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
    total_savings_u_per_wk: recs.reduce((total, rec) => total + (headlineSavings(rec) ?? 0), 0),
  };
}

function isCurrentRankedRec(rec: RecommendationCard): boolean {
  return (
    (rec.weeks_ago ?? 0) === 0 &&
    (rec.state as string) !== "RETIRED" &&
    rec.state !== "MEASURED_EFFECTIVE"
  );
}

function toolbarGroups(view: RecommendationsView, params: ToolbarParams): RecommendationGroup[] {
  const filtered = applyFilters(view.active.filter(isCurrentRankedRec), params);
  // "savings" orders groups by the summed $ their cards show (after filters), groups showing no $
  // and minor items last, as the server orders them unfiltered. Sort is stable. Standalone
  // estimates overlap, so they add only their largest card.
  const shownTotal = (group: RecommendationGroup) => {
    if (!group.recs.some((rec) => shownRank(rec) >= 0)) return -1;
    let sum = 0;
    let standaloneMax = 0;
    for (const rec of group.recs) {
      const shown = Math.max(0, shownRank(rec));
      if (isStandaloneShown(rec)) standaloneMax = Math.max(standaloneMax, shown);
      else sum += shown;
    }
    return sum + standaloneMax;
  };
  const orderGroups = (groups: RecommendationGroup[]): RecommendationGroup[] =>
    params.sort !== "savings"
      ? groups
      : [...groups].sort(
          (a, b) =>
            Number(a.detector_id === "MINOR_ITEMS") - Number(b.detector_id === "MINOR_ITEMS") ||
            shownTotal(b) - shownTotal(a),
        );
  if (params.group === "workspace") {
    return orderGroups(
      groupByWorkspace(filtered).map((group) => ({
        ...group,
        recs: applySort(group.recs, params.sort),
      })),
    );
  }

  // Default: detector-family groups (respect existing API groups when valid).
  const groups = activeGroupsForView(view);
  // Re-filter groups using the same priority as applyFilters.
  return orderGroups(
    groups
      .map((group) => {
        const recs = applySort(
          applyFilters(group.recs.filter(isCurrentRankedRec), params),
          params.sort,
        );
        return withGroupMembers(group, recs);
      })
      .filter((group) => group.recs.length > 0),
  );
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
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const { labelFor } = useWorkspaceNames();

  // Subscribe to hash changes to pick up URL-synced toolbar params.
  const hash = useSyncExternalStore(subscribeToHash, getHash, getHashServer);
  const toolbarParams: ToolbarParams = parseToolbarParams(hash);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional re-fetch trigger
  useEffect(() => {
    let cancelled = false;
    fetchRecommendations()
      .then((v) => {
        if (!cancelled) {
          setState({ status: "ok", value: v });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
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
  async function handleAdopt(recId: string, optionId?: string): Promise<void> {
    await persistAction("adopt", {
      rec_id: recId,
      completed_change: true,
      ...(optionId === undefined ? {} : { option_id: optionId }),
    });
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
    // REL-FIX 2: an adoption nothing can measure is saved without a cycle (effect_measured: false).
    let unmeasured = false;
    if (action === "adopt") {
      try {
        const result = (await res.json()) as { data?: { effect_measured?: boolean } } | null;
        unmeasured = result?.data?.effect_measured === false;
      } catch {
        // The flag is optional; a body we cannot read means a measured adoption.
      }
    }
    // The card may leave the list on refresh, so the page names what was saved.
    const saved = view?.active.find((rec) => rec.rec_id === body.rec_id);
    setLastSaved(
      `${action === "adopt" ? "Adopted" : "Dismissed"}: ${
        saved ? recTargetLabel(saved, labelFor) : String(body.rec_id)
      }${unmeasured ? " · Effect not measured" : ""}`,
    );
    refresh();
  }

  const view = state.status === "ok" ? state.value.data : null;
  const visibleWarnings = applyFilters(view?.limit_warnings ?? [], toolbarParams);
  // Basis and Last seen are proposed-finding filters. Ignore a stale/manual
  // hash parameter for lifecycle lists where those controls are not available.
  const lifecycleFilterParams = lifecycleListParams(toolbarParams);
  const visibleAdopted = applyFilters(view?.adopted ?? [], lifecycleFilterParams);
  const visibleDismissed = applyFilters(view?.dismissed ?? [], lifecycleFilterParams);
  const historyFromApi =
    (view as (RecommendationsView & { history?: RecommendationCard[] }) | null)?.history ?? [];
  const isImproved = (rec: RecommendationCard) => rec.state === "MEASURED_EFFECTIVE";
  const isNoImprovement = (rec: RecommendationCard) =>
    rec.effect_cycle?.targetDirection === "WORSENED" ||
    rec.effect_cycle?.targetDirection === "UNCHANGED" ||
    (rec.effect_cycle == null && rec.legacy_effect_verdict === "NO_EFFECT");
  const isRetired = (rec: RecommendationCard) => (rec.state as string) === "RETIRED";
  const rankedAdopted = visibleAdopted
    .filter(
      (rec) =>
        !isImproved(rec) &&
        !isRetired(rec) &&
        rec.detector_id !== "D5" &&
        (isNoImprovement(rec) ||
          rec.effect_cycle?.state === "OPEN_SETTLING" ||
          rec.effect_cycle?.state === "OPEN_MEASURING"),
    )
    .sort((a, b) => Number(isNoImprovement(b)) - Number(isNoImprovement(a)));
  const visibleHistory = applyFilters(
    [
      ...new Map(
        [...historyFromApi, ...visibleAdopted.filter(isImproved)].map((rec) => [rec.rec_id, rec]),
      ).values(),
    ],
    lifecycleFilterParams,
  );
  const rankedAdoptedIds = new Set(rankedAdopted.map((rec) => rec.rec_id));
  const historyIds = new Set(visibleHistory.map((rec) => rec.rec_id));
  const ledgerAdopted = visibleAdopted.filter(
    (rec) => !rankedAdoptedIds.has(rec.rec_id) && !historyIds.has(rec.rec_id),
  );
  const hasFilters =
    toolbarParams.scope !== null ||
    toolbarParams.ws !== null ||
    toolbarParams.basis !== null ||
    toolbarParams.seen !== null ||
    toolbarParams.type !== null;
  const resetFilters = resetToolbarParams;
  // RC-B: proposed cards under the de-minimis floor, shown in their own collapsed section.
  const belowFloorRecs =
    toolbarParams.state === null || toolbarParams.state === "proposed"
      ? applyFilters(view?.below_floor ?? [], toolbarParams)
      : [];
  // RV6 deep-link focus: the target proposal may live in the ranked list or
  // the limit-warning strip. Known → the
  // target card scrolls/highlights/auto-expands; stale → quiet notice. RC-B: a target in the
  // collapsed below-floor or history section opens that section.
  const focus = toolbarParams.focus;
  const focusInBelowFloor = focus !== null && belowFloorRecs.some((rec) => rec.rec_id === focus);
  const focusInHistory = focus !== null && visibleHistory.some((rec) => rec.rec_id === focus);
  const focusKnown =
    focus !== null &&
    view !== null &&
    (focusInBelowFloor ||
      focusInHistory ||
      [...view.active, ...view.limit_warnings].some((rec) => rec.rec_id === focus));
  const focusRecId = focusKnown ? focus : null;
  const clearFocus = () => setToolbarParam("focus", null);
  const focusWarning = useCallback((node: HTMLDivElement | null) => {
    node?.scrollIntoView?.({ block: "center" });
    node?.focus({ preventScroll: true });
  }, []);

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

      {state.status === "error" && <AsyncErrorState resource="recommendations" onRetry={refresh} />}

      {state.status === "loading" && (
        <div aria-busy="true" aria-label="Loading recommendations">
          <SkeletonBlock />
          <SkeletonBlock />
        </div>
      )}

      {state.status === "ok" && view !== null && (
        <>
          {/* RV6: a stale/unknown deep-link degrades to the full list with a quiet notice. */}
          {focus !== null && !focusKnown && (
            <output className="recs-focus-notice">
              <span>That recommendation is no longer available — showing the full list.</span>
              <button type="button" className="recs-focus-notice-dismiss" onClick={clearFocus}>
                Dismiss
              </button>
            </output>
          )}

          <section
            className="recs-supporting-intro"
            aria-labelledby="recs-supporting-detectors-head"
          >
            <div className="section-head">
              <h2 id="recs-supporting-detectors-head">Detector details and filtering</h2>
            </div>
            <p className="rec-ranking-explainer">
              Evidence records and filters for the ranked recommendations below.
            </p>
            <RecsToolbar view={view} params={toolbarParams} />
          </section>

          {/* D5 limit warning alert strip — above waste-source cards (taxonomy §7 IA §4 §2.1) */}
          {visibleWarnings.length > 0 &&
            (toolbarParams.state === null || toolbarParams.state === "proposed") && (
              <div className="limit-warning-strip">
                {visibleWarnings.map((rec) => (
                  <div
                    key={rec.rec_id}
                    className={`banner banner-warn${focusRecId === rec.rec_id ? " rec-focus-highlight" : ""}`}
                    role="alert"
                    tabIndex={-1}
                    ref={focusRecId === rec.rec_id ? focusWarning : undefined}
                  >
                    <span className="limit-warning-strip-icon" aria-hidden="true">
                      ⚠
                    </span>
                    <span className="limit-warning-strip-text">
                      <strong>Limit warning</strong> {limitWarningText(rec, labelFor)}
                    </span>
                    <InfoTip
                      label="How the limit warning is worked out"
                      content="Uses the weekly-limit percentage Claude Code reports, plus how fast it rose over the last 24 hours (since the reset if that was sooner). Unless a reading falls exactly at the start of that day, the percentage then is estimated between the nearest readings using local token spend. It adds that pace for the hours left until the reset. The share by workspace uses this week's cost-equivalent spend."
                    />
                    <a className="limit-warning-strip-action" href="#/settings?section=calibration">
                      Calibrate budget hook
                    </a>
                    {focusRecId === rec.rec_id && (
                      <button type="button" className="rec-focus-dismiss" onClick={clearFocus}>
                        Clear highlight
                      </button>
                    )}
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
              const savingsScale = Math.max(
                0,
                ...visibleRecs.map((rec) => meterBounds(rec)?.[1] ?? 0),
              );
              // A valid deep link must remain visible: if its target would otherwise be
              // nested in the closed remaining queue, promote it to the action card.
              const selectedRec =
                (focusRecId === null
                  ? undefined
                  : visibleRecs.find((rec) => rec.rec_id === focusRecId)) ?? visibleRecs[0];
              const remainingGroups =
                selectedRec === undefined
                  ? visibleGroups
                  : visibleGroups.flatMap((group) => {
                      const recs = group.recs.filter((rec) => rec.rec_id !== selectedRec.rec_id);
                      return recs.length === 0 ? [] : [withGroupMembers(group, recs)];
                    });

              // Scope choices keep the basis/seen filters and include warning proposals.
              const workspaces = collectWorkspaces(view, labelFor);
              const allProposed = [
                ...view.active.filter(isCurrentRankedRec),
                ...view.limit_warnings,
              ];
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
                        <p className="kpi-fn">
                          Dollar figures are net of overlaps: each token is counted once, so they
                          add up.{" "}
                          <InfoTip
                            label="Net of overlaps"
                            content="Each card's dollar figure is the spend in the last 7 days its fix would remove. Tokens targeted by several recommendations are counted once, for the most specific fix, so the figures can be added without double counting."
                          />
                        </p>
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
                    <h2>Ranked by weekly impact</h2>
                  </div>
                  <p className="rec-ranking-explainer">
                    Ranked using measured effects where available, usage-based estimates for
                    savings, and risk for safety findings. Review the evidence before acting.
                    <InfoTip
                      label="How this list is ranked"
                      content="Weekly impact uses measured effects when available, usage-estimated savings where measurement is pending, and risk for safety findings. The list follows the server's ranking order, highest first."
                    />
                  </p>
                  {lastSaved !== null && <output className="rec-apply-status">{lastSaved}</output>}
                  {/* Group sections contain cards, so a semantic list would require invalid nested elements. */}
                  {/* biome-ignore lint/a11y/useSemanticElements: group sections contain their own card structure */}
                  <div role="list" aria-label="Ranked by weekly impact">
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
                            help={{
                              href: "#/help?topic=recommendations&section=unavailable",
                              label: "Why recommendations may be empty",
                            }}
                          />
                          {hasFilters && (
                            <button type="button" className="btn-secondary" onClick={resetFilters}>
                              Reset filters
                            </button>
                          )}
                        </div>
                      ) : null
                    ) : (
                      <>
                        {selectedRec !== undefined && (
                          <RecCard
                            key={selectedRec.rec_id}
                            savingsScale={savingsScale}
                            rec={selectedRec}
                            showRank={false}
                            focusRecId={focusRecId}
                            onDismissFocus={clearFocus}
                            onDismiss={handleDismiss}
                            onAdopt={handleAdopt}
                            onEffectMutated={refresh}
                          />
                        )}
                        {/* UIP-7: each detector family renders as its own visible section. */}
                        {remainingGroups.map((group) => {
                          const above = group.recs.slice(0, 3);
                          const below = group.recs.slice(3);
                          return (
                            <div
                              key={group.detector_id}
                              className="recs-group-section"
                              data-detector-id={group.detector_id}
                            >
                              <h3 className="recs-group-head">
                                {group.label}{" "}
                                <span className="recs-group-count">({group.recs.length})</span>
                                {group.detector_id !== "MINOR_ITEMS" &&
                                  group.total_savings_u_per_wk > 0 && (
                                    <span className="recs-group-total">
                                      {" "}
                                      · ${(group.total_savings_u_per_wk / 1_000_000).toFixed(2)}/wk
                                      total{" "}
                                      <InfoTip
                                        label="About the group total"
                                        content="Sum of the net weekly savings of the cards in this group. Net figures count each token once, so they add up. Groups are ordered by this total."
                                      />
                                    </span>
                                  )}
                              </h3>
                              {above.map((rec) => (
                                <RecCard
                                  savingsScale={savingsScale}
                                  key={rec.rec_id}
                                  rec={rec}
                                  showRank={false}
                                  focusRecId={focusRecId}
                                  // R6-18: only #1 (selectedRec, rendered above) and the
                                  // deep-link focus target start open; everything else folds.
                                  defaultFolded={
                                    rec.rec_id !== selectedRec?.rec_id && rec.rec_id !== focusRecId
                                  }
                                  onDismissFocus={clearFocus}
                                  onDismiss={handleDismiss}
                                  onAdopt={handleAdopt}
                                  onEffectMutated={refresh}
                                />
                              ))}
                              {below.length > 0 && (
                                <details className="recs-group-more">
                                  <summary>Show {below.length} more</summary>
                                  {below.map((rec) => (
                                    <RecCard
                                      savingsScale={savingsScale}
                                      key={rec.rec_id}
                                      rec={rec}
                                      showRank={false}
                                      focusRecId={focusRecId}
                                      defaultFolded={
                                        rec.rec_id !== selectedRec?.rec_id &&
                                        rec.rec_id !== focusRecId
                                      }
                                      onDismissFocus={clearFocus}
                                      onDismiss={handleDismiss}
                                      onAdopt={handleAdopt}
                                      onEffectMutated={refresh}
                                    />
                                  ))}
                                </details>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                  {rankedAdopted.length > 0 && (
                    <section aria-label="Measuring and reopened recommendations">
                      <h3>Measuring and reopened</h3>
                      {rankedAdopted.map((rec) => (
                        <RecCard
                          key={rec.rec_id}
                          rec={rec}
                          showRank={false}
                          focusRecId={focusRecId}
                          defaultFolded={
                            rec.rec_id !== selectedRec?.rec_id && rec.rec_id !== focusRecId
                          }
                          onEffectMutated={refresh}
                        />
                      ))}
                    </section>
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

          {/* Investigate section — excluded decisions + rank_warnings. Read-only, no actions. */}
          {((view.excluded ?? []).length > 0 || (view.rank_warnings ?? []).length > 0) && (
            <section className="recs-investigate-section" aria-labelledby="recs-investigate-head">
              <div className="section-head">
                <h2 id="recs-investigate-head">Investigate</h2>
              </div>
              {(view.rank_warnings ?? []).length > 0 && (
                <ul className="recs-rank-warnings" aria-label="Ranking warnings">
                  {(view.rank_warnings ?? []).map((w, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: warnings are ephemeral, no stable id
                    <li key={i} className="recs-rank-warning banner banner-warn" role="alert">
                      {rankingWarningCopy(w.code)}
                      <details>
                        <summary>Technical details</summary>
                        <p>Warning code: {w.code}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
              {(view.excluded ?? []).length > 0 && (
                <>
                  <p className="recs-excluded-intro">Checked this window — no action needed:</p>
                  <ul className="recs-excluded-list" aria-label="Checked, no action needed">
                    {(view.excluded ?? []).map((e) => (
                      <li key={`${e.subject}:${e.reason}`} className="recs-excluded-item">
                        <span className="recs-excluded-subject">
                          {excludedSubjectCopy(e.subject)}
                        </span>
                        <span className="recs-excluded-reason">{excludedReasonCopy(e.reason)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {belowFloorRecs.length > 0 && (
            <section
              className="card"
              aria-label="Below the low-impact threshold"
              style={{ marginBottom: 13 }}
            >
              <details className="recs-history" {...(focusInBelowFloor ? { open: true } : {})}>
                <summary className="section-head">
                  <h2>Below the low-impact threshold ({belowFloorRecs.length})</h2>
                </summary>
                <p className="rec-ranking-explainer">
                  Real findings whose weekly savings are too small to rank with the cards above.
                </p>
                {applySort(belowFloorRecs, toolbarParams.sort).map((rec) => (
                  <RecCard
                    key={rec.rec_id}
                    rec={rec}
                    showRank={false}
                    focusRecId={focusRecId}
                    defaultFolded={rec.rec_id !== focusRecId}
                    onDismissFocus={clearFocus}
                    onDismiss={handleDismiss}
                    onAdopt={handleAdopt}
                    onEffectMutated={refresh}
                  />
                ))}
              </details>
            </section>
          )}

          {visibleHistory.length > 0 && (
            <section
              className="card"
              aria-label="Recommendation history"
              style={{ marginBottom: 13 }}
            >
              <details className="recs-history" {...(focusInHistory ? { open: true } : {})}>
                <summary className="section-head">
                  <h2>Recommendation history ({visibleHistory.length})</h2>
                </summary>
                {groupHistory(applySort(visibleHistory, toolbarParams.sort)).map((group) => (
                  <details
                    key={group.detector_id}
                    className="recs-history-group"
                    {...(focusRecId !== null && group.recs.some((rec) => rec.rec_id === focusRecId)
                      ? { open: true }
                      : {})}
                  >
                    <summary>
                      {group.label} · {group.recs.length} card{group.recs.length === 1 ? "" : "s"} ·
                      newest {group.newest.slice(0, 10)}
                    </summary>
                    {group.recs.map((rec) => (
                      <RecCard
                        key={rec.rec_id}
                        rec={rec}
                        showRank={false}
                        focusRecId={focusRecId}
                        onDismissFocus={clearFocus}
                        onEffectMutated={refresh}
                      />
                    ))}
                  </details>
                ))}
              </details>
            </section>
          )}

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
              {toolbarParams.state === "adopted" && rankedAdopted.length > 0 && (
                <section aria-label="Measuring and reopened recommendations">
                  <h3>Measuring and reopened</h3>
                  {rankedAdopted.map((rec) => (
                    <RecCard
                      key={rec.rec_id}
                      rec={rec}
                      showRank={false}
                      onEffectMutated={refresh}
                    />
                  ))}
                </section>
              )}
              {ledgerAdopted.length === 0 && rankedAdopted.length === 0 ? (
                <p className="kpi-off-hint">
                  No adopted recommendations in this selection. Modeled savings are never summed
                  into achieved — measured effect appears here once an adopted rec is verified.
                </p>
              ) : ledgerAdopted.length > 0 ? (
                <ul className="rec-adopted-list">
                  {applySort(ledgerAdopted, toolbarParams.sort).map((rec) => (
                    <li key={rec.rec_id} className="rec-adopted-row">
                      {rec.effect_cycle != null || rec.legacy_effect_verdict != null ? (
                        <RecCard rec={rec} showRank={false} onEffectMutated={refresh} />
                      ) : (
                        <>
                          <span className="rec-badge" title={rec.detector_id}>
                            {DETECTOR_GROUP_LABELS[rec.detector_id] ?? rec.detector_id}
                          </span>{" "}
                          {rec.lever} <span className="kpi-off-hint">· {rec.state}</span>
                          {rec.effect_capability?.mode === "MANUAL" && (
                            <span className="kpi-off-hint">
                              {" "}
                              · Effect not measured{" "}
                              <InfoTip
                                label="Effect not measured"
                                content={EFFECT_NOT_MEASURED_HELP}
                              />
                            </span>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <ImpactLedger
                key={refreshKey}
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
                  {applySort(visibleDismissed, toolbarParams.sort).map((rec) => (
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
