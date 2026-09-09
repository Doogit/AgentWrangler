import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "../../db/open.js";
import { GLOBAL_WORKSPACE_ID } from "../../detector/context-probe.js";
import { parseD1SourceIdentity } from "../../detector/d1-source-identity.js";
import type { EffectCapability, EffectEvidencePage } from "../../effects/api-contract.js";
import { ESF_EFFECT_WRITER_ENABLED } from "../../effects/gate.js";
import {
  createEffectEngine,
  createSqlObservationProvider,
  findHandler,
} from "../../effects/index.js";
import { cycleFromRow } from "../../effects/store.js";
import type { EffectCycle, ObservationProvider } from "../../effects/types.js";

export class EffectRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RecommendationSource {
  rec_id: string;
  detector_id: string;
  target_metric: string;
  scope_workspace_id: string | null;
  evidence_json: string;
  category: string | null;
  state: string;
}

interface Cursor {
  at: string;
  id: string;
}

function recommendation(db: Db, recId: string): RecommendationSource {
  const row = db
    .prepare(`SELECT rec_id,detector_id,target_metric,scope_workspace_id,evidence_json,category,state
    FROM recommendations WHERE rec_id=?`)
    .get(recId) as RecommendationSource | undefined;
  if (!row) throw new EffectRequestError(404, "Recommendation not found.");
  return row;
}

function sourceTuple(row: RecommendationSource) {
  const source = parseD1SourceIdentity(row.evidence_json);
  if (
    !source ||
    source.component.length === 0 ||
    source.fileRef.length === 0 ||
    (source.component !== "CLAUDE_MD" && source.component !== "MEMORY")
  )
    return null;
  return {
    workspaceId: row.scope_workspace_id ?? GLOBAL_WORKSPACE_ID,
    component: source.component,
    fileRef: source.fileRef,
  };
}

/** Stable opaque source identity: no recommendation ID, path, or source text is retained. */
function sourceDigest(tuple: NonNullable<ReturnType<typeof sourceTuple>>): string {
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

/** Opaque stable D1 identity for other bounded readers; never returns a source tuple. */
export function opaqueD1SourceIdentity(db: Db, recId: string): string | null {
  const rec = recommendation(db, recId);
  const tuple = rec.detector_id === "D1" ? sourceTuple(rec) : null;
  return tuple === null ? null : sourceDigest(tuple);
}

function sourceIdentityObserver(): ObservationProvider {
  return {
    observe(db, cycle, before, after) {
      // Capture this cycle's rec ID: resolution is O(1) and does not scan recommendations.
      const provider = createSqlObservationProvider({
        resolveSourceIdentity(identity) {
          try {
            const tuple = sourceTuple(recommendation(db, cycle.recId));
            if (tuple === null) return null;
            const expected = Buffer.from(sourceDigest(tuple));
            const actual = Buffer.from(identity);
            return expected.length === actual.length && timingSafeEqual(expected, actual)
              ? tuple
              : null;
          } catch {
            return null;
          }
        },
      });
      return provider.observe(db, cycle, before, after);
    },
  };
}

export function effectEngineForDb(db: Db) {
  return createEffectEngine(db, {
    writerEnabled: ESF_EFFECT_WRITER_ENABLED,
    observer: sourceIdentityObserver(),
  });
}

function isWarning(rec: RecommendationSource): boolean {
  return (
    rec.detector_id === "D5" ||
    rec.category === "LIMIT" ||
    rec.target_metric === "NONE" ||
    rec.target_metric === "forecast_margin"
  );
}

export function capabilityForRecommendation(db: Db, recId: string): EffectCapability {
  const rec = recommendation(db, recId);
  if (isWarning(rec)) return { mode: "ACKNOWLEDGEMENT", reason: "LIMIT_WARNING" };
  if (!ESF_EFFECT_WRITER_ENABLED) return { mode: "READ_ONLY", reason: "WRITER_DISABLED" };
  if (findHandler(rec.detector_id, rec.target_metric) === null)
    return { mode: "MANUAL", reason: "HANDLER_UNAVAILABLE" };
  if (rec.detector_id === "D1" && sourceTuple(rec) === null)
    return { mode: "MANUAL", reason: "SOURCE_UNAVAILABLE" };
  return { mode: "TRACKABLE", reason: null };
}

export function latestEffectCycle(db: Db, recId: string): EffectCycle | null {
  const row = db
    .prepare("SELECT * FROM effect_cycles WHERE rec_id=? ORDER BY cycle_no DESC LIMIT 1")
    .get(recId) as Record<string, string | number | null> | undefined;
  return row === undefined ? null : cycleFromRow(row);
}

function request(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EffectRequestError(400, "Expected an object.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new EffectRequestError(400, "Unknown request field.");
  return body;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value))
    throw new EffectRequestError(400, `${name} is required and must be an opaque identifier.`);
  return value;
}

