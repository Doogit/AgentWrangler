import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  CapabilityProfile,
  HandlerRegistration,
} from "../../src/recommendations/capabilities.js";
import { type EngineFinding, correlateFindings } from "../../src/recommendations/correlation.js";
import { type EngineContext, composeRecommendation } from "../../src/recommendations/engine.js";
import type { HandlerImplementation } from "../../src/recommendations/registry.js";
import { compareShadow } from "../../src/recommendations/shadow.js";

const NOW = "2026-09-16T00:00:00.000Z";
const profile: CapabilityProfile = {
  id: "profile",
  version: "p1",
  claudeCodeVersion: "1",
  platform: "WINDOWS",
  workspaceScope: "w",
  createdAt: "2026-09-15T00:00:00.000Z",
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
  acceptedEvidence: [
    { detectorId: "detector", schemaVersion: 1 },
    { detectorId: "other", schemaVersion: 2 },
  ],
  artifactKinds: ["advice"],
  capabilityRequirements: [
    { capability: "synthetic", allowedSources: ["VERSION_GATE"], allowedCanaryVersions: [] },
  ],
  correlationKeyVersion: "1",
  priorityClass: "VALUE",
  generatorVersion: "g1",
  validatorVersions: ["v2", "v1"],
  measurementFactoryVersion: "m1",
  applicabilityEstimatorVersion: "a1",
  supersededBy: null,
  historicalDecoderVersion: "1",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const artifactId = (value: string) => `artifact:${hash(value)}`;
const measurementId = (value: string) => `measurement:${hash(value)}`;
const artifact = (changes: Record<string, unknown> = {}) => ({
  artifactRevisionId: artifactId("artifact-1"),
  kind: "advice" as const,
  validationStatus: "VALIDATED" as const,
  validated: true,
  artifactHash: hash("artifact-hash"),
  scopeHash: hash("scope-hash"),
  targetHash: hash("target-hash"),
  rollbackArtifactRevisionId: artifactId("rollback-1"),
  rollbackHash: hash("rollback-hash"),
  supersedesArtifactRevisionId: null,
  createdAt: NOW,
  applyMechanismCode: "SYNTHETIC_APPLY",
  ...changes,
});
const implementation = (
  changes: Partial<ReturnType<HandlerImplementation["compose"]>> = {},
  registrationChanges: Partial<HandlerRegistration> = {},
): HandlerImplementation => ({
  registration: { ...registration, ...registrationChanges },
  compose: () => ({
    artifacts: [artifact()],
    measurement: {
      verdict: "AUTOMATIC",
      measurementMethodId: measurementId("measure"),
      methodVersion: "1",
      artifactRevisionId: artifactId("artifact-1"),
      targetMetricCode: "SAVINGS_USD",
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
    ...changes,
  }),
});
const factor = (methodId: string, value: number | null = 1) => ({
  value,
  methodId,
  methodVersion: "1",
  evidenceWindow: { from: "2026-09-01T00:00:00.000Z", to: NOW },
  uncertainty: { lower: value, upper: value },
});
const context = (changes: Partial<EngineContext> = {}): EngineContext => ({
  registry: { version: "r1", handlers: [implementation()] },
  profile,
  now: NOW,
  window: { from: "2026-09-01T00:00:00.000Z", to: NOW },
  compositionVersion: "c1",
  rankingPolicyVersion: "ranking-policy-2",
  value: {
    ceuProvenance: factor("ceu"),
    confidenceProvenance: factor("confidence"),
    price: factor("price", 2),
    applicability: factor("applicability"),
    expectedEffect: factor("effect"),
  },
  ...changes,
});
const finding = (
  id: string,
  key = "key",
  pool = "pool",
  changes: Partial<EngineFinding> = {},
): EngineFinding => ({
  id: id as EngineFinding["id"],
  detectorId: "detector",
  schemaVersion: 1,
  observedAt: NOW,
  correlationKey: key,
  ceuPoolId: pool as EngineFinding["ceuPoolId"],
  ceuPerWeek: 5,
  confidence: 1,
  ...changes,
});

describe("HRE-2 deterministic composition", () => {
  it("is stable under permutation, has explicit owner/supporting links, and versions change identity", () => {
    const a = composeRecommendation(
      [finding("b", "shared", "pool"), finding("a", "shared", "pool")],
      context(),
    );
    const b = composeRecommendation(
      [finding("a", "shared", "pool"), finding("b", "shared", "pool")],
      context(),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.links).toEqual([
      {
        findingId: "a",
        ceuPoolId: "pool",
        role: "PRIMARY",
        contributionCeuPerWeek: 5,
        ownsValue: true,
      },
      {
        findingId: "b",
        ceuPoolId: "pool",
        role: "SUPPORTING",
        contributionCeuPerWeek: 0,
        ownsValue: false,
      },
    ]);
    expect(a.lifecycle).toBe("ACTIONABLE");
    expect(
      composeRecommendation([finding("a", "k", "p", { confidence: 0.5 })], context()).immutableId,
    ).not.toBe(composeRecommendation([finding("a")], context()).immutableId);
    expect(
      composeRecommendation(
        [finding("a")],
        context({
          value: {
            ...context().value,
            applicability: factor("applicability", 0.5),
            expectedEffect: factor("effect", 0.5),
          },
        }),
      ).immutableId,
    ).not.toBe(composeRecommendation([finding("a")], context()).immutableId);
    for (const changed of [
      context({ compositionVersion: "c2" }),
      context({ rankingPolicyVersion: "ranking-policy-3" }),
      context({
        registry: { version: "r1", handlers: [implementation({}, { generatorVersion: "g2" })] },
      }),
      context({ profile: { ...profile, version: "p2" } }),
      context({ value: { ...context().value, price: factor("price", 3) } }),
    ])
      expect(composeRecommendation([finding("a")], changed).immutableId).not.toBe(
        composeRecommendation([finding("a")], context()).immutableId,
      );
  });
  it("rejects conflicting correlations, invalid timestamps/confidence, duplicates and floating CEU", () => {
    expect(correlateFindings([finding("a", "k", "p"), finding("b", "k", "other")]).valid).toBe(
      false,
    );
    expect(correlateFindings([finding("a", "k", "p"), finding("b", "other", "p")]).valid).toBe(
      false,
    );
    for (const bad of [
      finding("a", "k", "p", { observedAt: "bad" }),
      finding("a", "k", "p", { confidence: 2 }),
      finding("a", "k", "p", { ceuPerWeek: 0.0000001 }),
    ])
      expect(composeRecommendation([bad], context()).lifecycle).toBe("INVESTIGATE");
    expect(composeRecommendation([finding("a"), finding("a")], context()).lifecycle).toBe(
      "INVESTIGATE",
    );
  });
  it("requires every evidence shape, price, validated rollback artifact, and automatic measurement", () => {
    expect(
      composeRecommendation(
        [
          finding("a"),
          finding("b", "other-key", "other", { detectorId: "other", schemaVersion: 2 }),
        ],
        context(),
      ).lifecycle,
    ).toBe("ACTIONABLE");
    expect(
      composeRecommendation([finding("a", "k", "p", { detectorId: "missing" })], context())
        .reasonCodes,
    ).toContain("EVIDENCE_SCHEMA_UNSUPPORTED");
    expect(
      composeRecommendation([finding("a")], context({ registry: { version: "r1", handlers: [] } }))
        .reasonCodes,
    ).toContain("HANDLER_UNAVAILABLE");
    expect(
      composeRecommendation(
        [finding("a")],
        context({ value: { ...context().value, price: factor("price", null) } }),
      ).lifecycle,
    ).toBe("INVESTIGATE");
    const zeroValue = composeRecommendation(
      [finding("a")],
      context({ value: { ...context().value, price: factor("price", 0) } }),
    );
    expect(zeroValue.lifecycle).toBe("INVESTIGATE");
    expect(zeroValue.reasonCodes).toContain("VALUE_NOT_POSITIVE");
    expect(
      composeRecommendation(
        [finding("a")],
        context({
          registry: {
            version: "r1",
            handlers: [
              implementation({
                artifacts: [artifact({ rollbackHash: "" })],
              }),
            ],
          },
        }),
      ).lifecycle,
    ).toBe("INVESTIGATE");
    expect(
      composeRecommendation(
        [finding("a")],
        context({
          registry: {
            version: "r1",
            handlers: [
              implementation({
                measurement: {
                  verdict: "MANUAL",
                  measurementMethodId: measurementId("m"),
                  methodVersion: "1",
                  artifactRevisionId: artifactId("artifact-1"),
                  targetMetricCode: "SAVINGS_USD",
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
            ],
          },
        }),
      ).lifecycle,
    ).toBe("INVESTIGATE");
    expect(
      composeRecommendation(
        [finding("a")],
        context({
          registry: { version: "r1", handlers: [implementation({}, { status: "RETIRED" })] },
        }),
      ).lifecycle,
    ).toBe("INVESTIGATE");
  });
  it("sums each exclusive pool with its own confidence and rejects unbound measurement or incomplete rollback scope", () => {
    expect(
      composeRecommendation(
        [
          finding("a", "ka", "pa", { ceuPerWeek: 5, confidence: 0.2 }),
          finding("b", "kb", "pb", { ceuPerWeek: 5, confidence: 0.8 }),
        ],
        context(),
      ).expectedSavingsUsdPerWeek,
    ).toBe(10);
    expect(
      composeRecommendation(
        [finding("a")],
        context({
          registry: {
            version: "r1",
            handlers: [
              implementation({
                measurement: {
                  verdict: "AUTOMATIC",
                  measurementMethodId: measurementId("m"),
                  methodVersion: "1",
                  artifactRevisionId: artifactId("other"),
                  targetMetricCode: "SAVINGS_USD",
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
            ],
          },
        }),
      ).lifecycle,
    ).toBe("INVESTIGATE");
    expect(
      composeRecommendation(
        [finding("a")],
        context({
          registry: {
            version: "r1",
            handlers: [implementation({ artifacts: [artifact({ scopeHash: "" })] })],
          },
        }),
      ).lifecycle,
    ).toBe("INVESTIGATE");
    const unsafeArtifact = composeRecommendation(
      [finding("a")],
      context({
        registry: {
          version: "r1",
          handlers: [implementation({ artifacts: [artifact({ scopeHash: "raw scope text" })] })],
        },
      }),
    );
    expect(unsafeArtifact.lifecycle).toBe("INVESTIGATE");
    expect(JSON.stringify(unsafeArtifact)).not.toContain("raw scope text");
  });
  it("rejects secret-shaped structural IDs and hashes, duplicate artifacts, and never emits an invalid measurement", () => {
    const invalid = composeRecommendation(
      [finding("a")],
      context({
        registry: {
          version: "r1",
          handlers: [
            implementation({
              artifacts: [
                artifact({
                  artifactRevisionId: "sk-not-a-structural-id",
                  artifactHash: "deadbeef",
                }),
              ],
            }),
          ],
        },
      }),
    );
    expect(invalid.artifacts).toEqual([]);
    expect(invalid.measurement).toBeNull();
    const duplicate = composeRecommendation(
      [finding("a")],
      context({
        registry: {
          version: "r1",
          handlers: [
            implementation({ artifacts: [artifact(), artifact({ artifactHash: hash("second") })] }),
          ],
        },
      }),
    );
    expect(duplicate.artifacts).toEqual([]);
    expect(duplicate.lifecycle).toBe("INVESTIGATE");
  });
  it("fails the whole handler output closed and strips handler-only payload fields", () => {
    const mixed = composeRecommendation(
      [finding("a")],
      context({
        registry: {
          version: "r1",
          handlers: [
            implementation({
              artifacts: [artifact(), artifact({ artifactHash: "not-a-sha" })],
            }),
          ],
        },
      }),
    );
    expect(mixed.lifecycle).toBe("INVESTIGATE");
    expect(mixed.artifacts).toEqual([]);
    expect(mixed.measurement).toBeNull();
    const marked = composeRecommendation(
      [finding("a")],
      context({
        registry: {
          version: "r1",
          handlers: [
            implementation({
              artifacts: [artifact({ handlerSecretMarker: "artifact-marker" })],
              measurement: {
                verdict: "AUTOMATIC",
                measurementMethodId: measurementId("measure"),
                methodVersion: "1",
                artifactRevisionId: artifactId("artifact-1"),
                targetMetricCode: "SAVINGS_USD",
                definition: {
                  targetDirection: "REDUCE",
                  horizonDays: 7,
                  baselineCohortCode: "BASELINE",
                  afterCohortCode: "AFTER",
                  guardrailCodes: ["GUARDRAIL"],
                  comparabilityCode: "MATCHED",
                  handlerSecretMarker: "definition-marker",
                },
                createdAt: NOW,
                handlerSecretMarker: "measurement-marker",
              } as never,
            }),
          ],
        },
      }),
    );
    expect(marked.artifacts).toEqual([]);
    expect(marked.measurement).toBeNull();
    expect(JSON.stringify(marked)).not.toContain("marker");
  });
  it("fails closed without throwing on malformed runtime handler values", () => {
    const malformedArtifact = composeRecommendation(
      [finding("a")],
      context({
        registry: {
          version: "r1",
          handlers: [implementation({ artifacts: [null] as never })],
        },
      }),
    );
    expect(malformedArtifact).toMatchObject({
      lifecycle: "INVESTIGATE",
      artifacts: [],
      measurement: null,
    });

    const malformedDefinition = composeRecommendation(
      [finding("a")],
      context({
        registry: {
          version: "r1",
          handlers: [
            implementation({
              measurement: {
                verdict: "AUTOMATIC",
                measurementMethodId: measurementId("measure"),
                methodVersion: "1",
                artifactRevisionId: artifactId("artifact-1"),
                targetMetricCode: "SAVINGS_USD",
                definition: null,
                createdAt: NOW,
              } as never,
            }),
          ],
        },
      }),
    );
    expect(malformedDefinition).toMatchObject({
      lifecycle: "INVESTIGATE",
      measurement: null,
    });
  });
});

describe("HRE-2 shadow", () => {
  it("reports identity, all structural mismatch codes, additions/removals, and only allowlisted output", () => {
    const base = {
      eligible: true,
      ownerPoolHashes: ["pool-token"],
      value: 1,
      rank: 1,
      dedupHash: "dedup-token",
    };
    const equal = compareShadow(
      [{ opaqueId: "opaque-a", ...base }],
      [{ opaqueId: "opaque-a", ...base }],
    );
    expect(equal.mismatches).toEqual([]);
    expect(
      compareShadow(
        [
          { opaqueId: "duplicate", ...base },
          { opaqueId: "duplicate", ...base },
        ],
        [{ opaqueId: "duplicate", ...base }],
      ).mismatchCounts.DEDUP,
    ).toBe(1);
    const report = compareShadow(
      [
        { opaqueId: "opaque-a", ...base },
        { opaqueId: "opaque-removed", ...base },
      ],
      [
        {
          opaqueId: "opaque-a",
          eligible: false,
          ownerPoolHashes: ["different"],
          value: 2,
          rank: 2,
          dedupHash: "different",
        },
        { opaqueId: "opaque-added", ...base },
      ],
    );
    expect(report.mismatchCounts).toMatchObject({
      ELIGIBILITY: 1,
      CEU_OWNER: 1,
      VALUE: 1,
      RANK: 1,
      DEDUP: 1,
      ADDED: 1,
      REMOVED: 1,
    });
    const serialized = JSON.stringify(report);
    expect(Object.keys(report).sort()).toEqual([
      "compared",
      "mismatchCounts",
      "mismatches",
      "totals",
    ]);
    for (const secret of ["opaque-a", "pool-token", "dedup-token", "different"])
      expect(serialized).not.toContain(secret);
  });
});
