/**
 * src/query/api/efficiency-headroom.ts — BM2 efficiency headroom.
 *
 * "How far am I from my own modeled ceiling?" — the sum of modeled weekly
 * savings across the OPEN recommendations (state PROPOSED or ADOPTED, non-null
 * savings) expressed as a fraction of the trailing-7d actual spend.
 *
 * Honesty contract: this is a MODELED ceiling built from unvalidated per-detector
 * fractions (e.g. D6's avoidance fraction is UNVALIDATED). It is "modeled headroom
 * — if every open recommendation were applied", never a "$X wasted" headline
 * (INT-5). The frozen envelope has no MODELED ClaimKind, so it rides as
 * EXPERIMENTAL with the caveat carried in the qualification note.
 *
 * FR-REC-103 is respected: this is a SEPARATE surface from listRecommendations,
 * which still never sums modeled savings into an "achieved" total.
 *
 * SEC-101: sums of existing aggregates (recommendations.modeled_savings_u_per_wk,
 * turns.cost_equiv_u) only — no transcript content.
 */

import type { Db } from "../../db/open.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";

export interface EfficiencyHeadroom {
  /** Σ modeled_savings_u_per_wk over open (PROPOSED|ADOPTED) recs with non-null savings, in µUSD/wk. */
  headroom_u_per_wk: number;
  /** Trailing-window Σ turns.cost_equiv_u (LIST_EQUIV), in µUSD. */
  actual_u_per_wk: number;
  /** headroom_u_per_wk / actual_u_per_wk; null on zero spend or when open recs carry no savings. */
  headroom_pct: number | null;
  /** Open recs contributing a non-null savings figure. */
  open_rec_count: number;
  from: string;
  to: string;
}

interface HeadroomRow {
  sum_u: number | null;
  with_savings: number;
  open_total: number;
}

interface SpendRow {
  actual_u: number;
}

/**
 * Compute the efficiency-headroom ratio over [from, to). The headroom numerator
 * is window-independent (it sums the current open recommendation set); the
 * denominator is the actual spend in the window (default trailing 7d).
 */
export function getEfficiencyHeadroom(
  db: Db,
  opts: { from: string; to: string },
): ApiResponse<EfficiencyHeadroom> {
  const { from, to } = opts;

  const recs = db
    .prepare(
      `SELECT COALESCE(SUM(modeled_savings_u_per_wk), 0) AS sum_u,
              COUNT(modeled_savings_u_per_wk) AS with_savings,
              COUNT(*) AS open_total
         FROM recommendations
        WHERE state IN ('PROPOSED', 'ADOPTED')`,
    )
    .get() as HeadroomRow;

  const spend = db
    .prepare(
      `SELECT COALESCE(SUM(cost_equiv_u), 0) AS actual_u
         FROM turns
        WHERE ts >= ? AND ts < ? AND provisional = 0`,
    )
    .get(from, to) as SpendRow;

  const headroom_u_per_wk = recs.sum_u ?? 0;
  const actual_u_per_wk = spend.actual_u;
  const openRecsExist = recs.open_total > 0;

  // Null when: no spend (avoid /0 → ∞/NaN), or open recs exist but none carries a
  // savings figure (an all-null modeled set is not a defensible ceiling).
  let headroom_pct: number | null;
  if (actual_u_per_wk === 0) {
    headroom_pct = null;
  } else if (openRecsExist && recs.with_savings === 0) {
    headroom_pct = null;
  } else {
    headroom_pct = headroom_u_per_wk / actual_u_per_wk;
  }

  const data: EfficiencyHeadroom = {
    headroom_u_per_wk,
    actual_u_per_wk,
    headroom_pct,
    open_rec_count: recs.with_savings,
    from,
    to,
  };

  return buildResponse(data, {
    claim_kind: "EXPERIMENTAL",
    n: recs.with_savings,
    window: { from, to },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "Modeled headroom — if every open recommendation were applied; built from unvalidated per-detector fractions.",
    },
  });
}
