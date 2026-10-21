import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleB2 } from "./B2.js";

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
  w1: number,
) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_1h, pricing_snapshot_id) VALUES (?,?,?,?,?,?,'p')",
    )
    .run(id, sess, ws, ts, read, w1);

describe("oracleB2", () => {
  it("counts a collapse after the 1h TTL and carries the sums, longest gap and TTL", () => {
    const db = mkdb();
    // prev: ctx 100000 (reads 60000 + 1h 40000). cur: reads 10000 + 1h 85000 = ctx 95000, creation 85000 >= 50000.
    // First turn ctx 100000 = base, so avoidable = 85000 - 100000 < 0 -> add a small-start session to lower the base.
    // Reads 20000 < 0.5 x 60000 (B2 collapse) but >= 20% of 85000, so not a D8 event (no D8 card).
    add(db, "p1", "w1", "s1", "2027-01-02T00:00:00.000Z", 60_000, 40_000);
    add(db, "c1", "w1", "s1", "2027-01-02T02:05:00.000Z", 20_000, 85_000);
    add(db, "f2", "w1", "s2", "2027-01-03T00:00:00.000Z", 1_000, 4_000); // base = median(100000, 5000) = 52500
    const r = oracleB2(db, NOW);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.count).toBe(1);
    const q = (n: string) => f?.quantities.find((x) => x.name === n)?.value;
    expect(q("previous_cache_read_tokens")).toBe(60_000);
    expect(q("current_cache_read_tokens")).toBe(20_000);
    expect(q("current_cache_creation_tokens")).toBe(85_000);
    expect(q("longest_gap_ms")).toBe(125 * 60000);
    expect(q("longest_gap_ttl_ms")).toBe(60 * 60000);
  });

  it("F26: no B2 finding in a workspace that has a D8 card (reads under 20% of the write)", () => {
    const db = mkdb();
    add(db, "p1", "w1", "s1", "2027-01-02T00:00:00.000Z", 60_000, 40_000);
    add(db, "c1", "w1", "s1", "2027-01-02T02:05:00.000Z", 10_000, 85_000);
    add(db, "f2", "w1", "s2", "2027-01-03T00:00:00.000Z", 1_000, 4_000);
    expect(oracleB2(db, NOW).findings).toHaveLength(0);
  });

  it("near miss: gap exactly at the 60 min TTL is B1's, not B2's", () => {
    const db = mkdb();
    add(db, "p3", "w3", "s3", "2027-01-02T00:00:00.000Z", 60_000, 40_000);
    add(db, "c3", "w3", "s3", "2027-01-02T01:00:00.000Z", 10_000, 85_000);
    add(db, "f4", "w3", "s4", "2027-01-03T00:00:00.000Z", 1_000, 4_000);
    expect(oracleB2(db, NOW).findings).toHaveLength(0);
  });

  it("near miss: creation not above the base prefix gives no avoidable tokens", () => {
    const db = mkdb();
    // Only session starts at ctx 100000 = base; creation 85000 - 100000 < 0.
    add(db, "p5", "w5", "s5", "2027-01-02T00:00:00.000Z", 60_000, 40_000);
    add(db, "c5", "w5", "s5", "2027-01-02T02:05:00.000Z", 10_000, 85_000);
    expect(oracleB2(db, NOW).findings).toHaveLength(0);
  });
});
