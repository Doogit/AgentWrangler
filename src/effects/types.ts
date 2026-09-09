import type { Db } from "../db/open.js";

export const EFFECT_CONTRACT_VERSION = "esf-effect-1" as const;
export const EFFECT_QUERY_VERSION = "esf-1" as const;

export type CycleState =
  | "OPEN_SETTLING"
  | "OPEN_MEASURING"
  | "STOPPED"
  | "FINALIZED"
  | "UNSUPPORTED";
export type TargetDirection = "IMPROVED" | "UNCHANGED" | "WORSENED" | "INSUFFICIENT_DATA";
export type ComparisonStatus = "DESCRIPTIVE" | "COMPARABLE" | "CONFOUNDED";
export type ComparisonReason =
  | "WINDOW_OPEN"
  | "WINDOW_STOPPED_EARLY"
  | "INSUFFICIENT_SESSIONS"
  | "DENOMINATOR_ZERO"
  | "SESSION_COUNT_UNAVAILABLE"
  | "STRUCTURAL_ONLY"
  | "OVERLAPPING_INTERVENTION"
  | "METHOD_VERSION_CHANGED"
  | "PARSER_VERSION_CHANGED"
  | "SCOPE_CHANGED"
  | "ROLLBACK_IN_WINDOW"
  | "ROLLBACK_TIME_UNKNOWN"
  | "MODEL_MIX_SHIFT"
  | "TOOL_MIX_SHIFT"
  | "TASK_MIX_SHIFT"
  | "MIX_UNASSESSED"
  | "KNOWN_CONCURRENT_CHANGE";

export type CycleVersionStatus = "SUPPORTED" | "UNSUPPORTED_VERSION";

export interface EffectScope {
  workspaceId: string | null;
  /** Opaque identity only. File paths and source text are forbidden. */
  sourceIdentity?: string;
  tool?: string;
  modelClass?: string;
  taskIntent?: string;
}

export interface AggregateEvidence {
  value: number | null;
  denominator: number | null;
  exposureN: number;
  sessionN: number | null;
  excluded: Record<string, number>;
  median?: number;
  q1?: number;
  q3?: number;
  /** Opaque source snapshot reference; never a file path. */
  snapshotRef?: string;
}

export interface MixSummary {
  available: boolean;
  total: number;
  counts: Record<string, number>;
}

export interface ObservationWindow {
  from: string;
  to: string;
}

export interface GuardrailObservation {
  guardrailId: string;
  methodVersion: string;
  availability: "SUPPORTED" | "UNSUPPORTED";
  unit: string;
  before: AggregateEvidence;
  after: AggregateEvidence;
  direction: "IMPROVED" | "STABLE" | "ADVERSE" | "INSUFFICIENT_DATA";
  reasonCodes: string[];
  evidence: Record<string, unknown>;
}

export interface ObservationBundle {
  metricId: string;
  methodVersion: string;
  queryDefinitionVersion: string;
  scopeFingerprint: string;
  parserVersions: string[];
  parserMix: { before: MixSummary; after: MixSummary };
  before: AggregateEvidence;
  after: AggregateEvidence;
  modelMix: { before: MixSummary; after: MixSummary };
  toolMix: { before: MixSummary; after: MixSummary };
  taskMix: { before: MixSummary; after: MixSummary };
  guardrails: GuardrailObservation[];
}

export interface FrozenCycleInput {
  recId: string;
  detectorId: string;
  targetMetric: string;
  methodVersion?: string;
  scope: EffectScope;
  cohort: Record<string, unknown>;
  trackingRequestedAt: string;
  appliedAt: string;
  applicationSource: "MACHINE_CONFIRMED" | "USER_ATTESTED";
  actionRevision?: string;
  /** Required for D1 and must be opaque. */
  baselineSnapshotRef?: string;
  idempotencyKey: string;
  concurrentChange?: { kind: string; at?: string };
}

export interface EffectCycle {
  cycleId: string;
  recId: string;
  cycleNo: number;
  contractVersion: string;
  queryDefinitionVersion: string;
  /** Read-only compatibility result. Unsupported rows must never be mutated or reinterpreted. */
  versionStatus: CycleVersionStatus;
  detectorId: string;
  metricId: string;
  methodVersion: string;
  state: CycleState;
  createdAt: string;
  trackingRequestedAt: string;
  appliedAt: string;
  applicationSource: "MACHINE_CONFIRMED" | "USER_ATTESTED";
  actionRevision: string | null;
  scope: EffectScope;
  cohort: Record<string, unknown>;
  targetDefinition: TargetDefinition;
  guardrailDefinitions: GuardrailDefinition[];
  baselineFrom: string;
  baselineTo: string;
  observationFrom: string;
  scheduledObservationTo: string;
  observationTo: string | null;
  baselineEvidence: AggregateEvidence;
  provisionalEvidence: ObservationBundle | null;
  finalEvidence: ObservationBundle | null;
  targetDirection: TargetDirection | null;
  comparisonStatus: ComparisonStatus | null;
  comparisonReasons: ComparisonReason[];
  terminalAt: string | null;
  terminalReason: string | null;
  attributionClosedAt: string | null;
  attributionCloseReason: string | null;
  finalizerRevision: string | null;
  concurrentChange: { kind: string; at?: string } | null;
  rollbackStatus: RollbackStatus | null;
  rollbackAt: string | null;
  rollbackAttestationSource: string | null;
}

export interface TargetDefinition {
  metricId: string;
  methodVersion: string;
  unit: string;
  sampleUnit: string;
  aggregation: string;
  deltaSemantics: "RELATIVE_PERCENT" | "PERCENTAGE_POINTS";
  improvementThreshold: number;
  worseningThreshold: number;
  eligibleDefinition: string;
  excludedDefinition: string;
  denominatorDefinition: string;
  boundaryRule: string;
  minimumSessions: number | null;
}

export interface GuardrailDefinition {
  guardrailId: string;
  methodVersion: string;
  unit: string;
}

export interface RegisteredHandler {
  detectorId: "D1" | "D2" | "D4" | "D8";
  aliases: readonly string[];
  target: TargetDefinition;
  guardrails: GuardrailDefinition[];
}

export interface ObservationProvider {
  observe(
    db: Db,
    cycle: EffectCycle,
    before: ObservationWindow,
    after: ObservationWindow,
  ): ObservationBundle;
}

export type RollbackStatus =
  | "PENDING"
  | "SUCCEEDED"
  | "CONFLICT"
  | "FAILED"
  | "USER_ATTESTED"
  | "MANUAL"
  | "UNSUPPORTED";

export interface OwnedInverseOperation {
  kind: string;
  expectedRevision?: string;
  independentlyIdempotent: true;
  checkConflict(): { conflict: false } | { conflict: true; reasonClass: string };
  execute(): { restorationRevision?: string };
}

export interface RollbackOperation {
  operationId: string;
  cycleId: string;
  idempotencyKey: string;
  status: RollbackStatus;
  requestedAt: string;
  completedAt: string | null;
  inverseKind: string;
  expectedRevision: string | null;
  restorationRevision: string | null;
  failureClass: string | null;
  attestationSource: string | null;
  actualRollbackAt: string | null;
}
