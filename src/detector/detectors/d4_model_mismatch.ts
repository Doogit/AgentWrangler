/**
 * src/detector/detectors/d4_model_mismatch.ts — D4 MODEL_MISMATCH.
 *
 * Fires PER-WORKSPACE when a sustained fraction of Opus turns in the trailing
 * week match the "high-context, low-output" pattern — turns where Opus is reading
 * a large context but producing little output, a signal that Sonnet could serve
 * those turns at substantially lower cost.
 *
 * Conservative thresholds (all UNVALIDATED defaults, labeled in every rec):
 *   min_opus_turns:      5     — cold-start guard; avoids firing on sparse data
 *   mismatch_fraction:  40%    — sustained pattern, not isolated Opus use
 *   min_context_tokens: 50,000 — well above trivial lookups; below Opus-4-8 avg 155K
 *   max_output_tokens:    500  — short answer from large context ≈ lookup style
 *
 * False-positive guard: only turns where BOTH conditions hold (large context AND
 * small output) are flagged. Opus turns with large output, or turns below the
 * context threshold, are never counted as mismatch — preserving legitimate
 * architecture/reasoning/security use of Opus.
 *
 * Savings model: per-turn cost differential (Opus − Sonnet) on mismatch turns,
 * scaled by mismatch_turns_per_week × reduction_fraction (0.50 UNVALIDATED).
 * Prices are derived from pricing_snapshots, not hard-coded. Falls back to
 * LIST_PRICES when no snapshot is present for a tier.
 *
 * scopeKey: "D4|<workspace_id>" — one rec per workspace per window.
 */

import type { Db } from "../../db/open.js";
import { LIST_PRICES } from "../../ingest/pricing.js";
import {
  D4_MISMATCH_MAX_OUTPUT_TOKENS,
  D4_MISMATCH_MIN_CONTEXT_TOKENS,
  D4_MISMATCH_MIN_FRACTION,
  D4_OPUS_MIN_TURNS,
  D4_REDUCTION_FRACTION,
  d4Savings,
} from "../savings.js";
import type { Detector, DetectorContext, DetectorOutcome, Fired } from "../types.js";

/**
 * Fallback prices from LIST_PRICES when pricing_snapshots is missing a tier.
 * Sonnet uses the sonnet-4 tier as the conservative routing target — its higher
 * base rate ($3/$15 vs sonnet-5's $2/$10) yields the smaller Opus−Sonnet
 * differential, so the modeled routing savings are never overstated (BM0).
 */
const OPUS_INPUT_FALLBACK = LIST_PRICES.opus?.[0] ?? 5;
const OPUS_OUTPUT_FALLBACK = LIST_PRICES.opus?.[1] ?? 25;
const SONNET_INPUT_FALLBACK = LIST_PRICES["sonnet-4"]?.[0] ?? 3;
const SONNET_OUTPUT_FALLBACK = LIST_PRICES["sonnet-4"]?.[1] ?? 15;

interface WorkspaceRow {
  workspace_id: string;
}

interface OpusTurnCounts {
  total_opus: number;
  mismatch_count: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
}

interface PriceRow {
  unit_prices_json: string;
}

interface PerModelSnapshot {
  captured_at: string;
  seven_day_util: number;
  five_hour_util: number;
  per_model: Array<{
    model: string;
    utilization: number;
  }>;
}

type CapEvidence =
  | {
      withheld: true;
      withheld_reason: string;
      title: string;
    }
  | {
      cap_attribution: "all_models_or_opus_binds";
    };

/** Read a fresh, well-formed /usage snapshot once; fail open on any problem. */
function getPerModelSnapshot(db: Db, now: Date): PerModelSnapshot | null {
  try {
    const row = db
      .prepare("SELECT value FROM user_config WHERE key = 'per_model_snapshot'")
      .get() as { value: unknown } | undefined;
    if (!row || typeof row.value !== "string") return null;

    const snapshot = JSON.parse(row.value) as unknown;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;

    const candidate = snapshot as Record<string, unknown>;
    if (
      typeof candidate.captured_at !== "string" ||
      typeof candidate.seven_day_util !== "number" ||
      !Number.isFinite(candidate.seven_day_util) ||
      typeof candidate.five_hour_util !== "number" ||
      !Number.isFinite(candidate.five_hour_util) ||
      !Array.isArray(candidate.per_model)
    ) {
      return null;
    }

    const capturedAtMs = Date.parse(candidate.captured_at);
    if (!Number.isFinite(capturedAtMs) || now.getTime() - capturedAtMs > 24 * 60 * 60 * 1000) {
      return null;
    }

    const perModel: PerModelSnapshot["per_model"] = [];
    for (const entry of candidate.per_model) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const model = entry as Record<string, unknown>;
      if (
        typeof model.model !== "string" ||
        typeof model.utilization !== "number" ||
        !Number.isFinite(model.utilization)
      ) {
        return null;
      }
      perModel.push({ model: model.model, utilization: model.utilization });
    }

    return {
      captured_at: candidate.captured_at,
      seven_day_util: candidate.seven_day_util,
      five_hour_util: candidate.five_hour_util,
      per_model: perModel,
    };
  } catch {
    return null;
  }
}

