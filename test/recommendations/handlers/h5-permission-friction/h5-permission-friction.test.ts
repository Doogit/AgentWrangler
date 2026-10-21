import { describe, expect, it } from "vitest";
import type { CapabilityProfile } from "../../../../src/recommendations/capabilities.js";
import {
  type EngineContext,
  composeRecommendation,
} from "../../../../src/recommendations/engine.js";
import {
  H5_GENERATOR_VERSION,
  H5_HANDLER_FAMILY,
  H5_HANDLER_VERSION,
  H5_MEASUREMENT_VERSION,
  H5_SCOPE_PRECEDENCE,
  H5_VALIDATOR_VERSION,
  composeH5PermissionFriction,
  createH5PermissionFrictionHandler,
  decodeH5PermissionEvidence,
  evaluateH5PermissionEvidence,
  resolveH5EffectivePermission,
  validateH5ArtifactContract,
  validateH5MeasurementContract,
} from "../../../../src/recommendations/handlers/h5-permission-friction/index.js";
import {
  H5_FINDING_ID,
  H5_NOW,
  emptySettings,
  h5Evidence,
  h5Finding,
  withRule,
} from "../../../fixtures/recommendations/handlers/h5-permission-friction/fixtures.js";

describe("H5 permission-friction policy", () => {
  it("preserves exact scope precedence and deny > ask > allow semantics", () => {
    expect(H5_SCOPE_PRECEDENCE).toEqual([
      "MANAGED",
      "CLI",
      "PROJECT_LOCAL",
      "PROJECT_SHARED",
      "USER",
    ]);

    const settings = emptySettings();
    const conflicting = {
      ...settings,
      MANAGED: { ...settings.MANAGED, allow: ["Read"] as const },
      CLI: { ...settings.CLI, deny: ["Read"] as const },
      PROJECT_LOCAL: { ...settings.PROJECT_LOCAL, ask: ["Read"] as const },
      USER: { ...settings.USER, deny: ["Read"] as const },
    };
    expect(resolveH5EffectivePermission(conflicting, "Read")).toEqual({
      effect: "DENY",
      controllingScope: "CLI",
    });
    expect(evaluateH5PermissionEvidence(h5Evidence({ settings: conflicting }), H5_NOW)).toEqual({
      kind: "INVESTIGATE",
      reasonCode: "H5_DENY_PRECEDENCE",
    });

    const askOverAllow = emptySettings();
    const askConflict = {
      ...askOverAllow,
      MANAGED: { ...askOverAllow.MANAGED, allow: ["Read"] as const },
      USER: { ...askOverAllow.USER, ask: ["Read"] as const },
    };
    expect(resolveH5EffectivePermission(askConflict, "Read")).toEqual({
      effect: "ASK",
      controllingScope: "USER",
    });
  });

  it("emits one narrow project-local config diff with exact rollback and measurement binding", () => {
    const first = evaluateH5PermissionEvidence(h5Evidence(), H5_NOW);
    const second = evaluateH5PermissionEvidence(h5Evidence(), H5_NOW);
    expect(second).toEqual(first);
    expect(first.kind).toBe("ACTIONABLE");
    if (first.kind !== "ACTIONABLE") throw new Error("expected actionable H5 decision");

    expect(first.artifact).toEqual({
      schemaVersion: 1,
      operation: "ADD_PERMISSION_ALLOW",
      targetScope: "PROJECT_LOCAL",
      permission: "Read",
      targetClass: "PROJECT_FILES",
      workspaceBoundary: "CURRENT_PROJECT_ONLY",
      preserveDeny: true,
      preserveAsk: true,
    });
    expect(first.rollback).toEqual({
      schemaVersion: 1,
      operation: "REMOVE_OWNED_PERMISSION_ALLOW",
      targetScope: "PROJECT_LOCAL",
      permission: "Read",
      targetClass: "PROJECT_FILES",
      workspaceBoundary: "CURRENT_PROJECT_ONLY",
      ownedArtifactHash: first.artifactHash,
      preserveUnrelatedRules: true,
    });
    expect(first.measurement).toMatchObject({
      verdict: "VALIDATED_PROXY",
      methodVersion: H5_MEASUREMENT_VERSION,
      targetMetricCode: "PERMISSION_PROMPTS_PER_100_TOOL_USES",
      createdAt: H5_NOW,
    });
    expect(first.measurement.artifactRevisionId).toMatch(/^artifact:[a-f0-9]{64}$/);
    expect(first.measurement.measurementMethodId).toMatch(/^measurement:[a-f0-9]{64}$/);
    const later = evaluateH5PermissionEvidence(h5Evidence(), "2026-09-17T00:00:00.000Z");
    expect(later.kind).toBe("ACTIONABLE");
    if (later.kind !== "ACTIONABLE") throw new Error("expected later actionable H5 decision");
    expect(later.measurement.artifactRevisionId).not.toBe(first.measurement.artifactRevisionId);

    const composed = composeH5PermissionFriction(
      [h5Finding()],
      new Map([[H5_FINDING_ID, h5Evidence()]]),
      H5_NOW,
    );
    expect(composed.artifacts).toHaveLength(1);
    expect(composed.measurement?.artifactRevisionId).toBe(
      composed.artifacts[0]?.artifactRevisionId,
    );
    expect(composed.artifacts[0]).toMatchObject({
      kind: "config_diff",
      validationStatus: "VALIDATED",
      validated: true,
      artifactHash: first.artifactHash,
      rollbackHash: first.rollbackHash,
      applyMechanismCode: "MERGE_PERMISSION_ALLOW_ENTRY",
    });
    expect(validateH5ArtifactContract(composed.artifacts[0], h5Evidence(), H5_NOW)).toBe(true);
    expect(validateH5MeasurementContract(composed.measurement, h5Evidence(), H5_NOW)).toBe(true);
    expect(
      validateH5ArtifactContract(
        { ...composed.artifacts[0], rollbackHash: "0".repeat(64) },
        h5Evidence(),
        H5_NOW,
      ),
    ).toBe(false);
    expect(
      validateH5MeasurementContract(
        { ...composed.measurement, artifactRevisionId: `artifact:${"0".repeat(64)}` },
        h5Evidence(),
        H5_NOW,
      ),
    ).toBe(false);
  });

  it("returns healthy and sparse evidence as no-change", () => {
    expect(
      evaluateH5PermissionEvidence(h5Evidence({ settings: withRule("MANAGED", "allow") }), H5_NOW),
    ).toEqual({ kind: "NO_CHANGE", reasonCode: "H5_ALREADY_ALLOWED" });
    expect(evaluateH5PermissionEvidence(h5Evidence({ occurrenceCount: 1 }), H5_NOW)).toEqual({
      kind: "NO_CHANGE",
      reasonCode: "H5_EVIDENCE_SPARSE",
    });
    expect(evaluateH5PermissionEvidence(h5Evidence({ promptShown: false }), H5_NOW)).toEqual({
      kind: "NO_CHANGE",
      reasonCode: "H5_NO_CHANGE",
    });
  });

  it.each([
    ["write", { operationRisk: "WRITE" as const }],
    ["Bash", { operationRisk: "BASH" as const }],
    ["network", { operationRisk: "NETWORK" as const }],
    ["destructive", { operationRisk: "DESTRUCTIVE" as const }],
    ["out-of-project", { inProject: false }],
    ["not read-only", { readOnly: false }],
    ["side effects", { sideEffectFree: false }],
  ])("keeps %s evidence non-actionable", (_label, changes) => {
    expect(evaluateH5PermissionEvidence(h5Evidence(changes), H5_NOW)).toEqual({
      kind: "INVESTIGATE",
      reasonCode: "H5_UNSAFE_OPERATION",
    });
  });

  it("keeps broad wildcards, H9, interrupts, and bare rejection non-actionable", () => {
    expect(evaluateH5PermissionEvidence(h5Evidence({ broadWildcard: true }), H5_NOW)).toEqual({
      kind: "INVESTIGATE",
      reasonCode: "H5_BROAD_WILDCARD",
    });
    expect(
      evaluateH5PermissionEvidence(
        h5Evidence({ detectorId: "H9", eventClass: "H9_EVASION", h9Evasion: true }),
        H5_NOW,
      ),
    ).toEqual({ kind: "INVESTIGATE", reasonCode: "H5_H9_EVASION" });
    expect(
      evaluateH5PermissionEvidence(
        h5Evidence({ detectorId: "D14", eventClass: "INTERRUPTED", interrupted: true }),
        H5_NOW,
      ),
    ).toEqual({ kind: "INVESTIGATE", reasonCode: "H5_INTERRUPT_AMBIGUITY" });
    expect(
      evaluateH5PermissionEvidence(h5Evidence({ eventClass: "USER_REJECTED" }), H5_NOW),
    ).toEqual({ kind: "INVESTIGATE", reasonCode: "H5_BARE_REJECTION" });
  });

  it("fails malformed or reconstructable evidence closed without reflecting raw values", () => {
    const malformed = [
      { ...h5Evidence(), command: "sensitive raw command" },
      { ...h5Evidence(), occurrenceCount: "2" },
      { ...h5Evidence(), permission: "Bash" },
      { ...h5Evidence(), targetClass: "ARBITRARY_PATH" },
      { ...h5Evidence(), findingId: "finding:not-a-hash" },
      {
        ...h5Evidence(),
        settings: { ...emptySettings(), USER: { allow: ["Read", "Read"], ask: [], deny: [] } },
      },
      { ...h5Evidence(), settings: { ...emptySettings(), rawPath: "C:/private" } },
    ];
    for (const value of malformed) {
      expect(decodeH5PermissionEvidence(value)).toBeNull();
      const decision = evaluateH5PermissionEvidence(value, H5_NOW);
      expect(decision).toEqual({ kind: "INVESTIGATE", reasonCode: "H5_EVIDENCE_INVALID" });
      expect(JSON.stringify(decision)).not.toContain("sensitive");
      expect(JSON.stringify(decision)).not.toContain("C:/private");
    }
    expect(evaluateH5PermissionEvidence(h5Evidence(), "not-a-time")).toEqual({
      kind: "INVESTIGATE",
      reasonCode: "H5_EVIDENCE_INVALID",
    });
  });
});

