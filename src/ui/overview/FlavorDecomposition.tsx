/**
 * src/ui/overview/FlavorDecomposition.tsx — Token-flavor breakdown chart.
 *
 * Section: "Where your tokens go · weight per type" (taxonomy §1a)
 * Chart: Horizontal Recharts BarChart — one bar per flavor, showing cap-proxy-weighted
 * or raw token counts (toggle). The weighted view uses the cap-proxy contract.
 *
 * Caveats displayed (taxonomy §6):
 *   - ⚠ cap coefficient unverified · defaulting to 0.1× (weighted mode only)
 *   - Myth note: "Trimming a cached prompt saves ~10× less than you think..."
 *
 * Claim kind: PROXY
 */

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FlavorDecomposition as FlavorDecompositionData } from "../../query/api/spend-flavor";
import type { ApiResponse } from "../../query/envelope";
import Chip from "../shell/Chip";
import { SkeletonChart, useReducedMotion } from "../shell/Skeleton";
import { CustomTooltip, gridProps, seriesPalette } from "./chart-theme";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlavorDecompositionProps {
  state:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; value: ApiResponse<FlavorDecompositionData> };
}

type Mode = "weighted" | "raw";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

// Y-axis labels with the active cap-proxy weight.
const Y_AXIS_LABELS: Record<string, string> = {
  fresh_input: "fresh input · 1×",
  output: "output · 1×",
  cache_write_5m: "cache write (5 min) · 1×",
  cache_write_1h: "cache write (1 hr) · 1×",
  cache_write_other: "cache write (unspecified) · 1×",
};

function fmtCoeff(coeff: number): string {
  return coeff.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function axisLabel(flavor: string, fallback: string, coeff: number): string {
  if (flavor === "cache_read") return `cache read · ${fmtCoeff(coeff)}× ⚠`;
  return Y_AXIS_LABELS[flavor] ?? fallback;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FlavorDecomposition({ state }: FlavorDecompositionProps) {
  const [mode, setMode] = useState<Mode>("weighted");
  const prefersReducedMotion = useReducedMotion();
  const [isAnimationActive] = useState(() => !prefersReducedMotion);

  // Loading
  if (state.status === "loading") {
    return (
      <div className="card" aria-busy="true" aria-label="Loading flavor decomposition">
        <SkeletonChart />
      </div>
    );
  }

  // Error
  if (state.status === "error") {
    return (
      <div className="card">
        <div className="kpi-off">N/A</div>
        <div className="kpi-off-hint">Flavor decomposition unavailable</div>
      </div>
    );
  }

  const decomp = state.value.data;

  // Null / no data
  if (decomp === null || decomp.turns === 0) {
    return (
      <div className="card">
        <div className="kpi-label">Where your tokens go · weight per type</div>
        <div className="kpi-off">N/A</div>
        <div className="kpi-off-hint">No reconciled turns in this window.</div>
      </div>
    );
  }

  // Recharts-friendly data with Y-axis label
  const chartData = decomp.flavors.map((f) => ({
    label: axisLabel(f.flavor, f.label, decomp.coeff_used),
    flavor: f.flavor,
    weighted_tokens: Math.round(f.weighted_tokens),
    raw_tokens: f.raw_tokens,
    weighted_share: f.weighted_share,
    raw_share: f.raw_share,
  }));

  const dataKey = mode === "weighted" ? "weighted_tokens" : "raw_tokens";
  const shareKey = mode === "weighted" ? "weighted_share" : "raw_share";

  return (
    <div className="card">
      {/* Section heading */}
      <div className="section-head">
        <h2>Where your tokens go · weight per type</h2>
        <div className="chips">
          <Chip kind="PROXY" />
        </div>
      </div>

      {/* Toggle */}
      <div
        style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}
      >
        <button
          type="button"
          className={`date-preset-btn${mode === "weighted" ? " active" : ""}`}
          onClick={() => setMode("weighted")}
          aria-pressed={mode === "weighted"}
        >
          Cap-proxy weighted
        </button>
        <button
          type="button"
          className={`date-preset-btn${mode === "raw" ? " active" : ""}`}
          onClick={() => setMode("raw")}
          aria-pressed={mode === "raw"}
        >
          Raw tokens
        </button>
        {mode === "weighted" && (
          <span className="kpi-fn" style={{ color: "var(--amber)" }}>
            ⚠ cap coefficient unverified · using {fmtCoeff(decomp.coeff_used)}×
          </span>
        )}
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ top: 4, right: 80, bottom: 4, left: 8 }}
        >
          <CartesianGrid {...gridProps.grid} />
          <XAxis
            type="number"
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            tickCount={gridProps.tickCount}
            interval={gridProps.preserveStartEnd ? "preserveStartEnd" : 0}
            tickFormatter={fmtTokens}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            type="category"
            dataKey="label"
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            width={190}
            tick={{ fontSize: 11 }}
          />
          <Tooltip
            content={
              <CustomTooltip
                nameFormatter={() => (mode === "weighted" ? "cap-proxy tokens" : "raw tokens")}
                valueFormatter={(value) =>
                  typeof value === "number" ? fmtTokens(value) : String(value ?? "N/A")
                }
              />
            }
          />
          <Bar
            dataKey={dataKey}
            fill={seriesPalette[0]}
            radius={[0, 3, 3, 0]}
            isAnimationActive={isAnimationActive}
          >
            <LabelList
              dataKey={shareKey}
              position="right"
              formatter={(v) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "")}
              style={{ fontSize: 11 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Myth note — required by taxonomy §7 / A1 Diagram E §05 */}
      <p className="kpi-fn" style={{ marginTop: 8, fontStyle: "italic" }}>
        Trimming a cached prompt saves ~10× less than you think. Cache misses are where the real
        savings are.
      </p>
    </div>
  );
}
