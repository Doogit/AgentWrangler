/**
 * src/detector/engine.ts — deterministic orchestration + upsert.
 *
 * runDetectors(db, ctx) evaluates every registered detector under the injected
 * clock and upserts fired triggers into `recommendations`. Determinism (§2.3):
 * rec_id is a pure function of detector + scope + a stable evidence-window key
 * (never a random uuid); created_at is the injected `now`; the ON CONFLICT path
 * refreshes only derived fields and preserves lifecycle columns (state/adopted_at/
 * dismissed_until), so a DISMISSED rec in cool-down is never resurfaced.
 */

import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Db } from "../db/open.js";
import { registeredFindingDescriptors } from "./finding-registry.js";
import {
  type FindingEnvelopeV2,
  RECOMMENDATION_TEMPLATES,
  type RecencyFacts,
  type RecommendationPayloadV1,
  createFindingEnvelopeV2,
  recommendationTemplate,
  serializeFindingEnvelopeV2,
  serializeModeledFormulaV1,
  serializeModeledFormulaV2,
  serializeRecommendationPayloadV1,
} from "./privacy-contract.js";
import { recId } from "./rec-id.js";
import { DETECTORS, UNEVALUATED_DETECTORS } from "./registry.js";
import type {
  AnyDetector,
  DetectorContext,
  DetectorInputTable,
  DetectorStatusKind,
  Fired,
  FiredV2,
} from "./types.js";

/** Registry ordinal: position of each detector in the global DETECTORS array. */
const REGISTRY_ORDINALS = new Map(DETECTORS.map((d, i) => [d.id, i] as const));

const WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** True when stored metrics carry a key the descriptor no longer declares, or lack a required one. */
function metricsDrifted(
  stored: Record<string, unknown> | undefined,
  declared: Readonly<Record<string, { kind: string }>>,
): boolean {
  if (stored === undefined) return false;
  return (
    Object.keys(stored).some((metricId) => !(metricId in declared)) ||
    Object.entries(declared).some(
      ([metricId, definition]) => definition.kind !== "TEXT" && !(metricId in stored),
    )
  );
}

/** An error's constructor name: the only error detail stored or logged (SEC-101). */
function errorClass(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

/** Live per-detector status for the query layer's detectors[] strip. */
export interface LiveDetectorStatus {
  detector_id: string;
  name: string;
  status: DetectorStatusKind;
  note: string;
}

/** Build the trailing-7d context anchored at the injected `now`. */
export function buildContext(now: Date): DetectorContext {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY).toISOString();
  return { now, fromIso, toIso };
}

const UPSERT_SQL = `
  INSERT INTO recommendations
    (rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
     lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
     state, created_at, adopted_at, dismissed_until,
     contract_version, template_id, contract_status, rule_id)
  VALUES (?, 'RULE', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, NULL, NULL,
          ?, ?, ?, ?)
  ON CONFLICT(rec_id) DO UPDATE SET
    category                  = excluded.category,
    lever                     = excluded.lever,
    modeled_savings_u_per_wk = excluded.modeled_savings_u_per_wk,
    modeled_formula_json     = excluded.modeled_formula_json,
    evidence_json            = excluded.evidence_json,
    target_metric            = excluded.target_metric,
    contract_version         = excluded.contract_version,
    template_id              = excluded.template_id,
    contract_status          = excluded.contract_status
    ,rule_id                 = excluded.rule_id
  WHERE recommendations.contract_version IS NULL
     OR recommendations.contract_version <= excluded.contract_version
`;

/**
 * Step kinds that name a concrete, structurally-checkable action (see coerceStep
 * in src/query/api/recommendations.ts). A free-text step collapses to "generic"
 * and does NOT count.
 */

/**
 * Upsert-only quality flag stamped into evidence: does this rec name a concrete,
 * structurally-checkable action? True when the evidence carries a non-empty
 * file_ref (a config target, as D1/D10 emit) OR any step object with a typed
 * action kind. Directional friction recs whose steps are free-text advice stamp
 * false. This is a quality signal only — it never changes persisted `state`
 * ("informational" is not a valid recommendations.state); query-layer
 * consumption of the flag is a separate follow-on.
 */
function upsertFired(
  db: Db,
  detector: AnyDetector,
  fired: Fired | FiredV2,
  nowIso: string,
  recency?: RecencyFacts,
): void {
  if (
    !Number.isFinite(fired.modeled_savings_u_per_wk ?? 0) ||
    (fired.modeled_savings_u_per_wk ?? 0) < 0
  ) {
    throw new TypeError("modeled_savings_u_per_wk must be null or a non-negative finite number");
  }
  const contract =
    detector.contractVersion === 1
      ? (() => {
          const payload = fired.payload as RecommendationPayloadV1;
          const evidenceJson = serializeRecommendationPayloadV1(
            recency === undefined ? payload : withRecencyV1(payload, recency),
            detector.id,
          );
          const formulaJson = serializeModeledFormulaV1(
            payload,
            detector.id,
            fired.modeled_formula_json,
          );
          const template = recommendationTemplate(payload.template_id);
          return {
            evidenceJson,
            formulaJson,
            category: template.category,
            lever: template.lever,
            targetMetric: template.target_metric,
            version: 1,
            templateId: payload.template_id,
            status: "V1_VALIDATED",
            ruleId: null,
          } as const;
        })()
      : (() => {
          const payload = fired.payload as FindingEnvelopeV2;
          const descriptor = detector.descriptor;
          if (descriptor.owner_detector_id !== detector.id) {
            throw new TypeError(
              `detector ${detector.id} cannot emit rule ${descriptor.rule_id} owned by ${descriptor.owner_detector_id}`,
            );
          }
          return {
            evidenceJson: serializeFindingEnvelopeV2(
              recency === undefined ? payload : { ...payload, recency },
              descriptor,
            ),
            formulaJson: serializeModeledFormulaV2(payload, descriptor),
            category: descriptor.presentation.category,
            lever: descriptor.presentation.lever,
            targetMetric: descriptor.presentation.target_metric,
            version: 2,
            templateId: null,
            status: "V2_VALIDATED",
            ruleId: descriptor.rule_id,
          } as const;
        })();
  db.prepare(UPSERT_SQL).run(
    recId(detector.id, fired.scope_workspace_id, fired.scopeKey),
    detector.id,
    contract.category,
    fired.scope_workspace_id,
    contract.lever,
    fired.modeled_savings_u_per_wk,
    contract.formulaJson,
    contract.evidenceJson,
    contract.targetMetric,
    nowIso,
    contract.version,
    contract.templateId,
    contract.status,
    contract.ruleId,
  );
}

