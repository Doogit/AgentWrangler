/**
 * test/db/migrate.test.ts — migration runner tests.
 *
 * Verifies:
 * 1. Migrations apply cleanly on a fresh DB.
 * 2. All expected v2 tables are present after migration.
 * 3. Idempotence: running migrate twice applies nothing the second time.
 * 4. schema_migrations records each applied version.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";

const V2_TABLES = [
  "workspaces",
  "sessions",
  "turns",
  "tool_events",
  "pricing_snapshots",
  "context_inventory",
  "work_items",
  "work_item_branch_keys",
  "session_work_links",
  "observed_outcomes",
  "review_findings",
  "recommendations",
  "recommendation_effects",
  "effect_cycles",
  "effect_guardrail_results",
  "effect_rollback_operations",
  "effect_mutation_keys",
  "hre_capability_profiles",
  "hre_capability_observations",
  "hre_handler_history",
  "hre_composition_snapshots",
  "hre_findings",
  "hre_recommendations",
  "hre_recommendation_revisions",
  "hre_ceu_pools",
  "hre_recommendation_findings",
  "hre_recommendation_lifecycle_events",
  "hre_artifact_revisions",
  "hre_measurement_methods",
  "hre_artifact_applications",
  "hre_effect_cycle_links",
  "hre_intervention_locks",
  "apply_jobs",
  "tool_event_metadata",
  "analysis_runs",
  "ingest_quarantine",
  "ingest_metric_events",
  "ingest_metric_baselines",
  "ingest_offsets",
  "schema_migrations",
  "user_config",
  "reports",
] as const;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-test-"));
  dbPath = path.join(tmpDir, "test.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("creates all v2 tables on a fresh DB", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);

      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );

      for (const table of V2_TABLES) {
        expect(tables.has(table), `expected table ${table} to exist`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("records applied migrations in schema_migrations", () => {
    const db = openDb(dbPath);
    try {
      const applied = runMigrations(db);
      expect(applied.length).toBeGreaterThan(0);

      const rows = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: string }>;

      expect(rows.length).toBe(applied.length);
      // The first migration must be 001_observe.
      expect(rows[0]?.version).toBe("001_observe");
      expect(rows.at(-1)?.version).toBe("053_turns_grade_cover");
    } finally {
      db.close();
    }
  });

  it("sessions table has the three friction columns after migration (013)", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      const cols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      expect(cols.has("compaction_count"), "expected compaction_count column").toBe(true);
      expect(cols.has("api_error_count"), "expected api_error_count column").toBe(true);
      expect(cols.has("interrupt_count"), "expected interrupt_count column").toBe(true);
    } finally {
      db.close();
    }
  });

  it("creates recommendation feedback and goal preference tables", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );

      expect(tables.has("recommendation_feedback")).toBe(true);
      expect(tables.has("recommendation_goal_preference")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("adds nullable file-version fields to ingest offsets (016)", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      const columns = new Set(
        (db.prepare("PRAGMA table_info(ingest_offsets)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      for (const name of ["file_size", "file_dev", "file_ino", "file_mtime_ms", "file_ctime_ms"]) {
        expect(columns.has(name), `expected ${name}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("upgrades a populated 015 offset without changing its position or head hash", () => {
    const db = openDb(dbPath);
    try {
      expect(runMigrations(db, "015_gap_aggregates").at(-1)).toBe("015_gap_aggregates");
      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, file_hash_head, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run("C:/synthetic/session.jsonl", 1234, "old-head-hash", "2026-01-01T00:00:00.000Z");

      expect(runMigrations(db)).toEqual([
        "016_ingest_offset_file_version",
        "017_ingest_metric_events",
        "018_effect_cycles",
        "019_work_records",
        "020_local_command_retention",
        "021_recommendation_feedback",
        "022_classifier_boundaries",
        "023_privacy_contract",
        "024_finding_contract_v2",
        "025_tool_error_classifier",
        "026_recommendation_contract_guards",
        "027_handler_recommendation_storage",
        "028_tool_event_content",
        "029_subagent_meta",
        "030_detector_week_results",
        "031_detector_status_live",
        "032_session_title",
        "033_compaction_positions",
        "034_ingest_metric_events_session_position",
        "035_rec_lifecycle",
        "036_rec_lifecycle_actions",
        "037_subagent_meta_session_index",
        "038_turns_agent_id",
        "039_unrestrict_app_content",
        "040_ledger_daily",
        "041_perf_indexes",
        "042_limit_snapshots",
        "043_tool_error_labels_v2",
        "044_c6_edit_string_hashes",
        "045_catalog_items",
        "046_detector_contract_v2",
        "047_ingest_metric_events_event_ts",
        "048_ingest_offset_identity",
        "049_setup_grade_snapshots",
        "050_setup_grade_indexes",
        "051_judge_verdicts",
        "052_classifier_version_2",
        "053_turns_grade_cover",
      ]);
      const row = db
        .prepare(
          `SELECT byte_offset, file_hash_head, file_size, file_dev, file_ino, file_mtime_ms, file_ctime_ms
           FROM ingest_offsets WHERE file_path = ?`,
        )
        .get("C:/synthetic/session.jsonl") as {
        byte_offset: number;
        file_hash_head: string;
        file_size: number | null;
        file_dev: string | null;
        file_ino: string | null;
        file_mtime_ms: number | null;
        file_ctime_ms: number | null;
      };
      expect(row).toEqual({
        byte_offset: 1234,
        file_hash_head: "old-head-hash",
        file_size: null,
        file_dev: null,
        file_ino: null,
        file_mtime_ms: null,
        file_ctime_ms: null,
      });
    } finally {
      db.close();
    }
  });

  it("adds effect storage without changing populated legacy W4 results", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db, "017_ingest_metric_events");
      db.prepare(`INSERT INTO recommendations
        (rec_id,provenance,detector_id,category,lever,modeled_formula_json,evidence_json,target_metric,state,created_at)
        VALUES('legacy-upgrade','RULE','D2','CONTEXT','fixture','{}','{}','avg_context_per_turn','MEASURED_NO_EFFECT','2026-01-01')`).run();
      db.prepare(`INSERT INTO recommendation_effects
        (rec_id,measured_at,before_from,before_to,after_from,after_to,before_value,after_value,before_n,after_n,delta_pct,verdict)
        VALUES('legacy-upgrade','2026-02-01','2026-01-01','2026-02-01','2026-02-01','2026-02-15',100,84,9,10,-16,'INCONCLUSIVE')`).run();
      const legacy = db.prepare("SELECT * FROM recommendation_effects").all();
      const recommendations = db.prepare("SELECT * FROM recommendations").all();

      expect(runMigrations(db)).toEqual([
        "018_effect_cycles",
        "019_work_records",
        "020_local_command_retention",
        "021_recommendation_feedback",
        "022_classifier_boundaries",
        "023_privacy_contract",
        "024_finding_contract_v2",
        "025_tool_error_classifier",
        "026_recommendation_contract_guards",
        "027_handler_recommendation_storage",
        "028_tool_event_content",
        "029_subagent_meta",
        "030_detector_week_results",
        "031_detector_status_live",
        "032_session_title",
        "033_compaction_positions",
        "034_ingest_metric_events_session_position",
        "035_rec_lifecycle",
        "036_rec_lifecycle_actions",
        "037_subagent_meta_session_index",
        "038_turns_agent_id",
        "039_unrestrict_app_content",
        "040_ledger_daily",
        "041_perf_indexes",
        "042_limit_snapshots",
        "043_tool_error_labels_v2",
        "044_c6_edit_string_hashes",
        "045_catalog_items",
        "046_detector_contract_v2",
        "047_ingest_metric_events_event_ts",
        "048_ingest_offset_identity",
        "049_setup_grade_snapshots",
        "050_setup_grade_indexes",
        "051_judge_verdicts",
        "052_classifier_version_2",
        "053_turns_grade_cover",
      ]);
      expect(db.prepare("SELECT * FROM recommendation_effects").all()).toEqual(legacy);
      expect(db.prepare("SELECT * FROM recommendations").all()).toEqual(
        recommendations.map((row) => ({
          ...(row as Record<string, unknown>),
          contract_version: null,
          template_id: null,
          contract_status: "LEGACY_UNVERIFIED",
          rule_id: null,
        })),
      );
      expect(db.prepare("SELECT * FROM effect_cycles").all()).toEqual([]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(runMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("quarantines invalid persisted contract tuples while installing the guards", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db, "025_tool_error_classifier");
      const insert = db.prepare(`INSERT INTO recommendations
        (rec_id,provenance,detector_id,category,lever,modeled_formula_json,evidence_json,
         target_metric,state,created_at,contract_version,template_id,contract_status,rule_id)
        VALUES(?, 'RULE', 'D1', 'CONTEXT', 'fixture', '{}', '{}',
               'avg_context_per_turn', 'PROPOSED', '2026-01-01', ?, ?, ?, ?)`);
      insert.run("bad-v1", 2, "D1_CONTEXT_ALWAYS_LOADED", "V1_VALIDATED", null);
      insert.run("bad-v2", 2, "D1_CONTEXT_ALWAYS_LOADED", "V2_VALIDATED", "D1");

      expect(runMigrations(db)).toEqual([
        "026_recommendation_contract_guards",
        "027_handler_recommendation_storage",
        "028_tool_event_content",
        "029_subagent_meta",
        "030_detector_week_results",
        "031_detector_status_live",
        "032_session_title",
        "033_compaction_positions",
        "034_ingest_metric_events_session_position",
        "035_rec_lifecycle",
        "036_rec_lifecycle_actions",
        "037_subagent_meta_session_index",
        "038_turns_agent_id",
        "039_unrestrict_app_content",
        "040_ledger_daily",
        "041_perf_indexes",
        "042_limit_snapshots",
        "043_tool_error_labels_v2",
        "044_c6_edit_string_hashes",
        "045_catalog_items",
        "046_detector_contract_v2",
        "047_ingest_metric_events_event_ts",
        "048_ingest_offset_identity",
        "049_setup_grade_snapshots",
        "050_setup_grade_indexes",
        "051_judge_verdicts",
        "052_classifier_version_2",
        "053_turns_grade_cover",
      ]);
      expect(
        db
          .prepare(
            `SELECT rec_id,contract_version,template_id,contract_status,rule_id
               FROM recommendations ORDER BY rec_id`,
          )
          .all(),
      ).toEqual([
        {
          rec_id: "bad-v1",
          contract_version: null,
          template_id: null,
          contract_status: "LEGACY_UNVERIFIED",
          rule_id: null,
        },
        {
          rec_id: "bad-v2",
          contract_version: null,
          template_id: null,
          contract_status: "LEGACY_UNVERIFIED",
          rule_id: null,
        },
      ]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("admits RETIRED without losing rows or contract tuple guards", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db, "034_ingest_metric_events_session_position");
      db.prepare(
        `INSERT INTO recommendations
           (rec_id, provenance, detector_id, category, lever, modeled_formula_json,
            evidence_json, target_metric, state, created_at, contract_version, rule_id,
            contract_status)
         VALUES ('retire-fixture', 'RULE', 'D9', 'TOOLING', 'fixture', '{}', '{}',
                 'fixture_metric', 'PROPOSED', '2026-01-01', 2, 'D9', 'V2_VALIDATED')`,
      ).run();
      expect(runMigrations(db)).toEqual([
        "035_rec_lifecycle",
        "036_rec_lifecycle_actions",
        "037_subagent_meta_session_index",
        "038_turns_agent_id",
        "039_unrestrict_app_content",
        "040_ledger_daily",
        "041_perf_indexes",
        "042_limit_snapshots",
        "043_tool_error_labels_v2",
        "044_c6_edit_string_hashes",
        "045_catalog_items",
        "046_detector_contract_v2",
        "047_ingest_metric_events_event_ts",
        "048_ingest_offset_identity",
        "049_setup_grade_snapshots",
        "050_setup_grade_indexes",
        "051_judge_verdicts",
        "052_classifier_version_2",
        "053_turns_grade_cover",
      ]);
      db.prepare("UPDATE recommendations SET state='RETIRED' WHERE rec_id='retire-fixture'").run();
      expect(
        db
          .prepare(
            "SELECT state, contract_status, rule_id FROM recommendations WHERE rec_id='retire-fixture'",
          )
          .get(),
      ).toEqual({ state: "RETIRED", contract_status: "V2_VALIDATED", rule_id: "D9" });
      expect(() =>
        db.prepare("UPDATE recommendations SET rule_id=NULL WHERE rec_id='retire-fixture'").run(),
      ).toThrow("invalid recommendation contract tuple");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("opens with NORMAL synchronous mode", () => {
    const db = openDb(dbPath);
    try {
      expect(db.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("creates the reconcile indexes", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);

      const turnColumns = db.prepare("PRAGMA index_info(idx_turns_session_ctx)").all() as Array<{
        name: string;
      }>;
      const toolColumns = db
        .prepare("PRAGMA index_info(idx_tool_session_name_hash)")
        .all() as Array<{ name: string }>;

      expect(turnColumns.map((column) => column.name)).toEqual(["session_id", "context_tokens"]);
      expect(toolColumns.map((column) => column.name)).toEqual([
        "session_id",
        "tool_name",
        "input_hash",
      ]);
    } finally {
      db.close();
    }
  });

  it("indexes tool-event owner correlation by owner then event", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      const columns = db.prepare("PRAGMA index_info(idx_tool_meta_owner_event)").all() as Array<{
        seqno: number;
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual(["owner_message_id", "event_id"]);
    } finally {
      db.close();
    }
  });

  it("creates the branch-key schema, composite lookup index, and enforced constraints", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      db.prepare(
        `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
         VALUES ('ws-migration', 'migration-project', '2026-01-01T00:00:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
         VALUES ('gh:owner/repo#1', 'ws-migration', 1, 'OPEN', '2026-01-01T00:00:00Z')`,
      ).run();

      const indexColumns = db
        .prepare("PRAGMA index_info(idx_work_item_branch_key)")
        .all() as Array<{
        name: string;
      }>;
      expect(indexColumns.map((column) => column.name)).toEqual(["head_ref_key", "work_item_id"]);

      const insert = db.prepare(
        `INSERT INTO work_item_branch_keys
           (work_item_id, head_ref_key, normalization_version, synced_at)
         VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`,
      );
      const validKey = "a".repeat(64);
      expect(() => insert.run("gh:owner/repo#1", validKey, "branch-v1")).not.toThrow();

      db.prepare(
        `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
         VALUES ('gh:owner/repo#2', 'ws-migration', 2, 'OPEN', '2026-01-01T00:00:00Z')`,
      ).run();
      expect(() => insert.run("gh:owner/repo#2", "A".repeat(64), "branch-v1")).toThrow();
      expect(() => insert.run("gh:owner/repo#2", "a".repeat(63), "branch-v1")).toThrow();
      expect(() => insert.run("gh:owner/repo#2", validKey, "branch-v2")).toThrow();
      expect(() => insert.run("gh:owner/repo#missing", validKey, "branch-v1")).toThrow();

      db.prepare("DELETE FROM work_items WHERE work_item_id = 'gh:owner/repo#1'").run();
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM work_item_branch_keys").get() as {
        n: number;
      };
      expect(remaining.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("upgrades a database recorded through 006 and is idempotent afterward", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      db.exec("DROP TABLE work_item_branch_keys");
      db.prepare("DELETE FROM schema_migrations WHERE version = '007_work_item_branch_keys'").run();

      expect(runMigrations(db)).toEqual(["007_work_item_branch_keys"]);
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("work_item_branch_keys") as { name: string } | undefined;
      expect(table?.name).toBe("work_item_branch_keys");
      expect(runMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("uses time-first indexes for D7 trailing-window scans", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);

      const toolColumns = db
        .prepare("PRAGMA index_info(idx_tool_ts_session_event)")
        .all() as Array<{
        name: string;
      }>;
      expect(toolColumns.map((column) => column.name)).toEqual(["ts", "session_id", "event_id"]);

      const turnColumns = db
        .prepare("PRAGMA index_info(idx_turns_ts_provisional_session)")
        .all() as Array<{ name: string }>;
      expect(turnColumns.map((column) => column.name)).toEqual(["ts", "provisional", "session_id"]);

      const toolPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT event_id FROM tool_events
            WHERE ts >= ? AND ts < ?
            ORDER BY ts, session_id, event_id`,
        )
        .all("2026-01-01", "2026-01-08") as Array<{ detail: string }>;
      expect(toolPlan.some((row) => row.detail.includes("idx_tool_ts_session_event"))).toBe(true);

      const turnPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT session_id, COUNT(*) FROM turns
            WHERE ts >= ? AND ts < ? AND provisional = 0
            GROUP BY session_id`,
        )
        .all("2026-01-01", "2026-01-08") as Array<{ detail: string }>;
      expect(turnPlan.some((row) => row.detail.includes("idx_turns_ts_provisional_session"))).toBe(
        true,
      );

      const boundaryPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT boundary_kind FROM ingest_metric_events
            WHERE session_id = ? AND event_position < ?
            ORDER BY event_position DESC LIMIT 1`,
        )
        .all("synthetic-session", 12) as Array<{ detail: string }>;
      expect(
        boundaryPlan.some((row) =>
          row.detail.includes(
            "SEARCH ingest_metric_events USING INDEX idx_ingest_metric_events_session_position",
          ),
        ),
      ).toBe(true);
      expect(boundaryPlan.some((row) => row.detail.startsWith("SCAN"))).toBe(false);

      // P2-U8 W0 signature: the window's ingest_metric_events rows by event_ts.
      const w0Plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT group_concat(quote(event_id), char(10) ORDER BY rowid) AS s
             FROM ingest_metric_events WHERE event_ts >= ? AND event_ts < ?`,
        )
        .all("2026-01-01", "2026-01-08") as Array<{ detail: string }>;
      expect(
        w0Plan.some((row) =>
          row.detail.includes(
            "SEARCH ingest_metric_events USING INDEX idx_ingest_metric_events_event_ts",
          ),
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is idempotent: running twice applies nothing the second time", () => {
    const db = openDb(dbPath);
    try {
      const first = runMigrations(db);
      expect(first.length).toBeGreaterThan(0);

      const second = runMigrations(db);
      expect(second.length).toBe(0); // No new migrations applied.
    } finally {
      db.close();
    }
  });

  it("table count matches after idempotent re-run", () => {
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      const count1 = (
        db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'").get() as {
          n: number;
        }
      ).n;

      runMigrations(db); // second run
      const count2 = (
        db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'").get() as {
          n: number;
        }
      ).n;

      expect(count1).toBe(count2);
    } finally {
      db.close();
    }
  });

  it("works with an in-memory DB (for test fixtures)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      const applied = runMigrations(db);
      expect(applied.length).toBeGreaterThan(0);

      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      expect(tables.has("turns")).toBe(true);
    } finally {
      db.close();
    }
  });
});
