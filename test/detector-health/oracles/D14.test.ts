import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD14 } from "./D14.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT,
      interrupt_kind TEXT, interrupt_classifier_version TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT);
    CREATE TABLE tool_event_content (event_id TEXT PRIMARY KEY, content_json TEXT);
    CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT, user_turn_ts TEXT,
      is_user_turn INTEGER, is_compact_summary INTEGER DEFAULT 0, is_interrupt INTEGER DEFAULT 0);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','w1','RECONCILED')").run();
  return db;
}
const turn = (db: Database.Database, id: string, ts: string, input: number, other = 0) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, input_tokens, cache_write_other, pricing_snapshot_id) VALUES (?,'s1','w1',?,?,?,'p')",
    )
    .run(id, ts, input, other);
const ev = (
  db: Database.Database,
  id: string,
  ts: string,
  owner: string,
  kind: string,
  error?: string,
) => {
  db.prepare("INSERT INTO tool_events VALUES (?,'s1',?,'Bash',?,'interrupt-1')").run(id, ts, kind);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(id, owner);
  if (error)
    db.prepare("INSERT INTO tool_event_content VALUES (?,?)").run(id, JSON.stringify({ error }));
};
const prompt = (db: Database.Database, id: string, ts: string) =>
  db
    .prepare(
      "INSERT INTO ingest_metric_events (event_id, session_id, user_turn_ts, is_user_turn) VALUES (?,'s1',?,1)",
    )
    .run(id, ts);

const T = (min: number) => `2027-01-02T00:${String(min).padStart(2, "0")}:00.000Z`;

describe("oracleD14", () => {
  it("prices the recovery turn in full (not the owner turn, no 0.5, cache_write_other unclaimed) and counts both kinds", () => {
    const db = mkdb();
    turn(db, "m1", T(0), 1000);
    turn(db, "m2", T(1), 1_000_000, 5_000_000); // recovery: 1M input x $5 = 5,000,000 µ$; "other" bucket adds 0
    ev(db, "e1", T(0), "m1", "PURE_INTERRUPT");
    ev(db, "e2", T(0), "m1", "KILLED_NO_PROMPT");
    const r = oracleD14(db, NOW);
    expect(r.findings.map((f) => f.scope.key).sort()).toEqual([
      "D14|w1|s1|KILLED_NO_PROMPT",
      "D14|w1|s1|PURE_INTERRUPT",
    ]);
    // Tie on one event each: recovery turn goes to the lowest rec key (KILLED_NO_PROMPT); the other card is a real 0.
    const k = r.findings.find((f) => f.scope.key.endsWith("KILLED_NO_PROMPT"));
    const p = r.findings.find((f) => f.scope.key.endsWith("PURE_INTERRUPT"));
    expect(k?.modeled_u).toBeCloseTo(5_000_000, 3);
    expect(p?.modeled_u).toBe(0);
    expect(k?.count).toBe(1);
  });

  it("near-miss: prompt after exactly 2 later main turns is a good interrupt (silent); after 3 it fires", () => {
    for (const [later, fires] of [
      [2, false],
      [3, true],
    ] as const) {
      const db = mkdb();
      turn(db, "m1", T(0), 1000);
      for (let i = 1; i <= later; i++) turn(db, `r${i}`, T(i), 1000);
      ev(db, "e1", T(0), "m1", "PURE_INTERRUPT");
      prompt(db, "u1", T(later + 1));
      expect(oracleD14(db, NOW).findings.length > 0).toBe(fires);
    }
  });

  it("drops session-end cutoffs and non-RECONCILED sessions", () => {
    const db = mkdb();
    turn(db, "m1", T(0), 1000);
    turn(db, "m2", T(1), 1000);
    ev(
      db,
      "e1",
      T(0),
      "m1",
      "PURE_INTERRUPT",
      "[Tool call interrupted: the session ended while running]",
    );
    expect(oracleD14(db, NOW).findings).toHaveLength(0);
    const db2 = mkdb();
    db2.prepare("UPDATE sessions SET state='LIVE'").run();
    turn(db2, "m1", T(0), 1000);
    ev(db2, "e1", T(0), "m1", "PURE_INTERRUPT");
    expect(oracleD14(db2, NOW).findings).toHaveLength(0);
  });

  it("no recovery turn: the card exists with a real $0", () => {
    const db = mkdb();
    turn(db, "m1", T(0), 1000);
    ev(db, "e1", T(0), "m1", "PURE_INTERRUPT");
    const f = oracleD14(db, NOW).findings;
    expect(f).toHaveLength(1);
    expect(f[0]?.modeled_u).toBe(0);
  });
});
