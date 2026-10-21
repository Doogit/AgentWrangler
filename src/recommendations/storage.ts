import type { Db } from "../db/open.js";
import { trustedRecommendationContract } from "../query/recommendation-contract.js";
import {
  type HistoricalHandlerSnapshotV1,
  type HistoricalSnapshotAllowlist,
  decodeHistoricalHandlerSnapshotV1,
} from "./capabilities.js";
import {
  type LegacyAdapterResult,
  type LegacyFindingProjection,
  type LegacyRecommendationRowContract,
  adaptLegacyRecommendation,
} from "./legacy-adapter.js";

interface LegacyRecommendationDbRow {
  rec_id: string;
  detector_id: string | null;
  state: LegacyRecommendationRowContract["state"];
  created_at: string;
  category: string | null;
  lever: string | null;
  target_metric: string;
  evidence_json: string;
  contract_version: number | null;
  template_id: string | null;
  contract_status: LegacyRecommendationRowContract["contractStatus"];
  rule_id: string | null;
}

export type MaterializeLegacyFindingResult = LegacyAdapterResult | { readonly kind: "NOT_FOUND" };

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function requireOpaqueId(value: string, name: string): void {
  if (!OPAQUE_ID.test(value)) throw new Error(`${name} must be a bounded opaque identifier`);
}

function requireSafeCode(value: string, name: string): void {
  if (!SAFE_CODE.test(value)) throw new Error(`${name} must be a privacy-safe code`);
}

function requireSafeCodes(values: readonly string[], name: string, maximum = 16): void {
  if (values.length === 0 || values.length > maximum) throw new Error(`${name} must be bounded`);
  for (const value of values) requireSafeCode(value, name);
}

function requireCanonicalTime(value: string, name: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${name} must be a canonical timestamp`);
}

function requirePreciseNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value * 1_000_000))
    throw new Error(`${name} must be a non-negative number with at most six decimal places`);
}

/**
 * Materializes only detector findings that survive the existing fail-closed
 * recommendation contract boundary. Raw evidence is deliberately not copied.
 */
export function materializeLegacyFinding(
  db: Db,
  recId: string,
  findingKind: LegacyRecommendationRowContract["findingKind"] = "FINDING",
): MaterializeLegacyFindingResult {
  const row = db
    .prepare(
      `SELECT rec_id, detector_id, state, created_at, category, lever, target_metric,
              evidence_json, contract_version, template_id, contract_status, rule_id
         FROM recommendations WHERE rec_id = ?`,
    )
    .get(recId) as LegacyRecommendationDbRow | undefined;
  if (row === undefined) return { kind: "NOT_FOUND" };

  const adapted = adaptLegacyRecommendation({
    recId: row.rec_id,
    detectorId: row.detector_id,
    contractStatus: row.contract_status,
    contractVersion: row.contract_version,
    findingKind,
    state: row.state,
    createdAt: row.created_at,
  });
  if (adapted.kind === "EXCLUDED") return adapted;

  const trusted = trustedRecommendationContract(row);
  if (trusted === null || trusted.version !== adapted.finding.contractVersion) {
    return { kind: "EXCLUDED", reason: "UNVERIFIED_CONTRACT" };
  }

  db.prepare(
    `INSERT OR IGNORE INTO hre_findings
       (finding_id, source_kind, legacy_rec_id, detector_id, detector_contract_version,
        lifecycle, observed_at, reason_code, created_at)
     VALUES (?, 'LEGACY', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    adapted.finding.id,
    adapted.finding.sourceRecommendationId,
    adapted.finding.detectorId,
    adapted.finding.contractVersion,
    adapted.finding.lifecycle,
    adapted.finding.observedAt,
    adapted.finding.reasonCodes[0],
    adapted.finding.observedAt,
  );
  const persisted = readLegacyFinding(db, adapted.finding.id);
  if (persisted === null) throw new Error("legacy finding materialization failed");
  if (
    persisted.sourceRecommendationId !== adapted.finding.sourceRecommendationId ||
    persisted.detectorId !== adapted.finding.detectorId ||
    persisted.contractVersion !== adapted.finding.contractVersion ||
    persisted.lifecycle !== adapted.finding.lifecycle ||
    persisted.observedAt !== adapted.finding.observedAt ||
    persisted.reasonCodes[0] !== adapted.finding.reasonCodes[0]
  ) {
    throw new Error("legacy finding identity collision");
  }
  return { kind: "ADAPTED", finding: persisted };
}

