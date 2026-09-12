/**
 * RIQ3 relevance-feedback + goal-preference store (migration 021).
 *
 * Local, additive, deterministic. Persists only enums, ids, scope keys, and
 * timestamps — no free text, no raw content, no model/training call (SEC-101).
 * Feedback affects relevance/ranking only; it never records measured outcomes.
 *
 * Schema + semantics: docs/plans/spec-riq3-feedback-storage.md.
 * Ranker feed shape must stay compatible with decision-ranker-types.ts.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "../../db/open.js";
import { buildResponse } from "../envelope.js";
import type { CooldownInput, MaterialityBand, RankingGoal } from "./decision-ranker-types.js";

// ---------------------------------------------------------------------------
// Enums (frozen by the migration CHECK constraints)
// ---------------------------------------------------------------------------

export const FEEDBACK_KINDS = [
  "NOT_APPLICABLE",
  "ALREADY_DONE",
  "ACCEPTED_TRADEOFF",
  "NOT_USEFUL",
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const GOAL_PREFERENCES = [
  "PRESERVE_QUALITY",
  "REDUCE_RESOURCE_USE",
  "INVESTIGATE_FRICTION",
] as const;
/** Goal-preference enum — identical to the ranker's RankingGoal. */
export type GoalPreference = RankingGoal;

const MATERIALITY_BANDS = ["SMALL", "MODERATE", "LARGE", "UNKNOWN"] as const;

/** Default goal when a scope has no stored preference (spec §goal). */
export const DEFAULT_GOAL: GoalPreference = "PRESERVE_QUALITY";

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

/** An active relevance-feedback row for one (scope_key, rec_identity) pair. */
export interface FeedbackRow {
  scope_key: string;
  rec_identity: string;
  feedback: FeedbackKind;
  cooldown_until: string | null;
  dismissed_materiality_band: MaterialityBand | null;
  created_at: string;
  updated_at: string;
}

export interface SetFeedbackInput {
  scope_key: string;
  rec_identity: string;
  feedback: FeedbackKind;
  cooldown_until?: string | null;
  dismissed_materiality_band?: MaterialityBand | null;
}

/** Thrown for a malformed feedback/goal request. Maps to an HTTP status. */
export class FeedbackError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

// ---------------------------------------------------------------------------
// Storage operations — feedback (keyed on scope_key + rec_identity)
// ---------------------------------------------------------------------------

interface Row {
  scope_key: string;
  rec_identity: string;
  feedback: FeedbackKind;
  cooldown_until: string | null;
  dismissed_materiality_band: MaterialityBand | null;
  created_at: string;
  updated_at: string;
}

