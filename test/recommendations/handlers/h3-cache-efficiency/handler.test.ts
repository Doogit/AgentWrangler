import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../../src/recommendations/engine.js";
import { composeRecommendation } from "../../../../src/recommendations/engine.js";
import {
  H3_APPLICABILITY_ESTIMATOR_VERSION,
  H3_GENERATOR_VERSION,
  H3_HANDLER_FAMILY,
  H3_HANDLER_VERSION,
  H3_MEASUREMENT_FACTORY_VERSION,
  H3_REGISTRY_VERSION,
  H3_SUPPORTED_DETECTORS,
  H3_VALIDATOR_VERSIONS,
  h3CacheEfficiencyHandler,
  validateH3ArtifactContract,
  validateH3MeasurementContract,
} from "../../../../src/recommendations/handlers/h3-cache-efficiency/index.js";
import {
  H3_FINDING_CORPUS,
  H3_NOW,
  H3_WINDOW,
  h3CapabilityProfile,
  h3Finding,
} from "../../../fixtures/recommendations/handlers/h3-cache-efficiency/fixtures.js";

const factor = (methodId: string, value: number | null) => ({
  value,
  methodId,
  methodVersion: "1",
  evidenceWindow: H3_WINDOW,
  uncertainty: { lower: value, upper: value },
});

const context = (changes: Partial<EngineContext> = {}): EngineContext => ({
  registry: { version: H3_REGISTRY_VERSION, handlers: [h3CacheEfficiencyHandler] },
  profile: h3CapabilityProfile(),
  now: H3_NOW,
  window: H3_WINDOW,
  compositionVersion: "h3-composition-1",
  rankingPolicyVersion: "ranking-policy-2",
  value: {
    ceuProvenance: factor("h3-ceu", 1),
    confidenceProvenance: factor("h3-confidence", 1),
    price: factor("h3-price", 2),
    applicability: factor("h3-applicability", 0.5),
    expectedEffect: factor("h3-effect", 0.5),
  },
  ...changes,
});