export function readLegacyFinding(db: Db, findingId: string): LegacyFindingProjection | null {
  const row = db
    .prepare(
      `SELECT finding_id, legacy_rec_id, detector_id, detector_contract_version,
              lifecycle, observed_at, reason_code
         FROM hre_findings WHERE finding_id = ? AND source_kind = 'LEGACY'`,
    )
    .get(findingId) as
    | {
        finding_id: string;
        legacy_rec_id: string;
        detector_id: string;
        detector_contract_version: 1 | 2;
        lifecycle: LegacyFindingProjection["lifecycle"];
        observed_at: string;
        reason_code: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    id: row.finding_id as LegacyFindingProjection["id"],
    sourceRecommendationId: row.legacy_rec_id,
    detectorId: row.detector_id,
    contractVersion: row.detector_contract_version,
    lifecycle: row.lifecycle,
    effectLinkState: "LEGACY_UNLINKED",
    observedAt: row.observed_at,
    reasonCodes: [row.reason_code as LegacyFindingProjection["reasonCodes"][number]],
  };
}

export interface NativeFindingInput {
  readonly findingId: string;
  readonly detectorId: string;
  readonly detectorContractVersion: number;
  readonly scopeHash: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly findingCount: number;
  readonly affectedSessions: number;
  readonly exclusiveCeu: number | null;
  readonly confidence: number | null;
  readonly safeAnchorIds: readonly string[];
  readonly provenanceCode: string;
  readonly lifecycle: "OPEN" | "ACTIONED" | "DISMISSED";
  readonly observedAt: string;
  readonly reasonCode: string;
  readonly createdAt: string;
}

export interface NativeFindingProjection extends NativeFindingInput {
  readonly sourceKind: "NATIVE";
}

/** Writes only aggregate evidence and opaque anchor identities; raw evidence is not accepted. */
export function appendNativeFinding(db: Db, input: NativeFindingInput): NativeFindingProjection {
  requireOpaqueId(input.findingId, "finding id");
  requireOpaqueId(input.detectorId, "detector id");
  requireOpaqueId(input.scopeHash, "scope hash");
  requireSafeCode(input.provenanceCode, "provenance code");
  requireSafeCode(input.reasonCode, "reason code");
  if (!Number.isSafeInteger(input.detectorContractVersion) || input.detectorContractVersion < 1)
    throw new Error("invalid detector contract version");
  if (!Number.isSafeInteger(input.findingCount) || input.findingCount < 1)
    throw new Error("invalid finding count");
  if (!Number.isSafeInteger(input.affectedSessions) || input.affectedSessions < 0)
    throw new Error("invalid affected session count");
  if (input.safeAnchorIds.length > 5) throw new Error("safe anchors must be bounded");
  for (const anchor of input.safeAnchorIds) requireOpaqueId(anchor, "safe anchor id");
  if (
    input.exclusiveCeu !== null &&
    (!Number.isFinite(input.exclusiveCeu) || input.exclusiveCeu < 0)
  )
    throw new Error("invalid exclusive CEU");
  if (
    input.confidence !== null &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
  )
    throw new Error("invalid confidence");
  db.prepare(
    `INSERT INTO hre_findings
      (finding_id, source_kind, legacy_rec_id, detector_id, detector_contract_version,
       scope_hash, window_from, window_to, finding_count, affected_sessions, exclusive_ceu,
       confidence, safe_anchors_json, provenance_code, lifecycle, observed_at, reason_code, created_at)
     VALUES (?, 'NATIVE', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.findingId,
    input.detectorId,
    input.detectorContractVersion,
    input.scopeHash,
    input.windowFrom,
    input.windowTo,
    input.findingCount,
    input.affectedSessions,
    input.exclusiveCeu,
    input.confidence,
    JSON.stringify(input.safeAnchorIds),
    input.provenanceCode,
    input.lifecycle,
    input.observedAt,
    input.reasonCode,
    input.createdAt,
  );
  return { ...input, sourceKind: "NATIVE" };
}

export function storeHistoricalHandlerSnapshot(
  db: Db,
  value: unknown,
  allowlist: HistoricalSnapshotAllowlist,
  retiredAt: string | null = null,
): HistoricalHandlerSnapshotV1 {
  const decoded = decodeHistoricalHandlerSnapshotV1(value, allowlist);
  if (decoded === null) throw new Error("invalid historical handler snapshot");
  db.transaction(() => {
    db.prepare(
      `INSERT INTO hre_handler_history
         (handler_family, handler_version, registry_version, snapshot_schema_version,
          snapshot_json, retired_at)
       VALUES (?, ?, ?, 1, ?, NULL)`,
    ).run(
      decoded.handlerFamily,
      decoded.handlerVersion,
      decoded.registryVersion,
      JSON.stringify(decoded),
    );
    if (retiredAt !== null) {
      retireHistoricalHandler(db, decoded, retiredAt, "INITIAL_RETIREMENT");
    }
  })();
  return decoded;
}

export function retireHistoricalHandler(
  db: Db,
  identity: Pick<
    HistoricalHandlerSnapshotV1,
    "handlerFamily" | "handlerVersion" | "registryVersion"
  >,
  retiredAt: string,
  reasonCode: string,
): void {
  requireSafeCode(reasonCode, "handler retirement reason code");
  db.prepare(
    `INSERT INTO hre_handler_retirements
      (handler_family, handler_version, registry_version, retired_at, reason_code)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    identity.handlerFamily,
    identity.handlerVersion,
    identity.registryVersion,
    retiredAt,
    reasonCode,
  );
}

