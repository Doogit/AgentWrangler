import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EffectConflictError,
  type EffectCycle,
  type ObservationBundle,
  type ObservationProvider,
  createEffectEngine,
  directionFor,
  findHandler,
  synthesizeLegacyCycles,
} from "../../src/effects/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const APPLIED = "2026-02-01T00:00:00.000Z";

function insertRec(
  db: ReturnType<typeof createInMemoryFixtureDb>,
  id = "rec-esf2",
  detector = "D2",
  metric = "d2-floor-context",
) {
  db.prepare(`INSERT INTO recommendations
    (rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'PROPOSED',?)`).run(
    id,
    "RULE",
    detector,
    "CONTEXT",
    "ws-alpha",
    "test lever",
    "{}",
    "{}",
    metric,
    "2026-01-01T00:00:00.000Z",
  );
}

function evidence(value: number, sessions = 10) {
  return { value, denominator: sessions, exposureN: sessions, sessionN: sessions, excluded: {} };
}

const observer: ObservationProvider = {
  observe(_db, cycle): ObservationBundle {
    return {
      metricId: cycle.metricId,
      methodVersion: cycle.methodVersion,
      queryDefinitionVersion: cycle.queryDefinitionVersion,
      scopeFingerprint: awaitlessHash(cycle.scope),
      parserVersions: ["parser-1"],
      parserMix: {
        before: { available: true, total: 10, counts: { "parser-1": 10 } },
        after: { available: true, total: 10, counts: { "parser-1": 10 } },
      },
      before: evidence(100),
      after: evidence(84),
      modelMix: {
        before: { available: true, total: 10, counts: { sonnet: 10 } },
        after: { available: true, total: 10, counts: { sonnet: 10 } },
      },
      toolMix: {
        before: { available: false, total: 0, counts: {} },
        after: { available: false, total: 0, counts: {} },
      },
      taskMix: {
        before: { available: false, total: 0, counts: {} },
        after: { available: false, total: 0, counts: {} },
      },
      guardrails: [],
    };
  },
};

function awaitlessHash(scope: EffectCycle["scope"]): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function makeEngine(db: ReturnType<typeof createInMemoryFixtureDb>) {
  let n = 0;
  return createEffectEngine(db, {
    observer,
    now: () => new Date(APPLIED),
    idFactory: () => `id-${++n}`,
    finalizerRevision: "test-finalizer",
  });
}

function request(recId = "rec-esf2") {
  return {
    recId,
    detectorId: "D2",
    targetMetric: "d2-floor-context",
    scope: { workspaceId: "ws-alpha" },
    cohort: { state: "RECONCILED" },
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED" as const,
    idempotencyKey: "track-1",
  };
}

