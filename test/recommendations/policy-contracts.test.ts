import { describe, expect, it } from "vitest";
import {
  decodeHistoricalHandlerSnapshotV1,
  evaluateCapabilityProfile,
  evaluateHandlerCompatibility,
} from "../../src/recommendations/capabilities.js";
import { adaptLegacyRecommendation } from "../../src/recommendations/legacy-adapter.js";
import { validateQueueCursor } from "../../src/recommendations/queue-contract.js";
import {
  RANKING_POLICY_VERSION,
  estimateSavingsUsdPerWeek,
  rankRecommendations,
} from "../../src/recommendations/ranking-policy.js";
import {
  capabilityProfile,
  handlerRegistration,
  rankingFixtures,
  valueFixture,
} from "../fixtures/recommendations/policy-fixtures.js";

describe("HRE-0 ranking-policy-2", () => {
  it("computes dollars/week from versioned factors and propagates unknown values", () => {
    expect(estimateSavingsUsdPerWeek(valueFixture)).toBe(1);
    expect(
      estimateSavingsUsdPerWeek({
        ...valueFixture,
        listPriceUsdPerCeu: { ...valueFixture.listPriceUsdPerCeu, value: null },
      }),
    ).toBeNull();
    const olderOffset = {
      ...rankingFixtures.valueLow,
      stableId: "recommendation:older-offset" as typeof rankingFixtures.valueLow.stableId,
      evidenceNewestAt: "2026-09-16T01:00:00+01:00",
    };
    const newerUtc = {
      ...rankingFixtures.valueLow,
      stableId: "recommendation:newer-utc" as typeof rankingFixtures.valueLow.stableId,
      evidenceNewestAt: "2026-09-16T00:30:00.000Z",
    };
    expect(rankRecommendations([olderOffset, newerUtc]).at(0)?.candidate.stableId).toBe(
      newerUtc.stableId,
    );
    expect(
      estimateSavingsUsdPerWeek({
        ...valueFixture,
        detectorConfidence: { ...valueFixture.detectorConfidence, value: 1.1 },
      }),
    ).toBeNull();
  });

  it("bounds reviewed safety pins before applying deterministic value order", () => {
    const ranked = rankRecommendations(
      [
        rankingFixtures.valueUnknown,
        rankingFixtures.safetyOverflow,
        rankingFixtures.valueLow,
        rankingFixtures.unreviewedSafety,
        rankingFixtures.safetyTwo,
        rankingFixtures.valueHigh,
        rankingFixtures.safetyOne,
      ],
      2,
    );
    expect(ranked.map(({ candidate }) => candidate.stableId)).toEqual([
      rankingFixtures.safetyOne.stableId,
      rankingFixtures.safetyTwo.stableId,
      rankingFixtures.unreviewedSafety.stableId,
      rankingFixtures.safetyOverflow.stableId,
      rankingFixtures.valueHigh.stableId,
      rankingFixtures.valueLow.stableId,
      rankingFixtures.valueUnknown.stableId,
    ]);
    expect(ranked.slice(0, 2).map(({ rankKey }) => rankKey.safetyPinOrdinal)).toEqual([0, 1]);
    expect(ranked.slice(2).every(({ rankKey }) => rankKey.safetyPinOrdinal === null)).toBe(true);
  });

  it("enforces the policy maximum even when a caller requests a larger safety block", () => {
    const ranked = rankRecommendations(
      [
        rankingFixtures.safetyFour,
        rankingFixtures.safetyOverflow,
        rankingFixtures.safetyTwo,
        rankingFixtures.safetyOne,
        rankingFixtures.valueHigh,
      ],
      999,
    );
    expect(ranked.map(({ rankKey }) => rankKey.safetyPinOrdinal)).toEqual([0, 1, 2, null, null]);
    expect(ranked.at(3)?.candidate.stableId).toBe(rankingFixtures.valueHigh.stableId);
  });

  it("normalizes malformed rank values before comparison and rejects overflow estimates", () => {
    const malformedA = {
      ...rankingFixtures.valueLow,
      stableId: "recommendation:malformed-a" as typeof rankingFixtures.valueLow.stableId,
      expectedSavingsUsdPerWeek: Number.NaN,
      confidence: Number.NaN,
      applicability: Number.POSITIVE_INFINITY,
      evidenceNewestAt: "not-a-timestamp",
    };
    const malformedB = {
      ...malformedA,
      stableId: "recommendation:malformed-b" as typeof rankingFixtures.valueLow.stableId,
    };
    const ranked = rankRecommendations([malformedB, malformedA]);
    expect(ranked.map(({ candidate }) => candidate.stableId)).toEqual([
      malformedA.stableId,
      malformedB.stableId,
    ]);
    expect(ranked[0]?.rankKey).toMatchObject({
      expectedSavingsUsdPerWeek: null,
      confidence: 0,
      applicability: 0,
      evidenceNewestAt: "",
    });
    expect(
      estimateSavingsUsdPerWeek({
        ...valueFixture,
        exclusivePoolCeuPerWeek: {
          ...valueFixture.exclusivePoolCeuPerWeek,
          value: Number.MAX_VALUE,
        },
        listPriceUsdPerCeu: { ...valueFixture.listPriceUsdPerCeu, value: 2 },
      }),
    ).toBeNull();
  });

  it("uses stable identity as the final tie breaker", () => {
    const a = {
      ...rankingFixtures.valueLow,
      stableId: "recommendation:a" as typeof rankingFixtures.valueLow.stableId,
    };
    const b = {
      ...rankingFixtures.valueLow,
      stableId: "recommendation:b" as typeof rankingFixtures.valueLow.stableId,
    };
    expect(rankRecommendations([b, a]).map(({ candidate }) => candidate.stableId)).toEqual([
      a.stableId,
      b.stableId,
    ]);
  });
});

