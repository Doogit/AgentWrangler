/**
 * src/detector/benchmark-anchors.ts — BM4 public benchmark anchor constants.
 *
 * Static, cited reference points sourced from public Anthropic data.
 * These are display-only constants — NEVER a score input, NEVER stored.
 *
 * Re-verify when touched — $6→$13 is the precedent that these rot.
 *
 * SEC-101: only public aggregate/claim strings, no user data.
 */

export interface BenchmarkAnchor {
  /** Value in USD/day (enterprise API-billed population). */
  daily_usd: number;
  /** Human-readable label for the percentile. */
  label: string;
  /** Authoritative source URL. */
  source_url: string;
  /** ISO-8601 date when this anchor was verified. */
  fetched_date: string;
}

export interface CapImpactClaim {
  /** Claim string, verbatim from source. */
  claim: string;
  /** Attribution (platform + date). */
  source: string;
}

/** $13/day average (enterprise API-billed). Supersedes the old $6/day figure. */
export const DAILY_AVG_USD: BenchmarkAnchor = {
  daily_usd: 13,
  label: "avg/day",
  source_url: "https://code.claude.com/docs/en/costs",
  fetched_date: "2026-09-02",
};

/** $30/day p90 (enterprise API-billed). */
export const DAILY_P90_USD: BenchmarkAnchor = {
  daily_usd: 30,
  label: "p90/day",
  source_url: "https://code.claude.com/docs/en/costs",
  fetched_date: "2026-09-02",
};

/** Rate-limit cap-impact claim from official Anthropic post. */
export const CAP_IMPACT_CLAIM: CapImpactClaim = {
  claim: "<5% of subscribers",
  source: "official Anthropic X post, 2025-07-28",
};

/**
 * Mandatory caveat: anchor population is enterprise API-billed;
 * our own figure is a LIST_EQUIV subscription estimate — a reference
 * point, NOT like-for-like.
 */
export const ANCHOR_CAVEAT =
  "Benchmark figures are from enterprise API-billed users. " +
  "Your figure is a subscription-plan estimate (LIST_EQUIV) — a reference point, not a like-for-like comparison.";
