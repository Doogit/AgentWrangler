import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleB3 } from "./B3.js";

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
  db.prepare("INSERT INTO pricing_snapshots VALUES ('bad', '[5, 25]')").run();
  return db;
}
const add = (
  db: Database.Database,
  id: string,
  sess: string,
  ts: string,
  read: number,
  w1: number,
  wo = 0,
  snap = "p",
  ws = "w1",
) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_1h, cache_write_other, pricing_snapshot_id) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(id, sess, ws, ts, read, w1, wo, snap);

/** Z (older, small), P (previous, last turn context R), N (resume turn writing creation C, 60 min after P). */
function build(opts: {
  c: number;
  wo?: number;
  snap?: string;
  r?: number;
  reads?: number;
  gapMs?: number;
}) {
  const db = mkdb();
  const r = opts.r ?? opts.c;
  add(db, "z1", "Z", "2027-01-03T00:00:00.000Z", 0, 5000);
  add(db, "z2", "Z", "2027-01-03T01:00:00.000Z", 5000, 0);
  add(db, "p1", "P", "2027-01-05T00:00:00.000Z", 0, 5000);
  add(db, "p2", "P", "2027-01-05T01:00:00.000Z", r, 0);
  const nTs = new Date(
    Date.parse("2027-01-05T01:00:00.000Z") + (opts.gapMs ?? 3_600_000),
  ).toISOString();
  add(
    db,
    "n1",
    "N",
    nTs,
    opts.reads ?? 10_000,
    opts.c - (opts.wo ?? 0),
    opts.wo ?? 0,
    opts.snap ?? "p",
  );
  return db;
}

describe("oracleB3", () => {
  it("positive: per-event net headline from the 1h cell, base = median first-turn context", () => {
    const r = oracleB3(build({ c: 20_001 }), NOW);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    // base = median(5000, 5000, 30001) = 5000; avoidable 15001; claim round(15001/2)=7501 x (10 - 0.5) = 71259.5.
    expect(f?.quantities.find((q) => q.name === "avoidable_tokens")?.value).toBe(15_001);
    expect(f?.modeled_u).toBe(71_260);
    expect(f?.scope.key).toContain("B3|w1|P|N|n1");
    expect(f?.assumptions.map((a) => a.name)).toContain("B3_NO_COMPETING_CLAIMS");
  });

  it("drops cache_write_other from the claim cells", () => {
    const r = oracleB3(build({ c: 20_001, wo: 10_001 }), NOW);
    // avoidable 15001; raw1h = round(15001 x 10000 / 20001) = 7500; claim 3750 x 9.5 = 35625.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.modeled_u).toBe(35_625);
  });

  it("an event on an unusable snapshot is a real $0", () => {
    const r = oracleB3(build({ c: 20_001, snap: "bad" }), NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.modeled_u).toBe(0);
  });

  it("near-miss: creation exactly 20000 is silent (strict >)", () => {
    expect(oracleB3(build({ c: 20_000 }), NOW).findings).toHaveLength(0);
  });

  it("near-miss: ratio just below 0.8 is silent", () => {
    expect(oracleB3(build({ c: 20_001, r: 25_002 }), NOW).findings).toHaveLength(0);
  });

  it("near-miss: ratio just above 1.25 is silent", () => {
    expect(oracleB3(build({ c: 20_001, r: 16_000 }), NOW).findings).toHaveLength(0);
  });

  it("near-miss: reads one above half of previous reads is silent", () => {
    expect(oracleB3(build({ c: 20_001, reads: 10_001 }), NOW).findings).toHaveLength(0);
  });

  it("near-miss: gap 1 ms past the 60 min TTL is silent", () => {
    expect(oracleB3(build({ c: 20_001, gapMs: 3_600_001 }), NOW).findings).toHaveLength(0);
  });
});
