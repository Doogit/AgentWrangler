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
  "apply_jobs",
  "tool_event_metadata",
  "analysis_runs",
  "ingest_quarantine",
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
      expect(rows.at(-1)?.version).toBe("015_gap_aggregates");
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
