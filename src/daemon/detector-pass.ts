/**
 * Post-ready detector phase (U3 / PERF5 / P2H).
 *
 * The detector pass is the P2H history walk (src/detector/engine.ts
 * runHistoryWalk): synchronous within a week, yielding between weeks. This
 * runner keeps passes non-overlapping; requests that arrive while a walk is
 * running share one follow-up walk and await its real outcome (success or
 * failure), so a retry reports what actually happened.
 */

import type { Db } from "../db/open.js";
import {
  type HistoryWeekListener,
  type LiveDetectorStatus,
  runHistoryWalk,
} from "../detector/engine.js";
import type { BackgroundPipelineProgress, BackgroundProgressListener } from "../ingest/ingestor.js";
import { bumpDataVersion } from "./data-version.js";

export interface DetectorPassResult {
  ran: boolean;
  detector_runs: number;
}

export type DetectorPassRun = (
  db: Db,
  now: Date,
  onWeek?: HistoryWeekListener,
  /** P2-U4: a floored walk while the slice loop runs (HistoryWalkOptions.completeThroughMs). */
  completeThroughMs?: number,
) => LiveDetectorStatus[] | Promise<LiveDetectorStatus[]>;

export interface DetectorPassDeps {
  db: Db;
  now?: () => Date;
  idleFloorMs?: number;
  run?: DetectorPassRun;
}

export interface DetectorPassRunner {
  readonly isRunning: boolean;
  /**
   * Run (or join) a walk. `at` is the caller's injected clock (the ingestor's
   * now() on the post-ingest path); it defaults to deps.now(). A request made
   * while a walk is in flight awaits ONE shared follow-up walk and resolves or
   * rejects with that walk's outcome. A shared follow-up is floored only when every
   * request it serves was (at the lowest floor asked for).
   */
  runIfDue(
    changed: boolean,
    onWeek?: HistoryWeekListener,
    at?: Date,
    completeThroughMs?: number,
  ): Promise<DetectorPassResult>;
}

const DEFAULT_IDLE_FLOOR_MS = 5 * 60_000;

const walkStatuses: DetectorPassRun = async (db, now, onWeek, completeThroughMs) =>
  (await runHistoryWalk(db, now, { onWeek, completeThroughMs })).statuses;

/** A non-overlapping, idle-gated adapter around the detector history walk. */
export function createDetectorPassRunner(deps: DetectorPassDeps): DetectorPassRunner {
  const now = deps.now ?? (() => new Date());
  const idleFloorMs = deps.idleFloorMs ?? DEFAULT_IDLE_FLOOR_MS;
  const run = deps.run ?? walkStatuses;
  let lastRunAtMs: number | null = null;
  let current: Promise<LiveDetectorStatus[]> | null = null;
  let followUp: Promise<LiveDetectorStatus[]> | null = null;
  let followUpAt: Date | null = null;
  let followUpOnWeek: HistoryWeekListener | undefined;
  // null = no request yet; undefined = some request wants the full walk.
  let followUpFloor: number | undefined | null = null;

  function start(
    at: Date,
    onWeek: HistoryWeekListener | undefined,
    floor: number | undefined,
  ): Promise<LiveDetectorStatus[]> {
    const walk = Promise.resolve()
      .then(() => run(deps.db, at, onWeek, floor))
      .then((statuses) => {
        bumpDataVersion("detectors");
        lastRunAtMs = at.getTime();
        return statuses;
      })
      .finally(() => {
        if (current === walk) current = null;
      });
    current = walk;
    return walk;
  }

  return {
    get isRunning(): boolean {
      return current !== null;
    },
    async runIfDue(
      changed: boolean,
      onWeek?: HistoryWeekListener,
      at?: Date,
      completeThroughMs?: number,
    ): Promise<DetectorPassResult> {
      const requestedAt = at ?? now();
      const idleDue = lastRunAtMs !== null && requestedAt.getTime() - lastRunAtMs >= idleFloorMs;
      if (!changed && !idleDue) return { ran: false, detector_runs: 0 };
      let walk: Promise<LiveDetectorStatus[]>;
      if (current === null) {
        walk = start(requestedAt, onWeek, completeThroughMs);
      } else {
        // Coalesce: every request during this walk shares one follow-up, which
        // runs at the latest requested clock.
        followUpAt = requestedAt;
        followUpOnWeek = onWeek ?? followUpOnWeek;
        followUpFloor =
          followUpFloor === undefined || completeThroughMs === undefined
            ? undefined
            : Math.min(followUpFloor ?? completeThroughMs, completeThroughMs);
        if (followUp === null) {
          followUp = current
            .catch(() => undefined)
            .then(() => {
              const nextAt = followUpAt ?? now();
              const nextOnWeek = followUpOnWeek;
              const nextFloor = followUpFloor ?? undefined;
              followUp = null;
              followUpAt = null;
              followUpOnWeek = undefined;
              followUpFloor = null;
              return start(nextAt, nextOnWeek, nextFloor);
            });
        }
        walk = followUp;
      }
      const statuses = await walk;
      return { ran: true, detector_runs: statuses.length };
    },
  };
}

/**
 * Run the detector boundary of a completed background scan. P2H: the history
 * walk runs on EVERY pass, including a boot or retry whose re-read found no new
 * files (files_with_new_data === 0) — cached closed weeks make that repeat cheap,
 * and it is what refreshes stale recs after a restart. A failed walk leaves the
 * last reported phase at detecting for an honest retry boundary.
 */
export async function completeBackgroundDetectorPhase(
  progress: BackgroundPipelineProgress,
  runner: DetectorPassRunner,
  report: BackgroundProgressListener,
  onWeek?: HistoryWeekListener,
): Promise<BackgroundPipelineProgress> {
  const detecting = { ...progress, phase: "detecting" as const };
  report(detecting);
  const detector = await runner.runIfDue(true, onWeek);
  const done = { ...detecting, phase: "done" as const, detector_runs: detector.detector_runs };
  report(done);
  return done;
}
