/**
 * src/query/api/recommendations-ledger.ts — W4 Impact Ledger read path.
 *
 * `listLedger()` joins non-PROPOSED recommendations to their
 * `recommendation_effects` rows and returns the realized-vs-modeled ledger:
 *
 *   - effects[].after_value is the OBSERVED signal (probe/history delta);
 *     modeled_savings_u_per_wk is the raw projection; the two are NEVER summed.
 *   - modeled_cap_weighted_u_per_wk = modeled × cap_read_coeff (server-side),
 *     the display figure for CONTEXT recs; raw modeled also returned.
 *   - confounded_window = true when another rec's adopted_at lies within
 *     ±86400s — the spend rollup cannot be isolated, so the UI banners it.
 *
 * Split from recommendations.ts per W4 design §10 Q3 to keep each module small.
 * Claim kind: EXPERIMENTAL.
 */

import { resolveCapReadCoeff } from "../cap-weighted.js";
import { getQueryDb } from "../db-context.js";
import type { ApiResponse } from "../envelope.js";
import { buildResponse } from "../envelope.js";
import type { RecommendationCard } from "./recommendations.js";

export interface EffectRow {
  rec_id: string;
  measured_at: string;
  before_from: string;
  before_to: string;
  after_from: string;
  after_to: string;
  before_value: number | null;
  after_value: number | null;
  before_n: number | null;
  after_n: number | null;
  delta_pct: number | null;
  verdict: "EFFECTIVE" | "NO_EFFECT" | "INCONCLUSIVE" | null;
  /**
   * Honesty qualification derived server-side (no schema column needed):
   * NOT_ENOUGH_DATA when before_n < 3; EXPERIMENTAL for turns-based D2 signals.
   */
  qualification: "NOT_ENOUGH_DATA" | "EXPERIMENTAL" | null;
}

export interface LedgerEntry {
  rec_id: string;
  detector_id: string;
  lever: string;
  adopted_at: string;
  state: RecommendationCard["state"];
  target_metric: string;
  modeled_savings_u_per_wk: number | null;
  /** Cap-weighted modeled (display only) = modeled × COEFF. Never summed with realized. */
  modeled_cap_weighted_u_per_wk: number | null;
  effects: EffectRow[];
  /** True when ≥1 other rec was adopted within ±1 day (spend rollup not isolable). */
  confounded_window: boolean;
}

export interface LedgerView {
  entries: LedgerEntry[];
  /** From user_config.cap_read_coeff; shown as caveat in the UI. */
  cap_read_coeff: number;
}

interface RecSqlRow {
  rec_id: string;
  detector_id: string | null;
  lever: string;
  adopted_at: string | null;
  state: RecommendationCard["state"];
  target_metric: string;
  modeled_savings_u_per_wk: number | null;
}

interface EffectSqlRow {
  rec_id: string;
  measured_at: string;
  before_from: string;
  before_to: string;
  after_from: string;
  after_to: string;
  before_value: number | null;
  after_value: number | null;
  before_n: number | null;
  after_n: number | null;
  delta_pct: number | null;
  verdict: EffectRow["verdict"];
}

const CONFOUND_WINDOW_MS = 86_400_000; // ±1 day

function qualificationFor(
  row: EffectSqlRow,
  detectorId: string,
  targetMetric: string,
): EffectRow["qualification"] {
  const isD2 = detectorId === "D2" || targetMetric.startsWith("CACHE_READ_TOKENS_PER_WK");
  const isD8 = detectorId === "D8" || targetMetric.startsWith("cache_read_to_creation_ratio");
  // D1's direct file-size snapshot is a point-in-time measurement; n=1 is expected
  // because history only appends on distinct file versions. The sparse-data guard
  // applies to turns/session-window measurements (D2, D8), where n is a sample count.
  if ((isD2 || isD8) && row.before_n !== null && row.before_n < 3) return "NOT_ENOUGH_DATA";
  // Turns-based D2 floor signal is weak → EXPERIMENTAL label (design §2b honesty rail).
  if (isD2) {
    return "EXPERIMENTAL";
  }
  return null;
}