export function readHistoricalHandlerSnapshot(
  db: Db,
  identity: Pick<
    HistoricalHandlerSnapshotV1,
    "handlerFamily" | "handlerVersion" | "registryVersion"
  >,
  allowlist: HistoricalSnapshotAllowlist,
): HistoricalHandlerSnapshotV1 | null {
  const row = db
    .prepare(
      `SELECT snapshot_json FROM hre_handler_history
        WHERE handler_family = ? AND handler_version = ? AND registry_version = ?`,
    )
    .get(identity.handlerFamily, identity.handlerVersion, identity.registryVersion) as
    | { snapshot_json: string }
    | undefined;
  if (row === undefined) return null;
  try {
    const decoded = decodeHistoricalHandlerSnapshotV1(
      JSON.parse(row.snapshot_json) as unknown,
      allowlist,
    );
    if (decoded === null) return null;
    if (
      decoded.handlerFamily !== identity.handlerFamily ||
      decoded.handlerVersion !== identity.handlerVersion ||
      decoded.registryVersion !== identity.registryVersion
    )
      return null;
    return decoded;
  } catch {
    return null;
  }
}

export interface RevisionGraphInput {
  readonly recommendationId: string;
  readonly recommendationRevisionId: string;
  readonly expectedActiveRevisionId: string | null;
  readonly snapshotId: string;
  readonly findingId: string;
  readonly ceuPoolId: string;
  readonly ownsValue: boolean;
  readonly contributionCeuPerWeek: number;
  readonly handlerFamily: string;
  readonly handlerVersion: string;
  readonly registryVersion: string;
  readonly rankingPolicyVersion: string;
  readonly expectedValue: number | null;
  readonly expectedValueUnit: "CEU_PER_WEEK" | "USD_PER_WEEK" | "FRACTION";
  readonly valueMethodId: string;
  readonly valueMethodVersion: string;
  readonly valueWindowFrom: string;
  readonly valueWindowTo: string;
  readonly reasonCodes: readonly string[];
  readonly createdAt: string;
}

export interface CompositionSnapshotInput {
  readonly snapshotId: string;
  readonly compositionVersion: number;
  readonly registryVersion: string;
  readonly rankingPolicyVersion: string;
  readonly priceVersion: string;
  readonly capabilityProfileId: string | null;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly createdAt: string;
  readonly pools: readonly {
    readonly ceuPoolId: string;
    readonly totalCeuPerWeek: number;
  }[];
}

