import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "../../db/open.js";
import { GLOBAL_WORKSPACE_ID } from "../../detector/context-probe.js";
import { d1HistoryFileRef, parseD1SourceIdentity } from "../../detector/d1-source-identity.js";
import type { EffectCapability, EffectEvidencePage } from "../../effects/api-contract.js";
import { ESF_EFFECT_WRITER_ENABLED } from "../../effects/gate.js";
import {
  createEffectEngine,
  createSqlObservationProvider,
  findHandler,
} from "../../effects/index.js";
import { effectEventSourceIdentity } from "../../effects/scope-identity.js";
import {
  EFFECT_CYCLE_BRIDGE_COLUMNS,
  EFFECT_CYCLE_BRIDGE_JOINS,
  cycleFromRow,
  getCycle,
  listCycles,
} from "../../effects/store.js";
import type { EffectCycle, EffectScope, ObservationProvider } from "../../effects/types.js";
import { acquireInterventionLock, appendEffectCycleLink } from "../../recommendations/storage.js";
import { trustedDecisionContract } from "../decision-contract.js";
import { trustedRecommendationContract } from "../recommendation-contract.js";
import { c9WatchedShapes, leadCall } from "./rec-actions/trigger.js";
import { guardBlockToolCalls, oversizedCallGroups } from "./tool-calls.js";

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
  lever: string | null;
  state: string;
  provenance: string;
  contract_version: number | null;
  template_id: string | null;
  contract_status: string;
  rule_id: string | null;
}

interface Cursor {
  at: string;
  id: string;
}

type JoinedRecommendationSource = Record<string, string | number | null> & {
  source_detector_id: string | null;
  source_target_metric: string;
  source_scope_workspace_id: string | null;
  source_evidence_json: string;
  source_category: string | null;
  source_lever: string | null;
  source_state: string;
  source_provenance: string;
  source_contract_version: number | null;
  source_template_id: string | null;
  source_contract_status: string;
  source_rule_id: string | null;
};

const JOINED_RECOMMENDATION_COLUMNS = `
  r.detector_id AS source_detector_id,
  r.target_metric AS source_target_metric,
  r.scope_workspace_id AS source_scope_workspace_id,
  r.evidence_json AS source_evidence_json,
  r.category AS source_category,
  r.lever AS source_lever,
  r.state AS source_state,
  r.provenance AS source_provenance,
  r.contract_version AS source_contract_version,
  r.template_id AS source_template_id,
  r.contract_status AS source_contract_status,
  r.rule_id AS source_rule_id`;

function joinedRecommendation(row: JoinedRecommendationSource): RecommendationSource {
  return {
    rec_id: String(row.rec_id),
    detector_id: row.source_detector_id ?? "",
    target_metric: row.source_target_metric,
    scope_workspace_id: row.source_scope_workspace_id,
    evidence_json: row.source_evidence_json,
    category: row.source_category,
    lever: row.source_lever,
    state: row.source_state,
    provenance: row.source_provenance,
    contract_version: row.source_contract_version,
    template_id: row.source_template_id,
    contract_status: row.source_contract_status,
    rule_id: row.source_rule_id,
  };
}

function isTrustedSource(row: RecommendationSource): boolean {
  return (
    (row.rec_id.startsWith("riq-")
      ? trustedDecisionContract(row)
      : trustedRecommendationContract(row)) !== null
  );
}

