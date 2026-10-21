import type { MetricId } from "../lib/metric-copy";
import InfoTip from "../shell/InfoTip";

interface KpiCardProps {
  label: string;
  metricId?: MetricId;
  info?: string;
  value: string;
  cmp?: React.ReactNode;
  moreHref?: string;
  moreLabel?: string;
  onMoreClick?: React.MouseEventHandler<HTMLAnchorElement>;
  dataMetric?: string;
  /** Rendered at the right of the title row (e.g. a compact tab control). */
  headerExtra?: React.ReactNode;
  /** Rendered on the value's line, after it (e.g. a tier chip). */
  valueExtra?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/** Overview "This period" tile; also used by the OV-11 pages so every KPI tile looks the same. */
export function KpiCard({
  label,
  metricId,
  info,
  value,
  cmp,
  moreHref,
  moreLabel,
  onMoreClick,
  dataMetric,
  headerExtra,
  valueExtra,
  className,
  children,
}: KpiCardProps) {
  const valueEl = <div className="v num">{value}</div>;
  return (
    <div className={className ? `card kpi ${className}` : "card kpi"} data-metric={dataMetric}>
      <div className="lbl">
        <span>
          {label}{" "}
          <InfoTip label={`About ${label}`} {...(metricId ? { metricId } : { content: info })} />
        </span>
        {headerExtra}
      </div>
      {valueExtra === undefined ? (
        valueEl
      ) : (
        <div className="kpi-v-row">
          {valueEl}
          {valueExtra}
        </div>
      )}
      {cmp !== undefined && <div className="cmp num">{cmp}</div>}
      {children}
      {moreHref !== undefined && (
        <a className="more" href={moreHref} onClick={onMoreClick}>
          {moreLabel}
        </a>
      )}
    </div>
  );
}

export default KpiCard;