/** Creates one immutable draft identity and all of its CEU pools atomically. */
export function appendCompositionSnapshot(db: Db, input: CompositionSnapshotInput): void {
  for (const [name, value] of [
    ["snapshot id", input.snapshotId],
    ["registry version", input.registryVersion],
    ["ranking policy version", input.rankingPolicyVersion],
    ["price version", input.priceVersion],
  ] as const)
    requireOpaqueId(value, name);
  if (input.capabilityProfileId !== null)
    requireOpaqueId(input.capabilityProfileId, "capability profile id");
  if (!Number.isSafeInteger(input.compositionVersion) || input.compositionVersion < 1)
    throw new Error("composition version must be a positive integer");
  requireCanonicalTime(input.windowFrom, "snapshot window from");
  requireCanonicalTime(input.windowTo, "snapshot window to");
  requireCanonicalTime(input.createdAt, "snapshot created at");
  if (input.windowTo <= input.windowFrom) throw new Error("snapshot window must be increasing");
  if (input.pools.length === 0 || input.pools.length > 256)
    throw new Error("snapshot CEU pools must be bounded");
  const poolIds = new Set<string>();
  for (const pool of input.pools) {
    requireOpaqueId(pool.ceuPoolId, "CEU pool id");
    requirePreciseNonNegative(pool.totalCeuPerWeek, "CEU pool total");
    if (poolIds.has(pool.ceuPoolId)) throw new Error("duplicate snapshot CEU pool");
    poolIds.add(pool.ceuPoolId);
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO hre_composition_snapshots
       (snapshot_id, composition_version, registry_version, ranking_policy_version,
        price_version, capability_profile_id, window_from, window_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.snapshotId,
      input.compositionVersion,
      input.registryVersion,
      input.rankingPolicyVersion,
      input.priceVersion,
      input.capabilityProfileId,
      input.windowFrom,
      input.windowTo,
      input.createdAt,
    );
    const insertPool = db.prepare(
      `INSERT INTO hre_ceu_pools
       (composition_snapshot_id, ceu_pool_id, total_ceu_per_week) VALUES (?, ?, ?)`,
    );
    for (const pool of [...input.pools].sort((a, b) => a.ceuPoolId.localeCompare(b.ceuPoolId)))
      insertPool.run(input.snapshotId, pool.ceuPoolId, pool.totalCeuPerWeek);
  })();
}

export interface RecommendationFindingLinkInput {
  readonly findingId: string;
  readonly ceuPoolId: string;
  readonly evidenceRole: "PRIMARY" | "SUPPORTING";
  readonly contributionCeuPerWeek: number;
  readonly ownsValue: boolean;
}

export interface ComposedRevisionGraphInput
  extends Omit<
    RevisionGraphInput,
    "findingId" | "ceuPoolId" | "ownsValue" | "contributionCeuPerWeek"
  > {
  readonly findingLinks: readonly RecommendationFindingLinkInput[];
}

function validateFindingLinks(links: readonly RecommendationFindingLinkInput[]): void {
  if (links.length === 0 || links.length > 256)
    throw new Error("recommendation finding links must be bounded");
  const findingIds = new Set<string>();
  const ownedPools = new Set<string>();
  for (const link of links) {
    requireOpaqueId(link.findingId, "finding id");
    requireOpaqueId(link.ceuPoolId, "CEU pool id");
    requirePreciseNonNegative(link.contributionCeuPerWeek, "CEU contribution");
    if (findingIds.has(link.findingId)) throw new Error("duplicate recommendation finding link");
    findingIds.add(link.findingId);
    if (link.evidenceRole === "PRIMARY") {
      if (!link.ownsValue && link.contributionCeuPerWeek !== 0)
        throw new Error("non-owning finding links cannot contribute CEU");
      if (link.ownsValue && ownedPools.has(link.ceuPoolId))
        throw new Error("duplicate CEU pool owner");
      if (link.ownsValue) ownedPools.add(link.ceuPoolId);
    } else if (link.ownsValue || link.contributionCeuPerWeek !== 0) {
      throw new Error("supporting finding links cannot own or contribute CEU");
    }
  }
}

