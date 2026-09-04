/**
 * src/ui/shell/Skeleton.tsx — Loading skeleton for cards/tables/strips.
 *
 * Visually distinct from the N/A chip (N/A = metric defined but no value;
 * skeleton = data is being fetched right now).
 */

import { useEffect, useState } from "react";

export const CHART_SKELETON_HEIGHT = 220;

/**
 * Tracks the operating-system/browser reduced-motion preference, including
 * changes made while the dashboard is open.
 */
export function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

/** Single shimmering skeleton line. */
export function SkeletonLine({ width = "80%" }: { width?: string }) {
  return <span className="skeleton skeleton-line" style={{ width }} aria-hidden="true" />;
}

/** KPI card skeleton: value bar + a sub-line. */
export function SkeletonKpi() {
  return (
    <div className="kpi skeleton-kpi" aria-busy="true" aria-label="Loading">
      <div className="skeleton skeleton-line" style={{ width: "50%" }} aria-hidden="true" />
      <div className="skeleton skeleton-value" aria-hidden="true" />
      <div className="skeleton skeleton-line" style={{ width: "70%" }} aria-hidden="true" />
      <div className="chips">
        <span className="skeleton skeleton-chip" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Table row skeleton: fills placeholder rows. */
export function SkeletonRow({ cols }: { cols: number }) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: <tr> is not focusable; aria-hidden hides placeholder from screen readers
    <tr aria-hidden="true">
      {Array.from({ length: cols }).map((_v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable placeholder order
        <td key={i}>
          <span className="skeleton skeleton-line" style={{ width: "60%" }} />
        </td>
      ))}
    </tr>
  );
}

/** Generic fixed-height block skeleton (for strips and tables). */
export function SkeletonBlock({
  height = 48,
  className = "",
}: { height?: number; className?: string }) {
  return (
    <div
      className={`skeleton skeleton-block${className ? ` ${className}` : ""}`}
      style={{ width: "100%", height, borderRadius: 8, display: "block" }}
      aria-hidden="true"
    />
  );
}

/** Chart-sized skeleton block: matches the default Recharts chart height. */
export function SkeletonChart({ height = CHART_SKELETON_HEIGHT }: { height?: number }) {
  return <SkeletonBlock height={height} className="skeleton-chart" />;
}