describe("HRE-0 capability and registry contracts", () => {
  it("accepts only current locally verified capabilities", () => {
    expect(
      evaluateCapabilityProfile(
        capabilityProfile,
        [
          {
            capability: "settings.permissions.allow",
            allowedSources: ["LOCAL_CANARY"],
            allowedCanaryVersions: ["permission-canary-1"],
          },
        ],
        "2026-09-17T00:00:00.000Z",
      ),
    ).toEqual({ kind: "SUPPORTED" });
    expect(
      evaluateCapabilityProfile(
        capabilityProfile,
        [
          {
            capability: "settings.permissions.allow",
            allowedSources: ["LOCAL_CANARY"],
            allowedCanaryVersions: ["permission-canary-1"],
          },
        ],
        "2026-09-19T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "CAPABILITY_PROFILE_EXPIRED" });
  });

  it("fails closed for research-only, contradicted, retired, or mismatched handlers", () => {
    expect(
      evaluateCapabilityProfile(
        {
          ...capabilityProfile,
          observations: capabilityProfile.observations.map((observation) => ({
            ...observation,
            source: "RESEARCH_ONLY" as const,
          })),
        },
        [
          {
            capability: "settings.permissions.allow",
            allowedSources: ["LOCAL_CANARY"],
            allowedCanaryVersions: ["permission-canary-1"],
          },
        ],
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "CAPABILITY_UNVERIFIED" });
    expect(
      evaluateCapabilityProfile(
        {
          ...capabilityProfile,
          observations: capabilityProfile.observations.map((observation) => ({
            ...observation,
            verdict: "CONTRADICTED" as const,
          })),
        },
        [
          {
            capability: "settings.permissions.allow",
            allowedSources: ["LOCAL_CANARY"],
            allowedCanaryVersions: ["permission-canary-1"],
          },
        ],
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "CAPABILITY_CONTRADICTED" });
    expect(
      evaluateHandlerCompatibility(
        handlerRegistration,
        { detectorId: "C9", evidenceSchemaVersion: 2, artifactKind: "config_diff" },
        capabilityProfile,
        "2026-09-17T00:00:00.000Z",
      ),
    ).toEqual({ kind: "SUPPORTED" });
    expect(
      evaluateHandlerCompatibility(
        { ...handlerRegistration, status: "RETIRED" },
        { detectorId: "C9", evidenceSchemaVersion: 2, artifactKind: "config_diff" },
        capabilityProfile,
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "HANDLER_RETIRED" });
    expect(
      evaluateHandlerCompatibility(
        handlerRegistration,
        { detectorId: "C9", evidenceSchemaVersion: 1, artifactKind: "config_diff" },
        capabilityProfile,
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "EVIDENCE_SCHEMA_UNSUPPORTED" });
  });

  it("rejects malformed, future, and unversioned local capability evidence", () => {
    const requirement = [
      {
        capability: "settings.permissions.allow",
        allowedSources: ["LOCAL_CANARY" as const],
        allowedCanaryVersions: ["permission-canary-1"],
      },
    ];
    expect(
      evaluateCapabilityProfile(
        { ...capabilityProfile, expiresAt: "not-a-timestamp" },
        requirement,
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE" });
    expect(
      evaluateCapabilityProfile(
        {
          ...capabilityProfile,
          observations: capabilityProfile.observations.map((observation) => ({
            ...observation,
            canaryVersion: null,
          })),
        },
        requirement,
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "CAPABILITY_OBSERVATION_INVALID" });
    expect(
      evaluateCapabilityProfile(
        {
          ...capabilityProfile,
          observations: capabilityProfile.observations.map((observation) => ({
            ...observation,
            canaryVersion: "obsolete-canary",
          })),
        },
        requirement,
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "CAPABILITY_UNVERIFIED" });
    expect(
      evaluateCapabilityProfile(
        {
          ...capabilityProfile,
          observations: capabilityProfile.observations.map((observation) => ({
            ...observation,
            observedAt: "2026-09-17T00:00:00.001Z",
          })),
        },
        requirement,
        "2026-09-17T00:00:00.000Z",
      ),
    ).toMatchObject({ kind: "INVESTIGATE", reasonCode: "CAPABILITY_OBSERVATION_INVALID" });
  });

  it("decodes historical snapshots only through closed structural labels", () => {
    const allowlist = {
      handlerIdentities: new Set(["permission-friction@handler-1"]),
      registryVersions: new Set(["handler-registry-1"]),
      reasonCodes: new Set(["EXPECTED_VALUE_ORDER"]),
      aggregateRules: new Map([
        [
          "ESTIMATED_SAVINGS_USD",
          {
            kind: "NUMBER" as const,
            minimum: 0,
            maximum: 1_000_000,
            maximumDecimalPlaces: 2,
            nullable: false,
          },
        ],
      ]),
      guardrailCodes: new Set(["CAPABILITY_VERIFIED"]),
      maxReasonCodes: 8,
      maxAggregateEntries: 8,
      maxGuardrailResults: 8,
    };
    const snapshot = {
      schemaVersion: 1,
      handlerFamily: "permission-friction",
      handlerVersion: "handler-1",
      registryVersion: "handler-registry-1",
      reasonCodes: ["EXPECTED_VALUE_ORDER"],
      aggregateEvidence: [{ code: "ESTIMATED_SAVINGS_USD", value: 12.5 }],
      guardrailResults: [{ code: "CAPABILITY_VERIFIED", passed: true }],
    };
    expect(decodeHistoricalHandlerSnapshotV1(snapshot, allowlist)).not.toBeNull();
    expect(
      decodeHistoricalHandlerSnapshotV1(
        { ...snapshot, aggregateEvidence: { "raw command --secret": 1 } },
        allowlist,
      ),
    ).toBeNull();
    expect(
      decodeHistoricalHandlerSnapshotV1(
        { ...snapshot, aggregateEvidence: [{ code: "raw command --secret", value: 1 }] },
        allowlist,
      ),
    ).toBeNull();
    expect(
      decodeHistoricalHandlerSnapshotV1(
        {
          ...snapshot,
          aggregateEvidence: [
            { code: "ESTIMATED_SAVINGS_USD", value: 1 },
            { code: "ESTIMATED_SAVINGS_USD", value: 2 },
          ],
        },
        allowlist,
      ),
    ).toBeNull();
    expect(
      decodeHistoricalHandlerSnapshotV1(
        {
          ...snapshot,
          aggregateEvidence: [{ code: "ESTIMATED_SAVINGS_USD", value: 12.345 }],
        },
        allowlist,
      ),
    ).toBeNull();
    expect(
      decodeHistoricalHandlerSnapshotV1(snapshot, {
        ...allowlist,
        aggregateRules: new Map([
          [
            "ESTIMATED_SAVINGS_USD",
            {
              kind: "NUMBER" as const,
              minimum: Number.NaN,
              maximum: Number.NaN,
              maximumDecimalPlaces: 2,
              nullable: false,
            },
          ],
        ]),
      }),
    ).toBeNull();
  });
});

describe("HRE-0 queue and legacy compatibility contracts", () => {
  const snapshot = {
    compositionSnapshotId: "composition:fixture",
    compositionVersion: 3,
    rankingPolicyVersion: RANKING_POLICY_VERSION,
  } as const;
  const cursorRankKey = rankRecommendations([rankingFixtures.valueLow]).at(0)?.rankKey;
  if (cursorRankKey === undefined) throw new Error("ranking fixture must produce one rank key");
  const cursor = {
    version: 1,
    snapshot,
    after: cursorRankKey,
  } as const;

  it("accepts an exact immutable snapshot cursor and refreshes stale snapshots", () => {
    expect(
      validateQueueCursor(cursor, snapshot, new Set([snapshot.compositionSnapshotId])),
    ).toEqual({
      kind: "VALID",
      after: cursor.after,
    });
    expect(
      validateQueueCursor(
        cursor,
        { ...snapshot, compositionVersion: 4 },
        new Set([snapshot.compositionSnapshotId]),
      ),
    ).toEqual({ kind: "REFRESH_REQUIRED", reason: "SNAPSHOT_CHANGED" });
    expect(validateQueueCursor(cursor, snapshot, new Set())).toEqual({
      kind: "REFRESH_REQUIRED",
      reason: "SNAPSHOT_EXPIRED",
    });
  });

  it("adapts only validated detector findings and preserves legacy unlinking", () => {
    const base = {
      recId: "legacy:C9:fixture",
      detectorId: "C9",
      contractStatus: "V2_VALIDATED" as const,
      contractVersion: 2,
      findingKind: "FINDING" as const,
      state: "PROPOSED" as const,
      createdAt: "2026-09-16T00:00:00.000Z",
    };
    expect(adaptLegacyRecommendation(base)).toMatchObject({
      kind: "ADAPTED",
      finding: { lifecycle: "OPEN", effectLinkState: "LEGACY_UNLINKED", contractVersion: 2 },
    });
    expect(adaptLegacyRecommendation({ ...base, findingKind: "HEALTH" })).toEqual({
      kind: "EXCLUDED",
      reason: "NON_FINDING",
    });
    expect(
      adaptLegacyRecommendation({
        ...base,
        contractStatus: "LEGACY_UNVERIFIED",
        contractVersion: null,
      }),
    ).toEqual({ kind: "EXCLUDED", reason: "UNVERIFIED_CONTRACT" });
  });
});
