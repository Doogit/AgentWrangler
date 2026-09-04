/**
 * src/query/forecast.ts — BurnForecaster (ADR-107 §D-5, 5-state + OFF).
 *
 * The authoritative model is ADR-107 §D-5 (the Data Model §2 forecast block is
 * STALE). The state machine is pure arithmetic, so it lives in TypeScript rather
 * than SQL — this keeps `now` injectable (SQL `julianday('now')` is not) and
 * makes every state deterministically testable.
 *
 * Token metric (ADR-107 §D-2 as amended by the Data Model §2A cap meter): the
 * windowed sum is CAP-WEIGHTED via the shared `capWeightExprSql` helper —
 *   full(input + output + cache_write_5m + cache_write_1h + cache_write_other)
 *   + COEFF × cache_read_tokens            (COEFF default 0.1, UNVERIFIED)
 * so forecast burn matches what the T0 cap meter attributes. Cache-heavy windows
 * therefore yield LOWER burn than the old full-weight sum. Forecast still does
 * NOT filter provisional (burn = all compute engaged).
 *
 * Window: trailing 1 day (ADR-107 §D-3). elapsed_days = now - window_start where
 * window_start = MAX(now - 1d, earliest turn ts in the trailing window). On
 * install day (< 6h of data) that yields elapsed < 0.25 → COLD_START; once >1d of
 * history exists it saturates at 1d. This anchor choice is documented here because
 * the ADR SQL leaves how window_start yields COLD_START implicit (see M-02).
 *
 * Rate floor: MAX(0.25, elapsed_days) is used ONLY for the rate denominator, so a
 * near-zero elapsed never explodes the rate; the raw elapsed drives the COLD_START
 * test. Eval order (ADR-107 + WP2 spec): OFF → COLD_START → EXCEEDED → NO_BURN →
 * WARNING/OK. COLD_START is evaluated BEFORE EXCEEDED.
 */

import type { Db } from "../db/open.js";
import type { BurnForecast } from "./api/overview.js";
import { capWeightExprSql, resolveCapReadCoeff } from "./cap-weighted.js";

/** ADR-107 §D-4 default warning threshold (days). */
export const DEFAULT_WARN_THRESHOLD_DAYS = 2;
/** ADR-107 §D-3 trailing window (days). */
export const FORECAST_WINDOW_DAYS = 1;
/** ADR-107 §D-5 / M-02 elapsed floor for the rate denominator (days). */
export const ELAPSED_FLOOR_DAYS = 0.25;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Unix epoch (1970-01-01T00:00:00Z) as a Julian Day number. */
const UNIX_EPOCH_JD = 2440587.5;

/** Convert a Date to a Julian Day number (matching SQLite julianday()). */
export function toJulianDay(d: Date): number {
  return d.getTime() / MS_PER_DAY + UNIX_EPOCH_JD;
}

export interface ForecastComputeInput {
  /** Weekly token limit from user_config; null => OFF (forecast disabled). */
  limitTokens: number | null;
  /** Total tokens consumed over the trailing window. */
  tokensUsed: number;
  /** Raw elapsed days (now - window_start), unfloored — drives COLD_START. */
  elapsedDays: number;
  /** Julian day of `now`, for projected_exhaustion_jd. */
  nowJd: number;
  /** WARNING threshold in days (ADR-107 default 2). */
  warnThresholdDays: number;
}

/**
 * Pure state machine. Returns the BurnForecast DTO. Never throws.
 * See file header for the eval order and rate-floor rationale.
 */
