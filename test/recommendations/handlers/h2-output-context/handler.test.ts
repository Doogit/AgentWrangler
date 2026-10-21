import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../../src/recommendations/engine.js";
import { composeRecommendation } from "../../../../src/recommendations/engine.js";
import {
  H2_APPLICABILITY_ESTIMATOR_VERSION,
  H2_GENERATOR_VERSION,
  H2_HANDLER_FAMILY,
  H2_HANDLER_VERSION,
  H2_MEASUREMENT_FACTORY_VERSION,
  H2_REGISTRY_VERSION,
  H2_VALIDATOR_VERSIONS,
  h2OutputContextHandler,
  validateH2ArtifactContract,
  validateH2MeasurementContract,
} from "../../../../src/recommendations/handlers/h2-output-context/index.js";
import {
  H2_ADVERSE_CAPABILITY_PROFILE,
  H2_FINDING_CORPUS,
  H2_NOW,
  H2_WINDOW,
  h2CapabilityProfile,
} from "../../../fixtures/recommendations/handlers/h2-output-context/corpus.js";

const factor = (methodId: string, value: number | null) => ({
  value,
  methodId,
  methodVersion: "1",
  evidenceWindow: H2_WINDOW,
  uncertainty: { lower: value, upper: value },
});

const context = (changes: Partial<EngineContext> = {}): EngineContext => ({
  registry: { version: H2_REGISTRY_VERSION, handlers: [h2OutputContextHandler] },
  profile: h2CapabilityProfile(),
  now: H2_NOW,
  window: H2_WINDOW,
  compositionVersion: "h2-composition-1",
  rankingPolicyVersion: "ranking-policy-2",
  value: {
    ceuProvenance: factor("h2-ceu", 1),
    confidenceProvenance: factor("h2-confidence", 1),
    price: factor("h2-price", 2),
    applicability: factor("h2-applicability", 0.5),
    expectedEffect: factor("h2-effect", 0.5),
  },
  ...changes,
});

