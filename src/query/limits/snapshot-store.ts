/**
 * src/query/limits/snapshot-store.ts — log weekly limit readings to limit_snapshots (OV-12 U4).
 *
 * At most one row per hour per source. The throttle reads the newest row from the DB, so it
 * holds across daemon restarts. Percentages and timestamps only (SEC-101). Best-effort: never
 * throws.
 */

import type { Db } from "../../db/open.js";

const MIN_GAP_MS = 36e5;

export function recordLimitSnapshot(
  db: Db,
  s: { ts: string; resetsAt: string; usedPct: number; source: "api" | "statusline" | "cli" },
): void {
  try {
    const last = db
      .prepare("SELECT MAX(ts) AS ts FROM limit_snapshots WHERE source = ?")
      .get(s.source) as { ts: string | null };
    if (last.ts !== null && Date.parse(s.ts) - Date.parse(last.ts) < MIN_GAP_MS) return;
    db.prepare(
      "INSERT OR IGNORE INTO limit_snapshots (ts, resets_at, used_pct, source) VALUES (?, ?, ?, ?)",
    ).run(s.ts, new Date(s.resetsAt).toISOString(), Math.round(s.usedPct * 100) / 100, s.source);
  } catch {
    // Best-effort: a log failure never fails the usage response.
  }
}
