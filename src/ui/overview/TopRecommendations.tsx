import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { RecommendationCard } from "../../query/api/recommendations";
import { createEffectIdempotencyKey, trackEffect } from "../api/effect-client";
import {
  COPY_LABEL,
  CopyIcon,
  REVIEW_LABEL,
  RecChips,
  ReviewIcon,
  SavingsMeter,
  isQuantified,
  meterBounds,
  trackUnavailableReason,
} from "../lib/rec-presentation";
import InfoTip from "../shell/InfoTip";
import PartialBadge from "../shell/PartialBadge";
import { SectionEdge, type SectionLoad, SectionStatus } from "../shell/SectionStatus";
export { isQuantified } from "../lib/rec-presentation";

/** `--row` drives the skeleton shimmer and arrival stagger (styles.css). */
const rowVar = (row: number) => ({ "--row": row }) as CSSProperties;

/** Empty frame this long before bones shimmer, so fast loads never flicker (DESIGN_GUIDE). */
const RESERVE_MS = 300;

/**
 * The API's active array is already ranked; rows keep that order. Only recs with a modeled savings
 * figure qualify for the top 3 — unquantified recs stay on the Recommendations page.
 */
export interface TopRecommendationsProps {
  recommendations: RecommendationCard[];
  /** Grouped count shown on the Recommendations page; omitted from the link when absent. */
  groupCount?: number | undefined;
  pipelineIsIncomplete?: boolean;
  /** The snapshot's freshness; `recomputing` shows "Updating · as of …" and the edge sweep. */
  freshness?: { status: "ready" | "recomputing"; inputs_as_of: string } | undefined;
  /** Rows fade up (staggered) — set when the section just arrived after a build. */
  entering?: boolean;
  onEffectMutated?: (() => void) | undefined;
}

const wholeDollars = (micro: number) => `$${Math.round(micro / 1_000_000).toLocaleString()}`;
const detailHref = (id: string) => `#/recommendations?focus=${encodeURIComponent(id)}`;

