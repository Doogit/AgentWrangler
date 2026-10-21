import { describe, expect, it } from "vitest";
import type { CapabilityProfile } from "../../../../src/recommendations/capabilities.js";
import type { EngineFinding } from "../../../../src/recommendations/correlation.js";
import {
  type EngineContext,
  composeRecommendation,
} from "../../../../src/recommendations/engine.js";
import {
  H4_APPLICABILITY_ESTIMATOR_ID,
  H4_GENERATOR_ID,
  H4_HANDLER_FAMILY,
  H4_HANDLER_VERSION,
  H4_HOOK_POSTURE,
  H4_MEASUREMENT_FACTORY_ID,
  H4_MEASUREMENT_VALIDATOR_ID,
  H4_PROMPT_VALIDATOR_ID,
  H4_SUPPORTED_DETECTORS,
  createH4ErrorLoopHandler,
  evaluateH4Measurement,
  generateH4ErrorLoopPack,
  validateH4GeneratedPack,
} from "../../../../src/recommendations/handlers/h4-error-loop/index.js";
import {
  H4_FIXTURE_NOW,
  H4_FIXTURE_WINDOW,
  actionableFixture,
  conflictingFixture,
  falsePositiveFixture,
  h4Finding,
  healthyNoChangeFixture,
  malformedFixture,
  measurementFixtures,
  sparseFixture,
  supportedFamilyFixture,
} from "../../../fixtures/recommendations/handlers/h4-error-loop/fixtures.js";

const input = (findings: readonly EngineFinding[] = actionableFixture.findings) => ({
  findings,
  now: H4_FIXTURE_NOW,
  window: H4_FIXTURE_WINDOW,
});

const profile: CapabilityProfile = {
  id: "profile-h4",
  version: "profile-h4-1",
  claudeCodeVersion: "1",
  platform: "WINDOWS",
  workspaceScope: "workspace-opaque",
  createdAt: "2026-09-15T12:00:00.000Z",
  expiresAt: "2026-09-17T12:00:00.000Z",
  observations: [],
};

const factor = (methodId: string, value: number | null = 1) => ({
  value,
  methodId,
  methodVersion: "1",
  evidenceWindow: H4_FIXTURE_WINDOW,
  uncertainty: { lower: value, upper: value },
});

const engineContext = (): EngineContext => ({
  registry: { version: "handler-registry-1", handlers: [createH4ErrorLoopHandler()] },
  profile,
  now: H4_FIXTURE_NOW,
  window: H4_FIXTURE_WINDOW,
  compositionVersion: "hre-3b-1",
  rankingPolicyVersion: "ranking-policy-2",
  value: {
    ceuProvenance: factor("ceu"),
    confidenceProvenance: factor("confidence"),
    price: factor("price", 0.01),
    applicability: factor(H4_APPLICABILITY_ESTIMATOR_ID, 1),
    expectedEffect: factor("h4-expected-effect-1", 0.5),
  },
});

