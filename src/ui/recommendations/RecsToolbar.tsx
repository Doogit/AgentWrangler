/**
 * src/ui/recommendations/RecsToolbar.tsx — URL-synced filter/sort/group toolbar.
 *
 * Controls (all round-trip through hash query params):
 *   state  = proposed | adopted | dismissed  (lifecycle filter)
 *   tier   = WARNING | MODELED_SAVINGS | ADVISORY | DIRECTIONAL
 *   ws     = <scope_workspace_id> | "" (all workspaces)
 *   group  = detector | workspace
 *   sort   = confidence | savings | newest
 *   focus  = <rec_id> (reserved for RV6 deep-link; toolbar reads but does not set)
 *
 * Honesty invariant: this component never drops or alters the honesty chips on
 * RecCard — it only controls which cards are visible.
 */

import type { RecommendationCard, RecommendationsView } from "../../query/api/recommendations";
import { workspaceLabel } from "../lib/workspace-label";
import InfoTip from "../shell/InfoTip";
import { confidenceTierLabel } from "./RecCard";

export type LifecycleState = "proposed" | "adopted" | "dismissed";
export type TierFilter = "WARNING" | "MODELED SAVINGS" | "ADVISORY" | "DIRECTIONAL";
export type GroupBy = "detector" | "workspace";
export type SortOrder = "confidence" | "savings" | "newest";

export interface ToolbarParams {
  state: LifecycleState | null;
  tier: TierFilter | null;
  ws: string | null; // scope_workspace_id; null = all (kept for backward-compat URL round-trips; scope takes priority)
  /** Scope strip param: 'global' | workspace_id | null (all). Overrides ws when non-null. */
  scope: string | null;
  group: GroupBy;
  sort: SortOrder;
  focus: string | null; // RV6 deep-link target
}

const TIER_LABELS: TierFilter[] = ["WARNING", "MODELED SAVINGS", "ADVISORY", "DIRECTIONAL"];

const LIFECYCLE_LABELS: Array<{ value: LifecycleState; label: string }> = [
  { value: "proposed", label: "Proposed" },
  { value: "adopted", label: "Adopted" },
  { value: "dismissed", label: "Dismissed" },
];

/** Parse toolbar params from the current hash query string. */
export function parseToolbarParams(hash: string): ToolbarParams {
  const qIdx = hash.indexOf("?");
  const params = qIdx === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(qIdx + 1));

  const rawState = params.get("state");
  const state: LifecycleState | null =
    rawState === "proposed" || rawState === "adopted" || rawState === "dismissed" ? rawState : null;

  const rawTier = params.get("tier");
  const tier: TierFilter | null = (TIER_LABELS as string[]).includes(rawTier ?? "")
    ? (rawTier as TierFilter)
    : null;

  const rawGroup = params.get("group");
  const group: GroupBy = rawGroup === "workspace" ? "workspace" : "detector";

  const rawSort = params.get("sort");
  const sort: SortOrder = rawSort === "savings" || rawSort === "newest" ? rawSort : "confidence";

  const ws = params.get("ws"); // null if not set; kept for backward-compat

  const focus = params.get("focus");

  const rawScope = params.get("scope"); // null | 'global' | workspace_id
  const scope: string | null = rawScope !== "" ? rawScope : null;

  return { state, tier, ws, scope, group, sort, focus };
}

/** Write a single toolbar param into the hash without losing the route path. */
export function setToolbarParam(key: string, value: string | null): void {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const params = qIdx === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(qIdx + 1));
  if (value === null || value === "") {
    params.delete(key);
  } else {
    params.set(key, value);
  }
  const qs = params.toString();
  window.location.hash = qs ? `${path}?${qs}` : path;
}

/** Collect unique workspace ids from all recs (null = global). Exported for scope strip use. */
export function collectWorkspaces(
  view: RecommendationsView,
): Array<{ id: string | null; label: string }> {
  const seen = new Set<string | null>();
  const all = [...view.active, ...view.limit_warnings, ...view.adopted, ...view.dismissed];
  const workspaces: Array<{ id: string | null; label: string }> = [];
  for (const rec of all) {
    const id = rec.scope_workspace_id;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = id === null ? "Global (cross-workspace)" : workspaceLabel({ workspace_id: id });
    workspaces.push({ id, label });
  }
  return workspaces;
}

