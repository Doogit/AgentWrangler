/**
 * U9 r2: C1 used to fire one card for several tools; it fires one per tool now. The old row must
 * not stay active with its superseded counts (it counted a user rejection and an Artifact refusal
 * as failures). SEC-101: synthetic ids and counts only.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c1Detector } from "../../src/detector/detectors/c1_tool_error_rate.js";
import { runHistoryWalk } from "../../src/detector/engine.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
let db: Database.Database;
beforeEach(() => {
  db = migratedMemDb();
});
afterEach(() => db.close());

function insertC1(recId: string, tools: string): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, lever, modeled_formula_json, evidence_json, target_metric, state, created_at)
     VALUES (?, 'RULE', 'C1', 'TOOLING', 'lever', '{}', ?, 'tool_error_rate', 'PROPOSED', ?)`,
  ).run(
    recId,
    JSON.stringify({ metrics: { OUTLIER_TOOLS: { kind: "TEXT", value: tools } } }),
    NOW.toISOString(),
  );
}

const state = (recId: string) =>
  (db.prepare("SELECT state FROM recommendations WHERE rec_id = ?").get(recId) as { state: string })
    .state;

describe("C1 legacy multi-tool card", () => {
  it("is retired by a history walk; a single-tool row is kept", async () => {
    insertC1("rec-C1-legacy-multi", "ToolA, ToolB, AskUserQuestion");
    insertC1("rec-C1-single", "ToolA");
    await runHistoryWalk(db, NOW, { detectors: [c1Detector] });
    expect(state("rec-C1-legacy-multi")).toBe("RETIRED");
    expect(state("rec-C1-single")).not.toBe("RETIRED");
  });
});
