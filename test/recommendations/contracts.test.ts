import { describe, expect, it } from "vitest";
import {
  compareAndSetActiveRevision,
  decideAdmission,
  hasConservedExclusiveCeu,
  hasExactEffectBinding,
  projectLifecycle,
} from "../../src/recommendations/types.js";
import {
  application,
  artifact,
  effectCycle,
  method,
  primaryAdmission,
  recommendation,
  revisionOne,
  revisionTwo,
} from "../fixtures/recommendations/decision-fixtures.js";
import { lifecycleFixtures } from "../fixtures/recommendations/lifecycle-fixtures.js";

describe("HRE-0 recommendation contracts", () => {
  it("keeps a stable decision identity while revisions supersede through CAS", () => {
    expect(revisionTwo.recommendationId).toBe(revisionOne.recommendationId);
    expect(revisionTwo.id).not.toBe(revisionOne.id);
    expect(
      compareAndSetActiveRevision(recommendation, revisionTwo, {
        recommendationId: recommendation.id,
        expectedActiveRevisionId: revisionOne.id,
        nextRevisionId: revisionTwo.id,
      }),
    ).toMatchObject({ kind: "APPLIED", recommendation: { activeRevisionId: revisionTwo.id } });
    expect(
      compareAndSetActiveRevision(recommendation, revisionTwo, {
        recommendationId: recommendation.id,
        expectedActiveRevisionId: revisionTwo.id,
        nextRevisionId: revisionTwo.id,
      }),
    ).toMatchObject({ kind: "CONFLICT" });
    expect(
      compareAndSetActiveRevision(
        recommendation,
        { ...revisionTwo, supersedesRevisionId: null },
        {
          recommendationId: recommendation.id,
          expectedActiveRevisionId: revisionOne.id,
          nextRevisionId: revisionTwo.id,
        },
      ),
    ).toMatchObject({ kind: "INVALID_SUPERSESSION" });
  });

  it("requires exact artifact revision, application, method, and observed revision binding", () => {
    expect(hasExactEffectBinding(effectCycle, revisionTwo, application, artifact, method)).toBe(
      true,
    );
    expect(
      hasExactEffectBinding(
        { ...effectCycle, artifactRevisionId: "artifact-revision:other" as typeof artifact.id },
        revisionTwo,
        application,
        artifact,
        method,
      ),
    ).toBe(false);
    expect(
      hasExactEffectBinding(
        effectCycle,
        revisionTwo,
        { ...application, result: "FAILED" },
        artifact,
        method,
      ),
    ).toBe(false);
    expect(
      hasExactEffectBinding(
        { ...effectCycle, recommendationId: "recommendation:other" as typeof recommendation.id },
        revisionTwo,
        application,
        artifact,
        method,
      ),
    ).toBe(false);
  });

  it("routes null value to investigate but admits an eligible safety exception", () => {
    expect(decideAdmission({ ...primaryAdmission, expectedSavingsUsdPerWeek: null })).toMatchObject(
      { lifecycle: "INVESTIGATE" },
    );
    expect(
      decideAdmission({
        ...primaryAdmission,
        expectedSavingsUsdPerWeek: null,
        safetyException: {
          eligible: true,
          reasonCode: "SECRET_RISK" as (typeof revisionTwo.reasonCodes)[number],
        },
      }),
    ).toEqual({ lifecycle: "ACTIONABLE", reasonCodes: ["SAFETY_EXCEPTION", "SECRET_RISK"] });
    expect(
      decideAdmission({
        ...primaryAdmission,
        deterministicHandler: false,
        expectedSavingsUsdPerWeek: null,
        safetyException: {
          eligible: true,
          reasonCode: "SECRET_RISK" as (typeof revisionTwo.reasonCodes)[number],
        },
      }),
    ).toMatchObject({ lifecycle: "INVESTIGATE" });
  });

  it("conserves each CEU pool under exactly one value owner", () => {
    const poolId = "ceu-pool:context" as Parameters<
      typeof hasConservedExclusiveCeu
    >[0] extends ReadonlyMap<infer Key, number>
      ? Key
      : never;
    const total = new Map([[poolId, 10]]);
    expect(
      hasConservedExclusiveCeu(total, [
        {
          poolId,
          recommendationRevisionId: revisionTwo.id,
          contributionCeuPerWeek: 10,
          ownsValue: true,
        },
      ]),
    ).toBe(true);
    expect(
      hasConservedExclusiveCeu(total, [
        {
          poolId,
          recommendationRevisionId: revisionTwo.id,
          contributionCeuPerWeek: 5,
          ownsValue: true,
        },
        {
          poolId,
          recommendationRevisionId: revisionOne.id,
          contributionCeuPerWeek: 5,
          ownsValue: true,
        },
      ]),
    ).toBe(false);
  });

  it.each(lifecycleFixtures)("projects $expected", ({ input, expected }) => {
    expect(projectLifecycle(input)).toBe(expected);
  });
});
