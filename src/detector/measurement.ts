/**
 * src/detector/measurement.ts — W4 Impact Ledger measurement pass.
 *
 * Owns the ADOPTED → MEASURING → MEASURED_* lifecycle transitions and the
 * pre-adoption baseline snapshot for `recommendation_effects`:
 *
 *   - snapshotBeforeValue(db, rec): reads the realized baseline signal
 *     (context_inventory_history token delta for D1; session floor context for
 *     D2; routing-adherence score for D4; cache read/creation ratio for D8 —
 *     RI9). NEVER derives a value from recommendations.modeled_savings_u_per_wk.
 *   - runMeasurementPass(db, now, opts?): probe-driven pass called after each
 *     context-probe run (wired via the post-probe seam in detector-hook.ts).
 *
 * Honesty rails (W4 design §6):
 *   - Realized signal = observed history-table delta, never Claude self-report.
 *   - Every transition UPDATE is guarded on the expected predecessor state;
 *     zero changes ⇒ log + skip, never throw.
 *   - Warning-class recs (D5 / LIMIT) never enter MEASURING and get no effect row.
 *   - Unknown target_metric handlers log and leave the rec in MEASURING.
 *
 * Injected `now: Date` everywhere — never call new Date() in this module.
 */

import type { Db } from "../db/open.js";
import { GLOBAL_WORKSPACE_ID } from "./context-probe.js";
import { isD1SourceBackedRecommendation, parseD1SourceIdentity } from "./d1-source-identity.js";

/** Wait ≥1 day after adoption before entering MEASURING. */
export const MIN_SETTLING_DAYS = 1;

/** After-window length: once elapsed, the pass closes the measurement and writes a verdict. */
export const AFTER_WINDOW_DAYS = 14;

/**
 * Minimum interval between measurement passes (design §10 Q5): the probe can
 * fire every ~30s while tailing; most passes are no-ops. Throttled via
 * user_config 'last_measurement_run_at'. Bypass with opts.force (tests).
 */
export const MEASUREMENT_MIN_INTERVAL_MS = 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SIGNAL_WINDOW_DAYS = 14;

/** Pre-adoption baseline captured at adopt time. n = observation count backing the value. */
export interface BeforeSnapshot {
  value: number;
  from_ts: string;
  n: number;
}

/** Minimal shape of a `recommendations` row the helpers need. */
export interface MeasurementRecRow {
  rec_id: string;
  detector_id: string | null;
  category: string;
  scope_workspace_id: string | null;
  evidence_json: string;
  target_metric: string;
}

