import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/open.js";
import { EFFECT_HANDLERS, directionFor, findHandler } from "./registry.js";
import {
  cycleFromRow,
  getCycle,
  getRollbackByKey,
  hasOverlappingSupportedCycle,
  listCycles,
  rollbackFromRow,
} from "./store.js";
import type {
  ComparisonReason,
  ComparisonStatus,
  EffectCycle,
  FrozenCycleInput,
  MixSummary,
  ObservationBundle,
  ObservationProvider,
  OwnedInverseOperation,
  RegisteredHandler,
  RollbackOperation,
  TargetDirection,
} from "./types.js";
import { EFFECT_CONTRACT_VERSION, EFFECT_QUERY_VERSION } from "./types.js";

const DAY_MS = 86_400_000;
const WINDOW_MS = 14 * DAY_MS;

export class EffectConflictError extends Error {}
export class EffectValidationError extends Error {}
export class EffectUnsupportedVersionError extends Error {}

export interface EffectEngineOptions {
  observer: ObservationProvider;
  writerEnabled?: boolean;
  now?: () => Date;
  idFactory?: () => string;
  finalizerRevision?: string;
  handlerResolver?: (
    detectorId: string,
    targetMetric: string,
    methodVersion?: string,
  ) => RegisteredHandler | null;
  resolveOwnedInverse?: (operation: RollbackOperation) => OwnedInverseOperation | null;
}

export type TrackResult =
  | { supported: true; cycle: EffectCycle; replayed: boolean }
  | { supported: false; state: "UNSUPPORTED"; reason: "HANDLER_UNAVAILABLE" };

export interface PassResult {
  settlingAdvanced: number;
  finalized: number;
  unsupported: number;
  unchanged: number;
}

export interface RollbackRequest {
  idempotencyKey: string;
  requestedAt?: string;
  inverse?: OwnedInverseOperation;
}

function iso(value: string, field: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new EffectValidationError(`${field} must be an ISO timestamp`);
  return new Date(ms).toISOString();
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}
function scopeFingerprint(scope: EffectCycle["scope"]): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function replayMatches(cycle: EffectCycle, input: FrozenCycleInput): boolean {
  return (
    cycle.detectorId === input.detectorId &&
    (cycle.metricId === input.targetMetric ||
      findHandler(input.detectorId, input.targetMetric, input.methodVersion)?.target.metricId ===
        cycle.metricId) &&
    cycle.appliedAt === iso(input.appliedAt, "appliedAt") &&
    cycle.trackingRequestedAt === iso(input.trackingRequestedAt, "trackingRequestedAt") &&
    cycle.applicationSource === input.applicationSource &&
    cycle.actionRevision === (input.actionRevision ?? null) &&
    safeJson(cycle.scope) === safeJson(input.scope) &&
    safeJson(cycle.cohort) === safeJson(input.cohort)
  );
}

function mixShift(before: MixSummary, after: MixSummary): boolean {
  if (!before.available || !after.available || before.total === 0 || after.total === 0)
    return false;
  const categories = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
  return [...categories].some(
    (category) =>
      Math.abs(
        ((before.counts[category] ?? 0) / before.total) * 100 -
          ((after.counts[category] ?? 0) / after.total) * 100,
      ) >= 20,
  );
}

function sameCategories(a: MixSummary, b: MixSummary): boolean {
  if (!a.available || !b.available) return true;
  return safeJson(Object.keys(a.counts).sort()) === safeJson(Object.keys(b.counts).sort());
}

function freezeBaselineSide(
  bundle: ObservationBundle,
  frozen: ObservationBundle | null,
  evidence: EffectCycle["baselineEvidence"],
  definitions: EffectCycle["guardrailDefinitions"],
): ObservationBundle {
  const frozenGuardrails = frozen?.guardrails ?? bundle.guardrails;
  const guardrails = definitions.map((definition) => {
    const before = frozenGuardrails.find(
      (item) =>
        item.guardrailId === definition.guardrailId &&
        item.methodVersion === definition.methodVersion &&
        item.unit === definition.unit,
    );
    const after = bundle.guardrails.find(
      (item) =>
        item.guardrailId === definition.guardrailId &&
        item.methodVersion === definition.methodVersion &&
        item.unit === definition.unit,
    );
    if (before !== undefined && after !== undefined) return { ...after, before: before.before };
    const empty = { value: null, denominator: null, exposureN: 0, sessionN: null, excluded: {} };
    return {
      guardrailId: definition.guardrailId,
      methodVersion: definition.methodVersion,
      availability: "UNSUPPORTED" as const,
      unit: definition.unit,
      before: before?.before ?? empty,
      after: empty,
      direction: "INSUFFICIENT_DATA" as const,
      reasonCodes: ["GUARDRAIL_DEFINITION_MISMATCH"],
      evidence: {},
    };
  });
  if (frozen === null) return { ...bundle, before: evidence, guardrails };
  return {
    ...bundle,
    before: evidence,
    guardrails,
    modelMix: { before: frozen.modelMix.before, after: bundle.modelMix.after },
    toolMix: { before: frozen.toolMix.before, after: bundle.toolMix.after },
    taskMix: { before: frozen.taskMix.before, after: bundle.taskMix.after },
    parserMix: { before: frozen.parserMix.before, after: bundle.parserMix.after },
    parserVersions: [
      ...new Set([
        ...Object.keys(frozen.parserMix.before.counts),
        ...Object.keys(bundle.parserMix.after.counts),
      ]),
    ].sort(),
  };
}

