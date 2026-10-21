import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleE2 } from "./E2.js";

const NOW = new Date("2026-10-14T00:00:00.000Z"); // window [2026-10-07T00:00Z, 2026-10-14T00:00Z)

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT);
    CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, model TEXT,
      is_sidechain INTEGER DEFAULT 0, provisional INTEGER DEFAULT 0, output_tokens INTEGER, context_tokens INTEGER,
      cost_equiv_u INTEGER);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, tool_name TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT);
    CREATE TABLE pricing_snapshots (snapshot_id TEXT, model_tier TEXT, unit_prices_json TEXT, captured_at TEXT);
    INSERT INTO pricing_snapshots VALUES ('p','sonnet-5','[2,10,0.2,2.5,4]','2026-09-01T00:00:00.000Z');
  `);
  for (const [s, w, st] of [
    ["sA", "wsA", "RECONCILED"],
    ["sB", "wsB", "RECONCILED"],
    ["sC", "wsC", "RECONCILED"],
    ["sD", "wsD", "LIVE"],
  ])
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(s, w, st);
  return db;
}
let n = 0;
function turn(
  db: Database.Database,
  s: string,
  i: number,
  model: string,
  tool: string | null,
  out = 10,
  cost = 1_000_000,
): void {
  const id = `m${n++}`;
  db.prepare(`INSERT INTO turns (message_id,session_id,workspace_id,ts,model,output_tokens,context_tokens,cost_equiv_u)
    VALUES (?,?,?,?,?,?,100000,?)`).run(
    id,
    s,
    `ws${s[1]}`,
    `2026-10-10T00:0${i}:00.000Z`,
    model,
    out,
    cost,
  );
  if (tool) {
    db.prepare("INSERT INTO tool_events VALUES (?,?)").run(`t${id}`, tool);
    db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(`t${id}`, id);
  }
}

describe("oracleE2", () => {
  it("counts one qualifying run (text-only turn does not break it) and ignores near-misses", () => {
    const db = seed();
    // ws A: Bash, text-only, Bash, Bash -> one run of 3. Run cost 3,000,000.
    // Subagent: 30000*2.5 + 3*(30000*0.2 + 0 growth + 10*10) + handoff 1,000,000 = 1,093,300; net 1,906,700 >= 1% of 3,000,000.
    turn(db, "sA", 0, "claude-opus-5-5", "Bash");
    turn(db, "sA", 1, "claude-opus-5-5", null, 10, 0);
    turn(db, "sA", 2, "claude-opus-5-5", "Bash");
    turn(db, "sA", 3, "claude-opus-5-5", "Bash");
    // ws B: Bash, Bash, Read with output 300 (not < 300), Bash -> run of 2 then 1: no run.
    turn(db, "sB", 0, "claude-opus-5-5", "Bash");
    turn(db, "sB", 1, "claude-opus-5-5", "Bash");
    turn(db, "sB", 2, "claude-opus-5-5", "Read", 300);
    turn(db, "sB", 3, "claude-opus-5-5", "Bash");
    // ws C: a weak-model turn in the middle ends the run; an Edit turn is not mechanical.
    turn(db, "sC", 0, "claude-opus-5-5", "Bash");
    turn(db, "sC", 1, "claude-sonnet-5", "Bash");
    turn(db, "sC", 2, "claude-opus-5-5", "Bash");
    turn(db, "sC", 3, "claude-opus-5-5", "Edit");
    // ws D: a valid run but the session is not reconciled.
    for (let i = 0; i < 3; i++) turn(db, "sD", i, "claude-opus-5-5", "Bash");

    const r = oracleE2(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.workspace_id).toBe("wsA");
    expect(r.findings[0]?.count).toBe(1);
    expect(r.findings[0]?.measured_u).toBe(1_906_700);
  });
});
