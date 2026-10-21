/**
 * U7 computability helper.  The ledger contains only structural boundary
 * evidence; cache-read collapse is useful as a signal but is never promoted to
 * an exact N boundary (ADV-2).
 */
import type { Db } from "../db/open.js";
import type { BoundaryKind, BoundaryVerification } from "./types.js";

export interface NComputability {
  /** Exact surviving-turn count, or the conservative floor for an inferred boundary. */
  n: number;
  observedTurnCount: number;
  boundaryKind: BoundaryKind | null;
  verification: BoundaryVerification | null;
  conservativeFloor: boolean;
}

/**
 * Count turns from a boundary to the next boundary, local marker, or session
 * end. A structural boundary is exact. An inferred cache collapse returns a
 * zero floor rather than pretending its timestamp is corroborated.
 */
export function computeN(
  db: Db,
  sessionId: string,
  startTs: string,
  startPosition = 0,
): NComputability {
  const boundary = db
    .prepare(
      `SELECT event_ts, event_position, boundary_kind, boundary_verification
       FROM ingest_metric_events
      WHERE session_id = ? AND boundary_kind IS NOT NULL
        AND (event_ts > ? OR (event_ts = ? AND event_position >= ?))
      ORDER BY event_ts, event_position LIMIT 1`,
    )
    .get(sessionId, startTs, startTs, startPosition) as
    | {
        event_ts: string;
        event_position: number;
        boundary_kind: BoundaryKind;
        boundary_verification: BoundaryVerification;
      }
    | undefined;
  const nextBoundary =
    boundary === undefined
      ? undefined
      : (db
          .prepare(
            `SELECT event_ts FROM ingest_metric_events
      WHERE session_id = ? AND boundary_kind IS NOT NULL
        AND (event_ts > ? OR (event_ts = ? AND event_position > ?))
      ORDER BY event_ts, event_position LIMIT 1`,
          )
          .get(sessionId, boundary.event_ts, boundary.event_ts, boundary.event_position) as
          | { event_ts: string }
          | undefined);
  const command = db
    .prepare(
      `SELECT ts FROM tool_events
      WHERE session_id = ? AND tool_name = 'local_command' AND input_hash IN ('/compact', '/clear') AND ts >= ?
      ORDER BY ts LIMIT 1`,
    )
    .get(sessionId, startTs) as { ts: string } | undefined;
  const commandAfterStart =
    command !== undefined && command.ts > (boundary?.event_ts ?? startTs) ? command.ts : undefined;
  const cutoff =
    [nextBoundary?.event_ts, commandAfterStart]
      .filter((value): value is string => value !== undefined)
      .sort()[0] ?? null;
  const observedTurnCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM turns
      WHERE session_id = ? AND ts >= ? ${cutoff === null ? "" : "AND ts < ?"}`,
      )
      .get(...(cutoff === null ? [sessionId, startTs] : [sessionId, startTs, cutoff])) as {
      n: number;
    }
  ).n;
  // M1: a real legacy-summary marker carries no timestamp, so its event_ts is
  // NULL and it is invisible to the (event_ts)-ordered boundary query above. An
  // unplaceable boundary cannot be positioned relative to a ts anchor, so we
  // cannot prove the window is cut before it — floor N conservatively rather
  // than let an earlier anchor's window span past it and overcount.
  //
  // This is deliberately broad: any unplaceable boundary at/after startPosition
  // floors the whole call, even when a later verified ts-boundary would have cut
  // the counted window before it. That over-floors (n=0 where an exact count was
  // provable) but is always safe-direction (never overcounts). computeN has no
  // production caller yet; when one is wired, bound this to the counted window
  // (nextBoundary's event_position, NOT `boundary`'s) to recover that precision.
  const unplaceable = db
    .prepare(
      `SELECT boundary_kind, boundary_verification FROM ingest_metric_events
      WHERE session_id = ? AND boundary_kind IS NOT NULL AND event_ts IS NULL
        AND event_position >= ?
      ORDER BY event_position LIMIT 1`,
    )
    .get(sessionId, startPosition) as
    | { boundary_kind: BoundaryKind; boundary_verification: BoundaryVerification }
    | undefined;
  const conservativeFloor =
    boundary?.boundary_verification === "UNVERIFIED" || unplaceable !== undefined;
  return {
    n: conservativeFloor ? 0 : observedTurnCount,
    observedTurnCount,
    boundaryKind: boundary?.boundary_kind ?? unplaceable?.boundary_kind ?? null,
    verification: boundary?.boundary_verification ?? unplaceable?.boundary_verification ?? null,
    conservativeFloor,
  };
}
