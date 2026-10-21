/** Additive route proof for the HRE queue; legacy recommendations stay untouched. */

import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { listRecommendationQueue } from "../../src/query/api/recommendation-queue-reader.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import {
  appendArtifactRevision,
  appendComposedRecommendationRevision,
  appendCompositionSnapshot,
  appendMeasurementMethod,
  appendNativeFinding,
  publishCompositionSnapshot,
} from "../../src/recommendations/storage.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2026-09-09T00:00:00.000Z";
const NOW = "2026-09-16T00:00:00.000Z";

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function seedQueue(db: Database.Database): void {
  appendNativeFinding(db, {
    findingId: "finding-queue-1",
    detectorId: "detector-queue",
    detectorContractVersion: 2,
    scopeHash: "scope-queue",
    windowFrom: FROM,
    windowTo: NOW,
    findingCount: 2,
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
  appendNativeFinding(db, {
    findingId: "finding-queue-2",
    detectorId: "detector-queue",
    detectorContractVersion: 2,
    scopeHash: "scope-queue-2",
    windowFrom: FROM,
    windowTo: NOW,
    findingCount: 1,
    affectedSessions: 1,
    exclusiveCeu: 3,
    confidence: 0.7,
    safeAnchorIds: [],
    provenanceCode: "SYNTHETIC_FIXTURE",
    lifecycle: "OPEN",
    observedAt: NOW,
    reasonCode: "SYNTHETIC_FINDING",
    createdAt: NOW,
  });
  appendCompositionSnapshot(db, {
    snapshotId: "snapshot-queue",
    compositionVersion: 1,
    registryVersion: "registry-queue",
    rankingPolicyVersion: "ranking-policy-2",
    priceVersion: "price-queue",
    capabilityProfileId: null,
    windowFrom: FROM,
    windowTo: NOW,
    createdAt: NOW,
    pools: [
      { ceuPoolId: "pool-queue", totalCeuPerWeek: 5 },
      { ceuPoolId: "pool-queue-2", totalCeuPerWeek: 3 },
    ],
  });
  appendComposedRecommendationRevision(db, {
    recommendationId: "recommendation-queue",
    recommendationRevisionId: "revision-queue",
    expectedActiveRevisionId: null,
    snapshotId: "snapshot-queue",
    handlerFamily: "handler-queue",
    handlerVersion: "1",
    registryVersion: "registry-queue",
    rankingPolicyVersion: "ranking-policy-2",
    expectedValue: 12,
    expectedValueUnit: "USD_PER_WEEK",
    valueMethodId: "method-queue",
    valueMethodVersion: "1",
    valueWindowFrom: FROM,
    valueWindowTo: NOW,
    reasonCodes: ["PRIMARY_ADMISSION"],
    createdAt: NOW,
    findingLinks: [
      {
        findingId: "finding-queue-1",
        ceuPoolId: "pool-queue",
        evidenceRole: "PRIMARY",
        contributionCeuPerWeek: 5,
        ownsValue: true,
      },
    ],
  });
  appendArtifactRevision(db, {
    artifactRevisionId: "artifact-queue",
    recommendationRevisionId: "revision-queue",
    artifactKind: "advice",
    artifactHash: "hash-queue",
    capabilityProfileVersion: "profile-queue",
    validationStatus: "VALIDATED",
    rollbackAvailable: false,
    supersedesArtifactRevisionId: null,
    createdAt: NOW,
  });
  appendMeasurementMethod(db, {
    measurementMethodId: "measurement-queue",
    artifactRevisionId: "artifact-queue",
    methodVersion: "1",
    targetMetricCode: "CEU_PER_WEEK",
    verdict: "AUTOMATIC",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "BASELINE",
      afterCohortCode: "AFTER",
      guardrailCodes: ["NO_REGRESSION"],
      comparabilityCode: "MATCHED",
    },
    createdAt: NOW,
  });
  appendComposedRecommendationRevision(db, {
    recommendationId: "recommendation-queue-2",
    recommendationRevisionId: "revision-queue-2",
    expectedActiveRevisionId: null,
    snapshotId: "snapshot-queue",
    handlerFamily: "handler-queue",
    handlerVersion: "1",
    registryVersion: "registry-queue",
    rankingPolicyVersion: "ranking-policy-2",
    expectedValue: 6,
    expectedValueUnit: "USD_PER_WEEK",
    valueMethodId: "method-queue",
    valueMethodVersion: "1",
    valueWindowFrom: FROM,
    valueWindowTo: NOW,
    reasonCodes: ["PRIMARY_ADMISSION"],
    createdAt: NOW,
    findingLinks: [
      {
        findingId: "finding-queue-2",
        ceuPoolId: "pool-queue-2",
        evidenceRole: "PRIMARY",
        contributionCeuPerWeek: 3,
        ownsValue: true,
      },
    ],
  });
  appendArtifactRevision(db, {
    artifactRevisionId: "artifact-queue-2",
    recommendationRevisionId: "revision-queue-2",
    artifactKind: "advice",
    artifactHash: "hash-queue-2",
    capabilityProfileVersion: "profile-queue",
    validationStatus: "VALIDATED",
    rollbackAvailable: false,
    supersedesArtifactRevisionId: null,
    createdAt: NOW,
  });
  appendMeasurementMethod(db, {
    measurementMethodId: "measurement-queue-2",
    artifactRevisionId: "artifact-queue-2",
    methodVersion: "1",
    targetMetricCode: "CEU_PER_WEEK",
    verdict: "AUTOMATIC",
    definition: {
      targetDirection: "REDUCE",
      horizonDays: 7,
      baselineCohortCode: "BASELINE",
      afterCohortCode: "AFTER",
      guardrailCodes: ["NO_REGRESSION"],
      comparabilityCode: "MATCHED",
    },
    createdAt: NOW,
  });
  publishCompositionSnapshot(db, "snapshot-queue");
}

let server: http.Server;
let port: number;
let db: Database.Database;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  seedQueue(db);
  setQueryDb(db);
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  resetQueryDb();
  db.close();
});

