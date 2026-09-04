import type { Db } from "../../db/open.js";
import { getQueryDb } from "../db-context.js";
import { type HotSessionRow, hotSessionsByCost } from "../spend.js";
import { getSessionSpendPercentile } from "./self-percentiles.js";

/**
 * A hot-session row plus its per-session spend percentile within its own
 * workspace (BM3). The percentile reuses `getSessionSpendPercentile` verbatim —
 * one source of truth shared with the per-`:id` endpoint — so the Hot Sessions
 * chip and Session Detail chip can never diverge. `spend_percentile` is null
 * (chip suppressed) when the peer set is below the n>=20 floor.
 */
export interface HotSessionRowWithPercentile extends HotSessionRow {
  spend_percentile: number | null;
  spend_percentile_n: number;
}

export function getHotSessions(
  window?: { from: string; to: string },
  limit = 20,
): HotSessionRowWithPercentile[] {
  const db: Db = getQueryDb();
  // One query for the ranked rows, then one cheap percentile lookup per row
  // (<= limit rows, so no N-per-row HTTP calls). Reuses the per-session query
  // so the two BM3 surfaces stay identical.
  return hotSessionsByCost(db, limit, window).map((row) => {
    const percentile = getSessionSpendPercentile(db, row.session_id);
    return {
      ...row,
      spend_percentile: percentile.percentile,
      spend_percentile_n: percentile.n,
    };
  });
}