export function computeForecast(input: ForecastComputeInput): BurnForecast {
  const { limitTokens, tokensUsed, elapsedDays, nowJd, warnThresholdDays } = input;

  // OFF — no limit configured.
  if (limitTokens === null) {
    return {
      state: "OFF",
      limit_tokens: null,
      tokens_used: tokensUsed,
      tokens_per_day: null,
      projected_exhaustion_jd: null,
      warn_threshold_days: warnThresholdDays,
    };
  }

  const ratePerDay = tokensUsed / Math.max(ELAPSED_FLOOR_DAYS, elapsedDays);

  // COLD_START — evaluated BEFORE EXCEEDED (ADR-107 eval order).
  if (elapsedDays < ELAPSED_FLOOR_DAYS) {
    return {
      state: "COLD_START",
      limit_tokens: limitTokens,
      tokens_used: tokensUsed,
      tokens_per_day: null,
      projected_exhaustion_jd: null,
      warn_threshold_days: warnThresholdDays,
    };
  }

  // EXCEEDED — over the limit; ETA is meaningless (would be a past date). C-02.
  if (tokensUsed >= limitTokens) {
    return {
      state: "EXCEEDED",
      limit_tokens: limitTokens,
      tokens_used: tokensUsed,
      tokens_per_day: ratePerDay,
      projected_exhaustion_jd: null,
      warn_threshold_days: warnThresholdDays,
    };
  }

  // NO_BURN — no tokens in the window; rate is zero, ETA undefined.
  if (ratePerDay === 0) {
    return {
      state: "NO_BURN",
      limit_tokens: limitTokens,
      tokens_used: tokensUsed,
      tokens_per_day: null,
      projected_exhaustion_jd: null,
      warn_threshold_days: warnThresholdDays,
    };
  }

  const etaDays = (limitTokens - tokensUsed) / ratePerDay;
  const projected = nowJd + etaDays;
  return {
    state: etaDays <= warnThresholdDays ? "WARNING" : "OK",
    limit_tokens: limitTokens,
    tokens_used: tokensUsed,
    tokens_per_day: ratePerDay,
    projected_exhaustion_jd: projected,
    warn_threshold_days: warnThresholdDays,
  };
}

/** Read the `limit_tokens` user_config value; null when unset/blank. */
export function readLimitTokens(db: Db): number | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = 'limit_tokens'").get() as
    | { value: string | null }
    | undefined;
  if (row === undefined || row.value === null || row.value === "") return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the `limit_provenance` user_config value; null when unset.
 * Written by calibrateLimit ("calibrated YYYY-MM-DD @ X%; cap-weighted …")
 * and applySettingsUpdate ("manual") — see src/query/settings-store.ts.
 */
export function readLimitProvenance(db: Db): string | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = 'limit_provenance'").get() as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

/**
 * Read the `limit_resets_at` user_config value; null when unset. Written by
 * calibrateLimit alongside limit_tokens. Lets the card place the elapsed-week
 * budget tick when a live oauth reading (burn-status) is unavailable.
 */
export function readLimitResetsAt(db: Db): string | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = 'limit_resets_at'").get() as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export interface ForecastFromDbOptions {
  /** Evaluation instant. Defaults to new Date(). */
  now?: Date;
  /** Override limit_tokens (else read from user_config). */
  limitTokens?: number | null;
  /** WARNING threshold days (default 2). */
  warnThresholdDays?: number;
  /** Trailing window days (default 1). */
  windowDays?: number;
}

/**
 * Additive metadata on the DB-derived forecast. The frozen `BurnForecast` DTO
 * (src/query/api/overview.ts) is unchanged — these fields ride along so UI and
 * detector evidence can label the figure honestly without a breaking change.
 */
export interface ForecastFromDbResult extends BurnForecast {
  /** Always true: tokens_used / tokens_per_day are CAP-WEIGHTED, not raw totals. */
  cap_weighted: boolean;
  /** The cache-read weight (COEFF) used; default 0.1, UNVERIFIED against real caps. */
  cap_read_coeff: number;
  /** Human-readable metric label carrying the unverified-COEFF caveat. */
  token_metric: string;
  /**
   * True when the stored limit_tokens appears to have been calibrated under the
   * PREVIOUS full-weight token meter (its provenance lacks the "cap-weighted"
   * marker introduced by commit beea3d2). Purely additive honesty flag — the
   * limit number itself is NEVER rescaled (that would fabricate data).
   */
  limit_scale_legacy: boolean;
  /** Short reason string when limit_scale_legacy is true; null otherwise. */
  limit_scale_note: string | null;
  /**
   * "low" when the stored limit was calibrated under 10% utilization (its
   * provenance carries the LOW CONFIDENCE marker from calibrateLimit); null
   * otherwise. Purely additive honesty flag for the card's chip.
   */
  limit_confidence: "low" | null;
  /** The calibrated weekly-window reset timestamp (limit_resets_at), or null. */
  limit_resets_at: string | null;
}