function RecommendationRow({
  rec,
  rank,
  scale,
  onEffectMutated,
}: {
  rec: RecommendationCard;
  rank: number;
  scale: number;
  onEffectMutated?: (() => void) | undefined;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [trackState, setTrackState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [confirmTrack, setConfirmTrack] = useState(false);
  const [completed, setCompleted] = useState(false);
  const key = useRef<string | null>(null);
  const primary = rec.actions?.primary;
  const validation = rec.action_validation?.primary;
  const copyLabel = primary ? COPY_LABEL[primary.kind] : undefined;
  const reviewLabel = primary ? REVIEW_LABEL[primary.kind] : undefined;
  const copyReady = validation?.ok === true && Boolean(primary?.copy_text);
  const trackable = rec.effect_capability?.mode === "TRACKABLE";
  const unavailable: string[] = [];
  if (copyLabel && !copyReady) {
    unavailable.push(
      validation?.ok === false
        ? `${copyLabel} is withheld because the action failed validation (${validation.reason}). Open the recommendation to see its evidence, affected sessions, and steps.`
        : `${copyLabel} is unavailable because this action has no validated text yet. Open the recommendation to see its evidence, affected sessions, and steps.`,
    );
  }
  if (!trackable) {
    unavailable.push(trackUnavailableReason(rec));
  }

  async function copyInstruction() {
    if (!primary?.copy_text || !copyReady) return;
    try {
      await navigator.clipboard.writeText(primary.copy_text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  async function startTracking() {
    if (!completed || trackState === "saving" || trackState === "saved") return;
    setTrackState("saving");
    key.current ??= createEffectIdempotencyKey(rec.rec_id, "track");
    try {
      const result = await trackEffect(rec.rec_id, key.current);
      if (!result.supported || !result.cycle) throw new Error("Tracking is unavailable.");
      setTrackState("saved");
      onEffectMutated?.();
    } catch {
      setTrackState("failed");
    }
  }

  return (
    <article
      className="overview-top-rec-row"
      data-category={rec.category.toLowerCase()}
      data-testid={`top-rec-${rank}`}
      style={rowVar(rank - 1)}
    >
      <span className="overview-top-rec-rank" aria-label={`Rank ${rank}`}>
        {rank}
      </span>
      <div className="overview-top-rec-copy">
        <RecChips rec={rec} overview />
        <h3>
          <a href={detailHref(rec.rec_id)}>{rec.title || rec.lever}</a>
        </h3>
        {primary?.summary && <p>{primary.summary}</p>}
      </div>
      <SavingsMeter rec={rec} scale={scale} testIdSuffix={rank} overview />
      <div className="overview-top-rec-actions">
        {reviewLabel ? (
          <a className="btn-primary" href={detailHref(rec.rec_id)}>
            <ReviewIcon />
            {reviewLabel}
          </a>
        ) : copyLabel && !copyReady ? (
          <a className="btn-primary" href={detailHref(rec.rec_id)}>
            <ReviewIcon />
            Open recommendation
          </a>
        ) : copyLabel ? (
          <button type="button" className="btn-primary" onClick={() => void copyInstruction()}>
            <CopyIcon />
            {copyState === "copied" ? "Copied" : copyLabel}
          </button>
        ) : null}
        {trackable ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setConfirmTrack(true)}
            disabled={trackState === "saving" || trackState === "saved"}
            title="Records a baseline for a completed change; changes no files."
          >
            {trackState === "saved" ? "Tracking" : "Track"}
          </button>
        ) : (
          <button type="button" className="btn-secondary" disabled>
            Track
          </button>
        )}
        {unavailable.length > 0 && (
          <InfoTip label="Why some actions are unavailable" content={unavailable.join(" ")} />
        )}
        {copyState === "failed" && <span role="alert">Couldn't copy instruction. Try again.</span>}
        {trackState === "failed" && <span role="alert">Couldn't start tracking. Try again.</span>}
        {confirmTrack && trackState !== "saved" && (
          <div className="overview-top-rec-track-confirm">
            <label>
              <input
                type="checkbox"
                checked={completed}
                onChange={(event) => setCompleted(event.target.checked)}
              />{" "}
              I completed this change
            </label>
            <button
              type="button"
              className="btn-secondary"
              disabled={!completed || trackState === "saving"}
              onClick={() => void startTracking()}
            >
              Start tracking
            </button>
            <button type="button" className="btn-secondary" onClick={() => setConfirmTrack(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export function TopRecommendations({
  recommendations,
  groupCount,
  pipelineIsIncomplete = false,
  freshness,
  entering = false,
  onEffectMutated,
}: TopRecommendationsProps) {
  const load: SectionLoad =
    freshness?.status === "recomputing"
      ? { kind: "refreshing", asOf: freshness.inputs_as_of }
      : null;
  // L6: a card whose net headline is exactly $0 (fully overlapped or stale) must not take a
  // top-3 slot from a rec with real allocated $.
  const top = recommendations
    .filter((rec) => isQuantified(rec) && rec.allocated_u_per_wk !== 0)
    .slice(0, 3);
  const bounds = meterBounds;
  const scale = Math.max(0, ...top.map((rec) => bounds(rec)?.[1] ?? 0));
  const combinedLow = top.reduce((sum, rec) => sum + (bounds(rec)?.[0] ?? 0), 0);
  const combinedHigh = top.reduce((sum, rec) => sum + (bounds(rec)?.[1] ?? 0), 0);
  return (
    <section className="sec" aria-labelledby="top-recommendations-title">
      <div className="sec-h">
        <h2 id="top-recommendations-title">
          <a href="#/recommendations">Top Usage Recommendations</a>
        </h2>
        <span className="desc">
          <SectionStatus load={load} />
          <a href="#/recommendations">
            All {recommendations.length} recommendations
            {groupCount !== undefined && ` (${groupCount} groups)`} →
          </a>
          {pipelineIsIncomplete && <PartialBadge variant="may-change" />}
        </span>
      </div>
      <div
        className={`card overview-top-recs section-frame${entering ? " section-enter" : ""}`}
        data-testid="overview-decision"
      >
        <SectionEdge load={load} />
        {top.length === 0 ? (
          <p className="card-padded">
            <a href="#/recommendations">No active recommendations</a>
          </p>
        ) : (
          <>
            {top.map((rec, index) => (
              <RecommendationRow
                key={rec.rec_id}
                rec={rec}
                rank={index + 1}
                scale={scale}
                onEffectMutated={onEffectMutated}
              />
            ))}
            <footer className="overview-top-rec-footer" style={rowVar(top.length)}>
              <span>
                Bars share one $0–{wholeDollars(scale)}/wk scale · solid = point estimate, faded =
                modeled range{" "}
                <InfoTip
                  label="About the savings scale"
                  content="All bars use the same weekly savings scale, colored by category. Longer bars indicate greater modeled potential; review each recommendation before acting."
                />
              </span>
              <span>
                Top {top.length} combined: {wholeDollars(combinedLow)}–{wholeDollars(combinedHigh)}
                /wk
              </span>
            </footer>
          </>
        )}
      </div>
    </section>
  );
}

/** One bone; `--row` staggers its shimmer. */
function Bone({ row, style }: { row: number; style: CSSProperties }) {
  return <span className="skeleton-on-card" style={{ ...rowVar(row), ...style }} />;
}

const TITLE_WIDTHS = ["64%", "52%", "58%"];
const SUMMARY_WIDTHS = ["82%", "74%", "68%"];

/**
 * The section while `top_recs` is pending: content-shaped bones on the real row grid, and (once a
 * build has run for ~1 s) a header line and top-edge line saying what it is waiting on.
 */
export function TopRecommendationsSkeleton({ load }: { load: SectionLoad }) {
  const [reserve, setReserve] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setReserve(false), RESERVE_MS);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <section
      className="sec"
      aria-busy="true"
      aria-label="Loading recommendations"
      data-section-status="pending"
    >
      <div className="sec-h">
        <h2>
          <a href="#/recommendations">Top Usage Recommendations</a>
        </h2>
        <span className="desc">
          <SectionStatus load={load} />
        </span>
      </div>
      <div
        className="card overview-top-recs section-frame"
        data-phase={reserve ? "reserve" : "skeleton"}
        data-testid="overview-decision-skeleton"
      >
        <SectionEdge load={load} />
        {[0, 1, 2].map((row) => (
          <div key={row} className="overview-top-rec-row section-skeleton-row" aria-hidden="true">
            <span className="overview-top-rec-rank">
              <Bone row={row} style={{ width: 34, height: 34, borderRadius: 10 }} />
            </span>
            <div className="section-skeleton-stack">
              <Bone row={row} style={{ width: 72, height: 18, borderRadius: 999 }} />
              <Bone row={row} style={{ width: TITLE_WIDTHS[row], height: 15 }} />
              <Bone row={row} style={{ width: SUMMARY_WIDTHS[row], height: 12 }} />
            </div>
            <div className="section-skeleton-stack">
              <Bone row={row} style={{ width: "55%", height: 10 }} />
              <Bone row={row} style={{ width: "70%", height: 20 }} />
              <Bone row={row} style={{ width: "100%", height: 6, borderRadius: 999 }} />
            </div>
            <div className="section-skeleton-actions">
              <Bone row={row} style={{ width: 118, height: 32, borderRadius: 8 }} />
              <Bone row={row} style={{ width: 64, height: 32, borderRadius: 8 }} />
            </div>
          </div>
        ))}
        <div className="overview-top-rec-footer" aria-hidden="true">
          <Bone row={0} style={{ width: 240, height: 10, animation: "none" }} />
        </div>
      </div>
    </section>
  );
}
