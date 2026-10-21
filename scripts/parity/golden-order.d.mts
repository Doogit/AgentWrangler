export const PINNED_SAFETY_DETECTOR_ID: string;
export function checkRankingOrder(view: {
  active?: unknown[];
  pinned_safety?: unknown[];
  friction_safety?: unknown[];
}): {
  ranked_count: number;
  inversion_count: number;
  null_in_ranked_count: number;
  h1_in_ranked_count: number;
  pinned_count: number;
  pinned_non_h1_count: number;
  friction_count: number;
  friction_non_null_count: number;
  friction_h1_count: number;
  ordered: boolean;
};
