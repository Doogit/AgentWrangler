import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../../src/recommendations/engine.js";
import { composeRecommendation } from "../../../../src/recommendations/engine.js";
import {
  H6_APPLICABILITY_ESTIMATOR_VERSION,
  H6_GENERATOR_VERSION,
  H6_HANDLER_FAMILY,
  H6_HANDLER_VERSION,
  H6_MEASUREMENT_FACTORY_VERSION,
  H6_REGISTRY_VERSION,
  H6_SUPPORTED_DETECTORS,
  H6_VALIDATOR_VERSIONS,
  h6DurableCorrectionsHandler,
  validateH6ArtifactContract,
  validateH6MeasurementContract,
} from "../../../../src/recommendations/handlers/h6-durable-corrections/index.js";
import {
  H6_FINDING_CORPUS,
  H6_NOW,
  H6_WINDOW,
  h6CapabilityProfile,
  h6Finding,
} from "../../../fixtures/recommendations/handlers/h6-durable-corrections/fixtures.js";

const factor = (methodId: string, value: number | null) => ({
  value,
  methodId,
  methodVersion: "1",
  evidenceWindow: H6_WINDOW,
  uncertainty: { lower: value, upper: value },
});

const context = (changes: Partial<EngineContext> = {}): EngineContext => ({
  registry: { version: H6_REGISTRY_VERSION, handlers: [h6DurableCorrectionsHandler] },
  profile: h6CapabilityProfile(),
  now: H6_NOW,
  window: H6_WINDOW,
  compositionVersion: "h6-composition-1",
  rankingPolicyVersion: "ranking-policy-2",
  value: {
    ceuProvenance: factor("h6-ceu", 1),
    confidenceProvenance: factor("h6-confidence", 1),
    price: factor("h6-price", 2),
    applicability: factor("h6-applicability", 0.5),
    expectedEffect: factor("h6-effect", 0.5),
  },
  ...changes,
});

