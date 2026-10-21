import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD8 } from "./D8.js";

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
const addTurn = (
  db: Database.Database,
  id: string,
  ws: string,
  sess: string,
  ts: string,
  w1: number,
  w5 = 0,
) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_write_1h, cache_write_5m, pricing_snapshot_id) VALUES (?,?,?,?,?,?,'p')",
    )
    .run(id, sess, ws, ts, w1, w5);

describe("oracleD8", () => {
  it("emits the 3-event workspace with the hand-computed figure and skips the 2-event near miss", () => {
    const db = mkdb();
    // w1/s1: first turn ctx 10000 (1h tier, base prefix), then three 100000-token 1h rewrites after 2h gaps.
    addTurn(db, "a0", "w1", "s1", "2027-01-02T00:00:00.000Z", 10_000);
    addTurn(db, "a1", "w1", "s1", "2027-01-02T02:00:00.000Z", 100_000);
    addTurn(db, "a2", "w1", "s1", "2027-01-02T04:00:00.000Z", 100_000);
    addTurn(db, "a3", "w1", "s1", "2027-01-02T06:00:00.000Z", 100_000);
    // w2/s2: only two events (third gap 30 min <= 60 min TTL).
    addTurn(db, "b0", "w2", "s2", "2027-01-03T00:00:00.000Z", 10_000);
    addTurn(db, "b1", "w2", "s2", "2027-01-03T02:00:00.000Z", 100_000);
    addTurn(db, "b2", "w2", "s2", "2027-01-03T04:00:00.000Z", 100_000);
    addTurn(db, "b3", "w2", "s2", "2027-01-03T04:30:00.000Z", 100_000);
    // Subagent turn with 20M cache reads: cap-weighted 2M, so 2 events' 200k creation is 9% < 15% (no share trigger).
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, is_sidechain, cache_read_tokens, pricing_snapshot_id) VALUES ('b4','s2','w2','2027-01-03T05:00:00.000Z',1,20000000,'p')",
    ).run();

    const r = oracleD8(db, NOW);
    // w1: rate = 10 - 0.5 = 9.5 µ$/token. Event cost 100000*9.5 = 950000 (floor 0.1% of spend 3,100,000 = 3100: ok).
    // base = 10000 (median first-turn ctx of in-window sessions, w1 only) -> net 90000 -> 855000 per event.
    // Net headline: all-1h events, raw1h = 90000, tokens = round(90000*0.64) = 57600 (<= billed 100000),
    // value = 57600 * (10 - 0.5) = 547,200 per event; headline = 3*547,200 = 1,641,600.
    // Gross gate: 3*855000*0.64 = 1,641,600 >= 1% of spend (31,000).
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.scope.workspace_id).toBe("w1");
    expect(f?.measured_u).toBe(1_641_600);
    expect(f?.modeled_u).toBe(1_641_600);
    expect(f?.quantities.find((q) => q.name === "churn_events")?.value).toBe(3);
  });

  it("splits net across 5m/1h cells with each tier's own price (positive)", () => {
    const db = mkdb();
    addTurn(db, "c0", "w3", "s3", "2027-01-02T00:00:00.000Z", 10_000);
    for (const [i, h] of [2, 4, 6].entries())
      addTurn(db, `c${i + 1}`, "w3", "s3", `2027-01-02T0${h}:00:00.000Z`, 40_000, 60_000);
    // base 10000, creation 100000, net 90000; raw5 = 54000, raw1 = 36000; tokens 34560 / 23040.
    // value = 34560*(6.25-0.5) + 23040*(10-0.5) = 198,720 + 218,880 = 417,600 per event; x3 = 1,252,800.
    const r = oracleD8(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.measured_u).toBe(1_252_800);
  });

  it("emits nothing when events are no larger than the base prompt (net 0, near miss)", () => {
    const db = mkdb();
    addTurn(db, "d0", "w4", "s4", "2027-01-02T00:00:00.000Z", 100_000);
    for (const [i, h] of [2, 4, 6].entries())
      addTurn(db, `d${i + 1}`, "w4", "s4", `2027-01-02T0${h}:00:00.000Z`, 100_000);
    expect(oracleD8(db, NOW).findings).toHaveLength(0);
  });
});
