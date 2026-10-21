import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD4 } from "./D4.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, model_tier TEXT, unit_prices_json TEXT NOT NULL, captured_at TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, model TEXT, is_sidechain INTEGER DEFAULT 0,
      agent_id TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare(
    "INSERT INTO pricing_snapshots VALUES ('po','opus','[5, 25, 0.5, 6.25, 10]','2027-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO pricing_snapshots VALUES ('ps','sonnet-5','[2, 10, 0.2, 2.5, 4]','2027-01-01')",
  ).run();
  return db;
}
const add = (db: Database.Database, id: string, ws: string, n: number) =>
  db
    .prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id, input_tokens,
         output_tokens, cache_read_tokens, pricing_snapshot_id) VALUES (?,?,?,?,?,1,?,1000,100,60000,'po')`,
    )
    .run(id, `s-${ws}`, ws, `2027-01-02T00:0${n}:00.000Z`, "claude-opus-5", `agent-${ws}`);

describe("oracleD4", () => {
  it("emits the 5-turn lookup workspace and skips the 4-turn near miss", () => {
    const db = mkdb();
    for (let n = 0; n < 5; n++) add(db, `a${n}`, "w1", n);
    for (let n = 0; n < 4; n++) add(db, `b${n}`, "w2", n);
    const r = oracleD4(db, NOW);
    // per turn differential: input 1000*(5-2)=3000 + output 100*(25-10)=1500 + read 60000*(0.5-0.2)=18000 = 22,500.
    // w1: 5 turns -> measured 112,500; modeled x0.5 = 56,250. Spend = 5*(5000+2500+30000) = 187,500; 0.25% = 469 ok.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.workspace_id).toBe("w1");
    expect(r.findings[0]?.measured_u).toBeCloseTo(112_500, 3);
    expect(r.findings[0]?.modeled_u).toBeCloseTo(56_250, 3);
  });
});
