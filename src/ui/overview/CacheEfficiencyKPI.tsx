/**
 * Selected-window cache reuse diagnostic and cap-weighted draw.
 * Raw cache-read share is intentionally presented as diagnostic only, not a health signal.
 */

import type { BurnForecast } from "../../query/api/overview";
import type { CacheEfficiency, CacheReuseBand } from "../../query/api/spend-flavor";
import type { ApiResponse } from "../../query/envelope";
import Chip from "../shell/Chip";
import { SkeletonKpi } from "../shell/Skeleton";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CacheEfficiencyKPIProps {
  state:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ok"; value: ApiResponse<CacheEfficiency> };
  forecast?: BurnForecast | null;
}

// ---------------------------------------------------------------------------
// Signal colours
// ---------------------------------------------------------------------------

const BAND_COLOR: Record<CacheReuseBand, string> = {
  NO_DATA: "var(--muted, #888)",
  NO_DENOMINATOR: "var(--muted, #888)",
  WRITE_HEAVY: "var(--amber, #f39c12)",
  MIXED_REUSE: "var(--accent, #5bc0de)",
  REUSE_DOMINANT: "var(--green, #2ecc71)",
};

const BAND_LABEL: Record<CacheReuseBand, string> = {
  NO_DATA: "NO DATA",
  NO_DENOMINATOR: "NO DENOMINATOR",
  WRITE_HEAVY: "WRITE HEAVY",
  MIXED_REUSE: "MIXED REUSE",
  REUSE_DOMINANT: "REUSE DOMINANT",
};

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function fmtTokensCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CacheEfficiencyKPI({ state, forecast = null }: CacheEfficiencyKPIProps) {
  // Loading
  if (state.status === "loading") {
    return (
      <div className="kpi card" aria-busy="true" aria-label="Loading reuse efficiency">
        <SkeletonKpi />
      </div>
    );
  }

  // Error
  if (state.status === "error") {
    return (
      <div className="kpi card">
        <div className="kpi-label">REUSE EFFICIENCY</div>
        <div className="kpi-off">N/A</div>
        <div className="kpi-off-hint">Reuse efficiency unavailable</div>
      </div>
    );
  }

  const eff = state.value.data;

  if (eff === null || eff.turns === 0) {
    return (
      <div className="kpi card">
        <div className="kpi-label">REUSE EFFICIENCY</div>
        <div className="kpi-off">N/A</div>
        <div className="kpi-off-hint">No reconciled turns in this selected window.</div>
        <div className="chips">
          <Chip kind="N_A" />
        </div>
      </div>
    );
  }

  const rawShare = eff.ratio === null ? "—" : `${(eff.ratio * 100).toFixed(1)}%`;
  const readToCreation =
    eff.cache_creation_tokens === 0
      ? "—"
      : `${(eff.cache_read_tokens / eff.cache_creation_tokens).toFixed(1)}×`;
  const color = BAND_COLOR[eff.reuse_band];
  const label = BAND_LABEL[eff.reuse_band];

  return (
    <div className="kpi card">
      <div className="kpi-label">REUSE EFFICIENCY</div>
      <div className="kpi-value" style={{ color }}>
        {readToCreation}
        <span style={{ fontSize: "0.55em", marginLeft: 8, color }}>— {label}</span>
      </div>
      <div className="kpi-subval" style={{ marginTop: 4 }}>
        cache read : creation · {fmtTokensCompact(eff.cache_read_tokens)} :{" "}
        {fmtTokensCompact(eff.cache_creation_tokens)}
      </div>
      <div className="kpi-fn" style={{ marginTop: 4 }}>
        Raw cache-read share: {rawShare} · diagnostic only · not a health signal
      </div>
      <div className="kpi-subval" style={{ marginTop: 6 }}>
        Cap-weighted draw: {fmtTokensCompact(eff.cap_weighted_tokens)}
      </div>
      <div className="kpi-fn" style={{ marginTop: 4 }}>
        coefficient {eff.coeff_used}× unverified · selected window excludes provisional turns
      </div>
      {eff.cache_creation_tokens > 0 && (
        <div className="kpi-fn" style={{ color: "var(--amber, #f39c12)", marginTop: 4 }}>
          ⚠ TTL 5m/1h volatile · active TTL unknown (run /usage to confirm)
        </div>
      )}
      <div className="kpi-fn" style={{ marginTop: 4 }}>
        Separate limit-relative context: Burn Forecast is trailing 1-day and provisional-inclusive
        {forecast !== null ? ` (${forecast.state.replaceAll("_", " ")}).` : "."}
      </div>

      <div className="chips" style={{ marginTop: 6 }}>
        <Chip kind="LIST_EQUIV" />
      </div>
    </div>
  );
}
