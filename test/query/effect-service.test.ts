import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EffectRequestError,
  capabilityForRecommendation,
  effectEngineForDb,
  listArtifactBoundMeasuredResults,
  listEffectEvidence,
  mutateEffectCycle,
  opaqueD1SourceIdentity,
  trackArtifactBoundApplication,
  trackCompletedChange,
} from "../../src/query/api/effect-service.js";
import {
  adoptRecommendation,
  reopenRecommendation,
  undoAdoptRecommendation,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import {
  appendArtifactApplication,
  appendArtifactRevision,
  appendMeasurementMethod,
  appendRecommendationRevision,
} from "../../src/recommendations/storage.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../src/effects/gate.js", () => ({
  get ESF_EFFECT_WRITER_ENABLED() {
    return gate.enabled;
  },
}));

let db: Database.Database;
const T0 = new Date("2026-01-10T00:00:00.000Z");

beforeEach(() => {
  gate.enabled = true;
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

function d1Payload(component: "CLAUDE_MD" | "MEMORY" = "CLAUDE_MD"): string {
  return JSON.stringify({
    version: 1,
    template_id: "D1_CONTEXT_ALWAYS_LOADED",
    facts: {
      component,
      source_tokens: 2_000,
      source_target: 1_000,
      delta_context_tokens: 1_000,
      turns_per_week: 10,
      scope: "workspace",
      workspace_multiplier: 1,
    },
  });
}

function rec(id: string, _fileRef = `/project/${id}.md`, workspace = "ws-alpha"): void {
  seedValidatedRecommendation(db, {
    recId: id,
    scope: workspace,
    createdAt: T0.toISOString(),
    facts: {
      component: "CLAUDE_MD",
      source_tokens: 2_000,
      source_target: 1_000,
      delta_context_tokens: 1_000,
      turns_per_week: 10,
    },
  });
  if (workspace !== "ws-alpha") return;
  db.prepare(`INSERT INTO context_inventory_history
    (workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at)
    VALUES (?,'CLAUDE_MD',?,'h',100,'chars4-v1',?)`).run(
    workspace,
    "CLAUDE.md",
    new Date(T0.getTime() - 86_400_000).toISOString(),
  );
}

function artifactApplication(
  recId: string,
  suffix: string,
  verdict: "AUTOMATIC" | "MANUAL" = "AUTOMATIC",
  frozenDefinitionJson?: string,
): string {
  seedValidatedRecommendation(db, {
    recId,
    templateId: "D2_LONG_FULL_CONTEXT",
    scope: "ws-alpha",
    createdAt: T0.toISOString(),
  });
  const findingId = `hre-finding-${suffix}`;
  const snapshotId = `hre-snapshot-${suffix}`;
  const poolId = `hre-pool-${suffix}`;
  const recommendationId = `hre-recommendation-${suffix}`;
  const revisionId = `hre-revision-${suffix}`;
  const artifactId = `hre-artifact-${suffix}`;
  const applicationId = `hre-application-${suffix}`;
  db.prepare(
    `INSERT INTO hre_findings
      (finding_id,source_kind,legacy_rec_id,detector_id,detector_contract_version,lifecycle,observed_at,reason_code,created_at)
     VALUES(?, 'LEGACY', ?, 'D2', 1, 'OPEN', ?, 'LEGACY_ADAPTER', ?)`,
  ).run(findingId, recId, T0.toISOString(), T0.toISOString());
  db.prepare(
    `INSERT INTO hre_composition_snapshots
      (snapshot_id,composition_version,registry_version,ranking_policy_version,price_version,window_from,window_to,created_at)
     VALUES(?, 1, 'hre-registry-1', 'rank-1', 'price-1', ?, ?, ?)`,
  ).run(snapshotId, "2026-01-01T00:00:00.000Z", T0.toISOString(), T0.toISOString());
  db.prepare(
    "INSERT INTO hre_ceu_pools(composition_snapshot_id,ceu_pool_id,total_ceu_per_week) VALUES(?,?,1)",
  ).run(snapshotId, poolId);
  appendRecommendationRevision(db, {
    recommendationId,
    recommendationRevisionId: revisionId,
    expectedActiveRevisionId: null,
    snapshotId,
    findingId,
    ceuPoolId: poolId,
    ownsValue: true,
    contributionCeuPerWeek: 1,
    handlerFamily: "H2_OUTPUT_CONTEXT",
    handlerVersion: "h2-handler-1",
    registryVersion: "hre-registry-1",
    rankingPolicyVersion: "rank-1",
    expectedValue: 1,
    expectedValueUnit: "CEU_PER_WEEK",
    valueMethodId: `hre-value-${suffix}`,
    valueMethodVersion: "1",
    valueWindowFrom: "2026-01-01T00:00:00.000Z",
    valueWindowTo: T0.toISOString(),
    reasonCodes: ["OUTPUT_EXPOSURE"],
    createdAt: T0.toISOString(),
  });
  appendArtifactRevision(db, {
    artifactRevisionId: artifactId,
    recommendationRevisionId: revisionId,
    artifactKind: "advice",
    artifactHash: `hre-artifact-hash-${suffix}`,
    capabilityProfileVersion: "profile-1",
    validationStatus: "VALIDATED",
    rollbackAvailable: true,
    supersedesArtifactRevisionId: null,
    createdAt: T0.toISOString(),
  });
  if (frozenDefinitionJson === undefined) {
    appendMeasurementMethod(db, {
      measurementMethodId: `hre-measurement-${suffix}`,
      artifactRevisionId: artifactId,
      methodVersion: "hre-measurement-1",
      targetMetricCode: "OUTPUT_EXPOSURE_CEU_PER_WEEK",
      verdict,
      definition: {
        targetDirection: "REDUCE",
        horizonDays: 7,
        baselineCohortCode: "HRE_BASELINE",
        afterCohortCode: "HRE_AFTER",
        guardrailCodes: ["NO_QUALITY_REGRESSION"],
        comparabilityCode: "SAME_SCOPE",
      },
      createdAt: T0.toISOString(),
    });
  } else {
    db.prepare(
      `INSERT INTO hre_measurement_methods
        (measurement_method_id,artifact_revision_id,method_version,target_metric_code,verdict,frozen_definition_json,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(
      `hre-measurement-${suffix}`,
      artifactId,
      "hre-measurement-1",
      "OUTPUT_EXPOSURE_CEU_PER_WEEK",
      verdict,
      frozenDefinitionJson,
      T0.toISOString(),
    );
  }
  appendArtifactApplication(db, {
    artifactApplicationId: applicationId,
    artifactRevisionId: artifactId,
    observedRecommendationRevisionId: revisionId,
    authorizationId: `hre-authorization-${suffix}`,
    applicationSource: "USER_ATTESTED",
    baseHash: `hre-base-${suffix}`,
    postHash: `hre-post-${suffix}`,
    result: "APPLIED",
    rollbackState: "AVAILABLE",
    appliedAt: T0.toISOString(),
    createdAt: T0.toISOString(),
  });
  return applicationId;
}

describe("ESF2 effect service", () => {
  it("reopens a legacy effective verdict without a versioned cycle and preserves W4 evidence", () => {
    rec("rec-legacy-improved");
    db.prepare("UPDATE recommendations SET state='MEASURED_EFFECTIVE' WHERE rec_id=?").run(
      "rec-legacy-improved",
    );
    db.prepare(`INSERT INTO recommendation_effects
      (rec_id,measured_at,before_from,before_to,after_from,after_to,verdict)
      VALUES (?, ?, ?, ?, ?, ?, 'EFFECTIVE')`).run(
      "rec-legacy-improved",
      T0.toISOString(),
      T0.toISOString(),
      T0.toISOString(),
      T0.toISOString(),
      T0.toISOString(),
    );
    expect(reopenRecommendation("rec-legacy-improved", "reopen-legacy").data).toEqual({ ok: true });
    expect(
      db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get("rec-legacy-improved"),
    ).toEqual({ state: "PROPOSED" });
    expect(
      db
        .prepare("SELECT verdict FROM recommendation_effects WHERE rec_id=?")
        .get("rec-legacy-improved"),
    ).toEqual({ verdict: "EFFECTIVE" });
  });

  it("undoes an adoption, stops its open cycle, preserves evidence, and permits a new decision", () => {
    rec("rec-undo");
    const first = trackCompletedChange(
      db,
      { rec_id: "rec-undo", idempotency_key: "first", completed_change: true },
      T0,
    );
    if (!first.supported) throw new Error("expected tracked cycle");
    expect(() => reopenRecommendation("rec-undo", "bad-reopen")).toThrow(/Only an improved/);
    expect(undoAdoptRecommendation("rec-undo", "undo-1", T0.getTime() + 1000).data).toEqual({
      ok: true,
    });
    expect(undoAdoptRecommendation("rec-undo", "undo-1", T0.getTime() + 1000).data).toEqual({
      ok: true,
    });
    expect(() => undoAdoptRecommendation("rec-undo", "undo-2")).toThrow(/Only an adopted/);
    expect(() => reopenRecommendation("rec-undo", "undo-1")).toThrow(/Idempotency key/);
    expect(
      db.prepare("SELECT state,adopted_at FROM recommendations WHERE rec_id='rec-undo'").get(),
    ).toEqual({ state: "PROPOSED", adopted_at: null });
    expect(effectEngineForDb(db).getCycle(first.cycle.cycleId)?.state).toBe("STOPPED");
    const next = trackCompletedChange(
      db,
      { rec_id: "rec-undo", idempotency_key: "second", completed_change: true },
      new Date(T0.getTime() + 2000),
    );
    expect(next).toMatchObject({ supported: true, replayed: false });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM effect_cycles WHERE rec_id='rec-undo'").get(),
    ).toEqual({ n: 2 });
  });

  it.each([
    [60, "IMPROVED", "MEASURED_EFFECTIVE"],
    [150, "WORSENED", "PROPOSED"],
    [100, "UNCHANGED", "PROPOSED"],
  ] as const)(
    "persists %s-token verdict as %s and retains its cycle",
    (tokens, direction, state) => {
      rec("rec-verdict");
      const first = trackCompletedChange(
        db,
        { rec_id: "rec-verdict", idempotency_key: "first", completed_change: true },
        T0,
      );
      if (!first.supported) throw new Error("expected tracked cycle");
      db.prepare(`INSERT INTO context_inventory_history
        (workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at)
        VALUES ('ws-alpha','CLAUDE_MD','CLAUDE.md','changed',?,'chars4-v1',?)`).run(
        tokens,
        new Date(T0.getTime() + 7 * 86_400_000).toISOString(),
      );
      const engine = effectEngineForDb(db);
      expect(engine.runPass(new Date(first.cycle.scheduledObservationTo)).finalized).toBe(1);
      expect(engine.getCycle(first.cycle.cycleId)?.targetDirection).toBe(direction);
      expect(
        db.prepare("SELECT state FROM recommendations WHERE rec_id='rec-verdict'").get(),
      ).toEqual({ state });
      if (direction === "IMPROVED") {
        expect(reopenRecommendation("rec-verdict", "reopen-1").data).toEqual({ ok: true });
        expect(reopenRecommendation("rec-verdict", "reopen-1").data).toEqual({ ok: true });
        expect(
          db.prepare("SELECT state FROM recommendations WHERE rec_id='rec-verdict'").get(),
        ).toEqual({ state: "PROPOSED" });
      } else {
        expect(() => reopenRecommendation("rec-verdict", "reopen-1")).toThrow(/Only an improved/);
      }
      expect(
        adoptRecommendation("rec-verdict", T0.getTime() + 16 * 86_400_000, {
          completedChange: true,
        }).data,
      ).toEqual({ ok: true });
      expect(
        db.prepare("SELECT state FROM recommendations WHERE rec_id='rec-verdict'").get(),
      ).toEqual({ state: "ADOPTED" });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM effect_cycles WHERE rec_id='rec-verdict'").get(),
      ).toEqual({ n: 2 });
    },
  );
  it("tracks native D7 recommendations at workspace scope without inferring source or tool", () => {
    seedValidatedRecommendation(db, {
      recId: "rec-d7",
      templateId: "D7_RETRY_LOOP",
      scope: "ws-alpha",
      createdAt: T0.toISOString(),
    });
    expect(capabilityForRecommendation(db, "rec-d7")).toEqual({ mode: "TRACKABLE", reason: null });
    const tracked = trackCompletedChange(
      db,
      {
        rec_id: "rec-d7",
        idempotency_key: "d7-workspace",
        completed_change: true,
      },
      T0,
    );
    if (!tracked.supported) throw new Error("D7 tracking unavailable");
    expect(tracked.cycle.scope).toEqual({ workspaceId: "ws-alpha" });
    expect(tracked.cycle.targetDefinition.metricId).toBe("d7-loop-flagged-turn-share");
    expect(tracked.cycle.scheduledObservationTo).toBe("2026-01-24T00:00:00.000Z");
    expect(listEffectEvidence(db, "ws-alpha", "rec-d7").cycles[0]).toEqual(tracked.cycle);
    expect(() =>
      trackCompletedChange(
        db,
        {
          rec_id: "rec-d7",
          idempotency_key: "d7-injected",
          completed_change: true,
          scope: { tool: "b".repeat(64) },
        },
        T0,
      ),
    ).toThrow(/Unknown request field/);
  });

  it("fails closed when a persisted recommendation drifts after tracking", () => {
    rec("rec-retry");
    const request = { rec_id: "rec-retry", idempotency_key: "retry", completed_change: true };
    const first = trackCompletedChange(db, request, T0);
    db.prepare(
      "UPDATE recommendations SET evidence_json='{}', detector_id='DX', state='DISMISSED' WHERE rec_id='rec-retry'",
    ).run();
    expect(first).toMatchObject({ supported: true, replayed: false });
    expect(() => trackCompletedChange(db, request, new Date(T0.getTime() + 1000))).toThrow(
      /contract is not trusted/,
    );
    expect(() => trackCompletedChange(db, { ...request, concurrent_change: true }, T0)).toThrow(
      /contract is not trusted/,
    );
    expect(listEffectEvidence(db, "ws-alpha", "rec-retry").cycles).toEqual([]);
    if (!first.supported) throw new Error("missing supported cycle");
    expect(() =>
      mutateEffectCycle(
        db,
        "stop",
        { cycle_id: first.cycle.cycleId, idempotency_key: "tampered-stop" },
        T0,
      ),
    ).toThrow(/contract is not trusted/);
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id='rec-retry'").get()).toEqual({
      state: "DISMISSED",
    });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id='rec-retry'").all()).toHaveLength(
      1,
    );
  });

  it("makes existing cycle mutations read-only when the writer gate is disabled", () => {
    rec("rec-disabled");
    const tracked = trackCompletedChange(
      db,
      { rec_id: "rec-disabled", idempotency_key: "track", completed_change: true },
      T0,
    );
    if (!tracked.supported) throw new Error("missing supported cycle");
    const before = db.prepare("SELECT * FROM effect_cycles").all();
    gate.enabled = false;
    for (const action of ["stop", "close", "rollback", "attest-rollback"]) {
      expect(() =>
        mutateEffectCycle(
          db,
          action,
          { cycle_id: tracked.cycle.cycleId, idempotency_key: action, actual_time_known: false },
          T0,
        ),
      ).toThrow(/disabled/);
    }
    expect(db.prepare("SELECT * FROM effect_cycles").all()).toEqual(before);
    expect(listEffectEvidence(db, null, "rec-disabled").writer_enabled).toBe(false);
  });

  it("uses a stable D1 source identity across recommendation IDs and adopts once", () => {
    rec("rec-a", "/project/shared.md");
    rec("rec-b", "/project/shared.md");
    expect(opaqueD1SourceIdentity(db, "rec-a")).toBe(opaqueD1SourceIdentity(db, "rec-b"));
    const first = trackCompletedChange(
      db,
      { rec_id: "rec-a", idempotency_key: "a", completed_change: true },
      T0,
    );
    const replay = trackCompletedChange(
      db,
      { rec_id: "rec-a", idempotency_key: "a", completed_change: true },
      new Date(T0.getTime() + 1),
    );
    expect(first).toMatchObject({ supported: true, replayed: false });
    expect(replay).toMatchObject({ supported: true, replayed: true });
    expect(replay.supported && first.supported && replay.cycle.appliedAt).toBe(
      first.supported && first.cycle.appliedAt,
    );
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id='rec-a'").get()).toEqual({
      state: "ADOPTED",
    });
  });

  it("finalizes without attributing a replacement D1 source to the frozen cycle", () => {
    rec("rec-drift");
    const before = opaqueD1SourceIdentity(db, "rec-drift");
    const tracked = trackCompletedChange(
      db,
      { rec_id: "rec-drift", idempotency_key: "drift", completed_change: true },
      T0,
    );
    if (!tracked.supported) throw new Error("missing supported cycle");
    expect(tracked.cycle.baselineEvidence.value).toBe(100);
    db.prepare(`INSERT INTO context_inventory_history
      (workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at)
      VALUES ('ws-alpha','MEMORY','MEMORY.md','replacement',1,'chars4-v1',?)`).run(
      new Date(T0.getTime() + 7 * 86_400_000).toISOString(),
    );
    db.prepare("UPDATE recommendations SET evidence_json=? WHERE rec_id=?").run(
      d1Payload("MEMORY"),
      "rec-drift",
    );
    expect(opaqueD1SourceIdentity(db, "rec-drift")).not.toBe(before);
    expect(capabilityForRecommendation(db, "rec-drift")).toEqual({
      mode: "TRACKABLE",
      reason: null,
    });
    const engine = effectEngineForDb(db);
    expect(engine.runPass(new Date(tracked.cycle.scheduledObservationTo)).finalized).toBe(1);
    const finalized = engine.getCycle(tracked.cycle.cycleId);
    expect(finalized).toMatchObject({
      state: "FINALIZED",
      targetDirection: "INSUFFICIENT_DATA",
      baselineEvidence: { value: 100 },
      finalEvidence: {
        before: { value: 100 },
        after: { value: null, excluded: { SOURCE_UNRESOLVED: 1 } },
      },
    });
    expect(finalized?.scope.sourceIdentity).toBe(before);
    expect(JSON.stringify(finalized)).not.toContain("/changed.md");
  });

  it("joins D1 history rows that store the probe's absolute path (review 6 R6-07)", () => {
    seedValidatedRecommendation(db, {
      recId: "rec-abs",
      scope: "ws-alpha",
      createdAt: T0.toISOString(),
      facts: {
        component: "CLAUDE_MD",
        source_tokens: 2_000,
        source_target: 1_000,
        delta_context_tokens: 1_000,
        turns_per_week: 10,
      },
    });
    const history = db.prepare(`INSERT INTO context_inventory_history
      (workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at)
      VALUES ('ws-alpha','CLAUDE_MD','/repo/alpha/CLAUDE.md',?,?,'chars4-v1',?)`);
    history.run("before", 2_000, new Date(T0.getTime() - 86_400_000).toISOString());
    const identity = opaqueD1SourceIdentity(db, "rec-abs");
    const tracked = trackCompletedChange(
      db,
      { rec_id: "rec-abs", idempotency_key: "abs", completed_change: true },
      T0,
    );
    if (!tracked.supported) throw new Error("missing supported cycle");
    expect(tracked.cycle.baselineEvidence).toMatchObject({ value: 2_000, excluded: {} });
    history.run("after", 1_200, new Date(T0.getTime() + 7 * 86_400_000).toISOString());
    const engine = effectEngineForDb(db);
    engine.runPass(new Date(tracked.cycle.scheduledObservationTo));
    const finalized = engine.getCycle(tracked.cycle.cycleId);
    expect(finalized?.finalEvidence?.after).toMatchObject({ value: 1_200, excluded: {} });
    // The persisted identity is unchanged, and the path never leaves the query.
    expect(finalized?.scope.sourceIdentity).toBe(identity);
    expect(JSON.stringify(finalized)).not.toContain("/repo/alpha");
  });

  it("rejects injected tracking fields and reports unsupported recommendations without writing", () => {
    rec("rec-injected");
    expect(() =>
      trackCompletedChange(
        db,
        {
          rec_id: "rec-injected",
          idempotency_key: "x",
          completed_change: true,
          applied_at: "forged",
        },
        T0,
      ),
    ).toThrow(EffectRequestError);
    db.prepare("UPDATE recommendations SET detector_id='DX' WHERE rec_id='rec-injected'").run();
    expect(() =>
      trackCompletedChange(
        db,
        { rec_id: "rec-injected", idempotency_key: "x", completed_change: true },
        T0,
      ),
    ).toThrow(/contract is not trusted/);
  });

  it("pages scoped legacy evidence by timestamp and rec ID without losing tied rows", () => {
    rec("rec-page-a", "/a.md");
    rec("rec-page-b", "/b.md");
    rec("rec-other", "/other.md", "ws-other");
    const at = T0.toISOString();
    for (const id of ["rec-page-a", "rec-page-b", "rec-other"])
      db.prepare(`INSERT INTO recommendation_effects (rec_id,measured_at,before_from,before_to,after_from,after_to,before_value,after_value,before_n,after_n,delta_pct,verdict)
        VALUES (?, ?, 'a','b','c','d',1,2,1,1,0,'INCONCLUSIVE')`).run(id, at);
    const one = listEffectEvidence(db, "ws-alpha", undefined, "1");
    const two = listEffectEvidence(
      db,
      "ws-alpha",
      undefined,
      "1",
      undefined,
      one.next_legacy_cursor ?? undefined,
    );
    expect(one.legacy[0]?.verdict).toBe("INCONCLUSIVE");
    expect([one.legacy[0]?.recId, two.legacy[0]?.recId].sort()).toEqual([
      "rec-page-a",
      "rec-page-b",
    ]);
    expect(() => listEffectEvidence(db, "ws-alpha", undefined, "1", "eyJub3BlIjp0cnVlfQ")).toThrow(
      EffectRequestError,
    );
  });

  it("creates an artifact-bound frozen cycle, releases its lock terminally, and exposes an inconclusive stopped result", () => {
    const applicationId = artifactApplication("hre-cycle-rec", "one");
    const tracked = trackArtifactBoundApplication(db, applicationId, T0);
    if (!tracked.supported) throw new Error("expected artifact-bound cycle");
    expect(tracked.cycle).toMatchObject({
      bridge: {
        bridgeKind: "ARTIFACT_BOUND",
        artifactApplicationId: applicationId,
        measurementMethodId: "hre-measurement-one",
      },
      scheduledObservationTo: "2026-01-17T00:00:00.000Z",
      cohort: {
        baselineCohortCode: "HRE_BASELINE",
        afterCohortCode: "HRE_AFTER",
        comparabilityCode: "SAME_SCOPE",
      },
    });
    expect(
      db
        .prepare("SELECT state FROM hre_intervention_locks WHERE cycle_id=?")
        .get(tracked.cycle.cycleId),
    ).toEqual({ state: "OPEN" });
    expect(
      trackArtifactBoundApplication(db, applicationId, new Date(T0.getTime() + 1)),
    ).toMatchObject({
      supported: true,
      replayed: true,
      cycle: { cycleId: tracked.cycle.cycleId },
    });
    effectEngineForDb(db).stop(tracked.cycle.cycleId, {
      idempotencyKey: "hre-stop",
      reason: "USER_STOPPED",
      at: new Date(T0.getTime() + 86_400_000).toISOString(),
    });
    expect(
      db
        .prepare("SELECT state FROM hre_intervention_locks WHERE cycle_id=?")
        .get(tracked.cycle.cycleId),
    ).toEqual({ state: "RELEASED" });
    expect(listArtifactBoundMeasuredResults(db)).toEqual([
      expect.objectContaining({ cycleId: tracked.cycle.cycleId, state: "INCONCLUSIVE" }),
    ]);
  });

  it("fails closed for manual methods and overlapping artifact-bound interventions", () => {
    const manual = artifactApplication("hre-manual-rec", "manual", "MANUAL");
    expect(trackArtifactBoundApplication(db, manual, T0)).toEqual({
      supported: false,
      state: "UNSUPPORTED",
      reason: "MEASUREMENT_UNAVAILABLE",
    });
    const first = artifactApplication("hre-overlap-one", "overlap-one");
    const firstTracked = trackArtifactBoundApplication(db, first, T0);
    if (!firstTracked.supported) throw new Error("expected first artifact-bound cycle");
    const second = artifactApplication("hre-overlap-two", "overlap-two");
    expect(trackArtifactBoundApplication(db, second, T0)).toEqual({
      supported: false,
      state: "UNAVAILABLE",
      reason: "OVERLAPPING_INTERVENTION",
    });
    expect(
      db
        .prepare("SELECT cycle_id FROM hre_effect_cycle_links WHERE artifact_application_id=?")
        .get(second),
    ).toBeUndefined();
    expect(effectEngineForDb(db).runPass(new Date(T0.getTime() + 7 * 86_400_000)).finalized).toBe(
      1,
    );
    expect(
      db
        .prepare("SELECT state FROM hre_intervention_locks WHERE cycle_id=?")
        .get(firstTracked.cycle.cycleId),
    ).toEqual({ state: "RELEASED" });
  });

  it("rejects incomplete persisted measurement definitions without creating a cycle or lock", () => {
    const applicationId = artifactApplication(
      "hre-malformed-definition",
      "malformed-definition",
      "AUTOMATIC",
      JSON.stringify({
        horizonDays: 7,
        baselineCohortCode: "HRE_BASELINE",
        afterCohortCode: "HRE_AFTER",
        comparabilityCode: "SAME_SCOPE",
      }),
    );
    expect(trackArtifactBoundApplication(db, applicationId, T0)).toEqual({
      supported: false,
      state: "UNAVAILABLE",
      reason: "INVALID_ARTIFACT_BINDING",
    });
    expect(db.prepare("SELECT cycle_id FROM hre_effect_cycle_links").all()).toEqual([]);
    expect(db.prepare("SELECT lock_id FROM hre_intervention_locks").all()).toEqual([]);
  });
});
