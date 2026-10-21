import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleB4 } from "./B4.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  return db;
}
const add = (
  db: Database.Database,
  id: string,
  ws: string,
  sess: string,
  ts: string,
  read: number,
  w5: number,
) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_5m, pricing_snapshot_id) VALUES (?,?,?,?,?,?,'p')",
    )
    .run(id, sess, ws, ts, read, w5);

describe("oracleB4", () => {
  it("counts a rapid collapse and skips the one at the creation threshold", () => {
    const db = mkdb();
    // w1: prev ctx 100000 (reads); cur reads 10000 + 80000 creation (ctx 90000), gap 3 min, creation > 20000 and > 2x 0.
    add(db, "p1", "w1", "s1", "2027-01-02T00:00:00.000Z", 100_000, 0);
    add(db, "c1", "w1", "s1", "2027-01-02T00:03:00.000Z", 10_000, 80_000);
    // w2: collapse (B1) but creation exactly 20,000 is not > 20,000. prev ctx 40000, cur 20000 creation + 19000 reads = 39000.
    add(db, "p2", "w2", "s2", "2027-01-02T00:00:00.000Z", 40_000, 0);
    add(db, "c2", "w2", "s2", "2027-01-02T00:03:00.000Z", 19_000, 20_000);
    const r = oracleB4(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.workspace_id).toBe("w1");
    expect(r.findings[0]?.count).toBe(1);
    expect(r.findings[0]?.quantities.find((q) => q.name === "break_creation_tokens")?.value).toBe(
      80_000,
    );
    expect(r.findings[0]?.measured_u).toBeGreaterThan(0);
  });

  it("near miss: creation not strictly more than 2x previous creation", () => {
    const db = mkdb();
    // prev: 60000 reads + 40000 creation (ctx 100000); cur: 10000 reads + 80000 creation = exactly 2x -> not rapid.
    add(db, "p3", "w3", "s3", "2027-01-02T00:00:00.000Z", 60_000, 40_000);
    add(db, "c3", "w3", "s3", "2027-01-02T00:03:00.000Z", 10_000, 80_000);
    expect(oracleB4(db, NOW).findings).toHaveLength(0);
  });

  it("near miss: gap past 5 minutes is not rapid", () => {
    const db = mkdb();
    add(db, "p4", "w4", "s4", "2027-01-02T00:00:00.000Z", 100_000, 0);
    add(db, "c4", "w4", "s4", "2027-01-02T00:05:01.000Z", 10_000, 80_000);
    expect(oracleB4(db, NOW).findings).toHaveLength(0);
  });
});
