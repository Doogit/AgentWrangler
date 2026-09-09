import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";

const TABLES = [
  "work_records",
  "work_record_revisions",
  "work_record_session_links",
  "work_record_context_refs",
  "work_record_mutations",
  "work_record_tombstones",
  "work_allocation_revisions",
  "work_session_allocations",
  "work_allocation_record_snapshots",
] as const;

describe("019 work-record migration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });
  afterEach(() => db.close());

  it("upgrades a populated old database without changing legacy PR/effect rows", () => {
    runMigrations(db, "018_effect_cycles");
    db.exec(`
      INSERT INTO workspaces (workspace_id, project_slug, registered_at)
        VALUES ('ws', 'slug', '2026-01-01T00:00:00Z');
      INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
        VALUES ('gh:o/r#1', 'ws', 1, 'OPEN', '2026-01-01T00:00:00Z');
      INSERT INTO recommendations
        (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
         modeled_formula_json, evidence_json, target_metric, state, created_at)
        VALUES ('rec1', 'RULE', 'D1', 'EFFICIENCY', 'ws', 'do', '{}', '{}', 'm',
                'PROPOSED', '2026-01-01T00:00:00Z');
      INSERT INTO recommendation_effects
        (rec_id, measured_at, before_from, before_to, after_from, after_to,
         before_value, after_value, before_n, after_n, delta_pct, verdict)
        VALUES ('rec1', '2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z',
                '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z',
                '2026-01-03T00:00:00Z', 1, 2, 1, 1, 100, 'EFFECTIVE');
    `);

    expect(runMigrations(db)).toEqual(["019_work_records"]);
    for (const table of TABLES) {
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      ).toBeDefined();
    }
    expect(
      db.prepare("SELECT number, state FROM work_items WHERE work_item_id='gh:o/r#1'").get(),
    ).toEqual({ number: 1, state: "OPEN" });
    expect(
      db
        .prepare("SELECT before_value, after_value FROM recommendation_effects WHERE rec_id='rec1'")
        .get(),
    ).toEqual({ before_value: 1, after_value: 2 });
    expect(runMigrations(db)).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("backs workspace equality and immutable revision history with database triggers", () => {
    runMigrations(db);
    db.exec(`
      INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES
        ('a','a','2026-01-01T00:00:00Z'), ('b','b','2026-01-01T00:00:00Z');
      INSERT INTO sessions (session_id, workspace_id, file_path, state)
        VALUES ('s','b','s.jsonl','RECONCILED');
      INSERT INTO work_records
        (work_record_id, workspace_id, created_at, updated_at, current_revision_no)
        VALUES ('r','a','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0);
      INSERT INTO work_record_revisions
        (work_record_id, revision_no, task_intent, outcome_state, repair_band, effort_band,
         feedback_source, recorded_at, mutation_id)
        VALUES ('r',0,'IMPLEMENT','ACTIVE','UNREPORTED','UNREPORTED','NONE',
                '2026-01-01T00:00:00Z','m');
    `);
    expect(() =>
      db.exec(`INSERT INTO work_record_session_links
      (work_record_id, session_id, linked_revision_no, linked_at, link_source, link_mutation_id)
      VALUES ('r','s',0,'2026-01-01T00:00:00Z','USER','link')`),
    ).toThrow(/workspace_mismatch/);
    expect(() =>
      db.exec("UPDATE work_record_revisions SET outcome_state='USEFUL' WHERE work_record_id='r'"),
    ).toThrow(/revision_immutable/);
    expect(() =>
      db.exec("UPDATE work_records SET workspace_id='b' WHERE work_record_id='r'"),
    ).toThrow(/identity_immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
