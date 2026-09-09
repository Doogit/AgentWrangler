import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type EffectCycle,
  EffectUnsupportedVersionError,
  EffectValidationError,
  type ObservationBundle,
  createEffectEngine,
  findHandler,
} from "../../src/effects/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const APPLIED = "2026-02-01T00:00:00.000Z";

function insertRec(db: ReturnType<typeof createInMemoryFixtureDb>, id: string) {
  db.prepare(`INSERT INTO recommendations
    (rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at)
    VALUES(?,'RULE','D2','CONTEXT','ws-alpha','x','{}','{}','d2-floor-context','PROPOSED','2026-01-01')`).run(
    id,
  );
}

function evidence(value: number) {
  return { value, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} };
}

function bundle(
  cycle: EffectCycle,
  call: number,
  queryDefinitionVersion = "esf-1",
): ObservationBundle {
  const unavailable = { available: false, total: 0, counts: {} };
  const guardrail = cycle.guardrailDefinitions[0];
  return {
    metricId: cycle.metricId,
    methodVersion: cycle.methodVersion,
    queryDefinitionVersion,
    scopeFingerprint: createHash("sha256").update(JSON.stringify(cycle.scope)).digest("hex"),
    parserVersions: ["p1"],
    parserMix: {
      before: { available: true, total: 10, counts: { p1: 10 } },
      after: { available: true, total: 10, counts: { p1: 10 } },
    },
    before: evidence(call === 1 ? 100 : 999),
    after: evidence(80),
    modelMix: { before: unavailable, after: unavailable },
    toolMix: { before: unavailable, after: unavailable },
    taskMix: { before: unavailable, after: unavailable },
    guardrails:
      guardrail === undefined
        ? []
        : [
            {
              ...guardrail,
              availability: "SUPPORTED",
              before: evidence(call === 1 ? 100 : 999),
              after: evidence(80),
              direction: "STABLE",
              reasonCodes: [],
              evidence: {},
            },
          ],
  };
}

function request(recId: string, key = "track") {
  return {
    recId,
    detectorId: "D2",
    targetMetric: "avg_context_per_turn",
    scope: { workspaceId: "ws-alpha" },
    cohort: { state: "RECONCILED" },
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED" as const,
    idempotencyKey: key,
  };
}

