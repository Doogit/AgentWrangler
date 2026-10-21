/**
 * RQU-1b: the queue reader binds the HRE-5b artifact-bound measured-result feed
 * to the exact active revision and fails closed otherwise.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectEngineForDb,
  trackArtifactBoundApplication,
} from "../../src/query/api/effect-service.js";
import { listRecommendationQueue } from "../../src/query/api/recommendation-queue-reader.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import {
  appendArtifactApplication,
  appendArtifactRevision,
  appendCompositionSnapshot,
  appendMeasurementMethod,
  appendNativeFinding,
  appendRecommendationRevision,
  publishCompositionSnapshot,
} from "../../src/recommendations/storage.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../src/effects/gate.js", () => ({
  get ESF_EFFECT_WRITER_ENABLED() {
    return gate.enabled;
  },
}));

const T0 = new Date("2026-01-10T00:00:00.000Z");
const AT = T0.toISOString();

let db: Database.Database;

beforeEach(() => {
  gate.enabled = true;
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

function legacyFinding(findingId: string): void {
  db.prepare(
    `INSERT INTO hre_findings
      (finding_id,source_kind,legacy_rec_id,detector_id,detector_contract_version,lifecycle,observed_at,reason_code,created_at)
     VALUES(?, 'LEGACY', 'rec-rqu1b', 'D2', 1, 'OPEN', ?, 'LEGACY_ADAPTER', ?)`,
  ).run(findingId, AT, AT);
}

function revision(input: {
  readonly revisionId: string;
  readonly snapshotId: string;
  readonly findingId: string;
  readonly poolId: string;
  readonly expectedActiveRevisionId: string | null;
}): void {
  appendRecommendationRevision(db, {
    recommendationId: "hre-recommendation-rqu1b",
    recommendationRevisionId: input.revisionId,
    expectedActiveRevisionId: input.expectedActiveRevisionId,
    snapshotId: input.snapshotId,
    findingId: input.findingId,
    ceuPoolId: input.poolId,
    ownsValue: true,
    contributionCeuPerWeek: 1,
    handlerFamily: "H2_OUTPUT_CONTEXT",
    handlerVersion: "h2-handler-1",
    registryVersion: "hre-registry-rqu1b",
    rankingPolicyVersion: "ranking-policy-2",
    expectedValue: 1,
    expectedValueUnit: "CEU_PER_WEEK",
    valueMethodId: "hre-value-rqu1b",
    valueMethodVersion: "1",
    valueWindowFrom: "2026-01-01T00:00:00.000Z",
    valueWindowTo: AT,
    reasonCodes: ["OUTPUT_EXPOSURE"],
    createdAt: AT,
  });
}

function seedPublishedSnapshot(): void {
  seedValidatedRecommendation(db, {
    recId: "rec-rqu1b",
    templateId: "D2_LONG_FULL_CONTEXT",
    scope: "ws-alpha",
    createdAt: AT,
  });
  legacyFinding("hre-finding-rqu1b");
  appendCompositionSnapshot(db, {
    snapshotId: "hre-snapshot-rqu1b",
    compositionVersion: 1,
    registryVersion: "hre-registry-rqu1b",
    rankingPolicyVersion: "ranking-policy-2",
    priceVersion: "hre-price-rqu1b",
    capabilityProfileId: null,
    windowFrom: "2026-01-01T00:00:00.000Z",
    windowTo: AT,
    createdAt: AT,
    pools: [{ ceuPoolId: "hre-pool-rqu1b", totalCeuPerWeek: 1 }],
  });
  revision({
    revisionId: "hre-revision-rqu1b",
    snapshotId: "hre-snapshot-rqu1b",
    findingId: "hre-finding-rqu1b",
    poolId: "hre-pool-rqu1b",
    expectedActiveRevisionId: null,
  });
  appendArtifactRevision(db, {
    artifactRevisionId: "hre-artifact-rqu1b",
    recommendationRevisionId: "hre-revision-rqu1b",
    artifactKind: "advice",
    artifactHash: "hre-artifact-hash-rqu1b",
    capabilityProfileVersion: "profile-1",
    validationStatus: "VALIDATED",
    rollbackAvailable: true,
    supersedesArtifactRevisionId: null,
    createdAt: AT,
  });
  appendMeasurementMethod(db, {
    measurementMethodId: "hre-measurement-rqu1b",
    artifactRevisionId: "hre-artifact-rqu1b",
    methodVersion: "hre-measurement-1",
    targetMetricCode: "OUTPUT_EXPOSURE_CEU_PER_WEEK",
    verdict: "AUTOMATIC",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "HRE_BASELINE",
      afterCohortCode: "HRE_AFTER",
      guardrailCodes: ["NO_QUALITY_REGRESSION"],
      comparabilityCode: "SAME_SCOPE",
    },
    createdAt: AT,
  });
  appendArtifactApplication(db, {
    artifactApplicationId: "hre-application-rqu1b",
    artifactRevisionId: "hre-artifact-rqu1b",
    observedRecommendationRevisionId: "hre-revision-rqu1b",
    authorizationId: "hre-authorization-rqu1b",
    applicationSource: "USER_ATTESTED",
    baseHash: "hre-base-rqu1b",
    postHash: "hre-post-rqu1b",
    result: "APPLIED",
    rollbackState: "AVAILABLE",
    appliedAt: AT,
    createdAt: AT,
  });
  publishCompositionSnapshot(db, "hre-snapshot-rqu1b");
}

/** Publishes a newer snapshot whose terminal revision supersedes the measured one. */
function publishSuccessorSnapshot(): void {
  appendNativeFinding(db, {
    findingId: "hre-finding-rqu1b-2",
    detectorId: "D2",
    detectorContractVersion: 1,
    scopeHash: "scope-rqu1b-2",
    windowFrom: "2026-01-01T00:00:00.000Z",
    windowTo: AT,
    findingCount: 1,
    affectedSessions: 1,
    exclusiveCeu: 1,
    confidence: 0.5,
    safeAnchorIds: [],
    provenanceCode: "SYNTHETIC_FIXTURE",
    lifecycle: "OPEN",
    observedAt: AT,
    reasonCode: "SYNTHETIC_FINDING",
    createdAt: AT,
  });
  appendCompositionSnapshot(db, {
    snapshotId: "hre-snapshot-rqu1b-2",
    compositionVersion: 2,
    registryVersion: "hre-registry-rqu1b",
    rankingPolicyVersion: "ranking-policy-2",
    priceVersion: "hre-price-rqu1b",
    capabilityProfileId: null,
    windowFrom: "2026-01-01T00:00:00.000Z",
    windowTo: AT,
    createdAt: AT,
    pools: [{ ceuPoolId: "hre-pool-rqu1b-2", totalCeuPerWeek: 1 }],
  });
  revision({
    revisionId: "hre-revision-rqu1b-2",
    snapshotId: "hre-snapshot-rqu1b-2",
    findingId: "hre-finding-rqu1b-2",
    poolId: "hre-pool-rqu1b-2",
    expectedActiveRevisionId: "hre-revision-rqu1b",
  });
  publishCompositionSnapshot(db, "hre-snapshot-rqu1b-2");
}