/** Count visible cards per lifecycle given the current tier + ws filters. */
function countVisible(
  view: RecommendationsView,
  params: ToolbarParams,
): { proposed: number; adopted: number; dismissed: number } {
  const matchesTierWs = (rec: RecommendationCard) => {
    if (params.tier !== null && confidenceTierLabel(rec) !== params.tier) return false;
    if (params.ws !== null && rec.scope_workspace_id !== params.ws) return false;
    return true;
  };
  return {
    proposed: [...view.active, ...view.limit_warnings].filter(matchesTierWs).length,
    adopted: view.adopted.filter(matchesTierWs).length,
    dismissed: view.dismissed.filter(matchesTierWs).length,
  };
}

interface RecsToolbarProps {
  view: RecommendationsView;
  params: ToolbarParams;
}

export default function RecsToolbar({ view, params }: RecsToolbarProps) {
  const counts = countVisible(view, params);

  function toggle(key: string, value: string, currentValue: string | null) {
    setToolbarParam(key, currentValue === value ? null : value);
  }

  return (
    <div className="recs-toolbar" aria-label="Recommendations filters">
      {/* Lifecycle chips — use fieldset/legend for semantic grouping */}
      <fieldset className="recs-toolbar-group recs-toolbar-group--lifecycle">
        <legend className="recs-toolbar-legend">
          Lifecycle{" "}
          <InfoTip
            label="What the lifecycle chips mean"
            content="Where this recommendation is in your workflow — freshly surfaced, already acted on, or dismissed. Use it to avoid re-doing work you've handled."
          />
        </legend>
        {LIFECYCLE_LABELS.map(({ value, label }) => {
          const count = counts[value];
          const active = params.state === value;
          return (
            <button
              key={value}
              type="button"
              className={`recs-chip recs-chip--lifecycle${active ? " recs-chip--active" : ""}`}
              aria-pressed={active}
              data-toolbar-state={value}
              onClick={() => toggle("state", value, params.state)}
            >
              {label} <span className="recs-chip-count">({count})</span>
            </button>
          );
        })}
      </fieldset>

      {/* Confidence-tier chips — only relevant for proposed view */}
      {(params.state === null || params.state === "proposed") && (
        <fieldset className="recs-toolbar-group recs-toolbar-group--tier">
          <legend className="recs-toolbar-legend">
            Confidence tier{" "}
            <InfoTip
              label="What the tier chips mean"
              content="How strong the evidence is: WARNING and MODELED SAVINGS are grounded in your data, ADVISORY and DIRECTIONAL are softer signals. Act on the top tiers first."
            />
          </legend>
          {TIER_LABELS.map((tierLabel) => {
            const active = params.tier === tierLabel;
            return (
              <button
                key={tierLabel}
                type="button"
                className={`recs-chip recs-chip--tier${active ? " recs-chip--active" : ""}`}
                aria-pressed={active}
                data-toolbar-tier={tierLabel}
                onClick={() => toggle("tier", tierLabel, params.tier)}
              >
                {tierLabel}
              </button>
            );
          })}
        </fieldset>
      )}

      <div className="recs-toolbar-row">
        {/* Group-by */}
        <label className="recs-toolbar-label">
          Group by
          <select
            className="recs-toolbar-select"
            value={params.group}
            aria-label="Group recommendations by"
            onChange={(e) =>
              setToolbarParam("group", e.target.value === "workspace" ? "workspace" : null)
            }
          >
            <option value="detector">Detector family</option>
            <option value="workspace">Workspace</option>
          </select>
        </label>

        {/* Sort */}
        <label className="recs-toolbar-label">
          Sort
          <select
            className="recs-toolbar-select"
            value={params.sort}
            aria-label="Sort recommendations"
            onChange={(e) => {
              const v = e.target.value;
              setToolbarParam("sort", v === "confidence" ? null : v);
            }}
          >
            <option value="confidence">Confidence tier</option>
            <option value="savings">Modeled $/wk</option>
            <option value="newest">Newest</option>
          </select>
        </label>
      </div>
    </div>
  );
}
