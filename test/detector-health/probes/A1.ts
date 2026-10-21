/**
 * DH2 probe for A1 TOOL_RESULT_BLOAT_V2 (contract card A1, docs/plans/dh-contracts.md).
 * Fires per workspace when any tool result in the window is strictly larger than 25,600 bytes
 * (valid whole-number size, linked to a session that has a workspace). No other gate.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeResult } from "./types.js";

const A1_RESULT_BYTES_THRESHOLD = 25_600;
/** Relaxed candidate floor: half the threshold (a "large result" that is not yet bloat). */
const RELAXED_BYTES = A1_RESULT_BYTES_THRESHOLD / 2;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface WsRow {
  workspace_id: string;
  max_bytes: number;
}

export const probeA1: Probe = (db: Database.Database, now: Date): ProbeResult => {
  const to = now.toISOString();
  const from = new Date(now.getTime() - WEEK_MS).toISOString();
  // Window: ts >= from AND ts < to. Size must be a stored whole number.
  const rows = db
    .prepare(
      `SELECT s.workspace_id AS workspace_id, MAX(e.result_bytes) AS max_bytes
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id
        WHERE e.ts >= ? AND e.ts < ?
          AND typeof(e.result_bytes) = 'integer'
          AND s.workspace_id IS NOT NULL AND s.workspace_id <> ''
        GROUP BY s.workspace_id`,
    )
    .all(from, to) as WsRow[];

  const candidates = rows.filter((r) => r.max_bytes > RELAXED_BYTES).length;
  const qualifying = rows.filter((r) => r.max_bytes > A1_RESULT_BYTES_THRESHOLD).length;
  const best = rows.reduce<number | null>(
    (m, r) => (m === null || r.max_bytes > m ? r.max_bytes : m),
    null,
  );

  return {
    candidates,
    qualifying,
    gates: [
      {
        name: "A1_RESULT_BYTES_THRESHOLD",
        value: best,
        threshold: A1_RESULT_BYTES_THRESHOLD,
        op: ">",
        pass: best !== null && best > A1_RESULT_BYTES_THRESHOLD,
      },
    ],
    note: "Counts workspaces with any tool result larger than 25,600 bytes in the 7-day window (exact per card, any tool, any chain). Candidates = workspaces with a result over 12,800 bytes.",
  };
};
