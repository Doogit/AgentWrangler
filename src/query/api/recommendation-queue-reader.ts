/**
 * HRE-backed, snapshot-bound recommendation queue reader.
 *
 * This is deliberately an opt-in read model. It never joins legacy
 * recommendations, and it exposes only privacy-safe HRE aggregate fields.
 */

import { RANKING_POLICY_VERSION } from "../../recommendations/ranking-policy.js";
import type { RecommendationId, RecommendationLifecycle } from "../../recommendations/types.js";
import { getQueryDb } from "../db-context.js";
import { type ApiResponse, buildResponse, stubResponse } from "../envelope.js";
import { listArtifactBoundMeasuredResults } from "./effect-service.js";
import {
  type QueueArtifactKind,
  type QueueCompatibility,
  type QueueCursor,
  type QueueFilters,
  type QueueItem,
  type QueueMeasuredResult,
  type QueueMeasuredState,
  type QueueMeasurementVerdict,
  type QueueQueryResult,
  type QueueSafetyClass,
  type QueueSort,
  createRecommendationQueueSnapshot,
  queryRecommendationQueue,
} from "./recommendation-queue.js";

export interface RecommendationQueueReadRequest {
  readonly pageSize: number;
  readonly cursor?: QueueCursor;
  readonly filters?: QueueFilters;
  readonly sort?: QueueSort;
}

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly composition_version: number;
  readonly ranking_policy_version: typeof RANKING_POLICY_VERSION;
}

interface QueueRow {
  readonly recommendation_id: string;
  readonly active_revision_id: string;
  readonly lifecycle: RecommendationLifecycle | null;
  readonly handler_family: string;
  readonly expected_value: number | null;
  readonly expected_value_unit: string;
  readonly scope_id: string | null;
  readonly confidence: number | null;
  readonly evidence_newest_at: string;
  readonly artifact_kind: QueueArtifactKind | null;
  readonly measurement_verdict: QueueMeasurementVerdict | null;
  readonly compatibility: QueueCompatibility;
}

function currentSnapshot(): SnapshotRow | undefined {
  return getQueryDb()
    .prepare(
      `SELECT snapshot_id, composition_version, ranking_policy_version
         FROM hre_composition_snapshots
        WHERE state = 'PUBLISHED' AND ranking_policy_version = ?
        ORDER BY composition_version DESC, created_at DESC, snapshot_id DESC
        LIMIT 1`,
    )
    .get(RANKING_POLICY_VERSION) as SnapshotRow | undefined;
}

interface MeasuredFeedIndex {
  readonly byRevision: ReadonlyMap<string, QueueMeasuredResult>;
  readonly supersedes: ReadonlyMap<string, string>;
}

/**
 * Binds each item to the artifact-bound observed result of its exact active
 * revision. A cycle on a revision the active revision replaced (an ancestor)
 * counts as superseded; a cycle for any other revision — including a newer one
 * that is not yet in the frozen snapshot — fails closed rather than inheriting
 * a misleading reason. Modeled value is never promoted to measured value.
 */
function measuredFeedIndex(): MeasuredFeedIndex {
  const db = getQueryDb();
  const byRevision = new Map<string, QueueMeasuredResult>();
  for (const result of listArtifactBoundMeasuredResults(db)) {
    const key = `${result.recommendationId}|${result.recommendationRevisionId}`;
    if (!byRevision.has(key)) byRevision.set(key, result.state);
  }
  const edges = db
    .prepare(
      `SELECT recommendation_revision_id, supersedes_revision_id
         FROM hre_recommendation_revisions
        WHERE supersedes_revision_id IS NOT NULL`,
    )
    .all() as readonly {
    recommendation_revision_id: string;
    supersedes_revision_id: string;
  }[];
  return {
    byRevision,
    supersedes: new Map(
      edges.map((edge) => [edge.recommendation_revision_id, edge.supersedes_revision_id]),
    ),
  };
}