/**
 * Delete a detector's stale PROPOSED recs — those whose scopeKey was not
 * re-emitted in the run just performed. `emittedIds` is the exact set of rec_ids
 * this detector upserted this pass; anything else it owns in PROPOSED state is an
 * orphan. Restricted to state='PROPOSED' so recs the user has acted on
 * (ADOPTED/DISMISSED/MEASURING/MEASURED_*), which carry lifecycle columns and FK
 * children, are preserved and never trigger a foreign-key failure.
 */
function gcStaleProposed(db: Db, detectorId: string, emittedIds: readonly string[]): void {
  db.prepare(
    `DELETE FROM recommendations
       WHERE detector_id = ?
         AND state = 'PROPOSED'
         AND rec_id NOT IN (SELECT value FROM json_each(?))`,
  ).run(detectorId, JSON.stringify(emittedIds));
}

/**
 * F2: rows a pass does not re-emit (closed weeks, acted-on recs) keep the presentation text they
 * were written with, so rewording a template or descriptor made the trusted reader drop them.
 * Rewrite category/lever/target_metric from the current template or descriptor on every pass.
 */
function syncPresentation(db: Db): void {
  const v1 = db.prepare(
    `UPDATE recommendations SET category = ?, lever = ?, target_metric = ?
       WHERE contract_status = 'V1_VALIDATED' AND contract_version = 1
         AND template_id = ? AND detector_id = ?
         AND (category IS NOT ? OR lever IS NOT ? OR target_metric IS NOT ?)`,
  );
  for (const [templateId, t] of Object.entries(RECOMMENDATION_TEMPLATES)) {
    v1.run(
      t.category,
      t.lever,
      t.target_metric,
      templateId,
      t.detector_id,
      t.category,
      t.lever,
      t.target_metric,
    );
  }
  const v2 = db.prepare(
    `UPDATE recommendations SET category = ?, lever = ?, target_metric = ?
       WHERE contract_status = 'V2_VALIDATED' AND contract_version = 2
         AND rule_id = ? AND detector_id = ?
         AND (category IS NOT ? OR lever IS NOT ? OR target_metric IS NOT ?)`,
  );
  for (const d of registeredFindingDescriptors()) {
    const p = d.presentation;
    v2.run(
      p.category,
      p.lever,
      p.target_metric,
      d.rule_id,
      d.owner_detector_id,
      p.category,
      p.lever,
      p.target_metric,
    );
  }
}

/** Preserve the superseded global D11 row as history once workspace rows exist. */
function retireLegacyD11(db: Db): void {
  db.prepare(
    `UPDATE recommendations SET state = 'RETIRED', dismissed_until = NULL
       WHERE rec_id = ? AND detector_id = 'D11' AND scope_workspace_id IS NULL
         AND state IN ('PROPOSED', 'DISMISSED')`,
  ).run(recId("D11", null, "D11|tool-error-rate"));
}

/**
 * U9 r2: C1 used to fire one multi-tool card ("OUTLIER_TOOLS: a, b, c"); it now fires one card per
 * tool. The old rolling-window row stays "active" until it ages out, still showing counts from
 * the superseded rule (a user rejection and an Artifact refusal counted as failures). Retire it.
 */
function retireLegacyC1(db: Db): void {
  db.prepare(
    `UPDATE recommendations SET state = 'RETIRED', dismissed_until = NULL
       WHERE detector_id = 'C1' AND state IN ('PROPOSED', 'DISMISSED')
         AND json_extract(evidence_json, '$.metrics.OUTLIER_TOOLS.value') LIKE '%,%'`,
  ).run();
}

/**
 * Evaluate all registered detectors and upsert fired rows. Returns the live
 * status list (used for the detectors[] strip). Read-only w.r.t. ingest tables;
 * writes only `recommendations`.
 */
export function runDetectors(
  db: Db,
  ctx: DetectorContext,
  detectors: readonly AnyDetector[] = DETECTORS,
): LiveDetectorStatus[] {
  const nowIso = ctx.now.toISOString();
  const statuses: LiveDetectorStatus[] = [];

  const tx = db.transaction(() => {
    syncPresentation(db);
    for (const detector of detectors) {
      let outcome: ReturnType<AnyDetector["evaluate"]>;
      try {
        outcome = detector.evaluate(db, ctx);
      } catch (e) {
        // P2-U8 (R-6): one throwing detector no longer aborts the run; it keeps its recs.
        statuses.push({
          detector_id: detector.id,
          name: detector.name,
          status: "BLOCKED",
          note: `evaluation failed (${errorClass(e)})`,
        });
        continue;
      }
      const emittedIds: string[] = [];
      for (const fired of outcome.fired) {
        emittedIds.push(recId(detector.id, fired.scope_workspace_id, fired.scopeKey));
        upsertFired(db, detector, fired, nowIso);
      }
      if (detector.id === "D11") retireLegacyD11(db);
      if (detector.id === "C1") retireLegacyC1(db);
      // Rec-GC: this detector was evaluated this run, so any PROPOSED rec it owns
      // whose scopeKey was NOT re-emitted is stale (grain change or a finding that
      // stopped firing) — delete it so the query layer shows exactly one row per
      // live (detector, scope). Scoped by detector_id so detectors NOT in `detectors`
      // keep their recs; a detector that fired nothing (empty emittedIds) still GCs
      // all its PROPOSED rows. Only PROPOSED is collected — ADOPTED/DISMISSED/
      // MEASURING/MEASURED_* carry user intent and FK children (apply_jobs,
      // effect_cycles, recommendation_effects) and are never touched. Runs after the
      // upserts so re-emitted rows keep their original created_at.
      gcStaleProposed(db, detector.id, emittedIds);
      statuses.push({
        detector_id: detector.id,
        name: detector.name,
        status: outcome.status,
        note: outcome.note,
      });
    }
  });
  tx();

  for (const d of UNEVALUATED_DETECTORS) {
    statuses.push({ detector_id: d.id, name: d.name, status: d.status, note: d.note });
  }
  return statuses;
}

/**
 * Evaluate detector statuses WITHOUT writing (read path for the query layer's
 * detectors[] strip). Mirrors runDetectors but performs no upsert.
 */