/**
 * Tracks an artifact-bound cycle for a successor revision while its snapshot
 * stays unpublished, so the frozen active revision is the predecessor.
 */
function seedSuccessorCycleUnpublished(): void {
  appendCompositionSnapshot(db, {
    snapshotId: "hre-snapshot-rqu1b-2",
    compositionVersion: 2,
    registryVersion: "hre-registry-rqu1b",
    rankingPolicyVersion: "ranking-policy-2",
    priceVersion: "hre-price-rqu1b",
    capabilityProfileId: null,
    windowFrom: "2026-01-01T00:00:00.000Z",
    windowTo: AT,
    createdAt: AT,
    pools: [{ ceuPoolId: "hre-pool-rqu1b-2", totalCeuPerWeek: 1 }],
  });
  revision({
    revisionId: "hre-revision-rqu1b-2",
    snapshotId: "hre-snapshot-rqu1b-2",
    findingId: "hre-finding-rqu1b",
    poolId: "hre-pool-rqu1b-2",
    expectedActiveRevisionId: "hre-revision-rqu1b",
  });
  appendArtifactRevision(db, {
    artifactRevisionId: "hre-artifact-rqu1b-2",
    recommendationRevisionId: "hre-revision-rqu1b-2",
    artifactKind: "advice",
    artifactHash: "hre-artifact-hash-rqu1b-2",
    capabilityProfileVersion: "profile-1",
    validationStatus: "VALIDATED",
    rollbackAvailable: true,
    supersedesArtifactRevisionId: null,
    createdAt: AT,
  });
  appendMeasurementMethod(db, {
    measurementMethodId: "hre-measurement-rqu1b-2",
    artifactRevisionId: "hre-artifact-rqu1b-2",
    methodVersion: "hre-measurement-1",
    targetMetricCode: "OUTPUT_EXPOSURE_CEU_PER_WEEK",
    verdict: "AUTOMATIC",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "HRE_BASELINE",
      afterCohortCode: "HRE_AFTER",
      guardrailCodes: ["NO_QUALITY_REGRESSION"],
      comparabilityCode: "SAME_SCOPE",
    },
    createdAt: AT,
  });
  appendArtifactApplication(db, {
    artifactApplicationId: "hre-application-rqu1b-2",
    artifactRevisionId: "hre-artifact-rqu1b-2",
    observedRecommendationRevisionId: "hre-revision-rqu1b-2",
    authorizationId: "hre-authorization-rqu1b-2",
    applicationSource: "USER_ATTESTED",
    baseHash: "hre-base-rqu1b-2",
    postHash: "hre-post-rqu1b-2",
    result: "APPLIED",
    rollbackState: "AVAILABLE",
    appliedAt: AT,
    createdAt: AT,
  });
  const tracked = trackArtifactBoundApplication(db, "hre-application-rqu1b-2", T0);
  if (!tracked.supported) throw new Error("expected a successor cycle");
}

