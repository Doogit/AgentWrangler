# ADR-111: Weekly-Limit Calibration (resolves ADR-107 D-1 FLAG)

**Status:** accepted · **Date:** 2026-08-24
**Resolves:** ADR-107 D-1 FLAG (browser-assisted `oauth/usage` sync), previously *deferred to Phase 1 Settings*.
**Decision by:** Opus disposition 2026-08-24, on external verification of the current (Aug 2026) limit surface.

---

## Context

WP4 shipped `:limit_tokens` as a **user-typed constant** (`settings-store.ts`), and the Burn Forecast
card stays `● OFF` until it is set. This raised the practical question: *what number does a user type?*

External verification (Aug 2026) confirms there is **no number to look up**:

1. **Anthropic never publishes weekly limits as token counts.** They are surfaced to users only as a
   *utilization %* and a reset time (Settings → Usage; `/usage` in Claude Code). ADR-107 D-1 already
   found no local file exposes a token quota.
2. **The cap drifts.** A temporary **+50% boost applied to all paid plans through 2026-08-31**; the
   "weekly" window is reported to reset on a ~72h cadence for some accounts rather than a clean 7 days;
   the real limit is **compute-weighted** (context × turns), not a pure token count.

Therefore a hardcoded per-plan token cap is wrong for the next user and wrong again next month.
Shipping one into an open-source tool would manufacture false precision. `:limit_tokens` must be a
**calibrated proxy**, not a looked-up constant — which is exactly why ADR-107 labels the forecast `PROXY`.

The signal ADR-107 D-1 found is still the right one: `GET https://api.anthropic.com/api/oauth/usage`
returns `five_hour.utilization` and `seven_day.utilization` (fractions 0–1) plus `resets_at`. It reads
the user's own browser session locally; no data leaves the machine.

---

## Decision

**`:limit_tokens` is derived by calibration, not entered as a hunted-down constant.** AgentWrangler
already measures the user's own tokens locally, so the token-equivalent cap is *back-calculated* from a
single utilization reading — without waiting to hit the wall:

```
limit_tokens  ≈  tokens_consumed_in_current_weekly_window  /  seven_day.utilization
```

- **`tokens_consumed_in_current_weekly_window`** — total tokens (ADR-107 D-2 metric:
  `input + output + cache_read + cache_creation`) summed over turns since the window start.
- **Window start** — the endpoint's own `seven_day.resets_at` minus one window, **not** an assumed 7 days
  (the reset cadence is account-specific and not a clean week).
- **`seven_day.utilization`** — read once from `oauth/usage` when it is meaningfully non-zero.

The result **self-corrects**: when Anthropic changes the cap or a boost expires, the user re-calibrates
and `:limit_tokens` moves with the new reality. It stays a `PROXY` (compute-weighted reality ≠ pure
tokens), which the dashboard already labels.

### Two paths, primary + fallback

1. **Primary — auto-calibrate.** Settings reads `seven_day.utilization` + `resets_at` from `oauth/usage`,
   pairs it with measured tokens in that window, derives `:limit_tokens`, and stores it with a
   "calibrated {date}, {util}% at read" provenance line and a **Re-calibrate** action.
2. **Fallback — manual entry.** Today's flow, unchanged. Required because the endpoint is **currently
   flaky** — persistent HTTP 429 for some Max users (Claude Code issues #30930, #31021) — so
   auto-calibrate must degrade gracefully to a typed number, never hard-fail.

### Guards (mandatory)

- **Stable division:** only auto-calibrate when `seven_day.utilization ≥ 0.10`. Below that, a small
  reading error blows up the derived cap; prompt the user to run some work first or enter manually.
- **429 / no session:** on any non-200 from `oauth/usage`, fall back to manual entry with a one-line
  reason. Never block Settings on the endpoint.
- **Re-calibration prompt:** when a new weekly window has started since the stored provenance date,
  surface a non-blocking "cap may have shifted — re-calibrate?" hint (caps drift; boosts expire).

---

## Repeatable process (open-source users)

This is the documented method other users follow — no per-plan cap table to maintain, no number to guess:

1. Use Claude Code / Claude for the day as normal so `seven_day.utilization` climbs above ~10%.
2. In **Settings → Limit**, click **Calibrate**. AgentWrangler reads your own `oauth/usage` utilization
   + reset time, sums your measured tokens in that window, and computes `:limit_tokens` for you.
3. If the read fails (429 / not logged in), enter any known number manually — the forecast still runs,
   just less precisely.
4. Re-calibrate when prompted at each new weekly window, or after an Anthropic limit change.

---

## Consequences

- `:limit_tokens` gains provenance (`calibrated` vs `manual`) — a Settings/DTO field, wired in the
  follow-up work (see phase-1a plan "Follow-up work (post-WP4)"). Docs-only in this ADR; no code changed here.
- Forecast remains `PROXY`; this ADR does not upgrade it to billing-authoritative.
- **Out of scope (future):** the separate **Opus weekly sub-cap** is not modeled — `oauth/usage`
  exposes only the aggregate `seven_day` counter, so per-model calibration is deferred (ADR-107 already
  lists per-model limit forecasting as out of scope).

---

## Sources cited

- `https://api.anthropic.com/api/oauth/usage` — `five_hour` / `seven_day` `utilization` + `resets_at`
  fields (same endpoint ADR-107 D-1 cited via the monperrus gist).
- Claude Code issues **#30930**, **#31021** — persistent 429 on `oauth/usage` for Max users (fallback rationale).
- Anthropic usage-limit changes, 2026 — temporary **+50% weekly boost through 2026-08-31**; account-fixed
  reset time; community-observed ~72h "weekly" reset cadence.
- ADR-107 (D-1, D-2) — no local quota file; total-token forecast metric; `PROXY` labeling.