export function detectorStatuses(db: Db, ctx: DetectorContext): LiveDetectorStatus[] {
  const statuses: LiveDetectorStatus[] = DETECTORS.map((detector) => {
    const outcome = detector.evaluate(db, ctx);
    return {
      detector_id: detector.id,
      name: detector.name,
      status: outcome.status,
      note: outcome.note,
    };
  });
  for (const d of UNEVALUATED_DETECTORS) {
    statuses.push({ detector_id: d.id, name: d.name, status: d.status, note: d.note });
  }
  return statuses;
}

// ── P2H history walk (docs/plans/Archive/spec-rec-page-history-walk.md) ──────────────

const WEEK_MS = WINDOW_DAYS * MS_PER_DAY;
/** Fallback reset-grid phase: Monday 00:00 UTC (epoch day 0 is a Thursday; day 4 a Monday). */
const MONDAY_PHASE_MS = 4 * MS_PER_DAY;

function withRecencyV1(payload: RecommendationPayloadV1, recency: RecencyFacts): unknown {
  return { ...payload, facts: { ...payload.facts, ...recency } };
}

/** One evaluated window of the walk: W0 = trailing 7d, W1+ = closed reset-grid weeks. */
export interface HistoryWeek {
  /** k in W_k; also the anchor's `weeks_ago`. */
  index: number;
  start: string;
  end: string;
  ctx: DetectorContext;
}

/** Reset-grid phase = user_config.limit_resets_at mod 7d; Monday 00:00 UTC when unset/invalid. */
export function resetGridPhaseMs(db: Db): number {
  const row = db.prepare("SELECT value FROM user_config WHERE key = 'limit_resets_at'").get() as
    | { value: string | null }
    | undefined;
  const at = typeof row?.value === "string" ? Date.parse(row.value) : Number.NaN;
  if (!Number.isFinite(at)) return MONDAY_PHASE_MS;
  return ((at % WEEK_MS) + WEEK_MS) % WEEK_MS;
}

/** W1's end: the newest reset-grid point at or before now − 7d. */
export function gridW1EndMs(db: Db, now: Date, phase: number = resetGridPhaseMs(db)): number {
  const boundary = now.getTime() - WEEK_MS;
  return boundary - ((((boundary - phase) % WEEK_MS) + WEEK_MS) % WEEK_MS);
}

/**
 * Oldest non-provisional turn ts that parses as a date; malformed ts values are
 * skipped (a garbage string sorting first must not define the walk's depth).
 */
function oldestTurnMs(db: Db): number | null {
  const stmt = db.prepare("SELECT MIN(ts) AS ts FROM turns WHERE provisional = 0 AND ts > ?");
  let after = "";
  for (;;) {
    const { ts } = stmt.get(after) as { ts: string | null };
    if (ts === null) return null;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
    after = ts;
  }
}

/**
 * The walk's week grid, newest first. W0 = buildContext(now) exactly (the P2
 * oracle window). W1 = the newest full grid window ending at or before now − 7d;
 * W2, W3, … step back 7d down to the window holding the oldest non-provisional
 * turn. The sliver between W1's end and W0's start is not evaluated. A closed
 * week's ctx.now is its end, so its evaluation depends only on the week (the
 * cache stays sound as the real clock advances).
 */
export function historyWeeks(db: Db, now: Date): HistoryWeek[] {
  const w0 = buildContext(now);
  const weeks: HistoryWeek[] = [{ index: 0, start: w0.fromIso, end: w0.toIso, ctx: w0 }];
  const oldestMs = oldestTurnMs(db);
  if (oldestMs === null) return weeks;
  let end = gridW1EndMs(db, now);
  for (let index = 1; end > oldestMs; index++, end -= WEEK_MS) {
    const fromIso = new Date(end - WEEK_MS).toISOString();
    const toIso = new Date(end).toISOString();
    weeks.push({ index, start: fromIso, end: toIso, ctx: { now: new Date(end), fromIso, toIso } });
  }
  return weeks;
}

/**
 * Per-week progress for the (UH.2) history phase. new_findings = recs newly
 * INSERTED while processing this week (no row for that rec_id existed before).
 */
export interface HistoryWeekProgress {
  weeks_done: number;
  weeks_total: number;
  new_findings: number;
}

export type HistoryWeekListener = (progress: HistoryWeekProgress) => void;

/**
 * P0-U10: an optional counter hook fired around each detector.evaluate call
 * inside the walk. Instrumentation only — no behavior change: both callbacks
 * are no-ops when absent, and the walk's result is identical either way.
 */
export interface DetectorEvalHook {
  onStart?: (detectorId: string) => void;
  onEnd?: (detectorId: string, durationMs: number) => void;
}

export interface HistoryWalkOptions {
  detectors?: readonly AnyDetector[];
  onWeek?: HistoryWeekListener | undefined;
  detectorHook?: DetectorEvalHook | undefined;
  /**
   * P2-U4: history is fully ingested only from this instant on (the slice loop is still
   * running). The walk evaluates no week that starts before it, adds no new rec whose
   * detector reads before it (decision D5), and retires nothing. Unset = full walk.
   */
  completeThroughMs?: number | undefined;
}

/**
 * Days before ctx.now a detector reads, where that reaches past its 7-day window:
 * D5 compares the last day with the 7 before it; G11 compares against 90 days.
 */
const READ_BACK_DAYS: Readonly<Record<string, number>> = { D5: 8, G11: 90 };

export interface HistoryWalkResult {
  /** W0 statuses (same shape and order as runDetectors). */
  statuses: LiveDetectorStatus[];
  weeks_total: number;
  /**
   * week_start of every week evaluated this pass, in order: a week where at least one
   * detector ran (was not served from cache) and none threw.
   */
  evaluated_weeks: string[];
  new_findings: number;
  /** Weeks (W0 included) where at least one detector threw this pass. */
  failed_weeks: number;
  /** Detectors that threw in at least one week this pass (their GC was skipped). */
  failed_detectors: number;
}

/**
 * Non-turn detector inputs folded into every week mark (F1). A closed week is
 * stale when this signature differs from the one recorded at its evaluation.
 * Scoped to what registered detectors read beyond the turn-coupled ingest
 * tables (turns/sessions/tool_events/tool_event_metadata/tool_event_content/
 * ingest_metric_events/subagent_meta, all written by ingest together with the
 * turns of the same transcript — subagent_meta alongside its sidechain turns;
 * folding it in would invalidate all history on every new subagent):
 *   G11: work_items, observed_outcomes, session_work_links (B3 too)
 *   D1/D10: context_inventory (current snapshot, deterministic probe_id), workspaces
 *   pricing: pricing_snapshots
 *   user_config: D5 limit_* (forecast), cap_read_coeff, bytes_per_token*, limit_resets_at (grid)
 * Volatile columns (synced_at, derived_at, probed_at, probe_id) are excluded so a
 * no-op sync or probe does not invalidate history. per_model_snapshot (D4) is
 * excluded: /api/burn-status rewrites it on every poll.
 */
