import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD9 } from "./D9.js";

const NOW = new Date("2026-10-14T00:00:00.000Z"); // window [2026-10-07T00:00Z, 2026-10-14T00:00Z)

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, last_turn_at TEXT);
    CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT,
      provisional INTEGER DEFAULT 0, agent_id TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0,
      cache_write_other INTEGER DEFAULT 0, cost_equiv_u INTEGER, pricing_snapshot_id TEXT);
    CREATE TABLE subagent_meta (agent_id TEXT PRIMARY KEY, session_id TEXT, agent_type TEXT);
    CREATE TABLE pricing_snapshots (snapshot_id TEXT, unit_prices_json TEXT);
    INSERT INTO pricing_snapshots VALUES ('p','[3,15,0.5,3.75,6]');
  `);
  return db;
}
let n = 0;
function session(db: Database.Database, s: string, ws: string, last: string): void {
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(s, ws, last);
}
function turn(
  db: Database.Database,
  s: string,
  ws: string,
  ts: string,
  agent: string | null,
  input: number,
  read: number,
  snap: string | null = "p",
): void {
  db.prepare(
    `INSERT INTO turns (message_id,session_id,workspace_id,ts,agent_id,input_tokens,cache_read_tokens,pricing_snapshot_id)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(`m${n++}`, s, ws, ts, agent, input, read, snap);
}
function fork(db: Database.Database, id: string, s: string, type = "fork"): void {
  db.prepare("INSERT INTO subagent_meta VALUES (?,?,?)").run(id, s, type);
}
const IN = "2026-10-10T00:00:00.000Z";

/** Parent spend 399,000 µ$ (133,000 input x 3). Fork estimate E = read x 0.5. Pct = E / (399,000 + E). */
function ws(db: Database.Database, w: string, read: number, type = "fork"): void {
  session(db, `s${w}`, w, IN);
  turn(db, `s${w}`, w, IN, null, 133_000, 0);
  fork(db, `a${w}`, `s${w}`, type);
  turn(db, `s${w}`, w, IN, `a${w}`, 0, read);
}

describe("oracleD9", () => {
  it("fires at exactly 0.25% of spend and stays silent just below", () => {
    const db = seed();
    ws(db, "wsAt", 2000); // E = 1000 -> 1000 / 400,000 = 0.25% -> fires
    ws(db, "wsBelow", 1999); // E = 999.5 -> 0.249875% -> silent
    const r = oracleD9(db, NOW);
    expect(r.findings.map((f) => f.scope.workspace_id)).toEqual(["wsAt"]);
    expect(r.findings[0]?.count).toBe(1);
    expect(r.findings[0]?.measured_u).toBe(1000);
  });

  it("ignores non-fork types, out-of-window forks and counts unmeasured / no-turn forks ungated", () => {
    const db = seed();
    ws(db, "wsType", 2000, "general-purpose"); // not a fork
    // Fork whose only turn is before the window.
    session(db, "sOld", "wsOld", IN);
    fork(db, "aOld", "sOld");
    turn(db, "sOld", "wsOld", "2026-09-01T00:00:00.000Z", "aOld", 0, 5000);
    // Fork with a priced turn but zero cache reads: not measured, fires with no $.
    session(db, "sZero", "wsZero", IN);
    turn(db, "sZero", "wsZero", IN, null, 133_000, 0);
    fork(db, "aZero", "sZero");
    turn(db, "sZero", "wsZero", IN, "aZero", 10, 0);
    // Fork with no ingested turns: falls back to the parent's last turn time.
    session(db, "sNoTurn", "wsNoTurn", IN);
    fork(db, "aNoTurn", "sNoTurn");
    session(db, "sNoTurnOld", "wsNoTurnOld", "2026-09-01T00:00:00.000Z");
    fork(db, "aNoTurnOld", "sNoTurnOld");
    const r = oracleD9(db, NOW);
    expect(r.findings.map((f) => f.scope.workspace_id)).toEqual(["wsNoTurn", "wsZero"]);
    expect(r.findings.every((f) => f.count === 1 && f.measured_u === null)).toBe(true);
  });
});