describe("ESF2 persisted contract boundaries", () => {
  it("uses a bounded supported-cycle existence query and honors stopped, boundary, and version exclusions", () => {
    const db = createInMemoryFixtureDb();
    let sequence = 0;
    const engine = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
      idFactory: () => `bounded-${++sequence}`,
      now: () => new Date(APPLIED),
    });

    insertRec(db, "target");
    const target = engine.track(request("target"));
    if (!target.supported) throw new Error("expected supported target fixture");

    // A stopped window ending exactly where target begins must not intersect,
    // even though its originally scheduled window would have continued.
    insertRec(db, "stopped-boundary");
    const stopped = engine.track({
      ...request("stopped-boundary", "stopped"),
      appliedAt: "2026-01-18T00:00:00.000Z",
      trackingRequestedAt: "2026-01-18T00:00:00.000Z",
    });
    if (!stopped.supported) throw new Error("expected supported stopped fixture");
    db.prepare(`UPDATE effect_cycles
      SET state='STOPPED', observation_to=?, terminal_at=?
      WHERE cycle_id=?`).run(APPLIED, APPLIED, stopped.cycle.cycleId);

    // This overlaps in time and scope but is intentionally an unknown version.
    insertRec(db, "unsupported-first");
    const unsupported = engine.track({
      ...request("unsupported-first", "unsupported"),
      appliedAt: "2026-01-31T00:00:00.000Z",
      trackingRequestedAt: "2026-01-31T00:00:00.000Z",
    });
    if (!unsupported.supported) throw new Error("expected supported setup fixture");
    db.prepare("UPDATE effect_cycles SET contract_version='future-v99' WHERE cycle_id=?").run(
      unsupported.cycle.cycleId,
    );

    // Large unrelated history must stay out of the candidate result set.
    // Four digit cross joins avoid a slow per-row fixture setup while retaining
    // real, supported cycle envelopes and foreign-keyed recommendations.
    const numbers = `WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
      numbers(n) AS (
        SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 1
        FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
      )`;
    db.transaction(() => {
      db.prepare(`${numbers}
        INSERT INTO recommendations
          (rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at)
        SELECT 'history-' || n,'RULE','D2','CONTEXT','ws-alpha','x','{}','{}','d2-floor-context','PROPOSED','2030-01-01'
        FROM numbers WHERE n <= 10000`).run();
      db.prepare(`${numbers}
        INSERT INTO effect_cycles
          (cycle_id,rec_id,cycle_no,contract_version,query_definition_version,detector_id,metric_id,method_version,state,
           created_at,tracking_requested_at,applied_at,application_source,track_idempotency_key,
           scope_json,cohort_json,target_definition_json,guardrail_definitions_json,baseline_from,baseline_to,
           observation_from,scheduled_observation_to,baseline_evidence_json,provisional_evidence_json)
        SELECT 'history-cycle-' || n,'history-' || n,1,e.contract_version,e.query_definition_version,
          e.detector_id,e.metric_id,e.method_version,'OPEN_SETTLING','2030-01-01','2030-01-01','2030-01-01',
          e.application_source,'history-' || n,e.scope_json,e.cohort_json,e.target_definition_json,e.guardrail_definitions_json,
          '2029-12-18','2030-01-01','2030-01-01','2030-01-15',e.baseline_evidence_json,e.provisional_evidence_json
        FROM numbers CROSS JOIN effect_cycles e
        WHERE n <= 10000 AND e.cycle_id=?`).run(target.cycle.cycleId);
    })();

    const statements: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    const instrumented = db as unknown as { prepare: typeof db.prepare };
    instrumented.prepare = ((source: string) => {
      statements.push(source);
      return originalPrepare(source);
    }) as typeof db.prepare;

    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    const finalized = engine.getCycle(target.cycle.cycleId);
    expect(finalized?.comparisonStatus).toBe("COMPARABLE");
    expect(finalized?.comparisonReasons).not.toContain("OVERLAPPING_INTERVENTION");
    expect(
      statements.some(
        (statement) =>
          statement.includes("SELECT 1 FROM effect_cycles") && statement.includes("LIMIT 1"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("SELECT * FROM effect_cycles ORDER BY created_at DESC, cycle_id"),
      ),
    ).toBe(false);
    db.close();
  });

  it("uses the target's effective stopped end and does not let an unsupported row hide a supported overlap", () => {
    const db = createInMemoryFixtureDb();
    let sequence = 0;
    const engine = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
      idFactory: () => `overlap-${++sequence}`,
      now: () => new Date(APPLIED),
    });

    insertRec(db, "stopped-target");
    const stoppedTarget = engine.track(request("stopped-target", "target"));
    if (!stoppedTarget.supported) throw new Error("expected supported stopped target");
    insertRec(db, "starts-at-stop");
    const startsAtStop = engine.track({
      ...request("starts-at-stop", "boundary"),
      appliedAt: "2026-02-02T00:00:00.000Z",
      trackingRequestedAt: "2026-02-02T00:00:00.000Z",
    });
    if (!startsAtStop.supported) throw new Error("expected supported boundary fixture");
    const stopped = engine.stop(stoppedTarget.cycle.cycleId, {
      idempotencyKey: "stop",
      reason: "USER_REQUEST",
      at: "2026-02-02T00:00:00.000Z",
    });
    expect(stopped.observationTo).toBe("2026-02-02T00:00:00.000Z");
    expect(stopped.comparisonReasons).not.toContain("OVERLAPPING_INTERVENTION");
    db.prepare(
      'UPDATE effect_cycles SET scope_json=\'{"workspaceId":"ws-stopped-target"}\' WHERE cycle_id=?',
    ).run(stoppedTarget.cycle.cycleId);
    db.prepare(
      'UPDATE effect_cycles SET scope_json=\'{"workspaceId":"ws-other"}\' WHERE cycle_id=?',
    ).run(startsAtStop.cycle.cycleId);

    insertRec(db, "empty-target");
    const emptyTarget = engine.track({
      ...request("empty-target", "empty-target"),
      scope: { workspaceId: "ws-empty-target" },
    });
    insertRec(db, "spanning-other");
    engine.track({
      ...request("spanning-other", "spanning-other"),
      scope: { workspaceId: "ws-empty-target" },
      appliedAt: "2026-01-31T00:00:00.000Z",
      trackingRequestedAt: "2026-01-31T00:00:00.000Z",
    });
    if (!emptyTarget.supported) throw new Error("expected supported empty target");
    expect(
      engine.stop(emptyTarget.cycle.cycleId, {
        idempotencyKey: "immediate-stop",
        reason: "USER_REQUEST",
        at: APPLIED,
      }).comparisonReasons,
    ).not.toContain("OVERLAPPING_INTERVENTION");

    insertRec(db, "nonempty-target");
    const nonemptyTarget = engine.track({
      ...request("nonempty-target", "nonempty-target"),
      scope: { workspaceId: "ws-empty-other" },
    });
    insertRec(db, "empty-other");
    const emptyOther = engine.track({
      ...request("empty-other", "empty-other"),
      scope: { workspaceId: "ws-empty-other" },
      appliedAt: "2026-02-02T00:00:00.000Z",
      trackingRequestedAt: "2026-02-02T00:00:00.000Z",
    });
    if (!nonemptyTarget.supported || !emptyOther.supported)
      throw new Error("expected supported empty-other fixtures");
    engine.stop(emptyOther.cycle.cycleId, {
      idempotencyKey: "empty-other-stop",
      reason: "USER_REQUEST",
      at: "2026-02-02T00:00:00.000Z",
    });
    expect(
      engine.stop(nonemptyTarget.cycle.cycleId, {
        idempotencyKey: "nonempty-stop",
        reason: "USER_REQUEST",
        at: "2026-02-03T00:00:00.000Z",
      }).comparisonReasons,
    ).not.toContain("OVERLAPPING_INTERVENTION");

    insertRec(db, "positive-target");
    const positiveTarget = engine.track(request("positive-target", "positive-target"));
    if (!positiveTarget.supported) throw new Error("expected supported positive target");
    insertRec(db, "unsupported-before-supported");
    const unsupported = engine.track({
      ...request("unsupported-before-supported", "unsupported-before-supported"),
      appliedAt: "2026-02-02T00:00:00.000Z",
      trackingRequestedAt: "2026-02-02T00:00:00.000Z",
    });
    if (!unsupported.supported) throw new Error("expected unsupported setup fixture");
    db.prepare("UPDATE effect_cycles SET contract_version='future-v99' WHERE cycle_id=?").run(
      unsupported.cycle.cycleId,
    );
    insertRec(db, "supported-after-unsupported");
    const supported = engine.track({
      ...request("supported-after-unsupported", "supported-after-unsupported"),
      appliedAt: "2026-02-02T00:00:00.000Z",
      trackingRequestedAt: "2026-02-02T00:00:00.000Z",
    });
    if (!supported.supported) throw new Error("expected supported overlap fixture");

    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(engine.getCycle(positiveTarget.cycle.cycleId)?.comparisonReasons).toContain(
      "OVERLAPPING_INTERVENTION",
    );
    db.close();
  });

  it("reads future envelopes opaquely and rejects replay and mutations without starving supported work", () => {
    const db = createInMemoryFixtureDb();
    let seq = 0;
    const engine = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
      idFactory: () => `cycle-${++seq}`,
      now: () => new Date(APPLIED),
    });
    for (let i = 0; i < 101; i++) {
      insertRec(db, `future-${i}`);
      const result = engine.track(request(`future-${i}`));
      if (!result.supported) throw new Error("expected supported fixture");
      const field =
        i % 3 === 0
          ? "contract_version"
          : i % 3 === 1
            ? "query_definition_version"
            : "method_version";
      db.prepare(
        `UPDATE effect_cycles SET ${field}='future-v99',target_definition_json='null',guardrail_definitions_json='{}' WHERE cycle_id=?`,
      ).run(result.cycle.cycleId);
    }
    insertRec(db, "supported");
    const supported = engine.track(request("supported"));
    if (!supported.supported) throw new Error("expected supported fixture");

    const future = engine.getCycle("cycle-1");
    expect(future).toMatchObject({
      versionStatus: "UNSUPPORTED_VERSION",
      targetDirection: null,
      comparisonStatus: null,
      finalEvidence: null,
    });
    expect(engine.listCycles()).toHaveLength(102);
    expect(() => engine.track(request("future-0"))).toThrow(EffectUnsupportedVersionError);
    expect(() => engine.stop("cycle-1", { idempotencyKey: "stop", reason: "x" })).toThrow(
      EffectUnsupportedVersionError,
    );
    expect(() => engine.rollback("cycle-1", { idempotencyKey: "rb" })).toThrow(
      EffectUnsupportedVersionError,
    );
    expect(() =>
      engine.closeAttribution("cycle-1", { idempotencyKey: "close", reason: "x" }),
    ).toThrow(EffectUnsupportedVersionError);
    expect(() =>
      engine.attestExternalRollback("cycle-1", {
        idempotencyKey: "attest",
        attestationSource: "USER",
      }),
    ).toThrow(EffectUnsupportedVersionError);
    expect(engine.runPass(new Date("2026-02-15T00:00:00Z")).finalized).toBe(1);
    expect(engine.getCycle(supported.cycle.cycleId)?.state).toBe("FINALIZED");
    expect(engine.getCycle("cycle-1")?.state).toBe("OPEN_SETTLING");
    db.close();
  });

  it("accepts only exact aliases and provider-backed scope filters", () => {
    expect(findHandler("D1", "avg_context_per_turn")?.detectorId).toBe("D1");
    expect(findHandler("D2", "avg_context_per_turn")?.detectorId).toBe("D2");
    expect(findHandler("D8", "cache_read_to_creation_ratio")?.target.methodVersion).toBe(
      "d8-cache-ratio-v2",
    );
    expect(findHandler("D8", "CACHE_READ_TO_CREATION_RATIO")).toBeNull();
    expect(findHandler("D1", "d1-source-tokens", "future-v9")).toBeNull();

    const db = createInMemoryFixtureDb();
    insertRec(db, "scope");
    const engine = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
    });
    expect(() =>
      engine.track({ ...request("scope"), scope: { workspaceId: "ws-alpha", tool: "Read" } }),
    ).toThrow(EffectValidationError);
    db.close();
  });

  it("freezes guardrail baselines, persists guardrails, and confounds provider version drift", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db, "drift");
    let calls = 0;
    const engine = createEffectEngine(db, {
      observer: {
        observe: (_db, cycle) => {
          const observed = bundle(cycle, ++calls, calls === 1 ? "esf-1" : "esf-2");
          if (calls > 1 && observed.guardrails[0] !== undefined)
            observed.guardrails[0].methodVersion = "future-guardrail-v9";
          return observed;
        },
      },
      idFactory: () => "drift-cycle",
      now: () => new Date(APPLIED),
    });
    engine.track(request("drift"));
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    const cycle = engine.getCycle("drift-cycle");
    expect(cycle?.finalEvidence?.guardrails[0]?.before.value).toBe(100);
    expect(cycle?.finalEvidence?.guardrails[0]).toMatchObject({
      availability: "UNSUPPORTED",
      reasonCodes: ["GUARDRAIL_DEFINITION_MISMATCH"],
    });
    expect(cycle).toMatchObject({ comparisonStatus: "CONFOUNDED" });
    expect(cycle?.comparisonReasons).toEqual(
      expect.arrayContaining(["METHOD_VERSION_CHANGED", "MIX_UNASSESSED"]),
    );
    const row = db
      .prepare(
        "SELECT before_value FROM effect_guardrail_results WHERE cycle_id='drift-cycle' AND guardrail_id='reported-lost-progress'",
      )
      .get() as { before_value: number };
    expect(row.before_value).toBe(100);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM effect_mutation_keys").get() as { n: number }).n,
    ).toBeGreaterThanOrEqual(2);
    db.close();
  });
});