const NON_TURN_INPUT_SQL = {
  work_items: `SELECT work_item_id, workspace_id, number, state, final_commit, checks_conclusion,
          opened_at, merged_at, closed_at
     FROM work_items ORDER BY work_item_id`,
  observed_outcomes:
    "SELECT work_item_id, outcome, methodology_version FROM observed_outcomes ORDER BY work_item_id",
  session_work_links: `SELECT session_id, work_item_id, confidence, method
     FROM session_work_links ORDER BY session_id, work_item_id`,
  context_inventory: `SELECT workspace_id, component, file_ref, file_hash, tokens, attribution_version
     FROM context_inventory ORDER BY workspace_id, component, file_ref`,
  workspaces: "SELECT workspace_id FROM workspaces ORDER BY workspace_id",
  pricing_snapshots: "SELECT * FROM pricing_snapshots ORDER BY snapshot_id",
  user_config: `SELECT key, value FROM user_config
    WHERE key IN ('limit_tokens', 'limit_provenance', 'limit_resets_at', 'cap_read_coeff',
                  'bytes_per_token', 'bytes_per_token_measured_at', 'bytes_per_token_provenance')
    ORDER BY key`,
  // P2-U8: D10's catalog (rewritten by every probe; probed_at excluded) and D5's readings.
  catalog_items: `SELECT item_id, kind, name, plugin, usage_key, tokens, bytes, size_basis, source
     FROM catalog_items ORDER BY item_id`,
  limit_snapshots: "SELECT * FROM limit_snapshots ORDER BY rowid",
} as const satisfies Partial<Record<DetectorInputTable, string>>;

type NonTurnInputTable = keyof typeof NON_TURN_INPUT_SQL;

const INPUT_SIGNATURE_SQL = (
  [
    "work_items",
    "observed_outcomes",
    "session_work_links",
    "context_inventory",
    "workspaces",
    "pricing_snapshots",
    "user_config",
  ] as const
).map((table) => NON_TURN_INPUT_SQL[table]);

function hashRows(db: Db, sql: string, hash: crypto.Hash): void {
  for (const row of db.prepare(sql).raw().iterate()) hash.update(JSON.stringify(row));
  hash.update("\u0000");
}

export function inputSignature(db: Db): string {
  const hash = crypto.createHash("sha1");
  for (const sql of INPUT_SIGNATURE_SQL) hashRows(db, sql, hash);
  return hash.digest("hex");
}

/**
 * Turn-coupled tables, written by ingest together with the turns of the same transcript.
 * A closed week sees them through its turns_rowid_hwm; W0 signs them (see w0Part).
 */
const WINDOWED_TABLES: Readonly<Partial<Record<DetectorInputTable, string>>> = {
  turns: "ts",
  tool_events: "ts",
  ingest_metric_events: "event_ts",
};

/** The cache trusts a detector's results only for this version (P2-U8: declared per detector). */
function versionOf(detector: AnyDetector): string {
  return detector.version ?? detector.id;
}

export function detectorCodeVersion(detectors: readonly AnyDetector[] = DETECTORS): string {
  return [...new Set(detectors.map(versionOf))].sort().join(",");
}

/** P2-U8 (R-6): a (detector, version, window) that threw this many times is skipped. */
const QUARANTINE_AT = 3;
/** A quarantined pair is evaluated again this long after its last failure. */
const QUARANTINE_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Replace the old window bounds with the new ones in a stored W0 outcome, in one pass
 * (a 7-day move makes the old end equal the new start). Only exact quoted ISO strings
 * match; a data timestamp equal to a bound sits in the window's edge slice, whose
 * change would have changed the W0 signature.
 */
