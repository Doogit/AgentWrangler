/**
 * Primary, selected-window verdict for the Overview surface.
 * Uses the same reconciled spend trend supplied to the chart below; no new API
 * contract is introduced here.
 */

import { useEffect, useRef, useState } from "react";
import type { RecommendationCard } from "../../query/api/recommendations";
import type { TrendData } from "../../query/api/trends";
import { buildPromptArtifact } from "../recommendations/prompt-templates";

export interface WindowDelta {
  direction: "up" | "down" | "flat" | "new" | "unavailable";
  label: string;
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString("en-US");
}

/**
 * A short, honest measured claim for the top recommendation — the concrete
 * quantity the detector observed, not a dollar figure (which would overstate
 * cache-read exposure ~10×). Falls back to modeled savings, then null.
 */
function topRecClaim(rec: RecommendationCard): string | null {
  const num = (key: string): number | null => {
    const value = rec.evidence[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const source = num("source_tokens");
  const target = num("source_target");
  if (source !== null && target !== null)
    return `${fmtTokens(source)} always-loaded vs ${fmtTokens(target)} target`;
  const delta = num("delta_context_tokens");
  if (delta !== null) return `−${fmtTokens(delta)} tokens/turn`;
  if (rec.modeled_savings_u_per_wk !== null && rec.detector_id !== "D4")
    return `${formatUsd(rec.modeled_savings_u_per_wk)}/wk modeled`;
  return null;
}

function trendTotal(data: TrendData | null): number | null {
  if (data === null) return null;
  return data.buckets.reduce((total, bucket) => total + bucket.cost_equiv_u, 0);
}

export function windowDelta(current: number | null, previous: number | null): WindowDelta {
  if (current === null || previous === null)
    return { direction: "unavailable", label: "Prior window unavailable" };
  if (previous === 0 && current === 0) return { direction: "flat", label: "No change vs prior" };
  if (previous === 0) return { direction: "new", label: "New spend vs prior" };

  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { direction: "flat", label: "No material change vs prior" };
  const pct = `${Math.abs(change * 100).toFixed(1)}%`;
  return change > 0
    ? { direction: "up", label: `${pct} higher vs prior` }
    : { direction: "down", label: `${pct} lower vs prior` };
}

export function DeltaBadge({ delta }: { delta: WindowDelta }) {
  return <span className={`window-delta window-delta-${delta.direction}`}>{delta.label}</span>;
}

export function TrendSparkline({ values, label }: { values: number[]; label: string }) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length < 2) return <span className="trend-sparkline-empty">Trend unavailable</span>;

  const max = Math.max(...usable);
  const min = Math.min(...usable);
  const range = max - min || 1;
  const points = usable
    .map(
      (value, index) =>
        `${(index / (usable.length - 1)) * 100},${28 - ((value - min) / range) * 24}`,
    )
    .join(" ");

  return (
    <svg
      className="trend-sparkline"
      viewBox="0 0 100 32"
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CountUpValue({ value }: { value: number | null }) {
  const [display, setDisplay] = useState(value ?? 0);
  const previous = useRef(value ?? 0);

  useEffect(() => {
    if (value === null) return;
    const from = previous.current;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min((now - startedAt) / 560, 1);
      setDisplay(from + (value - from) * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else previous.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <div className="verdict-band-value">{value === null ? "—" : formatUsd(display)}</div>;
}

interface VerdictBandProps {
  preset: string;
  trend: TrendData | null;
  priorTrend: TrendData | null;
  isLoading: boolean;
  topRecommendation: RecommendationCard | null;
}

export default function VerdictBand({
  preset,
  trend,
  priorTrend,
  isLoading,
  topRecommendation,
}: VerdictBandProps) {
  const currentTotal = trendTotal(trend);
  const priorTotal = trendTotal(priorTrend);
  const delta = windowDelta(currentTotal, priorTotal);
  const values = trend?.buckets.map((bucket) => bucket.cost_equiv_u) ?? [];
  const wasteSource =
    topRecommendation?.title ?? topRecommendation?.lever ?? "No active waste source detected";
  const claim = topRecommendation === null ? null : topRecClaim(topRecommendation);
  const promptArtifact = topRecommendation === null ? null : buildPromptArtifact(topRecommendation);
  const focusHref =
    topRecommendation === null
      ? "#/recommendations"
      : `#/recommendations?focus=${encodeURIComponent(topRecommendation.rec_id)}`;
  const [promptCopied, setPromptCopied] = useState(false);

  function handleCopyPrompt() {
    if (promptArtifact === null) return;
    void navigator.clipboard.writeText(promptArtifact.text).then(() => {
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    });
  }

  return (
    <section
      className="verdict-band card"
      aria-labelledby="verdict-band-title"
      aria-busy={isLoading}
    >
      <div className="verdict-band-summary">
        <div>
          <div className="verdict-band-label" id="verdict-band-title">
            AT-A-GLANCE VERDICT
          </div>
          <CountUpValue value={currentTotal} />
          <div className="verdict-band-caption">{preset.toUpperCase()} list-price equivalent</div>
        </div>
        <DeltaBadge delta={delta} />
      </div>
      <div className="verdict-band-trend">
        <TrendSparkline values={values} label={`${preset} spend trend`} />
        <span>Selected-window spend trend</span>
      </div>
      <div className="verdict-band-detail">
        <strong>Top waste source:</strong> {wasteSource}
        {claim !== null && <span className="verdict-band-claim"> · {claim}</span>}
      </div>
      <div className="verdict-band-actions">
        {promptArtifact !== null && (
          <button type="button" className="verdict-band-copy" onClick={handleCopyPrompt}>
            {promptCopied ? "Copied ✓" : "Copy fix prompt"}
          </button>
        )}
        <a className="verdict-band-action" href={focusHref}>
          {topRecommendation === null ? "Review recommendations →" : "Open rec →"}
        </a>
      </div>
    </section>
  );
}
