import type { Db } from "../db/open.js";
import { FROZEN_EFFECT_METHODS, findFrozenHandler } from "./registry.js";
import {
  type AggregateEvidence,
  type ComparisonReason,
  EFFECT_CONTRACT_VERSION,
  EFFECT_QUERY_VERSION,
  type EffectCycle,
  type EffectCycleBridge,
  type GuardrailDefinition,
  type ObservationBundle,
  type RollbackOperation,
  type TargetDefinition,
} from "./types.js";

type CycleRow = Record<string, string | number | null>;

const SAFE_LABEL = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const TARGET_DIRECTIONS = new Set<EffectCycle["targetDirection"]>([
  "IMPROVED",
  "UNCHANGED",
  "WORSENED",
  "INSUFFICIENT_DATA",
]);
const COMPARISON_STATUSES = new Set<EffectCycle["comparisonStatus"]>([
  "DESCRIPTIVE",
  "COMPARABLE",
  "CONFOUNDED",
]);

function json<T>(value: unknown): T {
  if (value === undefined || value === null) throw new Error("missing persisted JSON field");
  return JSON.parse(String(value)) as T;
}

function decoded<T>(value: unknown, valid: (candidate: unknown) => candidate is T): T | null {
  if (value === undefined || value === null) return null;
  try {
    const candidate: unknown = JSON.parse(String(value));
    return valid(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableFinite(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function aggregateEvidence(value: unknown): value is AggregateEvidence {
  if (!record(value) || !record(value.excluded)) return false;
  if (
    !nullableFinite(value.value) ||
    !nullableFinite(value.denominator) ||
    typeof value.exposureN !== "number" ||
    !Number.isFinite(value.exposureN) ||
    !nullableFinite(value.sessionN)
  )
    return false;
  if (
    Object.entries(value.excluded).some(
      ([label, item]) =>
        !SAFE_LABEL.test(label) || typeof item !== "number" || !Number.isFinite(item),
    )
  )
    return false;
  for (const key of ["median", "q1", "q3"])
    if (value[key] !== undefined && !nullableFinite(value[key])) return false;
  return (
    value.snapshotRef === undefined ||
    (typeof value.snapshotRef === "string" && /^[a-f0-9]{64}$/.test(value.snapshotRef))
  );
}

function mix(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.available === "boolean" &&
    typeof value.total === "number" &&
    Number.isFinite(value.total) &&
    record(value.counts) &&
    Object.entries(value.counts).every(
      ([label, item]) =>
        SAFE_LABEL.test(label) && typeof item === "number" && Number.isFinite(item),
    )
  );
}

function observationBundle(value: unknown): value is ObservationBundle {
  if (!record(value)) return false;
  const pair = (candidate: unknown) =>
    record(candidate) && mix(candidate.before) && mix(candidate.after);
  if (
    typeof value.metricId !== "string" ||
    !SAFE_LABEL.test(value.metricId) ||
    typeof value.methodVersion !== "string" ||
    !SAFE_LABEL.test(value.methodVersion) ||
    typeof value.queryDefinitionVersion !== "string" ||
    !SAFE_LABEL.test(value.queryDefinitionVersion) ||
    typeof value.scopeFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.scopeFingerprint) ||
    !Array.isArray(value.parserVersions) ||
    !value.parserVersions.every((item) => typeof item === "string" && SAFE_LABEL.test(item)) ||
    !pair(value.parserMix) ||
    !pair(value.modelMix) ||
    !pair(value.toolMix) ||
    !pair(value.taskMix) ||
    !aggregateEvidence(value.before) ||
    !aggregateEvidence(value.after) ||
    !Array.isArray(value.guardrails)
  )
    return false;
  return value.guardrails.every(
    (item) =>
      record(item) &&
      typeof item.guardrailId === "string" &&
      SAFE_LABEL.test(item.guardrailId) &&
      typeof item.methodVersion === "string" &&
      SAFE_LABEL.test(item.methodVersion) &&
      (item.availability === "SUPPORTED" || item.availability === "UNSUPPORTED") &&
      typeof item.unit === "string" &&
      SAFE_LABEL.test(item.unit) &&
      aggregateEvidence(item.before) &&
      aggregateEvidence(item.after) &&
      ["IMPROVED", "STABLE", "ADVERSE", "INSUFFICIENT_DATA"].includes(String(item.direction)) &&
      Array.isArray(item.reasonCodes) &&
      item.reasonCodes.every(
        (reason) => typeof reason === "string" && /^[A-Z0-9_:-]+$/.test(reason),
      ) &&
      record(item.evidence) &&
      Object.entries(item.evidence).every(
        ([key, evidence]) => key === "directional" && typeof evidence === "boolean",
      ),
  );
}

const COMPARISON_REASONS = new Set<ComparisonReason>([
  "WINDOW_OPEN",
  "WINDOW_STOPPED_EARLY",
  "INSUFFICIENT_SESSIONS",
  "INSUFFICIENT_CALLS",
  "DENOMINATOR_ZERO",
  "SESSION_COUNT_UNAVAILABLE",
  "STRUCTURAL_ONLY",
  "OVERLAPPING_INTERVENTION",
  "METHOD_VERSION_CHANGED",
  "PARSER_VERSION_CHANGED",
  "SCOPE_CHANGED",
  "ROLLBACK_IN_WINDOW",
  "ROLLBACK_TIME_UNKNOWN",
  "MODEL_MIX_SHIFT",
  "TOOL_MIX_SHIFT",
  "TASK_MIX_SHIFT",
  "MIX_UNASSESSED",
  "KNOWN_CONCURRENT_CHANGE",
]);

function comparisonReasons(value: unknown): value is ComparisonReason[] {
  return Array.isArray(value) && value.every((item) => COMPARISON_REASONS.has(item));
}

function targetDirection(value: unknown): value is NonNullable<EffectCycle["targetDirection"]> {
  return TARGET_DIRECTIONS.has(value as NonNullable<EffectCycle["targetDirection"]>);
}

function comparisonStatus(value: unknown): value is NonNullable<EffectCycle["comparisonStatus"]> {
  return COMPARISON_STATUSES.has(value as NonNullable<EffectCycle["comparisonStatus"]>);
}

function bridgeFromRow(row: CycleRow): EffectCycleBridge {
  if (row.bridge_kind !== "ARTIFACT_BOUND") return { bridgeKind: "LEGACY_UNLINKED" };
  return {
    bridgeKind: "ARTIFACT_BOUND",
    recommendationId: String(row.bridge_recommendation_id),
    recommendationRevisionId: String(row.bridge_recommendation_revision_id),
    handlerFamily: String(row.bridge_handler_family),
    handlerVersion: String(row.bridge_handler_version),
    registryVersion: String(row.bridge_registry_version),
    artifactRevisionId: String(row.bridge_artifact_revision_id),
    artifactHash: String(row.bridge_artifact_hash),
    artifactApplicationId: String(row.bridge_artifact_application_id),
    applicationBaseHash: String(row.bridge_application_base_hash),
    applicationPostHash: String(row.bridge_application_post_hash),
    measurementMethodId: String(row.bridge_measurement_method_id),
    measurementMethodVersion: String(row.bridge_measurement_method_version),
    targetMetricCode: String(row.bridge_target_metric_code),
    measurementVerdict: String(row.bridge_measurement_verdict) as Extract<
      EffectCycleBridge,
      { bridgeKind: "ARTIFACT_BOUND" }
    >["measurementVerdict"],
    frozenMeasurementDefinition: json(row.bridge_frozen_definition_json),
    interventionLockKey: String(row.bridge_intervention_lock_key),
  };
}

export const EFFECT_CYCLE_BRIDGE_COLUMNS = `
  link.bridge_kind AS bridge_kind,
  link.recommendation_id AS bridge_recommendation_id,
  link.recommendation_revision_id AS bridge_recommendation_revision_id,
  revision.handler_family AS bridge_handler_family,
  revision.handler_version AS bridge_handler_version,
  revision.registry_version AS bridge_registry_version,
  link.artifact_revision_id AS bridge_artifact_revision_id,
  artifact.artifact_hash AS bridge_artifact_hash,
  link.artifact_application_id AS bridge_artifact_application_id,
  application.base_hash AS bridge_application_base_hash,
  application.post_hash AS bridge_application_post_hash,
  link.measurement_method_id AS bridge_measurement_method_id,
  method.method_version AS bridge_measurement_method_version,
  method.target_metric_code AS bridge_target_metric_code,
  method.verdict AS bridge_measurement_verdict,
  method.frozen_definition_json AS bridge_frozen_definition_json,
  link.intervention_lock_key AS bridge_intervention_lock_key`;

export const EFFECT_CYCLE_BRIDGE_JOINS = `
  LEFT JOIN hre_effect_cycle_links link ON link.cycle_id=c.cycle_id
  LEFT JOIN hre_recommendation_revisions revision
    ON revision.recommendation_revision_id=link.recommendation_revision_id
  LEFT JOIN hre_artifact_revisions artifact
    ON artifact.artifact_revision_id=link.artifact_revision_id
  LEFT JOIN hre_artifact_applications application
    ON application.artifact_application_id=link.artifact_application_id
  LEFT JOIN hre_measurement_methods method
    ON method.measurement_method_id=link.measurement_method_id`;

export function cycleFromRow(row: CycleRow): EffectCycle {
  const contractVersion = String(row.contract_version);
  const queryDefinitionVersion = String(row.query_definition_version);
  const detectorId = String(row.detector_id);
  const metricId = String(row.metric_id);
  const methodVersion = String(row.method_version);
  const knownEnvelope =
    contractVersion === EFFECT_CONTRACT_VERSION && queryDefinitionVersion === EFFECT_QUERY_VERSION;
  const parsedTarget = knownEnvelope ? decoded(row.target_definition_json, record) : null;
  const parsedGuardrails = knownEnvelope
    ? decoded(row.guardrail_definitions_json, Array.isArray)
    : null;
  const targetDefinition =
    parsedTarget !== null && typeof parsedTarget === "object"
      ? (parsedTarget as unknown as TargetDefinition)
      : null;
  const guardrailDefinitions = Array.isArray(parsedGuardrails)
    ? (parsedGuardrails as GuardrailDefinition[])
    : null;
  const handler = findFrozenHandler(
    detectorId,
    metricId,
    methodVersion,
    targetDefinition,
    guardrailDefinitions,
  );
  const supported = knownEnvelope && handler !== null;
  const emptyEvidence = {
    value: null,
    denominator: null,
    exposureN: 0,
    sessionN: null,
    excluded: {},
  };
  const unsupportedTarget: TargetDefinition = {
    metricId,
    methodVersion,
    unit: "UNSUPPORTED_VERSION",
    sampleUnit: "UNSUPPORTED_VERSION",
    aggregation: "UNSUPPORTED_VERSION",
    deltaSemantics: "RELATIVE_PERCENT",
    improvementThreshold: 0,
    worseningThreshold: 0,
    eligibleDefinition: "UNSUPPORTED_VERSION",
    excludedDefinition: "UNSUPPORTED_VERSION",
    denominatorDefinition: "UNSUPPORTED_VERSION",
    boundaryRule: "UNSUPPORTED_VERSION",
    minimumSessions: null,
  };
  return {
    cycleId: String(row.cycle_id),
    recId: String(row.rec_id),
    cycleNo: Number(row.cycle_no),
    contractVersion,
    queryDefinitionVersion,
    versionStatus: supported ? "SUPPORTED" : "UNSUPPORTED_VERSION",
    bridge: bridgeFromRow(row),
    detectorId,
    metricId,
    methodVersion,
    state: String(row.state) as EffectCycle["state"],
    createdAt: String(row.created_at),
    trackingRequestedAt: String(row.tracking_requested_at),
    appliedAt: String(row.applied_at),
    applicationSource: String(row.application_source) as EffectCycle["applicationSource"],
    actionRevision: row.action_revision === null ? null : String(row.action_revision),
    scope: supported ? json(row.scope_json) : { workspaceId: null },
    cohort: supported ? json(row.cohort_json) : {},
    targetDefinition: supported ? (targetDefinition as TargetDefinition) : unsupportedTarget,
    guardrailDefinitions: supported ? (guardrailDefinitions as GuardrailDefinition[]) : [],
    baselineFrom: String(row.baseline_from),
    baselineTo: String(row.baseline_to),
    observationFrom: String(row.observation_from),
    scheduledObservationTo: String(row.scheduled_observation_to),
    observationTo: row.observation_to === null ? null : String(row.observation_to),
    baselineEvidence: supported
      ? json(row.baseline_evidence_json)
      : (decoded(row.baseline_evidence_json, aggregateEvidence) ?? emptyEvidence),
    provisionalEvidence:
      row.provisional_evidence_json === null
        ? null
        : supported
          ? json(row.provisional_evidence_json)
          : decoded(row.provisional_evidence_json, observationBundle),
    finalEvidence:
      row.final_evidence_json === null
        ? null
        : supported
          ? json(row.final_evidence_json)
          : decoded(row.final_evidence_json, observationBundle),
    targetDirection:
      row.target_direction === null || !targetDirection(row.target_direction)
        ? null
        : row.target_direction,
    comparisonStatus:
      row.comparison_status === null || !comparisonStatus(row.comparison_status)
        ? null
        : row.comparison_status,
    comparisonReasons:
      row.comparison_reasons_json === null
        ? []
        : (decoded(row.comparison_reasons_json, comparisonReasons) ?? []),
    terminalAt: row.terminal_at === null ? null : String(row.terminal_at),
    terminalReason: row.terminal_reason === null ? null : String(row.terminal_reason),
    attributionClosedAt:
      row.attribution_closed_at === null ? null : String(row.attribution_closed_at),
    attributionCloseReason:
      row.attribution_close_reason === null ? null : String(row.attribution_close_reason),
    finalizerRevision: row.finalizer_revision === null ? null : String(row.finalizer_revision),
    concurrentChange:
      !supported || row.concurrent_change_json === null ? null : json(row.concurrent_change_json),
    rollbackStatus:
      row.rollback_status === null
        ? null
        : (String(row.rollback_status) as EffectCycle["rollbackStatus"]),
    rollbackAt: row.rollback_at === null ? null : String(row.rollback_at),
    rollbackAttestationSource:
      row.rollback_attestation_source === null ? null : String(row.rollback_attestation_source),
  };
}

export function getCycle(db: Db, cycleId: string): EffectCycle | null {
  const row = db
    .prepare(`SELECT c.*, ${EFFECT_CYCLE_BRIDGE_COLUMNS}
    FROM effect_cycles c ${EFFECT_CYCLE_BRIDGE_JOINS} WHERE c.cycle_id = ?`)
    .get(cycleId) as CycleRow | undefined;
  return row === undefined ? null : cycleFromRow(row);
}

export function listCycles(db: Db, recId?: string): EffectCycle[] {
  const rows = (
    recId === undefined
      ? db
          .prepare(`SELECT c.*, ${EFFECT_CYCLE_BRIDGE_COLUMNS} FROM effect_cycles c
          ${EFFECT_CYCLE_BRIDGE_JOINS} ORDER BY c.created_at DESC, c.cycle_id`)
          .all()
      : db
          .prepare(`SELECT c.*, ${EFFECT_CYCLE_BRIDGE_COLUMNS} FROM effect_cycles c
          ${EFFECT_CYCLE_BRIDGE_JOINS} WHERE c.rec_id = ? ORDER BY c.cycle_no DESC`)
          .all(recId)
  ) as CycleRow[];
  return rows.map(cycleFromRow);
}

/**
 * Tests whether a supported cycle intersects this cycle without hydrating the
 * full effect history. The handler predicate mirrors `cycleFromRow`'s exact
 * supported-envelope check (with SQLite JSON normalization for whitespace).
 */
export function hasOverlappingSupportedCycle(db: Db, cycle: EffectCycle): boolean {
  const observationTo = cycle.observationTo ?? cycle.scheduledObservationTo;
  if (cycle.observationFrom >= observationTo) return false;
  const optionalScopeKeys: Array<keyof Omit<EffectCycle["scope"], "workspaceId">> = [
    "sourceIdentity",
    "tool",
    "modelClass",
    "taskIntent",
    // Two C9 cards in one workspace (different denial kinds) do not overlap.
    "denialClass",
  ];
  const scopePredicates = optionalScopeKeys.map(
    (key) =>
      `(json_type(scope_json, '$.${key}') IS NULL OR ? = 1 OR json_extract(scope_json, '$.${key}') IS ?)`,
  );
  const optionalScopeParameters = optionalScopeKeys.flatMap((key) => [
    cycle.scope[key] === undefined ? 1 : 0,
    cycle.scope[key] ?? null,
  ]);
  const handlerPredicate = FROZEN_EFFECT_METHODS.map(
    () =>
      "(detector_id=? AND metric_id=? AND method_version=? AND json(target_definition_json)=json(?) AND json(guardrail_definitions_json)=json(?))",
  ).join(" OR ");
  const handlerParameters = FROZEN_EFFECT_METHODS.flatMap((handler) => [
    handler.detectorId,
    handler.target.metricId,
    handler.target.methodVersion,
    JSON.stringify(handler.target),
    JSON.stringify(handler.guardrails),
  ]);
  const row = db
    .prepare(`SELECT 1 FROM effect_cycles
      WHERE cycle_id <> ?
        AND contract_version = ?
        AND query_definition_version = ?
        AND (${handlerPredicate})
        AND observation_from < ?
        AND observation_from < COALESCE(observation_to, scheduled_observation_to)
        AND COALESCE(observation_to, scheduled_observation_to) > ?
        AND (json_extract(scope_json, '$.workspaceId') IS NULL OR ? IS NULL
             OR json_extract(scope_json, '$.workspaceId') IS ?)
        AND ${scopePredicates.join("\n        AND ")}
      LIMIT 1`)
    .get(
      cycle.cycleId,
      EFFECT_CONTRACT_VERSION,
      EFFECT_QUERY_VERSION,
      ...handlerParameters,
      observationTo,
      cycle.observationFrom,
      cycle.scope.workspaceId,
      cycle.scope.workspaceId,
      ...optionalScopeParameters,
    ) as { 1: number } | undefined;
  return row !== undefined;
}

export function rollbackFromRow(row: CycleRow): RollbackOperation {
  return {
    operationId: String(row.operation_id),
    cycleId: String(row.cycle_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as RollbackOperation["status"],
    requestedAt: String(row.requested_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    inverseKind: String(row.inverse_kind),
    expectedRevision: row.expected_revision === null ? null : String(row.expected_revision),
    restorationRevision:
      row.restoration_revision === null ? null : String(row.restoration_revision),
    failureClass: row.failure_class === null ? null : String(row.failure_class),
    attestationSource: row.attestation_source === null ? null : String(row.attestation_source),
    actualRollbackAt: row.actual_rollback_at === null ? null : String(row.actual_rollback_at),
  };
}

export function getRollbackByKey(db: Db, cycleId: string, key: string): RollbackOperation | null {
  const row = db
    .prepare("SELECT * FROM effect_rollback_operations WHERE cycle_id = ? AND idempotency_key = ?")
    .get(cycleId, key) as CycleRow | undefined;
  return row === undefined ? null : rollbackFromRow(row);
}