/**
 * Compute the burn forecast from the DB: sums CAP-WEIGHTED tokens over the
 * trailing window (cache reads × COEFF via `capWeightExprSql`, coeff resolved
 * from user_config), derives elapsed from the earliest turn in that window,
 * and runs the pure state machine. Provisional turns are deliberately included.
 */
export function forecastFromDb(db: Db, opts: ForecastFromDbOptions = {}): ForecastFromDbResult {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? FORECAST_WINDOW_DAYS;
  const warnThresholdDays = opts.warnThresholdDays ?? DEFAULT_WARN_THRESHOLD_DAYS;
  const limitTokens = opts.limitTokens !== undefined ? opts.limitTokens : readLimitTokens(db);

  const windowStartMs = now.getTime() - windowDays * MS_PER_DAY;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const nowIso = now.toISOString();

  const coeff = resolveCapReadCoeff(db);
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(${capWeightExprSql("turns", coeff)}), 0) AS tok,
              MIN(ts) AS first_ts
         FROM turns
        WHERE ts >= ? AND ts < ?`,
    )
    .get(windowStartIso, nowIso) as { tok: number; first_ts: string | null };

  // Anchor elapsed at the earliest turn in the window (bounded below by the
  // window start) so install-day data (< 6h) surfaces as COLD_START.
  const anchorMs =
    agg.first_ts !== null
      ? Math.max(windowStartMs, new Date(agg.first_ts).getTime())
      : windowStartMs;
  const elapsedDays = (now.getTime() - anchorMs) / MS_PER_DAY;

  // Legacy-scale detection (review P1): commit beea3d2 switched the burn meter
  // from full-weight token sums to cap-weighted (~10× lower for cache-heavy
  // users). A limit_tokens value calibrated under the OLD meter is still stored
  // in user_config and is now compared against cap-weighted burn, so states can
  // silently flip WARNING/EXCEEDED → OK. Calibration provenance written AFTER
  // beea3d2 contains the marker "cap-weighted"; older provenance does not.
  //
  // Decision: ANY stored provenance lacking the marker — including "manual"
  // (applySettingsUpdate) or a missing row — is treated as legacy-scale, because
  // a manual limit that predates the meter change is INDISTINGUISHABLE from a
  // fresh one. This is deliberately conservative: a false positive merely shows
  // an extra honest "re-run Calibrate" nudge, while a false negative would let
  // the forecast silently mis-state WARNING/EXCEEDED. The number itself is
  // never rescaled (that would fabricate data).
  const limitScaleLegacy =
    limitTokens !== null && !(readLimitProvenance(db) ?? "").includes("cap-weighted");
  const limitScaleNote = limitScaleLegacy
    ? "limit was calibrated under the previous full-weight meter; re-run Calibrate"
    : null;

  return {
    ...computeForecast({
      limitTokens,
      tokensUsed: agg.tok,
      elapsedDays,
      nowJd: toJulianDay(now),
      warnThresholdDays,
    }),
    cap_weighted: true,
    cap_read_coeff: coeff,
    token_metric:
      "cap-weighted tokens (input+output+cache-writes full weight; cache reads × COEFF — COEFF unverified)",
    limit_scale_legacy: limitScaleLegacy,
    limit_scale_note: limitScaleNote,
    limit_confidence: (readLimitProvenance(db) ?? "").includes("LOW CONFIDENCE") ? "low" : null,
    limit_resets_at: readLimitResetsAt(db),
  };
}
