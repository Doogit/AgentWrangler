import { describe, expect, it } from "vitest";
import { createEffectEngine } from "../../src/effects/index.js";
import {
  ESF5_APPLIED_AT,
  ESF5_EVIDENCE_AS_OF,
  ESF5_SCOPED_SOURCE_IDENTITY,
  ESF5_SCOPED_TOOL_IDENTITY,
  createEsf5ObservationProvider,
  esf5EffectManifest,
  seedEsf5Effects,
} from "../fixtures/esf5-effects.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function corpus() {
  const db = createInMemoryFixtureDb();
  seedEsf5Effects(db);
  return { db, engine: createEffectEngine(db, { observer: createEsf5ObservationProvider() }) };
}

describe("ESF5 bounded synthetic effect corpus", () => {
  it("persists D4 +18 points and engine-derived adverse supplied repair evidence", () => {
    const { db, engine } = corpus();
    const cycle = engine.getCycle(esf5EffectManifest.cycles.lowCostRepair);
    expect(cycle).toMatchObject({
      cycleId: "cycle-d4-01",
      state: "FINALIZED",
      targetDirection: "IMPROVED",
      baselineFrom: "2026-07-18T00:00:00.000Z",
      observationTo: ESF5_EVIDENCE_AS_OF,
      finalEvidence: { before: { value: 50, sessionN: 10 }, after: { value: 68, sessionN: 10 } },
    });
    expect(
      cycle?.finalEvidence?.guardrails.find(
        (x) => x.guardrailId === "reported-useful-completion-repair",
      ),
    ).toMatchObject({
      availability: "SUPPORTED",
      direction: "ADVERSE",
      before: { value: 2, denominator: 10 },
      after: { value: 5, denominator: 10 },
      reasonCodes: ["SYNTHETIC_SUPPLIED_GUARDRAIL_SEAM"],
    });
    db.close();
  });

  it("persists exact D2 rollback and D8 model drift", () => {
    const { db, engine } = corpus();
    expect(engine.getCycle(esf5EffectManifest.cycles.rollbackMid)).toMatchObject({
      cycleId: "cycle-d2-02",
      state: "STOPPED",
      observationTo: "2026-08-10T12:00:00.000Z",
      comparisonStatus: "CONFOUNDED",
      rollbackStatus: "USER_ATTESTED",
    });
    expect(engine.getCycle(esf5EffectManifest.cycles.rollbackMid)?.comparisonReasons).toEqual(
      expect.arrayContaining(["WINDOW_STOPPED_EARLY", "ROLLBACK_IN_WINDOW"]),
    );
    const drift = engine.getCycle(esf5EffectManifest.cycles.mixDrift);
    expect(drift?.finalEvidence?.modelMix).toEqual({
      before: { available: true, total: 20, counts: { "claude-opus": 6, "claude-sonnet": 14 } },
      after: { available: true, total: 20, counts: { "claude-opus": 11, "claude-sonnet": 9 } },
    });
    expect(drift?.comparisonReasons).toEqual(
      expect.arrayContaining(["MODEL_MIX_SHIFT", "MIX_UNASSESSED"]),
    );
    db.close();
  });

  it("makes 9 fail, 10 pass, and rejects a ten-turn one-session substitute", () => {
    const { db, engine } = corpus();
    for (const detector of ["D2", "D4", "D8"] as const) {
      const nine = engine.listCycles(`threshold-${detector.toLowerCase()}-9`)[0];
      const ten = engine.listCycles(`threshold-${detector.toLowerCase()}-10`)[0];
      expect(nine?.comparisonReasons).toContain("INSUFFICIENT_SESSIONS");
      expect(ten?.comparisonReasons).not.toContain("INSUFFICIENT_SESSIONS");
      expect(nine?.finalEvidence?.before.sessionN).toBe(9);
      expect(ten?.finalEvidence?.before.sessionN).toBe(10);
    }
    const trap = engine.listCycles("threshold-d4-turn-trap")[0];
    expect(trap?.finalEvidence?.after).toMatchObject({ exposureN: 10, sessionN: 1 });
    expect(trap?.comparisonReasons).toContain("INSUFFICIENT_SESSIONS");
    db.close();
  });

  it("keeps an unregistered D7 target unsupported and uses actual D2/D4 overlap controls", () => {
    const { db, engine } = corpus();
    expect(
      engine.track({
        recId: "no-d7-row",
        detectorId: "D7",
        targetMetric: "tool-error-rate",
        scope: { workspaceId: "ws-esf5-overlap", tool: "Bash" },
        cohort: {},
        trackingRequestedAt: ESF5_APPLIED_AT,
        appliedAt: ESF5_APPLIED_AT,
        applicationSource: "USER_ATTESTED",
        idempotencyKey: "d7",
      }),
    ).toEqual({ supported: false, state: "UNSUPPORTED", reason: "HANDLER_UNAVAILABLE" });
    for (const [id, detector] of [
      [esf5EffectManifest.cycles.overlapControlD2, "D2"],
      [esf5EffectManifest.cycles.overlapControlD4, "D4"],
    ] as const) {
      const cycle = engine.getCycle(id);
      expect(cycle).toMatchObject({
        detectorId: detector,
        state: "STOPPED",
        observationFrom: "2026-08-03T00:00:00.000Z",
        scheduledObservationTo: "2026-08-17T00:00:00.000Z",
        observationTo: ESF5_EVIDENCE_AS_OF,
      });
      expect(cycle?.comparisonReasons).toContain("OVERLAPPING_INTERVENTION");
    }
    db.close();
  });

  it("FX-OVERLAP-SCOPED-14D freezes opaque D7/D2 scopes, scalar evidence, and guardrails", () => {
    const { db, engine } = corpus();
    for (const [id, detector, metric, before, after, baselineToolEvents] of [
      [esf5EffectManifest.cycles.overlapScopedD7, "D7", "d7-loop-flagged-turn-share", 1, 0, 30],
      [esf5EffectManifest.cycles.overlapScopedD2, "D2", "d2-floor-context-scoped", 1000, 800, 30],
    ] as const) {
      const cycle = engine.getCycle(id);
      expect(cycle).toMatchObject({
        cycleId: id,
        detectorId: detector,
        metricId: metric,
        state: "STOPPED",
        observationFrom: "2026-08-03T00:00:00.000Z",
        scheduledObservationTo: "2026-08-17T00:00:00.000Z",
        observationTo: ESF5_EVIDENCE_AS_OF,
        scope: {
          workspaceId: "ws-esf5-overlap-scoped",
          sourceIdentity: ESF5_SCOPED_SOURCE_IDENTITY,
          tool: ESF5_SCOPED_TOOL_IDENTITY,
        },
        finalEvidence: {
          before: { value: before, sessionN: 10 },
          after: { value: after, sessionN: 10 },
        },
      });
      expect(cycle?.comparisonReasons).toContain("OVERLAPPING_INTERVENTION");
      expect(cycle?.finalEvidence?.toolMix).toEqual({
        before: {
          available: true,
          total: baselineToolEvents,
          counts: { Bash: baselineToolEvents },
        },
        after: { available: true, total: 10, counts: { Bash: 10 } },
      });
      expect(cycle?.finalEvidence?.modelMix).toEqual({
        before: { available: true, total: 10, counts: { "claude-sonnet": 10 } },
        after: { available: true, total: 10, counts: { "claude-sonnet": 10 } },
      });
      expect(cycle?.finalEvidence?.parserMix).toEqual({
        before: { available: true, total: 10, counts: { "esf5-parser": 10 } },
        after: { available: true, total: 10, counts: { "esf5-parser": 10 } },
      });
      expect(cycle?.finalEvidence?.guardrails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            guardrailId: "completed-tool-error-rate",
            availability: "SUPPORTED",
            before: expect.objectContaining({ value: 1 / 3, denominator: 30, sessionN: 10 }),
            after: expect.objectContaining({ value: 0, denominator: 10, sessionN: 10 }),
          }),
          expect.objectContaining({
            guardrailId: "strict-test-recovery-sequences",
            availability: "SUPPORTED",
            direction: "INSUFFICIENT_DATA",
            reasonCodes: ["DESCRIPTIVE_ONLY"],
          }),
        ]),
      );
    }
    db.close();
  });
});
