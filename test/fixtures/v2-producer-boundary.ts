import type Database from "better-sqlite3";
import { expect } from "vitest";
import { runDetectors } from "../../src/detector/engine.js";
import type { DetectorContext, DetectorV2 } from "../../src/detector/types.js";
import { getRecommendationCard } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { trustedRecommendationContract } from "../../src/query/recommendation-contract.js";

/** Exercise a real producer through the shared write boundary and trusted API reader. */
export function assertV2ProducerBoundary(
  db: Database.Database,
  context: DetectorContext,
  detector: DetectorV2,
): void {
  runDetectors(db, context, [detector]);
  const rows = db
    .prepare("SELECT * FROM recommendations WHERE detector_id=? ORDER BY rec_id")
    .all(detector.id) as Array<Record<string, unknown>>;
  expect(rows.length).toBeGreaterThan(0);
  setQueryDb(db);
  try {
    for (const row of rows) {
      const trusted = trustedRecommendationContract(
        row as unknown as Parameters<typeof trustedRecommendationContract>[0],
      );
      expect(trusted).toMatchObject({ version: 2 });
      expect(getRecommendationCard(String(row.rec_id))).toMatchObject({
        detector_id: detector.id,
        evidence: trusted?.payload,
      });
    }
  } finally {
    resetQueryDb();
  }
}