describe("ESF2 transactional lifecycle", () => {
  it("tracks atomically, replays a key, conflicts on a second open key, and retracks after stop", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db);
    const engine = makeEngine(db);
    const first = engine.track(request());
    expect(first.supported && first.cycle.state).toBe("OPEN_SETTLING");
    expect(engine.track(request())).toMatchObject({ supported: true, replayed: true });
    expect(() => engine.track({ ...request(), scope: { workspaceId: "ws-beta" } })).toThrow(
      EffectConflictError,
    );
    expect(() => engine.track({ ...request(), idempotencyKey: "track-2" })).toThrow(
      EffectConflictError,
    );
    const stopped = engine.stop("id-1", {
      idempotencyKey: "stop-1",
      reason: "USER_REQUEST",
      at: "2026-02-01T12:00:00Z",
    });
    expect(stopped).toMatchObject({
      state: "STOPPED",
      comparisonStatus: "DESCRIPTIVE",
      comparisonReasons: ["WINDOW_STOPPED_EARLY", "MIX_UNASSESSED"],
    });
    const retracked = engine.track({
      ...request(),
      idempotencyKey: "track-2",
      trackingRequestedAt: "2026-02-02T00:00:00Z",
      appliedAt: "2026-02-02T00:00:00Z",
    });
    expect(retracked.supported && retracked.cycle.cycleNo).toBe(2);
    expect(engine.getCycle("id-1")?.state).toBe("STOPPED");
    db.close();
  });

  it("blocks retracking while any prior rollback is pending", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db);
    const engine = makeEngine(db);
    engine.track(request());
    engine.stop("id-1", { idempotencyKey: "stop", reason: "test" });
    db.prepare(
      `INSERT INTO effect_rollback_operations(operation_id,cycle_id,idempotency_key,status,requested_at,inverse_kind) VALUES('pending','id-1','pending','PENDING',?,'owned')`,
    ).run(APPLIED);
    expect(() =>
      engine.track({
        ...request(),
        idempotencyKey: "track-2",
        appliedAt: "2026-02-02T00:00:00Z",
        trackingRequestedAt: "2026-02-02T00:00:00Z",
      }),
    ).toThrow(/pending rollback/);
    db.close();
  });

  it("uses exclusive material thresholds and 10-session promotion gate", () => {
    const d2 = findHandler("D2", "d2-floor-context");
    if (d2 === null) throw new Error();
    expect(directionFor(d2, 100, 85).direction).toBe("UNCHANGED");
    expect(directionFor(d2, 100, 84.999).direction).toBe("IMPROVED");
    const db = createInMemoryFixtureDb();
    insertRec(db);
    const engine = makeEngine(db);
    engine.track(request());
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    expect(engine.getCycle("id-1")).toMatchObject({
      state: "FINALIZED",
      targetDirection: "IMPROVED",
      comparisonStatus: "COMPARABLE",
    });
    db.close();
  });

  it("terminalizes a lost handler and makes stop/finalizer first-commit-wins", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db);
    let handlerAvailable = true;
    let n = 0;
    const engine = createEffectEngine(db, {
      observer,
      now: () => new Date(APPLIED),
      idFactory: () => `id-${++n}`,
      handlerResolver: (...args) => (handlerAvailable ? findHandler(...args) : null),
    });
    engine.track(request());
    handlerAvailable = false;
    expect(engine.runPass(new Date("2026-02-02T00:00:00Z")).unsupported).toBe(1);
    expect(engine.getCycle("id-1")?.state).toBe("UNSUPPORTED");
    handlerAvailable = true;
    insertRec(db, "rec-race");
    engine.track({ ...request("rec-race"), idempotencyKey: "race" });
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    const after = engine.stop("id-2", { idempotencyKey: "late-stop", reason: "late" });
    expect(after.state).toBe("FINALIZED");
    expect(after.finalEvidence).not.toBeNull();
    db.close();
  });

  it("preserves finalized evidence when attribution closes and rejects unsafe generic rollback", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db);
    const engine = makeEngine(db);
    engine.track(request());
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    const before = engine.getCycle("id-1")?.finalEvidence;
    const closed = engine.closeAttribution("id-1", {
      idempotencyKey: "close",
      reason: "USER_CLOSED",
      at: "2026-02-16T00:00:00Z",
    });
    expect(closed.state).toBe("FINALIZED");
    expect(closed.finalEvidence).toEqual(before);
    const manual = engine.rollback("id-1", { idempotencyKey: "rb-manual" });
    expect(manual.status).toBe("MANUAL");
    expect(engine.rollback("id-1", { idempotencyKey: "rb-manual" })).toEqual(manual);
    db.close();
  });

  it("supports owned inverse conflict checks and external unknown-time attestation", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db);
    const engine = makeEngine(db);
    engine.track(request());
    const conflict = engine.rollback("id-1", {
      idempotencyKey: "rb",
      inverse: {
        kind: "owned-setting",
        independentlyIdempotent: true,
        checkConflict: () => ({ conflict: true, reasonClass: "REVISION_MISMATCH" }),
        execute: () => {
          throw new Error("must not execute");
        },
      },
    });
    expect(conflict).toMatchObject({ status: "CONFLICT", failureClass: "REVISION_MISMATCH" });
    insertRec(db, "rec-external");
    engine.track({ ...request("rec-external"), idempotencyKey: "external" });
    engine.attestExternalRollback("id-3", { idempotencyKey: "attest", attestationSource: "USER" });
    expect(engine.getCycle("id-3")).toMatchObject({
      state: "STOPPED",
      rollbackStatus: "USER_ATTESTED",
      comparisonStatus: "CONFOUNDED",
    });
    expect(engine.getCycle("id-3")?.comparisonReasons).toContain("ROLLBACK_TIME_UNKNOWN");
    db.close();
  });
});

describe("legacy read-only synthesis", () => {
  it("preserves exact W4 INCONCLUSIVE evidence and deterministic identity", () => {
    const db = createInMemoryFixtureDb();
    insertRec(db, "legacy");
    db.prepare(
      "INSERT INTO recommendation_effects(rec_id,measured_at,before_from,before_to,after_from,after_to,before_value,after_value,before_n,after_n,delta_pct,verdict) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "legacy",
      APPLIED,
      "2026-01-01",
      APPLIED,
      APPLIED,
      "2026-02-15",
      100,
      null,
      1,
      null,
      null,
      "INCONCLUSIVE",
    );
    const one = synthesizeLegacyCycles(db, "legacy");
    const two = synthesizeLegacyCycles(db, "legacy");
    expect(one).toEqual(two);
    expect(one[0]).toMatchObject({
      contractVersion: "w4-legacy-1",
      verdict: "INCONCLUSIVE",
      comparisonStatus: null,
      label: "Legacy target-metric result.",
    });
    expect(
      (
        db.prepare("SELECT verdict FROM recommendation_effects WHERE rec_id='legacy'").get() as {
          verdict: string;
        }
      ).verdict,
    ).toBe("INCONCLUSIVE");
    db.close();
  });
});
