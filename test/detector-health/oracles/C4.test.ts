import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC4 } from "./C4.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, exit_class TEXT,
      tool_error_class TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, file_path_hash TEXT, owner_message_id TEXT,
      block_index INTEGER);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      agent_id TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  for (const s of ["s1", "s2", "s3", "s4"])
    db.prepare("INSERT INTO sessions VALUES (?, 'RECONCILED')").run(s);
  return db;
}
const turn = (
  db: Database.Database,
  id: string,
  sess: string,
  ts: string,
  input: number,
  side = 0,
  agent: string | null = null,
) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, is_sidechain, agent_id, input_tokens, pricing_snapshot_id) VALUES (?,?,'w1',?,?,?,?,'p')",
    )
    .run(id, sess, ts, side, agent, input);
const edit = (
  db: Database.Database,
  ev: string,
  sess: string,
  ts: string,
  owner: string,
  bi: number,
  exit: string,
  cls: string | null = null,
) => {
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,'Edit',?,?)").run(ev, sess, ts, exit, cls);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,'F',?,?)").run(ev, owner, bi);
};

describe("oracleC4", () => {
  it("prices the recovery turn once for a run of 3 errored Edits", () => {
    const db = mkdb();
    turn(db, "m1", "s1", "2027-01-02T00:00:00.000Z", 1000);
    turn(db, "m2", "s1", "2027-01-02T00:01:00.000Z", 1_000_000); // recovery: 1M x $5/MTok = 5,000,000 u
    edit(db, "e1", "s1", "2027-01-02T00:00:00.000Z", "m1", 0, "ERROR");
    edit(db, "e2", "s1", "2027-01-02T00:00:00.000Z", "m1", 1, "ERROR");
    edit(db, "e3", "s1", "2027-01-02T00:00:00.000Z", "m1", 2, "ERROR");
    const r = oracleC4(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("C4|w1|s1");
    expect(r.findings[0]?.count).toBe(3);
    expect(r.findings[0]?.modeled_u).toBeCloseTo(5_000_000, 3);
  });

  it("near miss: 2 errored Edits is below the threshold", () => {
    const db = mkdb();
    turn(db, "m1", "s1", "2027-01-02T00:00:00.000Z", 1000);
    turn(db, "m2", "s1", "2027-01-02T00:01:00.000Z", 1000);
    edit(db, "e1", "s1", "2027-01-02T00:00:00.000Z", "m1", 0, "ERROR");
    edit(db, "e2", "s1", "2027-01-02T00:00:00.000Z", "m1", 1, "ERROR");
    expect(oracleC4(db, NOW).findings).toHaveLength(0);
  });

  it("a non-error Edit breaks the run; NOT_READ Edits neither join nor break", () => {
    const db = mkdb();
    turn(db, "m1", "s1", "2027-01-02T00:00:00.000Z", 1000);
    turn(db, "m2", "s1", "2027-01-02T00:01:00.000Z", 1000);
    edit(db, "e1", "s1", "2027-01-02T00:00:00.000Z", "m1", 0, "ERROR");
    edit(db, "e2", "s1", "2027-01-02T00:00:00.000Z", "m1", 1, "ERROR");
    edit(db, "e3", "s1", "2027-01-02T00:00:00.000Z", "m1", 2, "OK");
    edit(db, "e4", "s1", "2027-01-02T00:00:00.000Z", "m1", 3, "ERROR");
    expect(oracleC4(db, NOW).findings).toHaveLength(0);

    const db2 = mkdb();
    turn(db2, "m1", "s1", "2027-01-02T00:00:00.000Z", 1000);
    turn(db2, "m2", "s1", "2027-01-02T00:01:00.000Z", 1000);
    edit(db2, "e1", "s1", "2027-01-02T00:00:00.000Z", "m1", 0, "ERROR");
    edit(db2, "e2", "s1", "2027-01-02T00:00:00.000Z", "m1", 1, "ERROR", "NOT_READ");
    edit(db2, "e3", "s1", "2027-01-02T00:00:00.000Z", "m1", 2, "ERROR");
    expect(oracleC4(db2, NOW).findings).toHaveLength(0); // only 2 real errors
  });

  it("consecutive turns t1,t2,t3 price recovery turns t2,t3,t4 once each; out-of-window recovery is dropped", () => {
    const db = mkdb();
    turn(db, "t1", "s1", "2027-01-02T00:00:00.000Z", 1_000_000);
    turn(db, "t2", "s1", "2027-01-02T00:01:00.000Z", 1_000_000);
    turn(db, "t3", "s1", "2027-01-02T00:02:00.000Z", 1_000_000);
    turn(db, "t4", "s1", "2027-01-02T00:03:00.000Z", 1_000_000);
    edit(db, "e1", "s1", "2027-01-02T00:00:00.000Z", "t1", 0, "ERROR");
    edit(db, "e2", "s1", "2027-01-02T00:01:00.000Z", "t2", 0, "ERROR");
    edit(db, "e3", "s1", "2027-01-02T00:02:00.000Z", "t3", 0, "ERROR");
    expect(oracleC4(db, NOW).findings[0]?.modeled_u).toBeCloseTo(15_000_000, 3); // t2 + t3 + t4

    // Issuing turn in window, recovery turn at/after NOW: not priced.
    const db2 = mkdb();
    turn(db2, "m1", "s2", "2027-01-07T23:59:00.000Z", 1000);
    turn(db2, "m2", "s2", "2027-01-08T00:00:00.000Z", 1_000_000);
    edit(db2, "e1", "s2", "2027-01-07T23:59:00.000Z", "m1", 0, "ERROR");
    edit(db2, "e2", "s2", "2027-01-07T23:59:00.000Z", "m1", 1, "ERROR");
    edit(db2, "e3", "s2", "2027-01-07T23:59:00.000Z", "m1", 2, "ERROR");
    expect(oracleC4(db2, NOW).findings[0]?.modeled_u).toBe(0);
  });

  it("subagent runs go to the subagent figure, not the headline", () => {
    const db = mkdb();
    turn(db, "a1", "s3", "2027-01-02T00:00:00.000Z", 1000, 1, "ag");
    turn(db, "a2", "s3", "2027-01-02T00:01:00.000Z", 1_000_000, 1, "ag");
    turn(db, "m9", "s3", "2027-01-02T00:02:00.000Z", 9_000_000); // main turn must not be used
    edit(db, "e1", "s3", "2027-01-02T00:00:00.000Z", "a1", 0, "ERROR");
    edit(db, "e2", "s3", "2027-01-02T00:00:00.000Z", "a1", 1, "ERROR");
    edit(db, "e3", "s3", "2027-01-02T00:00:00.000Z", "a1", 2, "ERROR");
    const f = oracleC4(db, NOW).findings[0];
    expect(f?.modeled_u).toBe(0);
    expect(f?.quantities.find((q) => q.name === "subagent_reliability_u")?.value).toBe(5_000_000);
  });
});
