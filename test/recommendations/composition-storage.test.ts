import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendComposedRecommendationRevision,
  appendCompositionSnapshot,
  appendNativeFinding,
  publishCompositionSnapshot,
  readRecommendationGraph,
} from "../../src/recommendations/storage.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2026-09-09T00:00:00.000Z";
const NOW = "2026-09-16T00:00:00.000Z";
let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => db.close());

function appendFinding(id: string): void {
  appendNativeFinding(db, {
    findingId: id,
    detectorId: "synthetic-detector",
    detectorContractVersion: 2,
    scopeHash: `scope-${id}`,
    windowFrom: FROM,
    windowTo: NOW,
    findingCount: 1,
    affectedSessions: 1,
    exclusiveCeu: 5,
    confidence: 0.8,
    safeAnchorIds: [],
    provenanceCode: "SYNTHETIC_FIXTURE",
    lifecycle: "OPEN",
    observedAt: NOW,
    reasonCode: "SYNTHETIC_FINDING",
    createdAt: NOW,
  });
}

function appendSnapshot(): void {
  appendCompositionSnapshot(db, {
    snapshotId: "snapshot-1",
    compositionVersion: 1,
    registryVersion: "registry-1",
    rankingPolicyVersion: "ranking-policy-2",
    priceVersion: "price-1",
    capabilityProfileId: null,
    windowFrom: FROM,
    windowTo: NOW,
    createdAt: NOW,
    pools: [{ ceuPoolId: "pool-1", totalCeuPerWeek: 5 }],
  });
}

describe("HRE-2 composition storage boundary", () => {
  it("writes a draft snapshot and multi-finding owner/support graph atomically", () => {
    appendFinding("finding-a");
    appendFinding("finding-b");
    appendSnapshot();
    appendComposedRecommendationRevision(db, {
      recommendationId: "recommendation-1",
      recommendationRevisionId: "revision-1",
      expectedActiveRevisionId: null,
      snapshotId: "snapshot-1",
      handlerFamily: "synthetic-handler",
      handlerVersion: "1",
      registryVersion: "registry-1",
      rankingPolicyVersion: "ranking-policy-2",
      expectedValue: 10,
      expectedValueUnit: "USD_PER_WEEK",
      valueMethodId: "ranking-policy-2",
      valueMethodVersion: "1",
      valueWindowFrom: FROM,
      valueWindowTo: NOW,
      reasonCodes: ["PRIMARY_ADMISSION"],
      createdAt: NOW,
      findingLinks: [
        {
          findingId: "finding-b",
          ceuPoolId: "pool-1",
          evidenceRole: "SUPPORTING",
          contributionCeuPerWeek: 0,
          ownsValue: false,
        },
        {
          findingId: "finding-a",
          ceuPoolId: "pool-1",
          evidenceRole: "PRIMARY",
          contributionCeuPerWeek: 5,
          ownsValue: true,
        },
      ],
    });
    expect(() => publishCompositionSnapshot(db, "snapshot-1")).not.toThrow();
    expect(readRecommendationGraph(db, "recommendation-1")).toMatchObject({
      activeRevisionId: "revision-1",
      state: "PUBLISHED",
      findingIds: ["finding-a", "finding-b"],
    });
    expect(
      db
        .prepare(
          `SELECT finding_id, evidence_role, contribution_ceu_per_week, owns_value
             FROM hre_recommendation_findings ORDER BY finding_id`,
        )
        .all(),
    ).toEqual([
      {
        finding_id: "finding-a",
        evidence_role: "PRIMARY",
        contribution_ceu_per_week: 5,
        owns_value: 1,
      },
      {
        finding_id: "finding-b",
        evidence_role: "SUPPORTING",
        contribution_ceu_per_week: 0,
        owns_value: 0,
      },
    ]);
  });

  it("rejects malformed snapshots and link sets before partial writes", () => {
    expect(() =>
      appendCompositionSnapshot(db, {
        snapshotId: "snapshot-invalid",
        compositionVersion: 1,
        registryVersion: "registry-1",
        rankingPolicyVersion: "ranking-policy-2",
        priceVersion: "price-1",
        capabilityProfileId: null,
        windowFrom: FROM,
        windowTo: NOW,
        createdAt: NOW,
        pools: [
          { ceuPoolId: "pool-1", totalCeuPerWeek: 5 },
          { ceuPoolId: "pool-1", totalCeuPerWeek: 5 },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM hre_composition_snapshots").get()).toEqual({
      count: 0,
    });

    appendFinding("finding-a");
    appendSnapshot();
    const base = {
      recommendationId: "recommendation-1",
      recommendationRevisionId: "revision-1",
      expectedActiveRevisionId: null,
      snapshotId: "snapshot-1",
      handlerFamily: "synthetic-handler",
      handlerVersion: "1",
      registryVersion: "registry-1",
      rankingPolicyVersion: "ranking-policy-2",
      expectedValue: 10,
      expectedValueUnit: "USD_PER_WEEK" as const,
      valueMethodId: "ranking-policy-2",
      valueMethodVersion: "1",
      valueWindowFrom: FROM,
      valueWindowTo: NOW,
      reasonCodes: ["PRIMARY_ADMISSION"],
      createdAt: NOW,
    };
    expect(() =>
      appendComposedRecommendationRevision(db, {
        ...base,
        findingLinks: [
          {
            findingId: "finding-a",
            ceuPoolId: "pool-1",
            evidenceRole: "SUPPORTING",
            contributionCeuPerWeek: 5,
            ownsValue: false,
          },
        ],
      }),
    ).toThrow(/supporting/);
    expect(() =>
      appendComposedRecommendationRevision(db, {
        ...base,
        findingLinks: [
          {
            findingId: "finding-missing",
            ceuPoolId: "pool-1",
            evidenceRole: "PRIMARY",
            contributionCeuPerWeek: 5,
            ownsValue: true,
          },
        ],
      }),
    ).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM hre_recommendations").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM hre_recommendation_revisions").get()).toEqual({
      count: 0,
    });
  });
});
