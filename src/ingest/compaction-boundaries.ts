/**
 * src/ingest/compaction-boundaries.ts — timestamp-order compaction-boundary turn
 * flagging, replacing the position-order approach that broke across multi-file
 * sessions.
 *
 * Rule: each DISTINCT event_ts of compact-boundary / compact-summary events maps to the first
 * main-chain turn (is_sidechain = 0) with ts > event_ts, ordered by ts then
 * message_id. Several compactions mapping to the same turn produce one flag.
 * Compactions with no later main-chain turn get no marker.
 */

import type { Db } from "../db/open.js";
import { bumpEnrichmentEpochIfClosed } from "./enrichment-epoch.js";

/**
 * Recompute is_compaction_boundary for every turn of a session.
 *
 * Sets the flag to 1 for the correct target turns and removes wrong flags,
 * making the function idempotent and self-correcting.
 *
 * Returns the number of turns whose value changed 0→1 (newly added flags).
 * Returns 0 when the existing flags already match the correct set.
 */
export function recomputeCompactionBoundaries(
  db: Db,
  sessionId: string,
  now: Date = new Date(),
): number {
  // A compact-summary is its own compaction only when no compact-boundary precedes it
  // without a main-chain turn in between (the boundary already marks that compaction).
  const stEvents = db.prepare(
    `SELECT DISTINCT s.event_ts FROM ingest_metric_events s
     WHERE s.session_id = ? AND (s.boundary_kind = 'compact-boundary' OR (
       s.boundary_kind = 'compact-summary' AND NOT EXISTS (
         SELECT 1 FROM ingest_metric_events b
          WHERE b.session_id = s.session_id AND b.boundary_kind = 'compact-boundary'
            AND b.event_ts <= s.event_ts
            AND NOT EXISTS (
              SELECT 1 FROM turns t
               WHERE t.session_id = s.session_id AND t.is_sidechain = 0
                 AND t.ts > b.event_ts AND t.ts < s.event_ts))))`,
  );
  const stFirstTurn = db.prepare(
    `SELECT message_id FROM turns
     WHERE session_id = ? AND is_sidechain = 0 AND ts > ?
     ORDER BY ts, message_id LIMIT 1`,
  );
  const stGetFlagged = db.prepare(
    "SELECT message_id FROM turns WHERE session_id = ? AND is_compaction_boundary = 1",
  );
  const stClearOne = db.prepare(
    "UPDATE turns SET is_compaction_boundary = 0 WHERE session_id = ? AND message_id = ?",
  );
  const stSetOne = db.prepare(
    `UPDATE turns SET is_compaction_boundary = 1
     WHERE session_id = ? AND message_id = ? AND is_sidechain = 0 AND is_compaction_boundary = 0`,
  );

  // Compute the correct set of boundary turn message_ids.
  const events = stEvents.all(sessionId) as { event_ts: string | null }[];
  const target = new Set<string>();
  for (const e of events) {
    if (e.event_ts === null) continue;
    const row = stFirstTurn.get(sessionId, e.event_ts) as { message_id: string } | undefined;
    if (row !== undefined) target.add(row.message_id);
  }

  // A flag flipped on a turn of a closed ledger window is an in-place edit the fingerprint misses.
  const stTurnTs = db.prepare("SELECT ts FROM turns WHERE message_id = ?");
  const touched = (mid: string): void => {
    const row = stTurnTs.get(mid) as { ts: string } | undefined;
    bumpEnrichmentEpochIfClosed(db, row?.ts, now);
  };

  // Remove flags from turns that are no longer boundary turns.
  const currently = (stGetFlagged.all(sessionId) as { message_id: string }[]).map(
    (r) => r.message_id,
  );
  for (const mid of currently) {
    if (target.has(mid)) continue;
    stClearOne.run(sessionId, mid);
    touched(mid);
  }

  // Add flags to turns that should be boundaries but are not yet flagged.
  let added = 0;
  for (const mid of target) {
    const r = stSetOne.run(sessionId, mid);
    added += r.changes;
    if (r.changes > 0) touched(mid);
  }
  return added;
}