function comparison(
  db: Db,
  cycle: EffectCycle,
  bundle: ObservationBundle,
  direction: TargetDirection,
  stopped: boolean,
  observationTo: string,
): { status: ComparisonStatus; reasons: ComparisonReason[] } {
  const reasons: ComparisonReason[] = [];
  if (stopped) reasons.push("WINDOW_STOPPED_EARLY");
  if (cycle.detectorId === "D1") reasons.push("STRUCTURAL_ONLY");
  const minimum = cycle.targetDefinition.minimumSessions;
  if (minimum !== null && (bundle.before.sessionN === null || bundle.after.sessionN === null))
    reasons.push("SESSION_COUNT_UNAVAILABLE");
  else if (
    minimum !== null &&
    ((bundle.before.sessionN ?? 0) < minimum || (bundle.after.sessionN ?? 0) < minimum)
  )
    reasons.push("INSUFFICIENT_SESSIONS");
  if (
    bundle.before.denominator === 0 ||
    bundle.after.denominator === 0 ||
    direction === "INSUFFICIENT_DATA"
  )
    reasons.push("DENOMINATOR_ZERO");
  if (bundle.metricId !== cycle.metricId || bundle.methodVersion !== cycle.methodVersion)
    reasons.push("METHOD_VERSION_CHANGED");
  if (bundle.queryDefinitionVersion !== cycle.queryDefinitionVersion)
    reasons.push("METHOD_VERSION_CHANGED");
  if (bundle.scopeFingerprint !== scopeFingerprint(cycle.scope)) reasons.push("SCOPE_CHANGED");
  if (!sameCategories(bundle.parserMix.before, bundle.parserMix.after))
    reasons.push("PARSER_VERSION_CHANGED");
  if (mixShift(bundle.modelMix.before, bundle.modelMix.after)) reasons.push("MODEL_MIX_SHIFT");
  if (mixShift(bundle.toolMix.before, bundle.toolMix.after)) reasons.push("TOOL_MIX_SHIFT");
  if (mixShift(bundle.taskMix.before, bundle.taskMix.after)) reasons.push("TASK_MIX_SHIFT");
  if (
    !bundle.modelMix.before.available ||
    !bundle.modelMix.after.available ||
    !bundle.toolMix.before.available ||
    !bundle.toolMix.after.available ||
    !bundle.taskMix.before.available ||
    !bundle.taskMix.after.available
  )
    reasons.push("MIX_UNASSESSED");
  if (cycle.concurrentChange !== null) reasons.push("KNOWN_CONCURRENT_CHANGE");
  if (hasOverlappingSupportedCycle(db, { ...cycle, observationTo }))
    reasons.push("OVERLAPPING_INTERVENTION");
  if (
    cycle.rollbackStatus === "SUCCEEDED" &&
    cycle.rollbackAt !== null &&
    cycle.rollbackAt >= cycle.observationFrom &&
    cycle.rollbackAt < cycle.scheduledObservationTo
  )
    reasons.push("ROLLBACK_IN_WINDOW");
  if (cycle.rollbackStatus === "USER_ATTESTED" && cycle.rollbackAt === null)
    reasons.push("ROLLBACK_TIME_UNKNOWN");
  const unique = [...new Set(reasons)];
  const confounds = new Set<ComparisonReason>([
    "OVERLAPPING_INTERVENTION",
    "METHOD_VERSION_CHANGED",
    "PARSER_VERSION_CHANGED",
    "SCOPE_CHANGED",
    "ROLLBACK_IN_WINDOW",
    "ROLLBACK_TIME_UNKNOWN",
    "MODEL_MIX_SHIFT",
    "TOOL_MIX_SHIFT",
    "TASK_MIX_SHIFT",
    "KNOWN_CONCURRENT_CHANGE",
  ]);
  if (unique.some((reason) => confounds.has(reason)))
    return { status: "CONFOUNDED", reasons: unique };
  const descriptive = unique.filter((reason) => reason !== "MIX_UNASSESSED");
  return { status: descriptive.length === 0 ? "COMPARABLE" : "DESCRIPTIVE", reasons: unique };
}

