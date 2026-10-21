import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD7, oracleD7Loop, oracleD7Xread } from "./D7.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const D = "2027-01-02T";

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, input_hash TEXT,
      exit_class TEXT, result_bytes INTEGER, tool_error_class TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, file_path_hash TEXT, owner_message_id TEXT,
      block_index INTEGER);
    CREATE TABLE tool_event_content (event_id TEXT PRIMARY KEY, content_json TEXT);
    CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT, event_ts TEXT,
      boundary_kind TEXT, boundary_verification TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      agent_id TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0,
      cache_write_other INTEGER DEFAULT 0,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other),
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  return db;
}

let n = 0;
function session(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO sessions VALUES (?, 'w1', 'RECONCILED')").run(id);
}
function turn(
  db: Database.Database,
  id: string,
  sess: string,
  ts: string,
  o: { cost?: number; read?: number; w5?: number; w1?: number } = {},
): void {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, cache_write_5m, cache_write_1h,
       pricing_snapshot_id, cost_equiv_u) VALUES (?, ?, 'w1', ?, ?, ?, ?, 'p', ?)`,
  ).run(id, sess, ts, o.read ?? 0, o.w5 ?? 0, o.w1 ?? 0, o.cost ?? 1_000_000);
}
function ev(
  db: Database.Database,
  sess: string,
  owner: string,
  ts: string,
  tool: string,
  o: { hash?: string; exit?: string; bytes?: number; fp?: string | null } = {},
): void {
  const id = `e${n++}`;
  db.prepare("INSERT INTO tool_events VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
    id,
    sess,
    ts,
    tool,
    o.hash ?? "h",
    o.exit ?? "OK",
    o.bytes ?? 10,
  );
  db.prepare("INSERT INTO tool_event_metadata VALUES (?, ?, ?, 0)").run(id, o.fp ?? null, owner);
}

describe("oracleD7 loop lane", () => {
  function loop(db: Database.Database, messages: number, bytes = 10): void {
    session(db, "s1");
    for (let i = 0; i < messages; i++) {
      turn(db, `t${i}`, "s1", `${D}0${i}:00:00.000Z`);
      ev(db, "s1", `t${i}`, `${D}0${i}:00:01.000Z`, "Bash", { bytes });
    }
  }

  it("identical call over 3 messages: later messages' owner turns are excess, 0.5 x their stored cost", () => {
    const db = mkdb();
    loop(db, 3);
    const r = oracleD7Loop(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("D7|w1");
    expect(r.findings[0]?.modeled_u).toBe(1_000_000); // t1 + t2 = 2,000,000 x 0.5
  });

  it("near miss: 2 messages (MIN_RUN = 3) stay silent", () => {
    const db = mkdb();
    loop(db, 2);
    expect(oracleD7Loop(db, NOW).findings).toHaveLength(0);
  });

  it("results over 25,600 bytes are ineligible and break the run", () => {
    const db = mkdb();
    loop(db, 3, 25_601);
    expect(oracleD7Loop(db, NOW).findings).toHaveLength(0);
  });
});

describe("oracleD7 XREAD lane", () => {
  // Identity: one file, 2,700-byte result -> 1,000 raw tokens at 2.7 bytes/token.
  function xread(db: Database.Database, reads: number): void {
    session(db, "A");
    session(db, "B");
    // Total spend 4,000,000 keeps the card gate (6,750 carry cost >= 0.1%) satisfied.
    turn(db, "a0", "A", `${D}00:00:00.000Z`);
    turn(db, "b0", "B", `${D}01:00:00.000Z`);
    turn(db, "b1", "B", `${D}01:01:00.000Z`, { w5: 2000 });
    turn(db, "b2", "B", `${D}01:02:00.000Z`, { read: 5000 });
    for (let i = 0; i < reads - 4; i++)
      ev(db, "A", "a0", `${D}00:00:0${i}.000Z`, "Read", { fp: "f", bytes: 2700 });
    for (let i = 0; i < 4; i++)
      ev(db, "B", "b0", `${D}01:00:0${i}.000Z`, "Read", { fp: "f", bytes: 2700 });
  }

  it("10 reads over 2 sessions: B's first read is the one redundant re-read; per-claim ledger value", () => {
    const db = mkdb();
    xread(db, 10);
    const r = oracleD7Xread(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("D7-XREAD|w1");
    // write: round(1000 x 0.5) = 500 on b1's 5m cell x 6.25 = 3125; carry: b2 read round(1000 x 0.5) = 500 x 0.5 = 250.
    expect(r.findings[0]?.modeled_u).toBe(3375);
  });

  it("near miss: 9 reads (MIN_CROSS_SESSION_READS = 10) stay silent", () => {
    const db = mkdb();
    xread(db, 9);
    expect(oracleD7Xread(db, NOW).findings).toHaveLength(0);
  });

  it("a session that edited the file has its reads left out of the count", () => {
    const db = mkdb();
    xread(db, 10);
    ev(db, "A", "a0", `${D}00:30:00.000Z`, "Edit", { fp: "f" });
    expect(oracleD7Xread(db, NOW).findings).toHaveLength(0);
  });

  it("combined oracle carries both lanes under separate keys", () => {
    const db = mkdb();
    xread(db, 10);
    // The fixture's repeated same-region reads in session A also make a loop finding.
    const keys = oracleD7(db, NOW).findings.map((f) => f.scope.key);
    expect(keys).toEqual(["D7|w1", "D7-XREAD|w1"]);
  });
});
