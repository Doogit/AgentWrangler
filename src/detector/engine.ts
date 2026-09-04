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
import type { Db } from "../db/open.js";
import { DETECTORS, UNEVALUATED_DETECTORS } from "./registry.js";
import type { DetectorContext, DetectorStatusKind, Fired } from "./types.js";

const WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

/** Deterministic rec_id: rec-<detector_id>-<scope>-<sha1(scopeKey)[:16]>. */
function recId(detectorId: string, scopeWorkspaceId: string | null, scopeKey: string): string {
  const scope = scopeWorkspaceId ?? "global";
  const hash = crypto.createHash("sha1").update(scopeKey).digest("hex").slice(0, 16);
  return `rec-${detectorId}-${scope}-${hash}`;
}

const UPSERT_SQL = `
  INSERT INTO recommendations
    (rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
     lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
     state, created_at, adopted_at, dismissed_until)
  VALUES (?, 'RULE', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, NULL, NULL)
  ON CONFLICT(rec_id) DO UPDATE SET
    modeled_savings_u_per_wk = excluded.modeled_savings_u_per_wk,
    modeled_formula_json     = excluded.modeled_formula_json,
    evidence_json            = excluded.evidence_json,
    target_metric            = excluded.target_metric
`;

function upsertFired(db: Db, detectorId: string, fired: Fired, nowIso: string): void {
  db.prepare(UPSERT_SQL).run(
    recId(detectorId, fired.scope_workspace_id, fired.scopeKey),
    detectorId,
    fired.category,
    fired.scope_workspace_id,
    fired.lever,
    fired.modeled_savings_u_per_wk,
    JSON.stringify(fired.modeled_formula),
    JSON.stringify(fired.evidence),
    fired.target_metric,
    nowIso,
  );
}

/**
 * Evaluate all registered detectors and upsert fired rows. Returns the live
 * status list (used for the detectors[] strip). Read-only w.r.t. ingest tables;
 * writes only `recommendations`.
 */
export function runDetectors(db: Db, ctx: DetectorContext): LiveDetectorStatus[] {
  const nowIso = ctx.now.toISOString();
  const statuses: LiveDetectorStatus[] = [];

  const tx = db.transaction(() => {
    for (const detector of DETECTORS) {
      const outcome = detector.evaluate(db, ctx);
      for (const fired of outcome.fired) {
        upsertFired(db, detector.id, fired, nowIso);
      }
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