/**
 * Read the realized-vs-modeled ledger for all adopted-or-later recs.
 * When `scope` is given, only that workspace's rows and global (NULL-scope)
 * rows are returned. Claim kind: EXPERIMENTAL.
 */
export function listLedger(scope?: string): ApiResponse<LedgerView> {
  const db = getQueryDb();
  const coeff = resolveCapReadCoeff(db);

  const recRows = (
    scope !== undefined
      ? db
          .prepare(
            `SELECT rec_id, detector_id, lever, adopted_at, state, target_metric,
                    modeled_savings_u_per_wk
               FROM recommendations
              WHERE (scope_workspace_id = ? OR scope_workspace_id IS NULL)
                AND state IN ('ADOPTED','MEASURING','MEASURED_EFFECTIVE','MEASURED_NO_EFFECT')
                AND adopted_at IS NOT NULL
              ORDER BY adopted_at DESC, rec_id ASC`,
          )
          .all(scope)
      : db
          .prepare(
            `SELECT rec_id, detector_id, lever, adopted_at, state, target_metric,
                    modeled_savings_u_per_wk
               FROM recommendations
              WHERE state IN ('ADOPTED','MEASURING','MEASURED_EFFECTIVE','MEASURED_NO_EFFECT')
                AND adopted_at IS NOT NULL
              ORDER BY adopted_at DESC, rec_id ASC`,
          )
          .all()
  ) as RecSqlRow[];

  const effectRows = db
    .prepare(
      `SELECT rec_id, measured_at, before_from, before_to, after_from, after_to,
              before_value, after_value, before_n, after_n, delta_pct, verdict
         FROM recommendation_effects`,
    )
    .all() as EffectSqlRow[];
  const effectsByRec = new Map<string, EffectSqlRow[]>();
  for (const e of effectRows) {
    const list = effectsByRec.get(e.rec_id);
    if (list !== undefined) list.push(e);
    else effectsByRec.set(e.rec_id, [e]);
  }

  // Confounded-window flag: another ADOPTED+ rec within ±86400s of this adoption.
  const adoptedTimes = recRows.map((r) => ({
    recId: r.rec_id,
    ms: r.adopted_at !== null ? Date.parse(r.adopted_at) : Number.NaN,
  }));

  const entries: LedgerEntry[] = recRows.map((r) => {
    const self = adoptedTimes.find((a) => a.recId === r.rec_id);
    const confounded =
      self !== undefined &&
      !Number.isNaN(self.ms) &&
      adoptedTimes.some(
        (o) =>
          o.recId !== r.rec_id &&
          !Number.isNaN(o.ms) &&
          Math.abs(o.ms - self.ms) <= CONFOUND_WINDOW_MS,
      );

    const effects: EffectRow[] = (effectsByRec.get(r.rec_id) ?? []).map((e) => ({
      ...e,
      qualification: qualificationFor(e, r.detector_id ?? "", r.target_metric),
    }));

    return {
      rec_id: r.rec_id,
      detector_id: r.detector_id ?? "unknown",
      lever: r.lever,
      adopted_at: r.adopted_at as string,
      state: r.state,
      target_metric: r.target_metric,
      modeled_savings_u_per_wk: r.modeled_savings_u_per_wk,
      // Cap-weighted modeled is a DISPLAY figure only — computed server-side,
      // never summed with the realized after_value / delta_pct fields.
      modeled_cap_weighted_u_per_wk:
        r.modeled_savings_u_per_wk === null ? null : r.modeled_savings_u_per_wk * coeff,
      effects,
      confounded_window: confounded,
    };
  });

  const data: LedgerView = { entries, cap_read_coeff: coeff };

  return buildResponse<LedgerView>(data, {
    claim_kind: "EXPERIMENTAL",
    n: entries.length,
    drilldown_ids: scope !== undefined ? { workspace_id: scope } : {},
  });
}