describe("HRE-3a H2 output/context handler", () => {
  it("publishes stable versioned generator, validator, measurement, and applicability identities", () => {
    expect(h2OutputContextHandler.registration).toMatchObject({
      family: H2_HANDLER_FAMILY,
      version: H2_HANDLER_VERSION,
      registryVersion: H2_REGISTRY_VERSION,
      generatorVersion: H2_GENERATOR_VERSION,
      validatorVersions: H2_VALIDATOR_VERSIONS,
      measurementFactoryVersion: H2_MEASUREMENT_FACTORY_VERSION,
      applicabilityEstimatorVersion: H2_APPLICABILITY_ESTIMATOR_VERSION,
      artifactKinds: ["claude_md_rule"],
    });
    expect(h2OutputContextHandler.registration.acceptedEvidence).toEqual([
      { detectorId: "A1", schemaVersion: 2 },
      { detectorId: "A2", schemaVersion: 2 },
    ]);
  });

  it("keeps handler output and composed identity stable under equivalent evidence order", () => {
    const findings = [
      H2_FINDING_CORPUS.actionable[0],
      {
        ...H2_FINDING_CORPUS.actionable[0],
        id: "actionable-b" as (typeof H2_FINDING_CORPUS.actionable)[number]["id"],
        detectorId: "A2",
        correlationKey: "output-scope-b",
        ceuPoolId: "output-pool-b" as (typeof H2_FINDING_CORPUS.actionable)[number]["ceuPoolId"],
      },
    ];
    const first = h2OutputContextHandler.compose({ findings, now: H2_NOW, window: H2_WINDOW });
    const second = h2OutputContextHandler.compose({
      findings: [...findings].reverse(),
      now: H2_NOW,
      window: H2_WINDOW,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const firstComposed = composeRecommendation(findings, context());
    const secondComposed = composeRecommendation([...findings].reverse(), context());
    expect(JSON.stringify(firstComposed)).toBe(JSON.stringify(secondComposed));
    expect(firstComposed.immutableId).toBe(secondComposed.immutableId);
  });

  it("emits a validated structural artifact with a distinct valid rollback contract", () => {
    const output = h2OutputContextHandler.compose({
      findings: H2_FINDING_CORPUS.actionable,
      now: H2_NOW,
      window: H2_WINDOW,
    });
    expect(output.artifacts).toHaveLength(1);
    const artifact = output.artifacts[0];
    expect(validateH2ArtifactContract(artifact)).toBe(true);
    expect(artifact?.rollbackArtifactRevisionId).not.toBe(artifact?.artifactRevisionId);
    expect(artifact?.applyMechanismCode).toBe("H2_RULE_BLOCK_REVIEW");
    expect(validateH2ArtifactContract({ ...artifact, rollbackHash: "0".repeat(64) })).toBe(false);
  });

  it("binds the validated-proxy measurement to the exact artifact revision", () => {
    const output = h2OutputContextHandler.compose({
      findings: H2_FINDING_CORPUS.actionable,
      now: H2_NOW,
      window: H2_WINDOW,
    });
    const artifact = output.artifacts[0];
    expect(artifact).toBeDefined();
    expect(output.measurement?.artifactRevisionId).toBe(artifact?.artifactRevisionId);
    expect(
      validateH2MeasurementContract(
        output.measurement,
        artifact?.artifactRevisionId ?? "",
        H2_WINDOW,
      ),
    ).toBe(true);
    expect(
      validateH2MeasurementContract(
        output.measurement === null
          ? null
          : { ...output.measurement, artifactRevisionId: `artifact:${"0".repeat(64)}` },
        artifact?.artifactRevisionId ?? "",
        H2_WINDOW,
      ),
    ).toBe(false);
    expect(
      validateH2MeasurementContract(
        output.measurement === null
          ? null
          : { ...output.measurement, createdAt: "2026-09-16T11:59:59.000Z" },
        artifact?.artifactRevisionId ?? "",
        H2_WINDOW,
      ),
    ).toBe(false);
  });

  it("rejects a measurement whose fixed guardrails are replaced or duplicated", () => {
    const output = h2OutputContextHandler.compose({
      findings: H2_FINDING_CORPUS.actionable,
      now: H2_NOW,
      window: H2_WINDOW,
    });
    const artifactRevisionId = output.artifacts[0]?.artifactRevisionId ?? "";
    expect(output.measurement).not.toBeNull();
    for (const guardrailCodes of [
      ["NO_ERROR_RATE_REGRESSION", "UNRELATED_SAFE_CODE"],
      ["NO_ERROR_RATE_REGRESSION", "NO_ERROR_RATE_REGRESSION"],
    ]) {
      expect(
        validateH2MeasurementContract(
          output.measurement === null
            ? null
            : {
                ...output.measurement,
                definition: { ...output.measurement.definition, guardrailCodes },
              },
          artifactRevisionId,
          H2_WINDOW,
        ),
      ).toBe(false);
    }
  });

  it("fails closed on malformed measurement windows and hostile runtime objects", () => {
    const output = h2OutputContextHandler.compose({
      findings: H2_FINDING_CORPUS.actionable,
      now: H2_NOW,
      window: H2_WINDOW,
    });
    const artifactRevisionId = output.artifacts[0]?.artifactRevisionId ?? "";
    expect(output.measurement).not.toBeNull();

    for (const window of [
      { ...H2_WINDOW, rawTranscript: "must-not-survive" },
      { from: H2_WINDOW.to, to: H2_WINDOW.from },
      { from: "not-a-time", to: H2_WINDOW.to },
    ]) {
      expect(validateH2MeasurementContract(output.measurement, artifactRevisionId, window)).toBe(
        false,
      );
    }

    const poisoned = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("poisoned runtime object");
        },
      },
    );
    expect(() => validateH2ArtifactContract(poisoned)).not.toThrow();
    expect(validateH2ArtifactContract(poisoned)).toBe(false);
    expect(() =>
      validateH2MeasurementContract(poisoned, artifactRevisionId, H2_WINDOW),
    ).not.toThrow();
    expect(validateH2MeasurementContract(poisoned, artifactRevisionId, H2_WINDOW)).toBe(false);
    expect(() => h2OutputContextHandler.compose(poisoned as never)).not.toThrow();
    expect(h2OutputContextHandler.compose(poisoned as never)).toEqual({
      artifacts: [],
      measurement: null,
    });
  });

  it("propagates numeric CEU, confidence, price, applicability, and expected effect", () => {
    const composed = composeRecommendation(H2_FINDING_CORPUS.actionable, context());
    expect(composed.lifecycle).toBe("ACTIONABLE");
    expect(composed.expectedSavingsUsdPerWeek).toBe(4);
    expect(composed.measurement?.targetMetricCode).toBe("OUTPUT_EXPOSURE_CEU_PER_WEEK");
    expect(composed.measurement?.verdict).toBe("VALIDATED_PROXY");
  });

  it.each([
    ["healthy/no-change", H2_FINDING_CORPUS.healthyNoChange],
    ["sparse", H2_FINDING_CORPUS.sparse],
    ["conflicting", H2_FINDING_CORPUS.conflicting],
    ["false-positive", H2_FINDING_CORPUS.falsePositive],
    ["unsupported", H2_FINDING_CORPUS.unsupported],
  ])("keeps %s evidence non-actionable", (_name, findings) => {
    const composed = composeRecommendation(findings, context());
    expect(composed.lifecycle).toBe("INVESTIGATE");
    expect(composed.artifacts).toEqual([]);
    expect(composed.measurement).toBeNull();
  });

  it("keeps contradicted capability evidence non-actionable", () => {
    const composed = composeRecommendation(
      H2_FINDING_CORPUS.actionable,
      context({ profile: H2_ADVERSE_CAPABILITY_PROFILE }),
    );
    expect(composed.lifecycle).toBe("INVESTIGATE");
    expect(composed.reasonCodes).toContain("CAPABILITY_CONTRADICTED");
    expect(composed.artifacts).toEqual([]);
  });

  it.each(["UNKNOWN", "UNSUPPORTED"] as const)(
    "keeps %s capability evidence non-actionable",
    (verdict) => {
      const composed = composeRecommendation(
        H2_FINDING_CORPUS.actionable,
        context({ profile: h2CapabilityProfile(verdict) }),
      );
      expect(composed.lifecycle).toBe("INVESTIGATE");
      expect(composed.reasonCodes).toContain("CAPABILITY_UNVERIFIED");
      expect(composed.artifacts).toEqual([]);
    },
  );

  it("fails closed when an unsupported detector reaches the handler directly", () => {
    expect(
      h2OutputContextHandler.compose({
        findings: H2_FINDING_CORPUS.unsupported,
        now: H2_NOW,
        window: H2_WINDOW,
      }),
    ).toEqual({ artifacts: [], measurement: null });
  });

  it("fails closed without throwing for malformed or extra runtime values", () => {
    for (const input of [
      null,
      {},
      { findings: "not-an-array", now: H2_NOW, window: H2_WINDOW },
      { findings: H2_FINDING_CORPUS.actionable, now: "bad", window: H2_WINDOW },
      {
        findings: H2_FINDING_CORPUS.actionable,
        now: H2_NOW,
        window: H2_WINDOW,
        rawOutput: "must-not-survive",
      },
      {
        findings: [{ ...H2_FINDING_CORPUS.actionable[0], rawCommand: "must-not-survive" }],
        now: H2_NOW,
        window: H2_WINDOW,
      },
    ]) {
      expect(() => h2OutputContextHandler.compose(input as never)).not.toThrow();
      expect(h2OutputContextHandler.compose(input as never)).toEqual({
        artifacts: [],
        measurement: null,
      });
    }
  });

  it("emits no raw commands, output, prompts, transcript text, paths, or unsupported claims", () => {
    const marker = "C:/secret/raw-command-transcript-marker";
    const finding = {
      ...H2_FINDING_CORPUS.actionable[0],
      correlationKey: marker,
    };
    const output = h2OutputContextHandler.compose({
      findings: [finding],
      now: H2_NOW,
      window: H2_WINDOW,
    });
    const serialized = JSON.stringify(output);
    for (const forbidden of [marker, ".claudeignore", "updatedInput", "updatedToolOutput", "MCP"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
