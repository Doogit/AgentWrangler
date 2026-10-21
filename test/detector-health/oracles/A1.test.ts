import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleA1 } from "./A1.js";

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
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER, provisional INTEGER DEFAULT 0,
      agent_id TEXT, is_compaction_boundary INTEGER DEFAULT 0);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, result_bytes INTEGER);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT, block_index INTEGER DEFAULT 0);
    CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT, event_ts TEXT,
      boundary_kind TEXT, boundary_verification TEXT);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[0,0,1,2,3]')").run(); // read 1, 5m write 2, 1h write 3 µ$/token
  return db;
}

/** Session with an owner turn t0 (00:00), a write turn t1 (00:01: cw5m 100 / cw1h 300) and a read turn t2 (00:02: read 2000). */
function addSession(db: Database.Database, ws: string, sid: string, bytes: number): void {
  db.prepare("INSERT INTO sessions VALUES (?,?,?,'RECONCILED')").run(sid, ws, `${sid}.jsonl`);
  const ins = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_5m, cache_write_1h, pricing_snapshot_id) VALUES (?,?,?,?,?,?,?,'p')",
  );
  ins.run(`${sid}-t0`, sid, ws, "2027-01-03T00:00:00.000Z", 0, 0, 0);
  ins.run(`${sid}-t1`, sid, ws, "2027-01-03T00:01:00.000Z", 0, 100, 300);
  ins.run(`${sid}-t2`, sid, ws, "2027-01-03T00:02:00.000Z", 2000, 0, 0);
  db.prepare("INSERT INTO tool_events VALUES (?,?,'2027-01-03T00:00:30.000Z','Read',?)").run(
    `${sid}-ev`,
    sid,
    bytes,
  );
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?,0)").run(`${sid}-ev`, `${sid}-t0`);
}

describe("oracleA1", () => {
  it("computes the net ledger headline by hand and ignores results at or below the threshold", () => {
    const db = mkDb();
    // w1: 28300 bytes -> raw = round(2700 / 2.7) = 1000 tokens.
    //  t1 write: split 1000 x 100/400 = 250 (5m), 750 (1h); capped at billed 100 / 300 -> 100 / 300;
    //    x 0.5 -> 50 x 2 + 150 x 3 = 100 + 450 = 550.
    //  t2 read: 1000 raw (billed 2000) x 0.5 = 500 x 1 = 500.   Headline = 1050.
    addSession(db, "w1", "a", 28300);
    // w2 near miss: exactly 25600 bytes is not strictly larger.
    addSession(db, "w2", "b", 25600);
    const r = oracleA1(db, NOW);
    expect(r.findings.map((f) => f.scope.key)).toEqual(["A1|w1"]);
    const [f] = r.findings;
    if (!f) throw new Error("no finding");
    expect(f.count).toBe(1);
    expect(f.quantities.find((q) => q.name === "total_bytes")?.value).toBe(28300);
    expect(f.quantities.find((q) => q.name === "claimed_tokens")?.value).toBe(50 + 150 + 500);
    expect(f.modeled_u).toBe(1050);
  });

  it("fires with a $0 headline when the result is 1 byte over (rounds to 0 tokens), and drops out-of-window results", () => {
    const db = mkDb();
    addSession(db, "w1", "a", 25601);
    addSession(db, "w2", "b", 30000);
    db.prepare(
      "UPDATE tool_events SET ts = '2026-12-30T00:00:00.000Z' WHERE session_id = 'b'",
    ).run();
    const r = oracleA1(db, NOW);
    expect(r.findings.map((f) => f.scope.key)).toEqual(["A1|w1"]);
    expect(r.findings[0]?.modeled_u).toBe(0);
  });

  it("stops the carry chain at a verified compact boundary", () => {
    const db = mkDb();
    addSession(db, "w1", "a", 28300);
    db.prepare(
      "INSERT INTO ingest_metric_events VALUES ('m1','a','2027-01-03T00:01:30.000Z','compact-boundary','VERIFIED')",
    ).run();
    // Boundary falls before t2, so only the t1 write claim survives: 100 + 450 = 550.
    expect(oracleA1(db, NOW).findings[0]?.modeled_u).toBe(550);
  });
});
