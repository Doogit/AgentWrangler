# ADR-107: Burn Forecast Model

**Status:** accepted · **Date:** 2026-08-21
**Spike:** S7 limit observability
**Decision by:** S7 spike findings + Opus disposition 2026-08-21 (below).

---

## Opus disposition (2026-08-21)

Accept the recommended defaults; the three flagged items are optional Settings/UI enhancements
that do not gate the model or Phase-1b — defer them to the Phase 1 Settings/UI design.

- **Defaults adopted now:** trailing **1-day** window (D-3), warning at **ETA ≤ 2 days** (D-4),
  **total-token** metric labeled **`PROXY`** (D-2), forecast **disabled until the user sets
  `:limit_tokens`** (D-1), and the **C-02 clamp** (`EXCEEDED` state → NULL ETA, D-5) — accepted as-is.
- **D-1 FLAG (browser-assisted `claude.ai/api/oauth/usage` sync):** ~~deferred to Phase 1 Settings~~
  **RESOLVED by [ADR-111](ADR-111-limit-calibration.md) (2026-08-24).** No per-plan cap table is needed:
  `:limit_tokens` is *calibrated* from `seven_day.utilization` × measured local tokens, with manual
  entry as fallback (endpoint 429s for some Max users). See ADR-111.
- **D-2 FLAG (dual-metric display):** deferred to Phase 1 UI. Default single total-token PROXY
  forecast is sufficient for MVP.
- **D-3 FLAG (user-configurable window):** deferred to Phase 1 Settings. Ship the empirical 1-day
  default; expose config only if users ask.

---

## Context

S7 empirically validated:
1. No official usage/limit signal is accessible from local `~/.claude/**` files.
2. The trailing-rate model (calibrated on the exhaustion week) fires a ≥24h-ahead warning
   by Day 3, meeting the S7 and §15 success criteria.
3. Adversarial finding C-02 (forecast produces a past date once limit exceeded) is reproduced
   and requires a clamp rule.

All numbers in this ADR are aggregates from the S7 corpus scan; no transcript content.

---

## Decisions

### D-1 Official limit signal: does not exist locally

**Finding:** No local file in `~/.claude/**` stores usage quota, weekly utilization, or reset time.
Official signals require authenticated external access:
- `https://claude.ai/api/oauth/usage` — web endpoint returning `five_hour.utilization` and
  `seven_day.utilization` (fractional 0–1). Requires browser OAuth session; not scriptable
  without user credentials. Confirmed by S7 census.
- Anthropic Rate Limits API (`https://api.anthropic.com/v1/organizations/rate_limits`) —
  returns configured limits (RPM/ITPM by model tier), not current usage. Requires Admin API key.
- API response headers (`anthropic-ratelimit-tokens-remaining`, etc.) — ephemeral per-request;
  not stored in transcript JSONL.

**[FLAG — Opus decision requested]:** Should AgentWrangler offer a browser-assisted setup
flow to read the current `seven_day.utilization` from `claude.ai/api/oauth/usage` as part of
the Settings → Limit configuration screen? This would let the user sync their actual remaining
allowance into a stored `:limit_tokens` value (converted from utilization fraction × plan cap).
The plan cap itself is not exposed by the API, so a "known cap values per plan" table would
also be required, with a manual override.

**Interim policy (implemented):** `:limit_tokens` is user-configured. The dashboard labels
the burn forecast `PROXY` to distinguish it from a billing-authoritative figure. Default is
no limit (forecast disabled) until the user configures it in Settings.

### D-2 Forecast token metric

Use **total tokens** (`input_tokens + output_tokens + cache_read_input_tokens +
cache_creation_input_tokens`) as the forecast metric, matching the existing spec query.

Rationale: Although cache reads do not count toward API ITPM rate limits (per Anthropic docs),
Claude Code subscription limits correlate with total compute engaged (context × turns),
not just uncached tokens. The total-token metric is therefore a better proxy for subscription
utilization. The billing-relevant metric (`input + output + cache_write`, excluding cache reads)
covers only ~2% of the 5-day corpus total — far too small to forecast subscription exhaustion.

