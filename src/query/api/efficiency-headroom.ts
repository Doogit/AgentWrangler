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
  /** Individual open modeled opportunities. They must never be summed as an attainable ceiling. */
  opportunities?: Array<{ rec_id: string; modeled_savings_u_per_wk: number }>;
  /** Σ modeled_savings_u_per_wk over open (PROPOSED|ADOPTED) recs with non-null savings, in µUSD/wk. */
  headroom_u_per_wk: number;
  /** Trailing-window Σ turns.cost_equiv_u (LIST_EQUIV), in µUSD. */
  actual_u_per_wk: number;
  /** Always null: modeled opportunities cannot form a combined efficiency percentage. */
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

interface OpportunityRow {
  rec_id: string;
  modeled_savings_u_per_wk: number;
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

  const opportunities = db
    .prepare(
      `SELECT rec_id, modeled_savings_u_per_wk
         FROM recommendations
        WHERE state IN ('PROPOSED', 'ADOPTED') AND modeled_savings_u_per_wk IS NOT NULL
        ORDER BY rec_id`,
    )
    .all() as OpportunityRow[];
  const headroom_u_per_wk = recs.sum_u ?? 0;
  const actual_u_per_wk = spend.actual_u;

  // Individual recommendation models overlap and their weekly horizon differs from
  // the trailing spend window, so a combined percentage would be misleading.
  const headroom_pct: number | null = null;

  const data: EfficiencyHeadroom = {
    opportunities,
    headroom_u_per_wk,
    actual_u_per_wk,
    headroom_pct,
    open_rec_count: recs.with_savings,
    from,
    to,
  };

  return buildResponse(data, {
    claim_kind: "EXPERIMENTAL",
    metric_definition_version: "esf-1",
    n: recs.with_savings,
    window: { from, to },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "Individual modeled weekly opportunities are not summed: recommendations can overlap and their weekly horizon differs from the trailing spend window.",
    },
  });
}
