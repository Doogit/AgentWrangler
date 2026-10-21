/**
 * src/daemon/boot-state.ts — P0-U13 S4: skip the boot detector walk when nothing
 * the detectors read changed since the last completed walk.
 *
 * Daemons restart constantly, and every boot used to run the full history walk
 * even when no data had arrived. The marker below is persisted in user_config
 * after each walk COMPLETES (never at start, never on failure), and records the
 * state the walk read: it is computed just before the walk starts, so data
 * written during a walk makes the next boot walk again. Only the boot pass is
 * gated; post-ingest and 5-min idle-floor passes run exactly as before, so a
 * skipped boot is refreshed by the first of those.
 *
 * Marker = detector code version + ISO week + the walk's grid week + a hash of:
 *   - ingest_offsets (file, byte offset, head hash): every ingested line
 *     advances an offset, so any ingest write shows up here;
 *   - sessions (all columns): reconcile (LIVE → RECONCILED, provisional turns),
 *     re-pricing and attribution repair all update sessions rows;
 *   - turns and the append-only evidence tables: max rowid (O(1); a COUNT(*)
 *     cost ~100 ms per table, and deletes also remove offsets or sessions rows);
 *   - workspaces (all columns): new or changed repo mappings;
 *   - schema_migrations: a build that migrated the DB walks once;
 *   - the engine's own non-turn input signature (work_items, outcomes, links,
 *     context inventory, pricing, limit config) — reused, not re-derived.
 */

import * as crypto from "node:crypto";
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import { detectorCodeVersion, gridW1EndMs, inputSignature } from "../detector/engine.js";
import type { DetectorPassRun, DetectorPassRunner } from "./detector-pass.js";

export const DETECTOR_PASS_MARKER_KEY = "detector_pass_marker";

const INGEST_STATE_SQL = [
  "SELECT file_path, byte_offset, file_hash_head FROM ingest_offsets ORDER BY file_path",
  "SELECT * FROM sessions ORDER BY rowid",
  "SELECT * FROM workspaces ORDER BY rowid",
  "SELECT version FROM schema_migrations ORDER BY version",
  ...[
    "turns",
    "subagent_meta",
    "tool_events",
    "tool_event_metadata",
    "tool_event_content",
    "ingest_metric_events",
  ].map((table) => `SELECT IFNULL(MAX(rowid), 0) FROM ${table}`),
];

/** ISO-8601 week of `now` in UTC, e.g. "2026-W40". */
export function isoWeek(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The detector input marker for a walk at `now` (see the file header). */
export function detectorPassMarker(db: Db, now: Date, codeVersion: string): string {
  const hash = crypto.createHash("sha1");
  for (const sql of INGEST_STATE_SQL) {
    for (const row of db.prepare(sql).raw().iterate()) hash.update(JSON.stringify(row));
    hash.update("\u0000");
  }
  hash.update(inputSignature(db));
  return JSON.stringify({
    code: codeVersion,
    week: isoWeek(now),
    grid: gridW1EndMs(db, now),
    input: hash.digest("hex"),
  });
}

/** P0-U14: when the last COMPLETED walk finished (ISO); persisted with the marker. */
export const DETECTOR_PASS_COMPLETED_AT_KEY = "detector_pass_completed_at";

/** P0-U14: an idle-floor pass always runs once this long has passed since a completed walk. */
export const IDLE_PASS_MAX_STALE_MS = 60 * 60_000;

function localDay(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export interface DetectorBootGate {
  /** Wraps a walk: marker computed before it starts, persisted only once it resolves. */
  track(run: DetectorPassRun): DetectorPassRun;
  /**
   * P0-U14: should an idle-floor pass (nothing ingested, nothing newly mapped) run at `at`?
   * Yes when the marker changed, no completed walk is recorded, 60 min passed since the last
   * completed walk, or the local calendar day changed. Cheap checks run before the marker.
   */
  idleDue(at: Date): boolean;
  /** The runner for the boot pass: skips when the persisted marker matches the current state. */
  forBoot(runner: DetectorPassRunner): DetectorPassRunner;
}

export function createDetectorBootGate(
  db: Db,
  opts: { codeVersion?: string; now?: () => Date } = {},
): DetectorBootGate {
  const now = opts.now ?? (() => new Date());
  const codeVersion = opts.codeVersion ?? detectorCodeVersion();
  return {
    track: (run) => async (walkDb, at, onWeek) => {
      const marker = detectorPassMarker(db, at, codeVersion);
      const statuses = await run(walkDb, at, onWeek);
      await awaitDbWriteGate();
      try {
        db.prepare(
          `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(DETECTOR_PASS_MARKER_KEY, marker, new Date().toISOString());
        db.prepare(
          `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(DETECTOR_PASS_COMPLETED_AT_KEY, now().toISOString(), now().toISOString());
      } catch (e) {
        // Not persisting only costs the next boot one walk.
        console.warn(`detector pass marker not saved: ${e instanceof Error ? e.message : e}`);
      }
      return statuses;
    },
    idleDue: (at) => {
      const read = (key: string) =>
        (
          db.prepare("SELECT value FROM user_config WHERE key = ?").get(key) as
            | { value: string | null }
            | undefined
        )?.value ?? null;
      const doneRaw = read(DETECTOR_PASS_COMPLETED_AT_KEY);
      const stored = read(DETECTOR_PASS_MARKER_KEY);
      if (doneRaw === null || stored === null) return true;
      const done = new Date(doneRaw);
      if (Number.isNaN(done.getTime())) return true;
      const elapsed = at.getTime() - done.getTime();
      // A negative gap means the wall clock stepped back: treat as due.
      if (elapsed < 0 || elapsed >= IDLE_PASS_MAX_STALE_MS) return true;
      if (localDay(done) !== localDay(at)) return true;
      return stored !== detectorPassMarker(db, at, codeVersion);
    },
    forBoot: (runner) => ({
      get isRunning() {
        return runner.isRunning;
      },
      async runIfDue(changed, onWeek, at, completeThroughMs) {
        const stored = db
          .prepare("SELECT value FROM user_config WHERE key = ?")
          .get(DETECTOR_PASS_MARKER_KEY) as { value: string | null } | undefined;
        if (
          stored?.value != null &&
          stored.value === detectorPassMarker(db, at ?? now(), codeVersion)
        ) {
          console.log("Boot detector pass skipped: no new data since the last completed pass");
          return { ran: false, detector_runs: 0 };
        }
        return runner.runIfDue(changed, onWeek, at, completeThroughMs);
      },
    }),
  };
}