function track(
  db: Db,
  rec: RecommendationSource,
  idempotencyKey: string,
  now: Date,
  source: "USER_ATTESTED" | "MACHINE_CONFIRMED",
  actionRevision?: string,
  concurrentChange = false,
) {
  const previous = db
    .prepare("SELECT * FROM effect_cycles WHERE rec_id=? AND track_idempotency_key=?")
    .get(rec.rec_id, idempotencyKey) as Record<string, string | number | null> | undefined;
  if (previous !== undefined) {
    if (!ESF_EFFECT_WRITER_ENABLED)
      throw new EffectRequestError(409, "Effect cycle writer is disabled.");
    const cycle = cycleFromRow(previous);
    if (cycle.versionStatus !== "SUPPORTED")
      throw new EffectRequestError(409, "UNSUPPORTED_VERSION");
    // Recommendation metadata is server-owned and may have changed since commit.
    // Compare only caller intent, then return the persisted cycle without writes.
    if (
      cycle.applicationSource !== source ||
      cycle.actionRevision !== (actionRevision ?? null) ||
      (cycle.concurrentChange !== null) !== concurrentChange
    )
      throw new EffectRequestError(
        409,
        "Track idempotency key was reused with a different request.",
      );
    return { supported: true as const, cycle, replayed: true };
  }
  if (source === "USER_ATTESTED" && rec.state === "DISMISSED")
    throw new EffectRequestError(409, "Dismissed recommendation cannot be tracked.");
  const capability = capabilityForRecommendation(db, rec.rec_id);
  if (capability.mode !== "TRACKABLE")
    return { supported: false as const, reason: capability.reason ?? "UNSUPPORTED" };
  const appliedAt = now.toISOString();
  const trackingRequestedAt = appliedAt;
  const tuple = rec.detector_id === "D1" ? sourceTuple(rec) : null;
  const identity = tuple === null ? undefined : sourceDigest(tuple);
  const result = effectEngineForDb(db).track({
    recId: rec.rec_id,
    detectorId: rec.detector_id,
    targetMetric: rec.target_metric,
    scope: {
      workspaceId: rec.scope_workspace_id,
      ...(identity ? { sourceIdentity: identity } : {}),
    },
    cohort: {
      definitionVersion: "esf-effect-cohort-1",
      sessionState: "RECONCILED",
      windowBoundary: "[from,to)",
    },
    trackingRequestedAt,
    appliedAt,
    applicationSource: source,
    ...(actionRevision ? { actionRevision } : {}),
    ...(identity ? { baselineSnapshotRef: identity } : {}),
    idempotencyKey,
    ...(concurrentChange ? { concurrentChange: { kind: "USER_REPORTED", at: appliedAt } } : {}),
  });
  if (result.supported && !result.replayed) {
    db.prepare("UPDATE recommendations SET state='ADOPTED', adopted_at=? WHERE rec_id=?").run(
      result.cycle.appliedAt,
      rec.rec_id,
    );
  }
  return result;
}

/** Scope, dates, source identity and provenance are server-owned. */
export function trackCompletedChange(db: Db, value: unknown, now = new Date()) {
  const body = request(value, [
    "rec_id",
    "idempotency_key",
    "completed_change",
    "concurrent_change",
  ]);
  if (body.completed_change !== true)
    throw new EffectRequestError(400, "Confirm that the change is complete before tracking.");
  if (body.concurrent_change !== undefined && typeof body.concurrent_change !== "boolean")
    throw new EffectRequestError(400, "concurrent_change must be a boolean.");
  const rec = recommendation(db, identifier(body.rec_id, "rec_id"));
  const key = identifier(body.idempotency_key, "idempotency_key");
  return db
    .transaction(() =>
      track(db, rec, key, now, "USER_ATTESTED", undefined, body.concurrent_change === true),
    )
    .immediate();
}

/** Internal bridge for a completed owned apply operation. It is intentionally not an HTTP route. */
export function trackMachineConfirmedChange(
  db: Db,
  recId: string,
  now = new Date(),
  actionRevision?: string,
) {
  const rec = recommendation(db, recId);
  const revision = identifier(actionRevision, "action_revision");
  const key = `machine:${recId}:${revision}`;
  return db.transaction(() => track(db, rec, key, now, "MACHINE_CONFIRMED", revision)).immediate();
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  if (value.length > 1024) throw new EffectRequestError(400, "Invalid effect cursor.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !Object.hasOwn(parsed, "at") ||
      !Object.hasOwn(parsed, "id") ||
      typeof parsed.at !== "string" ||
      typeof parsed.id !== "string" ||
      parsed.at.length > 128 ||
      parsed.id.length > 160
    )
      throw new EffectRequestError(400, "Invalid effect cursor.");
    return parsed;
  } catch {
    throw new EffectRequestError(400, "Invalid effect cursor.");
  }
}
function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString("base64url");
}
function pageLimit(value: string | undefined): number {
  const n = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100)
    throw new EffectRequestError(400, "limit must be an integer from 1 to 100.");
  return n;
}

