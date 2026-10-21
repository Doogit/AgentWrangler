/**
 * src/query/api/efficiency-headroom.ts — BM2 efficiency headroom.
 *
 * P3.L L6: addressable spend is the WHOLE spend lane — billed spend in [from, to) owned by
 * ANY spend-lane claim on the exclusive claim ledger, not only claims of open PROPOSED recs.
 * Each priced token cell is counted at most once (net of overlaps). The reliability lane
 * (failure-family detectors) is a separate lane and is never counted here.
 *
 * FR-REC-103 is respected: this is a SEPARATE surface from listRecommendations,
 * which still never sums modeled savings into an "achieved" total.
 *
 * SEC-101: uses billed token counts and aggregate recommendation contracts only.
 */

import type { Db } from "../../db/open.js";
import {
  CLAIM_PRODUCERS,
  type ClaimProducer,
  SPEND_LANE_DETECTOR_IDS,
  buildClaimLedger,
} from "../../detector/claim-ledger.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import {
  type PersistedRecommendationContractRow,
  trustedRecommendationContract,
} from "../recommendation-contract.js";

export interface EfficiencyHeadroom {
  /** Individual open modeled opportunities. They must never be summed as an attainable ceiling. */
  opportunities?: Array<{ rec_id: string; modeled_savings_u_per_wk: number }>;
  /** Billed spend owned by the whole spend lane in [from, to), in integer micro-USD. */
  headroom_u_per_wk: number;
  /** Trailing-window Σ turns.cost_equiv_u (LIST_EQUIV), in µUSD. */
  actual_u_per_wk: number;
  /** headroom_u_per_wk / actual_u_per_wk as a percentage (0–100); null when actual is 0. */
  headroom_pct: number | null;
  /** Open recs contributing a non-null savings figure. */
  open_rec_count: number;
  /** Open recs whose detector has a spend-lane producer but no claim in the window. */
  unclaimed_rec_count: number;
  from: string;
  to: string;
}

interface SpendRow {
  actual_u: number;
}

interface OpportunityRow extends PersistedRecommendationContractRow {
  rec_id: string;
  scope_workspace_id: string | null;
  modeled_savings_u_per_wk: number | null;
}

/**
 * Attribute selected-window billed spend to the current open recommendation set.
 */
export function getEfficiencyHeadroom(
  db: Db,
  opts: { from: string; to: string },
  producers: readonly ClaimProducer[] = CLAIM_PRODUCERS,
): ApiResponse<EfficiencyHeadroom> {
  const { from, to } = opts;

  const recommendationRows = db
    .prepare(
      `SELECT rec_id, detector_id, scope_workspace_id, category, lever, target_metric,
              modeled_savings_u_per_wk, evidence_json,
              contract_version, template_id, contract_status, rule_id
        FROM recommendations
        WHERE state = 'PROPOSED'
          AND CASE WHEN json_valid(evidence_json) THEN
            COALESCE(json_extract(evidence_json, '$.facts.weeks_ago'),
                     json_extract(evidence_json, '$.recency.weeks_ago'), 0) = 0
            AND COALESCE(json_extract(evidence_json, '$.facts.weeks_fired'),
                         json_extract(evidence_json, '$.recency.weeks_fired'), 1) > 0
          ELSE 0 END
        ORDER BY rec_id`,
    )
    .all() as OpportunityRow[];
  const opportunities = recommendationRows.flatMap((row) =>
    trustedRecommendationContract(row) !== null && row.modeled_savings_u_per_wk !== null
      ? [{ rec_id: row.rec_id, modeled_savings_u_per_wk: row.modeled_savings_u_per_wk }]
      : [],
  );

  const spend = db
    .prepare(
      `SELECT COALESCE(SUM(cost_equiv_u), 0) AS actual_u
         FROM turns
        WHERE ts >= ? AND ts < ? AND provisional = 0`,
    )
    .get(from, to) as SpendRow;

  const openRecIds = new Set(opportunities.map((opportunity) => opportunity.rec_id));
  const openRecs = recommendationRows.filter(
    (row) => openRecIds.has(row.rec_id) && row.detector_id !== null,
  ) as Array<OpportunityRow & { detector_id: string }>;
  const ledger = buildClaimLedger(db, { now: new Date(to), fromIso: from, toIso: to }, producers);
  const spendLaneClaims = ledger.claims.filter((claim) => claim.lane === "spend");
  const headroom_u_per_wk = Math.round(
    spendLaneClaims.reduce((sum, claim) => sum + claim.value_u, 0),
  );
  const claimedRecIds = new Set(
    spendLaneClaims.flatMap((claim) => (claim.recId === undefined ? [] : [claim.recId])),
  );
  const unclaimed_rec_count = openRecs.filter(
    (row) => SPEND_LANE_DETECTOR_IDS.has(row.detector_id) && !claimedRecIds.has(row.rec_id),
  ).length;
  const actual_u_per_wk = spend.actual_u;

  // P3.L L6: the whole spend lane cannot exceed billed actual spend (each token counted once),
  // so a share of trailing-window spend is a safe combined percentage.
  const headroom_pct: number | null =
    actual_u_per_wk > 0 ? (headroom_u_per_wk / actual_u_per_wk) * 100 : null;

  const data: EfficiencyHeadroom = {
    opportunities,
    headroom_u_per_wk,
    actual_u_per_wk,
    headroom_pct,
    open_rec_count: opportunities.length,
    unclaimed_rec_count,
    from,
    to,
  };

  return buildResponse(data, {
    claim_kind: "EXPERIMENTAL",
    metric_definition_version: "esf-1",
    n: opportunities.length,
    window: { from, to },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "Addressable spend: the whole spend lane on the claim ledger in this window (each token counted once, net of overlaps, so it cannot exceed actual spend) — not only claims of currently open recommendations. Recommendations without ledger claims count 0. Failure-family claims are a separate reliability lane and are not counted.",
    },
  });
}