/**
 * Only `NO_CYCLE` and `SUPERSEDED_REVISION` are derivable from the current feed.
 * `LEGACY_UNLINKED` stays in the contract vocabulary for the widened feed
 * requested by RQU-1b; it is not fabricated here.
 */
function measuredStateFor(
  index: MeasuredFeedIndex,
  recommendationId: string,
  activeRevisionId: string,
): QueueMeasuredState {
  const exact = index.byRevision.get(`${recommendationId}|${activeRevisionId}`);
  if (exact !== undefined) return { kind: "MEASURED", result: exact };
  for (
    let revision = index.supersedes.get(activeRevisionId);
    revision !== undefined;
    revision = index.supersedes.get(revision)
  ) {
    if (index.byRevision.has(`${recommendationId}|${revision}`))
      return { kind: "UNAVAILABLE", reason: "SUPERSEDED_REVISION" };
  }
  return { kind: "UNAVAILABLE", reason: "NO_CYCLE" };
}

/**
 * Reads every value from the immutable snapshot-revision graph in one statement.
 * A field is exposed only when its linked evidence agrees; otherwise it remains
 * null. In particular, applicability and reviewed safety pins have no persisted
 * HRE provenance yet and must not be invented here.
 */
function queueItems(snapshotId: string): readonly QueueItem[] {
  const rows = getQueryDb()
    .prepare(
      `WITH snapshot_revisions AS (
         SELECT revision.*
           FROM hre_recommendation_revisions revision
          WHERE revision.composition_snapshot_id = ?
            AND revision.ranking_policy_version = ?
            AND NOT EXISTS (
              SELECT 1
                FROM hre_recommendation_revisions successor
               WHERE successor.recommendation_id = revision.recommendation_id
                 AND successor.composition_snapshot_id = revision.composition_snapshot_id
                 AND successor.supersedes_revision_id = revision.recommendation_revision_id
            )
       ), finding_summary AS (
         SELECT link.recommendation_revision_id,
                CASE WHEN COUNT(finding.scope_hash) = COUNT(*)
                               AND COUNT(DISTINCT finding.scope_hash) = 1
                       THEN MIN(finding.scope_hash) ELSE NULL END AS scope_id,
                CASE WHEN COUNT(finding.confidence) = COUNT(*)
                           AND MIN(finding.confidence) = MAX(finding.confidence)
                       THEN MIN(finding.confidence) ELSE NULL END AS confidence,
                MAX(finding.observed_at) AS evidence_newest_at,
                CASE WHEN MIN(finding.source_kind) = 'NATIVE'
                           AND MAX(finding.source_kind) = 'NATIVE'
                       THEN 'NATIVE' ELSE 'LEGACY' END AS compatibility
           FROM hre_recommendation_findings link
           JOIN hre_findings finding ON finding.finding_id = link.finding_id
          GROUP BY link.recommendation_revision_id
       ), artifact_summary AS (
         SELECT artifact.recommendation_revision_id,
                CASE WHEN COUNT(artifact.artifact_revision_id) = 0 THEN NULL
                     WHEN COUNT(DISTINCT artifact.artifact_kind) = 1
                          AND COUNT(DISTINCT CASE WHEN artifact.validation_status <> 'VALIDATED'
                                                   THEN artifact.artifact_revision_id END) = 0
                       THEN MIN(artifact.artifact_kind)
                     ELSE NULL END AS artifact_kind,
                CASE WHEN COUNT(method.measurement_method_id) = 0 THEN NULL
                     WHEN COUNT(DISTINCT method.verdict) = 1 THEN MIN(method.verdict)
                     ELSE NULL END AS measurement_verdict
           FROM hre_artifact_revisions artifact
           LEFT JOIN hre_measurement_methods method
             ON method.artifact_revision_id = artifact.artifact_revision_id
          GROUP BY artifact.recommendation_revision_id
       ), latest_lifecycle AS (
         SELECT event.recommendation_id, event.recommendation_revision_id, event.to_state
           FROM hre_recommendation_lifecycle_events event
           JOIN (
             SELECT recommendation_id, MAX(sequence_no) AS sequence_no
               FROM hre_recommendation_lifecycle_events
              GROUP BY recommendation_id
           ) latest
             ON latest.recommendation_id = event.recommendation_id
            AND latest.sequence_no = event.sequence_no
       )
       SELECT revision.recommendation_id,
              revision.recommendation_revision_id AS active_revision_id,
              lifecycle.to_state AS lifecycle,
              revision.handler_family,
              revision.expected_value,
              revision.expected_value_unit,
              findings.scope_id,
              findings.confidence,
              findings.evidence_newest_at,
              artifacts.artifact_kind,
              artifacts.measurement_verdict,
              findings.compatibility
         FROM snapshot_revisions revision
         JOIN finding_summary findings
           ON findings.recommendation_revision_id = revision.recommendation_revision_id
         LEFT JOIN artifact_summary artifacts
           ON artifacts.recommendation_revision_id = revision.recommendation_revision_id
         LEFT JOIN latest_lifecycle lifecycle
           ON lifecycle.recommendation_id = revision.recommendation_id
          AND lifecycle.recommendation_revision_id = revision.recommendation_revision_id
        ORDER BY revision.recommendation_id`,
    )
    .all(snapshotId, RANKING_POLICY_VERSION) as readonly QueueRow[];

  const measured = measuredFeedIndex();
  return rows.map((row) => ({
    stableId: row.recommendation_id as RecommendationId,
    activeRevisionId: row.active_revision_id,
    lifecycle: row.lifecycle ?? "ACTIONABLE",
    handlerFamily: row.handler_family,
    expectedSavingsUsdPerWeek:
      row.expected_value_unit === "USD_PER_WEEK" ? row.expected_value : null,
    confidence: row.confidence,
    applicability: null,
    evidenceNewestAt: row.evidence_newest_at,
    safetyPin: null,
    artifactKind: row.artifact_kind,
    workspaceId: null,
    scopeId: row.scope_id,
    safetyClass: null as QueueSafetyClass,
    measurementVerdict: row.measurement_verdict,
    measuredState: measuredStateFor(measured, row.recommendation_id, row.active_revision_id),
    compatibility: row.compatibility,
  }));
}

