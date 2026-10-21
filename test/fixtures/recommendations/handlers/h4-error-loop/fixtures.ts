import type { EngineFinding } from "../../../../../src/recommendations/correlation.js";
import type { H4MeasurementObservationV1 } from "../../../../../src/recommendations/handlers/h4-error-loop/index.js";

export const H4_FIXTURE_NOW = "2026-09-16T12:00:00.000Z";
export const H4_FIXTURE_WINDOW = {
  from: "2026-09-09T12:00:00.000Z",
  to: H4_FIXTURE_NOW,
} as const;

export function h4Finding(
  id: string,
  detectorId: string,
  changes: Partial<EngineFinding> = {},
): EngineFinding {
  return {
    id: id as EngineFinding["id"],
    detectorId,
    schemaVersion: 2,
    observedAt: H4_FIXTURE_NOW,
    correlationKey: "session-error-loop-opaque",
    ceuPoolId: "h4-pool-opaque" as EngineFinding["ceuPoolId"],
    ceuPerWeek: 120,
    confidence: 0.9,
    ...changes,
  };
}

export const healthyNoChangeFixture = {
  name: "healthy-no-change",
  findings: [] as readonly EngineFinding[],
  expectedArtifact: false,
} as const;

export const actionableFixture = {
  name: "actionable-repeated-failure-with-recovery-context",
  findings: [h4Finding("finding-c5", "C5"), h4Finding("finding-c4", "C4")],
  expectedArtifact: true,
} as const;

export const sparseFixture = {
  name: "sparse-read-first-signal",
  findings: [h4Finding("finding-c3", "C3")],
  expectedArtifact: false,
} as const;

export const conflictingFixture = {
  name: "conflicting-session-correlation",
  findings: [
    h4Finding("finding-c4-a", "C4"),
    h4Finding("finding-c5-b", "C5", {
      correlationKey: "different-session-opaque",
      ceuPoolId: "different-pool-opaque" as EngineFinding["ceuPoolId"],
    }),
  ],
  expectedArtifact: false,
} as const;

export const falsePositiveFixture = {
  name: "isolated-general-errors-without-repeat-signal",
  findings: [h4Finding("finding-c1", "C1"), h4Finding("finding-c2", "C2")],
  expectedArtifact: false,
} as const;

export const supportedFamilyFixture = {
  name: "all-supported-c-family-signals-backed-by-repeat-evidence",
  findings: [
    h4Finding("finding-c1", "C1"),
    h4Finding("finding-c2", "C2"),
    h4Finding("finding-c3", "C3"),
    h4Finding("finding-c4", "C4"),
    h4Finding("finding-c5", "C5"),
    h4Finding("finding-c6", "C6"),
    h4Finding("finding-c7", "C7"),
    h4Finding("finding-c8", "C8"),
    h4Finding("finding-c10", "C10"),
    h4Finding("finding-c11", "C11"),
  ],
  expectedArtifact: true,
} as const;

export const malformedFixture = {
  name: "malformed-extra-content",
  findings: [
    {
      ...h4Finding("finding-c5-malformed", "C5"),
      rawError: "must never enter the handler artifact",
    },
  ] as unknown as readonly EngineFinding[],
  expectedArtifact: false,
} as const;

export function measurementFixtures(artifactRevisionId: string): {
  readonly recovery: H4MeasurementObservationV1;
  readonly noChange: H4MeasurementObservationV1;
  readonly adverse: H4MeasurementObservationV1;
  readonly slightGuardrailRegression: H4MeasurementObservationV1;
  readonly sparse: H4MeasurementObservationV1;
} {
  const baseline = {
    eligibleSessions: 100,
    repeatedFailureSessions: 30,
    totalFailures: 80,
    recoveryLoopSessions: 20,
  } as const;
  return {
    recovery: {
      schemaVersion: 1,
      artifactRevisionId,
      baseline,
      after: {
        eligibleSessions: 100,
        repeatedFailureSessions: 15,
        totalFailures: 70,
        recoveryLoopSessions: 12,
      },
    },
    noChange: {
      schemaVersion: 1,
      artifactRevisionId,
      baseline,
      after: {
        eligibleSessions: 100,
        repeatedFailureSessions: 29,
        totalFailures: 80,
        recoveryLoopSessions: 20,
      },
    },
    adverse: {
      schemaVersion: 1,
      artifactRevisionId,
      baseline,
      after: {
        eligibleSessions: 100,
        repeatedFailureSessions: 12,
        totalFailures: 100,
        recoveryLoopSessions: 30,
      },
    },
    slightGuardrailRegression: {
      schemaVersion: 1,
      artifactRevisionId,
      baseline,
      after: {
        eligibleSessions: 100,
        repeatedFailureSessions: 12,
        totalFailures: 81,
        recoveryLoopSessions: 21,
      },
    },
    sparse: {
      schemaVersion: 1,
      artifactRevisionId,
      baseline: {
        eligibleSessions: 10,
        repeatedFailureSessions: 3,
        totalFailures: 8,
        recoveryLoopSessions: 2,
      },
      after: {
        eligibleSessions: 8,
        repeatedFailureSessions: 1,
        totalFailures: 4,
        recoveryLoopSessions: 1,
      },
    },
  };
}