function guardrailDirection(
  guardrail: ObservationBundle["guardrails"][number],
): ObservationBundle["guardrails"][number] {
  if (
    guardrail.availability === "UNSUPPORTED" ||
    guardrail.before.value === null ||
    guardrail.after.value === null ||
    guardrail.before.value === 0
  )
    return { ...guardrail, direction: "INSUFFICIENT_DATA" };
  const delta = ((guardrail.after.value - guardrail.before.value) / guardrail.before.value) * 100;
  return { ...guardrail, direction: delta < -15 ? "IMPROVED" : delta > 15 ? "ADVERSE" : "STABLE" };
}

export function createEffectEngine(db: Db, options: EffectEngineOptions) {
  const now = options.now ?? (() => new Date());
  const id = options.idFactory ?? randomUUID;
  const writerEnabled = options.writerEnabled ?? true;
  const resolveHandler = options.handlerResolver ?? findHandler;

  function assertMutable(cycle: EffectCycle): void {
    if (cycle.versionStatus !== "SUPPORTED")
      throw new EffectUnsupportedVersionError("UNSUPPORTED_VERSION");
  }

  function recordMutation(cycleId: string, kind: string, key: string, at: string): void {
    db.prepare(
      "INSERT OR IGNORE INTO effect_mutation_keys(cycle_id,mutation_kind,idempotency_key,recorded_at) VALUES(?,?,?,?)",
    ).run(cycleId, kind, key, at);
  }

  function persistGuardrails(cycleId: string, bundle: ObservationBundle): void {
    const statement = db.prepare(`INSERT INTO effect_guardrail_results
      (cycle_id,guardrail_id,method_version,availability,unit,before_value,after_value,
       before_denominator,after_denominator,before_eligible_n,after_eligible_n,direction,
       reason_codes_json,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cycle_id,guardrail_id) DO UPDATE SET
       method_version=excluded.method_version,availability=excluded.availability,unit=excluded.unit,
       before_value=excluded.before_value,after_value=excluded.after_value,
       before_denominator=excluded.before_denominator,after_denominator=excluded.after_denominator,
       before_eligible_n=excluded.before_eligible_n,after_eligible_n=excluded.after_eligible_n,
       direction=excluded.direction,reason_codes_json=excluded.reason_codes_json,
       evidence_json=excluded.evidence_json`);
    for (const item of bundle.guardrails)
      statement.run(
        cycleId,
        item.guardrailId,
        item.methodVersion,
        item.availability,
        item.unit,
        item.before.value,
        item.after.value,
        item.before.denominator,
        item.after.denominator,
        item.before.exposureN,
        item.after.exposureN,
        item.direction,
        safeJson(item.reasonCodes),
        safeJson(item.evidence),
      );
  }

  function capability(
    input: Pick<FrozenCycleInput, "detectorId" | "targetMetric" | "methodVersion">,
  ): boolean {
    return resolveHandler(input.detectorId, input.targetMetric, input.methodVersion) !== null;
  }

  function track(input: FrozenCycleInput): TrackResult {
    const handler = resolveHandler(input.detectorId, input.targetMetric, input.methodVersion);
    if (handler === null)
      return { supported: false, state: "UNSUPPORTED", reason: "HANDLER_UNAVAILABLE" };
    if (!writerEnabled) throw new EffectValidationError("effect cycle writer is disabled");
    if (input.applicationSource === "MACHINE_CONFIRMED" && input.actionRevision === undefined)
      throw new EffectValidationError(
        "machine-confirmed tracking requires an opaque action revision",
      );
    const unsupportedScope = [
      input.scope.tool,
      input.scope.modelClass,
      input.scope.taskIntent,
    ].some((value) => value !== undefined);
    if (unsupportedScope || (input.detectorId !== "D1" && input.scope.sourceIdentity !== undefined))
      throw new EffectValidationError(
        "scope filter is not implemented by the observation provider",
      );
    if (
      input.detectorId === "D1" &&
      (input.scope.sourceIdentity === undefined || /[\\/]/.test(input.scope.sourceIdentity))
    )
      throw new EffectValidationError(
        "D1 requires an opaque source identity without path separators",
      );
    const appliedAt = iso(input.appliedAt, "appliedAt");
    const requestedAt = iso(input.trackingRequestedAt, "trackingRequestedAt");
    return db.transaction((): TrackResult => {
      const replay = db
        .prepare("SELECT * FROM effect_cycles WHERE rec_id = ? AND track_idempotency_key = ?")
        .get(input.recId, input.idempotencyKey) as
        | Record<string, string | number | null>
        | undefined;
      if (replay !== undefined) {
        const replayed = cycleFromRow(replay);
        assertMutable(replayed);
        if (!replayMatches(replayed, input))
          throw new EffectConflictError(
            "track idempotency key was reused with a different request",
          );
        return { supported: true, cycle: replayed, replayed: true };
      }
      const open = db
        .prepare(
          "SELECT cycle_id FROM effect_cycles WHERE rec_id = ? AND state IN ('OPEN_SETTLING','OPEN_MEASURING')",
        )
        .get(input.recId);
      if (open !== undefined)
        throw new EffectConflictError("recommendation already has an open effect cycle");
      const pendingRollback = db
        .prepare(`SELECT r.operation_id FROM effect_rollback_operations r
        JOIN effect_cycles c ON c.cycle_id=r.cycle_id WHERE c.rec_id=? AND r.status='PENDING' LIMIT 1`)
        .get(input.recId);
      if (pendingRollback !== undefined)
        throw new EffectConflictError("recommendation has a pending rollback");
      const cycleNo = Number(
        (
          db
            .prepare("SELECT COALESCE(MAX(cycle_no),0)+1 AS n FROM effect_cycles WHERE rec_id = ?")
            .get(input.recId) as { n: number }
        ).n,
      );
      const cycleId = id();
      const baselineFrom = new Date(Date.parse(appliedAt) - WINDOW_MS).toISOString();
      const scheduledTo = new Date(Date.parse(appliedAt) + WINDOW_MS).toISOString();
      const shell: EffectCycle = {
        cycleId,
        recId: input.recId,
        cycleNo,
        contractVersion: EFFECT_CONTRACT_VERSION,
        queryDefinitionVersion: EFFECT_QUERY_VERSION,
        versionStatus: "SUPPORTED",
        detectorId: handler.detectorId,
        metricId: handler.target.metricId,
        methodVersion: handler.target.methodVersion,
        state: "OPEN_SETTLING",
        createdAt: now().toISOString(),
        trackingRequestedAt: requestedAt,
        appliedAt,
        applicationSource: input.applicationSource,
        actionRevision: input.actionRevision ?? null,
        scope: input.scope,
        cohort: input.cohort,
        targetDefinition: handler.target,
        guardrailDefinitions: handler.guardrails,
        baselineFrom,
        baselineTo: appliedAt,
        observationFrom: appliedAt,
        scheduledObservationTo: scheduledTo,
        observationTo: null,
        baselineEvidence: {
          value: null,
          denominator: null,
          exposureN: 0,
          sessionN: null,
          excluded: {},
        },
        provisionalEvidence: null,
        finalEvidence: null,
        targetDirection: null,
        comparisonStatus: null,
        comparisonReasons: [],
        terminalAt: null,
        terminalReason: null,
        attributionClosedAt: null,
        attributionCloseReason: null,
        finalizerRevision: null,
        concurrentChange: input.concurrentChange ?? null,
        rollbackStatus: null,
        rollbackAt: null,
        rollbackAttestationSource: null,
      };
      let observed = options.observer.observe(
        db,
        shell,
        { from: baselineFrom, to: appliedAt },
        { from: appliedAt, to: appliedAt },
      );
      if (
        observed.metricId !== shell.metricId ||
        observed.methodVersion !== shell.methodVersion ||
        observed.queryDefinitionVersion !== shell.queryDefinitionVersion
      )
        throw new EffectValidationError("observation provider version mismatch");
      observed = freezeBaselineSide(observed, null, observed.before, shell.guardrailDefinitions);
      observed.guardrails = observed.guardrails.map(guardrailDirection);
      shell.baselineEvidence = observed.before;
      shell.provisionalEvidence = observed;
      db.prepare(`INSERT INTO effect_cycles
        (cycle_id,rec_id,cycle_no,contract_version,query_definition_version,detector_id,metric_id,method_version,state,
         created_at,tracking_requested_at,applied_at,application_source,action_revision,track_idempotency_key,
         scope_json,cohort_json,target_definition_json,guardrail_definitions_json,baseline_from,baseline_to,
         observation_from,scheduled_observation_to,baseline_evidence_json,provisional_evidence_json,concurrent_change_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        cycleId,
        input.recId,
        cycleNo,
        EFFECT_CONTRACT_VERSION,
        EFFECT_QUERY_VERSION,
        handler.detectorId,
        handler.target.metricId,
        handler.target.methodVersion,
        "OPEN_SETTLING",
        shell.createdAt,
        requestedAt,
        appliedAt,
        input.applicationSource,
        input.actionRevision ?? null,
        input.idempotencyKey,
        safeJson(input.scope),
        safeJson(input.cohort),
        safeJson(handler.target),
        safeJson(handler.guardrails),
        baselineFrom,
        appliedAt,
        appliedAt,
        scheduledTo,
        safeJson(observed.before),
        safeJson(observed),
        input.concurrentChange === undefined ? null : safeJson(input.concurrentChange),
      );
      persistGuardrails(cycleId, observed);
      recordMutation(cycleId, "TRACK", input.idempotencyKey, requestedAt);
      return { supported: true, cycle: getCycle(db, cycleId) as EffectCycle, replayed: false };
    })();
  }

  function finalize(
    cycleId: string,
    at: string,
    stopped: boolean,
    stopKey?: string,
    stopReason?: string,
  ): EffectCycle {
    return db.transaction(() => {
      const cycle = getCycle(db, cycleId);
      if (cycle === null) throw new EffectValidationError("unknown effect cycle");
      assertMutable(cycle);
      if (cycle.state !== "OPEN_SETTLING" && cycle.state !== "OPEN_MEASURING") return cycle;
      const handler = resolveHandler(cycle.detectorId, cycle.metricId, cycle.methodVersion);
      if (handler === null) {
        db.prepare(
          "UPDATE effect_cycles SET state='UNSUPPORTED',terminal_at=?,terminal_reason='HANDLER_UNAVAILABLE' WHERE cycle_id=? AND state IN ('OPEN_SETTLING','OPEN_MEASURING')",
        ).run(at, cycleId);
        return getCycle(db, cycleId) as EffectCycle;
      }
      const end = stopped ? at : cycle.scheduledObservationTo;
      let bundle = options.observer.observe(
        db,
        cycle,
        { from: cycle.baselineFrom, to: cycle.baselineTo },
        { from: cycle.observationFrom, to: end },
      );
      bundle = freezeBaselineSide(
        bundle,
        cycle.provisionalEvidence,
        cycle.baselineEvidence,
        cycle.guardrailDefinitions,
      );
      bundle.guardrails = bundle.guardrails.map(guardrailDirection);
      const { direction } = directionFor(handler, bundle.before.value, bundle.after.value);
      const cmp = comparison(db, cycle, bundle, direction, stopped, end);
      const nextState = stopped ? "STOPPED" : "FINALIZED";
      const result = db
        .prepare(
          `UPDATE effect_cycles SET state=?,observation_to=?,final_evidence_json=?,target_direction=?,comparison_status=?,comparison_reasons_json=?,terminal_at=?,terminal_reason=?,stop_idempotency_key=?,stop_reason=?,finalizer_revision=? WHERE cycle_id=? AND state IN ('OPEN_SETTLING','OPEN_MEASURING')`,
        )
        .run(
          nextState,
          end,
          safeJson(bundle),
          direction,
          cmp.status,
          safeJson(cmp.reasons),
          at,
          stopped ? "USER_STOPPED" : "WINDOW_MATURE",
          stopKey ?? null,
          stopReason ?? null,
          options.finalizerRevision ?? EFFECT_CONTRACT_VERSION,
          cycleId,
        );
      if (result.changes > 0) {
        persistGuardrails(cycleId, bundle);
        recordMutation(cycleId, stopped ? "STOP" : "FINALIZE", stopKey ?? at, at);
      }
      return result.changes === 0
        ? (getCycle(db, cycleId) as EffectCycle)
        : (getCycle(db, cycleId) as EffectCycle);
    })();
  }

  function runPass(at = now()): PassResult {
    const atIso = at.toISOString();
    const result: PassResult = { settlingAdvanced: 0, finalized: 0, unsupported: 0, unchanged: 0 };
    const settlingCutoff = new Date(at.getTime() - DAY_MS).toISOString();
    const handlerPredicate = EFFECT_HANDLERS.map(
      () =>
        "(detector_id=? AND metric_id=? AND method_version=? AND target_definition_json=? AND guardrail_definitions_json=?)",
    ).join(" OR ");
    const handlerParameters = EFFECT_HANDLERS.flatMap((handler) => [
      handler.detectorId,
      handler.target.metricId,
      handler.target.methodVersion,
      safeJson(handler.target),
      safeJson(handler.guardrails),
    ]);
    const open = db
      .prepare(`SELECT cycle_id FROM effect_cycles
      WHERE contract_version=? AND query_definition_version=?
      AND state IN ('OPEN_SETTLING','OPEN_MEASURING')
      AND (${handlerPredicate})
      AND (
        scheduled_observation_to <= ? OR
        (state='OPEN_SETTLING' AND applied_at <= ?))
      ORDER BY scheduled_observation_to,cycle_id LIMIT 100`)
      .all(
        EFFECT_CONTRACT_VERSION,
        EFFECT_QUERY_VERSION,
        ...handlerParameters,
        atIso,
        settlingCutoff,
      ) as Array<{
      cycle_id: string;
    }>;
    for (const row of open) {
      db.transaction(() => {
        let cycle = getCycle(db, row.cycle_id);
        if (
          cycle === null ||
          (cycle.state !== "OPEN_SETTLING" && cycle.state !== "OPEN_MEASURING")
        ) {
          result.unchanged++;
          return;
        }
        if (cycle.versionStatus !== "SUPPORTED") {
          result.unchanged++;
          return;
        }
        if (resolveHandler(cycle.detectorId, cycle.metricId, cycle.methodVersion) === null) {
          const changed = db
            .prepare(
              "UPDATE effect_cycles SET state='UNSUPPORTED',terminal_at=?,terminal_reason='HANDLER_UNAVAILABLE' WHERE cycle_id=? AND state IN ('OPEN_SETTLING','OPEN_MEASURING')",
            )
            .run(atIso, cycle.cycleId).changes;
          if (changed > 0) result.unsupported++;
          else result.unchanged++;
          return;
        }
        if (
          cycle.state === "OPEN_SETTLING" &&
          at.getTime() >= Date.parse(cycle.appliedAt) + DAY_MS
        ) {
          const changed = db
            .prepare(
              "UPDATE effect_cycles SET state='OPEN_MEASURING' WHERE cycle_id=? AND state='OPEN_SETTLING'",
            )
            .run(cycle.cycleId).changes;
          if (changed > 0) result.settlingAdvanced++;
          cycle = getCycle(db, cycle.cycleId) as EffectCycle;
        }
        if (at.getTime() >= Date.parse(cycle.scheduledObservationTo)) {
          finalize(cycle.cycleId, atIso, false);
          result.finalized++;
        }
      })();
    }
    return result;
  }

  function stop(
    cycleId: string,
    request: { idempotencyKey: string; reason: string; at?: string },
  ): EffectCycle {
    const cycle = getCycle(db, cycleId);
    if (cycle === null) throw new EffectValidationError("unknown effect cycle");
    assertMutable(cycle);
    if (cycle.state !== "OPEN_SETTLING" && cycle.state !== "OPEN_MEASURING") return cycle;
    return finalize(
      cycleId,
      iso(request.at ?? now().toISOString(), "stop at"),
      true,
      request.idempotencyKey,
      request.reason,
    );
  }

  function closeAttribution(
    cycleId: string,
    request: { idempotencyKey: string; reason: string; at?: string },
  ): EffectCycle {
    const at = iso(request.at ?? now().toISOString(), "closure at");
    return db.transaction(() => {
      const cycle = getCycle(db, cycleId);
      if (cycle === null) throw new EffectValidationError("unknown effect cycle");
      assertMutable(cycle);
      if (cycle.state !== "FINALIZED")
        throw new EffectConflictError("only finalized attribution can be closed");
      if (cycle.attributionClosedAt !== null) return cycle;
      db.prepare(
        "UPDATE effect_cycles SET attribution_closed_at=?,attribution_close_reason=?,closure_idempotency_key=? WHERE cycle_id=? AND state='FINALIZED' AND attribution_closed_at IS NULL",
      ).run(at, request.reason, request.idempotencyKey, cycleId);
      recordMutation(cycleId, "CLOSE_ATTRIBUTION", request.idempotencyKey, at);
      return getCycle(db, cycleId) as EffectCycle;
    })();
  }

  function completeOwnedRollback(
    operation: RollbackOperation,
    inverse: OwnedInverseOperation,
  ): RollbackOperation {
    const cycle = getCycle(db, operation.cycleId);
    if (cycle === null) throw new EffectValidationError("unknown effect cycle");
    assertMutable(cycle);
    const conflict = inverse.checkConflict();
    if (conflict.conflict) {
      const completedAt = now().toISOString();
      db.transaction(() => {
        db.prepare(
          "UPDATE effect_rollback_operations SET status='CONFLICT',completed_at=?,failure_class=? WHERE operation_id=? AND status='PENDING'",
        ).run(completedAt, conflict.reasonClass, operation.operationId);
        db.prepare("UPDATE effect_cycles SET rollback_status='CONFLICT' WHERE cycle_id=?").run(
          operation.cycleId,
        );
      })();
      return getRollbackByKey(db, operation.cycleId, operation.idempotencyKey) as RollbackOperation;
    }
    try {
      const executed = inverse.execute();
      const completedAt = now().toISOString();
      db.transaction(() => {
        db.prepare(
          "UPDATE effect_rollback_operations SET status='SUCCEEDED',completed_at=?,actual_rollback_at=?,restoration_revision=? WHERE operation_id=? AND status='PENDING'",
        ).run(
          completedAt,
          completedAt,
          executed.restorationRevision ?? null,
          operation.operationId,
        );
        const current = getCycle(db, operation.cycleId) as EffectCycle;
        const inWindow =
          completedAt >= current.observationFrom && completedAt < current.scheduledObservationTo;
        const reasons = new Set(current.comparisonReasons);
        if (inWindow && current.state !== "FINALIZED") reasons.add("ROLLBACK_IN_WINDOW");
        db.prepare(
          `UPDATE effect_cycles SET rollback_status='SUCCEEDED',rollback_at=?,
           comparison_status=CASE WHEN state='FINALIZED' OR ?=0 THEN comparison_status ELSE 'CONFOUNDED' END,
           comparison_reasons_json=CASE WHEN state='FINALIZED' OR ?=0 THEN comparison_reasons_json ELSE ? END
           WHERE cycle_id=?`,
        ).run(
          completedAt,
          inWindow ? 1 : 0,
          inWindow ? 1 : 0,
          safeJson([...reasons]),
          operation.cycleId,
        );
      })();
    } catch (error) {
      const failureClass = error instanceof Error ? error.name : "UnknownError";
      const completedAt = now().toISOString();
      db.transaction(() => {
        db.prepare(
          "UPDATE effect_rollback_operations SET status='FAILED',completed_at=?,failure_class=? WHERE operation_id=? AND status='PENDING'",
        ).run(completedAt, failureClass, operation.operationId);
        db.prepare("UPDATE effect_cycles SET rollback_status='FAILED' WHERE cycle_id=?").run(
          operation.cycleId,
        );
      })();
    }
    return getRollbackByKey(db, operation.cycleId, operation.idempotencyKey) as RollbackOperation;
  }

  function rollback(cycleId: string, request: RollbackRequest): RollbackOperation {
    const requestedAt = iso(request.requestedAt ?? now().toISOString(), "rollback requestedAt");
    const cycle = getCycle(db, cycleId);
    if (cycle === null) throw new EffectValidationError("unknown effect cycle");
    assertMutable(cycle);
    const existing = getRollbackByKey(db, cycleId, request.idempotencyKey);
    if (existing !== null) return existing;
    const inverse = request.inverse;
    const operationId = id();
    const initialStatus = inverse === undefined ? "MANUAL" : "PENDING";
    db.transaction(() => {
      const pending = db
        .prepare(
          "SELECT operation_id FROM effect_rollback_operations WHERE cycle_id=? AND status='PENDING'",
        )
        .get(cycleId);
      if (pending !== undefined) throw new EffectConflictError("rollback already pending");
      if (cycle.state === "OPEN_SETTLING" || cycle.state === "OPEN_MEASURING")
        finalize(cycleId, requestedAt, true, request.idempotencyKey, "ROLLBACK_REQUESTED");
      db.prepare(
        "INSERT INTO effect_rollback_operations(operation_id,cycle_id,idempotency_key,status,requested_at,completed_at,inverse_kind,expected_revision) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        operationId,
        cycleId,
        request.idempotencyKey,
        initialStatus,
        requestedAt,
        inverse === undefined ? requestedAt : null,
        inverse?.kind ?? "manual",
        inverse?.expectedRevision ?? null,
      );
      db.prepare("UPDATE effect_cycles SET rollback_status=?,rollback_at=? WHERE cycle_id=?").run(
        initialStatus,
        null,
        cycleId,
      );
      recordMutation(cycleId, "ROLLBACK", request.idempotencyKey, requestedAt);
    })();
    if (inverse === undefined)
      return getRollbackByKey(db, cycleId, request.idempotencyKey) as RollbackOperation;
    return completeOwnedRollback(
      getRollbackByKey(db, cycleId, request.idempotencyKey) as RollbackOperation,
      inverse,
    );
  }

  function resumePendingRollbacks(): RollbackOperation[] {
    const rows = db
      .prepare("SELECT * FROM effect_rollback_operations WHERE status='PENDING'")
      .all() as Array<Record<string, string | number | null>>;
    return rows.map((row) => {
      const operation = rollbackFromRow(row);
      const cycle = getCycle(db, operation.cycleId);
      if (cycle === null || cycle.versionStatus !== "SUPPORTED") return operation;
      const inverse = options.resolveOwnedInverse?.(operation) ?? null;
      if (
        inverse === null ||
        inverse.independentlyIdempotent !== true ||
        inverse.kind !== operation.inverseKind ||
        (inverse.expectedRevision ?? null) !== operation.expectedRevision
      ) {
        const completedAt = now().toISOString();
        db.transaction(() => {
          db.prepare(
            "UPDATE effect_rollback_operations SET status='MANUAL',completed_at=?,failure_class='RESTART_INVERSE_UNAVAILABLE' WHERE operation_id=? AND status='PENDING'",
          ).run(completedAt, operation.operationId);
          db.prepare("UPDATE effect_cycles SET rollback_status='MANUAL' WHERE cycle_id=?").run(
            operation.cycleId,
          );
        })();
        return getRollbackByKey(
          db,
          operation.cycleId,
          operation.idempotencyKey,
        ) as RollbackOperation;
      }
      return completeOwnedRollback(operation, inverse);
    });
  }

  function attestExternalRollback(
    cycleId: string,
    request: {
      idempotencyKey: string;
      attestationSource: string;
      attestedAt?: string;
      actualRollbackAt?: string;
    },
  ): RollbackOperation {
    const initialCycle = getCycle(db, cycleId);
    if (initialCycle === null) throw new EffectValidationError("unknown effect cycle");
    assertMutable(initialCycle);
    const existing = getRollbackByKey(db, cycleId, request.idempotencyKey);
    if (existing !== null) return existing;
    const attestedAt = iso(request.attestedAt ?? now().toISOString(), "attestedAt");
    const actual =
      request.actualRollbackAt === undefined
        ? null
        : iso(request.actualRollbackAt, "actualRollbackAt");
    const operationId = id();
    db.transaction(() => {
      const cycle = getCycle(db, cycleId);
      if (cycle === null) throw new EffectValidationError("unknown effect cycle");
      assertMutable(cycle);
      if (cycle.state === "OPEN_SETTLING" || cycle.state === "OPEN_MEASURING")
        finalize(cycleId, attestedAt, true, request.idempotencyKey, "EXTERNAL_ROLLBACK_ATTESTED");
      db.prepare(
        "INSERT INTO effect_rollback_operations(operation_id,cycle_id,idempotency_key,status,requested_at,completed_at,inverse_kind,attestation_source,actual_rollback_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        operationId,
        cycleId,
        request.idempotencyKey,
        "USER_ATTESTED",
        attestedAt,
        attestedAt,
        "external",
        request.attestationSource,
        actual,
      );
      const current = getCycle(db, cycleId) as EffectCycle;
      const reasons = new Set(current.comparisonReasons);
      if (actual === null) reasons.add("ROLLBACK_TIME_UNKNOWN");
      else if (actual >= current.observationFrom && actual < current.scheduledObservationTo)
        reasons.add("ROLLBACK_IN_WINDOW");
      const changesComparison =
        current.state !== "FINALIZED" &&
        (actual === null ||
          (actual >= current.observationFrom && actual < current.scheduledObservationTo));
      db.prepare(`UPDATE effect_cycles SET rollback_status='USER_ATTESTED',rollback_at=?,
        rollback_attestation_source=?,
        comparison_status=CASE WHEN ?=1 THEN 'CONFOUNDED' ELSE comparison_status END,
        comparison_reasons_json=CASE WHEN ?=1 THEN ? ELSE comparison_reasons_json END
        WHERE cycle_id=?`).run(
        actual,
        request.attestationSource,
        changesComparison ? 1 : 0,
        changesComparison ? 1 : 0,
        safeJson([...reasons]),
        cycleId,
      );
      recordMutation(cycleId, "ATTEST_ROLLBACK", request.idempotencyKey, attestedAt);
    })();
    return getRollbackByKey(db, cycleId, request.idempotencyKey) as RollbackOperation;
  }

  return {
    capability,
    track,
    runPass,
    stop,
    closeAttribution,
    rollback,
    resumePendingRollbacks,
    attestExternalRollback,
    getCycle: (cycleId: string) => getCycle(db, cycleId),
    listCycles: (recId?: string) => listCycles(db, recId),
  };
}