/** Parse a unit_prices_json array and return [input, output, cacheRead] prices. */
function parsePrices(json: string | null): [number, number] {
  if (!json) return [0, 0];
  try {
    const arr = JSON.parse(json) as number[];
    return [arr[0] ?? 0, arr[1] ?? 0];
  } catch {
    return [0, 0];
  }
}

/** Get the freshest pricing snapshot for a given model tier, or null. */
function getTierPrices(db: Db, tier: string): [number, number] | null {
  const row = db
    .prepare(
      `SELECT unit_prices_json FROM pricing_snapshots
        WHERE model_tier = ?
        ORDER BY stale_after DESC
        LIMIT 1`,
    )
    .get(tier) as PriceRow | undefined;
  if (!row) return null;
  return parsePrices(row.unit_prices_json);
}

export const d4Detector: Detector = {
  id: "D4",
  name: "MODEL_MISMATCH",

  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome {
    // Cap attribution is advisory metadata only; any read or parse failure fails open.
    const perModelSnapshot = getPerModelSnapshot(db, ctx.now);

    // All non-global workspaces with at least one turn in the window.
    const workspaces = db
      .prepare(
        `SELECT DISTINCT workspace_id
           FROM turns
          WHERE ts >= ? AND ts < ?
            AND model LIKE '%opus%'
            AND provisional = 0`,
      )
      .all(ctx.fromIso, ctx.toIso) as WorkspaceRow[];

    if (workspaces.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: "no Opus turns in window",
      };
    }

    // Resolve prices once (shared across all workspace evaluations).
    const opusPrices = getTierPrices(db, "opus");
    const sonnetPrices = getTierPrices(db, "sonnet-4");

    const opusInputPrice = opusPrices?.[0] ?? OPUS_INPUT_FALLBACK;
    const opusOutputPrice = opusPrices?.[1] ?? OPUS_OUTPUT_FALLBACK;
    const sonnetInputPrice = sonnetPrices?.[0] ?? SONNET_INPUT_FALLBACK;
    const sonnetOutputPrice = sonnetPrices?.[1] ?? SONNET_OUTPUT_FALLBACK;

    const fired: Fired[] = [];

    for (const { workspace_id } of workspaces) {
      // Count ALL Opus turns for this workspace in the window (denominator for fraction).
      const totalOpus = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM turns
              WHERE workspace_id = ?
                AND model LIKE '%opus%'
                AND ts >= ? AND ts < ?
                AND provisional = 0`,
          )
          .get(workspace_id, ctx.fromIso, ctx.toIso) as { n: number }
      ).n;

      // Cold-start guard: skip workspaces with too few Opus turns.
      if (totalOpus < D4_OPUS_MIN_TURNS) continue;

      // Count mismatch turns (high context AND low output).
      const mismatch = db
        .prepare(
          `SELECT
             COUNT(*) AS mismatch_count,
             AVG(input_tokens) AS avg_input_tokens,
             AVG(output_tokens) AS avg_output_tokens
           FROM turns
          WHERE workspace_id = ?
            AND model LIKE '%opus%'
            AND context_tokens >= ?
            AND output_tokens <= ?
            AND ts >= ? AND ts < ?
            AND provisional = 0`,
        )
        .get(
          workspace_id,
          D4_MISMATCH_MIN_CONTEXT_TOKENS,
          D4_MISMATCH_MAX_OUTPUT_TOKENS,
          ctx.fromIso,
          ctx.toIso,
        ) as OpusTurnCounts;

      const mismatchCount = mismatch.mismatch_count ?? 0;
      if (mismatchCount === 0) continue;

      const mismatchFraction = mismatchCount / totalOpus;
      if (mismatchFraction < D4_MISMATCH_MIN_FRACTION) continue;

      const avgInputTokens = Math.round(mismatch.avg_input_tokens ?? 0);
      const avgOutputTokens = Math.round(mismatch.avg_output_tokens ?? 0);

      const { savingsU, formula } = d4Savings(
        avgInputTokens,
        avgOutputTokens,
        mismatchCount,
        opusInputPrice,
        opusOutputPrice,
        sonnetInputPrice,
        sonnetOutputPrice,
        D4_REDUCTION_FRACTION,
      );

      // Skip zero-savings recs (e.g., prices not loaded). The computed figure is
      // retained as DIAGNOSTIC evidence only (see advisory gate below).
      if (savingsU <= 0) continue;

      // This is evidence for an already-fired D4 recommendation, not another
      // qualification rule. Keep its scope and time window aligned with D4.
      const sidechainPremiumTurns = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM turns
              WHERE workspace_id = ?
                AND model LIKE '%opus%'
                AND is_sidechain = 1
                AND ts >= ? AND ts < ?
                AND provisional = 0`,
          )
          .get(workspace_id, ctx.fromIso, ctx.toIso) as { n: number }
      ).n;

      const mismatchPct = Math.round(mismatchFraction * 100);
      const sonnetEntries = perModelSnapshot?.per_model.filter((entry) =>
        entry.model.toLowerCase().includes("sonnet"),
      );
      const bindingSonnet = sonnetEntries?.find(
        (entry) =>
          entry.utilization >= (perModelSnapshot?.seven_day_util ?? Number.POSITIVE_INFINITY),
      );
      const capEvidence: CapEvidence | undefined =
        bindingSonnet && perModelSnapshot
          ? {
              withheld: true,
              withheld_reason: `Sonnet weekly cap is the binding constraint (Sonnet util ${bindingSonnet.utilization} >= all-models ${perModelSnapshot.seven_day_util}) — routing Opus->Sonnet would worsen it`,
              title: `[withheld] Route Opus→Sonnet: ${mismatchPct}% of turns are high-context low-output`,
            }
          : perModelSnapshot && sonnetEntries && sonnetEntries.length > 0
            ? { cap_attribution: "all_models_or_opus_binds" }
            : undefined;

      fired.push({
        scopeKey: `D4|${workspace_id}`,
        category: "MODEL",
        scope_workspace_id: workspace_id,
        // Advisory gate (W0.3): which cap binds is NOT inferable from JSONL. Conditional lever.
        lever:
          "If your all-models / Opus / 5h cap is the one binding — check /usage — these high-context low-output Opus turns are Sonnet-movable. This does NOT help, and can hurt, if your Sonnet-specific weekly cap is the binding constraint.",
        target_metric: "model_mix_opus_fraction",
        // Advisory gate: suppress the crisp $/wk headline until live /usage cap-attribution exists.
        modeled_savings_u_per_wk: null,
        // Retain the computation as a DIAGNOSTIC formula (kind ADVISORY), not a headline.
        // Destructure out result_usd_per_wk so the advisory formula carries no crisp $/wk figure.
        modeled_formula: (({ result_usd_per_wk: _, ...rest }) => ({ ...rest, kind: "ADVISORY" }))(
          formula,
        ),
        evidence: {
          title: `Route Opus→Sonnet: ${mismatchPct}% of turns are high-context low-output`,
          workspace_id,
          total_opus_turns_per_week: totalOpus,
          mismatch_turns_per_week: mismatchCount,
          sidechain_premium_turns: sidechainPremiumTurns,
          mismatch_fraction: Number(mismatchFraction.toFixed(4)),
          min_context_tokens_threshold: D4_MISMATCH_MIN_CONTEXT_TOKENS,
          max_output_tokens_threshold: D4_MISMATCH_MAX_OUTPUT_TOKENS,
          mismatch_fraction_threshold: D4_MISMATCH_MIN_FRACTION,
          min_opus_turns_threshold: D4_OPUS_MIN_TURNS,
          avg_input_tokens: avgInputTokens,
          avg_output_tokens: avgOutputTokens,
          opus_input_price_usd_per_mtok: opusInputPrice,
          opus_output_price_usd_per_mtok: opusOutputPrice,
          sonnet_input_price_usd_per_mtok: sonnetInputPrice,
          sonnet_output_price_usd_per_mtok: sonnetOutputPrice,
          reduction_fraction: D4_REDUCTION_FRACTION,
          // Advisory framing: crisp savings suppressed; computed figure is diagnostic only.
          advisory: true,
          requires_usage_cap_data: true,
          diagnostic_savings_u_per_wk_if_all_models_cap_binds: savingsU,
          advisory_note:
            "Routing savings are only real if the all-models/Opus/5h cap is binding — check /usage. No crisp $/wk is emitted from transcripts alone.",
          steps: [
            "Check /usage to see which cap (all-models/Opus/5h vs Sonnet weekly) is actually binding",
            "Only if the all-models/Opus cap binds: review the highest-Opus sessions in this workspace",
            "Identify turns where the task is lookup, summarization, or formatting (not deep reasoning)",
            "Route those turns to Sonnet; re-check this workspace's Opus fraction after 7 days",
          ],
          ...capEvidence,
        },
      });
    }

    if (fired.length === 0) {
      return {
        fired: [],
        status: "INACTIVE",
        note: `no workspace met the mismatch threshold (≥${D4_OPUS_MIN_TURNS} Opus turns, ≥${Math.round(D4_MISMATCH_MIN_FRACTION * 100)}% high-context-low-output)`,
      };
    }

    return {
      fired,
      status: "ACTIVE",
      note: `${fired.length} workspace(s) with sustained Opus mismatch pattern`,
    };
  },
};