function availableSnapshotIds(): ReadonlySet<string> {
  const rows = getQueryDb()
    .prepare(
      `SELECT snapshot_id FROM hre_composition_snapshots
        WHERE state = 'PUBLISHED' AND ranking_policy_version = ?`,
    )
    .all(RANKING_POLICY_VERSION) as readonly { snapshot_id: string }[];
  return new Set(rows.map((row) => row.snapshot_id));
}

/** Returns null data until HRE has a published snapshot compatible with this policy. */
export function listRecommendationQueue(
  request: RecommendationQueueReadRequest,
): ApiResponse<QueueQueryResult> {
  const snapshot = currentSnapshot();
  if (snapshot === undefined) {
    return stubResponse<QueueQueryResult>("N_A");
  }

  const current = createRecommendationQueueSnapshot({
    snapshot: {
      compositionSnapshotId: snapshot.snapshot_id,
      compositionVersion: snapshot.composition_version,
      rankingPolicyVersion: snapshot.ranking_policy_version,
    },
    items: queueItems(snapshot.snapshot_id),
  });
  const data = queryRecommendationQueue({
    current,
    availableSnapshotIds: availableSnapshotIds(),
    pageSize: request.pageSize,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.filters === undefined ? {} : { filters: request.filters }),
    ...(request.sort === undefined ? {} : { sort: request.sort }),
  });
  return buildResponse(data, {
    claim_kind: "EXPERIMENTAL",
    n: data.kind === "PAGE" ? data.counts.total : 0,
  });
}