describe("H5 handler implementation", () => {
  it("is versioned, capability-gated, and snapshots validated evidence", () => {
    const evidence = new Map<string, unknown>([[H5_FINDING_ID, h5Evidence()]]);
    const handler = createH5PermissionFrictionHandler(evidence);
    evidence.set(H5_FINDING_ID, { ...h5Evidence(), command: "late mutation" });

    expect(handler.registration).toMatchObject({
      family: H5_HANDLER_FAMILY,
      version: H5_HANDLER_VERSION,
      acceptedEvidence: [
        { detectorId: "C9", schemaVersion: 2 },
        { detectorId: "D14", schemaVersion: 2 },
        { detectorId: "H9", schemaVersion: 1 },
      ],
      artifactKinds: ["config_diff"],
      generatorVersion: H5_GENERATOR_VERSION,
      validatorVersions: [H5_VALIDATOR_VERSION],
      measurementFactoryVersion: H5_MEASUREMENT_VERSION,
    });
    expect(handler.registration.capabilityRequirements).toEqual([
      {
        capability: "permission-config-diff-v1",
        allowedSources: ["LOCAL_CANARY", "VERSION_GATE"],
        allowedCanaryVersions: ["permission-config-canary-1"],
      },
    ]);
    expect(
      handler.compose({
        findings: [h5Finding()],
        now: H5_NOW,
        window: { from: H5_NOW, to: H5_NOW },
      }),
    ).toMatchObject({
      artifacts: [{ kind: "config_diff" }],
      measurement: { verdict: "VALIDATED_PROXY" },
    });
  });

  it("is admitted by the frozen engine only with verified capability and exact binding", () => {
    const handler = createH5PermissionFrictionHandler(new Map([[H5_FINDING_ID, h5Evidence()]]));
    const factor = (methodId: string, value: number) => ({
      value,
      methodId,
      methodVersion: "1",
      evidenceWindow: { from: "2026-09-09T00:00:00.000Z", to: H5_NOW },
      uncertainty: { lower: value, upper: value },
    });
    const profile: CapabilityProfile = {
      id: "h5-profile",
      version: "h5-profile-1",
      claudeCodeVersion: "1",
      platform: "WINDOWS",
      workspaceScope: "workspace",
      createdAt: "2026-09-15T00:00:00.000Z",
      expiresAt: "2026-09-17T00:00:00.000Z",
      observations: [
        {
          capability: "permission-config-diff-v1",
          verdict: "SUPPORTED",
          source: "LOCAL_CANARY",
          canaryVersion: "permission-config-canary-1",
          observedAt: H5_NOW,
        },
      ],
    };
    const context: EngineContext = {
      registry: { version: handler.registration.registryVersion, handlers: [handler] },
      profile,
      now: H5_NOW,
      window: { from: "2026-09-09T00:00:00.000Z", to: H5_NOW },
      compositionVersion: "h5-composition-1",
      rankingPolicyVersion: "ranking-policy-2",
      value: {
        ceuProvenance: factor("ceu", 1),
        confidenceProvenance: factor("confidence", 1),
        price: factor("price", 1),
        applicability: factor("applicability", 1),
        expectedEffect: factor("effect", 1),
      },
    };

    const recommendation = composeRecommendation([h5Finding()], context);
    expect(recommendation.lifecycle).toBe("ACTIONABLE");
    expect(recommendation.artifacts).toHaveLength(1);
    expect(recommendation.measurement?.artifactRevisionId).toBe(
      recommendation.artifacts[0]?.artifactRevisionId,
    );

    const unsupported = composeRecommendation([h5Finding()], {
      ...context,
      profile: { ...profile, observations: [] },
    });
    expect(unsupported.lifecycle).toBe("INVESTIGATE");
    expect(unsupported.artifacts).toEqual([]);
    expect(unsupported.reasonCodes).toContain("CAPABILITY_UNVERIFIED");
  });

  it("fails composition closed for missing, mismatched, mixed, or non-actionable evidence", () => {
    expect(composeH5PermissionFriction([h5Finding()], new Map(), H5_NOW)).toEqual({
      artifacts: [],
      measurement: null,
    });
    expect(
      composeH5PermissionFriction(
        [h5Finding()],
        new Map([[H5_FINDING_ID, h5Evidence({ detectorId: "H9" })]]),
        H5_NOW,
      ),
    ).toEqual({ artifacts: [], measurement: null });
    expect(
      composeH5PermissionFriction(
        [h5Finding()],
        new Map([[H5_FINDING_ID, h5Evidence({ eventClass: "USER_REJECTED" })]]),
        H5_NOW,
      ),
    ).toEqual({ artifacts: [], measurement: null });
  });

  it("keeps equivalent actionable evidence order-independent with one stable artifact identity", () => {
    const secondFindingId = `finding:${"b".repeat(64)}`;
    const first = h5Finding();
    const second = h5Finding({ id: secondFindingId as typeof first.id });
    const evidence = new Map<string, unknown>([
      [first.id, h5Evidence()],
      [second.id, h5Evidence({ findingId: secondFindingId })],
    ]);

    const forward = composeH5PermissionFriction([first, second], evidence, H5_NOW);
    const reverse = composeH5PermissionFriction([second, first], evidence, H5_NOW);

    expect(reverse).toEqual(forward);
    expect(forward.artifacts).toHaveLength(1);
    expect(forward.measurement?.artifactRevisionId).toBe(forward.artifacts[0]?.artifactRevisionId);
  });

  it.each([
    ["C9", 1],
    ["D14", 1],
    ["H9", 2],
  ] as const)(
    "fails the direct compose boundary closed for unsupported %s/v%s evidence",
    (detectorId, schemaVersion) => {
      const finding = h5Finding({ detectorId, schemaVersion });
      const evidence = h5Evidence({ detectorId });
      const expected = { artifacts: [], measurement: null };

      expect(
        composeH5PermissionFriction([finding], new Map([[H5_FINDING_ID, evidence]]), H5_NOW),
      ).toEqual(expected);
      expect(
        createH5PermissionFrictionHandler(new Map([[H5_FINDING_ID, evidence]])).compose({
          findings: [finding],
          now: H5_NOW,
          window: { from: H5_NOW, to: H5_NOW },
        }),
      ).toEqual(expected);
    },
  );
});