function queueItem() {
  const response = listRecommendationQueue({ pageSize: 10 });
  if (response.data?.kind !== "PAGE") throw new Error("expected a queue page");
  const item = response.data.items[0];
  if (item === undefined) throw new Error("expected a queue item");
  return item;
}

describe("recommendation queue measured-result feed", () => {
  it("binds a pending artifact-bound result to the exact active revision", () => {
    seedPublishedSnapshot();
    const tracked = trackArtifactBoundApplication(db, "hre-application-rqu1b", T0);
    if (!tracked.supported) throw new Error("expected an artifact-bound cycle");

    expect(queueItem()).toMatchObject({
      stableId: "hre-recommendation-rqu1b",
      activeRevisionId: "hre-revision-rqu1b",
      measuredState: { kind: "MEASURED", result: "PENDING" },
    });

    effectEngineForDb(db).stop(tracked.cycle.cycleId, {
      idempotencyKey: "rqu1b-stop",
      reason: "USER_STOPPED",
      at: new Date(T0.getTime() + 86_400_000).toISOString(),
    });
    expect(queueItem().measuredState).toEqual({ kind: "MEASURED", result: "INCONCLUSIVE" });
  });

  it("fails closed to null once the active revision advances past the measured revision", () => {
    seedPublishedSnapshot();
    const tracked = trackArtifactBoundApplication(db, "hre-application-rqu1b", T0);
    if (!tracked.supported) throw new Error("expected an artifact-bound cycle");
    expect(queueItem().measuredState).toEqual({ kind: "MEASURED", result: "PENDING" });

    publishSuccessorSnapshot();

    expect(queueItem()).toMatchObject({
      activeRevisionId: "hre-revision-rqu1b-2",
      measuredState: { kind: "UNAVAILABLE", reason: "SUPERSEDED_REVISION" },
    });
  });

  it("does not label an unpublished successor's cycle as superseding the frozen active revision", () => {
    seedPublishedSnapshot();
    seedSuccessorCycleUnpublished();

    expect(queueItem()).toMatchObject({
      activeRevisionId: "hre-revision-rqu1b",
      measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
    });
  });

  it("fails closed to an explicit no-cycle state when no artifact-bound cycle exists", () => {
    seedPublishedSnapshot();
    expect(queueItem()).toMatchObject({
      stableId: "hre-recommendation-rqu1b",
      measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
    });
  });

  it("filters the measured feed through the reader request", () => {
    seedPublishedSnapshot();
    const tracked = trackArtifactBoundApplication(db, "hre-application-rqu1b", T0);
    if (!tracked.supported) throw new Error("expected an artifact-bound cycle");

    const measured = listRecommendationQueue({
      pageSize: 10,
      filters: { measuredResult: ["PENDING"] },
    });
    expect(measured.data).toMatchObject({
      kind: "PAGE",
      counts: { total: 1, byMeasuredResult: { PENDING: 1 } },
    });

    const unavailable = listRecommendationQueue({
      pageSize: 10,
      filters: { measuredResult: [null] },
    });
    expect(unavailable.data).toMatchObject({ kind: "PAGE", counts: { total: 0 } });
  });
});
