/**
 * src/oauth/usage.ts — usage-limit types shared by the limits card, burn status and calibration.
 *
 * OAUTH-1 (2026-10-13): AgentWrangler no longer calls Anthropic's oauth/usage endpoint. Anthropic's
 * terms bar third-party apps from using the Claude Code OAuth token
 * (.claude/audits/2026-10-13-jms-p2-terms.md). Usage now comes from the Claude Code statusline
 * (src/query/limits/statusline.ts `readStatuslineUsage`).
 */

export interface OAuthUsagePeriod {
  /** Fraction 0–1; fraction of the period's compute allowance used. */
  utilization: number;
  /** ISO-8601 timestamp when this counter resets, or null for inactive windows. */
  resets_at: string | null;
}

/** Per-model utilization, normalized to the fraction 0–1 contract. */
export interface OAuthUsagePerModel {
  /** Model identifier. */
  model: string;
  /** Fraction 0–1; fraction of this model's allowance used. */
  utilization: number;
}

export interface OAuthUsageData {
  five_hour: OAuthUsagePeriod;
  seven_day: OAuthUsagePeriod;
  per_model?: OAuthUsagePerModel[];
}

export type OAuthUsageResult =
  | { ok: true; data: OAuthUsageData }
  | { ok: false; reason: string; status?: number; retryAfterSec?: number };

/** Type for injecting a custom usage reader (tests, stubs). */
export type UsageReader = () => Promise<OAuthUsageResult>;

/**
 * The limits card's primary reader now that there is no usage API: always fails, so the card serves
 * the statusline values with `source: "statusline"` (src/query/limits/index.ts statuslineFallback).
 */
export const noUsageApi: UsageReader = async () => ({
  ok: false,
  reason: "No recent usage reading from the Claude Code statusline. Set it up in Settings.",
});
