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
import type {
  FindingDescriptorV2,
  FindingEnvelopeV2,
  RecommendationPayloadV1,
} from "./privacy-contract.js";
import type { Estimate } from "./savings.js";

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
  scope_workspace_id: string | null; // null = global
  modeled_savings_u_per_wk: number | null; // null for warning-class (D5)
  /** Additive formula details persisted with the contract-derived formula metadata. */
  modeled_formula_json?: Readonly<{ estimate: Estimate }>;
  payload: RecommendationPayloadV1;
}

export interface FiredV2 extends Omit<Fired, "payload"> {
  payload: FindingEnvelopeV2;
}

/** One detector's evaluation result: rows to persist + the live status. */
export interface DetectorOutcome {
  fired: Fired[];
  status: DetectorStatusKind;
  /** Honest reason for the status, e.g. 'no :limit_tokens configured'. */
  note: string;
}

/** P2-U8 (A-5): the grain a detector's findings aggregate over. Declarative. */
export type DetectorScope = "turn" | "session" | "cross-session";

/**
 * Tables a detector (or a helper it calls) reads. The walk's dirty gate signs only
 * these, so a declaration that misses a table under-invalidates: the contract test
 * checks every SQL statement a detector runs on the shared seed against it.
 */
export type DetectorInputTable =
  | "turns"
  | "sessions"
  | "tool_events"
  | "tool_event_metadata"
  | "tool_event_content"
  | "tool_event_skills"
  | "ingest_metric_events"
  | "subagent_meta"
  | "work_items"
  | "observed_outcomes"
  | "session_work_links"
  | "context_inventory"
  | "catalog_items"
  | "workspaces"
  | "pricing_snapshots"
  | "user_config"
  | "limit_snapshots";

export interface DetectorInputs {
  tables: readonly DetectorInputTable[];
  /**
   * The outcome depends on the wall clock or on state the window's rows do not
   * carry (a forecast from `now`, a live snapshot table). W0 then always re-runs.
   */
  clock?: true;
}

/**
 * P2-U8 contract metadata. `version` is bumped when evaluation logic changes; it
 * re-stales only that detector's cached weeks and is not part of the rec_id.
 * Optional on the type so test stubs stay small; every registered detector
 * declares all three (contract test). A detector without `inputs` is never
 * served from the W0 cache.
 */
export interface DetectorMeta {
  version?: string;
  scope?: DetectorScope;
  inputs?: DetectorInputs;
}

/** A registered detector. `evaluate` is read-only w.r.t. ingest tables. */
export interface Detector extends DetectorMeta {
  contractVersion: 1;
  id: string; // Stable runtime id, e.g. 'D1', 'D7', 'D10'.
  name: string; // e.g. 'SESSION_LONG_FULL_CONTEXT'
  evaluate(db: Db, ctx: DetectorContext): DetectorOutcome;
}

export interface DetectorV2 extends DetectorMeta {
  contractVersion: 2;
  descriptor: FindingDescriptorV2;
  id: string;
  name: string;
  evaluate(db: Db, ctx: DetectorContext): Omit<DetectorOutcome, "fired"> & { fired: FiredV2[] };
}

export type AnyDetector = Detector | DetectorV2;