function immediate<T>(db: Db, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Upsert the active feedback row for a pair. The partial unique index keeps at
 * most one active row while leaving any prior soft-deleted rows for retention.
 */
export function setFeedback(db: Db, input: SetFeedbackInput, nowIso: string): FeedbackRow {
  const cooldownUntil = input.cooldown_until ?? null;
  const band = input.dismissed_materiality_band ?? null;
  // A cooldown is only meaningful to the ranker with a dismissed band (§9
  // re-surface compares bands), and listCooldowns requires both. Reject a
  // half-specified cooldown here so it can never be a stored silent no-op.
  if ((cooldownUntil === null) !== (band === null)) {
    throw new FeedbackError(
      400,
      "INVALID_REQUEST",
      "cooldown_until and dismissed_materiality_band must be set together",
    );
  }
  return immediate(db, () => {
    const existing = db
      .prepare(
        "SELECT feedback_id FROM recommendation_feedback WHERE scope_key = ? AND rec_identity = ? AND deleted_at IS NULL",
      )
      .get(input.scope_key, input.rec_identity) as { feedback_id: string } | undefined;
    if (existing === undefined) {
      db.prepare(
        `INSERT INTO recommendation_feedback
           (feedback_id, scope_key, rec_identity, feedback, cooldown_until,
            dismissed_materiality_band, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.scope_key,
        input.rec_identity,
        input.feedback,
        cooldownUntil,
        band,
        nowIso,
        nowIso,
      );
    } else {
      db.prepare(
        `UPDATE recommendation_feedback
           SET feedback = ?, cooldown_until = ?, dismissed_materiality_band = ?, updated_at = ?
         WHERE feedback_id = ?`,
      ).run(input.feedback, cooldownUntil, band, nowIso, existing.feedback_id);
    }
    return getFeedback(db, input.scope_key, input.rec_identity) as FeedbackRow;
  });
}

/** Active feedback row for a pair, or null. */
export function getFeedback(db: Db, scopeKey: string, recIdentity: string): FeedbackRow | null {
  const row = db
    .prepare(
      `SELECT scope_key, rec_identity, feedback, cooldown_until, dismissed_materiality_band,
              created_at, updated_at
         FROM recommendation_feedback
        WHERE scope_key = ? AND rec_identity = ? AND deleted_at IS NULL`,
    )
    .get(scopeKey, recIdentity) as Row | undefined;
  return row ?? null;
}

/** Active feedback rows for one scope, oldest first. */
export function listFeedback(db: Db, scopeKey: string): FeedbackRow[] {
  return db
    .prepare(
      `SELECT scope_key, rec_identity, feedback, cooldown_until, dismissed_materiality_band,
              created_at, updated_at
         FROM recommendation_feedback
        WHERE scope_key = ? AND deleted_at IS NULL
        ORDER BY created_at, rec_identity`,
    )
    .all(scopeKey) as FeedbackRow[];
}

/**
 * Reversible dismissal: soft-delete the active row. Idempotent no-op when no
 * active row exists. Returns true when a row was soft-deleted.
 */
export function undoFeedback(
  db: Db,
  scopeKey: string,
  recIdentity: string,
  nowIso: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE recommendation_feedback
         SET deleted_at = ?, updated_at = ?
       WHERE scope_key = ? AND rec_identity = ? AND deleted_at IS NULL`,
    )
    .run(nowIso, nowIso, scopeKey, recIdentity);
  return info.changes > 0;
}

/**
 * Privacy erasure: hard-delete ALL rows (active and soft-deleted) for a pair.
 * Returns the number of rows removed.
 */
export function deleteFeedback(db: Db, scopeKey: string, recIdentity: string): number {
  const info = db
    .prepare("DELETE FROM recommendation_feedback WHERE scope_key = ? AND rec_identity = ?")
    .run(scopeKey, recIdentity);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Storage operations — goal preference (keyed on scope_key)
// ---------------------------------------------------------------------------

/** Insert or update the stored goal for a scope. */
export function setGoal(db: Db, scopeKey: string, goal: GoalPreference, nowIso: string): void {
  db.prepare(
    `INSERT INTO recommendation_goal_preference (scope_key, goal, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET goal = excluded.goal, updated_at = excluded.updated_at`,
  ).run(scopeKey, goal, nowIso);
}

/** Stored goal for a scope, or the default PRESERVE_QUALITY when unset. */
export function getGoal(db: Db, scopeKey: string): GoalPreference {
  const row = db
    .prepare("SELECT goal FROM recommendation_goal_preference WHERE scope_key = ?")
    .get(scopeKey) as { goal: GoalPreference } | undefined;
  return row?.goal ?? DEFAULT_GOAL;
}

/** Return a scope to the default goal by deleting its preference row. */
export function resetGoal(db: Db, scopeKey: string): void {
  db.prepare("DELETE FROM recommendation_goal_preference WHERE scope_key = ?").run(scopeKey);
}

// ---------------------------------------------------------------------------
// Ranker feed (§ranker feed and outcome boundary)
// ---------------------------------------------------------------------------

/**
 * Active feedback rows that are dismissal cooldowns for the ranker: those with
 * both a cooldown_until and a dismissed band. ALREADY_DONE is persisted but
 * never fed here — it awaits the RIQ5 completed-change confirmation.
 */
export function listCooldowns(db: Db, scopeKey: string): CooldownInput[] {
  const rows = db
    .prepare(
      `SELECT rec_identity, cooldown_until, dismissed_materiality_band
         FROM recommendation_feedback
        WHERE scope_key = ? AND deleted_at IS NULL
          AND feedback <> 'ALREADY_DONE'
          AND cooldown_until IS NOT NULL
          AND dismissed_materiality_band IS NOT NULL
        ORDER BY rec_identity`,
    )
    .all(scopeKey) as Array<{
    rec_identity: string;
    cooldown_until: string;
    dismissed_materiality_band: MaterialityBand;
  }>;
  return rows.map((r) => ({
    decision_identity: r.rec_identity,
    until_iso: r.cooldown_until,
    dismissed_materiality_band: r.dismissed_materiality_band,
  }));
}

// ---------------------------------------------------------------------------
// Request parsing (route layer) — validates enums, rejects unknown fields
// ---------------------------------------------------------------------------

function record(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new FeedbackError(400, "INVALID_REQUEST", "object body required");
  const rec = raw as Record<string, unknown>;
  const unknown = Object.keys(rec).find((k) => !allowed.includes(k));
  if (unknown !== undefined)
    throw new FeedbackError(400, "INVALID_REQUEST", `unknown field: ${unknown}`);
  return rec;
}

// scope_key and rec_identity are opaque ids; rec_identity is FAMILY + sorted
// comma-joined evidence ids, so allow generous room before rejecting.
const MAX_KEY_LEN = 1024;

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0)
    throw new FeedbackError(400, "INVALID_REQUEST", `${key} is required`);
  if (v.length > MAX_KEY_LEN)
    throw new FeedbackError(400, "INVALID_REQUEST", `${key} exceeds ${MAX_KEY_LEN} characters`);
  return v;
}

function isoOrNull(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v))
    throw new FeedbackError(400, "INVALID_REQUEST", `${key} must be a UTC ISO-8601 timestamp`);
  // Canonicalize to millisecond precision so the ranker's lexicographic
  // until_iso comparison (§9) can't misjudge a no-ms value by up to ~1s.
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new FeedbackError(400, "INVALID_REQUEST", `${key} must be a UTC ISO-8601 timestamp`);
  return d.toISOString();
}

function enumVal<T extends string>(
  rec: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const v = str(rec, key);
  if (!values.includes(v as T))
    throw new FeedbackError(400, "INVALID_REQUEST", `${key} is invalid`);
  return v as T;
}

function bandOrNull(rec: Record<string, unknown>, key: string): MaterialityBand | null {
  if (rec[key] === undefined || rec[key] === null) return null;
  return enumVal(rec, key, MATERIALITY_BANDS);
}

export function parseSetFeedback(raw: unknown): SetFeedbackInput {
  const rec = record(raw, [
    "scope_key",
    "rec_identity",
    "feedback",
    "cooldown_until",
    "dismissed_materiality_band",
  ]);
  return {
    scope_key: str(rec, "scope_key"),
    rec_identity: str(rec, "rec_identity"),
    feedback: enumVal(rec, "feedback", FEEDBACK_KINDS),
    cooldown_until: isoOrNull(rec, "cooldown_until"),
    dismissed_materiality_band: bandOrNull(rec, "dismissed_materiality_band"),
  };
}

/** Parse a body that identifies one pair (undo / delete). */
export function parsePair(raw: unknown): { scope_key: string; rec_identity: string } {
  const rec = record(raw, ["scope_key", "rec_identity"]);
  return { scope_key: str(rec, "scope_key"), rec_identity: str(rec, "rec_identity") };
}

export function parseSetGoal(raw: unknown): { scope_key: string; goal: GoalPreference } {
  const rec = record(raw, ["scope_key", "goal"]);
  return { scope_key: str(rec, "scope_key"), goal: enumVal(rec, "goal", GOAL_PREFERENCES) };
}

export function parseScope(raw: unknown): { scope_key: string } {
  const rec = record(raw, ["scope_key"]);
  return { scope_key: str(rec, "scope_key") };
}

// ---------------------------------------------------------------------------
// Route wrappers (enveloped) — used by the daemon router
// ---------------------------------------------------------------------------

function envelope<T>(data: T, scopeKey: string) {
  return buildResponse(data, {
    claim_kind: "EXACT",
    n: Array.isArray(data) ? data.length : 1,
    drilldown_ids: { workspace_id: scopeKey },
  });
}

export function setFeedbackRoute(db: Db, raw: unknown) {
  const input = parseSetFeedback(raw);
  return envelope(setFeedback(db, input, new Date().toISOString()), input.scope_key);
}

export function undoFeedbackRoute(db: Db, raw: unknown) {
  const { scope_key, rec_identity } = parsePair(raw);
  const soft_deleted = undoFeedback(db, scope_key, rec_identity, new Date().toISOString());
  return envelope({ scope_key, rec_identity, soft_deleted }, scope_key);
}

export function deleteFeedbackRoute(db: Db, raw: unknown) {
  const { scope_key, rec_identity } = parsePair(raw);
  const removed = deleteFeedback(db, scope_key, rec_identity);
  return envelope({ scope_key, rec_identity, removed }, scope_key);
}

export function listFeedbackRoute(db: Db, scopeKey: string) {
  return envelope(listFeedback(db, scopeKey), scopeKey);
}

export function setGoalRoute(db: Db, raw: unknown) {
  const { scope_key, goal } = parseSetGoal(raw);
  setGoal(db, scope_key, goal, new Date().toISOString());
  return envelope({ scope_key, goal }, scope_key);
}

export function resetGoalRoute(db: Db, raw: unknown) {
  const { scope_key } = parseScope(raw);
  resetGoal(db, scope_key);
  return envelope({ scope_key, goal: getGoal(db, scope_key) }, scope_key);
}

export function getGoalRoute(db: Db, scopeKey: string) {
  return envelope({ scope_key: scopeKey, goal: getGoal(db, scopeKey) }, scopeKey);
}
