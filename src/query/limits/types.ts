/**
 * src/query/limits/types.ts — Usage-limits card model (overview-v2 §1).
 *
 * The fully computed hero-card model returned by GET /api/query/limits, so the
 * UI renders values and never computes pace/burn/projection itself. Formulas:
 * docs/design/overview/overview-v2.md §1.
 *
 * Privacy (SEC-101): percentages, timestamps, counts, and model identifiers
 * only. No OAuth token, no raw API body.
 */

export type PaceState = "on" | "ahead" | "over";
export type LimitsState = "connected" | "signed-out" | "rate-limited" | "error" | "loading";

export interface LimitRow {
  id: "session" | "weekly" | `weekly:${string}`;
  label: string; // "Current session", "Weekly · all models", "Weekly · Fable"
  windowHours: 5 | 168;
  usedPct: number; // 0–100
  resetsAt: string; // ISO
  hoursUntilReset: number;
  elapsedHours: number;
  pacePct: number;
  burnRate: number; // %/hr for session, %/day for weekly
  budgetRate: number; // 20 or 14.29
  paceState: PaceState;
  projection: { kind: "ends-at"; pct: number } | { kind: "hits-limit-in"; hours: number };
  headroomMultiple?: number; // per-model rows, only when ≥ 1.5
  /** No active window upstream (resets_at null); resetsAt/pace fields are placeholders. */
  idle?: true;
  /** Set only when the model's rows come from more than one source (USAGE-CLI). */
  source?: "statusline" | "cli";
  asOf?: string;
}

export interface LocalUsageHistory {
  basis: "cap-weighted";
  fiveHourTokens: number;
  sevenDayTokens: number;
  tokensPerDay: number | null;
  weeklyLimitTokens: number | null;
  weeklyUtilizationPct: number | null;
  projectedExhaustionAt: string | null;
  forecastState: "OFF" | "COLD_START" | "EXCEEDED" | "NO_BURN" | "WARNING" | "OK";
}

export type WeeklyMaxState = "ok" | "low-confidence" | "too-early" | "unavailable";

/** OV-12 Q2: implied max for one per-model weekly row (same rules as the all-models figure). */
export interface WeeklyMaxModel {
  id: `weekly:${string}`;
  label: string; // model family, e.g. "Fable"
  usedPct: number;
  impliedMaxSpendU: number | null;
  impliedMaxPwTokens: number | null;
  state: WeeklyMaxState;
}

/**
 * OV-12 U5: one past limit week's implied max, from its last reading ≥ 10% before the reset.
 * `spread` compares the week's readings ≥ 50% (whole-% rounding is small there); absent when < 2.
 */
export interface WeeklyHistoryWeek {
  resetsAt: string; // rounded to the hour (ISO)
  impliedMaxSpendU: number;
  impliedMaxPwTokens: number;
  usedPctAtSample: number;
  source: string; // limit_snapshots.source
  spread?: { readings: number; pct: number; minSpendU: number; maxSpendU: number };
}

/**
 * OV-12 U5: per-family weight fit (D6). `multiplier` scales the family's list-price spend; 1 =
 * list prices are right. Sonnet is the fixed reference. Diagnostic only.
 */
export interface WeightFitFamily {
  family: "Opus" | "Sonnet" | "Fable" | "Haiku";
  listWeight: [number, number]; // input list price ÷ Sonnet 5 input, lowest–highest version
  multiplier: number | null;
  status: "fitted" | "reference" | "too-little-use";
}

export interface WeightFit {
  readings: number;
  weeks: number;
  variedMix: boolean;
  ready: boolean;
  families: WeightFitFamily[];
  /** Largest deviation of a reading's implied max from the mean, % — at list prices, then fitted. */
  spreadListPct: number | null;
  spreadFittedPct: number | null;
}

/**
 * OV-12 U1: implied weekly max = spend so far this limit week ÷ weekly % used. Window is
 * [weekStart, asOf), provisional turns included. Values are null when the state has no figure;
 * week fields are null only when `unavailable`.
 */
export interface WeeklyMax {
  weekStart: string | null; // resetsAt − 168h (ISO)
  resetsAt: string | null;
  usedPct: number | null; // weekly all-models usedPct (0–100)
  spendSoFarU: number | null;
  impliedMaxSpendU: number | null;
  impliedMaxPwTokens: number | null; // impliedMaxSpendU ÷ REF_PRICE_U_PER_TOKEN
  stale: boolean;
  state: WeeklyMaxState;
  perModel?: WeeklyMaxModel[];
  /** OV-12 U5: past weeks with a max, newest first, within the 11 weeks before this one. Absent when none. */
  history?: WeeklyHistoryWeek[];
  /** OV-12 U5: largest same-week spread, % (3% floor). A smaller change is "no clear change". */
  noisePct?: number;
  /** OV-12 U5: this week vs the latest past week with a max. Only when state is "ok". */
  vsLastWeek?: { pct: number; clear: boolean; resetsAt: string; impliedMaxSpendU: number };
}

export interface LimitsModel {
  state: LimitsState;
  asOf: string; // ISO of the API response used
  stale: boolean; // true when serving last-good during 429/error
  retryInSec?: number; // rate-limited only
  plan?: string; // "Max 5x"
  /** Human-readable parse failure reason for the error state (no token values). */
  reason?: string;
  /**
   * Where the rows came from; "statusline" = the OV-7 fallback file, "cli" = `claude -p /usage` (USAGE-CLI).
   * Absent on older payloads. When sources mix, each row also carries its own `source` + `asOf`.
   */
  source?: "api" | "statusline" | "cli";
  /** A CLI call is in flight or the first reading hasn't landed yet: the card re-polls sooner. */
  pending?: boolean;
  /** Why the CLI reader isn't giving fresh data ("off" = toggle or AW_USAGE_CLI). Fixed enum, no CLI text. */
  cliReason?: "not_found" | "outdated" | "timeout" | "parse" | "guard" | "error" | "off";
  rows: LimitRow[];
  estimateVsActual?: { modelPct: number; actualPct: number; deltaPts: number };
  /** Local aggregate fallback. Never represents exact claude.ai plan usage. */
  localHistory: LocalUsageHistory;
  live: { sessions: number; runningSpendUsd: number };
  /** OV-12: absent on older daemons; present with state "unavailable" when there is no figure. */
  weeklyMax?: WeeklyMax;
}
