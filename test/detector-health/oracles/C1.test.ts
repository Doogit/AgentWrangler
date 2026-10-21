import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC1 } from "./C1.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, exit_class TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT);
    CREATE TABLE tool_event_content (event_id TEXT PRIMARY KEY, content_json TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1', 'RECONCILED')").run();
  return db;
}

let seq = 0;
/** One turn per call, 1 minute apart; the turn's tool event has the given class and error. */
function call(
  db: Database.Database,
  tool: string,
  xc: string,
  error: string | null,
  input = 1000,
): void {
  seq++;
  const ts = new Date(Date.parse("2027-01-02T00:00:00.000Z") + seq * 60_000).toISOString();
  const m = `m${seq}`;
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, input_tokens, pricing_snapshot_id) VALUES (?,?,?,?,?,'p')",
  ).run(m, "s1", "w1", ts, input);
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,?,?)").run(`e${seq}`, "s1", ts, tool, xc);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(`e${seq}`, m);
  if (error !== null)
    db.prepare("INSERT INTO tool_event_content VALUES (?,?)").run(
      `e${seq}`,
      JSON.stringify({ error }),
    );
}

/** 200 OK Read calls (the corpus), then `calls` calls of tool X of which `errs` fail. */
function build(calls: number, errs: number): Database.Database {
  seq = 0;
  const db = mkdb();
  for (let i = 0; i < 200; i++) call(db, "Read", "OK", null);
  for (let i = 0; i < calls; i++) {
    if (i < errs)
      call(db, "Grep", "ERROR", "Error: boom", 1_000_000); // recovery turn = next turn, 1M input = 5,000,000 µ$
    else call(db, "Grep", "OK", null, 1_000_000);
  }
  return db;
}

describe("oracleC1", () => {
  it("fires on 3 errors in 20 calls and prices the recovery turns in full", () => {
    const r = oracleC1(build(20, 3), NOW);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.scope.key).toBe("C1|Grep");
    expect(f?.quantities.find((q) => q.name === "tool_errors")?.value).toBe(3);
    // 3 distinct recovery turns x 1M input x $5/MTok, no 0.5.
    expect(f?.modeled_u).toBeCloseTo(15_000_000, 3);
  });

  it("near-miss: 19 calls or 2 errors does not fire", () => {
    expect(oracleC1(build(19, 3), NOW).findings).toHaveLength(0);
    expect(oracleC1(build(20, 2), NOW).findings).toHaveLength(0);
  });

  it("benign failures (hook block, user reject) are not counted", () => {
    seq = 0;
    const db = mkdb();
    for (let i = 0; i < 200; i++) call(db, "Read", "OK", null);
    for (let i = 0; i < 20; i++)
      call(
        db,
        "Edit",
        "ERROR",
        i % 2
          ? "PreToolUse:Edit hook error: no"
          : "The user doesn't want to proceed with this tool use",
      );
    expect(oracleC1(db, NOW).findings).toHaveLength(0);
  });
});
