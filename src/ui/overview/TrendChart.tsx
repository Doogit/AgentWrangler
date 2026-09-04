/**
 * src/ui/overview/TrendChart.tsx — Spend-over-time chart section.
 *
 * Renders two sub-views:
 *   1. Daily/weekly/monthly spend stacked by workspace (BarChart).
 *   2. Per-session cost over time (ScatterChart dot-per-session).
 *
 * Data source: GET /api/trends via fetchTrends() from the API client.
 * Claim kind: LIST_EQUIV (reconciled turns only, no provisional).
 *
 * Recharts bundled inline via Vite — no CDN (preserves the no-cloud posture).
 * All UI state follows the three-state pattern: loading | error | ok.
 */

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HeadroomTrendData } from "../../query/api/headroom-trend";
import type { TrendData } from "../../query/api/trends";
import type { ApiResponse } from "../../query/envelope";
import { fetchHeadroomTrend } from "../api/client";
import { workspaceLabel } from "../lib/workspace-label";
import Chip from "../shell/Chip";
import { SkeletonChart, useReducedMotion } from "../shell/Skeleton";
import { CustomTooltip, gridProps, seriesPalette } from "./chart-theme";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TrendChartProps {
  state:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; value: ApiResponse<TrendData> };
}

type HeadroomLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: ApiResponse<HeadroomTrendData> };

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtUsdCompact(u: number): string {
  const usd = u / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtHeadroom(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const MAX_X_AXIS_TICKS = 8;

export function xAxisInterval(pointCount: number): number {
  if (pointCount <= MAX_X_AXIS_TICKS) return 0;
  return Math.ceil(pointCount / MAX_X_AXIS_TICKS) - 1;
}

// ---------------------------------------------------------------------------
// Workspace colour palette — deterministic by index (no random, no CDN)
// ---------------------------------------------------------------------------

function colorFor(index: number): string {
  return seriesPalette[index % seriesPalette.length] ?? seriesPalette[0];
}

// ---------------------------------------------------------------------------
// Build stacked bar data from by_workspace rows
// ---------------------------------------------------------------------------

interface BarDatum {
  bucket: string;
  [workspaceId: string]: number | string;
}

function buildWorkspaceBarData(data: TrendData): {
  rows: BarDatum[];
  workspaceIds: string[];
  labelMap: Map<string, string>;
} {
  const workspaceIds: string[] = [];
  const labelMap = new Map<string, string>();

  for (const row of data.by_workspace) {
    if (!workspaceIds.includes(row.workspace_id)) {
      workspaceIds.push(row.workspace_id);
      labelMap.set(row.workspace_id, row.project_slug);
    }
  }

  // Group by bucket
  const byBucket = new Map<string, BarDatum>();
  for (const row of data.by_workspace) {
    const existing = byBucket.get(row.bucket) ?? { bucket: row.bucket };
    existing[row.workspace_id] = row.cost_equiv_u / 1_000_000; // USD
    byBucket.set(row.bucket, existing);
  }

  // Fill missing workspaces with 0 so recharts stacks cleanly
  for (const marker of data.adoption_markers) {
    if (!byBucket.has(marker.bucket)) byBucket.set(marker.bucket, { bucket: marker.bucket });
  }
  for (const datum of byBucket.values()) {
    for (const wid of workspaceIds) {
      if (datum[wid] === undefined) datum[wid] = 0;
    }
  }

  const rows = Array.from(byBucket.values()).sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  );
  return { rows, workspaceIds, labelMap };
}

// ---------------------------------------------------------------------------
// Build scatter data for per-session cost
// ---------------------------------------------------------------------------

interface ScatterDatum {
  x: string; // first_turn_at normalized to the selected trend bucket
  y: number; // cost in USD
  name: string; // tooltip label
}

function withMarkerBuckets<T extends { bucket: string }>(
  rows: T[],
  data: TrendData,
  emptyRow: (bucket: string) => T,
): T[] {
  const result = [...rows];
  const seen = new Set(result.map((row) => row.bucket));
  for (const marker of data.adoption_markers) {
    if (!seen.has(marker.bucket)) {
      result.push(emptyRow(marker.bucket));
      seen.add(marker.bucket);
    }
  }
  return result.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function bucketCoordinate(iso: string, bucket: TrendData["bucket"]): string {
  const date = new Date(iso);
  if (bucket === "month") return iso.slice(0, 7);
  if (bucket === "day") {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor(
    (Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000,
  );
  const jan1MondayIndex = (new Date(start).getUTCDay() + 6) % 7;
  const firstMonday = (7 - jan1MondayIndex) % 7;
  const week = dayOfYear < firstMonday ? 0 : 1 + Math.floor((dayOfYear - firstMonday) / 7);
  return `${year}-${pad2(week)}`;
}

export function buildSessionScatterData(data: TrendData): ScatterDatum[] {
  return [...data.sessions]
    .sort((a, b) => {
      const byDate = a.first_turn_at.localeCompare(b.first_turn_at);
      return byDate || a.session_id.localeCompare(b.session_id);
    })
    .map((s) => ({
      x: bucketCoordinate(s.first_turn_at, data.bucket),
      y: s.cost_equiv_u / 1_000_000,
      name: s.project_slug,
    }));
}

export function markerLabel(lever: string): string {
  const label = lever.trim() || "Recommendation adopted";
  return label.length <= 36 ? label : `${label.slice(0, 33)}...`;
}

function adoptionReferenceLines(data: TrendData) {
  return (data.adoption_markers ?? []).map((marker) => (
    <ReferenceLine
      key={`${marker.rec_id}-${marker.adopted_at}`}
      x={marker.bucket}
      ifOverflow="extendDomain"
      stroke="var(--amber, #f59e0b)"
      strokeDasharray="4 3"
      label={{
        value: markerLabel(marker.lever),
        position: "insideTopRight",
        fill: "var(--amber, #f59e0b)",
        fontSize: 10,
      }}
    />
  ));
}

function HeadroomPanel({
  state,
  isAnimationActive,
}: {
  state: HeadroomLoadState;
  isAnimationActive: boolean;
}) {
  if (state.status === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading headroom trend" style={{ marginTop: 20 }}>
        <p className="kpi-fn">Headroom vs cap over time</p>
        <SkeletonChart height={210} />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="banner banner-error" role="alert" style={{ marginTop: 20 }}>
        <span>Headroom trend unavailable - {state.message}</span>
      </div>
    );
  }

  if (state.status !== "ok" || state.value.data === null) return null;
  const data = state.value.data;

  if (data.state === "NO_LIMIT") {
    return (
      <div className="banner banner-info" data-testid="headroom-no-limit" style={{ marginTop: 20 }}>
        <span>Headroom trend is off - calibrate first in Settings.</span>
      </div>
    );
  }

  if (data.points.length === 0) {
    return (
      <div className="banner banner-info" style={{ marginTop: 20 }}>
        <span>No headroom data in this window.</span>
      </div>
    );
  }

  return (
    <div data-testid="headroom-trend-panel" style={{ marginTop: 20 }}>
      <p className="kpi-fn" style={{ marginBottom: 4 }}>
        Headroom vs cap per {data.bucket} - percent-native
      </p>
      <div className="kpi-fn" style={{ marginBottom: 4, opacity: 0.85 }}>
        <span style={{ color: "var(--teal, #2dd4bf)", marginRight: 16 }}>
          0.1x headline - unverified cap coefficient
        </span>
        <span style={{ color: "var(--amber, #f59e0b)" }}>
          1.0x upper-bound - unverified cap coefficient
        </span>
      </div>
      <p className="kpi-fn" style={{ marginBottom: 8, opacity: 0.75 }}>
        Percent-native headroom has no absolute-cap denominator; negative values mean the limit was
        exceeded.
      </p>
      <ResponsiveContainer width="100%" height={210}>
        <LineChart data={data.points} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
          <CartesianGrid {...gridProps.grid} />
          <XAxis
            dataKey="bucket"
            interval={
              gridProps.preserveStartEnd ? "preserveStartEnd" : xAxisInterval(data.points.length)
            }
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            tickCount={gridProps.tickCount}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            axisLine={gridProps.axisLine}
            tickLine={gridProps.tickLine}
            tickFormatter={(v: number) => fmtHeadroom(v)}
            tick={{ fontSize: 11 }}
            width={60}
          />
          <Tooltip
            content={
              <CustomTooltip
                valueFormatter={(v) =>
                  typeof v === "number" ? fmtHeadroom(v) : String(v ?? "N/A")
                }
              />
            }
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="headroom_headline"
            name="0.1x headline"
            stroke={seriesPalette[0]}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={isAnimationActive}
          />
          <Line
            type="monotone"
            dataKey="headroom_upper"
            name="1.0x upper-bound"
            stroke={seriesPalette[1]}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={isAnimationActive}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function TrendChart({ state }: TrendChartProps) {
  const [headroomState, setHeadroomState] = useState<HeadroomLoadState>({ status: "idle" });
  const prefersReducedMotion = useReducedMotion();
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const isAnimationActive = !prefersReducedMotion && shouldAnimate;

  useEffect(() => {
    if (state.status === "ok" && state.value.data !== null) setShouldAnimate(false);
  }, [state]);

  useEffect(() => {
    if (state.status !== "ok" || state.value.data === null) {
      setHeadroomState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setHeadroomState((current) => (current.status === "ok" ? current : { status: "loading" }));
    const { from, to } = state.value.meta.window;
    const request = fetchHeadroomTrend({ from, to }, state.value.data.bucket);

    void request
      .then((value) => {
        if (!cancelled) setHeadroomState({ status: "ok", value });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHeadroomState({ status: "error", message: String(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [state]);

  return (
    <div className="card" style={{ marginBottom: 13 }}>
      <div className="section-head">
        <h2>Spend Over Time</h2>
        <div className="chips">
          <Chip kind="LIST_EQUIV" />
        </div>
      </div>

      {state.status === "loading" && (
        <div aria-busy="true" aria-label="Loading trend data">
          <SkeletonChart />
        </div>
      )}

      {state.status === "error" && (
        <div className="banner banner-error" role="alert">
          <span>Trend data unavailable — {state.message}</span>
        </div>
      )}

      {state.status === "ok" && state.value.data !== null && (
        <TrendChartInner
          data={state.value.data}
          headroomState={headroomState}
          isAnimationActive={isAnimationActive}
        />
      )}

      {state.status === "ok" && state.value.data === null && (
        <div className="banner banner-info">
          <span>No spend data in this window.</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner component (only rendered when data is present)
// ---------------------------------------------------------------------------

function TrendChartInner({
  data,
  headroomState,
  isAnimationActive,
}: {
  data: TrendData;
  headroomState: HeadroomLoadState;
  isAnimationActive: boolean;
}) {
  const { rows, workspaceIds, labelMap } = buildWorkspaceBarData(data);
  const scatterData = buildSessionScatterData(data);
  const markerScatterData: ScatterDatum[] = data.adoption_markers.map((marker) => ({
    x: marker.bucket,
    y: 0,
    name: "",
  }));
  // Tick thinning must reflect the session-cost scatter's own density only.
  // Adoption markers are sparse annotations at arbitrary buckets; pooling their
  // x-values inflated the distinct-x count and over-thinned the session ticks.
  const scatterTickCount = new Set(scatterData.map((row) => row.x)).size;

  // Fall back to total-only bar chart if by_workspace is empty (workspace-scoped query)
  const useTotalBars = workspaceIds.length === 0;
  const totalBarData = useTotalBars
    ? withMarkerBuckets(
        data.buckets.map((b) => ({ bucket: b.bucket, cost: b.cost_equiv_u / 1_000_000 })),
        data,
        (bucket) => ({ bucket, cost: 0 }),
      )
    : [];
  const capWeightedData = withMarkerBuckets(data.cap_weighted, data, (bucket) => ({
    bucket,
    cap_weighted_tokens: 0,
    turns: 0,
  }));

  const hasData = rows.length > 0 || totalBarData.length > 0;
  const showSessionChart = scatterData.length > 0 || markerScatterData.length > 0;
  const showCapWeightedChart = capWeightedData.length > 0;

  const showHeadroomPanel = headroomState.status !== "idle";
  if (!hasData && !showSessionChart) {
    return (
      <div>
        <div className="banner banner-info">
          <span>No spend data in this window.</span>
        </div>
        {showHeadroomPanel && (
          <HeadroomPanel state={headroomState} isAnimationActive={isAnimationActive} />
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Bar chart — spend per bucket */}
      {data.adoption_markers.length > 0 && (
        <div className="kpi-fn" aria-label="Adoption markers" style={{ marginBottom: 8 }}>
          {data.adoption_markers.map((marker) => (
            <span key={marker.rec_id} style={{ marginRight: 12, color: "var(--amber, #f59e0b)" }}>
              <span
                title={marker.lever.trim() || "Recommendation adopted"}
                style={{
                  display: "inline-block",
                  maxWidth: "36ch",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  verticalAlign: "bottom",
                }}
              >
                {markerLabel(marker.lever)}
              </span>{" "}
              · {marker.bucket}
            </span>
          ))}
        </div>
      )}
      {hasData && (
        <div style={{ marginBottom: 20 }}>
          <p className="kpi-fn" style={{ marginBottom: 8 }}>
            Spend by {data.bucket} · stacked by workspace
          </p>
          <ResponsiveContainer width="100%" height={220}>
            {useTotalBars ? (
              <BarChart data={totalBarData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid {...gridProps.grid} />
                <XAxis
                  dataKey="bucket"
                  interval={
                    gridProps.preserveStartEnd
                      ? "preserveStartEnd"
                      : xAxisInterval(totalBarData.length)
                  }
                  axisLine={gridProps.axisLine}
                  tickLine={gridProps.tickLine}
                  tickCount={gridProps.tickCount}
                  tick={{ fontSize: 11 }}
                />
                {adoptionReferenceLines(data)}
                <YAxis
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  axisLine={gridProps.axisLine}
                  tickLine={gridProps.tickLine}
                  tick={{ fontSize: 11 }}
                  width={60}
                />
                <Tooltip
                  content={
                    <CustomTooltip
                      valueFormatter={(v) =>
                        typeof v === "number" ? fmtUsdCompact(v * 1_000_000) : String(v ?? "N/A")
                      }
                    />
                  }
                />
                <Bar
                  dataKey="cost"
                  name="Spend"
                  fill={colorFor(0)}
                  isAnimationActive={isAnimationActive}
                />
              </BarChart>
            ) : (
              <BarChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid {...gridProps.grid} />
                <XAxis
                  dataKey="bucket"
                  interval={
                    gridProps.preserveStartEnd ? "preserveStartEnd" : xAxisInterval(rows.length)
                  }
                  axisLine={gridProps.axisLine}
                  tickLine={gridProps.tickLine}
                  tickCount={gridProps.tickCount}
                  tick={{ fontSize: 11 }}
                />
                {adoptionReferenceLines(data)}
                <YAxis
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  axisLine={gridProps.axisLine}
                  tickLine={gridProps.tickLine}
                  tick={{ fontSize: 11 }}
                  width={60}
                />
                <Tooltip
                  content={
                    <CustomTooltip
                      valueFormatter={(v) =>
                        typeof v === "number" ? `$${v.toFixed(4)}` : String(v ?? "N/A")
                      }
                    />
                  }
                />
                <Legend
                  formatter={(value: string) =>
                    workspaceLabel({ workspace_id: value, repo_path: labelMap.get(value) ?? null })
                  }
                />
                {workspaceIds.map((wid, i) => (
                  <Bar
                    key={wid}
                    dataKey={wid}
                    stackId="a"
                    fill={colorFor(i)}
                    name={workspaceLabel({
                      workspace_id: wid,
                      repo_path: labelMap.get(wid) ?? null,
                    })}
                    isAnimationActive={isAnimationActive}
                  />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}

      {/* Scatter chart — per-session cost over time */}
      {showSessionChart && (
        <div>
          <p className="kpi-fn" style={{ marginBottom: 8 }}>
            Session cost over time · each dot = one reconciled session
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <ScatterChart margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid {...gridProps.grid} />
              <XAxis
                dataKey="x"
                type="category"
                interval={
                  gridProps.preserveStartEnd ? "preserveStartEnd" : xAxisInterval(scatterTickCount)
                }
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                tickCount={gridProps.tickCount}
                tickFormatter={(value: string) => value.slice(5)}
                tick={{ fontSize: 11 }}
                name="Date"
              />
              {adoptionReferenceLines(data)}
              <YAxis
                dataKey="y"
                type="number"
                tickFormatter={(v: number) => `$${v.toFixed(3)}`}
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                tick={{ fontSize: 11 }}
                width={60}
                name="Cost"
              />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={
                  <CustomTooltip
                    valueFormatter={(v) =>
                      typeof v === "number" ? fmtUsdCompact(v * 1_000_000) : String(v ?? "N/A")
                    }
                  />
                }
              />
              <Scatter
                data={scatterData}
                fill={colorFor(0)}
                name="Session cost"
                isAnimationActive={isAnimationActive}
              />
              <Scatter
                data={markerScatterData}
                fillOpacity={0}
                strokeOpacity={0}
                isAnimationActive={false}
                legendType="none"
                name="Adoption marker domain"
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cap-weighted token bar chart — cap draw estimate, alongside the $ chart */}
      {showCapWeightedChart && (
        <div style={{ marginTop: 20 }}>
          <p className="kpi-fn" style={{ marginBottom: 4 }}>
            Cap-weighted tokens per {data.bucket} · estimated cap draw
          </p>
          <p className="kpi-fn" style={{ marginBottom: 8, opacity: 0.75 }}>
            {`Cap-weighted (COEFF=${data.cap_read_coeff}× cache reads) — unverified: Anthropic has not published a cap coefficient.`}
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={capWeightedData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid {...gridProps.grid} />
              <XAxis
                dataKey="bucket"
                interval={
                  gridProps.preserveStartEnd
                    ? "preserveStartEnd"
                    : xAxisInterval(capWeightedData.length)
                }
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                tickCount={gridProps.tickCount}
                tick={{ fontSize: 11 }}
              />
              {adoptionReferenceLines(data)}
              <YAxis
                axisLine={gridProps.axisLine}
                tickLine={gridProps.tickLine}
                tickFormatter={fmtTokensCompact}
                tick={{ fontSize: 11 }}
                width={60}
              />
              <Tooltip
                content={
                  <CustomTooltip
                    valueFormatter={(v) =>
                      typeof v === "number" ? fmtTokensCompact(v) : String(v ?? "N/A")
                    }
                  />
                }
              />
              <Bar
                dataKey="cap_weighted_tokens"
                name="Cap-weighted tokens"
                fill={colorFor(2)}
                isAnimationActive={isAnimationActive}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {showHeadroomPanel && (
        <HeadroomPanel state={headroomState} isAnimationActive={isAnimationActive} />
      )}
    </div>
  );
}
