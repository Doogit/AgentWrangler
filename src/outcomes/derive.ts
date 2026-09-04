/**
 * src/outcomes/derive.ts — Outcome derivation.
 *
 * Pure versioned deriveOutcome() per plan §3.4 + Spec §3.
 * 5 branches:
 *   1. state=OPEN              → IN_PROGRESS
 *   2. state=CLOSED (abandoned) → OBSERVED_FAILURE  (no merge)
 *   3. state=MERGED, deferral findings → OBSERVED_SUCCESS_WITH_DEFERRALS
 *   4. state=MERGED, checks=FAILURE   → OBSERVED_FAILURE
 *   5. state=MERGED, otherwise        → OBSERVED_SUCCESS
 *   checks=NONE: MERGED + no CI → treat as OBSERVED_SUCCESS (checks_conclusion='NONE' annotation only)
 *
 * writeObservedOutcomes(): upserts derived outcomes for all linked terminal PRs.
 */

import type { Db } from "../db/open.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObservedOutcome =
  | "OBSERVED_SUCCESS"
  | "OBSERVED_SUCCESS_WITH_DEFERRALS"
  | "OBSERVED_FAILURE"
  | "IN_PROGRESS";

export interface WorkItemForDerivation {
  work_item_id: string;
  state: string; // OPEN|MERGED|CLOSED
  checks_conclusion: string | null; // SUCCESS|FAILURE|PENDING|NONE|null
}

export interface FindingForDerivation {
  status: string; // ADDRESSED|DEFERRED|UNKNOWN
  source: string; // UNRESOLVED_THREAD|DEFERRAL_SECTION|DIFF_MARKER|LLM
  human_state: string | null; // CONFIRMED|REJECTED|null
  extractor_version: string;
}

export const METHODOLOGY_VERSION = "outcome-v1";

// COND-1: per-extractor precision map. All three extractors are EXPERIMENTAL
// and excluded from gated/deferral denominators.
const EXPERIMENTAL_SOURCES = new Set(["UNRESOLVED_THREAD", "DEFERRAL_SECTION", "DIFF_MARKER"]);

/**
 * A finding counts toward deferral denominators only when:
 *  - source is deterministic (not LLM, not EXPERIMENTAL source)
 *  - OR (source=LLM AND human_state='CONFIRMED')
 * Since all three current extractors are EXPERIMENTAL, this effectively means
 * only LLM+CONFIRMED findings count in gated denominators (conservative COND-1).
 */
function isGatedFinding(f: FindingForDerivation): boolean {
  if (EXPERIMENTAL_SOURCES.has(f.source)) return false; // COND-1 exclusion
  if (f.source === "LLM" && f.human_state !== "CONFIRMED") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Core derivation (pure — no DB access)
// ---------------------------------------------------------------------------

/**
 * Derive the outcome for a single work item.
 * Findings passed in may be empty ([]) if no findings exist.
 *
 * The COND-1 gate applies only to the deferral branch:
 *   OBSERVED_SUCCESS_WITH_DEFERRALS requires ≥1 gated DEFERRED finding.
 *   Experimental findings are written and displayed but not counted toward
 *   this determination (conservative).
 */
export function deriveOutcome(
  workItem: WorkItemForDerivation,
  findings: FindingForDerivation[],
): ObservedOutcome {
  // Branch 1: still open
  if (workItem.state === "OPEN") return "IN_PROGRESS";

  // Branch 2: closed without merge (abandoned)
  if (workItem.state === "CLOSED") return "OBSERVED_FAILURE";

  // state === "MERGED" beyond here
  // Branch 4: CI failure
  if (workItem.checks_conclusion === "FAILURE") return "OBSERVED_FAILURE";

  // Branch 3: gated deferred findings → success with deferrals
  const hasDeferral = findings.some((f) => f.status === "DEFERRED" && isGatedFinding(f));
  if (hasDeferral) return "OBSERVED_SUCCESS_WITH_DEFERRALS";

  // Branch 5 (incl. checks=NONE + checks=SUCCESS): clean success
  return "OBSERVED_SUCCESS";
}

// ---------------------------------------------------------------------------
// DB write pass
// ---------------------------------------------------------------------------

/**
 * Derive and write observed_outcomes for all linked terminal PRs.
 * "Terminal" = state in (MERGED, CLOSED) with ≥1 session_work_links row.
 * Idempotent — ON CONFLICT DO UPDATE.
 */
export function writeObservedOutcomes(
  db: Db,
  methodologyVersion: string = METHODOLOGY_VERSION,
): void {
  const workItems = db
    .prepare(
      `SELECT wi.work_item_id, wi.state, wi.checks_conclusion
       FROM work_items wi
       WHERE wi.state IN ('MERGED', 'CLOSED')
         AND EXISTS (SELECT 1 FROM session_work_links l WHERE l.work_item_id = wi.work_item_id)`,
    )
    .all() as WorkItemForDerivation[];

  const getFindingsStmt = db.prepare(
    `SELECT status, source, human_state, extractor_version
     FROM review_findings WHERE work_item_id = ?`,
  );

  const upsert = db.prepare(`
    INSERT INTO observed_outcomes (work_item_id, outcome, derived_at, methodology_version)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET
      outcome             = excluded.outcome,
      derived_at          = excluded.derived_at,
      methodology_version = excluded.methodology_version
  `);

  const now = new Date().toISOString();

  for (const wi of workItems) {
    const findings = getFindingsStmt.all(wi.work_item_id) as FindingForDerivation[];
    const outcome = deriveOutcome(wi, findings);
    upsert.run(wi.work_item_id, outcome, now, methodologyVersion);
  }
}
