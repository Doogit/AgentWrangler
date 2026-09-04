/**
 * src/detector/types.ts — DetectorEngine shared types (Tier-1 recs D1/D2/D5).
 *
 * A Detector evaluates the trailing-7d window (anchored at an injected `now`,
 * never new Date()) and returns a DetectorOutcome: zero or more Fired rows to
 * upsert into `recommendations`, plus one live status for the query layer's
 * detectors[] strip. Non-firing statuses (INACTIVE/BLOCKED/NOT_EVALUATED) are
 * NOT persisted (the DDL `state` CHECK forbids them) — only Fired rows persist
 * as state='PROPOSED'.
 *
 * SEC-101: evidence/modeled-formula blobs carry ids + metric names + numbers
 * only — never transcript text.
 */

import type { Db } from "../db/open.js";

/** Detector evaluation context — the trailing-7d window anchored at `now`. */
export interface DetectorContext {
  /** Injected wall clock (the ingestor's this.opts.now()). Never new Date() inside detectors. */
  now: Date;
  /** ISO lower bound (inclusive) = now - 7d. */
  fromIso: string;
  /** ISO upper bound (exclusive) = now. */
  toIso: string;
}

/** Reproducible modeled-savings formula blob (stored as modeled_formula_json). */
export interface ModeledFormula {
  model: string;
  inputs: Record<string, number>;
  expression?: string;
  result_usd_per_wk?: number;
  kind?: string;
}

/** Live per-detector status kinds surfaced in the query DTO's detectors[]. */
export type DetectorStatusKind = "ACTIVE" | "INACTIVE" | "BLOCKED" | "NOT_EVALUATED";

/** A fired trigger → one `recommendations` row (state='PROPOSED' on first insert). */
export interface Fired {
  /** Stable identity string for the deterministic rec_id (§2.3). */
  scopeKey: string;
  category: string; // 'CONTEXT' | 'LIMIT' | 'CACHE' | 'TOOLING' | 'SESSION_HYGIENE' | 'MODEL'
  scope_workspace_id: string | null; // null = global
  lever: string;
  target_metric: string;
  modeled_savings_u_per_wk: number | null; // null for warning-class (D5)
  modeled_formula: ModeledFormula;
  evidence: Record<string, unknown>;
}

/** One detector's evaluation result: rows to persist + the live status. */
export interface DetectorOutcome {
  fired: Fired[];
  status: DetectorStatusKind;
  /** Honest reason for the status, e.g. 'no :limit_tokens configured'. */
  note: string;
}

/** A registered detector. `evaluate` is read-only w.r.t. ingest tables. */
export interface Detector {
  id: string; // Stable runtime id, e.g. 'D1', 'D7', 'D10'.
  name: string; // e.g. 'SESSION_LONG_FULL_CONTEXT'
  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome;
}
