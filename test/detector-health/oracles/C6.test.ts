import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC6 } from "./C6.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, file_path_hash TEXT, owner_message_id TEXT,
      block_index INTEGER, edit_old_string_hash TEXT, edit_new_string_hash TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  return db;
}
const turn = (db: Database.Database, id: string, sess: string, ts: string, input: number) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, input_tokens, pricing_snapshot_id) VALUES (?,?,'w1',?,?,'p')",
    )
    .run(id, sess, ts, input);
const edit = (
  db: Database.Database,
  ev: string,
  sess: string,
  ts: string,
  owner: string,
  oh: string,
  nh: string,
) => {
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,'Edit')").run(ev, sess, ts);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,'F',?,0,?,?)").run(ev, owner, oh, nh);
};

describe("oracleC6", () => {
  it("emits the A->B then B->A session and skips A->B then B->C", () => {
    const db = mkdb();
    turn(db, "m1", "s1", "2027-01-02T00:00:00.000Z", 1000);
    turn(db, "m2", "s1", "2027-01-02T00:01:00.000Z", 1_000_000); // redo turn: 1M input x $5/MTok = $5 = 5,000,000 µ$
    edit(db, "e1", "s1", "2027-01-02T00:00:00.000Z", "m1", "A", "B");
    edit(db, "e2", "s1", "2027-01-02T00:01:00.000Z", "m2", "B", "A");
    turn(db, "m3", "s2", "2027-01-02T00:00:00.000Z", 1000);
    turn(db, "m4", "s2", "2027-01-02T00:01:00.000Z", 1000);
    edit(db, "e3", "s2", "2027-01-02T00:00:00.000Z", "m3", "A", "B");
    edit(db, "e4", "s2", "2027-01-02T00:01:00.000Z", "m4", "B", "C");

    const r = oracleC6(db, NOW);
    // Reliability figure = full redo-turn cost: 5,000,000 µ$ (the card's x0.5 is not applied). Count = 1.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("C6|s1");
    expect(r.findings[0]?.count).toBe(1);
    expect(r.findings[0]?.modeled_u).toBeCloseTo(5_000_000, 3);
  });
});