**[FLAG — Opus decision requested]:** Should the dashboard show BOTH metrics (total-token
forecast and billing-relevant-token forecast) to allow the user to calibrate which better
matches their observed subscription resets? This adds UI complexity but improves transparency.

> **Reconciliation — 2026-08-25 (external research pass).** The D-2 "total tokens" metric weights cache
> reads at **full (1×)** against the cap — this is the research's **upper-bound regime**. The 2026-08-25
> economics brief finds the more-likely cap weight for cache reads is the **cached rate (~0.1×)**, though
> the coefficient is **unverified** (Anthropic never published it; community reports dispute it, some
> alleging ~full-rate). Resolution (adopted in `spec-recommendations-engine.md` §W0.1): make the
> cache-read weight a **runtime config constant `COEFF` (default 0.1, flagged unverified)** and compute a
> **cap-weighted** forecast `full(cache_write_*) + COEFF×cache_read + full(input+output)`; the current
> full-weight total is the `COEFF=1` end of that same expression. This **answers this FLAG**: ship the
> cap-weighted forecast as default and let the user calibrate `COEFF` against observed resets — one metric,
> one knob, rather than two separate metrics. Note D5's full-weight forecast **over-warns** (conservative)
> until calibrated, which is the safe direction for a limit-burn warning.

### D-3 Trailing window: 1 day (24h) recommended

| Window | Day-1 ETA | Day-3 ETA | First warning day | Warning responsiveness |
|---|---|---|---|---|
| 1-day | 4.06 d | 0.37 d | Day 3 | High — reacts to today's rate |
| 2-day | 4.06 d | 0.63 d | Day 3 | Moderate — smooths two days |
| 3-day | 4.06 d | 0.71 d | Day 3 | Lower — lags burst days |

All three windows fire on Day 3 (the first day where remaining < current rate × 1d).
The 1-day window is most responsive to burst days (the scenario that caused the incident).

**Recommended value:** trailing 1 day (24h). Rationale: The exhaustion-week corpus shows
a 5.4× day-3 surge. A 1-day window adapts to the surge within the same day. Longer windows
understate the rate during a spike, potentially delaying the warning by hours within day 3.

**[FLAG — Opus decision requested]:** Should the trailing window be user-configurable
(1d/2d/3d)? The 1d recommendation is empirically grounded but a conservative engineer might
prefer 3d for stability. A config option adds flexibility at the cost of a less obvious default.

### D-4 Warning threshold: ETA ≤ 2 days

The warning fires when `projected_remaining_days ≤ 2.0`.

Rationale:
- A 24h threshold (ETA ≤ 1d) matches the intra-day crossover analysis but gives no buffer
  if the user is in the middle of a session and cannot act immediately.
- A 48h threshold (ETA ≤ 2d) fires approximately 1–2 days before exhaustion at typical
  daily rates, giving actionable lead time without too many false positives on light days.
- The exhaustion-week corpus: with the 24h threshold, the warning fires ~9h into day 3;
  with the 48h threshold, the warning fires earlier in day 3 with 24–48h of lead time.
- At Day 1 rate (450M tokens/day) and a 2.28B-token limit, ETA = 5.06 days → no spurious
  warning on a normal day.

**Recommended value:** warning threshold = ETA ≤ 2 days.

### D-5 C-02 resolution: clamp rule for exceeded-limit case

**Finding (from adversarial review C-02 and S7 simulation):** When `tok ≥ :limit_tokens`,
the expression `(:limit_tokens − tok) / rate` is negative, producing a Julian day in the past.
The simulation confirms: Day 5 (08-18) shows `remaining = −566,800,537` and ETA = −1.

**Clamp rule (mandatory, before Phase 1 slice (b)):**

