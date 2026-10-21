import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleA2 } from "./A2.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, file_path TEXT, state TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED,
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER DEFAULT 0, provisional INTEGER DEFAULT 0,
      agent_id TEXT, is_compaction_boundary INTEGER DEFAULT 0);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, result_bytes INTEGER);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT, block_index INTEGER DEFAULT 0);
    CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT, event_ts TEXT,
      boundary_kind TEXT, boundary_verification TEXT);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[0,0,1,2,3]')").run(); // read 1, 5m write 2, 1h write 3 µ$/token
  return db;
}

/** Owner t0, write turn t1 (cw5m 100 / cw1h 300), read turn t2 (read 2000); spend 1,000,000 µ$ on t0. */
function addSession(
  db: Database.Database,
  ws: string,
  sid: string,
  bytes: number,
  spend = 1_000_000,
): void {
  db.prepare("INSERT INTO sessions VALUES (?,?,?,'RECONCILED')").run(sid, ws, `${sid}.jsonl`);
  const ins = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_5m, cache_write_1h, pricing_snapshot_id, cost_equiv_u) VALUES (?,?,?,?,?,?,?,'p',?)",
  );
  ins.run(`${sid}-t0`, sid, ws, "2027-01-03T00:00:00.000Z", 0, 0, 0, spend);
  ins.run(`${sid}-t1`, sid, ws, "2027-01-03T00:01:00.000Z", 0, 100, 300, 0);
  ins.run(`${sid}-t2`, sid, ws, "2027-01-03T00:02:00.000Z", 2000, 0, 0, 0);
  db.prepare("INSERT INTO tool_events VALUES (?,?,'2027-01-03T00:00:30.000Z','TaskOutput',?)").run(
    `${sid}-ev`,
    sid,
    bytes,
  );
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?,0)").run(`${sid}-ev`, `${sid}-t0`);
}

describe("oracleA2", () => {
  it("computes the net ledger headline by hand", () => {
    const db = mkDb();
    // 12940 bytes -> raw = round(2700 / 2.7) = 1000.
    // t1 write: split 250 / 750 raw, clamped to billed 100 / 300 -> x0.5 = 50 x 2 + 150 x 3 = 550.
    // t2 read: 1000 raw (billed 2000) x 0.5 = 500 x 1 = 500.  Headline = 1050.
    addSession(db, "w1", "a", 12940);
    const r = oracleA2(db, NOW);
    expect(r.findings.map((f) => f.scope.key)).toEqual(["A2|w1"]);
    const [f] = r.findings;
    if (!f) throw new Error("no finding");
    expect(f.quantities.find((q) => q.name === "claimed_tokens")?.value).toBe(700);
    expect(f.modeled_u).toBe(1050);
  });

  it("is silent at the byte threshold (10240), over A1's line (25601), and below the 0.1 percent spend gate", () => {
    const db = mkDb();
    addSession(db, "w1", "a", 10240);
    addSession(db, "w2", "b", 25601);
    addSession(db, "w3", "c", 12940, 100_000_000); // gate cost ~14k of 100M = 0.014 percent
    expect(oracleA2(db, NOW).findings).toEqual([]);
  });

  it("rounds per claim and drops the write when the write turn is provisional", () => {
    const db = mkDb();
    // 10243 bytes -> raw = round(3/2.7) = 1. t1 write r5 = round(0.25) = 0, r1h = 1 -> requested round(0.5) = 1 x 3.
    // t2 read: raw 1 -> round(0.5) = 1 x 1.  Headline = 3 + 1 = 4.
    addSession(db, "w1", "a", 10243);
    expect(oracleA2(db, NOW).findings[0]?.modeled_u).toBe(4);
    db.prepare("UPDATE turns SET provisional = 1 WHERE message_id = 'a-t1'").run();
    expect(oracleA2(db, NOW).findings[0]?.modeled_u).toBe(1); // no move of the write; only the read claim
  });

  it("stops the carry chain at a verified compact boundary", () => {
    const db = mkDb();
    addSession(db, "w1", "a", 12940);
    db.prepare(
      "INSERT INTO ingest_metric_events VALUES ('m1','a','2027-01-03T00:01:30.000Z','compact-boundary','VERIFIED')",
    ).run();
    expect(oracleA2(db, NOW).findings[0]?.modeled_u).toBe(550);
  });
});