describe("ESF2 rollback recovery and comparison metadata", () => {
  it("resumes an independently idempotent pending inverse and records in-window confounding", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db, "restart");
    let executions = 0;
    const inverse = {
      kind: "owned-setting",
      expectedRevision: "r1",
      independentlyIdempotent: true as const,
      checkConflict: () => ({ conflict: false as const }),
      execute: () => {
        executions++;
        return { restorationRevision: "r0" };
      },
    };
    const base = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
      idFactory: () => "restart-cycle",
      now: () => new Date(APPLIED),
    });
    base.track(request("restart"));
    base.stop("restart-cycle", { idempotencyKey: "stop", reason: "restart" });
    db.prepare(`INSERT INTO effect_rollback_operations
      (operation_id,cycle_id,idempotency_key,status,requested_at,inverse_kind,expected_revision)
      VALUES('pending','restart-cycle','resume','PENDING',?,'owned-setting','r1')`).run(APPLIED);
    db.prepare(
      "UPDATE effect_cycles SET rollback_status='PENDING' WHERE cycle_id='restart-cycle'",
    ).run();
    const restarted = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
      now: () => new Date("2026-02-02T00:00:00Z"),
      resolveOwnedInverse: () => inverse,
    });
    expect(restarted.resumePendingRollbacks()[0]).toMatchObject({
      status: "SUCCEEDED",
      actualRollbackAt: "2026-02-02T00:00:00.000Z",
    });
    expect(executions).toBe(1);
    expect(restarted.getCycle("restart-cycle")).toMatchObject({
      comparisonStatus: "CONFOUNDED",
      rollbackStatus: "SUCCEEDED",
    });
    expect(restarted.getCycle("restart-cycle")?.comparisonReasons).toContain("ROLLBACK_IN_WINDOW");
    db.close();
  });

  it("keeps finalized evidence and verdict immutable for later rollback metadata", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db, "final");
    const engine = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
      idFactory: () => "final-cycle",
      now: () => new Date(APPLIED),
    });
    engine.track(request("final"));
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    const before = engine.getCycle("final-cycle");
    engine.attestExternalRollback("final-cycle", {
      idempotencyKey: "attest",
      attestationSource: "USER",
      actualRollbackAt: "2026-02-05T00:00:00Z",
    });
    const after = engine.getCycle("final-cycle");
    expect(after?.finalEvidence).toEqual(before?.finalEvidence);
    expect(after?.targetDirection).toBe(before?.targetDirection);
    expect(after?.comparisonStatus).toBe(before?.comparisonStatus);
    expect(after?.comparisonReasons).toEqual(before?.comparisonReasons);
    expect(after?.rollbackStatus).toBe("USER_ATTESTED");
    db.close();
  });

  it("marks unrecoverable pending work manual and does not confound a known outside-window rollback", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db, "outside");
    let seq = 0;
    const engine = createEffectEngine(db, {
      observer: { observe: (_db, cycle) => bundle(cycle, 1) },
      idFactory: () => `outside-${++seq}`,
      now: () => new Date(APPLIED),
    });
    engine.track(request("outside"));
    engine.attestExternalRollback("outside-1", {
      idempotencyKey: "outside",
      attestationSource: "USER",
      attestedAt: "2026-02-20T00:00:00Z",
      actualRollbackAt: "2026-02-16T00:00:00Z",
    });
    // The full frozen window matured before this known outside-window rollback.
    expect(engine.getCycle("outside-1")).toMatchObject({ comparisonStatus: "COMPARABLE" });
    expect(engine.getCycle("outside-1")?.comparisonReasons).not.toEqual(
      expect.arrayContaining(["ROLLBACK_IN_WINDOW", "ROLLBACK_TIME_UNKNOWN"]),
    );

    db.prepare(`INSERT INTO effect_rollback_operations
      (operation_id,cycle_id,idempotency_key,status,requested_at,inverse_kind)
      VALUES('orphan','outside-1','orphan','PENDING',?,'owned-setting')`).run(APPLIED);
    const recovered = engine.resumePendingRollbacks();
    expect(recovered[0]).toMatchObject({
      status: "MANUAL",
      failureClass: "RESTART_INVERSE_UNAVAILABLE",
    });
    db.close();
  });
});