describe("HRE-6 H6 durable-corrections handler", () => {
  it("publishes the bounded D1/D4/D5 rule-artifact contract", () => {
    expect(h6DurableCorrectionsHandler.registration).toMatchObject({
      family: H6_HANDLER_FAMILY,
      version: H6_HANDLER_VERSION,
      registryVersion: H6_REGISTRY_VERSION,
      generatorVersion: H6_GENERATOR_VERSION,
      validatorVersions: H6_VALIDATOR_VERSIONS,
      measurementFactoryVersion: H6_MEASUREMENT_FACTORY_VERSION,
      applicabilityEstimatorVersion: H6_APPLICABILITY_ESTIMATOR_VERSION,
      artifactKinds: ["claude_md_rule"],
    });
    expect(h6DurableCorrectionsHandler.registration.acceptedEvidence).toEqual(
      H6_SUPPORTED_DETECTORS.map((detectorId) => ({ detectorId, schemaVersion: 2 })),
    );
    expect(
      h6DurableCorrectionsHandler.registration.acceptedEvidence.map((e) => e.detectorId),
    ).toEqual(["D1", "D4", "D5"]);
  });

  it.each([
    ["broad instruction trim", H6_FINDING_CORPUS.actionableBroad],
    ["model selection rule", H6_FINDING_CORPUS.actionableModel],
    ["budget guardrail rule", H6_FINDING_CORPUS.actionableBudget],
    ["both narrow rules", H6_FINDING_CORPUS.actionableBothNarrow],
  ])("composes actionable %s evidence with a rollback-bound measurement", (_name, findings) => {
    const composed = composeRecommendation(findings, context());
    expect(composed.lifecycle).toBe("ACTIONABLE");
    expect(composed.expectedSavingsUsdPerWeek).toBeGreaterThan(0);
    expect(composed.artifacts).toHaveLength(1);
    expect(composed.artifacts[0]).toMatchObject({
      kind: "claude_md_rule",
      validated: true,
      validationStatus: "VALIDATED",
      applyMechanismCode: "H6_CLAUDE_MD_RULE_REVIEW",
    });
    expect(composed.artifacts[0]?.rollbackArtifactRevisionId).not.toBe(
      composed.artifacts[0]?.artifactRevisionId,
    );
    expect(composed.measurement).toMatchObject({
      verdict: "VALIDATED_PROXY",
      targetMetricCode: "REPEAT_CORRECTION_RATE",
      artifactRevisionId: composed.artifacts[0]?.artifactRevisionId,
    });
  });

  it("lets a specific rule outrank the broad trim and never double-claims the opportunity", () => {
    const narrowOnly = h6DurableCorrectionsHandler.compose({
      findings: [h6Finding("d4-shared", "D4")],
      now: H6_NOW,
      window: H6_WINDOW,
    });
    const broadAndNarrow = h6DurableCorrectionsHandler.compose({
      findings: [h6Finding("d1-shared", "D1"), h6Finding("d4-shared", "D4")],
      now: H6_NOW,
      window: H6_WINDOW,
    });
    expect(broadAndNarrow.artifacts).toHaveLength(1);
    expect(JSON.stringify(broadAndNarrow)).toBe(JSON.stringify(narrowOnly));
  });

  it("validates exact artifact and measurement contracts and rejects tampering", () => {
    const output = h6DurableCorrectionsHandler.compose({
      findings: H6_FINDING_CORPUS.actionableModel,
      now: H6_NOW,
      window: H6_WINDOW,
    });
    const artifact = output.artifacts[0];
    expect(
      validateH6ArtifactContract(artifact, H6_FINDING_CORPUS.actionableModel, H6_NOW, H6_WINDOW),
    ).toBe(true);
    expect(
      validateH6ArtifactContract(
        artifact === undefined ? null : { ...artifact, targetHash: "0".repeat(64) },
        H6_FINDING_CORPUS.actionableModel,
        H6_NOW,
        H6_WINDOW,
      ),
    ).toBe(false);
    expect(
      validateH6MeasurementContract(
        output.measurement,
        H6_FINDING_CORPUS.actionableModel,
        H6_NOW,
        H6_WINDOW,
      ),
    ).toBe(true);
    expect(
      validateH6MeasurementContract(
        output.measurement === null
          ? null
          : { ...output.measurement, artifactRevisionId: `artifact:${"0".repeat(64)}` },
        H6_FINDING_CORPUS.actionableModel,
        H6_NOW,
        H6_WINDOW,
      ),
    ).toBe(false);
  });

  it("is deterministic under equivalent D1/D4 evidence order", () => {
    const reversed = [...H6_FINDING_CORPUS.actionableMixed].reverse();
    const first = h6DurableCorrectionsHandler.compose({
      findings: H6_FINDING_CORPUS.actionableMixed,
      now: H6_NOW,
      window: H6_WINDOW,
    });
    const second = h6DurableCorrectionsHandler.compose({
      findings: reversed,
      now: H6_NOW,
      window: H6_WINDOW,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(composeRecommendation(H6_FINDING_CORPUS.actionableMixed, context()).immutableId).toBe(
      composeRecommendation(reversed, context()).immutableId,
    );
  });

  it.each([
    ["healthy/no-change", H6_FINDING_CORPUS.healthyNoChange],
    ["sparse", H6_FINDING_CORPUS.sparse],
    ["conflicting opportunities", H6_FINDING_CORPUS.conflicting],
    ["adverse zero value", H6_FINDING_CORPUS.adverse],
    ["duplicate detector evidence", H6_FINDING_CORPUS.duplicate],
    ["version mismatch", H6_FINDING_CORPUS.versionMismatch],
    ["unsupported D2", H6_FINDING_CORPUS.unsupportedD2],
    ["retired D3", H6_FINDING_CORPUS.unsupportedRetiredD3],
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
        H6_FINDING_CORPUS.actionableModel,
        context({ profile: h6CapabilityProfile(verdict) }),
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
      { findings: "bad", now: H6_NOW, window: H6_WINDOW },
      { findings: H6_FINDING_CORPUS.actionableModel, now: "bad", window: H6_WINDOW },
      {
        findings: H6_FINDING_CORPUS.actionableModel,
        now: H6_NOW,
        window: H6_WINDOW,
        rawTranscript: "must-not-survive",
      },
      {
        findings: [{ ...h6Finding("extra", "D4"), rawCommand: "must-not-survive" }],
        now: H6_NOW,
        window: H6_WINDOW,
      },
      {
        findings: [h6Finding("outside", "D4", { observedAt: H6_WINDOW.to })],
        now: H6_NOW,
        window: H6_WINDOW,
      },
      { findings: H6_FINDING_CORPUS.unsupportedD2, now: H6_NOW, window: H6_WINDOW },
      { findings: H6_FINDING_CORPUS.unsupportedRetiredD3, now: H6_NOW, window: H6_WINDOW },
      { findings: H6_FINDING_CORPUS.versionMismatch, now: H6_NOW, window: H6_WINDOW },
    ];
    for (const value of cases) {
      expect(() => h6DurableCorrectionsHandler.compose(value as never)).not.toThrow();
      expect(h6DurableCorrectionsHandler.compose(value as never)).toEqual({
        artifacts: [],
        measurement: null,
      });
    }
  });

  it("emits only structural hashes and never raw evidence or unsupported compliance claims", () => {
    const marker = "private.raw-correction-transcript-marker";
    const output = h6DurableCorrectionsHandler.compose({
      findings: [h6Finding("private-marker", "D4", { correlationKey: marker })],
      now: H6_NOW,
      window: H6_WINDOW,
    });
    const serialized = JSON.stringify(output);
    expect(output.artifacts).toHaveLength(1);
    for (const forbidden of [
      marker,
      "enforced configuration",
      "guaranteed instruction",
      "automatic deduplication",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
