import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import { c2Detector } from "../../src/detector/detectors/c2_content_not_found.js";
import { d1Detector } from "../../src/detector/detectors/d1_ctx_always_loaded.js";
import { buildContext, runDetectors } from "../../src/detector/engine.js";
import { resetDatabase } from "../../src/query/settings-store.js";
import type { HistoricalSnapshotAllowlist } from "../../src/recommendations/capabilities.js";
import {
  acquireInterventionLock,
  appendArtifactApplication,
  appendArtifactRevision,
  appendEffectCycleLink,
  appendMeasurementMethod,
  appendNativeFinding,
  appendRecommendationLifecycleEvent,
  appendRecommendationRevision,
  materializeLegacyFinding,
  publishCompositionSnapshot,
  readEffectCycleBridge,
  readHistoricalHandlerSnapshot,
  readLegacyFinding,
  readRecommendationGraph,
  releaseInterventionLock,
  retireHistoricalHandler,
  storeHistoricalHandlerSnapshot,
} from "../../src/recommendations/storage.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-08T00:00:00.000Z");
const CTX = buildContext(NOW);
let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => db.close());

function produceV1(): string {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, '__global__', ?)`,
  ).run(GLOBAL_WORKSPACE_ID, CTX.fromIso);
  db.prepare(
    `INSERT INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES ('hre-d1', ?, ?, 'CLAUDE_MD', 'opaque-file-ref', 'opaque-hash', 5000, 'chars4-v1')`,
  ).run(GLOBAL_WORKSPACE_ID, CTX.fromIso);
  runDetectors(db, CTX, [d1Detector]);
  return (
    db.prepare("SELECT rec_id FROM recommendations WHERE detector_id='D1'").get() as {
      rec_id: string;
    }
  ).rec_id;
}

function produceV2(): string {
  db.exec(`
    INSERT INTO workspaces (workspace_id, project_slug, registered_at)
      VALUES ('ws-hre-c2', 'ws-hre-c2', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state,
       turn_count, cost_equiv_u, hygiene_flags)
      VALUES ('session-hre-c2', 'ws-hre-c2', 'opaque-path', '${CTX.fromIso}', '${CTX.toIso}',
              'RECONCILED', 1, 0, '[]');
    INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
       output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
       cost_equiv_u, cost_claim, provisional, parser_version)
      VALUES ('message-hre-c2', 'session-hre-c2', 'ws-hre-c2', '2026-01-02T00:00:00.000Z',
              'claude-sonnet', 0, 0, 0, 0, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test-v1');
    INSERT INTO tool_events
      (event_id, session_id, ts, tool_name, exit_class, tool_error_class,
       tool_error_classifier_version)
      VALUES ('event-hre-c2', 'session-hre-c2', '2026-01-02T00:00:00.000Z',
              'Read', 'ERROR', 'NOT_FOUND', 'tool-error-1');
    INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
      VALUES ('event-hre-c2', NULL, 'message-hre-c2', 0, 0);
  `);
  runDetectors(db, CTX, [c2Detector]);
  return (
    db.prepare("SELECT rec_id FROM recommendations WHERE detector_id='C2'").get() as {
      rec_id: string;
    }
  ).rec_id;
}

function seedSnapshot(total = 4): void {
  db.prepare(
    `INSERT INTO hre_composition_snapshots
      (snapshot_id, composition_version, registry_version, ranking_policy_version,
       price_version, window_from, window_to, created_at)
     VALUES ('snapshot-1', 1, 'registry-1', 'rank-1', 'price-1', ?, ?, ?)`,
  ).run(CTX.fromIso, CTX.toIso, CTX.toIso);
  db.prepare(
    `INSERT INTO hre_ceu_pools (composition_snapshot_id, ceu_pool_id, total_ceu_per_week)
     VALUES ('snapshot-1', 'pool-1', ?)`,
  ).run(total);
}

function appendRevision(
  revisionId: string,
  expectedActiveRevisionId: string | null,
  findingId: string,
  contribution = 4,
  ownsValue = true,
): void {
  appendRecommendationRevision(db, {
    recommendationId: "recommendation-1",
    recommendationRevisionId: revisionId,
    expectedActiveRevisionId,
    snapshotId: "snapshot-1",
    findingId,
    ceuPoolId: "pool-1",
    ownsValue,
    contributionCeuPerWeek: contribution,
    handlerFamily: "reduce-context",
    handlerVersion: "1",
    registryVersion: "registry-1",
    rankingPolicyVersion: "rank-1",
    expectedValue: 4,
    expectedValueUnit: "CEU_PER_WEEK",
    valueMethodId: "method-1",
    valueMethodVersion: "1",
    valueWindowFrom: CTX.fromIso,
    valueWindowTo: CTX.toIso,
    reasonCodes: ["CONTEXT_OVERSIZE"],
    createdAt: CTX.toIso,
  });
}

function insertLegacyCycle(recId: string, cycleId: string, cycleNo = 1): void {
  db.prepare(
    `INSERT INTO effect_cycles
     (cycle_id, rec_id, cycle_no, contract_version, query_definition_version, detector_id,
      metric_id, method_version, state, created_at, tracking_requested_at, applied_at,
      application_source, track_idempotency_key, scope_json, cohort_json,
      target_definition_json, guardrail_definitions_json, baseline_from, baseline_to,
      observation_from, scheduled_observation_to, baseline_evidence_json)
     VALUES (?, ?, ?, 'legacy', 'q1', 'D1', 'metric', 'm1', 'OPEN_SETTLING',
             ?, ?, ?, 'USER_ATTESTED', ?, '{}', '{}', '{}', '[]', ?, ?, ?, ?, '{}')`,
  ).run(
    cycleId,
    recId,
    cycleNo,
    CTX.toIso,
    CTX.toIso,
    CTX.toIso,
    `track-${cycleId}`,
    CTX.fromIso,
    CTX.toIso,
    CTX.toIso,
    "2026-01-15T00:00:00.000Z",
  );
}

function appendBoundRecords(suffix: string): void {
  appendArtifactRevision(db, {
    artifactRevisionId: `artifact-${suffix}`,
    recommendationRevisionId: "revision-1",
    artifactKind: "advice",
    artifactHash: `hash-${suffix}`,
    capabilityProfileVersion: "profile-1",
    validationStatus: "VALIDATED",
    rollbackAvailable: true,
    supersedesArtifactRevisionId: null,
    createdAt: CTX.toIso,
  });
  appendMeasurementMethod(db, {
    measurementMethodId: `measurement-${suffix}`,
    artifactRevisionId: `artifact-${suffix}`,
    methodVersion: "1",
    targetMetricCode: "TARGET_METRIC",
    verdict: "MANUAL",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "BASELINE_7D",
      afterCohortCode: "AFTER_7D",
      guardrailCodes: ["NO_QUALITY_REGRESSION"],
      comparabilityCode: "SAME_SCOPE",
    },
    createdAt: CTX.toIso,
  });
  appendArtifactApplication(db, {
    artifactApplicationId: `application-${suffix}`,
    artifactRevisionId: `artifact-${suffix}`,
    observedRecommendationRevisionId: "revision-1",
    authorizationId: `authorization-${suffix}`,
    applicationSource: "USER_ATTESTED",
    baseHash: `base-${suffix}`,
    postHash: `post-${suffix}`,
    result: "APPLIED",
    rollbackState: "AVAILABLE",
    appliedAt: CTX.toIso,
    createdAt: CTX.toIso,
  });
}

function appendBoundEffect(suffix: string): void {
  appendBoundRecords(suffix);
  appendEffectCycleLink(db, {
    cycleId: `cycle-${suffix}`,
    recommendationId: "recommendation-1",
    recommendationRevisionId: "revision-1",
    artifactRevisionId: `artifact-${suffix}`,
    artifactApplicationId: `application-${suffix}`,
    measurementMethodId: `measurement-${suffix}`,
    interventionLockKey: "workspace:alpha",
    createdAt: CTX.toIso,
  });
}

const handlerAllowlist: HistoricalSnapshotAllowlist = {
  handlerIdentities: new Set(["reduce-context@1"]),
  registryVersions: new Set(["registry-1"]),
  reasonCodes: new Set(["CONTEXT_OVERSIZE"]),
  aggregateRules: new Map([
    [
      "CEU_PER_WEEK",
      { kind: "NUMBER", minimum: 0, maximum: 1000, maximumDecimalPlaces: 2, nullable: false },
    ],
  ]),
  guardrailCodes: new Set(["NO_QUALITY_REGRESSION"]),
  maxReasonCodes: 4,
  maxAggregateEntries: 8,
  maxGuardrailResults: 8,
};

const handlerSnapshot = {
  schemaVersion: 1,
  handlerFamily: "reduce-context",
  handlerVersion: "1",
  registryVersion: "registry-1",
  reasonCodes: ["CONTEXT_OVERSIZE"],
  aggregateEvidence: [{ code: "CEU_PER_WEEK", value: 4 }],
  guardrailResults: [{ code: "NO_QUALITY_REGRESSION", passed: true }],
};

describe("HRE linked storage", () => {
  it("materializes real V1 and V2 producer rows through the trusted boundary", () => {
    const v1 = produceV1();
    const v2 = produceV2();

    expect(materializeLegacyFinding(db, v1)).toMatchObject({
      kind: "ADAPTED",
      finding: { contractVersion: 1, effectLinkState: "LEGACY_UNLINKED" },
    });
    expect(materializeLegacyFinding(db, v2)).toMatchObject({
      kind: "ADAPTED",
      finding: { contractVersion: 2, effectLinkState: "LEGACY_UNLINKED" },
    });
    expect(readLegacyFinding(db, `legacy-finding:${v2}`)).toMatchObject({
      sourceRecommendationId: v2,
      detectorId: "C2",
      reasonCodes: ["LEGACY_FINDING_ADAPTER"],
    });
    expect(JSON.stringify(db.prepare("SELECT * FROM hre_findings").all())).not.toContain(
      "evidence_json",
    );
  });

  it("persists native aggregate findings and rejects reconstructable anchors", () => {
    expect(
      appendNativeFinding(db, {
        findingId: "finding-native-1",
        detectorId: "C2",
        detectorContractVersion: 2,
        scopeHash: "scope-hash-1",
        windowFrom: CTX.fromIso,
        windowTo: CTX.toIso,
        findingCount: 2,
        affectedSessions: 1,
        exclusiveCeu: 4,
        confidence: 0.8,
        safeAnchorIds: ["sid_opaque"],
        provenanceCode: "DETERMINISTIC_RULE",
        lifecycle: "OPEN",
        observedAt: CTX.toIso,
        reasonCode: "CONTENT_NOT_FOUND",
        createdAt: CTX.toIso,
      }),
    ).toMatchObject({ sourceKind: "NATIVE", findingCount: 2 });
    expect(() =>
      appendNativeFinding(db, {
        findingId: "finding-native-2",
        detectorId: "C2",
        detectorContractVersion: 2,
        scopeHash: "scope-hash-2",
        windowFrom: CTX.fromIso,
        windowTo: CTX.toIso,
        findingCount: 1,
        affectedSessions: 1,
        exclusiveCeu: null,
        confidence: null,
        safeAnchorIds: ["C:/private/raw path"],
        provenanceCode: "DETERMINISTIC_RULE",
        lifecycle: "OPEN",
        observedAt: CTX.toIso,
        reasonCode: "CONTENT_NOT_FOUND",
        createdAt: CTX.toIso,
      }),
    ).toThrow(/opaque/);
  });

  it("returns persisted legacy state and rejects an identity collision", () => {
    const recId = produceV1();
    const first = materializeLegacyFinding(db, recId);
    expect(materializeLegacyFinding(db, recId)).toEqual(first);
    db.prepare("DELETE FROM hre_findings WHERE legacy_rec_id = ?").run(recId);
    db.prepare(
      `INSERT INTO hre_findings
       (finding_id, source_kind, legacy_rec_id, detector_id, detector_contract_version,
        lifecycle, observed_at, reason_code, created_at)
       VALUES (?, 'LEGACY', ?, 'C2', 2, 'OPEN', ?, 'LEGACY_FINDING_ADAPTER', ?)`,
    ).run(`legacy-finding:${recId}`, recId, CTX.toIso, CTX.toIso);
    expect(() => materializeLegacyFinding(db, recId)).toThrow(/collision/);
  });

  it("fails closed for health/zero, decisions, unverified rows, and corrupted contracts", () => {
    const verified = produceV1();
    expect(materializeLegacyFinding(db, verified, "HEALTH")).toEqual({
      kind: "EXCLUDED",
      reason: "NON_FINDING",
    });
    expect(materializeLegacyFinding(db, verified, "ZERO")).toEqual({
      kind: "EXCLUDED",
      reason: "NON_FINDING",
    });
    db.prepare(
      `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, lever, modeled_formula_json, evidence_json,
        target_metric, state, created_at, contract_version, template_id, contract_status)
       VALUES ('riq-decision', 'CLAUDE_ANALYZED', NULL, 'EFFICIENCY', 'opaque', '{}', '{}',
               'metric', 'PROPOSED', ?, 1, 'RIQ_DECISION_V1', 'DECISION_V1_VALIDATED')`,
    ).run(CTX.toIso);
    expect(materializeLegacyFinding(db, "riq-decision")).toEqual({
      kind: "EXCLUDED",
      reason: "NON_DETECTOR_DECISION",
    });
    db.prepare(
      `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, lever, modeled_formula_json, evidence_json,
        target_metric, state, created_at)
       VALUES ('legacy-unverified', 'RULE', 'D1', 'CONTEXT', 'opaque', '{}', '{}',
               'metric', 'PROPOSED', ?)`,
    ).run(CTX.toIso);
    expect(materializeLegacyFinding(db, "legacy-unverified")).toEqual({
      kind: "EXCLUDED",
      reason: "UNVERIFIED_CONTRACT",
    });
    db.prepare("UPDATE recommendations SET evidence_json='{}' WHERE rec_id=?").run(verified);
    expect(materializeLegacyFinding(db, verified)).toEqual({
      kind: "EXCLUDED",
      reason: "UNVERIFIED_CONTRACT",
    });
  });

  it("enforces immutable revisions, active-pointer CAS, and CEU conservation", () => {
    const recId = produceV1();
    const finding = materializeLegacyFinding(db, recId);
    if (finding.kind !== "ADAPTED") throw new Error("expected adapted finding");
    seedSnapshot();
    appendRevision("revision-1", null, finding.finding.id);
    expect(() =>
      db.prepare("UPDATE hre_recommendation_revisions SET expected_value=5").run(),
    ).toThrow(/immutable/);
    expect(() => appendRevision("revision-conflict", null, finding.finding.id)).toThrow();
    expect(
      db.prepare("SELECT recommendation_revision_id FROM hre_recommendation_revisions").all(),
    ).toHaveLength(1);
    expect(() =>
      appendRecommendationRevision(db, {
        recommendationId: "recommendation-snapshot-mismatch",
        recommendationRevisionId: "revision-snapshot-mismatch",
        expectedActiveRevisionId: null,
        snapshotId: "snapshot-1",
        findingId: finding.finding.id,
        ceuPoolId: "pool-1",
        ownsValue: false,
        contributionCeuPerWeek: 0,
        handlerFamily: "reduce-context",
        handlerVersion: "1",
        registryVersion: "wrong-registry",
        rankingPolicyVersion: "rank-1",
        expectedValue: 0,
        expectedValueUnit: "CEU_PER_WEEK",
        valueMethodId: "method-mismatch",
        valueMethodVersion: "1",
        valueWindowFrom: CTX.fromIso,
        valueWindowTo: CTX.toIso,
        reasonCodes: ["CONTEXT_OVERSIZE"],
        createdAt: CTX.toIso,
      }),
    ).toThrow(/snapshot binding/);
    appendRevision("revision-2", "revision-1", finding.finding.id, 0, false);
    expect(() =>
      appendRevision("revision-stale", "revision-1", finding.finding.id, 0, false),
    ).toThrow(/active revision conflict/);
    expect(
      db.prepare("SELECT recommendation_revision_id FROM hre_recommendation_revisions").all(),
    ).toHaveLength(2);
    expect(() => publishCompositionSnapshot(db, "snapshot-1")).not.toThrow();
    expect(() => db.prepare("UPDATE hre_ceu_pools SET total_ceu_per_week=5").run()).toThrow(
      /published/,
    );
    expect(readRecommendationGraph(db, "recommendation-1")).toMatchObject({
      activeRevisionId: "revision-2",
      compositionSnapshotId: "snapshot-1",
      state: "PUBLISHED",
      findingIds: [finding.finding.id],
    });
    expect(() =>
      db.prepare("UPDATE hre_composition_snapshots SET price_version='price-2'").run(),
    ).toThrow(/immutable/);
  });

  it("rejects cross-snapshot finding links and invalid lifecycle transitions", () => {
    const recId = produceV1();
    const finding = materializeLegacyFinding(db, recId);
    if (finding.kind !== "ADAPTED") throw new Error("expected adapted finding");
    seedSnapshot();
    appendRevision("revision-1", null, finding.finding.id);
    db.prepare(
      `INSERT INTO hre_composition_snapshots
       (snapshot_id, composition_version, registry_version, ranking_policy_version,
        price_version, window_from, window_to, created_at)
       VALUES ('snapshot-2', 1, 'registry-1', 'rank-1', 'price-1', ?, ?, ?)`,
    ).run(CTX.fromIso, CTX.toIso, CTX.toIso);
    db.prepare(
      `INSERT INTO hre_ceu_pools (composition_snapshot_id, ceu_pool_id, total_ceu_per_week)
       VALUES ('snapshot-2', 'pool-2', 4)`,
    ).run();
    appendNativeFinding(db, {
      findingId: "finding-native-cross-snapshot",
      detectorId: "C2",
      detectorContractVersion: 2,
      scopeHash: "scope-cross-snapshot",
      windowFrom: CTX.fromIso,
      windowTo: CTX.toIso,
      findingCount: 1,
      affectedSessions: 1,
      exclusiveCeu: 4,
      confidence: 0.8,
      safeAnchorIds: [],
      provenanceCode: "DETERMINISTIC_RULE",
      lifecycle: "OPEN",
      observedAt: CTX.toIso,
      reasonCode: "CONTENT_NOT_FOUND",
      createdAt: CTX.toIso,
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO hre_recommendation_findings
         (recommendation_revision_id, finding_id, composition_snapshot_id, ceu_pool_id,
          evidence_role, contribution_ceu_per_week, owns_value)
         VALUES ('revision-1', ?, 'snapshot-2', 'pool-2', 'SUPPORTING', 4, 1)`,
        )
        .run("finding-native-cross-snapshot"),
    ).toThrow(/cross-snapshot/);
    expect(
      appendRecommendationLifecycleEvent(db, {
        recommendationId: "recommendation-1",
        recommendationRevisionId: "revision-1",
        fromState: null,
        toState: "ACTIONABLE",
        reasonCode: "PRIMARY_ADMISSION",
        createdAt: CTX.toIso,
      }),
    ).toBe(1);
    expect(() =>
      appendRecommendationLifecycleEvent(db, {
        recommendationId: "recommendation-1",
        recommendationRevisionId: "revision-1",
        fromState: "ACTIONABLE",
        toState: "MEASURED_IMPROVED",
        reasonCode: "INVALID_SKIP",
        createdAt: CTX.toIso,
      }),
    ).toThrow(/transition/);
  });

  it("rejects empty or unconserved snapshot publication", () => {
    db.prepare(
      `INSERT INTO hre_composition_snapshots
       (snapshot_id, composition_version, registry_version, ranking_policy_version,
        price_version, window_from, window_to, created_at)
       VALUES ('empty', 1, 'r', 'p', 'price', ?, ?, ?)`,
    ).run(CTX.fromIso, CTX.toIso, CTX.toIso);
    expect(() => publishCompositionSnapshot(db, "empty")).toThrow(/publication/);

    const recId = produceV1();
    const finding = materializeLegacyFinding(db, recId);
    if (finding.kind !== "ADAPTED") throw new Error("expected adapted finding");
    seedSnapshot(5);
    appendRevision("revision-1", null, finding.finding.id, 4);
    expect(() => publishCompositionSnapshot(db, "snapshot-1")).toThrow(/publication/);
  });

  it("validates historical handler snapshots on both write and read", () => {
    expect(() =>
      storeHistoricalHandlerSnapshot(
        db,
        { ...handlerSnapshot, rawCommand: "private" },
        handlerAllowlist,
      ),
    ).toThrow(/invalid historical/);
    storeHistoricalHandlerSnapshot(db, handlerSnapshot, handlerAllowlist, CTX.toIso);
    expect(
      readHistoricalHandlerSnapshot(
        db,
        { handlerFamily: "reduce-context", handlerVersion: "1", registryVersion: "registry-1" },
        handlerAllowlist,
      ),
    ).toEqual(handlerSnapshot);
    expect(
      readHistoricalHandlerSnapshot(
        db,
        { handlerFamily: "reduce-context", handlerVersion: "1", registryVersion: "registry-1" },
        { ...handlerAllowlist, reasonCodes: new Set() },
      ),
    ).toBeNull();
    db.prepare(
      `INSERT INTO hre_handler_history
        (handler_family, handler_version, registry_version, snapshot_schema_version,
         snapshot_json, retired_at)
       VALUES ('other-family', '1', 'registry-1', 1, ?, NULL)`,
    ).run(JSON.stringify(handlerSnapshot));
    expect(
      readHistoricalHandlerSnapshot(
        db,
        { handlerFamily: "other-family", handlerVersion: "1", registryVersion: "registry-1" },
        handlerAllowlist,
      ),
    ).toBeNull();
  });

  it("keeps retired handler history readable while blocking new revisions", () => {
    const recId = produceV1();
    const finding = materializeLegacyFinding(db, recId);
    if (finding.kind !== "ADAPTED") throw new Error("expected adapted finding");
    seedSnapshot();
    storeHistoricalHandlerSnapshot(db, handlerSnapshot, handlerAllowlist);
    retireHistoricalHandler(db, handlerSnapshot, "2026-01-09T00:00:00.000Z", "CAPABILITY_REMOVED");
    expect(
      readHistoricalHandlerSnapshot(
        db,
        { handlerFamily: "reduce-context", handlerVersion: "1", registryVersion: "registry-1" },
        handlerAllowlist,
      ),
    ).toEqual(handlerSnapshot);
    expect(() => appendRevision("revision-retired", null, finding.finding.id)).toThrow(/retired/);
  });

  it("reads old effect cycles as explicitly unlinked", () => {
    const recId = produceV1();
    insertLegacyCycle(recId, "legacy-cycle");
    expect(readEffectCycleBridge(db, "legacy-cycle")).toEqual({
      bridgeKind: "LEGACY_UNLINKED",
      cycleId: "legacy-cycle",
    });
  });

  it("binds validated applications to effects and rejects conflicting intervention locks", () => {
    const recId = produceV1();
    const finding = materializeLegacyFinding(db, recId);
    if (finding.kind !== "ADAPTED") throw new Error("expected adapted finding");
    seedSnapshot();
    appendRevision("revision-1", null, finding.finding.id);
    appendRecommendationRevision(db, {
      recommendationId: "recommendation-other",
      recommendationRevisionId: "revision-other",
      expectedActiveRevisionId: null,
      snapshotId: "snapshot-1",
      findingId: finding.finding.id,
      ceuPoolId: "pool-1",
      ownsValue: false,
      contributionCeuPerWeek: 0,
      handlerFamily: "reduce-context",
      handlerVersion: "1",
      registryVersion: "registry-1",
      rankingPolicyVersion: "rank-1",
      expectedValue: 0,
      expectedValueUnit: "CEU_PER_WEEK",
      valueMethodId: "method-other",
      valueMethodVersion: "1",
      valueWindowFrom: CTX.fromIso,
      valueWindowTo: CTX.toIso,
      reasonCodes: ["CONTEXT_OVERSIZE"],
      createdAt: CTX.toIso,
    });
    appendArtifactRevision(db, {
      artifactRevisionId: "artifact-other",
      recommendationRevisionId: "revision-other",
      artifactKind: "advice",
      artifactHash: "hash-other",
      capabilityProfileVersion: "profile-1",
      validationStatus: "VALIDATED",
      rollbackAvailable: true,
      supersedesArtifactRevisionId: null,
      createdAt: CTX.toIso,
    });
    expect(() =>
      appendArtifactRevision(db, {
        artifactRevisionId: "artifact-cross-lineage",
        recommendationRevisionId: "revision-1",
        artifactKind: "advice",
        artifactHash: "hash-cross-lineage",
        capabilityProfileVersion: "profile-1",
        validationStatus: "VALIDATED",
        rollbackAvailable: true,
        supersedesArtifactRevisionId: "artifact-other",
        createdAt: CTX.toIso,
      }),
    ).toThrow(/artifact supersession/);
    insertLegacyCycle(recId, "cycle-1");
    db.prepare("UPDATE effect_cycles SET state='STOPPED' WHERE cycle_id='cycle-1'").run();
    insertLegacyCycle(recId, "cycle-2", 2);
    const otherRecId = produceV2();
    insertLegacyCycle(otherRecId, "cycle-3", 1);
    appendBoundEffect("1");
    appendBoundEffect("2");
    expect(() =>
      db.prepare("UPDATE effect_cycles SET rec_id=? WHERE cycle_id='cycle-1'").run(otherRecId),
    ).toThrow(/provenance is immutable/);
    appendBoundRecords("3");
    expect(() =>
      appendEffectCycleLink(db, {
        cycleId: "cycle-3",
        recommendationId: "recommendation-1",
        recommendationRevisionId: "revision-1",
        artifactRevisionId: "artifact-3",
        artifactApplicationId: "application-3",
        measurementMethodId: "measurement-3",
        interventionLockKey: "workspace:alpha",
        createdAt: CTX.toIso,
      }),
    ).toThrow(/effect binding/);
    expect(() =>
      appendMeasurementMethod(db, {
        measurementMethodId: "measurement-unsafe",
        artifactRevisionId: "artifact-1",
        methodVersion: "1",
        targetMetricCode: "TARGET_METRIC",
        verdict: "MANUAL",
        definition: {
          targetDirection: "REDUCE",
          horizonDays: 7,
          baselineCohortCode: "BASELINE_7D",
          afterCohortCode: "AFTER_7D",
          guardrailCodes: ["NO_QUALITY_REGRESSION"],
          comparabilityCode: "SAME_SCOPE",
          rawCommand: "private command",
        } as never,
        createdAt: CTX.toIso,
      }),
    ).toThrow(/closed privacy-safe shape/);
    acquireInterventionLock(db, {
      lockId: "lock-1",
      interventionLockKey: "workspace:alpha",
      cycleId: "cycle-1",
      artifactApplicationId: "application-1",
      confoundedOverride: false,
      conflictsWithLockId: null,
      conflictReasonCode: null,
      createdAt: CTX.toIso,
    });
    expect(() =>
      acquireInterventionLock(db, {
        lockId: "lock-2",
        interventionLockKey: "workspace:alpha",
        cycleId: "cycle-2",
        artifactApplicationId: "application-2",
        confoundedOverride: false,
        conflictsWithLockId: null,
        conflictReasonCode: null,
        createdAt: CTX.toIso,
      }),
    ).toThrow(/conflict/);
    acquireInterventionLock(db, {
      lockId: "lock-2",
      interventionLockKey: "workspace:alpha",
      cycleId: "cycle-2",
      artifactApplicationId: "application-2",
      confoundedOverride: true,
      conflictsWithLockId: "lock-1",
      conflictReasonCode: "OPERATOR_CONFOUNDED_OVERRIDE",
      createdAt: CTX.toIso,
    });
    expect(() =>
      db
        .prepare("UPDATE hre_intervention_locks SET cycle_id='cycle-2' WHERE lock_id='lock-1'")
        .run(),
    ).toThrow(/transition/);
    releaseInterventionLock(db, "lock-1", "2026-01-09T00:00:00.000Z");
    expect(() => releaseInterventionLock(db, "lock-1", CTX.toIso)).toThrow(/not found/);
    releaseInterventionLock(db, "lock-2", "2026-01-09T00:00:00.000Z");
    db.prepare("UPDATE effect_cycles SET state='STOPPED' WHERE cycle_id='cycle-2'").run();
    insertLegacyCycle(recId, "cycle-4", 3);
    appendBoundEffect("4");
    acquireInterventionLock(db, {
      lockId: "lock-4",
      interventionLockKey: "workspace:alpha",
      cycleId: "cycle-4",
      artifactApplicationId: "application-4",
      confoundedOverride: false,
      conflictsWithLockId: null,
      conflictReasonCode: null,
      createdAt: "2026-01-10T00:00:00.000Z",
    });
    expect(readEffectCycleBridge(db, "cycle-1")).toMatchObject({
      bridgeKind: "ARTIFACT_BOUND",
      artifactApplicationId: "application-1",
      interventionLockKey: "workspace:alpha",
    });
  });

  it("privacy reset removes the complete HRE graph in FK-safe order", () => {
    const recId = produceV1();
    const finding = materializeLegacyFinding(db, recId);
    if (finding.kind !== "ADAPTED") throw new Error("expected adapted finding");
    seedSnapshot();
    appendRevision("revision-1", null, finding.finding.id);
    publishCompositionSnapshot(db, "snapshot-1");
    storeHistoricalHandlerSnapshot(
      db,
      handlerSnapshot,
      handlerAllowlist,
      "2026-01-09T00:00:00.000Z",
    );
    expect(() => resetDatabase(db)).not.toThrow();
    for (const table of [
      "hre_recommendation_revisions",
      "hre_recommendations",
      "hre_findings",
      "hre_composition_snapshots",
      "hre_handler_retirements",
      "hre_handler_history",
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });
});
