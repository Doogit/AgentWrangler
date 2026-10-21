import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD6 } from "./D6.js";

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
  // [in, out, cacheRead, cw5m, cw1h] $/MTok = µ$/token: read 1, 5m write 2, 1h write 3.
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[0,0,1,2,3]')").run();
  return db;
}

/**
 * Session: owner t0 (00:00, 100 read), write turn t1 (00:01: cw5m 300 / cw1h 100), read turns t2..(later+0) (00:02..:
 * 2000 cache-read each), plus one tool result at 00:00:30 owned by t0. `later` counts turns after t0.
 */
function addSession(
  db: Database.Database,
  ws: string,
  sid: string,
  bytes: number,
  tool = "Read",
  later = 3,
  ownerRead = 100,
): void {
  db.prepare("INSERT INTO sessions VALUES (?,?,?,'RECONCILED')").run(sid, ws, `${sid}.jsonl`);
  const ins = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_5m, cache_write_1h, pricing_snapshot_id) VALUES (?,?,?,?,?,?,?,'p')",
  );
  ins.run(`${sid}-t0`, sid, ws, "2027-01-03T00:00:00.000Z", ownerRead, 0, 0);
  for (let i = 1; i <= later; i++)
    ins.run(
      `${sid}-t${i}`,
      sid,
      ws,
      `2027-01-03T00:0${i}:00.000Z`,
      i === 1 ? 0 : 2000,
      i === 1 ? 300 : 0,
      i === 1 ? 100 : 0,
    );
  db.prepare("INSERT INTO tool_events VALUES (?,?,'2027-01-03T00:00:30.000Z',?,?)").run(
    `${sid}-ev`,
    sid,
    tool,
    bytes,
  );
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?,0)").run(`${sid}-ev`, `${sid}-t0`);
}

// One 13590-byte result: excess 3350 B / 3.35 B/token -> raw 1000 tokens.
//  write turn t1: r5 = round(1000 x 300/400) = 750 -> capped at cw5m 300 -> round(300 x 0.5) = 150 tok x 2 = 300
//                 r1h = 250 -> capped at cw1h 100 -> 50 tok x 3 = 150
//  read turns t2, t3: raw 1000 (billed 2000) -> 500 tok x 1 = 500 each -> 1000
//  per session: 300 + 150 + 1000 = 1450.
const SESSION_VALUE = 1450;

describe("oracleD6 (net headline)", () => {
  it("prices the ledger's per-cell claims for a 3-session workspace and skips non-qualifying results", () => {
    const db = mkDb();
    for (const s of ["a", "b", "c"]) addSession(db, "w1", s, 13590);
    // Near misses in w2 (each a separate session, none contributes): exactly 10240 bytes (no excess),
    // 25601 bytes (A1's), TaskOutput 12000 bytes (A2's).
    addSession(db, "w2", "n1", 10240);
    addSession(db, "w2", "n2", 25601);
    addSession(db, "w2", "n3", 12000, "TaskOutput");

    const r = oracleD6(db, NOW);
    expect(r.findings.map((f) => f.scope.key)).toEqual(["D6|w1"]);
    expect(r.findings[0]?.modeled_u).toBe(3 * SESSION_VALUE);
    expect(r.findings[0]?.measured_u).toBe(3 * SESSION_VALUE);
    expect(r.findings[0]?.count).toBe(3);
    expect(r.findings[0]?.assumptions.map((a) => a.name)).toContain("no_competing_claims");
  });

  it("emits nothing when only 2 sessions carry a bloated result (recurrence gate)", () => {
    const db = mkDb();
    addSession(db, "w1", "a", 13590);
    addSession(db, "w1", "b", 13590);
    expect(oracleD6(db, NOW).findings).toEqual([]);
  });

  it("drops a result with no later turn, stops at a VERIFIED compact boundary only, and ends on a context collapse", () => {
    const db = mkDb();
    for (const s of ["a", "b"]) addSession(db, "w1", s, 13590);
    addSession(db, "w1", "c", 13590);
    const ev = db.prepare("INSERT INTO ingest_metric_events VALUES (?,?,?,'compact-boundary',?)");
    // c: verified boundary at 00:01:30 -> carry is t1 (write turn) only: 300 + 150 = 450.
    ev.run("m1", "c", "2027-01-03T00:01:30.000Z", "VERIFIED");
    // a: an UNVERIFIED boundary is ignored (full 1450).
    ev.run("m2", "a", "2027-01-03T00:01:30.000Z", "UNVERIFIED");
    // d: owner only, no later turn -> dropped. e: owner context 60000 then t1 context 400 < half -> collapse, dropped.
    addSession(db, "w1", "d", 13590, "Read", 0);
    addSession(db, "w1", "e", 13590, "Read", 3, 60000);

    const r = oracleD6(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.measured_u).toBe(2 * SESSION_VALUE + 450);
    expect(r.findings[0]?.count).toBe(3);
  });

  it("requires a D6 recommendations row for the workspace when that table exists", () => {
    const db = mkDb();
    db.exec(
      "CREATE TABLE recommendations (rec_id TEXT, detector_id TEXT, scope_workspace_id TEXT)",
    );
    for (const s of ["a", "b", "c"]) addSession(db, "w1", s, 13590);
    expect(oracleD6(db, NOW).findings).toEqual([]);
    db.prepare("INSERT INTO recommendations VALUES ('r1','D6','w1')").run();
    expect(oracleD6(db, NOW).findings.map((f) => f.scope.key)).toEqual(["D6|w1"]);
  });
});