export function listEffectEvidence(
  db: Db,
  workspaceId: string | null,
  recId: string | undefined,
  limitValue?: string,
  cycleCursorValue?: string,
  legacyCursorValue?: string,
): EffectEvidencePage {
  const limit = pageLimit(limitValue);
  const cycleCursor = decodeCursor(cycleCursorValue);
  const legacyCursor = decodeCursor(legacyCursorValue);
  const scope =
    workspaceId === null ? "" : " AND (r.scope_workspace_id=? OR r.scope_workspace_id IS NULL)";
  const rec = recId === undefined ? "" : " AND r.rec_id=?";
  const base = `${scope}${rec}`;
  const args = [
    ...(workspaceId === null ? [] : [workspaceId]),
    ...(recId === undefined ? [] : [recId]),
  ];
  const cycleRows = db
    .prepare(
      `SELECT c.* FROM effect_cycles c JOIN recommendations r ON r.rec_id=c.rec_id WHERE 1=1${base}${cycleCursor ? " AND (c.created_at < ? OR (c.created_at=? AND c.cycle_id>?))" : ""} ORDER BY c.created_at DESC,c.cycle_id ASC LIMIT ?`,
    )
    .all(
      ...args,
      ...(cycleCursor ? [cycleCursor.at, cycleCursor.at, cycleCursor.id] : []),
      limit + 1,
    ) as Array<Record<string, string | number | null>>;
  const legacyRows = db
    .prepare(
      `SELECT e.rec_id,e.measured_at,e.before_from,e.before_to,e.after_from,e.after_to,e.before_value,e.after_value,e.before_n,e.after_n,e.delta_pct,e.verdict FROM recommendation_effects e JOIN recommendations r ON r.rec_id=e.rec_id WHERE 1=1${base}${legacyCursor ? " AND (e.measured_at < ? OR (e.measured_at=? AND e.rec_id>?))" : ""} ORDER BY e.measured_at DESC,e.rec_id ASC LIMIT ?`,
    )
    .all(
      ...args,
      ...(legacyCursor ? [legacyCursor.at, legacyCursor.at, legacyCursor.id] : []),
      limit + 1,
    ) as Array<Record<string, string | number | null>>;
  const cycles = cycleRows.slice(0, limit).map(cycleFromRow);
  const legacy = legacyRows.slice(0, limit).map((row) => ({
    cycleId: `legacy-${createHash("sha256").update(`${row.rec_id}\0${row.measured_at}`).digest("hex")}`,
    recId: String(row.rec_id),
    contractVersion: "w4-legacy-1" as const,
    state: row.verdict === null ? ("LEGACY_OPEN" as const) : ("LEGACY_FINALIZED" as const),
    measuredAt: String(row.measured_at),
    beforeFrom: String(row.before_from),
    beforeTo: String(row.before_to),
    afterFrom: String(row.after_from),
    afterTo: String(row.after_to),
    beforeValue: row.before_value as number | null,
    afterValue: row.after_value as number | null,
    beforeN: row.before_n as number | null,
    afterN: row.after_n as number | null,
    deltaPct: row.delta_pct as number | null,
    verdict: row.verdict as "EFFECTIVE" | "NO_EFFECT" | "INCONCLUSIVE" | null,
    comparisonStatus: null,
    guardrails: [] as [],
    label: "Legacy target-metric result." as const,
  }));
  const c = cycles.at(-1);
  const l = legacy.at(-1);
  return {
    writer_enabled: ESF_EFFECT_WRITER_ENABLED,
    cycles,
    legacy,
    next_cycle_cursor: cycleRows.length > limit && c ? encodeCursor(c.createdAt, c.cycleId) : null,
    next_legacy_cursor: legacyRows.length > limit && l ? encodeCursor(l.measuredAt, l.recId) : null,
  };
}

export function mutateEffectCycle(db: Db, action: string, value: unknown, now = new Date()) {
  if (!ESF_EFFECT_WRITER_ENABLED)
    throw new EffectRequestError(409, "Effect cycle writer is disabled.");
  const body = request(value, ["cycle_id", "idempotency_key", "actual_time_known"]);
  const cycleId = identifier(body.cycle_id, "cycle_id");
  const idempotencyKey = identifier(body.idempotency_key, "idempotency_key");
  const engine = effectEngineForDb(db);
  if (!engine.getCycle(cycleId)) throw new EffectRequestError(404, "Effect cycle not found.");
  switch (action) {
    case "stop":
      return engine.stop(cycleId, {
        idempotencyKey,
        reason: "USER_STOPPED",
        at: now.toISOString(),
      });
    case "close":
      return engine.closeAttribution(cycleId, {
        idempotencyKey,
        reason: "USER_CLOSED",
        at: now.toISOString(),
      });
    case "rollback":
      return engine.rollback(cycleId, { idempotencyKey, requestedAt: now.toISOString() });
    case "attest-rollback":
      if (body.actual_time_known !== false)
        throw new EffectRequestError(400, "External rollback time must be recorded as unknown.");
      return engine.attestExternalRollback(cycleId, {
        idempotencyKey,
        attestationSource: "USER_ATTESTED",
        attestedAt: now.toISOString(),
      });
    default:
      throw new EffectRequestError(404, "Unknown effect action.");
  }
}