```sql
-- Revised burn forecast query
WITH burn AS (
  SELECT
    SUM(input_tokens + output_tokens + cache_read_tokens
        + cache_write_5m + cache_write_1h + cache_write_other) AS tok,
    MAX(0.25, (julianday('now') - julianday(:window_start)))   AS elapsed_days
  FROM turns WHERE ts >= :window_start
),
rate AS (
  SELECT
    tok / elapsed_days AS tokens_per_day,
    tok,
    elapsed_days
  FROM burn
)
SELECT
  tok                                                           AS tokens_used,
  tokens_per_day                                                AS trailing_rate,
  CASE
    WHEN tok >= :limit_tokens THEN 0
    ELSE :limit_tokens - tok
  END                                                           AS tokens_remaining,
  CASE
    WHEN elapsed_days < 0.25 THEN 'COLD_START'
    WHEN tok >= :limit_tokens THEN 'EXCEEDED'
    WHEN tokens_per_day = 0 THEN 'NO_BURN'
    WHEN ((:limit_tokens - tok) / tokens_per_day) > :warn_threshold_days THEN 'OK'
    ELSE 'WARNING'
  END                                                           AS forecast_state,
  CASE
    WHEN tok < :limit_tokens AND tokens_per_day > 0
    THEN julianday('now') + ((:limit_tokens - tok) / tokens_per_day)
    ELSE NULL
  END                                                           AS projected_exhaustion_jd
FROM rate;
```

**State machine:**

| `forecast_state` | Meaning | UI display |
|---|---|---|
| `COLD_START` | < 4h of data; rate unreliable | "Warming up (< 4h data)" |
| `EXCEEDED` | `tok ≥ limit_tokens` | "Limit exceeded — wait for reset" |
| `NO_BURN` | No turns recorded in window | "No activity" |
| `WARNING` | ETA ≤ `:warn_threshold_days` | "Warning: ~{ETA}d remaining" |
| `OK` | ETA > threshold | "{ETA}d remaining at current rate" |

**The `EXCEEDED` state replaces any past-date or negative display.** C-02 is resolved.

`projected_exhaustion_jd` is NULL when not computable (COLD_START, EXCEEDED, NO_BURN).
The UI converts Julian day to a human-readable date/time only when the field is non-NULL.

### D-6 S7 exit criteria scorecard

| Criterion (Spike Plan v2 S7 row) | Result |
|---|---|
| ADR: forecast model fixed (observed-signal or trailing-rate) | **trailing-rate** — no observed signal exists locally |
| Backtest shows ≥day-3 warning on exhaustion week | **PASS** — Day 3 (2026-08-16), all windows |
| OR documents why not and what margin is achievable | N/A — criterion met |
| C-02 clamp rule specified | **PASS** — `EXCEEDED` state; `projected_exhaustion_jd = NULL` |

**All S7 exit criteria: PASS.**

---

## Addressing M-02 (denominator floor refinement)

The spec's `MAX(0.25, julianday_diff)` denominator suppresses warnings on install day. This
ADR adds a `COLD_START` state that surfaces the condition explicitly rather than silently
underestimating the rate. The `0.25`-day floor is retained for the rate calculation; the
`COLD_START` label informs the user that the forecast is unreliable.

---

## Deferred

- ~~Browser-assisted `claude.ai/api/oauth/usage` sync (D-1 FLAG) — Phase 1 Settings screen scope.~~
  **Resolved — see [ADR-111](ADR-111-limit-calibration.md).**
- Dual-metric display (D-2 FLAG) — Phase 1 UI scope.
- User-configurable trailing window (D-3 FLAG) — Phase 1 Settings scope.
- Per-model limit forecasting (e.g., separate Opus vs Sonnet caps) — out of S7 scope.

---

## Sources cited

- `https://platform.claude.com/docs/en/api/rate-limits` — official rate limit docs; cache-read
  ITPM exclusion confirmed here.
- `https://www.aicodex.to/articles/claude-rate-limits-api` — Rate Limits API endpoint structure.
- `https://gist.github.com/monperrus/3ac4b303a84946bbeaf2b1123ee99491` — claude.ai/api/oauth/usage
  endpoint structure and `seven_day.utilization` field.
- S7 corpus scan: `spikes/s7-limit-backtest/s7-backtest.mjs` (all numbers reproduced here are
  aggregates from that scan; no transcript content).
