/**
 * src/ui/overview/RateLimitGauges.tsx — Live 5h/7d rate-limit utilization bars.
 *
 * Renders two progress gauges from GET /api/burn-status (O9 OAuth reader).
 * Thresholds: green < 60%, amber 60–85%, red ≥ 85%.
 * Signed-out / unavailable: honest empty state with Settings pointer.
 * Never invents a number.
 */

import type { BurnStatus } from "../../query/api/burn-status";
import InfoTip from "../shell/InfoTip";

interface Props {
  burnStatus: BurnStatus | null;
  isLoading: boolean;
}

type Band = "green" | "amber" | "red";

function band(utilization: number): Band {
  if (utilization >= 0.85) return "red";
  if (utilization >= 0.6) return "amber";
  return "green";
}

function bandColor(b: Band): string {
  if (b === "red") return "var(--red, #e05252)";
  if (b === "amber") return "var(--amber, #d4a017)";
  return "var(--green, #3fa66b)";
}

function fmtResetTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function Gauge({
  label,
  utilization,
  resetsAt,
}: { label: string; utilization: number; resetsAt: string }) {
  const pct = Math.round(utilization * 100);
  const b = band(utilization);
  const color = bandColor(b);
  const fill = Math.min(utilization * 100, 100);

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--soft)" }}>{label}</span>
        <span
          style={{ fontSize: 13, fontWeight: 700, color }}
          aria-label={`${label} utilization ${pct}%`}
        >
          {pct}%
        </span>
      </div>
      <div
        role="progressbar"
        tabIndex={0}
        aria-label={`${label} rate-limit utilization`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        style={{
          height: 8,
          borderRadius: 4,
          background: "rgba(132,146,166,.18)",
          overflow: "hidden",
          marginBottom: 4,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: `${fill}%`,
            minWidth: fill > 0 ? 3 : 0,
            height: "100%",
            background: color,
            borderRadius: "4px 0 0 4px",
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>resets {fmtResetTime(resetsAt)}</div>
    </div>
  );
}

export default function RateLimitGauges({ burnStatus, isLoading }: Props) {
  return (
    <div className="card" data-testid="rate-limit-gauges" style={{ padding: "14px 16px" }}>
      <div style={{ marginBottom: 10, fontWeight: 700, fontSize: 13, color: "var(--soft)" }}>
        RATE LIMITS{" "}
        <InfoTip
          label="What the rate-limit gauges show"
          content="Share of your Claude usage window already consumed, green under 60% and red past 85%. Watch the 7-day bar to avoid a mid-week cutoff."
        />
      </div>

      {isLoading && (
        <div
          className="skeleton"
          style={{ height: 48, borderRadius: 6 }}
          aria-label="Loading rate-limit data"
        />
      )}

      {!isLoading && burnStatus === null && (
        <div className="kpi-off-hint" style={{ fontSize: 12 }}>
          <div>Rate-limit data unavailable.</div>
          <a href="#/settings" style={{ color: "var(--teal)" }} data-testid="gauges-calibrate-link">
            Calibrate from usage in Settings →
          </a>
        </div>
      )}

      {!isLoading && burnStatus !== null && !burnStatus.available && (
        <div style={{ fontSize: 12.5, color: "var(--soft)" }}>
          <span>Signed out — </span>
          <a href="#/settings" style={{ color: "var(--teal)" }}>
            configure OAuth in Settings
          </a>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            {burnStatus.reason ?? "Re-login to Claude Code to enable live rate-limit tracking."}
          </div>
        </div>
      )}

      {!isLoading && burnStatus?.available && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {burnStatus.five_hour && (
            <Gauge
              label="5-hour"
              utilization={burnStatus.five_hour.utilization}
              resetsAt={burnStatus.five_hour.resets_at}
            />
          )}
          {burnStatus.seven_day && (
            <Gauge
              label="7-day"
              utilization={burnStatus.seven_day.utilization}
              resetsAt={burnStatus.seven_day.resets_at}
            />
          )}
        </div>
      )}
    </div>
  );
}
