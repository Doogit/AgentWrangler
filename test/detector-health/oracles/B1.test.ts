import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleB1 } from "./B1.js";

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
  w1 = 0,
  wo = 0,
  snap = "p",
) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(id, sess, ws, ts, read, w5, w1, wo, snap);

describe("oracleB1", () => {
  it("emits a within-TTL collapse and skips the after-TTL near miss", () => {
    const db = mkdb();
    // w1: prev ctx 100000 (all reads); cur reads 10000 + 80000 5m creation = ctx 90000 (= 0.9 x prev, ok), gap 3 min <= 5m TTL.
    add(db, "p1", "w1", "s1", "2027-01-02T00:00:00.000Z", 100_000, 0);
    add(db, "c1", "w1", "s1", "2027-01-02T00:03:00.000Z", 10_000, 80_000);
    // w2: identical shape but gap 10 min > 5 min TTL -> B2's, not B1's.
    add(db, "p2", "w2", "s2", "2027-01-02T00:00:00.000Z", 100_000, 0);
    add(db, "c2", "w2", "s2", "2027-01-02T00:10:00.000Z", 10_000, 80_000);

    const r = oracleB1(db, NOW);
    // w1: rate = 6.25 - 0.5 = 5.75 -> 80000 * 5.75 = 460,000; spend = 100000*0.5 + (80000*6.25 + 10000*0.5) = 555,000
    // (floor 555 ok). Net headline = round(0.5 * 80000) * 5.75 = 230,000.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.workspace_id).toBe("w1");
    expect(r.findings[0]?.measured_u).toBeCloseTo(460_000, 3);
    expect(r.findings[0]?.modeled_u).toBeCloseTo(230_000, 3);
    expect(r.findings[0]?.assumptions.map((a) => a.name)).toContain("B1_NO_COMPETING_CLAIMS");
  });

  it("net headline: prices 1h cell at its own tier, drops cache_write_other", () => {
    const db = mkdb();
    // prev ctx 100000; cur reads 10000 + 1h 50000 + other 30000 = ctx 90000, creation 80000 >= 50000; 1h tier -> TTL 60m.
    add(db, "p3", "w3", "s3", "2027-01-02T00:00:00.000Z", 100_000, 0);
    add(db, "c3", "w3", "s3", "2027-01-02T00:03:00.000Z", 10_000, 0, 50_000, 30_000);
    const r = oracleB1(db, NOW);
    // 1h cell: round(0.5 * 50000) = 25000 * (10 - 0.5) = 237,500; the 30000 other-tier write earns nothing.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.modeled_u).toBeCloseTo(237_500, 3);
  });

  it("net headline: a collapse with no usable snapshot is a real $0, not null", () => {
    const db = mkdb();
    db.prepare("INSERT INTO pricing_snapshots VALUES ('bad', '[5, 25]')").run();
    add(db, "p4", "w4", "s4", "2027-01-02T00:00:00.000Z", 100_000, 0, 0, 0, "bad");
    add(db, "c4", "w4", "s4", "2027-01-02T00:03:00.000Z", 10_000, 80_000, 0, 0, "bad");
    const r = oracleB1(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.modeled_u).toBe(0);
  });
});