describe("GET /api/recommendation-queue", () => {
  it("serves one published HRE snapshot with unknown fields still null", async () => {
    const response = await get(port, "/api/recommendation-queue?page_size=1");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      data: {
        kind: string;
        snapshot: { compositionSnapshotId: string };
        items: Array<Record<string, unknown>>;
      };
      meta: { n: number };
    };
    expect(body.meta.n).toBe(2);
    expect(body.data.snapshot.compositionSnapshotId).toBe("snapshot-queue");
    expect(body.data).toMatchObject({ kind: "PAGE" });
    expect(body.data.items).toEqual([
      expect.objectContaining({
        stableId: "recommendation-queue",
        activeRevisionId: "revision-queue",
        lifecycle: "ACTIONABLE",
        expectedSavingsUsdPerWeek: 12,
        confidence: 0.8,
        applicability: null,
        safetyPin: null,
        safetyClass: null,
        workspaceId: null,
        scopeId: "scope-queue",
        artifactKind: "advice",
        measurementVerdict: "AUTOMATIC",
        measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
        compatibility: "NATIVE",
      }),
    ]);
  });

  it("keeps the legacy recommendations endpoint on its existing projection", async () => {
    const response = await get(port, "/api/recommendations");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { data: Record<string, unknown> | null };
    expect(body.data).not.toHaveProperty("kind");
    expect(body.data).not.toHaveProperty("snapshot");
  });

  it("rejects malformed filters and serves the measured sort without an HRE-5 fallback", async () => {
    const invalid = await get(
      port,
      "/api/recommendation-queue?filters=%7B%22unknown%22%3A%5B%22x%22%5D%7D",
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({ code: "INVALID_QUERY" });

    const measured = await get(port, "/api/recommendation-queue?sort=MEASURED_RESULT");
    expect(measured.status).toBe(200);
    const measuredBody = JSON.parse(measured.body) as {
      data: {
        kind: string;
        items: Array<{ stableId: string; measuredState: { kind: string; reason?: string } }>;
      };
    };
    expect(measuredBody.data.kind).toBe("PAGE");
    expect(measuredBody.data.items[0]).toMatchObject({
      stableId: "recommendation-queue",
      measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
    });

    const unknowns = await get(
      port,
      "/api/recommendation-queue?filters=%7B%22measurementVerdict%22%3A%5Bnull%5D%2C%22safetyClass%22%3A%5Bnull%5D%7D",
    );
    expect(unknowns.status).toBe(200);
    expect(JSON.parse(unknowns.body)).toMatchObject({ data: { kind: "PAGE", items: [] } });
  });

  it("keeps a published snapshot and its cursor stable after a draft successor advances active state", () => {
    const firstPage = listRecommendationQueue({ pageSize: 1 });
    expect(firstPage.data).toMatchObject({
      kind: "PAGE",
      items: [{ stableId: "recommendation-queue", activeRevisionId: "revision-queue" }],
    });
    if (firstPage.data?.kind !== "PAGE" || firstPage.data.nextCursor === null) {
      throw new Error("expected a cursor from the published queue snapshot");
    }

    appendNativeFinding(db, {
      findingId: "finding-queue-draft",
      detectorId: "detector-queue",
      detectorContractVersion: 2,
      scopeHash: "scope-queue-draft",
      windowFrom: FROM,
      windowTo: "2026-09-17T00:00:00.000Z",
      findingCount: 1,
      affectedSessions: 1,
      exclusiveCeu: 4,
      confidence: 0.9,
      safeAnchorIds: [],
      provenanceCode: "SYNTHETIC_FIXTURE",
      lifecycle: "OPEN",
      observedAt: "2026-09-17T00:00:00.000Z",
      reasonCode: "SYNTHETIC_FINDING",
      createdAt: "2026-09-17T00:00:00.000Z",
    });
    appendCompositionSnapshot(db, {
      snapshotId: "snapshot-queue-draft",
      compositionVersion: 2,
      registryVersion: "registry-queue",
      rankingPolicyVersion: "ranking-policy-2",
      priceVersion: "price-queue",
      capabilityProfileId: null,
      windowFrom: FROM,
      windowTo: "2026-09-17T00:00:00.000Z",
      createdAt: "2026-09-17T00:00:00.000Z",
      pools: [{ ceuPoolId: "pool-queue-draft", totalCeuPerWeek: 4 }],
    });
    appendComposedRecommendationRevision(db, {
      recommendationId: "recommendation-queue",
      recommendationRevisionId: "revision-queue-draft",
      expectedActiveRevisionId: "revision-queue",
      snapshotId: "snapshot-queue-draft",
      handlerFamily: "handler-queue",
      handlerVersion: "1",
      registryVersion: "registry-queue",
      rankingPolicyVersion: "ranking-policy-2",
      expectedValue: 20,
      expectedValueUnit: "USD_PER_WEEK",
      valueMethodId: "method-queue",
      valueMethodVersion: "1",
      valueWindowFrom: FROM,
      valueWindowTo: "2026-09-17T00:00:00.000Z",
      reasonCodes: ["PRIMARY_ADMISSION"],
      createdAt: "2026-09-17T00:00:00.000Z",
      findingLinks: [
        {
          findingId: "finding-queue-draft",
          ceuPoolId: "pool-queue-draft",
          evidenceRole: "PRIMARY",
          contributionCeuPerWeek: 4,
          ownsValue: true,
        },
      ],
    });

    expect(
      listRecommendationQueue({ pageSize: 1, cursor: firstPage.data.nextCursor }).data,
    ).toMatchObject({
      kind: "PAGE",
      snapshot: { compositionSnapshotId: "snapshot-queue" },
      items: [{ stableId: "recommendation-queue-2", activeRevisionId: "revision-queue-2" }],
    });
  });
});
