import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD12 } from "./D12.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

function mkDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, model_tier TEXT, unit_prices_json TEXT NOT NULL, captured_at TEXT);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, file_path TEXT, state TEXT);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, model TEXT DEFAULT 'claude-sonnet',
      is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED,
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER, provisional INTEGER DEFAULT 0, agent_id TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT PRIMARY KEY, owner_message_id TEXT);
    CREATE TABLE subagent_meta (agent_id TEXT PRIMARY KEY, session_id TEXT, agent_type TEXT, tool_use_id TEXT);
    CREATE TABLE user_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT, event_ts TEXT, boundary_kind TEXT, boundary_verification TEXT);
  `);
  // [in, out, cacheRead, cw5m, cw1h] µ$/token: read 1, 5m write 10.
  db.prepare(
    "INSERT INTO pricing_snapshots VALUES ('p','sonnet','[0,0,1,10,0]','2027-01-01')",
  ).run();
  return db;
}

let n = 0;
function turn(
  db: Database.Database,
  session: string,
  ts: string,
  o: { out?: number; side?: boolean; agent?: string; ctx?: number; prov?: boolean } = {},
): string {
  const id = `m${n++}`;
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, is_sidechain, output_tokens, cache_read_tokens, pricing_snapshot_id, provisional, agent_id) VALUES (?,?,'w1',?,?,?,?, 'p',?,?)",
  ).run(id, session, ts, o.side ? 1 : 0, o.out ?? 0, o.ctx ?? 0, o.prov ? 1 : 0, o.agent ?? null);
  return id;
}

/** One session: owner turn, Agent call, subagent (last-turn output `sub`), `carry` later main turns. */
function session(db: Database.Database, s: string, sub: number, carry: number): void {
  const owner = turn(db, s, "2027-01-03T00:00:00.000Z");
  db.prepare("INSERT INTO tool_events VALUES (?,?,?, 'Agent')").run(
    `ev-${s}`,
    s,
    "2027-01-03T00:00:01.000Z",
  );
  db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(`ev-${s}`, owner);
  db.prepare("INSERT INTO subagent_meta VALUES (?,?, 'general', ?)").run(`ag-${s}`, s, `ev-${s}`);
  turn(db, s, "2027-01-03T00:00:02.000Z", { out: 1, side: true, agent: `ag-${s}` });
  turn(db, s, "2027-01-03T00:00:03.000Z", { out: sub, side: true, agent: `ag-${s}` });
  for (let i = 0; i < carry; i++) turn(db, s, `2027-01-03T01:00:0${i}.000Z`);
}

function cal(db: Database.Database): void {
  db.prepare("INSERT OR REPLACE INTO user_config VALUES ('bytes_per_token','2.7','t')").run();
}

describe("oracleD12 (modeled carried-return figure)", () => {
  it("uncalibrated bytes/token: fires but modeled is null (card: not shown), rank value kept", () => {
    const db = mkDb();
    for (const s of ["a", "b", "c"]) session(db, s, 5000, 4);
    const f = oracleD12(db, NOW).findings[0];
    expect(f?.modeled_u).toBeNull();
    expect(f?.measured_u).toBe(97500);
  });

  it("prices output x 0.5 x (W + R x (carry-1)) per qualifying return, summed over 3 sessions", () => {
    const db = mkDb();
    cal(db);
    // 5000 tokens x 2.7 = 13500 bytes > 10240. carry 4: W 10 + R 1 x 3 = 13. Per session 5000 x 0.5 x 13 = 32500.
    for (const s of ["a", "b", "c"]) session(db, s, 5000, 4);
    const r = oracleD12(db, NOW);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.scope.key).toBe("D12|w1");
    expect(f?.modeled_u).toBe(97500);
    expect(f?.quantities.find((q) => q.name === "sessions")?.value).toBe(3);
    expect(f?.assumptions.map((a) => a.name)).toContain("D12_AVOIDANCE_FRACTION");
  });

  it("near miss: two sessions is silent", () => {
    const db = mkDb();
    for (const s of ["a", "b"]) session(db, s, 5000, 4);
    expect(oracleD12(db, NOW).findings).toEqual([]);
  });

  it("near miss: return at 10240 bytes is skipped, one token above counts (bpt 2.7 vs user_config)", () => {
    const db = mkDb();
    db.prepare("INSERT INTO user_config VALUES ('bytes_per_token','2','t')").run();
    for (const s of ["a", "b", "c"]) session(db, s, 5120, 4); // 5120 x 2 = 10240: not > 10240
    expect(oracleD12(db, NOW).findings).toEqual([]);
    const db2 = mkDb();
    db2.prepare("INSERT INTO user_config VALUES ('bytes_per_token','2','t')").run();
    for (const s of ["a", "b", "c"]) session(db2, s, 5121, 4);
    expect(oracleD12(db2, NOW).findings).toHaveLength(1);
  });

  it("a carry-0 call counts toward the session gate but prices 0", () => {
    const db = mkDb();
    cal(db);
    for (const s of ["a", "b"]) session(db, s, 5000, 4);
    session(db, "c", 5000, 0);
    // 2 x 32500 = 65000; session c adds nothing but is the 3rd session.
    expect(oracleD12(db, NOW).findings[0]?.modeled_u).toBe(65000);
  });

  it("applies the 0.25 percent spend gate", () => {
    const db = mkDb();
    for (const s of ["a", "b", "c"]) session(db, s, 5000, 4);
    // Priced spend so far = 0 (no token columns priced). Add a big spend turn: 5m write 1,000,000 x 10 = 10,000,000 µ$.
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_write_5m, pricing_snapshot_id) VALUES ('big','a','w1','2027-01-04T00:00:00.000Z',1000000,'p')",
    ).run();
    // 97500 / 10,000,000 = 0.975 percent: fires. Raise spend to 100,000,000 -> 0.0975 percent: silent.
    expect(oracleD12(db, NOW).findings).toHaveLength(1);
    db.prepare("UPDATE turns SET cache_write_5m = 10000000 WHERE message_id = 'big'").run();
    expect(oracleD12(db, NOW).findings).toEqual([]);
  });

  it("stops the carry at a verified compact boundary", () => {
    const db = mkDb();
    cal(db);
    for (const s of ["a", "b", "c"]) session(db, s, 5000, 4);
    db.prepare(
      "INSERT INTO ingest_metric_events VALUES ('b1','a','2027-01-03T01:00:02.000Z','compact-boundary','VERIFIED')",
    ).run();
    // Session a carries 2 turns: W 10 + R 1 x 1 = 11 -> 27500; b, c 32500 each.
    expect(oracleD12(db, NOW).findings[0]?.modeled_u).toBe(92500);
  });
});
