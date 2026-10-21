import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CapabilityProfile,
  HandlerRegistration,
} from "../../src/recommendations/capabilities.js";
import { type EngineContext, composeRecommendation } from "../../src/recommendations/engine.js";
import {
  H5_REGISTRY_VERSION,
  createH5PermissionFrictionHandler,
} from "../../src/recommendations/handlers/h5-permission-friction/index.js";
import { persistComposedRecommendation } from "../../src/recommendations/persistence.js";
import type { HandlerImplementation } from "../../src/recommendations/registry.js";
import {
  appendCompositionSnapshot,
  appendNativeFinding,
  publishCompositionSnapshot,
  readRecommendationGraph,
} from "../../src/recommendations/storage.js";
import {
  H5_FINDING_ID,
  h5Evidence,
  h5Finding,
} from "../fixtures/recommendations/handlers/h5-permission-friction/fixtures.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = "2026-09-16T00:00:00.000Z";
const FROM = "2026-09-09T00:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const artifactId = (value: string) => `artifact:${hash(value)}`;
const measurementId = (value: string) => `measurement:${hash(value)}`;
let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
});
afterEach(() => db.close());

const profile: CapabilityProfile = {
  id: "profile",
  version: "p1",
  claudeCodeVersion: "1",
  platform: "WINDOWS",
  workspaceScope: "w",
  createdAt: FROM,
  expiresAt: "2026-09-17T00:00:00.000Z",
  observations: [
    {
      capability: "synthetic",
      verdict: "SUPPORTED",
      source: "VERSION_GATE",
      canaryVersion: null,
      observedAt: NOW,
    },
  ],
};
const registration: HandlerRegistration = {
  family: "synthetic",
  version: "1",
  registryVersion: "r1",
  status: "ACTIVE",
  acceptedEvidence: [{ detectorId: "detector", schemaVersion: 1 }],
  artifactKinds: ["advice"],
  capabilityRequirements: [
    { capability: "synthetic", allowedSources: ["VERSION_GATE"], allowedCanaryVersions: [] },
  ],
  correlationKeyVersion: "1",
  priorityClass: "VALUE",
  generatorVersion: "g1",
  validatorVersions: ["v1"],
  measurementFactoryVersion: "m1",
  applicabilityEstimatorVersion: "a1",
  supersededBy: null,
  historicalDecoderVersion: "1",
};
const handler: HandlerImplementation = {
  registration,
  compose: () => ({
    artifacts: [
      {
        artifactRevisionId: artifactId("a"),
        kind: "advice",
        validationStatus: "VALIDATED",
        validated: true,
        artifactHash: hash("content"),
        scopeHash: hash("scope"),
        targetHash: hash("target"),
        rollbackArtifactRevisionId: artifactId("rollback"),
        rollbackHash: hash("rollback"),
        supersedesArtifactRevisionId: null,
        createdAt: NOW,
        applyMechanismCode: "SYNTHETIC_APPLY",
      },
    ],
    measurement: {
      measurementMethodId: measurementId("m"),
      artifactRevisionId: artifactId("a"),
      methodVersion: "1",
      targetMetricCode: "SAVINGS_USD",
      verdict: "AUTOMATIC",
      definition: {
        targetDirection: "REDUCE",
        horizonDays: 7,
        baselineCohortCode: "BASELINE",
        afterCohortCode: "AFTER",
        guardrailCodes: ["GUARDRAIL"],
        comparabilityCode: "MATCHED",
      },
      createdAt: NOW,
    },
  }),
};
const factor = (methodId: string, value: number) => ({
  value,
  methodId,
  methodVersion: "1",
  evidenceWindow: { from: FROM, to: NOW },
  uncertainty: { lower: value, upper: value },
});
const context: EngineContext = {
  registry: { version: "r1", handlers: [handler] },
  profile,
  now: NOW,
  window: { from: FROM, to: NOW },
  compositionVersion: "1",
  rankingPolicyVersion: "rank1",
  value: {
    ceuProvenance: factor("ceu", 1),
    confidenceProvenance: factor("confidence", 1),
    price: factor("price", 2),
    applicability: factor("app", 1),
    expectedEffect: factor("effect", 1),
  },
};

