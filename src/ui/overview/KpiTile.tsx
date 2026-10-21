import type { ReactNode } from "react";
import type { MetricId } from "../lib/metric-copy";
import InfoTip from "../shell/InfoTip";

interface KpiTileProps {
  label: string;
  value: string;
  deltaText?: ReactNode;
  deltaGood?: boolean | undefined;
  subLabel?: ReactNode;
  hero?: boolean;
  meterFraction?: number | undefined;
  /** Optional in-place explanation (an <InfoTip/>) shown beside the label. */
  info?: ReactNode;
  /**
   * When set, renders a canonical InfoTip keyed by metric id beside the label.
   * Ignored when `info` is also provided (caller-supplied `info` takes precedence).
   */
  metricId?: MetricId;
}

/** Number-forward overview metric tile, intentionally self-contained. */
export function KpiTile({
  label,
  value,
  deltaText,
  deltaGood,
  subLabel,
  hero = false,
  meterFraction,
  info,
  metricId,
}: KpiTileProps) {
  const tipNode =
    info ?? (metricId ? <InfoTip label={`About ${label}`} metricId={metricId} /> : undefined);
  const clampedMeterFraction =
    meterFraction === undefined ? null : Math.min(Math.max(meterFraction, 0), 1);
  const meterPercent = clampedMeterFraction === null ? null : clampedMeterFraction * 100;

  return (
    <section className={`overview-kpi-tile${hero ? " overview-kpi-tile-hero" : ""}`}>
      <div className="overview-kpi-tile-label">
        <span>{label}</span>
        {tipNode}
      </div>
      <div className="overview-kpi-tile-value">{value}</div>
      {meterPercent !== null && (
        // biome-ignore lint/a11y/useFocusableInteractive: non-interactive visual meter; making a progressbar focusable would be incorrect.
        <div
          className="overview-kpi-tile-meter"
          role="progressbar"
          aria-label={`${value} used`}
          aria-valuenow={meterPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="overview-kpi-tile-meter-fill" style={{ width: `${meterPercent}%` }} />
        </div>
      )}
      {deltaText !== undefined && (
        <div
          className={`overview-kpi-tile-delta${
            deltaGood === undefined
              ? ""
              : deltaGood
                ? " overview-kpi-tile-delta-good"
                : " overview-kpi-tile-delta-bad"
          }`}
        >
          {deltaText}
        </div>
      )}
      {subLabel !== undefined && <div className="overview-kpi-tile-sublabel">{subLabel}</div>}
    </section>
  );
}

export default KpiTile;
