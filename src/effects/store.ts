import type { Db } from "../db/open.js";
import { EFFECT_HANDLERS, findHandler } from "./registry.js";
import {
  EFFECT_CONTRACT_VERSION,
  EFFECT_QUERY_VERSION,
  type EffectCycle,
  type GuardrailDefinition,
  type RollbackOperation,
  type TargetDefinition,
} from "./types.js";

type CycleRow = Record<string, string | number | null>;

function json<T>(value: unknown): T {
  if (value === undefined || value === null) throw new Error("missing persisted JSON field");
  return JSON.parse(String(value)) as T;
}

export function cycleFromRow(row: CycleRow): EffectCycle {
  const contractVersion = String(row.contract_version);
  const queryDefinitionVersion = String(row.query_definition_version);
  const detectorId = String(row.detector_id);
  const metricId = String(row.metric_id);
  const methodVersion = String(row.method_version);
  const handler = findHandler(detectorId, metricId, methodVersion);
  const knownEnvelope =
    contractVersion === EFFECT_CONTRACT_VERSION &&
    queryDefinitionVersion === EFFECT_QUERY_VERSION &&
    handler !== null;
  const parsedTarget = knownEnvelope ? json<unknown>(row.target_definition_json) : null;
  const parsedGuardrails = knownEnvelope ? json<unknown>(row.guardrail_definitions_json) : null;
  const targetDefinition =
    parsedTarget !== null && typeof parsedTarget === "object"
      ? (parsedTarget as TargetDefinition)
      : null;
  const guardrailDefinitions = Array.isArray(parsedGuardrails)
    ? (parsedGuardrails as GuardrailDefinition[])
    : null;
  const definitionMatches =
    handler !== null &&
    targetDefinition !== null &&
    guardrailDefinitions !== null &&
    targetDefinition.metricId === metricId &&
    targetDefinition.methodVersion === methodVersion &&
    JSON.stringify(targetDefinition) === JSON.stringify(handler.target) &&
    JSON.stringify(guardrailDefinitions) === JSON.stringify(handler.guardrails);
  const supported = knownEnvelope && definitionMatches;
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
    baselineEvidence: supported ? json(row.baseline_evidence_json) : emptyEvidence,
    provisionalEvidence:
      !supported || row.provisional_evidence_json === null
        ? null
        : json(row.provisional_evidence_json),
    finalEvidence:
      !supported || row.final_evidence_json === null ? null : json(row.final_evidence_json),
    targetDirection:
      !supported || row.target_direction === null
        ? null
        : (String(row.target_direction) as EffectCycle["targetDirection"]),
    comparisonStatus:
      !supported || row.comparison_status === null
        ? null
        : (String(row.comparison_status) as EffectCycle["comparisonStatus"]),
    comparisonReasons:
      !supported || row.comparison_reasons_json === null ? [] : json(row.comparison_reasons_json),
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
  const row = db.prepare("SELECT * FROM effect_cycles WHERE cycle_id = ?").get(cycleId) as
    | CycleRow
    | undefined;
  return row === undefined ? null : cycleFromRow(row);
}

export function listCycles(db: Db, recId?: string): EffectCycle[] {
  const rows = (
    recId === undefined
      ? db.prepare("SELECT * FROM effect_cycles ORDER BY created_at DESC, cycle_id").all()
      : db.prepare("SELECT * FROM effect_cycles WHERE rec_id = ? ORDER BY cycle_no DESC").all(recId)
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
  ];
  const scopePredicates = optionalScopeKeys.map(
    (key) =>
      `(json_type(scope_json, '$.${key}') IS NULL OR ? = 1 OR json_extract(scope_json, '$.${key}') IS ?)`,
  );
  const optionalScopeParameters = optionalScopeKeys.flatMap((key) => [
    cycle.scope[key] === undefined ? 1 : 0,
    cycle.scope[key] ?? null,
  ]);
  const handlerPredicate = EFFECT_HANDLERS.map(
    () =>
      "(detector_id=? AND metric_id=? AND method_version=? AND json(target_definition_json)=json(?) AND json(guardrail_definitions_json)=json(?))",
  ).join(" OR ");
  const handlerParameters = EFFECT_HANDLERS.flatMap((handler) => [
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
