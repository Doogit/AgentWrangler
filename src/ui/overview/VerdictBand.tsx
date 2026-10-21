/**
 * Primary, selected-window verdict for the Overview surface.
 * Uses the same reconciled spend trend supplied to the chart below; no new API
 * contract is introduced here.
 */

import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { RecommendationCard } from "../../query/api/recommendations";
import type { TrendData } from "../../query/api/trends";

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

function fmtCompact(microUsd: number): string {
  const usd = microUsd / 1_000_000;
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

export function TrendSparkline({ values, label }: { values: number[]; label: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length < 2) return <span className="trend-sparkline-empty">Trend unavailable</span>;

  const max = Math.max(...usable);
  const min = Math.min(...usable);
  const range = max - min || 1;

  const pts = usable.map((value, index) => ({
    x: (index / (usable.length - 1)) * 100,
    y: 28 - ((value - min) / range) * 24,
    v: value,
  }));
  const polyPoints = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const last = pts[pts.length - 1];
  if (last === undefined) return <span className="trend-sparkline-empty">Trend unavailable</span>;

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(
      0,
      Math.min(usable.length - 1, Math.round(fraction * (usable.length - 1))),
    );
    setHoverIndex(idx);
  }

  const hovered = hoverIndex !== null ? usable[hoverIndex] : null;
  const hoverPt = hoverIndex !== null ? pts[hoverIndex] : null;

  return (
    <div className="trend-sparkline-wrap">
      <span className="trend-sparkline-axis-label trend-sparkline-axis-min" aria-hidden="true">
        {fmtCompact(min)}
      </span>
      <div className="trend-sparkline-svg-wrap">
        <svg
          ref={svgRef}
          className="trend-sparkline"
          viewBox="0 0 100 32"
          role="img"
          aria-label={label}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <polyline
            points={polyPoints}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={last.x}
            cy={last.y}
            r="3"
            fill="currentColor"
            vectorEffect="non-scaling-stroke"
          />
          {hoverPt !== null && hoverPt !== undefined && hoverIndex !== usable.length - 1 && (
            <circle
              cx={hoverPt.x}
              cy={hoverPt.y}
              r="3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {hovered !== null && hovered !== undefined && (
          <span className="trend-sparkline-hover-val" aria-live="polite">
            {fmtCompact(hovered)}
          </span>
        )}
      </div>
      <span className="trend-sparkline-axis-label trend-sparkline-axis-max" aria-hidden="true">
        {fmtCompact(max)}
      </span>
    </div>
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
  /** Retained for existing callers; recommendation presentation lives in OverviewPage. */
  topRecommendation?: RecommendationCard | null;
}

export default function VerdictBand({ preset, trend, priorTrend, isLoading }: VerdictBandProps) {
  const currentTotal = trendTotal(trend);
  const priorTotal = trendTotal(priorTrend);
  const delta = windowDelta(currentTotal, priorTotal);
  const values = trend?.buckets.map((bucket) => bucket.cost_equiv_u) ?? [];

  return (
    <section
      className="verdict-band card"
      aria-labelledby="verdict-band-title"
      aria-busy={isLoading}
    >
      <div className="verdict-band-grid">
        <div className="verdict-band-summary">
          <div>
            <div className="verdict-band-label" id="verdict-band-title">
              Usage this period
            </div>
            <CountUpValue value={currentTotal} />
            <div className="verdict-band-caption">{preset.toUpperCase()} list-price equivalent</div>
          </div>
          {/* While either window is still loading, withhold the delta — showing
              "Prior window unavailable" before the prior fetch resolves causes a
              visible flip to the real "% vs prior" once it lands (UIC-3a/O4). */}
          {!isLoading && <DeltaBadge delta={delta} />}
        </div>
        <div className="verdict-band-trend">
          {isLoading ? (
            <span className="trend-sparkline-empty">Loading trend…</span>
          ) : (
            <TrendSparkline values={values} label={`${preset} spend trend`} />
          )}
          <span>Selected-window spend trend</span>
        </div>
      </div>
    </section>
  );
}
