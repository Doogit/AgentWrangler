/**
 * src/ui/overview/CacheWriteSpikesChart.tsx — Cache-write spike timeline.
 *
 * Article framing (A1 §09): "If cache writes are large → you're missing."
 * A rising cache_creation series = alert signal for D8 CACHE_WRITE_CHURN.
 *
 * Chart: Recharts ComposedChart — stepped Area (writes) + spike scatter + threshold line.
 * Reads are intentionally NOT plotted here (they dwarf writes ~30× and flatten the axis) —
 * the reads/reuse ratio lives in the REUSE EFFICIENCY KPI instead.
 *
 * Caveats displayed (taxonomy §6):
 *   - Title: "Cache writes over time · spike = likely miss event"
 *   - ⚠ TTL 5m/1h volatile — spike threshold is TTL-sensitive
 *   - Inline note: "Rising writes vs reads signals cache misses (A1 §09 · D8 companion)"
 *
 * Claim kind: LIST_EQUIV
 */

import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CacheWriteBucketRow, CacheWriteTrend } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import Chip from "../shell/Chip";
import { SkeletonChart, useReducedMotion } from "../shell/Skeleton";
import { CustomTooltip, gridProps, seriesPalette } from "./chart-theme";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CacheWriteSpikesChartProps {
  state:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; value: ApiResponse<CacheWriteTrend> };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

function spikeThreshold(rows: CacheWriteBucketRow[]): number | null {
  if (rows.length < 3) return null;
  const vals = rows.map((r) => r.cache_creation_tokens);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return mean + 2 * Math.sqrt(variance);
}

export interface CacheWriteChartRow extends CacheWriteBucketRow {
  spike_value: number | null;
}

export function buildCacheWriteChartRows(
  buckets: CacheWriteBucketRow[],
  spikeBuckets: string[],
): CacheWriteChartRow[] {
  const spikeSet = new Set(spikeBuckets);
  return buckets.map((bucket) => ({
    ...bucket,
    spike_value: spikeSet.has(bucket.bucket) ? bucket.cache_creation_tokens : null,
  }));
}

export const SPIKE_THRESHOLD_LABEL_POSITION = "insideTopLeft" as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CacheWriteSpikesChart({ state }: CacheWriteSpikesChartProps) {
  const prefersReducedMotion = useReducedMotion();
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const isAnimationActive = !prefersReducedMotion && shouldAnimate;

  useEffect(() => {
    if (state.status === "ok" && state.value.data !== null) setShouldAnimate(false);
  }, [state]);

  // Loading
  if (state.status === "loading") {
    return (
      <div className="card" aria-busy="true" aria-label="Loading cache write spike chart">
        <SkeletonChart />
      </div>
    );
  }

  // Error
  if (state.status === "error") {
    return (
      <div className="card">
        <div className="kpi-off">N/A</div>
        <div className="kpi-off-hint">Cache write timeline unavailable</div>
      </div>
    );
  }

  const trend = state.value.data;

  if (trend === null || trend.buckets.length === 0) {
    return (
      <div className="card">
        <div className="section-head">
          <h2>Cache writes over time · spike = likely miss event</h2>
        </div>
        <div className="banner banner-info">
          <span>No cache write data in this window.</span>
        </div>
      </div>
    );
  }

  const { buckets, spike_buckets } = trend;
  const threshold = spikeThreshold(buckets);
  const chartRows = buildCacheWriteChartRows(buckets, spike_buckets);
  const hasSpikes = chartRows.some((row) => row.spike_value !== null);

  return (
    <div className="card">
      <div className="section-head">
        <h2>Cache writes over time · spike = likely miss event</h2>
        <div className="chips">
          <Chip kind="LIST_EQUIV" />
        </div>
      </div>

      {/* Inline note — required by taxonomy §6 */}
      <p className="kpi-fn" style={{ marginBottom: 4 }}>
        Rising writes vs reads signals cache misses (A1 §09 · D8 companion view)
      </p>
      <p className="kpi-fn" style={{ color: "var(--amber, #f39c12)", marginBottom: 8 }}>
        ⚠ TTL 5m/1h volatile · Spike threshold is TTL-sensitive · active TTL unknown (run /usage to
        confirm)
      </p>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartRows} margin={{ top: 4, right: 20, bottom: 4, left: 8 }}>
          <defs>
            <linearGradient id="cache-write-gradient" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={seriesPalette[1]} stopOpacity={0.24} />
              <stop offset="100%" stopColor={seriesPalette[1]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps.grid} />
          <XAxis
            dataKey="bucket"
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            tickCount={gridProps.tickCount}
            interval={gridProps.preserveStartEnd ? "preserveStartEnd" : 0}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: string) => v.slice(5)} // show MM-DD
          />
          <YAxis
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            tickFormatter={fmtTokens}
            tick={{ fontSize: 11 }}
          />
          <Tooltip
            content={
              <CustomTooltip
                labelFormatter={(label) => `Bucket: ${String(label ?? "")}`}
                nameFormatter={(name) =>
                  name === "cache_creation_tokens"
                    ? "cache writes"
                    : name === "spike_value"
                      ? "spike (miss event)"
                      : String(name ?? "Value")
                }
                valueFormatter={(value) =>
                  typeof value === "number" ? fmtTokens(value) : String(value ?? "N/A")
                }
              />
            }
          />
          <Legend
            formatter={(value: string) => {
              if (value === "cache_creation_tokens") return "cache writes";
              return value;
            }}
          />
          <Area
            dataKey="cache_creation_tokens"
            type="step"
            fill="url(#cache-write-gradient)"
            stroke={seriesPalette[1]}
            dot={false}
            isAnimationActive={isAnimationActive}
          />
          {threshold !== null && (
            <ReferenceLine
              y={threshold}
              stroke="var(--red, #e74c3c)"
              strokeDasharray="4 4"
              label={{
                value: "spike threshold",
                position: SPIKE_THRESHOLD_LABEL_POSITION,
                offset: 8,
                fontSize: 11,
              }}
            />
          )}
          {hasSpikes && (
            <Scatter
              dataKey="spike_value"
              fill={seriesPalette[4]}
              name="spike (miss event)"
              isAnimationActive={isAnimationActive}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
