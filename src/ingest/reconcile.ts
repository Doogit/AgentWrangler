/**
 * src/ingest/reconcile.ts — LIVE → RECONCILED session lifecycle.
 *
 * A session is LIVE while its last_turn_at is within the activity window of the
 * reference time; otherwise it closes to RECONCILED. On close, provisional turn
 * flags are cleared and hygiene flags are evaluated from settled DB state
 * (deterministic, so rebuild-equality holds). Turns are inserted provisional=1
 * by the ingestor; this pass is the sole authority that clears them.
 *
 * sessions.cost_equiv_u rollforward is maintained incrementally by the ingestor
 * (sum of each session's turn costs) and is unaffected by reconciliation — the
 * running total is the final total once the session settles.
 */

import type { Db } from "../db/open.js";

export interface ReconcileOptions {
  /** context_tokens above which a turn counts as "full context". */
  longContextThreshold: number;
  /** more than this many full-context turns in a session ⇒ LONG_FULL_CONTEXT. */
  longContextTurnCount: number;
}

export const DEFAULT_RECONCILE_OPTIONS: ReconcileOptions = {
  longContextThreshold: 150_000,
  longContextTurnCount: 20,
};

interface SessionRow {
  session_id: string;
  last_turn_at: string | null;
  turn_count: number;
}

/**
 * Reconcile every session against `cutoffIso` (= referenceTime − activityWindow).
 * Sessions with last_turn_at ≥ cutoff stay LIVE (provisional); older sessions
 * close to RECONCILED with provisional cleared and hygiene flags evaluated.
 * Idempotent: re-running with the same cutoff yields the same state.
 */
export function reconcileSessions(
  db: Db,
  cutoffIso: string,
  opts: ReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
): void {
  const sessions = db
    .prepare(
      "SELECT session_id, last_turn_at, turn_count FROM sessions WHERE state != 'RECONCILED' OR last_turn_at >= :cutoff",
    )
    .all({ cutoff: cutoffIso }) as SessionRow[];

  const setProvisional = db.prepare("UPDATE turns SET provisional = ? WHERE session_id = ?");
  const setSession = db.prepare(
    "UPDATE sessions SET state = ?, hygiene_flags = ? WHERE session_id = ?",
  );
  const countLong = db.prepare(
    "SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND context_tokens > ?",
  );
  const countCompact = db.prepare(
    "SELECT COUNT(*) AS n FROM tool_events WHERE session_id = ? AND tool_name = 'local_command' AND input_hash = '/compact'",
  );

  const tx = db.transaction(() => {
    for (const s of sessions) {
      const live = s.last_turn_at !== null && s.last_turn_at >= cutoffIso;
      if (live) {
        setProvisional.run(1, s.session_id);
        setSession.run("LIVE", "[]", s.session_id);
        continue;
      }

      setProvisional.run(0, s.session_id);
      const flags: string[] = [];
      const longN = (countLong.get(s.session_id, opts.longContextThreshold) as { n: number }).n;
      if (longN > opts.longContextTurnCount) flags.push("LONG_FULL_CONTEXT");
      const compactN = (countCompact.get(s.session_id) as { n: number }).n;
      if (compactN > 0 && s.turn_count > 1) flags.push("COMPACT_MID_TASK");
      setSession.run("RECONCILED", JSON.stringify(flags), s.session_id);
    }
  });
  tx();
}
