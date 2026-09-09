import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedSyntheticHistory } from "../../scripts/benchmark/synthetic-fixture.js";
import { runMigrations } from "../../src/db/migrate.js";
import { type Db, openDb } from "../../src/db/open.js";

const roots: string[] = [];
const databases: Db[] = [];

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

function createSyntheticDb(): Db {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-fixture-"));
  roots.push(root);
  const db = openDb(path.join(root, "synthetic.sqlite"));
  databases.push(db);
  runMigrations(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("synthetic benchmark fixture", () => {
  it.each([1, 200, 999])("preserves small-scale seeding at %i turns", (turns) => {
    const db = createSyntheticDb();
    seedSyntheticHistory(db, turns);
    expect(count(db, "SELECT COUNT(*) AS count FROM turns")).toBe(turns);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it.each([1_000, 10_000, 100_000])("seeds every population at %i turns", (turns) => {
    const db = createSyntheticDb();
    seedSyntheticHistory(db, turns);

    expect(count(db, "SELECT COUNT(*) AS count FROM workspaces")).toBeGreaterThan(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM sessions")).toBeGreaterThan(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM turns")).toBe(turns);
    expect(
      count(
        db,
        `SELECT COUNT(*) AS count FROM sessions s WHERE s.cost_equiv_u !=
      COALESCE((SELECT SUM(t.cost_equiv_u) FROM turns t WHERE t.session_id = s.session_id), 0)`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) AS count FROM session_work_links l
      JOIN sessions s USING(session_id) JOIN work_items w USING(work_item_id)
      WHERE s.workspace_id != w.workspace_id`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS count FROM sessions WHERE file_path LIKE 'synthetic://idle-session-%'",
      ),
    ).toBeGreaterThan(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS count FROM sessions WHERE session_id = 'synthetic-session-0' AND turn_count >= 350",
      ),
    ).toBeGreaterThan(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM tool_events")).toBeGreaterThan(0);
    expect(
      count(db, "SELECT COUNT(*) AS count FROM tool_event_metadata WHERE is_test_command = 1"),
    ).toBeGreaterThan(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM recommendation_effects")).toBeGreaterThan(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM context_inventory")).toBeGreaterThan(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM ingest_offsets")).toBeGreaterThan(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM ingest_metric_baselines")).toBeGreaterThan(0);
  });
});
