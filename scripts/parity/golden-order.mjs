/**
 * G-Order — independent ranking-order check for the Recommendations spine (B5).
 *
 * Consumes the produced RecommendationsView (from listRecommendations) and asserts
 * the B5 ranking contract WITHOUT re-deriving savings: the ranked `active` list is
 * ordered by the card's formula estimate rank key DESC with no inversion, carries
 * only rankable recs, and places X-basis rows after every P/E/O/R row. The cost-free
 * high-consequence safety detector (H1) is pinned above the
 * list rather than mixed in, and null-$/wk recs live only in the Track-D
 * friction/safety lane. This is an ORDER oracle independent of the spine code that
 * produces the order.
 *
 * The report is numeric/boolean only (SEC-101 / ADR-112): safe to save or share.
 */

/** Detector id of the cost-free high-consequence safety guard that takes the pinned slot. */
export const PINNED_SAFETY_DETECTOR_ID = "H1";

function rankValue(card) {
  const value = card?.modeled_formula?.estimate?.rank_value_u_per_wk;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null) return null;

  const modeledSavings = card?.modeled_savings_u_per_wk;
  return typeof modeledSavings === "number" && Number.isFinite(modeledSavings)
    ? modeledSavings
    : null;
}

function basis(card) {
  return card?.modeled_formula?.estimate?.basis;
}

/**
 * @param {{active?: unknown[], pinned_safety?: unknown[], friction_safety?: unknown[]}} view
 * @returns numeric/boolean report — see field comments.
 */
export function checkRankingOrder(view) {
  const ranked = Array.isArray(view?.active) ? view.active : [];
  const pinned = Array.isArray(view?.pinned_safety) ? view.pinned_safety : [];
  const friction = Array.isArray(view?.friction_safety) ? view.friction_safety : [];

  // Adjacent inversion: X is always last; every other basis shares one descending
  // rank-value scale.
  let inversion_count = 0;
  for (let i = 1; i < ranked.length; i += 1) {
    const previousCard = ranked[i - 1];
    const currentCard = ranked[i];
    const prev = rankValue(previousCard);
    const cur = rankValue(currentCard);
    if (
      (basis(previousCard) === "X" && basis(currentCard) !== "X") ||
      (basis(previousCard) !== "X" &&
        basis(currentCard) !== "X" &&
        prev !== null &&
        cur !== null &&
        cur > prev)
    ) {
      inversion_count += 1;
    }
  }

  // P/E/O/R rows must carry rank values. X is intentionally unranked and belongs
  // only at the tail of the list. H1 belongs above the list, not in it.
  let null_in_ranked_count = 0;
  let h1_in_ranked_count = 0;
  for (const card of ranked) {
    if (basis(card) !== "X" && rankValue(card) === null) null_in_ranked_count += 1;
    if (card?.detector_id === PINNED_SAFETY_DETECTOR_ID) h1_in_ranked_count += 1;
  }

  // Pinned slot holds only the high-consequence safety detector.
  let pinned_non_h1_count = 0;
  for (const card of pinned) {
    if (card?.detector_id !== PINNED_SAFETY_DETECTOR_ID) pinned_non_h1_count += 1;
  }

  // Track-D friction lane holds only null-$/wk recs, and never the pinned safety detector.
  let friction_non_null_count = 0;
  let friction_h1_count = 0;
  for (const card of friction) {
    if (rankValue(card) !== null) friction_non_null_count += 1;
    if (card?.detector_id === PINNED_SAFETY_DETECTOR_ID) friction_h1_count += 1;
  }

  const ordered = inversion_count === 0 && null_in_ranked_count === 0 && h1_in_ranked_count === 0;

  return {
    ranked_count: ranked.length,
    inversion_count,
    null_in_ranked_count,
    h1_in_ranked_count,
    pinned_count: pinned.length,
    pinned_non_h1_count,
    friction_count: friction.length,
    friction_non_null_count,
    friction_h1_count,
    ordered,
  };
}
