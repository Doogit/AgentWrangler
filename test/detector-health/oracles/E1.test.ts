import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleE1 } from "./E1.js";

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
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER, provisional INTEGER DEFAULT 0);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, result_bytes INTEGER);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT, block_index INTEGER DEFAULT 0);
  `);
  // [in, out, cacheRead, cw5m, cw1h] $/MTok: only cache reads cost, 1 µ$ per token.
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[0,0,1,0,0]')").run();
  return db;
}

/** One workspace session: `pre` main turns of 100 µ$ each, then an Edit turn (100 µ$) with an Edit event. */
function addSession(db: Database.Database, ws: string, sid: string, pre: number, day = 3): void {
  db.prepare("INSERT INTO sessions VALUES (?,?,?,'RECONCILED')").run(sid, ws, `${sid}.jsonl`);
  const ins = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, pricing_snapshot_id) VALUES (?,?,?,?,100,'p')",
  );
  for (let i = 0; i < pre; i++)
    ins.run(`${sid}-t${i}`, sid, ws, `2027-01-0${day}T00:${String(i).padStart(2, "0")}:00.000Z`);
  const editTs = `2027-01-0${day}T01:00:00.000Z`;
  ins.run(`${sid}-edit`, sid, ws, editTs);
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,'Edit',10)").run(`${sid}-ev`, sid, editTs);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?,0)").run(`${sid}-ev`, `${sid}-edit`);
}

describe("oracleE1", () => {
  it("emits the positive workspace with hand-computed modeled_u and skips the 7-session near-miss", () => {
    const db = mkDb();
    // w1: 8 sessions, pre-edit counts [1,1,1,1,1,1,1,5] -> sorted p50 = 4th = 1, p75 = 6th = 1.
    // Long = only the 5-turn session; excess = its pre-edit turns after the first 1 = 4 turns x 100 = 400 µ$.
    // Workspace spend = 7 x (1 pre + 1 edit) + (5 pre + 1 edit) = 20 turns x 100 = 2000 µ$; 400/2000 = 20% >= 1%.
    // modeled = 400 x 0.5 = 200.
    for (let i = 1; i <= 7; i++) addSession(db, "w1", `a${i}`, 1);
    addSession(db, "w1", "a8", 5);
    // A provisional pre-edit turn and a sidechain pre-edit turn in a8 must not count as pre-edit main turns.
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, pricing_snapshot_id, provisional) VALUES ('a8-prov','a8','w1','2027-01-03T00:30:00.000Z',100,'p',1)",
    ).run();
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, is_sidechain, pricing_snapshot_id) VALUES ('a8-side','a8','w1','2027-01-03T00:31:00.000Z',1,'p')",
    ).run();
    // w2: 7 editing sessions only (below the 8-session minimum) even with a very long one.
    for (let i = 1; i <= 6; i++) addSession(db, "w2", `b${i}`, 1);
    addSession(db, "w2", "b7", 9);

    const r = oracleE1(db, NOW);
    expect(r.findings.map((f) => f.scope.key)).toEqual(["E1|w1"]);
    const [f] = r.findings;
    if (!f) throw new Error("no finding");
    expect(f.measured_u).toBeCloseTo(400, 6);
    expect(f.modeled_u).toBeCloseTo(200, 6);
    expect(f.count).toBe(4);
    expect(f.assumptions[0]).toMatchObject({ value: 0.5 });
  });

  it("does not count editing sessions whose first edit predates the window", () => {
    const db = mkDb();
    for (let i = 1; i <= 7; i++) addSession(db, "w1", `a${i}`, 1);
    addSession(db, "w1", "a8", 5, 3);
    // Replace a1's edit with one before the window: only 7 in-window first edits remain -> below 8.
    db.prepare(
      "UPDATE tool_events SET ts = '2026-12-20T00:00:00.000Z' WHERE event_id = 'a1-ev'",
    ).run();
    expect(oracleE1(db, NOW).findings).toEqual([]);
  });
});
