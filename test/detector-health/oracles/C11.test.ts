import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC11 } from "./C11.js";

const NOW = new Date("2026-10-14T00:00:00.000Z"); // window [2026-10-07, 2026-10-14)

let n = 0;
function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT);
    CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      provisional INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0,
      pricing_snapshot_id TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_error_class TEXT,
      tool_error_classifier_version TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p','[5,25,0.5,6.25,10]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','w1','RECONCILED')").run();
  return db;
}
function turn(
  db: Database.Database,
  id: string,
  ts: string,
  input: number,
  side = 0,
  prov = 0,
): void {
  db.prepare(
    "INSERT INTO turns (message_id, session_id, ts, is_sidechain, provisional, input_tokens, pricing_snapshot_id) VALUES (?,'s1',?,?,?,?,'p')",
  ).run(id, ts, side, prov, input);
}
function ev(
  db: Database.Database,
  owner: string,
  ts: string,
  cls = "MCP_CONTENT_TOO_LARGE",
  ver = "tool-error-1",
): void {
  const id = `e${n++}`;
  db.prepare("INSERT INTO tool_events VALUES (?,'s1',?,?,?)").run(id, ts, cls, ver);
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(id, owner);
}

describe("oracleC11", () => {
  it("claims the issuing and retry turn in full; Read over-cap priced but not counted", () => {
    const db = seed();
    turn(db, "m1", "2026-10-10T00:00:00.000Z", 1_000_000); // issuing: $5 = 5,000,000 u
    turn(db, "m2", "2026-10-10T00:01:00.000Z", 2_000_000); // retry: 10,000,000 u
    turn(db, "m3", "2026-10-10T00:02:00.000Z", 9_000_000); // not claimed
    ev(db, "m1", "2026-10-10T00:00:00.000Z");
    ev(db, "m1", "2026-10-10T00:00:00.000Z", "READ_OUTPUT_TOO_LARGE");
    const r = oracleC11(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.key).toBe("C11|w1|s1");
    expect(r.findings[0]?.count).toBe(1);
    expect(r.findings[0]?.modeled_u).toBeCloseTo(15_000_000, 3);
  });

  it("near miss: sidechain-owned, wrong version, provisional or non-reconciled calls stay silent", () => {
    const db = seed();
    turn(db, "side", "2026-10-10T00:00:00.000Z", 1000, 1);
    turn(db, "prov", "2026-10-10T00:00:00.000Z", 1000, 0, 1);
    turn(db, "ok", "2026-10-10T00:00:00.000Z", 1000);
    ev(db, "side", "2026-10-10T00:00:00.000Z");
    ev(db, "prov", "2026-10-10T00:00:00.000Z");
    ev(db, "ok", "2026-10-10T00:00:00.000Z", "MCP_CONTENT_TOO_LARGE", "tool-error-0");
    ev(db, "ok", "2026-10-14T00:00:00.000Z"); // exclusive upper bound
    db.prepare("UPDATE sessions SET state='LIVE'").run();
    ev(db, "ok", "2026-10-10T00:00:00.000Z");
    expect(oracleC11(db, NOW).findings).toHaveLength(0);
  });

  it("retry turn outside the window is not priced; distinct turn counted once", () => {
    const db = seed();
    turn(db, "m1", "2026-10-13T23:59:00.000Z", 1_000_000);
    turn(db, "m2", "2026-10-14T00:01:00.000Z", 1_000_000); // retry after window end
    ev(db, "m1", "2026-10-13T23:59:00.000Z");
    ev(db, "m1", "2026-10-13T23:59:00.000Z");
    const f = oracleC11(db, NOW).findings[0];
    expect(f?.count).toBe(2);
    expect(f?.modeled_u).toBeCloseTo(5_000_000, 3);
  });
});