/** Appends an immutable multi-finding revision and advances the active pointer with a CAS. */
export function appendComposedRecommendationRevision(
  db: Db,
  input: ComposedRevisionGraphInput,
): void {
  requireSafeCodes(input.reasonCodes, "revision reason codes");
  for (const [name, value] of [
    ["recommendation id", input.recommendationId],
    ["recommendation revision id", input.recommendationRevisionId],
    ["snapshot id", input.snapshotId],
    ["handler family", input.handlerFamily],
    ["handler version", input.handlerVersion],
    ["registry version", input.registryVersion],
    ["ranking policy version", input.rankingPolicyVersion],
    ["value method id", input.valueMethodId],
    ["value method version", input.valueMethodVersion],
  ] as const)
    requireOpaqueId(value, name);
  validateFindingLinks(input.findingLinks);
  requireCanonicalTime(input.valueWindowFrom, "value window from");
  requireCanonicalTime(input.valueWindowTo, "value window to");
  requireCanonicalTime(input.createdAt, "revision created at");
  if (input.valueWindowTo <= input.valueWindowFrom)
    throw new Error("value window must be increasing");
  if (input.expectedValue !== null)
    requirePreciseNonNegative(input.expectedValue, "expected value");
  db.transaction(() => {
    const retired = db
      .prepare(
        `SELECT 1 FROM hre_handler_history history
          LEFT JOIN hre_handler_retirements retirement
            ON retirement.handler_family = history.handler_family
           AND retirement.handler_version = history.handler_version
           AND retirement.registry_version = history.registry_version
          WHERE history.handler_family = ? AND history.handler_version = ?
            AND history.registry_version = ?
            AND (history.retired_at IS NOT NULL OR retirement.retired_at IS NOT NULL)`,
      )
      .get(input.handlerFamily, input.handlerVersion, input.registryVersion);
    if (retired !== undefined) throw new Error("retired hre handler cannot create revisions");
    if (input.expectedActiveRevisionId === null) {
      db.prepare(
        `INSERT INTO hre_recommendations (recommendation_id, active_revision_id, created_at)
         VALUES (?, NULL, ?)`,
      ).run(input.recommendationId, input.createdAt);
    }
    db.prepare(
      `INSERT INTO hre_recommendation_revisions
       (recommendation_revision_id, recommendation_id, supersedes_revision_id,
        composition_snapshot_id, handler_family, handler_version, registry_version,
        ranking_policy_version, expected_value, expected_value_unit, value_method_id,
        value_method_version, value_window_from, value_window_to, reason_codes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.recommendationRevisionId,
      input.recommendationId,
      input.expectedActiveRevisionId,
      input.snapshotId,
      input.handlerFamily,
      input.handlerVersion,
      input.registryVersion,
      input.rankingPolicyVersion,
      input.expectedValue,
      input.expectedValueUnit,
      input.valueMethodId,
      input.valueMethodVersion,
      input.valueWindowFrom,
      input.valueWindowTo,
      JSON.stringify(input.reasonCodes),
      input.createdAt,
    );
    const insertLink = db.prepare(
      `INSERT INTO hre_recommendation_findings
       (recommendation_revision_id, finding_id, composition_snapshot_id, ceu_pool_id,
        evidence_role, contribution_ceu_per_week, owns_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const link of [...input.findingLinks].sort((a, b) =>
      a.findingId.localeCompare(b.findingId),
    ))
      insertLink.run(
        input.recommendationRevisionId,
        link.findingId,
        input.snapshotId,
        link.ceuPoolId,
        link.evidenceRole,
        link.contributionCeuPerWeek,
        link.ownsValue ? 1 : 0,
      );
    const advanced = db
      .prepare(
        `UPDATE hre_recommendations SET active_revision_id = ?
          WHERE recommendation_id = ? AND active_revision_id IS ?`,
      )
      .run(input.recommendationRevisionId, input.recommendationId, input.expectedActiveRevisionId);
    if (advanced.changes !== 1) throw new Error("hre active revision conflict");
  })();
}

/** Compatibility wrapper for the HRE-1 single-finding writer. */
export function appendRecommendationRevision(db: Db, input: RevisionGraphInput): void {
  appendComposedRecommendationRevision(db, {
    recommendationId: input.recommendationId,
    recommendationRevisionId: input.recommendationRevisionId,
    expectedActiveRevisionId: input.expectedActiveRevisionId,
    snapshotId: input.snapshotId,
    handlerFamily: input.handlerFamily,
    handlerVersion: input.handlerVersion,
    registryVersion: input.registryVersion,
    rankingPolicyVersion: input.rankingPolicyVersion,
    expectedValue: input.expectedValue,
    expectedValueUnit: input.expectedValueUnit,
    valueMethodId: input.valueMethodId,
    valueMethodVersion: input.valueMethodVersion,
    valueWindowFrom: input.valueWindowFrom,
    valueWindowTo: input.valueWindowTo,
    reasonCodes: input.reasonCodes,
    createdAt: input.createdAt,
    findingLinks: [
      {
        findingId: input.findingId,
        ceuPoolId: input.ceuPoolId,
        evidenceRole: "PRIMARY",
        contributionCeuPerWeek: input.contributionCeuPerWeek,
        ownsValue: input.ownsValue,
      },
    ],
  });
}

export function publishCompositionSnapshot(db: Db, snapshotId: string): void {
  const result = db
    .prepare("UPDATE hre_composition_snapshots SET state = 'PUBLISHED' WHERE snapshot_id = ?")
    .run(snapshotId);
  if (result.changes !== 1) throw new Error("hre composition snapshot not found");
}

export interface RecommendationGraphProjection {
  readonly recommendationId: string;
  readonly activeRevisionId: string;
  readonly compositionSnapshotId: string;
  readonly state: "DRAFT" | "PUBLISHED";
  readonly reasonCodes: readonly string[];
  readonly findingIds: readonly string[];
}

/** Reads a revision only when its stable identity, snapshot, and finding links agree. */
export function readRecommendationGraph(
  db: Db,
  recommendationId: string,
): RecommendationGraphProjection | null {
  const row = db
    .prepare(
      `SELECT recommendation.recommendation_id, recommendation.active_revision_id,
              revision.composition_snapshot_id, snapshot.state, revision.reason_codes_json
         FROM hre_recommendations recommendation
         JOIN hre_recommendation_revisions revision
           ON revision.recommendation_revision_id = recommendation.active_revision_id
          AND revision.recommendation_id = recommendation.recommendation_id
         JOIN hre_composition_snapshots snapshot
           ON snapshot.snapshot_id = revision.composition_snapshot_id
        WHERE recommendation.recommendation_id = ?`,
    )
    .get(recommendationId) as
    | {
        recommendation_id: string;
        active_revision_id: string;
        composition_snapshot_id: string;
        state: "DRAFT" | "PUBLISHED";
        reason_codes_json: string;
      }
    | undefined;
  if (row === undefined) return null;
  const reasonCodes = JSON.parse(row.reason_codes_json) as unknown;
  if (!Array.isArray(reasonCodes) || reasonCodes.some((value) => typeof value !== "string"))
    return null;
  try {
    requireSafeCodes(reasonCodes, "persisted revision reason codes");
  } catch {
    return null;
  }
  const findings = db
    .prepare(
      `SELECT finding_id FROM hre_recommendation_findings
        WHERE recommendation_revision_id = ? AND composition_snapshot_id = ?
        ORDER BY finding_id`,
    )
    .all(row.active_revision_id, row.composition_snapshot_id) as { finding_id: string }[];
  if (findings.length === 0) return null;
  return {
    recommendationId: row.recommendation_id,
    activeRevisionId: row.active_revision_id,
    compositionSnapshotId: row.composition_snapshot_id,
    state: row.state,
    reasonCodes,
    findingIds: findings.map((finding) => finding.finding_id),
  };
}

export interface LifecycleEventInput {
  readonly recommendationId: string;
  readonly recommendationRevisionId: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly reasonCode: string;
  readonly createdAt: string;
}

export function appendRecommendationLifecycleEvent(db: Db, input: LifecycleEventInput): number {
  requireSafeCode(input.reasonCode, "lifecycle reason code");
  const current = db
    .prepare(
      `SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no
         FROM hre_recommendation_lifecycle_events WHERE recommendation_id = ?`,
    )
    .get(input.recommendationId) as { sequence_no: number };
  const sequenceNo = current.sequence_no + 1;
  db.prepare(
    `INSERT INTO hre_recommendation_lifecycle_events
      (recommendation_id, sequence_no, recommendation_revision_id, from_state, to_state,
       reason_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.recommendationId,
    sequenceNo,
    input.recommendationRevisionId,
    input.fromState,
    input.toState,
    input.reasonCode,
    input.createdAt,
  );
  return sequenceNo;
}

export interface ArtifactRevisionInput {
  readonly artifactRevisionId: string;
  readonly recommendationRevisionId: string;
  readonly artifactKind:
    | "installable_hook"
    | "config_diff"
    | "claude_md_rule"
    | "skill"
    | "subagent_def"
    | "cc_prompt"
    | "advice";
  readonly artifactHash: string;
  readonly capabilityProfileVersion: string;
  readonly validationStatus: "VALIDATED" | "REJECTED";
  readonly rollbackAvailable: boolean;
  readonly supersedesArtifactRevisionId: string | null;
  readonly createdAt: string;
}

export function appendArtifactRevision(db: Db, input: ArtifactRevisionInput): void {
  for (const [name, value] of [
    ["artifact revision id", input.artifactRevisionId],
    ["recommendation revision id", input.recommendationRevisionId],
    ["artifact hash", input.artifactHash],
    ["capability profile version", input.capabilityProfileVersion],
  ] as const)
    requireOpaqueId(value, name);
  db.prepare(
    `INSERT INTO hre_artifact_revisions
      (artifact_revision_id, recommendation_revision_id, artifact_kind, artifact_hash,
       capability_profile_version, validation_status, rollback_available,
       supersedes_artifact_revision_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.artifactRevisionId,
    input.recommendationRevisionId,
    input.artifactKind,
    input.artifactHash,
    input.capabilityProfileVersion,
    input.validationStatus,
    input.rollbackAvailable ? 1 : 0,
    input.supersedesArtifactRevisionId,
    input.createdAt,
  );
}

export interface FrozenMeasurementDefinition {
  readonly targetDirection: "REDUCE" | "INCREASE" | "HOLD";
  readonly horizonDays: number;
  readonly baselineCohortCode: string;
  readonly afterCohortCode: string;
  readonly guardrailCodes: readonly string[];
  readonly comparabilityCode: string;
}

export interface MeasurementMethodInput {
  readonly measurementMethodId: string;
  readonly artifactRevisionId: string;
  readonly methodVersion: string;
  readonly targetMetricCode: string;
  readonly verdict: "AUTOMATIC" | "VALIDATED_PROXY" | "MANUAL" | "UNMEASURABLE";
  readonly definition: FrozenMeasurementDefinition;
  readonly createdAt: string;
}

export function appendMeasurementMethod(db: Db, input: MeasurementMethodInput): void {
  for (const [name, value] of [
    ["measurement method id", input.measurementMethodId],
    ["artifact revision id", input.artifactRevisionId],
    ["method version", input.methodVersion],
  ] as const)
    requireOpaqueId(value, name);
  requireSafeCode(input.targetMetricCode, "target metric code");
  requireSafeCode(input.definition.baselineCohortCode, "baseline cohort code");
  requireSafeCode(input.definition.afterCohortCode, "after cohort code");
  requireSafeCode(input.definition.comparabilityCode, "comparability code");
  requireSafeCodes(input.definition.guardrailCodes, "guardrail codes", 8);
  const definitionKeys = Object.keys(input.definition).sort();
  const expectedKeys = [
    "afterCohortCode",
    "baselineCohortCode",
    "comparabilityCode",
    "guardrailCodes",
    "horizonDays",
    "targetDirection",
  ];
  if (
    definitionKeys.length !== expectedKeys.length ||
    definitionKeys.some((key, index) => key !== expectedKeys[index])
  )
    throw new Error("measurement definition must use the closed privacy-safe shape");
  if (
    !Number.isSafeInteger(input.definition.horizonDays) ||
    input.definition.horizonDays < 1 ||
    input.definition.horizonDays > 365
  )
    throw new Error("measurement horizon must be bounded");
  db.prepare(
    `INSERT INTO hre_measurement_methods
      (measurement_method_id, artifact_revision_id, method_version, target_metric_code,
       verdict, frozen_definition_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.measurementMethodId,
    input.artifactRevisionId,
    input.methodVersion,
    input.targetMetricCode,
    input.verdict,
    JSON.stringify(input.definition),
    input.createdAt,
  );
}

export interface ArtifactApplicationInput {
  readonly artifactApplicationId: string;
  readonly artifactRevisionId: string;
  readonly observedRecommendationRevisionId: string;
  readonly authorizationId: string;
  readonly applicationSource: "MACHINE_CONFIRMED" | "USER_ATTESTED";
  readonly baseHash: string;
  readonly postHash: string | null;
  readonly result: "APPLIED" | "FAILED" | "ROLLED_BACK";
  readonly rollbackState: "AVAILABLE" | "UNAVAILABLE" | "COMPLETED";
  readonly appliedAt: string | null;
  readonly createdAt: string;
}

export function appendArtifactApplication(db: Db, input: ArtifactApplicationInput): void {
  for (const [name, value] of [
    ["artifact application id", input.artifactApplicationId],
    ["artifact revision id", input.artifactRevisionId],
    ["observed recommendation revision id", input.observedRecommendationRevisionId],
    ["authorization id", input.authorizationId],
    ["base hash", input.baseHash],
  ] as const)
    requireOpaqueId(value, name);
  if (input.postHash !== null) requireOpaqueId(input.postHash, "post hash");
  db.prepare(
    `INSERT INTO hre_artifact_applications
      (artifact_application_id, artifact_revision_id, observed_recommendation_revision_id,
       authorization_id, application_source, base_hash, post_hash, result, rollback_state,
       applied_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.artifactApplicationId,
    input.artifactRevisionId,
    input.observedRecommendationRevisionId,
    input.authorizationId,
    input.applicationSource,
    input.baseHash,
    input.postHash,
    input.result,
    input.rollbackState,
    input.appliedAt,
    input.createdAt,
  );
}

export interface EffectCycleLinkInput {
  readonly cycleId: string;
  readonly recommendationId: string;
  readonly recommendationRevisionId: string;
  readonly artifactRevisionId: string;
  readonly artifactApplicationId: string;
  readonly measurementMethodId: string;
  readonly interventionLockKey: string;
  readonly createdAt: string;
}

export function appendEffectCycleLink(db: Db, input: EffectCycleLinkInput): void {
  for (const value of Object.values(input)) requireOpaqueId(value, "effect link value");
  db.prepare(
    `INSERT INTO hre_effect_cycle_links
      (cycle_id, recommendation_id, recommendation_revision_id, artifact_revision_id,
       artifact_application_id, measurement_method_id, intervention_lock_key, bridge_kind,
       created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ARTIFACT_BOUND', ?)`,
  ).run(
    input.cycleId,
    input.recommendationId,
    input.recommendationRevisionId,
    input.artifactRevisionId,
    input.artifactApplicationId,
    input.measurementMethodId,
    input.interventionLockKey,
    input.createdAt,
  );
}

export interface InterventionLockInput {
  readonly lockId: string;
  readonly interventionLockKey: string;
  readonly cycleId: string;
  readonly artifactApplicationId: string;
  readonly confoundedOverride: boolean;
  readonly conflictsWithLockId: string | null;
  readonly conflictReasonCode: string | null;
  readonly createdAt: string;
}

export function acquireInterventionLock(db: Db, input: InterventionLockInput): void {
  for (const [name, value] of [
    ["lock id", input.lockId],
    ["intervention lock key", input.interventionLockKey],
    ["cycle id", input.cycleId],
    ["artifact application id", input.artifactApplicationId],
  ] as const)
    requireOpaqueId(value, name);
  if (input.conflictReasonCode !== null)
    requireSafeCode(input.conflictReasonCode, "conflict reason code");
  db.prepare(
    `INSERT INTO hre_intervention_locks
      (lock_id, intervention_lock_key, cycle_id, artifact_application_id, state,
       confounded_override, conflicts_with_lock_id, conflict_reason_code, created_at)
     VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
  ).run(
    input.lockId,
    input.interventionLockKey,
    input.cycleId,
    input.artifactApplicationId,
    input.confoundedOverride ? 1 : 0,
    input.conflictsWithLockId,
    input.conflictReasonCode,
    input.createdAt,
  );
}

export function releaseInterventionLock(db: Db, lockId: string, releasedAt: string): void {
  const result = db
    .prepare(
      `UPDATE hre_intervention_locks SET state = 'RELEASED', released_at = ?
        WHERE lock_id = ? AND state = 'OPEN'`,
    )
    .run(releasedAt, lockId);
  if (result.changes !== 1) throw new Error("open hre intervention lock not found");
}

export type EffectCycleBridge =
  | { readonly bridgeKind: "LEGACY_UNLINKED"; readonly cycleId: string }
  | {
      readonly bridgeKind: "ARTIFACT_BOUND";
      readonly cycleId: string;
      readonly recommendationId: string;
      readonly recommendationRevisionId: string;
      readonly artifactRevisionId: string;
      readonly artifactApplicationId: string;
      readonly measurementMethodId: string;
      readonly interventionLockKey: string;
    };

/** Old effect cycles remain readable, explicitly marked as not artifact-linked. */
export function readEffectCycleBridge(db: Db, cycleId: string): EffectCycleBridge | null {
  const legacy = db.prepare("SELECT cycle_id FROM effect_cycles WHERE cycle_id = ?").get(cycleId) as
    | { cycle_id: string }
    | undefined;
  if (legacy === undefined) return null;
  const linked = db
    .prepare(
      `SELECT cycle_id, recommendation_id, recommendation_revision_id,
              artifact_revision_id, artifact_application_id, measurement_method_id,
              intervention_lock_key
         FROM hre_effect_cycle_links WHERE cycle_id = ?`,
    )
    .get(cycleId) as
    | {
        cycle_id: string;
        recommendation_id: string;
        recommendation_revision_id: string;
        artifact_revision_id: string;
        artifact_application_id: string;
        measurement_method_id: string;
        intervention_lock_key: string;
      }
    | undefined;
  return linked === undefined
    ? { bridgeKind: "LEGACY_UNLINKED", cycleId: legacy.cycle_id }
    : {
        bridgeKind: "ARTIFACT_BOUND",
        cycleId: linked.cycle_id,
        recommendationId: linked.recommendation_id,
        recommendationRevisionId: linked.recommendation_revision_id,
        artifactRevisionId: linked.artifact_revision_id,
        artifactApplicationId: linked.artifact_application_id,
        measurementMethodId: linked.measurement_method_id,
        interventionLockKey: linked.intervention_lock_key,
      };
}