function recommendation(db: Db, recId: string): RecommendationSource {
  const row = db
    .prepare(`SELECT rec_id,detector_id,target_metric,scope_workspace_id,evidence_json,category,state,
      provenance,lever,contract_version,template_id,contract_status,rule_id
    FROM recommendations WHERE rec_id=?`)
    .get(recId) as RecommendationSource | undefined;
  if (!row) throw new EffectRequestError(404, "Recommendation not found.");
  if (!isTrustedSource(row))
    throw new EffectRequestError(400, "Recommendation contract is not trusted.");
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

const C9_DENIAL_CLASSES = ["HOOK_BLOCK", "DENY_RULE", "USER_REJECTED"] as const;

/** The C9 card's denial kind and window, from its stored finding; null when absent. */
function c9Finding(rec: RecommendationSource): {
  denialClass: (typeof C9_DENIAL_CLASSES)[number];
  window: { from: string; to: string } | null;
} | null {
  if (rec.detector_id !== "C9") return null;
  try {
    const payload = JSON.parse(rec.evidence_json) as {
      metrics?: { DENIAL_CLASS?: { value?: unknown } };
      window?: { from?: unknown; to?: unknown };
    };
    const denialClass = C9_DENIAL_CLASSES.find(
      (kind) => kind === payload.metrics?.DENIAL_CLASS?.value,
    );
    if (denialClass === undefined) return null;
    const { from, to } = payload.window ?? {};
    return {
      denialClass,
      window: typeof from === "string" && typeof to === "string" ? { from, to } : null,
    };
  } catch {
    return null;
  }
}

/** The C1 card's outlier tool names, sorted, from its stored finding; null when absent. */
function c1Tools(rec: RecommendationSource): string[] | null {
  if (rec.detector_id !== "C1") return null;
  try {
    const payload = JSON.parse(rec.evidence_json) as {
      metrics?: { OUTLIER_TOOLS?: { value?: unknown } };
    };
    const value = payload.metrics?.OUTLIER_TOOLS?.value;
    if (typeof value !== "string") return null;
    const tools = value.split(", ").filter((tool) => tool !== "");
    return tools.length === 0 ? null : tools.sort();
  } catch {
    return null;
  }
}

/**
 * The A1 card's lead file (the one its action fixes) as opaque event-source identities, sorted;
 * null when the lead is not a file or its calls carry no path hash.
 */
function a1LeadFiles(db: Db, rec: RecommendationSource): string[] | null {
  const workspaceId = rec.scope_workspace_id;
  if (rec.detector_id !== "A1" || workspaceId === null) return null;
  try {
    const { window } = JSON.parse(rec.evidence_json) as {
      window?: { from?: unknown; to?: unknown };
    };
    if (typeof window?.from !== "string" || typeof window.to !== "string") return null;
    const lead = leadCall(
      oversizedCallGroups(db, { workspaceId, from: window.from, to: window.to }),
    );
    if (lead?.kind !== "file") return null;
    const hashes = db
      .prepare(
        `SELECT DISTINCT file_path_hash FROM tool_event_metadata
          WHERE file_path_hash IS NOT NULL
            AND event_id IN (${lead.event_ids.map(() => "?").join(",")})`,
      )
      .all(...lead.event_ids) as Array<{ file_path_hash: string }>;
    if (hashes.length === 0) return null;
    return hashes.map((row) => effectEventSourceIdentity(workspaceId, row.file_path_hash)).sort();
  } catch {
    return null;
  }
}

/**
 * The frozen cycle scope. A C9 card adds its denial kind; a guard card also the shapes it counts,
 * read from the card's blocks now (`withShapes`), so later card refreshes cannot move them. A C1
 * card adds its outlier tools and an A1 card its lead file the same way.
 */
function effectScope(db: Db, rec: RecommendationSource, withShapes: boolean): EffectScope {
  const tuple = rec.detector_id === "D1" ? sourceTuple(rec) : null;
  const c9 = c9Finding(rec);
  const scope: EffectScope = {
    workspaceId: rec.scope_workspace_id,
    ...(tuple === null ? {} : { sourceIdentity: sourceDigest(tuple) }),
    ...(c9 === null ? {} : { denialClass: c9.denialClass }),
  };
  const tools = withShapes ? c1Tools(rec) : null;
  if (tools !== null) return { ...scope, tools };
  const files = withShapes ? a1LeadFiles(db, rec) : null;
  if (files !== null) return { ...scope, files };
  if (!withShapes || c9?.denialClass !== "HOOK_BLOCK") return scope;
  const calls =
    c9.window === null || rec.scope_workspace_id === null
      ? []
      : guardBlockToolCalls(db, { workspaceId: rec.scope_workspace_id, ...c9.window });
  return { ...scope, guardShapes: c9WatchedShapes(calls) };
}

function artifactInterventionLockKey(db: Db, rec: RecommendationSource): string {
  // Stable per card: the guard shapes, C1 tools and A1 files are left out, so a refreshed card
  // keeps its lock.
  const scope = effectScope(db, rec, false);
  return `hre:${createHash("sha256")
    .update(JSON.stringify({ targetMetric: rec.target_metric, scope }))
    .digest("hex")}`;
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
              ? { ...tuple, fileRef: d1HistoryFileRef(db, tuple.workspaceId, tuple) }
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
  if (rec.detector_id === "C9" && c9Finding(rec) === null)
    return { mode: "MANUAL", reason: "SOURCE_UNAVAILABLE" };
  if (rec.detector_id === "A1" && a1LeadFiles(db, rec) === null)
    return { mode: "MANUAL", reason: "SOURCE_UNAVAILABLE" };
  return { mode: "TRACKABLE", reason: null };
}

export function latestEffectCycle(db: Db, recId: string): EffectCycle | null {
  const row = db
    .prepare("SELECT cycle_id FROM effect_cycles WHERE rec_id=? ORDER BY cycle_no DESC LIMIT 1")
    .get(recId) as { cycle_id: string } | undefined;
  if (row !== undefined) recommendation(db, recId);
  return row === undefined ? null : getCycle(db, row.cycle_id);
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
    .prepare("SELECT cycle_id FROM effect_cycles WHERE rec_id=? AND track_idempotency_key=?")
    .get(rec.rec_id, idempotencyKey) as { cycle_id: string } | undefined;
  if (previous !== undefined) {
    if (!ESF_EFFECT_WRITER_ENABLED)
      throw new EffectRequestError(409, "Effect cycle writer is disabled.");
    const cycle = getCycle(db, previous.cycle_id);
    if (cycle === null) throw new EffectRequestError(409, "Effect cycle disappeared.");
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
  // Native D7 recommendations have no exact event-source/tool identity producer.
  // Keep production tracking workspace-only; opaque scoped fixtures use the engine directly.
  const tuple = rec.detector_id === "D1" ? sourceTuple(rec) : null;
  const identity = tuple === null ? undefined : sourceDigest(tuple);
  const result = effectEngineForDb(db).track({
    recId: rec.rec_id,
    detectorId: rec.detector_id,
    targetMetric: rec.target_metric,
    scope: effectScope(db, rec, true),
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

interface ArtifactBoundCycleRow {
  rec_id: string;
  recommendation_id: string;
  recommendation_revision_id: string;
  artifact_revision_id: string;
  artifact_application_id: string;
  application_source: "MACHINE_CONFIRMED" | "USER_ATTESTED";
  applied_at: string;
  measurement_method_id: string;
  measurement_verdict: "AUTOMATIC" | "VALIDATED_PROXY" | "MANUAL" | "UNMEASURABLE";
  frozen_definition_json: string;
}

interface FrozenHreMeasurementDefinition {
  targetDirection: "REDUCE" | "INCREASE" | "HOLD";
  horizonDays: number;
  baselineCohortCode: string;
  afterCohortCode: string;
  guardrailCodes: string[];
  comparabilityCode: string;
}

const SAFE_HRE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export type ArtifactBoundTrackResult =
  | { supported: true; cycle: EffectCycle; replayed: boolean }
  | {
      supported: false;
      state: "UNSUPPORTED" | "UNAVAILABLE";
      reason:
        | "MEASUREMENT_UNAVAILABLE"
        | "HANDLER_UNAVAILABLE"
        | "OVERLAPPING_INTERVENTION"
        | "INVALID_ARTIFACT_BINDING";
    };

function frozenHreDefinition(value: string): FrozenHreMeasurementDefinition | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const definition = parsed as Record<string, unknown>;
    const keys = Object.keys(definition).sort();
    const expectedKeys = [
      "afterCohortCode",
      "baselineCohortCode",
      "comparabilityCode",
      "guardrailCodes",
      "horizonDays",
      "targetDirection",
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      (definition.targetDirection !== "REDUCE" &&
        definition.targetDirection !== "INCREASE" &&
        definition.targetDirection !== "HOLD") ||
      !Number.isSafeInteger(definition.horizonDays) ||
      (definition.horizonDays as number) < 1 ||
      (definition.horizonDays as number) > 365 ||
      typeof definition.baselineCohortCode !== "string" ||
      !SAFE_HRE_CODE.test(definition.baselineCohortCode) ||
      typeof definition.afterCohortCode !== "string" ||
      !SAFE_HRE_CODE.test(definition.afterCohortCode) ||
      typeof definition.comparabilityCode !== "string" ||
      !SAFE_HRE_CODE.test(definition.comparabilityCode) ||
      !Array.isArray(definition.guardrailCodes) ||
      definition.guardrailCodes.length === 0 ||
      definition.guardrailCodes.length > 8 ||
      !definition.guardrailCodes.every(
        (code) => typeof code === "string" && SAFE_HRE_CODE.test(code),
      )
    )
      return null;
    return definition as unknown as FrozenHreMeasurementDefinition;
  } catch {
    return null;
  }
}

function artifactBoundCycleRow(
  db: Db,
  artifactApplicationId: string,
): ArtifactBoundCycleRow | null {
  const rows = db
    .prepare(
      `SELECT finding.legacy_rec_id AS rec_id, revision.recommendation_id,
              revision.recommendation_revision_id, artifact.artifact_revision_id,
              application.artifact_application_id, application.application_source, application.applied_at,
              method.measurement_method_id, method.verdict AS measurement_verdict,
              method.frozen_definition_json
         FROM hre_artifact_applications application
         JOIN hre_artifact_revisions artifact
           ON artifact.artifact_revision_id=application.artifact_revision_id
         JOIN hre_recommendation_revisions revision
           ON revision.recommendation_revision_id=artifact.recommendation_revision_id
         JOIN hre_measurement_methods method
           ON method.artifact_revision_id=artifact.artifact_revision_id
         JOIN hre_recommendation_findings revision_finding
           ON revision_finding.recommendation_revision_id=revision.recommendation_revision_id
         JOIN hre_findings finding
           ON finding.finding_id=revision_finding.finding_id
        WHERE application.artifact_application_id=?
          AND application.result='APPLIED'
          AND artifact.validation_status='VALIDATED'
          AND finding.source_kind='LEGACY'
          AND finding.legacy_rec_id IS NOT NULL
        ORDER BY method.measurement_method_id, finding.finding_id`,
    )
    .all(artifactApplicationId) as ArtifactBoundCycleRow[];
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

function artifactBridgeMatches(
  cycle: EffectCycle,
  row: ArtifactBoundCycleRow,
  lockKey: string,
): boolean {
  return (
    cycle.bridge.bridgeKind === "ARTIFACT_BOUND" &&
    cycle.bridge.recommendationId === row.recommendation_id &&
    cycle.bridge.recommendationRevisionId === row.recommendation_revision_id &&
    cycle.bridge.artifactRevisionId === row.artifact_revision_id &&
    cycle.bridge.artifactApplicationId === row.artifact_application_id &&
    cycle.bridge.measurementMethodId === row.measurement_method_id &&
    cycle.bridge.interventionLockKey === lockKey
  );
}

/**
 * Internal HRE lifecycle entry point. It accepts only an immutable application
 * identity, derives every other field from persisted producer records, and is
 * intentionally not wired to an HTTP or apply route.
 */
export function trackArtifactBoundApplication(
  db: Db,
  artifactApplicationId: string,
  now = new Date(),
): ArtifactBoundTrackResult {
  const applicationId = identifier(artifactApplicationId, "artifact_application_id");
  if (!ESF_EFFECT_WRITER_ENABLED)
    throw new EffectRequestError(409, "Effect cycle writer is disabled.");
  const row = artifactBoundCycleRow(db, applicationId);
  if (row === null)
    return { supported: false, state: "UNAVAILABLE", reason: "INVALID_ARTIFACT_BINDING" };
  const definition = frozenHreDefinition(row.frozen_definition_json);
  if (definition === null)
    return { supported: false, state: "UNAVAILABLE", reason: "INVALID_ARTIFACT_BINDING" };
  if (row.measurement_verdict === "MANUAL" || row.measurement_verdict === "UNMEASURABLE")
    return { supported: false, state: "UNSUPPORTED", reason: "MEASUREMENT_UNAVAILABLE" };
  const rec = recommendation(db, row.rec_id);
  const capability = capabilityForRecommendation(db, rec.rec_id);
  if (capability.mode !== "TRACKABLE")
    return { supported: false, state: "UNSUPPORTED", reason: "HANDLER_UNAVAILABLE" };
  const lockKey = artifactInterventionLockKey(db, rec);
  const existingCycle = db
    .prepare("SELECT cycle_id FROM effect_cycles WHERE rec_id=? AND track_idempotency_key=?")
    .get(rec.rec_id, `hre:${applicationId}`);
  const existingLock = db
    .prepare(
      "SELECT 1 FROM hre_intervention_locks WHERE intervention_lock_key=? AND state='OPEN' LIMIT 1",
    )
    .get(lockKey);
  if (existingCycle === undefined && existingLock !== undefined)
    return { supported: false, state: "UNAVAILABLE", reason: "OVERLAPPING_INTERVENTION" };
  const idempotencyKey = `hre:${applicationId}`;
  try {
    return db
      .transaction((): ArtifactBoundTrackResult => {
        const tuple = rec.detector_id === "D1" ? sourceTuple(rec) : null;
        const identity = tuple === null ? undefined : sourceDigest(tuple);
        const tracked = effectEngineForDb(db).track({
          recId: rec.rec_id,
          detectorId: rec.detector_id,
          targetMetric: rec.target_metric,
          scope: effectScope(db, rec, true),
          cohort: {
            definitionVersion: "hre-artifact-cycle-1",
            baselineCohortCode: definition.baselineCohortCode,
            afterCohortCode: definition.afterCohortCode,
            comparabilityCode: definition.comparabilityCode,
          },
          trackingRequestedAt: row.applied_at,
          appliedAt: row.applied_at,
          applicationSource: row.application_source,
          ...(row.application_source === "MACHINE_CONFIRMED"
            ? { actionRevision: row.artifact_application_id }
            : {}),
          ...(identity ? { baselineSnapshotRef: identity } : {}),
          horizonDays: definition.horizonDays,
          idempotencyKey,
        });
        if (!tracked.supported)
          return { supported: false, state: "UNSUPPORTED", reason: "HANDLER_UNAVAILABLE" } as const;
        if (tracked.replayed) {
          if (!artifactBridgeMatches(tracked.cycle, row, lockKey))
            throw new EffectRequestError(409, "Artifact lifecycle idempotency conflict.");
          return { supported: true, cycle: tracked.cycle, replayed: true };
        }
        appendEffectCycleLink(db, {
          cycleId: tracked.cycle.cycleId,
          recommendationId: row.recommendation_id,
          recommendationRevisionId: row.recommendation_revision_id,
          artifactRevisionId: row.artifact_revision_id,
          artifactApplicationId: row.artifact_application_id,
          measurementMethodId: row.measurement_method_id,
          interventionLockKey: lockKey,
          createdAt: row.applied_at,
        });
        acquireInterventionLock(db, {
          lockId: `hre-lock:${createHash("sha256")
            .update(row.artifact_application_id)
            .digest("hex")}`,
          interventionLockKey: lockKey,
          cycleId: tracked.cycle.cycleId,
          artifactApplicationId: row.artifact_application_id,
          confoundedOverride: false,
          conflictsWithLockId: null,
          conflictReasonCode: null,
          createdAt: row.applied_at,
        });
        return {
          supported: true,
          cycle: getCycle(db, tracked.cycle.cycleId) as EffectCycle,
          replayed: false,
        };
      })
      .immediate();
  } catch (error) {
    if (error instanceof Error && error.message.includes("hre intervention lock conflict"))
      return { supported: false, state: "UNAVAILABLE", reason: "OVERLAPPING_INTERVENTION" };
    throw error;
  }
}

export interface ArtifactBoundMeasuredResult {
  readonly cycleId: string;
  readonly recommendationId: string;
  readonly recommendationRevisionId: string;
  readonly artifactApplicationId: string;
  readonly measurementMethodId: string;
  readonly state: "PENDING" | "IMPROVED" | "NO_EFFECT" | "INCONCLUSIVE" | "WORSE" | "UNSUPPORTED";
  readonly measuredAt: string | null;
}

/** Read-only feed for RQU-1b; it deliberately does not rank or mutate queue data. */
export function listArtifactBoundMeasuredResults(db: Db): readonly ArtifactBoundMeasuredResult[] {
  return listCycles(db).flatMap((cycle) => {
    if (cycle.bridge.bridgeKind !== "ARTIFACT_BOUND") return [];
    try {
      recommendation(db, cycle.recId);
    } catch {
      return [];
    }
    const adverseGuardrail = cycle.finalEvidence?.guardrails.some(
      (guardrail) => guardrail.direction === "ADVERSE",
    );
    const state =
      cycle.state === "UNSUPPORTED"
        ? "UNSUPPORTED"
        : cycle.state === "STOPPED"
          ? "INCONCLUSIVE"
          : cycle.state !== "FINALIZED"
            ? "PENDING"
            : cycle.comparisonStatus !== "COMPARABLE"
              ? "INCONCLUSIVE"
              : adverseGuardrail || cycle.targetDirection === "WORSENED"
                ? "WORSE"
                : cycle.targetDirection === "IMPROVED"
                  ? "IMPROVED"
                  : cycle.targetDirection === "UNCHANGED"
                    ? "NO_EFFECT"
                    : "INCONCLUSIVE";
    return [
      {
        cycleId: cycle.cycleId,
        recommendationId: cycle.bridge.recommendationId,
        recommendationRevisionId: cycle.bridge.recommendationRevisionId,
        artifactApplicationId: cycle.bridge.artifactApplicationId,
        measurementMethodId: cycle.bridge.measurementMethodId,
        state,
        measuredAt: cycle.terminalAt,
      },
    ];
  });
}

/** Scope, dates, source identity and provenance are server-owned. */
export function trackCompletedChange(
  db: Db,
  value: unknown,
  now = new Date(),
  actionRevision?: string,
) {
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
      track(db, rec, key, now, "USER_ATTESTED", actionRevision, body.concurrent_change === true),
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
      `SELECT c.*, ${EFFECT_CYCLE_BRIDGE_COLUMNS}, ${JOINED_RECOMMENDATION_COLUMNS}
         FROM effect_cycles c ${EFFECT_CYCLE_BRIDGE_JOINS}
         JOIN recommendations r ON r.rec_id=c.rec_id
        WHERE 1=1${base}${cycleCursor ? " AND (c.created_at < ? OR (c.created_at=? AND c.cycle_id>?))" : ""}
        ORDER BY c.created_at DESC,c.cycle_id ASC LIMIT ?`,
    )
    .all(
      ...args,
      ...(cycleCursor ? [cycleCursor.at, cycleCursor.at, cycleCursor.id] : []),
      limit + 1,
    ) as JoinedRecommendationSource[];
  const legacyRows = db
    .prepare(
      `SELECT e.rec_id,e.measured_at,e.before_from,e.before_to,e.after_from,e.after_to,
              e.before_value,e.after_value,e.before_n,e.after_n,e.delta_pct,e.verdict,
              ${JOINED_RECOMMENDATION_COLUMNS}
         FROM recommendation_effects e JOIN recommendations r ON r.rec_id=e.rec_id
        WHERE 1=1${base}${legacyCursor ? " AND (e.measured_at < ? OR (e.measured_at=? AND e.rec_id>?))" : ""}
        ORDER BY e.measured_at DESC,e.rec_id ASC LIMIT ?`,
    )
    .all(
      ...args,
      ...(legacyCursor ? [legacyCursor.at, legacyCursor.at, legacyCursor.id] : []),
      limit + 1,
    ) as JoinedRecommendationSource[];
  const scannedCycles = cycleRows.slice(0, limit);
  const scannedLegacy = legacyRows.slice(0, limit);
  const cycles = scannedCycles
    .filter((row) => isTrustedSource(joinedRecommendation(row)))
    .map(cycleFromRow);
  const legacy = scannedLegacy
    .filter((row) => isTrustedSource(joinedRecommendation(row)))
    .map((row) => ({
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
  const c = scannedCycles.at(-1);
  const l = scannedLegacy.at(-1);
  return {
    writer_enabled: ESF_EFFECT_WRITER_ENABLED,
    cycles,
    legacy,
    next_cycle_cursor:
      cycleRows.length > limit && c ? encodeCursor(String(c.created_at), String(c.cycle_id)) : null,
    next_legacy_cursor:
      legacyRows.length > limit && l ? encodeCursor(String(l.measured_at), String(l.rec_id)) : null,
  };
}

export function mutateEffectCycle(db: Db, action: string, value: unknown, now = new Date()) {
  if (!ESF_EFFECT_WRITER_ENABLED)
    throw new EffectRequestError(409, "Effect cycle writer is disabled.");
  const body = request(value, ["cycle_id", "idempotency_key", "actual_time_known"]);
  const cycleId = identifier(body.cycle_id, "cycle_id");
  const idempotencyKey = identifier(body.idempotency_key, "idempotency_key");
  const engine = effectEngineForDb(db);
  const cycle = engine.getCycle(cycleId);
  if (!cycle) throw new EffectRequestError(404, "Effect cycle not found.");
  recommendation(db, cycle.recId);
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
