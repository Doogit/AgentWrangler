/**
 * src/ui/shell/SectionStatus.tsx — in-section loading state (OV-13).
 *
 * A section waiting on background work says what it is waiting on and for how long: a header line
 * ("Building recommendations · 12 s · usually ~20 s") or, while a snapshot is served and a rebuild
 * runs behind it, an "Updating · as of 3m ago" chip. `SectionEdge` is the 2 px cyan line on the
 * card's top edge. Approved look: docs/design/mockups/section-status-mockup.html. See DESIGN_GUIDE.md.
 */

import { useEffect, useState } from "react";
import { relativeTime } from "../lib/relative-time";

export type SectionLoad =
  | {
      kind: "building";
      /** e.g. "Building recommendations". */
      label: string;
      /** ISO time the build started; absent while it has not started yet. */
      startedAt?: string | undefined;
      /** The last build's duration; null or absent before the first one. */
      expectedMs?: number | null | undefined;
    }
  | {
      kind: "refreshing";
      /** ISO time the served data is from. */
      asOf: string;
    }
  | null;

/** The header line is shown only after this long (guide: don't flash a status on fast loads). */
const SHOW_AFTER_MS = 1000;

/** Milliseconds since `startedAt`, ticking once a second while `startedAt` is set. */
export function useElapsedMs(startedAt: string | undefined): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === undefined) {
      setElapsed(null);
      return;
    }
    const started = Date.parse(startedAt);
    const tick = () => setElapsed(Math.max(0, Date.now() - started));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

/** True when a build has run more than twice its usual time. */
export function isSlow(elapsedMs: number, expectedMs: number | null | undefined): boolean {
  return expectedMs != null && elapsedMs > 2 * expectedMs;
}

/** "12 s · usually ~20 s", "12 s" (no prior build), or "74 s · taking longer than usual". */
export function buildingMeta(elapsedMs: number, expectedMs: number | null | undefined): string {
  const s = Math.floor(elapsedMs / 1000);
  if (isSlow(elapsedMs, expectedMs)) return `${s} s · taking longer than usual`;
  if (expectedMs == null) return `${s} s`;
  return `${s} s · usually ~${Math.round(expectedMs / 1000)} s`;
}

/** Edge fill percent (elapsed ÷ usual, capped at 95), or null to sweep (no estimate, or slow). */
export function edgeFillPct(
  elapsedMs: number,
  expectedMs: number | null | undefined,
): number | null {
  if (expectedMs == null || expectedMs <= 0 || isSlow(elapsedMs, expectedMs)) return null;
  return Math.min(95, (elapsedMs / expectedMs) * 100);
}

/** Cyan ring spinner (cyan = in progress). */
export function StatusSpinner() {
  return <span className="section-status-spinner" aria-hidden="true" />;
}

/** The header element: the building line, the refreshing chip, or nothing. */
export function SectionStatus({ load }: { load: SectionLoad }) {
  const elapsed = useElapsedMs(load?.kind === "building" ? load.startedAt : undefined);
  if (load?.kind === "refreshing") {
    return (
      <span className="chip history-notice section-status-refreshing">
        <StatusSpinner />
        Updating · as of {relativeTime(load.asOf)}
      </span>
    );
  }
  if (load?.kind !== "building" || elapsed === null || elapsed < SHOW_AFTER_MS) return null;
  return (
    <output
      className="section-status"
      data-slow={isSlow(elapsed, load.expectedMs) ? "true" : undefined}
    >
      <StatusSpinner />
      <span className="section-status-label">{load.label}</span>
      <span className="section-status-meta">{buildingMeta(elapsed, load.expectedMs)}</span>
    </output>
  );
}

/** The 2 px top-edge line. Place inside a `.section-frame` (position: relative; overflow: hidden). */
export function SectionEdge({ load }: { load: SectionLoad }) {
  const elapsed = useElapsedMs(load?.kind === "building" ? load.startedAt : undefined);
  const on =
    load?.kind === "refreshing" ||
    (load?.kind === "building" && elapsed !== null && elapsed >= SHOW_AFTER_MS);
  const pct =
    load?.kind === "building" && elapsed !== null ? edgeFillPct(elapsed, load.expectedMs) : null;
  return (
    <div
      className="section-edge"
      data-on={on ? "true" : "false"}
      data-mode={pct === null ? "sweep" : "fill"}
      aria-hidden="true"
    >
      <span style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