describe("HRE-3b H4 error-loop handler", () => {
  it("publishes stable generator, validator, measurement, and non-hook identities", () => {
    const registration = createH4ErrorLoopHandler().registration;
    expect(registration).toMatchObject({
      family: H4_HANDLER_FAMILY,
      version: H4_HANDLER_VERSION,
      registryVersion: "handler-registry-1",
      generatorVersion: H4_GENERATOR_ID,
      validatorVersions: [H4_PROMPT_VALIDATOR_ID, H4_MEASUREMENT_VALIDATOR_ID],
      measurementFactoryVersion: H4_MEASUREMENT_FACTORY_ID,
      applicabilityEstimatorVersion: H4_APPLICABILITY_ESTIMATOR_ID,
      artifactKinds: ["cc_prompt"],
      capabilityRequirements: [],
    });
    expect(registration.acceptedEvidence).toEqual(
      H4_SUPPORTED_DETECTORS.map((detectorId) => ({ detectorId, schemaVersion: 2 })),
    );
    expect(registration.artifactKinds).not.toContain("installable_hook");
    expect(H4_HOOK_POSTURE).toBe("NOT_APPLICABLE_UNVERIFIED_CAPABILITY");
  });

  it("generates byte-stable prompt, artifact, rollback, and measurement contracts", () => {
    const generated = generateH4ErrorLoopPack(input());
    const permuted = generateH4ErrorLoopPack(input([...actionableFixture.findings].reverse()));
    expect(generated).not.toBeNull();
    expect(JSON.stringify(generated)).toBe(JSON.stringify(permuted));
    expect(validateH4GeneratedPack(generated, input())).toBe(true);
    expect(generated?.artifact).toMatchObject({
      schemaVersion: 1,
      artifactKind: "cc_prompt",
      templateId: "H4_LOOP_RECOVERY_PROMPT_V1",
      generatorId: H4_GENERATOR_ID,
      detectorCodes: ["C4", "C5"],
      evidenceCount: 2,
      apply: {
        mechanismCode: "COPY_PROMPT",
        authorizationCode: "EXPLICIT_USER_ACTION",
        targetCode: "USER_SELECTED_NEW_SESSION_OR_SUBAGENT",
      },
    });
    expect(generated?.rollback).toEqual({
      schemaVersion: 1,
      strategyCode: "NO_PERSISTED_CHANGE",
      actionCode: "DISCARD_UNAPPLIED_PROMPT",
      artifactRevisionId: generated?.artifactContract.artifactRevisionId,
      rollbackArtifactRevisionId: generated?.artifactContract.rollbackArtifactRevisionId,
    });
    expect(generated?.measurementContract.artifactRevisionId).toBe(
      generated?.artifactContract.artifactRevisionId,
    );
    expect(generated?.measurementContract.definition.guardrailCodes).toEqual([
      "TOTAL_FAILURE_RATE_NOT_INCREASED",
      "RECOVERY_LOOP_RATE_NOT_INCREASED",
    ]);
  });

  it("gives recomposed immutable contracts new identities when createdAt changes", () => {
    const original = generateH4ErrorLoopPack(input());
    const recomposed = generateH4ErrorLoopPack({
      ...input(),
      now: "2026-09-16T13:00:00.000Z",
    });
    expect(original).not.toBeNull();
    expect(recomposed).not.toBeNull();
    expect(recomposed?.artifactContract.artifactRevisionId).not.toBe(
      original?.artifactContract.artifactRevisionId,
    );
    expect(recomposed?.measurementContract.measurementMethodId).not.toBe(
      original?.measurementContract.measurementMethodId,
    );
  });

  it("canonicalizes the evidence window identity and rejects extra window fields", () => {
    const canonical = generateH4ErrorLoopPack(input());
    const reversedWindow = Object.fromEntries([
      ["to", H4_FIXTURE_WINDOW.to],
      ["from", H4_FIXTURE_WINDOW.from],
    ]) as typeof H4_FIXTURE_WINDOW;
    expect(generateH4ErrorLoopPack({ ...input(), window: reversedWindow })).toEqual(canonical);
    expect(
      generateH4ErrorLoopPack({
        ...input(),
        window: { ...H4_FIXTURE_WINDOW, rawContext: "private" } as typeof H4_FIXTURE_WINDOW,
      }),
    ).toBeNull();
  });

  it("emits a root-cause recovery prompt without raw evidence or mutation instructions", () => {
    const rawTokens = [
      "C:\\private\\secret.env",
      "rm -rf private",
      "API_TOKEN_VALUE",
      "verbatim failure output",
      "original user prompt",
    ];
    const findings = actionableFixture.findings.map((finding) => ({
      ...finding,
      correlationKey: rawTokens.join("|"),
    }));
    const generated = generateH4ErrorLoopPack(input(findings));
    expect(generated).not.toBeNull();
    const serialized = JSON.stringify(generated);
    for (const token of rawTokens) expect(serialized).not.toContain(token);
    expect(generated?.artifact.prompt).toContain("Stop repeating the failing action");
    expect(generated?.artifact.prompt).toContain("Classify the root cause");
    expect(generated?.artifact.prompt).toContain("verify it independently");
    expect(generated?.artifact.prompt).toContain("Do not change permissions");
  });

  it.each([
    healthyNoChangeFixture,
    sparseFixture,
    conflictingFixture,
    falsePositiveFixture,
    malformedFixture,
  ])("fails closed for $name", (fixture) => {
    expect(generateH4ErrorLoopPack(input(fixture.findings))).toBeNull();
    expect(createH4ErrorLoopHandler().compose(input(fixture.findings))).toEqual({
      artifacts: [],
      measurement: null,
    });
  });

  it("rejects findings outside the declared evidence window", () => {
    const before = h4Finding("finding-before-window", "C5", {
      observedAt: "2026-09-09T11:59:59.999Z",
    });
    const after = h4Finding("finding-after-window", "C5", {
      observedAt: "2026-09-16T12:00:00.001Z",
    });
    expect(generateH4ErrorLoopPack(input([before]))).toBeNull();
    expect(generateH4ErrorLoopPack(input([after]))).toBeNull();
  });

  it("supports every scoped C-family signal only when repeat evidence anchors the pack", () => {
    const generated = generateH4ErrorLoopPack(input(supportedFamilyFixture.findings));
    expect(generated?.artifact.detectorCodes).toEqual(H4_SUPPORTED_DETECTORS);
    expect(generated?.artifact.evidenceCount).toBe(H4_SUPPORTED_DETECTORS.length);
  });

  it("composes through the accepted HRE-2 engine as an actionable validated prompt", () => {
    const result = composeRecommendation(actionableFixture.findings, engineContext());
    expect(result.lifecycle).toBe("ACTIONABLE");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      kind: "cc_prompt",
      validationStatus: "VALIDATED",
      validated: true,
      applyMechanismCode: "COPY_PROMPT",
      capabilityProfileVersion: profile.version,
    });
    expect(result.measurement).toMatchObject({
      verdict: "VALIDATED_PROXY",
      targetMetricCode: "REPEATED_FAILURE_SESSION_RATE",
    });
    expect(result.reasonCodes).toContain("PRIMARY_ADMISSION");
  });

  it("binds measurement to the exact artifact and detects recovery", () => {
    const pack = generateH4ErrorLoopPack(input());
    expect(pack).not.toBeNull();
    if (pack === null) return;
    const fixtures = measurementFixtures(pack.artifactContract.artifactRevisionId);
    expect(
      evaluateH4Measurement(fixtures.recovery, pack.artifactContract.artifactRevisionId),
    ).toMatchObject({
      artifactRevisionId: pack.artifactContract.artifactRevisionId,
      verdict: "IMPROVED",
      reasonCodes: ["REPEATED_FAILURE_RATE_REDUCED"],
    });
    expect(evaluateH4Measurement(fixtures.recovery, "artifact:wrong")).toBeNull();
  });

  it("reports no change when recovery does not meet the materiality threshold", () => {
    const pack = generateH4ErrorLoopPack(input());
    if (pack === null) throw new Error("fixture must generate");
    const fixtures = measurementFixtures(pack.artifactContract.artifactRevisionId);
    expect(
      evaluateH4Measurement(fixtures.noChange, pack.artifactContract.artifactRevisionId),
    ).toMatchObject({
      verdict: "NO_EFFECT",
      reasonCodes: ["MATERIAL_REDUCTION_NOT_OBSERVED"],
    });

    expect(
      evaluateH4Measurement(
        {
          schemaVersion: 1,
          artifactRevisionId: pack.artifactContract.artifactRevisionId,
          baseline: {
            eligibleSessions: 20_000_000,
            repeatedFailureSessions: 6_000_010,
            totalFailures: 12_000_020,
            recoveryLoopSessions: 0,
          },
          after: {
            eligibleSessions: 20_000_000,
            repeatedFailureSessions: 4_800_009,
            totalFailures: 9_600_018,
            recoveryLoopSessions: 0,
          },
        },
        pack.artifactContract.artifactRevisionId,
      ),
    ).toMatchObject({
      verdict: "NO_EFFECT",
      reasonCodes: ["MATERIAL_REDUCTION_NOT_OBSERVED"],
    });
  });

  it("fails the outcome guardrails when failures or recovery loops increase", () => {
    const pack = generateH4ErrorLoopPack(input());
    if (pack === null) throw new Error("fixture must generate");
    const fixtures = measurementFixtures(pack.artifactContract.artifactRevisionId);
    expect(
      evaluateH4Measurement(fixtures.adverse, pack.artifactContract.artifactRevisionId),
    ).toMatchObject({
      verdict: "WORSE",
      reasonCodes: ["TOTAL_FAILURE_RATE_INCREASED", "RECOVERY_LOOP_RATE_INCREASED"],
    });
    expect(
      evaluateH4Measurement(
        fixtures.slightGuardrailRegression,
        pack.artifactContract.artifactRevisionId,
      ),
    ).toMatchObject({
      verdict: "WORSE",
      reasonCodes: ["TOTAL_FAILURE_RATE_INCREASED", "RECOVERY_LOOP_RATE_INCREASED"],
    });
  });

  it("treats sparse or incomparable measurement cohorts as inconclusive", () => {
    const pack = generateH4ErrorLoopPack(input());
    if (pack === null) throw new Error("fixture must generate");
    const fixtures = measurementFixtures(pack.artifactContract.artifactRevisionId);
    expect(
      evaluateH4Measurement(fixtures.sparse, pack.artifactContract.artifactRevisionId),
    ).toMatchObject({ verdict: "INCONCLUSIVE", reasonCodes: ["COHORT_NOT_COMPARABLE"] });
  });

  it("rejects malformed observations and tampered generated output without throwing", () => {
    const pack = generateH4ErrorLoopPack(input());
    if (pack === null) throw new Error("fixture must generate");
    const tampered = {
      ...pack,
      artifact: { ...pack.artifact, prompt: `${pack.artifact.prompt}\nraw error` },
    };
    expect(validateH4GeneratedPack(tampered, input())).toBe(false);
    expect(
      evaluateH4Measurement(
        {
          ...measurementFixtures(pack.artifactContract.artifactRevisionId).recovery,
          rawError: "forbidden",
        },
        pack.artifactContract.artifactRevisionId,
      ),
    ).toBeNull();
    expect(() =>
      generateH4ErrorLoopPack(
        input([h4Finding("finding-bad-time", "C5", { observedAt: "not-a-time" })]),
      ),
    ).not.toThrow();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateH4GeneratedPack(circular, input())).not.toThrow();
    expect(validateH4GeneratedPack(circular, input())).toBe(false);

    const poisonedObservation = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("poisoned observation");
        },
      },
    );
    expect(() =>
      evaluateH4Measurement(poisonedObservation, pack.artifactContract.artifactRevisionId),
    ).not.toThrow();
    expect(
      evaluateH4Measurement(poisonedObservation, pack.artifactContract.artifactRevisionId),
    ).toBeNull();

    const privateArtifactId = "C:\\private\\raw-error-output";
    expect(
      evaluateH4Measurement(
        {
          ...measurementFixtures(pack.artifactContract.artifactRevisionId).recovery,
          artifactRevisionId: privateArtifactId,
        },
        privateArtifactId,
      ),
    ).toBeNull();

    expect(
      evaluateH4Measurement(
        {
          ...measurementFixtures(pack.artifactContract.artifactRevisionId).recovery,
          baseline: {
            eligibleSessions: 100,
            repeatedFailureSessions: 30,
            totalFailures: 59,
            recoveryLoopSessions: 20,
          },
        },
        pack.artifactContract.artifactRevisionId,
      ),
    ).toBeNull();
  });
});