export interface MeasurementPassResult {
  /** ADOPTED → MEASURING transitions performed. */
  to_measuring: number;
  /** MEASURING → MEASURED_* verdicts written. */
  verdicts: number;
  /** Guarded updates that changed nothing (already transitioned / missing row). */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Schema guards
// ---------------------------------------------------------------------------

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Signal queries per detector class (design §2)
// ---------------------------------------------------------------------------

/** Latest context_inventory_history row for one source (any time ≤ upperBoundIso). */
function latestHistoryRow(
  db: Db,
  workspaceId: string,
  component: string,
  fileRef: string,
  upperBoundIso: string,
): { tokens: number; observed_at: string } | null {
  const row = db
    .prepare(
      `SELECT tokens, observed_at FROM context_inventory_history
        WHERE workspace_id = ? AND component = ? AND file_ref = ? AND observed_at <= ?
        ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(workspaceId, component, fileRef, upperBoundIso) as
    | { tokens: number; observed_at: string }
    | undefined;
  return row ?? null;
}

/**
 * D2 signal: avg of per-session MIN(context_tokens) (cold-cache floor proxy)
 * over RECONCILED sessions whose last_turn_at falls in [fromIso, toIso).
 * Returns null when there are no qualifying sessions (not enough data).
 */
function avgFloorContext(
  db: Db,
  scopeWorkspaceId: string | null,
  fromIso: string,
  toIso: string,
): { value: number; n: number } | null {
  const scoped = scopeWorkspaceId !== null;
  const row = db
    .prepare(
      `SELECT COUNT(avg_floor_ctx) AS n,
              AVG(avg_floor_ctx) AS avg_floor_ctx
         FROM (
           SELECT (SELECT MIN(t2.context_tokens) FROM turns t2
                    WHERE t2.session_id = s.session_id AND t2.provisional = 0) AS avg_floor_ctx
             FROM sessions s
            WHERE s.last_turn_at >= ? AND s.last_turn_at < ?
              AND s.state = 'RECONCILED'
              ${scoped ? "AND s.workspace_id = ?" : "AND s.workspace_id != ?"}
         )
        WHERE avg_floor_ctx IS NOT NULL`,
    )
    .get(fromIso, toIso, scopeWorkspaceId ?? GLOBAL_WORKSPACE_ID) as {
    n: number;
    avg_floor_ctx: number | null;
  };
  if (row.n === 0 || row.avg_floor_ctx === null) return null;
  return { value: row.avg_floor_ctx, n: row.n };
}

/**
 * D4 signal: routing-adherence score = ROUND(100 × (1 − premium_share)) over
 * non-sidechain reconciled turns in [fromIso, toIso), where premium = model
 * contains 'opus'. The data-model's "mechanical turn" classifier is not yet
 * shipped, so all reconciled turns are the mechanical set (conservative proxy —
 * documented in the W4 build digest).
 */
function routingAdherenceScore(
  db: Db,
  scopeWorkspaceId: string | null,
  fromIso: string,
  toIso: string,
): { value: number; n: number } | null {
  const scoped = scopeWorkspaceId !== null;
  const sql = `SELECT COUNT(*) AS n,
                      AVG(CASE WHEN model LIKE '%opus%' THEN 1.0 ELSE 0.0 END) AS premium_share
                 FROM turns
                WHERE is_sidechain = 0 AND provisional = 0 AND ts >= ? AND ts < ? ${
                  scoped ? "AND workspace_id = ?" : ""
                }`;
  const params = scoped ? [fromIso, toIso, scopeWorkspaceId] : [fromIso, toIso];
  const row = db.prepare(sql).get(...params) as { n: number; premium_share: number | null };
  if (row.n === 0 || row.premium_share === null) return null;
  return { value: Math.round(100 * (1 - row.premium_share)), n: row.n };
}

/**
 * D8 signal (RI9 cache-churn metric): cache read-to-creation ratio =
 * SUM(cache_read_tokens) / SUM(cache_write_5m + cache_write_1h + cache_write_other)
 * over non-sidechain reconciled turns in [fromIso, toIso). A higher ratio means
 * more warm reads per creation (less full-price re-write churn) → improvement.
 * Returns null when no qualifying turns exist or total creation is zero (the
 * ratio is undefined — "not enough data", never a divide-by-zero).
 */
function cacheReadToCreationRatio(
  db: Db,
  scopeWorkspaceId: string | null,
  fromIso: string,
  toIso: string,
): { value: number; n: number } | null {
  const scoped = scopeWorkspaceId !== null;
  const sql = `SELECT COUNT(*) AS n,
                      SUM(cache_read_tokens) AS reads,
                      SUM(cache_write_5m + cache_write_1h + cache_write_other) AS creation
                 FROM turns
                WHERE is_sidechain = 0 AND provisional = 0 AND ts >= ? AND ts < ? ${
                  scoped ? "AND workspace_id = ?" : ""
                }`;
  const params = scoped ? [fromIso, toIso, scopeWorkspaceId] : [fromIso, toIso];
  const row = db.prepare(sql).get(...params) as {
    n: number;
    reads: number | null;
    creation: number | null;
  };
  if (row.n === 0 || row.creation === null || row.creation === 0) return null;
  return { value: (row.reads ?? 0) / row.creation, n: row.n };
}

/** True when a detector class has a measurement handler (design §2a–§2c; RI9 adds D8). */
function handlerFor(rec: MeasurementRecRow): "D1" | "D2" | "D4" | "D8" | null {
  const tm = rec.target_metric ?? "";
  if (isD1SourceBackedRecommendation(rec)) return "D1";
  if (rec.detector_id === "D2" || tm.startsWith("CACHE_READ_TOKENS_PER_WK")) return "D2";
  if (rec.detector_id === "D4" || tm.startsWith("ROUTING_ADHERENCE_SCORE")) return "D4";
  if (rec.detector_id === "D8" || tm.startsWith("cache_read_to_creation_ratio")) return "D8";
  return null;
}

/** Warning-class recs (D5 / LIMIT / explicit NONE) skip the lifecycle entirely (design §2d). */
export function isWarningClass(rec: MeasurementRecRow): boolean {
  return (
    rec.category === "LIMIT" ||
    rec.target_metric === "NONE" ||
    rec.target_metric === "forecast_margin"
  );
}

// ---------------------------------------------------------------------------
// snapshotBeforeValue — design §4c
// ---------------------------------------------------------------------------

/**
 * Read the pre-adoption baseline for a rec. Returns null when no signal is
 * available for the class (the adopt path still writes an effect row with
 * before_value = NULL and proceeds — design §4a error handling).
 */
export function snapshotBeforeValue(
  db: Db,
  rec: MeasurementRecRow,
  now: Date,
): BeforeSnapshot | null {
  const nowIso = now.toISOString();
  const handler = handlerFor(rec);
  if (handler === null || isWarningClass(rec)) return null;
  if (handler === "D1" && !tableExists(db, "context_inventory_history")) return null;

  if (handler === "D1") {
    const src = parseD1SourceIdentity(rec.evidence_json);
    if (src === null) return null;
    const workspaceId = rec.scope_workspace_id ?? GLOBAL_WORKSPACE_ID;
    const row = latestHistoryRow(db, workspaceId, src.component, src.fileRef, nowIso);
    if (row === null) return null;
    // History appends one row per distinct version → the snapshot grain is one
    // observation (the latest version's token count).
    return { value: row.tokens, from_ts: row.observed_at, n: 1 };
  }

  if (handler === "D2") {
    const fromIso = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * MS_PER_DAY).toISOString();
    const r = avgFloorContext(db, rec.scope_workspace_id, fromIso, nowIso);
    return r === null ? null : { value: r.value, from_ts: fromIso, n: r.n };
  }

  if (handler === "D4") {
    const fromIso = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * MS_PER_DAY).toISOString();
    const r = routingAdherenceScore(db, rec.scope_workspace_id, fromIso, nowIso);
    return r === null ? null : { value: r.value, from_ts: fromIso, n: r.n };
  }

  // D8
  const fromIso = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const r = cacheReadToCreationRatio(db, rec.scope_workspace_id, fromIso, nowIso);
  return r === null ? null : { value: r.value, from_ts: fromIso, n: r.n };
}

type Verdict = "EFFECTIVE" | "NO_EFFECT" | "INCONCLUSIVE";

function d1Verdict(
  beforeValue: number | null,
  afterValue: number | null,
): { delta_pct: number | null; verdict: Verdict } {
  if (beforeValue === null || afterValue === null || beforeValue === 0) {
    return { delta_pct: null, verdict: "INCONCLUSIVE" };
  }
  const deltaPct = ((afterValue - beforeValue) / beforeValue) * 100;
  // Threshold is exclusive: < −5% ⇒ EFFECTIVE; [−5%, 0%] too small; growth ⇒ NO_EFFECT.
  return { delta_pct: deltaPct, verdict: deltaPct < -5 ? "EFFECTIVE" : "NO_EFFECT" };
}

function d2Verdict(
  beforeValue: number | null,
  afterValue: number | null,
): { delta_pct: number | null; verdict: Verdict } {
  if (beforeValue === null || afterValue === null || beforeValue === 0) {
    return { delta_pct: null, verdict: "INCONCLUSIVE" };
  }
  const deltaPct = ((afterValue - beforeValue) / beforeValue) * 100;
  // Noisier signal than D1 → higher bar (−15%).
  return { delta_pct: deltaPct, verdict: deltaPct < -15 ? "EFFECTIVE" : "NO_EFFECT" };
}

function d4Verdict(
  beforeValue: number | null,
  afterValue: number | null,
): { delta_pct: number | null; verdict: Verdict } {
  if (beforeValue === null || afterValue === null) {
    return { delta_pct: null, verdict: "INCONCLUSIVE" };
  }
  // Score units are points (0–100); "delta_pct" carries the point delta here.
  const points = afterValue - beforeValue;
  return { delta_pct: points, verdict: points > 10 ? "EFFECTIVE" : "NO_EFFECT" };
}

function d8Verdict(
  beforeValue: number | null,
  afterValue: number | null,
): { delta_pct: number | null; verdict: Verdict } {
  if (beforeValue === null || afterValue === null || beforeValue === 0) {
    return { delta_pct: null, verdict: "INCONCLUSIVE" };
  }
  const deltaPct = ((afterValue - beforeValue) / beforeValue) * 100;
  // A rising read/creation ratio = warmer cache = improvement; noisy signal → +15% bar.
  return { delta_pct: deltaPct, verdict: deltaPct > 15 ? "EFFECTIVE" : "NO_EFFECT" };
}

// ---------------------------------------------------------------------------
// After-value readers for the close step
// ---------------------------------------------------------------------------

function d1AfterValue(
  db: Db,
  rec: MeasurementRecRow,
  adoptedIso: string,
  deadlineIso: string,
): { value: number; to_ts: string; n: number } | null {
  const src = parseD1SourceIdentity(rec.evidence_json);
  if (src === null) return null;
  const workspaceId = rec.scope_workspace_id ?? GLOBAL_WORKSPACE_ID;
  // History rows exist only for DISTINCT versions (append-on-hash-change), so any
  // post-adoption row IS a change. Take the last one in-window (net final state).
  const row = db
    .prepare(
      `SELECT tokens, observed_at FROM context_inventory_history
        WHERE workspace_id = ? AND component = ? AND file_ref = ?
          AND observed_at > ? AND observed_at <= ?
        ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(workspaceId, src.component, src.fileRef, adoptedIso, deadlineIso) as
    | { tokens: number; observed_at: string }
    | undefined;
  if (row === undefined) return null;
  return { value: row.tokens, to_ts: row.observed_at, n: 1 };
}

function d2AfterValue(
  db: Db,
  rec: MeasurementRecRow,
  adoptedMs: number,
  deadlineMs: number,
): { value: number; to_ts: string; n: number } | null {
  const r = avgFloorContext(
    db,
    rec.scope_workspace_id,
    new Date(adoptedMs).toISOString(),
    new Date(deadlineMs).toISOString(),
  );
  if (r === null) return null;
  return { value: r.value, to_ts: new Date(deadlineMs).toISOString(), n: r.n };
}

function d4AfterValue(
  db: Db,
  rec: MeasurementRecRow,
  adoptedMs: number,
  deadlineMs: number,
): { value: number; to_ts: string; n: number } | null {
  const r = routingAdherenceScore(
    db,
    rec.scope_workspace_id,
    new Date(adoptedMs).toISOString(),
    new Date(deadlineMs).toISOString(),
  );
  if (r === null) return null;
  return { value: r.value, to_ts: new Date(deadlineMs).toISOString(), n: r.n };
}

function d8AfterValue(
  db: Db,
  rec: MeasurementRecRow,
  adoptedMs: number,
  deadlineMs: number,
): { value: number; to_ts: string; n: number } | null {
  const r = cacheReadToCreationRatio(
    db,
    rec.scope_workspace_id,
    new Date(adoptedMs).toISOString(),
    new Date(deadlineMs).toISOString(),
  );
  if (r === null) return null;
  return { value: r.value, to_ts: new Date(deadlineMs).toISOString(), n: r.n };
}

// ---------------------------------------------------------------------------
// Close step — MEASURING → MEASURED_*
// ---------------------------------------------------------------------------

function closeMeasurement(
  db: Db,
  rec: MeasurementRecRow & { adopted_at: string },
  now: Date,
  result: MeasurementPassResult,
): void {
  const adoptedMs = Date.parse(rec.adopted_at);
  if (Number.isNaN(adoptedMs)) return;
  const deadlineMs = adoptedMs + AFTER_WINDOW_DAYS * MS_PER_DAY;
  // The after-window closes at its deadline (or now, if the pass runs later).
  const effectiveDeadlineMs = Math.min(deadlineMs, now.getTime());
  const adoptedIso = rec.adopted_at;
  const deadlineIso = new Date(effectiveDeadlineMs).toISOString();

  // Baseline row as written by adoptRecommendation(): measured_at = adopted_at.
  const effect = db
    .prepare("SELECT before_value FROM recommendation_effects WHERE rec_id = ? AND measured_at = ?")
    .get(rec.rec_id, adoptedIso) as { before_value: number | null } | undefined;
  if (effect === undefined) {
    console.warn(`W4: no effect row for ${rec.rec_id}; cannot close measurement — skipped`);
    result.skipped++;
    return;
  }

  const handler = handlerFor(rec);
  let computed: { delta_pct: number | null; verdict: Verdict };
  let afterValue: number | null = null;
  let afterN: number | null = null;
  let afterTo = deadlineIso;

  if (handler === "D1") {
    const a = d1AfterValue(db, rec, adoptedIso, deadlineIso);
    if (a === null) {
      // Probe ran but the source never changed within the window.
      computed = { delta_pct: null, verdict: "INCONCLUSIVE" };
    } else {
      afterValue = a.value;
      afterN = a.n;
      afterTo = a.to_ts;
      computed = d1Verdict(effect.before_value, a.value);
    }
  } else if (handler === "D2") {
    const a = d2AfterValue(db, rec, adoptedMs, effectiveDeadlineMs);
    if (a === null) {
      computed = { delta_pct: null, verdict: "INCONCLUSIVE" };
    } else {
      afterValue = a.value;
      afterN = a.n;
      afterTo = a.to_ts;
      computed = d2Verdict(effect.before_value, a.value);
    }
  } else if (handler === "D4") {
    const a = d4AfterValue(db, rec, adoptedMs, effectiveDeadlineMs);
    if (a === null) {
      computed = { delta_pct: null, verdict: "INCONCLUSIVE" };
    } else {
      afterValue = a.value;
      afterN = a.n;
      afterTo = a.to_ts;
      computed = d4Verdict(effect.before_value, a.value);
    }
  } else if (handler === "D8") {
    const a = d8AfterValue(db, rec, adoptedMs, effectiveDeadlineMs);
    if (a === null) {
      computed = { delta_pct: null, verdict: "INCONCLUSIVE" };
    } else {
      afterValue = a.value;
      afterN = a.n;
      afterTo = a.to_ts;
      computed = d8Verdict(effect.before_value, a.value);
    }
  } else {
    console.info(
      `W4: no measurement handler for target_metric ${rec.target_metric}; staying MEASURING`,
    );
    result.skipped++;
    return;
  }

  // Write the verdict onto the adoption-cycle effect row (guarded: only when still open).
  const upd = db
    .prepare(
      `UPDATE recommendation_effects
          SET after_from = ?, after_to = ?, after_value = ?, after_n = ?, delta_pct = ?, verdict = ?
        WHERE rec_id = ? AND measured_at = ? AND verdict IS NULL`,
    )
    .run(
      adoptedIso,
      afterTo,
      afterValue,
      afterN,
      computed.delta_pct,
      computed.verdict,
      rec.rec_id,
      adoptedIso,
    );
  if (upd.changes === 0) {
    console.warn(`W4: effect row for ${rec.rec_id} already closed or missing — skipped`);
    result.skipped++;
    return;
  }

  // INCONCLUSIVE maps to the NO_EFFECT state (the state enum has no INCONCLUSIVE);
  // the effect row's verdict column keeps the honest distinction for the ledger.
  const nextState = computed.verdict === "EFFECTIVE" ? "MEASURED_EFFECTIVE" : "MEASURED_NO_EFFECT";
  const trans = db
    .prepare("UPDATE recommendations SET state = ? WHERE rec_id = ? AND state = 'MEASURING'")
    .run(nextState, rec.rec_id);
  if (trans.changes === 0) {
    console.warn(`W4: rec ${rec.rec_id} not in MEASURING at close — skipped`);
    result.skipped++;
    return;
  }
  result.verdicts++;
}

// ---------------------------------------------------------------------------
// runMeasurementPass — design §3
// ---------------------------------------------------------------------------

export interface RunMeasurementOptions {
  /** Bypass the last-run throttle (tests / explicit invocation). */
  force?: boolean;
}

/**
 * Probe-driven measurement pass. Idempotent, guarded, never throws:
 *   ADOPTED → MEASURING    when now ≥ adopted_at + MIN_SETTLING_DAYS
 *   MEASURING → MEASURED_* when now ≥ adopted_at + AFTER_WINDOW_DAYS
 * Warning-class recs (D5/LIMIT) are skipped entirely; unknown target_metric
 * handlers log and stay in MEASURING.
 */
export function runMeasurementPass(
  db: Db,
  now: Date,
  opts?: RunMeasurementOptions,
): MeasurementPassResult {
  const result: MeasurementPassResult = { to_measuring: 0, verdicts: 0, skipped: 0 };

  if (!tableExists(db, "context_inventory_history")) {
    console.warn("W4: context_inventory_history not available; measurement pass skipped");
    return result;
  }

  // Throttle (design §10 Q5): skip when the last run is younger than the interval.
  if (opts?.force !== true && tableExists(db, "user_config")) {
    const last = db
      .prepare("SELECT value FROM user_config WHERE key = 'last_measurement_run_at'")
      .get() as { value: string | null } | undefined;
    if (last !== undefined && last.value !== null && last.value !== "") {
      const lastMs = Date.parse(last.value);
      if (!Number.isNaN(lastMs) && now.getTime() - lastMs < MEASUREMENT_MIN_INTERVAL_MS) {
        return result;
      }
    }
  }

  try {
    const rows = db
      .prepare(
        `SELECT rec_id, detector_id, category, scope_workspace_id, evidence_json,
                target_metric, state, adopted_at
           FROM recommendations
          WHERE state IN ('ADOPTED', 'MEASURING') AND adopted_at IS NOT NULL
          ORDER BY adopted_at ASC, rec_id ASC`,
      )
      .all() as Array<MeasurementRecRow & { state: string; adopted_at: string }>;

    for (const rec of rows) {
      if (isWarningClass(rec)) continue; // D5 stays ADOPTED; no MEASURING, no effect rows
      const adoptedMs = Date.parse(rec.adopted_at);
      if (Number.isNaN(adoptedMs)) continue;

      let state = rec.state;
      if (state === "ADOPTED") {
        if (now.getTime() < adoptedMs + MIN_SETTLING_DAYS * MS_PER_DAY) continue;
        const r = db
          .prepare(
            "UPDATE recommendations SET state = 'MEASURING' WHERE rec_id = ? AND state = 'ADOPTED'",
          )
          .run(rec.rec_id);
        if (r.changes === 0) {
          console.warn(`W4: rec ${rec.rec_id} not in ADOPTED for MEASURING transition — skipped`);
          result.skipped++;
          continue;
        }
        state = "MEASURING";
        result.to_measuring++;
      }

      if (state !== "MEASURING") continue;
      if (now.getTime() < adoptedMs + AFTER_WINDOW_DAYS * MS_PER_DAY) continue; // window still open
      closeMeasurement(db, rec, now, result);
    }
  } finally {
    // Record the run regardless of partial failures so the throttle holds.
    if (tableExists(db, "user_config")) {
      db.prepare(
        `INSERT INTO user_config (key, value, updated_at) VALUES ('last_measurement_run_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(now.toISOString(), now.toISOString());
    }
  }

  return result;
}
