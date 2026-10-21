import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import type { ComposedRecommendation } from "./engine.js";
import {
  appendArtifactRevision,
  appendComposedRecommendationRevision,
  appendMeasurementMethod,
} from "./storage.js";

export interface PersistComposedRecommendationInput {
  readonly snapshotId: string;
  readonly recommendationId: string;
  readonly expectedActiveRevisionId: string | null;
}
export interface PersistedComposedRecommendation {
  readonly recommendationRevisionId: string;
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Atomically maps an admitted immutable composition to the existing HRE graph.
 * The adapter deliberately has no semantic defaults: missing engine metadata is
 * a fail-closed error rather than an invented persistence value.
 */
export function persistComposedRecommendation(
  db: Db,
  recommendation: ComposedRecommendation,
  input: PersistComposedRecommendationInput,
): PersistedComposedRecommendation {
  if (
    recommendation.lifecycle !== "ACTIONABLE" ||
    recommendation.composition === null ||
    recommendation.measurement === null ||
    recommendation.artifacts.length === 0
  ) {
    throw new Error("only actionable, fully-bound compositions may persist");
  }
  const composition = recommendation.composition;
  const measurement = recommendation.measurement;
  if (composition === null || measurement === null) throw new Error("incomplete composition");
  const revisionId = `revision:${digest(recommendation.immutableId)}`;
  db.transaction(() => {
    appendComposedRecommendationRevision(db, {
      recommendationId: input.recommendationId,
      recommendationRevisionId: revisionId,
      expectedActiveRevisionId: input.expectedActiveRevisionId,
      snapshotId: input.snapshotId,
      handlerFamily: composition.handlerFamily,
      handlerVersion: composition.handlerVersion,
      registryVersion: composition.registryVersion,
      rankingPolicyVersion: composition.rankingPolicyVersion,
      expectedValue: recommendation.expectedSavingsUsdPerWeek,
      expectedValueUnit: "USD_PER_WEEK",
      valueMethodId: composition.valueMethodId,
      valueMethodVersion: composition.valueMethodVersion,
      valueWindowFrom: composition.valueWindowFrom,
      valueWindowTo: composition.valueWindowTo,
      reasonCodes: recommendation.reasonCodes,
      createdAt: composition.createdAt,
      findingLinks: recommendation.links.map((link) => ({
        findingId: link.findingId,
        ceuPoolId: link.ceuPoolId,
        evidenceRole: link.role,
        contributionCeuPerWeek: link.contributionCeuPerWeek,
        ownsValue: link.ownsValue,
      })),
    });
    for (const artifact of recommendation.artifacts) {
      appendArtifactRevision(db, {
        artifactRevisionId: artifact.artifactRevisionId,
        recommendationRevisionId: revisionId,
        artifactKind: artifact.kind,
        artifactHash: artifact.artifactHash,
        capabilityProfileVersion: artifact.capabilityProfileVersion,
        validationStatus: artifact.validationStatus,
        rollbackAvailable:
          artifact.rollbackArtifactRevisionId.length > 0 && artifact.rollbackHash.length > 0,
        supersedesArtifactRevisionId: artifact.supersedesArtifactRevisionId,
        createdAt: artifact.createdAt,
      });
    }
    appendMeasurementMethod(db, {
      measurementMethodId: measurement.measurementMethodId,
      artifactRevisionId: measurement.artifactRevisionId,
      methodVersion: measurement.methodVersion,
      targetMetricCode: measurement.targetMetricCode,
      verdict: measurement.verdict,
      definition: measurement.definition,
      createdAt: measurement.createdAt,
    });
  })();
  return { recommendationRevisionId: revisionId };
}