function rebaseWindow(json: string, from: [string, string], to: [string, string]): string {
  const map = new Map([
    [JSON.stringify(from[0]), JSON.stringify(to[0])],
    [JSON.stringify(from[1]), JSON.stringify(to[1])],
  ]);
  const pattern = new RegExp(
    [...map.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  return json.replace(pattern, (m) => map.get(m) ?? m);
}

interface RecEvidenceRow {
  evidence_json: string;
}

interface KeyRow {
  detector_id: string;
  scope_key: string;
  scope_workspace_id: string | null;
  anchor: string;
}

function rankValueU(fired: Fired | FiredV2): number | null {
  const payloadEstimate = (fired.payload as { estimate?: { rank_value_u_per_wk: number | null } })
    .estimate;
  const value =
    fired.modeled_formula_json?.estimate.rank_value_u_per_wk ??
    payloadEstimate?.rank_value_u_per_wk ??
    fired.modeled_savings_u_per_wk;
  return value === null ? null : Math.round(value);
}

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Evaluate every history week newest-first via the unchanged detector.evaluate
 * and merge per (detector, scopeKey): the newest firing week (the anchor) supplies
 * figure, evidence and estimate; older firing weeks only count toward weeks_fired.
 * rec_id has no week component, so lifecycle state survives an anchor move.
 *
 * Each week is one transaction (cache rows + upserts). P2-U8: caching is per
 * (window, detector) in detector_eval_marks. A closed week re-runs only the
 * detectors whose version or declared non-turn inputs changed, or that saw a turn
 * land in the week since. W0 replays a detector's stored outcome when it declares
 * inputs, is not `clock`, and its version and W0 signature are unchanged.
 * Rec-GC runs once, after the full walk and merge: silent recs keep their anchor
 * and retire after three closed weeks without an emission.
 * A detector that throws is counted and skipped for that week (W0 included); the walk
 * continues, and its GC is skipped. After QUARANTINE_AT failures of one (detector,
 * version, window) the walk stops calling it there (status BLOCKED) until 24 h after
 * the last failure, then tries it again.
 */
export async function runHistoryWalk(
  db: Db,
  now: Date,
  opts: HistoryWalkOptions = {},
): Promise<HistoryWalkResult> {
  const detectors = opts.detectors ?? DETECTORS;
  const byId = new Map(detectors.map((d) => [d.id, d] as const));
  const idsJson = JSON.stringify([...byId.keys()]);
  const detectorSig = detectorCodeVersion(detectors);
  const nowIso = now.toISOString();
  const weeks = historyWeeks(db, now);
  const floor = opts.completeThroughMs;
  // The grid stays whole (the W0 transaction drops cache rows of weeks off the grid);
  // weeks before the floor are only left unevaluated.
  const belowFloor = (week: HistoryWeek) =>
    floor !== undefined && week.index !== 0 && Date.parse(week.start) < floor;
  const indexByStart = new Map(weeks.map((w) => [w.start, w.index] as const));
  const w0StartMs = now.getTime() - WEEK_MS;
  // The grid can leave a sliver between W1 and W0; retirement uses whole
  // weeks_ago values, so that sliver does not count as a closed silent week.
  const evaluatedWeeks: string[] = [];
  let statuses: LiveDetectorStatus[] = [];
  let newFindings = 0;
  let failedWeeks = 0;
  const failed = new Set<string>();
  const quarantined = new Set<string>();

  // Marks and quarantine rows as of the walk's start, read once (key: window|detector).
  // A pass reads each (window, detector) mark before it can write it.
  const evalMarks = new Map(
    (
      db
        .prepare(
          `SELECT window_key, detector_id, week_end, version, inputs_sig, turns_rowid_hwm,
                  window_from, outcome_json
             FROM detector_eval_marks`,
        )
        .all() as Array<EvalMarkRow & { window_key: string; detector_id: string }>
    ).map((m) => [`${m.window_key}|${m.detector_id}`, m] as const),
  );
  const quarantineRows = db
    .prepare(
      "SELECT detector_id, version, scope_key, fail_count, last_error_class, since FROM detector_quarantine",
    )
    .all() as Array<{
    detector_id: string;
    version: string;
    scope_key: string;
    fail_count: number;
    last_error_class: string;
    since: string;
  }>;
  const stNewTurn = db.prepare(
    "SELECT 1 FROM turns WHERE rowid > ? AND ts >= ? AND ts < ? LIMIT 1",
  );
  const stFiringWeeks = db.prepare(
    `SELECT week_start FROM detector_week_results
      WHERE detector_id = ? AND scope_key = ? AND fired = 1
      ORDER BY week_start DESC`,
  );
  const stCountMarks = db.prepare("SELECT COUNT(*) AS n FROM detector_week_marks");
  const stRec = db.prepare("SELECT evidence_json FROM recommendations WHERE rec_id = ?");
  const stSetEvidence = db.prepare("UPDATE recommendations SET evidence_json = ? WHERE rec_id = ?");

  function recencyFor(detectorId: string, scopeKey: string): RecencyFacts | null {
    const rows = stFiringWeeks.all(detectorId, scopeKey) as Array<{ week_start: string }>;
    const anchor = rows[0];
    if (anchor === undefined) return null;
    return {
      last_seen_week_start: anchor.week_start,
      weeks_ago: indexByStart.get(anchor.week_start) ?? 0,
      weeks_fired: rows.length,
      weeks_evaluated: (stCountMarks.get() as { n: number }).n,
    };
  }

  /**
   * Rewrite only the recency counts of a rec whose stored evidence already comes
   * from `recency`'s anchor week. Never moves the anchor: a rec whose stored
   * anchor differs (or that has none) keeps its evidence until its anchor week is
   * re-evaluated. Returns false when the stored anchor does not match.
   */
  function refreshRecency(id: string, detector: AnyDetector, recency: RecencyFacts): boolean {
    const row = stRec.get(id) as RecEvidenceRow | undefined;
    if (row === undefined) return false;
    const parsed = JSON.parse(row.evidence_json) as {
      facts?: Record<string, unknown>;
      recency?: Record<string, unknown>;
      metrics?: Record<string, unknown>;
    };
    const stored = (parsed.facts ?? parsed.recency)?.last_seen_week_start;
    if (stored !== recency.last_seen_week_start) return false;
    let next: string;
    if (detector.contractVersion === 1) {
      next = serializeRecommendationPayloadV1(
        { ...parsed, facts: { ...parsed.facts, ...recency } },
        detector.id,
      );
    } else if (metricsDrifted(parsed.metrics, detector.descriptor.metrics)) {
      // Stored under an older descriptor (P3.1-T4 dropped TOOL_CLASS from A1/C2 and added
      // SESSION_COUNT to C2): the current contract rejects the body, and its missing
      // values cannot be rebuilt. Recency sits outside the digest, so rewrite only it.
      next = JSON.stringify({ ...parsed, recency });
    } else {
      next = serializeFindingEnvelopeV2({ ...parsed, recency }, detector.descriptor);
    }
    if (next !== row.evidence_json) stSetEvidence.run(next, id);
    return true;
  }

  // ── Input signatures (P2-U8). Each part is computed at most once per walk, and only
  // when some detector being checked declares its table.
  const parts = new Map<string, string>();
  function part(key: string, compute: (hash: crypto.Hash) => void): string {
    let value = parts.get(key);
    if (value === undefined) {
      const hash = crypto.createHash("sha1");
      compute(hash);
      value = hash.digest("hex");
      parts.set(key, value);
    }
    return value;
  }
  const isNonTurn = (table: DetectorInputTable): table is NonTurnInputTable =>
    table in NON_TURN_INPUT_SQL;
  const nonTurnPart = (table: NonTurnInputTable) =>
    part(table, (hash) => hashRows(db, NON_TURN_INPUT_SQL[table], hash));
  const allNonTurn = Object.keys(NON_TURN_INPUT_SQL) as NonTurnInputTable[];
  function signature(
    tables: readonly DetectorInputTable[],
    partOf: (t: DetectorInputTable) => string,
  ): string {
    const hash = crypto.createHash("sha1");
    for (const table of [...new Set(tables)].sort()) hash.update(`${table}:${partOf(table)}\n`);
    return hash.digest("hex");
  }

  /** Closed-week signature: the declared non-turn tables (all of them for a detector without `inputs`). */
  function closedSig(detector: AnyDetector): string {
    const tables = detector.inputs?.tables.filter(isNonTurn) ?? allNonTurn;
    return signature(tables, (t) => nonTurnPart(t as NonTurnInputTable));
  }

  /**
   * One declared table's part of the W0 signature. Windowed tables: the full-row content
   * of the window's rows plus MAX(rowid) (an insert of any age). sessions and subagent_meta:
   * full-table content (small; ingest updates them in place). Other turn-coupled tables:
   * MAX(rowid). Accepted gap: an UPDATE to a turn-coupled row older than the window.
   */
  function w0Part(table: DetectorInputTable, w0: HistoryWeek): string {
    if (isNonTurn(table)) return nonTurnPart(table);
    if (table === "sessions" || table === "subagent_meta") {
      return part(`${table}@all`, (hash) =>
        hashRows(db, `SELECT * FROM ${table} ORDER BY rowid`, hash),
      );
    }
    const hwm = part(`${table}@hwm`, (hash) => {
      const row = db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() as { m: number | null };
      hash.update(String(row.m));
    });
    const column = WINDOWED_TABLES[table];
    if (column === undefined) return hwm;
    const content = part(`${table}@W0`, (hash) => {
      const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
        .map((c) => `quote("${c.name}")`)
        .join(" || ',' || ");
      const row = db
        .prepare(
          `SELECT group_concat(${columns}, char(10) ORDER BY rowid) AS s
             FROM ${table} WHERE ${column} >= ? AND ${column} < ?`,
        )
        .get(w0.start, w0.end) as { s: string | null };
      hash.update(row.s ?? "");
    });
    return `${content}/${hwm}`;
  }

  /** W0 signature, or undefined when the detector cannot be served from cache. */
  function w0Sig(detector: AnyDetector, w0: HistoryWeek): string | undefined {
    const inputs = detector.inputs;
    if (inputs === undefined || inputs.clock === true) return undefined;
    return signature(inputs.tables, (t) => w0Part(t, w0));
  }

  interface EvalMarkRow {
    week_end: string;
    version: string;
    inputs_sig: string;
    turns_rowid_hwm: number;
    window_from: string;
    outcome_json: string | null;
  }

  /** The detectors a closed week must re-run (the rest are served from detector_week_results). */
  function staleDetectors(week: HistoryWeek): AnyDetector[] {
    const turnLanded = new Map<number, boolean>();
    return detectors.filter((detector) => {
      const mark = evalMarks.get(`${week.start}|${detector.id}`);
      if (
        mark === undefined ||
        mark.week_end !== week.end ||
        mark.version !== versionOf(detector) ||
        mark.inputs_sig !== closedSig(detector)
      ) {
        return true;
      }
      let landed = turnLanded.get(mark.turns_rowid_hwm);
      if (landed === undefined) {
        landed = stNewTurn.get(mark.turns_rowid_hwm, week.start, week.end) !== undefined;
        turnLanded.set(mark.turns_rowid_hwm, landed);
      }
      return landed;
    });
  }

  const stFail = db.prepare(
    `INSERT INTO detector_quarantine
       (detector_id, version, scope_key, fail_count, last_error_class, since)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(detector_id, version, scope_key) DO UPDATE SET
       fail_count = fail_count + 1, last_error_class = excluded.last_error_class,
       since = excluded.since`,
  );

  interface EvalMark {
    detectorId: string;
    version: string;
    /** null: not cacheable here (W0 without inputs, or `clock`); no mark is written. */
    sig: string | null;
    outcomeJson: string | null;
  }

  /** Persist one evaluated week atomically; detector reads run before this transaction. */
  const evaluateWeekTx = db.transaction(
    (
      week: HistoryWeek,
      hwm: number,
      firedAll: Array<{ detector: AnyDetector; fired: Fired | FiredV2 }>,
      weekStatuses: LiveDetectorStatus[],
      marks: EvalMark[],
      weekFailed: boolean,
    ): number => {
      if (week.index === 0) {
        // Drop cache rows for weeks no longer on the grid (weekly roll, grid phase change).
        const startsJson = JSON.stringify(weeks.map((w) => w.start));
        db.prepare(
          "DELETE FROM detector_week_results WHERE week_start NOT IN (SELECT value FROM json_each(?))",
        ).run(startsJson);
        db.prepare(
          "DELETE FROM detector_week_marks WHERE week_start NOT IN (SELECT value FROM json_each(?))",
        ).run(startsJson);
        db.prepare(
          `DELETE FROM detector_eval_marks
            WHERE window_key <> 'W0' AND window_key NOT IN (SELECT value FROM json_each(?))`,
        ).run(startsJson);
      }
      const windowKey = week.index === 0 ? "W0" : week.start;
      // Only the detectors that produced an outcome here replace their rows.
      db.prepare(
        `DELETE FROM detector_week_results
        WHERE week_start = ? AND detector_id IN (SELECT value FROM json_each(?))`,
      ).run(week.start, JSON.stringify(marks.map((m) => m.detectorId)));
      const insertResult = db.prepare(
        `INSERT OR REPLACE INTO detector_week_results
         (detector_id, scope_key, week_start, scope_workspace_id, fired, rank_value_u, evaluated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      );
      for (const { detector, fired } of firedAll) {
        insertResult.run(
          detector.id,
          fired.scopeKey,
          week.start,
          fired.scope_workspace_id,
          rankValueU(fired),
          nowIso,
        );
      }
      if (week.index === 0 && byId.has("D11")) retireLegacyD11(db);
      if (week.index === 0 && byId.has("C1")) retireLegacyC1(db);
      // weeks_evaluated counts these rows; a week with a failed detector is not complete.
      if (!weekFailed) {
        db.prepare(
          `INSERT OR REPLACE INTO detector_week_marks
           (week_start, week_end, evaluated_at, turns_rowid_hwm, detector_ids, inputs_sig)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          week.start,
          week.end,
          nowIso,
          hwm,
          detectorSig,
          // Unread since P2-U8 (staleness is per detector in detector_eval_marks).
          "",
        );
      }
      // One statement for the week's marks (a null sig is never served from cache: no mark).
      db.prepare(
        `INSERT OR REPLACE INTO detector_eval_marks
           (window_key, detector_id, week_end, version, inputs_sig, turns_rowid_hwm,
            window_from, outcome_json, evaluated_at)
         SELECT ?, value ->> '$.detectorId', ?, value ->> '$.version', value ->> '$.sig', ?, ?,
                value ->> '$.outcomeJson', ?
           FROM json_each(?)`,
      ).run(
        windowKey,
        week.end,
        hwm,
        week.start,
        nowIso,
        JSON.stringify(marks.filter((m) => m.sig !== null)),
      );
      const stClearQuarantine = db.prepare(
        "DELETE FROM detector_quarantine WHERE detector_id = ? AND scope_key = ?",
      );
      for (const m of marks) {
        if (
          quarantineRows.some((q) => q.detector_id === m.detectorId && q.scope_key === windowKey)
        ) {
          stClearQuarantine.run(m.detectorId, windowKey);
        }
      }
      let inserted = 0;
      for (const { detector, fired } of firedAll) {
        const recency = recencyFor(detector.id, fired.scopeKey);
        if (recency === null) continue;
        const id = recId(detector.id, fired.scope_workspace_id, fired.scopeKey);
        if (recency.last_seen_week_start === week.start) {
          if (stRec.get(id) === undefined) inserted++;
          upsertFired(db, detector, fired, nowIso, recency);
        } else {
          refreshRecency(id, detector, recency);
        }
      }
      if (week.index === 0) {
        // Persist W0 statuses so listRecommendations can read them without
        // re-evaluating every detector (P4 open item b).  Scoped delete: only
        // replace the rows for this walk's detector set so a subset walk (tests
        // pass opts.detectors) does not wipe unrelated detector rows.
        db.prepare(
          "DELETE FROM detector_status_live WHERE detector_id IN (SELECT value FROM json_each(?))",
        ).run(idsJson);
        const stInsertLive = db.prepare(
          `INSERT OR REPLACE INTO detector_status_live
           (detector_id, ordinal, name, status, note, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const s of weekStatuses) {
          stInsertLive.run(
            s.detector_id,
            REGISTRY_ORDINALS.get(s.detector_id) ?? 999,
            s.name,
            s.status,
            s.note,
            nowIso,
          );
        }
        statuses = weekStatuses;
      }
      return inserted;
    },
  );

  /**
   * Evaluate `toRun` over one week; returns the recs it newly inserted. W0 replays a
   * detector's stored outcome when its W0 signature is unchanged. A detector that
   * throws is recorded in detector_quarantine, gets no mark and keeps its old rows;
   * the others are persisted (R-6). A failing transaction rolls the week back: a closed
   * week is counted and skipped (F4), a W0 one propagates.
   */
  async function evaluateWeek(week: HistoryWeek, toRun: readonly AnyDetector[]): Promise<number> {
    const isW0 = week.index === 0;
    const windowKey = isW0 ? "W0" : week.start;
    const hwm =
      (db.prepare("SELECT MAX(rowid) AS hwm FROM turns").get() as { hwm: number | null }).hwm ?? 0;
    const firedAll: Array<{ detector: AnyDetector; fired: Fired | FiredV2 }> = [];
    const weekStatuses: LiveDetectorStatus[] = [];
    const marks: EvalMark[] = [];
    let ran = false;
    let weekFailed = false;
    for (const detector of toRun) {
      const version = versionOf(detector);
      const q = quarantineRows.find(
        (r) => r.detector_id === detector.id && r.version === version && r.scope_key === windowKey,
      );
      if (
        q !== undefined &&
        q.fail_count >= QUARANTINE_AT &&
        now.getTime() - Date.parse(q.since) < QUARANTINE_RETRY_MS
      ) {
        quarantined.add(detector.id);
        weekStatuses.push({
          detector_id: detector.id,
          name: detector.name,
          status: "BLOCKED",
          note: `quarantined after ${q.fail_count} errors (${q.last_error_class})`,
        });
        continue;
      }
      const sig = isW0 ? w0Sig(detector, week) : closedSig(detector);
      let outcome: ReturnType<AnyDetector["evaluate"]> | undefined;
      if (isW0 && sig !== undefined) {
        const mark = evalMarks.get(`W0|${detector.id}`);
        if (mark?.outcome_json != null && mark.version === version && mark.inputs_sig === sig) {
          outcome = JSON.parse(
            rebaseWindow(
              mark.outcome_json,
              [mark.window_from, mark.week_end],
              [week.start, week.end],
            ),
          ) as ReturnType<AnyDetector["evaluate"]>;
          if (detector.contractVersion === 2) {
            // The digest covers the window: re-seal the rebased body.
            for (const fired of outcome.fired as FiredV2[]) {
              const { evidence_digest: _stale, ...body } = fired.payload;
              fired.payload = createFindingEnvelopeV2(body, detector.descriptor);
            }
          }
        }
      }
      if (outcome === undefined) {
        ran = true;
        opts.detectorHook?.onStart?.(detector.id);
        const evalStart = performance.now();
        // Review fix (P0-U10): a detector that throws must still get its onEnd —
        // otherwise its onStart snapshot is silently dropped when the next
        // detector's onStart overwrites it, undercounting its totals with no signal.
        try {
          outcome = detector.evaluate(db, week.ctx);
        } catch (e) {
          weekFailed = true;
          failed.add(detector.id);
          stFail.run(detector.id, version, windowKey, errorClass(e), nowIso);
          console.warn(
            `history walk: ${detector.id} failed in week ${week.index} (${errorClass(e)})`,
          );
          weekStatuses.push({
            detector_id: detector.id,
            name: detector.name,
            status: "BLOCKED",
            note: `evaluation failed (${errorClass(e)})`,
          });
          continue;
        } finally {
          opts.detectorHook?.onEnd?.(detector.id, performance.now() - evalStart);
        }
        if (isW0) await yieldTurn();
      }
      weekStatuses.push({
        detector_id: detector.id,
        name: detector.name,
        status: outcome.status,
        note: outcome.note,
      });
      for (const fired of outcome.fired) firedAll.push({ detector, fired });
      marks.push({
        detectorId: detector.id,
        version,
        sig: sig ?? null,
        outcomeJson: isW0 && sig !== undefined ? JSON.stringify(outcome) : null,
      });
    }
    if (weekFailed) failedWeeks++;
    if (!isW0 && !ran) return 0;
    let inserted: number;
    try {
      const kept =
        floor === undefined
          ? firedAll
          : firedAll.filter(({ detector, fired }) => {
              const readsFromMs = Math.min(
                Date.parse(week.ctx.fromIso),
                week.ctx.now.getTime() - (READ_BACK_DAYS[detector.id] ?? 0) * MS_PER_DAY,
              );
              return (
                readsFromMs >= floor ||
                stRec.get(recId(detector.id, fired.scope_workspace_id, fired.scopeKey)) !==
                  undefined
              );
            });
      inserted = evaluateWeekTx(week, hwm, kept, weekStatuses, marks, weekFailed);
    } catch (e) {
      if (isW0) throw e;
      if (!weekFailed) failedWeeks++;
      for (const m of marks) failed.add(m.detectorId);
      console.warn(
        `history walk: week ${week.index} / ${weeks.length - 1} failed (${failedWeeks} failed this walk)`,
      );
      return 0;
    }
    if (ran && !weekFailed) evaluatedWeeks.push(week.start);
    newFindings += inserted;
    return inserted;
  }

  // 1) Newest-first walk: W0, then each closed week (its fresh detectors served from cache).
  for (const [i, week] of weeks.entries()) {
    const toRun = belowFloor(week) ? [] : week.index === 0 ? detectors : staleDetectors(week);
    const found = toRun.length > 0 ? await evaluateWeek(week, toRun) : 0;
    opts.onWeek?.({ weeks_done: i + 1, weeks_total: weeks.length, new_findings: found });
    if (toRun.length > 0) await yieldTurn();
  }

  // 2) Merge: refresh every key's recency counts. A key whose stored evidence is
  // not from its anchor week (e.g. it stopped firing in W0 and the anchor fell back
  // to a cached closed week) gets that anchor week re-evaluated, so the rec's
  // figure/evidence/estimate follow the anchor. Each week is re-evaluated at most
  // once here, which bounds the loop.
  const reevaluated = new Set<string>();
  let keys: KeyRow[];
  const stKeys = db.prepare(
    `SELECT detector_id, scope_key, scope_workspace_id, MAX(week_start) AS anchor
       FROM detector_week_results
      WHERE fired = 1 AND detector_id IN (SELECT value FROM json_each(?))
      GROUP BY detector_id, scope_key`,
  );
  for (;;) {
    keys = stKeys.all(idsJson) as KeyRow[];
    // anchor week → the detectors whose keys need it re-evaluated
    const stale = new Map<string, Set<string>>();
    db.transaction(() => {
      for (const key of keys) {
        const detector = byId.get(key.detector_id);
        const recency = recencyFor(key.detector_id, key.scope_key);
        if (detector === undefined || recency === null) continue;
        const id = recId(key.detector_id, key.scope_workspace_id, key.scope_key);
        if (!refreshRecency(id, detector, recency) && !reevaluated.has(key.anchor)) {
          stale.set(key.anchor, (stale.get(key.anchor) ?? new Set()).add(key.detector_id));
        }
      }
    })();
    if (stale.size === 0) break;
    for (const start of [...stale.keys()].sort().reverse()) {
      reevaluated.add(start);
      const week = weeks[indexByStart.get(start) ?? -1];
      // W0 already ran (or replayed) every detector this pass.
      if (week === undefined || week.index === 0 || belowFloor(week)) continue;
      const ids = stale.get(start);
      await evaluateWeek(
        week,
        detectors.filter((d) => ids?.has(d.id)),
      );
      await yieldTurn();
    }
  }

  // 3) Identify keys that fired during this walk. Silent recommendations stay
  // persisted while their recency ages toward retirement.
  const liveIdsJson = JSON.stringify(
    keys.map((k) => recId(k.detector_id, k.scope_workspace_id, k.scope_key)),
  );
  const anchorSql = `COALESCE(json_extract(evidence_json, '$.facts.last_seen_week_start'),
                              json_extract(evidence_json, '$.recency.last_seen_week_start'))`;
  // Keep silent recommendations so their lifecycle can age into RETIRED. The
  // sliver between W1 and W0 still cannot count as a closed silent week.

  // 4) Recs of walked detectors whose key fires in no grid week keep their
  // anchor, but weeks_ago / weeks_evaluated are recomputed and weeks_fired = 0.
  const weeksEvaluated = (stCountMarks.get() as { n: number }).n;
  const notLive = db
    .prepare(
      `SELECT rec_id, detector_id, evidence_json FROM recommendations
        WHERE detector_id IN (SELECT value FROM json_each(?))
          AND rec_id NOT IN (SELECT value FROM json_each(?))
          AND ${anchorSql} IS NOT NULL`,
    )
    .all(idsJson, liveIdsJson) as Array<{ rec_id: string; detector_id: string } & RecEvidenceRow>;
  db.transaction(() => {
    for (const row of notLive) {
      const detector = byId.get(row.detector_id);
      if (detector === undefined) continue;
      const parsed = JSON.parse(row.evidence_json) as {
        facts?: Record<string, unknown>;
        recency?: Record<string, unknown>;
      };
      const lastSeen = (parsed.facts ?? parsed.recency)?.last_seen_week_start;
      if (typeof lastSeen !== "string") continue;
      refreshRecency(row.rec_id, detector, {
        last_seen_week_start: lastSeen,
        weeks_ago: Math.max(0, Math.floor((w0StartMs - Date.parse(lastSeen)) / WEEK_MS)),
        weeks_fired: 0,
        weeks_evaluated: weeksEvaluated,
      });
    }
  })();

  // A floored walk has not seen the weeks a silent rec may still fire in: no GC.
  // A detector that failed or was quarantined this pass keeps its recs as they are.
  const gcIdsJson = JSON.stringify(
    [...byId.keys()].filter((id) => !failed.has(id) && !quarantined.has(id)),
  );
  if (floor === undefined) {
    const weeksAgoSql = `COALESCE(json_extract(evidence_json, '$.facts.weeks_ago'),
                                   json_extract(evidence_json, '$.recency.weeks_ago'))`;
    db.prepare(
      `UPDATE recommendations SET state = 'RETIRED', dismissed_until = NULL
         WHERE detector_id IN (SELECT value FROM json_each(?))
           AND state IN ('PROPOSED', 'DISMISSED')
           AND ${weeksAgoSql} >= 4`,
    ).run(gcIdsJson);
    db.prepare(
      `UPDATE recommendations SET state = 'PROPOSED', dismissed_until = NULL
         WHERE detector_id IN (SELECT value FROM json_each(?))
           AND rec_id IN (SELECT value FROM json_each(?))
           AND state = 'RETIRED' AND ${weeksAgoSql} = 0`,
    ).run(gcIdsJson, liveIdsJson);
  }

  for (const d of UNEVALUATED_DETECTORS) {
    statuses.push({ detector_id: d.id, name: d.name, status: d.status, note: d.note });
  }
  return {
    statuses,
    weeks_total: weeks.length,
    evaluated_weeks: evaluatedWeeks,
    new_findings: newFindings,
    failed_weeks: failedWeeks,
    failed_detectors: failed.size,
  };
}
