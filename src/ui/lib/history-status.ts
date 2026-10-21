import type { DaemonStatus, HistoryCoverage } from "../api/client";
import { useStatusPoller } from "../api/status-poller";

const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;

export interface HistoryStatus {
  complete: boolean;
  processing: boolean;
  failed: boolean;
  /** Moves when a slice (`ingest`) or a detector walk (`detectors`) lands; never on `live`. */
  revision: string;
  coverage: HistoryCoverage | undefined;
}

/** P2-U7: history state from the P2-U5 status poller (same rules as /api/history-progress). */
export function historyFromStatus(status: DaemonStatus | null): HistoryStatus {
  const pipeline = status?.pipeline;
  const scopes = status?.data_scopes;
  return {
    complete: pipeline?.phase === "done" && pipeline.failed_phase === null,
    processing:
      pipeline !== undefined && pipeline.phase !== "done" && pipeline.failed_phase === null,
    failed: pipeline?.failed_phase != null,
    revision: scopes ? `${scopes.ingest}:${scopes.detectors}` : "pending",
    coverage: status?.history_coverage,
  };
}

/** Reads the shared status poller; no fetch and no timer of its own. */
export function useHistoryStatus(): HistoryStatus {
  return historyFromStatus(useStatusPoller().status);
}

/** The page chip: "Showing N of ~M days · loading" (either part may be absent; null when complete). */
export function historyNoteText(coverage: string | null, history: HistoryStatus): string | null {
  const state = history.complete
    ? null
    : history.processing
      ? "loading"
      : history.failed
        ? "history paused; may be incomplete"
        : "completeness unknown";
  const parts = [coverage, state].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * "Showing N of ~M days" while history loads (review M36: days, never weeks). N counts whole
 * UTC days from `oldest_complete_day` through today; M is the planned weeks in days. With
 * `windowDays`, labels only a window wider than N ("Showing N of 30 days").
 */
export function coverageLabel(
  coverage: HistoryCoverage | undefined,
  windowDays?: number,
  now: number = Date.now(),
): string | null {
  if (coverage?.oldest_complete_day == null) return null;
  if (coverage.weeks_done >= coverage.weeks_total && !coverage.partial_week) return null;
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  const days = Math.floor((today - Date.parse(coverage.oldest_complete_day)) / DAY_MS) + 1;
  if (windowDays !== undefined) {
    return windowDays > days ? `Showing ${days} of ${windowDays} days` : null;
  }
  const label = `Showing ${days} of ~${coverage.weeks_total * DAYS_PER_WEEK} days`;
  return coverage.partial_week ? `${label} (partial week)` : label;
}
