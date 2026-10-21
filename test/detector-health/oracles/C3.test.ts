import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC3 } from "./C3.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkdb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT,
      tool_error_class TEXT, tool_error_classifier_version TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      agent_id TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0,
      cache_write_other INTEGER DEFAULT 0, pricing_snapshot_id TEXT, cost_equiv_u REAL, provisional INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[5, 25, 0.5, 6.25, 10]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','RECONCILED')").run();
  return db;
}
const turn = (
  db: Database.Database,
  id: string,
  ts: string,
  input: number,
  opts: { side?: number; agent?: string | null; prov?: number } = {},
) =>
  db
    .prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, is_sidechain, agent_id, input_tokens, pricing_snapshot_id, provisional) VALUES (?,'s1','w1',?,?,?,?,'p',?)",
    )
    .run(id, ts, opts.side ?? 0, opts.agent ?? null, input, opts.prov ?? 0);
const fail = (
  db: Database.Database,
  ev: string,
  ts: string,
  owner: string,
  cls = "NOT_READ",
  tool = "Edit",
) => {
  db.prepare("INSERT INTO tool_events VALUES (?,'s1',?,?,?,'tool-error-1')").run(ev, ts, tool, cls);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(ev, owner);
};

describe("oracleC3", () => {
  it("prices the full recovery turn after a main-chain NOT_READ Edit", () => {
    const db = mkdb();
    turn(db, "m1", "2027-01-02T00:00:00.000Z", 1000);
    turn(db, "m2", "2027-01-02T00:01:00.000Z", 1_000_000); // 1M input x $5/MTok = 5,000,000 µ$
    fail(db, "e1", "2027-01-02T00:00:00.000Z", "m1");
    const f = oracleC3(db, NOW).findings;
    expect(f).toHaveLength(1);
    expect(f[0]?.scope.key).toBe("C3|w1");
    expect(f[0]?.count).toBe(1);
    expect(f[0]?.modeled_u).toBeCloseTo(5_000_000, 3);
  });

  it("near-miss: subagent-only failure shows a real 0 headline; other error class does not fire", () => {
    const db = mkdb();
    turn(db, "a1", "2027-01-02T00:00:00.000Z", 1000, { side: 1, agent: "ag" });
    turn(db, "a2", "2027-01-02T00:01:00.000Z", 1_000_000, { side: 1, agent: "ag" });
    fail(db, "e1", "2027-01-02T00:00:00.000Z", "a1");
    turn(db, "m1", "2027-01-03T00:00:00.000Z", 1000);
    turn(db, "m2", "2027-01-03T00:01:00.000Z", 1_000_000);
    fail(db, "e2", "2027-01-03T00:00:00.000Z", "m1", "OTHER");
    const f = oracleC3(db, NOW).findings;
    expect(f).toHaveLength(1);
    expect(f[0]?.count).toBe(1);
    expect(f[0]?.modeled_u).toBe(0);
    expect(f[0]?.quantities.find((q) => q.name === "subagent_recovery_u")?.value).toBe(5_000_000);
  });

  it("skips a provisional recovery turn and takes the next settled one", () => {
    const db = mkdb();
    turn(db, "m1", "2027-01-02T00:00:00.000Z", 1000);
    turn(db, "m2", "2027-01-02T00:01:00.000Z", 9_000_000, { prov: 1 });
    turn(db, "m3", "2027-01-02T00:02:00.000Z", 2_000_000); // 10,000,000 µ$
    fail(db, "e1", "2027-01-02T00:00:00.000Z", "m1", "NOT_READ", "Write");
    expect(oracleC3(db, NOW).findings[0]?.modeled_u).toBeCloseTo(10_000_000, 3);
  });
});
