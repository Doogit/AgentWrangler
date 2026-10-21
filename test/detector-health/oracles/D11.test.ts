import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD11 } from "./D11.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const ERR = "Exit code 127\nbash: nosuchcmd: command not found";

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT,
      input_hash TEXT, result_bytes INTEGER, exit_class TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT, block_index INTEGER);
    CREATE TABLE tool_event_content (event_id TEXT PRIMARY KEY, content_json TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','w1','RECONCILED')").run();
  return db;
}

/** One turn per call (seconds apart, base 2027-01-02), each owning one shell call; recovery = the next turn. */
function build(bashCalls: number, bashErrors: number, psCalls: number, psErrors: number) {
  const db = mkdb();
  let n = 0;
  const add = (tool: string, isErr: boolean) => {
    n++;
    const ts = new Date(Date.UTC(2027, 0, 2, 0, 0, n * 10)).toISOString();
    const id = `m${n}`;
    // Every turn costs 1,000,000 input tokens x $5/MTok = 5,000,000 µ$.
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, input_tokens, pricing_snapshot_id) VALUES (?, 's1','w1',?,1000000,'p')",
    ).run(id, ts);
    db.prepare("INSERT INTO tool_events VALUES (?, 's1', ?, ?, NULL, NULL, ?)").run(
      `e${n}`,
      ts,
      tool,
      isErr ? "ERROR" : "OK",
    );
    db.prepare("INSERT INTO tool_event_metadata VALUES (?,?,0)").run(`e${n}`, id);
    db.prepare("INSERT INTO tool_event_content VALUES (?,?)").run(
      `e${n}`,
      JSON.stringify(isErr ? { command: `bad ${n}`, error: ERR } : { command: `ok ${n}` }),
    );
  };
  for (let i = 0; i < bashCalls; i++) add("Bash", i % 7 === 0 && i / 7 < bashErrors);
  for (let i = 0; i < psCalls; i++) add("PowerShell", i % 7 === 0 && i / 7 < psErrors);
  add("Bash", false); // trailing turn so the last error still has a recovery turn
  return db;
}

describe("oracleD11", () => {
  it("positive: Bash 66/3 vs PS 50/1 fires; headline = 3 recovery turns x 5,000,000 µ$", () => {
    const r = oracleD11(build(66, 3, 50, 1), NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("D11|tool-error-rate|w1");
    expect(r.findings[0]?.modeled_u).toBe(15_000_000);
  });

  it("near-miss ratio: Bash 101/3 vs PS 50/1 (ratio 1.485 < 1.5) is silent", () => {
    expect(oracleD11(build(101, 3, 50, 1), NOW).findings).toHaveLength(0);
  });

  it("near-miss calls: PS 49 calls is silent", () => {
    expect(oracleD11(build(66, 3, 49, 1), NOW).findings).toHaveLength(0);
  });

  it("near-miss errors: worse shell with 2 errors is silent", () => {
    expect(oracleD11(build(66, 2, 50, 1), NOW).findings).toHaveLength(0);
  });
});
