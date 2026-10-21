/**
 * Enrichment epoch: a counter in `user_config` that `ledgerFingerprint` includes, bumped by every
 * write that can change a row of an already-closed ledger window in a way the fingerprint's count,
 * rowid and flag signals do not see (late result bytes, error or interrupt labels, destructive-op
 * relabels, agent ids, subagent or tool-event metadata). Hot ingest of the open window never
 * bumps, so the closed-window aggregate cache stays warm. `test/ingest/enrichment-epoch-guard`
 * fails when a source file writes a ledger-input table without importing this module.
 */
import type { Statement } from "better-sqlite3";
import type { Db } from "../db/open.js";
import { gridW1EndMs } from "../detector/engine.js";

export const ENRICHMENT_EPOCH_KEY = "ledger_enrichment_epoch";

const WEEK_MS = 7 * 86_400_000;

/** The epoch as the text `ledgerFingerprint` hashes; "0" before the first bump. */
export function readEnrichmentEpoch(db: Db): string {
  const row = db.prepare("SELECT value FROM user_config WHERE key = ?").get(ENRICHMENT_EPOCH_KEY) as
    | { value: string | null }
    | undefined;
  return row?.value ?? "0";
}

const bumpStmts = new WeakMap<Db, Statement<unknown[]>>();

export function bumpEnrichmentEpoch(db: Db): void {
  // Prepared once per connection: a replay of a closed transcript bumps once per row.
  let stmt = bumpStmts.get(db);
  if (stmt === undefined) {
    stmt = db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
                                      updated_at = excluded.updated_at`,
    );
    bumpStmts.set(db, stmt);
  }
  stmt.run(ENRICHMENT_EPOCH_KEY, new Date().toISOString());
}

/**
 * Bump when `ts` lies in a closed window: at or before the newest reset-grid point at or before
 * `now`, the boundary `isClosedWindow` uses. An unreadable ts counts as closed (conservative).
 * Cost: one `user_config` point read, none when the caller passes the reset-grid `phase` it
 * already read (a chunk transaction reads it once).
 */
export function bumpEnrichmentEpochIfClosed(
  db: Db,
  ts: string | null | undefined,
  now: Date,
  phase?: number,
): void {
  if (isClosedTs(db, ts, now, phase)) bumpEnrichmentEpoch(db);
}

/** True when `ts` is in a closed window (or unreadable). Same boundary as the bump above. */
export function isClosedTs(
  db: Db,
  ts: string | null | undefined,
  now: Date,
  phase?: number,
): boolean {
  const ms = ts === null || ts === undefined ? Number.NaN : Date.parse(ts);
  return !(Number.isFinite(ms) && ms > gridW1EndMs(db, new Date(now.getTime() + WEEK_MS), phase));
}