describe("HRE-2 composed persistence adapter", () => {
  it("persists equivalent H5 artifacts for distinct recommendation lineages without identity collisions", () => {
    const secondFindingId = `finding:${"b".repeat(64)}`;
    const secondPoolId = "permission-friction-pool-2";
    const h5Handler = createH5PermissionFrictionHandler(
      new Map([
        [H5_FINDING_ID, h5Evidence()],
        [secondFindingId, h5Evidence({ findingId: secondFindingId })],
      ]),
    );
    const h5Profile: CapabilityProfile = {
      ...profile,
      id: "h5-profile",
      version: "h5-profile-1",
      observations: [
        {
          capability: "permission-config-diff-v1",
          verdict: "SUPPORTED",
          source: "LOCAL_CANARY",
          canaryVersion: "permission-config-canary-1",
          observedAt: NOW,
        },
      ],
    };
    const h5Context: EngineContext = {
      ...context,
      registry: { version: H5_REGISTRY_VERSION, handlers: [h5Handler] },
      profile: h5Profile,
      rankingPolicyVersion: "ranking-policy-2",
    };
    for (const [findingId, scopeHash, poolId] of [
      [H5_FINDING_ID, "scope-h5-1", "permission-friction-pool"],
      [secondFindingId, "scope-h5-2", secondPoolId],
    ] as const) {
      appendNativeFinding(db, {
        findingId,
        detectorId: "C9",
        detectorContractVersion: 2,
        scopeHash,
        windowFrom: FROM,
        windowTo: NOW,
        findingCount: 2,
        affectedSessions: 1,
        exclusiveCeu: 3,
        confidence: 1,
        safeAnchorIds: [],
        provenanceCode: "SYNTHETIC",
        lifecycle: "OPEN",
        observedAt: NOW,
        reasonCode: "SYNTHETIC",
        createdAt: NOW,
      });
    }
    appendCompositionSnapshot(db, {
      snapshotId: "snapshot-h5",
      compositionVersion: 1,
      registryVersion: H5_REGISTRY_VERSION,
      rankingPolicyVersion: "ranking-policy-2",
      priceVersion: "price1",
      capabilityProfileId: null,
      windowFrom: FROM,
      windowTo: NOW,
      createdAt: NOW,
      pools: [
        { ceuPoolId: "permission-friction-pool", totalCeuPerWeek: 3 },
        { ceuPoolId: secondPoolId, totalCeuPerWeek: 3 },
      ],
    });

    const first = composeRecommendation([h5Finding({ confidence: 1 })], h5Context);
    const second = composeRecommendation(
      [
        h5Finding({
          id: secondFindingId as ReturnType<typeof h5Finding>["id"],
          correlationKey: "permission-friction-2",
          ceuPoolId: secondPoolId as ReturnType<typeof h5Finding>["ceuPoolId"],
          confidence: 1,
        }),
      ],
      h5Context,
    );
    expect(first.artifacts[0]?.artifactRevisionId).not.toBe(
      second.artifacts[0]?.artifactRevisionId,
    );
    persistComposedRecommendation(db, first, {
      snapshotId: "snapshot-h5",
      recommendationId: "recommendation-h5-1",
      expectedActiveRevisionId: null,
    });
    persistComposedRecommendation(db, second, {
      snapshotId: "snapshot-h5",
      recommendationId: "recommendation-h5-2",
      expectedActiveRevisionId: null,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS total, COUNT(DISTINCT artifact_revision_id) AS distinct_ids
             FROM hre_artifact_revisions`,
        )
        .get(),
    ).toEqual({ total: 2, distinct_ids: 2 });
  });

  it("persists the admitted graph and exact stored artifact/method fields atomically", () => {
    appendNativeFinding(db, {
      findingId: "finding-1",
      detectorId: "detector",
      detectorContractVersion: 1,
      scopeHash: "scope-1",
      windowFrom: FROM,
      windowTo: NOW,
      findingCount: 1,
      affectedSessions: 1,
      exclusiveCeu: 5,
      confidence: 1,
      safeAnchorIds: [],
      provenanceCode: "SYNTHETIC",
      lifecycle: "OPEN",
      observedAt: NOW,
      reasonCode: "SYNTHETIC",
      createdAt: NOW,
    });
    appendCompositionSnapshot(db, {
      snapshotId: "snapshot-1",
      compositionVersion: 1,
      registryVersion: "r1",
      rankingPolicyVersion: "rank1",
      priceVersion: "price1",
      capabilityProfileId: null,
      windowFrom: FROM,
      windowTo: NOW,
      createdAt: NOW,
      pools: [{ ceuPoolId: "pool-1", totalCeuPerWeek: 5 }],
    });
    const composed = composeRecommendation(
      [
        {
          id: "finding-1" as never,
          detectorId: "detector",
          schemaVersion: 1,
          observedAt: NOW,
          correlationKey: "key-1",
          ceuPoolId: "pool-1" as never,
          ceuPerWeek: 5,
          confidence: 1,
        },
      ],
      context,
    );
    expect(composed.lifecycle).toBe("ACTIONABLE");
    const persisted = persistComposedRecommendation(db, composed, {
      snapshotId: "snapshot-1",
      recommendationId: "recommendation-1",
      expectedActiveRevisionId: null,
    });
    publishCompositionSnapshot(db, "snapshot-1");
    expect(readRecommendationGraph(db, "recommendation-1")).toMatchObject({
      activeRevisionId: persisted.recommendationRevisionId,
      state: "PUBLISHED",
      findingIds: ["finding-1"],
    });
    expect(
      db
        .prepare(
          `SELECT artifact_revision_id, recommendation_revision_id, artifact_kind, artifact_hash,
                  capability_profile_version, validation_status, rollback_available,
                  supersedes_artifact_revision_id, created_at
             FROM hre_artifact_revisions`,
        )
        .get(),
    ).toEqual({
      artifact_revision_id: artifactId("a"),
      recommendation_revision_id: persisted.recommendationRevisionId,
      artifact_kind: "advice",
      artifact_hash: hash("content"),
      capability_profile_version: "p1",
      validation_status: "VALIDATED",
      rollback_available: 1,
      supersedes_artifact_revision_id: null,
      created_at: NOW,
    });
    expect(
      db
        .prepare(
          `SELECT measurement_method_id, artifact_revision_id, method_version, target_metric_code,
                  verdict, frozen_definition_json, created_at
             FROM hre_measurement_methods`,
        )
        .get(),
    ).toEqual({
      measurement_method_id: measurementId("m"),
      artifact_revision_id: artifactId("a"),
      method_version: "1",
      target_metric_code: "SAVINGS_USD",
      verdict: "AUTOMATIC",
      frozen_definition_json: JSON.stringify(composed.measurement?.definition),
      created_at: NOW,
    });
  });
  it("fails closed without partially writing an investigate composition", () => {
    const investigate = composeRecommendation([], context);
    expect(() =>
      persistComposedRecommendation(db, investigate, {
        snapshotId: "snapshot-1",
        recommendationId: "recommendation-1",
        expectedActiveRevisionId: null,
      }),
    ).toThrow("only actionable");
    expect(db.prepare("SELECT COUNT(*) AS count FROM hre_recommendations").get()).toEqual({
      count: 0,
    });
  });
  it("rolls back the entire graph when a late artifact insert fails", () => {
    appendNativeFinding(db, {
      findingId: "finding-1",
      detectorId: "detector",
      detectorContractVersion: 1,
      scopeHash: "scope-1",
      windowFrom: FROM,
      windowTo: NOW,
      findingCount: 1,
      affectedSessions: 1,
      exclusiveCeu: 5,
      confidence: 1,
      safeAnchorIds: [],
      provenanceCode: "SYNTHETIC",
      lifecycle: "OPEN",
      observedAt: NOW,
      reasonCode: "SYNTHETIC",
      createdAt: NOW,
    });
    appendCompositionSnapshot(db, {
      snapshotId: "snapshot-1",
      compositionVersion: 1,
      registryVersion: "r1",
      rankingPolicyVersion: "rank1",
      priceVersion: "price1",
      capabilityProfileId: null,
      windowFrom: FROM,
      windowTo: NOW,
      createdAt: NOW,
      pools: [{ ceuPoolId: "pool-1", totalCeuPerWeek: 5 }],
    });
    const composed = composeRecommendation(
      [
        {
          id: "finding-1" as never,
          detectorId: "detector",
          schemaVersion: 1,
          observedAt: NOW,
          correlationKey: "key-1",
          ceuPoolId: "pool-1" as never,
          ceuPerWeek: 5,
          confidence: 1,
        },
      ],
      context,
    );
    const firstArtifact = composed.artifacts.at(0);
    const boundMeasurement = composed.measurement;
    if (firstArtifact === undefined || boundMeasurement === null) throw new Error("test fixture");
    const lateFailure = {
      ...composed,
      artifacts: [...composed.artifacts, firstArtifact],
    };
    expect(() =>
      persistComposedRecommendation(db, lateFailure, {
        snapshotId: "snapshot-1",
        recommendationId: "recommendation-1",
        expectedActiveRevisionId: null,
      }),
    ).toThrow();
    for (const table of [
      "hre_recommendations",
      "hre_recommendation_revisions",
      "hre_artifact_revisions",
      "hre_measurement_methods",
    ])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    const unboundMeasurement = {
      ...composed,
      measurement: { ...boundMeasurement, artifactRevisionId: artifactId("not-present") },
    };
    expect(() =>
      persistComposedRecommendation(db, unboundMeasurement, {
        snapshotId: "snapshot-1",
        recommendationId: "recommendation-2",
        expectedActiveRevisionId: null,
      }),
    ).toThrow();
    for (const table of [
      "hre_recommendations",
      "hre_recommendation_revisions",
      "hre_artifact_revisions",
      "hre_measurement_methods",
    ])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  });
});
