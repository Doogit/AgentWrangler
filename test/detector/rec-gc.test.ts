/**
 * Rec-GC (engine.runDetectors) — a detector that is evaluated this run deletes
 * its own stale PROPOSED recs (scopeKey no longer emitted: grain change or a
 * finding that stopped firing), so the query layer shows exactly one row per live
 * (detector, scope). Recs of detectors NOT evaluated this pass, and recs the user
 * has acted on (non-PROPOSED), are preserved.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-08T00:00:00.000Z");

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => db.close());

/** Makes D1 fire on the global CLAUDE.md (mirrors actionability-flag.test). */
function seedD1Oversize(): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, '__global__', '2026-01-01T00:00:00.000Z')`,
  ).run(GLOBAL_WORKSPACE_ID);
  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "probe-gc-claude-md",
    GLOBAL_WORKSPACE_ID,
    "2026-01-07T00:00:00.000Z",
    "CLAUDE_MD",
    "/home/.claude/CLAUDE.md",
    "abc123",
    5000,
    "chars4-v1",
  );
}

/** Insert a synthetic recommendation row with the given detector/scope/state. */
function insertRec(recId: string, detectorId: string, state: string): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at, contract_version, template_id, contract_status)
     VALUES (?, 'RULE', ?, 'CACHE', NULL, 'CACHE', NULL, '{}', '{}', 'X', ?, ?, 1,
             'D1_CONTEXT_ALWAYS_LOADED', 'V1_VALIDATED')`,
  ).run(recId, detectorId, state, "2026-01-01T00:00:00.000Z");
}

function recIds(detectorId: string): string[] {
  return (
    db
      .prepare("SELECT rec_id FROM recommendations WHERE detector_id = ? ORDER BY rec_id")
      .all(detectorId) as Array<{ rec_id: string }>
  ).map((r) => r.rec_id);
}

describe("rec-GC", () => {
  it("deletes an evaluated detector's stale PROPOSED rec not re-emitted this run", () => {
    seedD1Oversize();
    // Orphan: a prior D1 rec whose scopeKey D1 will not re-emit this run.
    insertRec("rec-D1-global-DEADBEEFDEADBEEF", "D1", "PROPOSED");

    runDetectors(db, { now: NOW });

    const ids = recIds("D1");
    expect(ids).not.toContain("rec-D1-global-DEADBEEFDEADBEEF");
    // D1 still emits its real rec — exactly one live D1 row remains.
    expect(ids.length).toBe(1);
  });

  it("preserves recs of a detector NOT evaluated this pass", () => {
    seedD1Oversize();
    // 'ZZ' is not a registered detector, so runDetectors never evaluates it and
    // must not GC its rows.
    insertRec("rec-ZZ-global-000000000000000a", "ZZ", "PROPOSED");

    runDetectors(db, { now: NOW });

    expect(recIds("ZZ")).toEqual(["rec-ZZ-global-000000000000000a"]);
  });

  it("preserves an orphaned rec the user has acted on (non-PROPOSED)", () => {
    seedD1Oversize();
    insertRec("rec-D1-global-ADOP7EDADOP7EDAD", "D1", "ADOPTED");

    runDetectors(db, { now: NOW });

    // The adopted orphan survives (user intent + FK-child safety), even though its
    // scopeKey was not re-emitted; the freshly-emitted PROPOSED rec is added.
    expect(recIds("D1")).toContain("rec-D1-global-ADOP7EDADOP7EDAD");
  });
});