describe("HRE-6 H3 cache-efficiency handler", () => {
  it("publishes the bounded B1-B4 rule-artifact contract", () => {
    expect(h3CacheEfficiencyHandler.registration).toMatchObject({
      family: H3_HANDLER_FAMILY,
      version: H3_HANDLER_VERSION,
      registryVersion: H3_REGISTRY_VERSION,
      generatorVersion: H3_GENERATOR_VERSION,
      validatorVersions: H3_VALIDATOR_VERSIONS,
      measurementFactoryVersion: H3_MEASUREMENT_FACTORY_VERSION,
      applicabilityEstimatorVersion: H3_APPLICABILITY_ESTIMATOR_VERSION,
      artifactKinds: ["claude_md_rule"],
    });
    expect(h3CacheEfficiencyHandler.registration.acceptedEvidence).toEqual(
      H3_SUPPORTED_DETECTORS.map((detectorId) => ({ detectorId, schemaVersion: 2 })),
    );
  });

  it.each([
    ["TTL gap", H3_FINDING_CORPUS.actionable],
    ["resume miss", H3_FINDING_CORPUS.actionableResume],
    ["mid-session prefix break", H3_FINDING_CORPUS.actionablePrefix],
  ])("composes actionable %s evidence with a rollback-bound measurement", (_name, findings) => {
    const composed = composeRecommendation(findings, context());
    expect(composed.lifecycle).toBe("ACTIONABLE");
    expect(composed.expectedSavingsUsdPerWeek).toBe(5.4);
    expect(composed.artifacts).toHaveLength(1);
    expect(composed.artifacts[0]).toMatchObject({
      kind: "claude_md_rule",
      validated: true,
      validationStatus: "VALIDATED",
      applyMechanismCode: "H3_RULE_BLOCK_REVIEW",
    });
    expect(composed.artifacts[0]?.rollbackArtifactRevisionId).not.toBe(
      composed.artifacts[0]?.artifactRevisionId,
    );
    expect(composed.measurement).toMatchObject({
      verdict: "VALIDATED_PROXY",
      targetMetricCode: "CACHE_CREATION_CEU_PER_WEEK",
      artifactRevisionId: composed.artifacts[0]?.artifactRevisionId,
    });
  });

  it("validates exact artifact and measurement contracts and rejects tampering", () => {
    const output = h3CacheEfficiencyHandler.compose({
      findings: H3_FINDING_CORPUS.actionable,
      now: H3_NOW,
      window: H3_WINDOW,
    });
    const artifact = output.artifacts[0];
    expect(
      validateH3ArtifactContract(artifact, H3_FINDING_CORPUS.actionable, H3_NOW, H3_WINDOW),
    ).toBe(true);
    expect(
      validateH3ArtifactContract(
        artifact === undefined ? null : { ...artifact, targetHash: "0".repeat(64) },
        H3_FINDING_CORPUS.actionable,
        H3_NOW,
        H3_WINDOW,
      ),
    ).toBe(false);
    expect(
      validateH3MeasurementContract(
        output.measurement,
        H3_FINDING_CORPUS.actionable,
        H3_NOW,
        H3_WINDOW,
      ),
    ).toBe(true);
    expect(
      validateH3MeasurementContract(
        output.measurement === null
          ? null
          : { ...output.measurement, artifactRevisionId: `artifact:${"0".repeat(64)}` },
        H3_FINDING_CORPUS.actionable,
        H3_NOW,
        H3_WINDOW,
      ),
    ).toBe(false);
  });

  it("is deterministic under equivalent B1/classifier evidence order", () => {
    const reversed = [...H3_FINDING_CORPUS.actionable].reverse();
    const first = h3CacheEfficiencyHandler.compose({
      findings: H3_FINDING_CORPUS.actionable,
      now: H3_NOW,
      window: H3_WINDOW,
    });
    const second = h3CacheEfficiencyHandler.compose({
      findings: reversed,
      now: H3_NOW,
      window: H3_WINDOW,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(composeRecommendation(H3_FINDING_CORPUS.actionable, context()).immutableId).toBe(
      composeRecommendation(reversed, context()).immutableId,
    );
  });

  it.each([
    ["healthy/no-change", H3_FINDING_CORPUS.healthyNoChange],
    ["sparse", H3_FINDING_CORPUS.sparse],
    ["conflicting classifiers", H3_FINDING_CORPUS.conflicting],
    ["adverse CEU overlap", H3_FINDING_CORPUS.adverse],
    ["false-positive", H3_FINDING_CORPUS.falsePositive],
    ["unclassified B1", H3_FINDING_CORPUS.b1Unclassified],
    ["unsupported B5", H3_FINDING_CORPUS.unsupportedB5],
    ["unsupported A6", H3_FINDING_CORPUS.unsupportedA6],
  ])("keeps %s evidence non-actionable", (_name, findings) => {
    const composed = composeRecommendation(findings, context());
    expect(composed.lifecycle).toBe("INVESTIGATE");
    expect(composed.artifacts).toEqual([]);
    expect(composed.measurement).toBeNull();
  });

  it.each(["UNKNOWN", "UNSUPPORTED", "CONTRADICTED"] as const)(
    "fails closed for %s rule capability",
    (verdict) => {
      const composed = composeRecommendation(
        H3_FINDING_CORPUS.actionable,
        context({ profile: h3CapabilityProfile(verdict) }),
      );
      expect(composed.lifecycle).toBe("INVESTIGATE");
      expect(composed.artifacts).toEqual([]);
      expect(composed.measurement).toBeNull();
      expect(composed.reasonCodes).toContain(
        verdict === "CONTRADICTED" ? "CAPABILITY_CONTRADICTED" : "CAPABILITY_UNVERIFIED",
      );
    },
  );

  it("rejects malformed, extra, stale, and unsupported direct inputs without throwing", () => {
    const cases = [
      null,
      {},
      { findings: "bad", now: H3_NOW, window: H3_WINDOW },
      { findings: H3_FINDING_CORPUS.actionable, now: "bad", window: H3_WINDOW },
      {
        findings: H3_FINDING_CORPUS.actionable,
        now: H3_NOW,
        window: H3_WINDOW,
        rawTranscript: "must-not-survive",
      },
      {
        findings: [{ ...h3Finding("extra", "B2"), rawCommand: "must-not-survive" }],
        now: H3_NOW,
        window: H3_WINDOW,
      },
      {
        findings: [h3Finding("outside", "B2", { observedAt: H3_WINDOW.to })],
        now: H3_NOW,
        window: H3_WINDOW,
      },
      { findings: H3_FINDING_CORPUS.unsupportedB5, now: H3_NOW, window: H3_WINDOW },
    ];
    for (const value of cases) {
      expect(() => h3CacheEfficiencyHandler.compose(value as never)).not.toThrow();
      expect(h3CacheEfficiencyHandler.compose(value as never)).toEqual({
        artifacts: [],
        measurement: null,
      });
    }
  });

  it("emits only structural hashes and never raw evidence or unsupported provider claims", () => {
    const marker = "private.raw-cache-transcript-marker";
    const output = h3CacheEfficiencyHandler.compose({
      findings: [h3Finding("private-marker", "B4", { correlationKey: marker })],
      now: H3_NOW,
      window: H3_WINDOW,
    });
    const serialized = JSON.stringify(output);
    expect(output.artifacts).toHaveLength(1);
    for (const forbidden of [
      marker,
      "guaranteed cache",
      "breakpoint placement",
      "keepalive hook",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
