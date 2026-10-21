/**
 * test/detector/d7-xread-query-plan.test.ts — the cross-session read rollup must not rescan its
 * "edited" CTE once per read row (D7 perf regression, 2026-10-13: 20 s per call on the live DB).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { d7xClaimProducer } from "../../src/detector/detectors/d7_loop_retry_waste.js";
import { buildContext } from "../../src/detector/engine.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("D7 cross-session read rollup query plan", () => {
  it("does not scan the edited CTE inside a per-row correlated subquery", () => {
    const seen: string[] = [];
    const prepare = db.prepare.bind(db) as (sql: string) => Database.Statement;
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);

    [...d7xClaimProducer.produce(db, CTX)];

    const sql = seen.find((s) => s.includes("per_session_reads"));
    expect(sql).toBeDefined();
    const placeholders = (sql as string).match(/\?/g)?.length ?? 0;
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: placeholders }, (_, i) => (i < 4 ? "2027-01-01" : 1)))
      .map((row) => (row as { detail: string }).detail);

    expect(plan.filter((line) => /^SCAN d\b/.test(line))).toEqual([]);
  });

  // NOT IN matches nothing once its list holds a NULL, which would silently empty D7. The edited
  // set must stay NULL-free: session_id NOT NULL in the schema, file_path_hash filtered in the CTE.
  it("keeps the NOT IN list NULL-free", () => {
    const cols = db.prepare("PRAGMA table_info(tool_events)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(cols.find((c) => c.name === "session_id")?.notnull).toBe(1);

    const seen: string[] = [];
    const prepare = db.prepare.bind(db) as (sql: string) => Database.Statement;
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    [...d7xClaimProducer.produce(db, CTX)];

    const sql = seen.find((s) => s.includes("per_session_reads")) as string;
    const edited = sql.slice(sql.indexOf("edited AS ("), sql.indexOf("per_session_reads AS"));
    expect(edited).toMatch(/m\.file_path_hash IS NOT NULL/);
  });
});
