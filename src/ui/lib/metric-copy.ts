/**
 * src/ui/lib/metric-copy.ts
 *
 * Canonical tooltip copy for every metric id used in the dashboard.
 * Each entry answers three questions in ≤ 3 sentences:
 *   what  — what the metric measures
 *   read  — how to interpret it (is high good or bad?)
 *   act   — what to do about it
 *
 * Ids must match the metric ids defined in docs/design/overview/overview-v2.md Appendix A.
 */

export type MetricId =
  | "limit.session"
  | "limit.weekly"
  | "limit.weekly.model"
  | "spend.equiv"
  | "spend.tokens"
  | "spend.weekly_max"
  | "limits.weight_fit"
  | "sessions.count"
  | "ctx.output_share"
  | "cache.misses"
  | "weight.listprice"
  | "weight.cap"
  | "chart.spend_by_day"
  | "chart.tokens_by_type"
  | "table.context_per_turn"
  | "ws.best_next";

export interface MetricCopy {
  /** What the metric measures. */
  what: string;
  /** How to read it — is high good or bad? */
  read: string;
  /** What to do when it looks off. */
  act: string;
}

export const METRIC_COPY: Record<MetricId, MetricCopy> = {
  "limit.session": {
    what: "Rolling 5-hour window shared by all models on your claude.ai plan.",
    read: "The pace marker shows even spending (20%/hr); below pace means you will finish with headroom, above means you may hit the limit early.",
    act: "If you are ahead of pace and running out of headroom, use /clear between tasks to reset context and slow consumption.",
  },
  "limit.weekly": {
    what: "7-day rolling cap across all models; budget pace is 14.3%/day.",
    read: "This is what claude.ai enforces — our estimate only models it, so treat the difference as a calibration signal, not a second source of truth.",
    act: "When the estimate is more than 10 points off the API value, open Settings → Calibration to check your cap coefficient.",
  },
  "limit.weekly.model": {
    what: "Model-specific weekly cap; only shown for models that have their own separate limit.",
    read: "Headroom shown is relative to this model's cap, not the all-models cap — you may have room here even when the weekly total is near its limit.",
    act: "If one model's cap is a bottleneck, switching tasks to a different model can preserve weekly headroom.",
  },
  "spend.equiv": {
    what: "Tokens × API list price for this window.",
    read: "A comparison figure, not your bill on Max or Team plans.",
    act: "If it rises, check whether useful output grew too.",
  },
  "spend.tokens": {
    what: "The same spend as the $ tab, in Sonnet-equivalent tokens: each model's tokens weighted by its API list price (Fable ≈ 4×, Opus ≈ 1.5–2×, Haiku ≈ ⅓ of Sonnet).",
    read: "It assumes Anthropic counts usage like API pricing; unverified. Not a raw token count.",
    act: "Use it to compare windows and models in one unit; switch to $ for the list-price cost.",
  },
  "spend.weekly_max": {
    what: "Spend this week ÷ weekly % used = spend at 100%.",
    read: "Reset to reset, not the window above. Noisy early in the week.",
    act: "Near 100%? Slow down or use a cheaper model.",
  },
  "limits.weight_fit": {
    what: "Per-model weights that make the weekly max flattest.",
    read: "1× = list price is right.",
    act: "Diagnostic only; nothing else uses it.",
  },
  "sessions.count": {
    what: "Transcripts ingested in the selected window. The change vs prior, bar, Top 3, median and average cover reconciled sessions that started in the window (live sessions are not included), at list-price equivalent.",
    read: "Top 3 is the three costliest sessions' share of that spend. A median far below the average means a few expensive sessions drive the spend.",
    act: "Click 'Most expensive' to open the costliest sessions. On 24h and 30d it opens Sessions by cost, which lists sessions active in the window (including ones started earlier).",
  },
  "ctx.output_share": {
    what: "Output tokens divided by total context tokens per turn, for the worst-performing model.",
    read: "Below about 1% means each turn is mostly re-reading history rather than generating new content — efficiency is poor.",
    act: "Use /clear between tasks to reset context and raise output share; long sessions without /clear are the most common cause of low ratios.",
  },
  "cache.misses": {
    what: "Turns where cache writes spiked while cache reads dropped — each re-uploads context at full input price.",
    read: "Fewer is better; a spike in misses on a day explains why spend-equivalent rose without more sessions.",
    act: "Look at the sessions listed under 'Which sessions' to find transcripts with frequent context resets and consider shorter sessions.",
  },
  "weight.listprice": {
    what: "Published API multipliers relative to base input price for each token type.",
    read: "These are exact: cache read 0.1×, cache write 1.25–2×, fresh input 1×, output 5×.",
    act: "High output weight means each generated token costs 5× an input token — minimising unnecessary output reduces list-price spend.",
  },
  "weight.cap": {
    what: "Share of subscription limit consumed per token, by type — unpublished; 0.1× for cache reads is a community estimate.",
    read: "Unverified: Anthropic has not published these coefficients, so actual cap consumption may differ.",
    act: "If the estimate drifts far from the API value, adjust the cap coefficient in Settings → Calibration.",
  },
  "chart.spend_by_day": {
    what: "List-price value of each day's tokens, stacked by workspace.",
    read: "Days that are taller than expected relative to your session count suggest cache misses or large context; tabs show cap-weighted tokens (what counts toward your limit) and cache writes (spikes indicate misses).",
    act: "Click a tall day to filter Sessions to that date and find the sessions driving the spike.",
  },
  "chart.tokens_by_type": {
    what: "Share of the window's total tokens broken down by type (cache read, cache write, input, output).",
    read: "Cache reads dominating is normal for long sessions; the weight columns show what each type costs relative to the basis you selected.",
    act: "If output tokens are a large share, look for sessions that generate verbose responses; if cache writes dominate, you may have frequent context resets.",
  },
  "table.context_per_turn": {
    what: "Average context and output tokens per turn, broken down by model.",
    read: "Output share under about 1% means each turn is mostly history — the model is re-reading far more than it generates.",
    act: "Models with the lowest output share are the best candidates for shorter sessions with regular /clear calls.",
  },
  "ws.best_next": {
    what: "Highest-ranked active recommendation scoped to this workspace.",
    read: "Experimental: the ranking is modeled from observed token patterns and may not reflect your actual priorities.",
    act: "Review the recommendation before acting — the detail view shows the evidence and estimated impact.",
  },
};
