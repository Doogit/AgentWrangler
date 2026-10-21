import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD10 } from "./D10.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const IN = "2027-01-03T00:00:00.000Z";

function mkDb(outputPrice = 0): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED,
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER, provisional INTEGER DEFAULT 0, agent_id TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT);
    CREATE TABLE tool_event_skills (event_id TEXT PRIMARY KEY, skill_name TEXT NOT NULL);
    CREATE TABLE catalog_items (
      item_id TEXT PRIMARY KEY, kind TEXT, name TEXT, plugin TEXT, usage_key TEXT, tokens INTEGER);
  `);
  // [in, out, cacheRead, cw5m, cw1h]: cache read 2 µ$/token; a large output price makes spend dominate (gate a off).
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', ?)").run(`[0,${outputPrice},2,0,0]`);
  return db;
}

let n = 0;
function turn(
  db: Database.Database,
  o: {
    read?: number;
    input?: number;
    out?: number;
    ts?: string;
    prov?: boolean;
    ws?: string;
    snap?: string | null;
  } = {},
): void {
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, input_tokens, output_tokens, pricing_snapshot_id, provisional) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    `m${n++}`,
    "s",
    o.ws ?? "w1",
    o.ts ?? IN,
    o.read ?? 19900,
    o.input ?? 100,
    o.out ?? 0,
    o.snap === undefined ? "p" : o.snap,
    o.prov ? 1 : 0,
  );
}
function item(
  db: Database.Database,
  kind: string,
  name: string,
  tokens: number | null,
  plugin: string | null = null,
  key: string | null = name,
): void {
  db.prepare("INSERT INTO catalog_items VALUES (?,?,?,?,?,?)").run(
    `${kind}:${name}`,
    kind,
    name,
    plugin,
    key,
    tokens,
  );
}
function skillCall(db: Database.Database, skill: string, ts = IN): void {
  const id = `e${n++}`;
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,?)").run(id, "s", ts, "Skill");
  db.prepare("INSERT INTO tool_event_skills VALUES (?,?)").run(id, skill);
}
function toolCall(db: Database.Database, tool: string): void {
  db.prepare("INSERT INTO tool_events VALUES (?,?,?,?)").run(`e${n++}`, "s", IN, tool);
}
/** 4 turns of mean context 20000 (19900 cached + 100 input), huge output so gate (a) cannot fire. */
function fourTurns(db: Database.Database): void {
  for (let i = 0; i < 4; i++) turn(db, { out: 20000 });
}

describe("oracleD10 (net headline)", () => {
  it("fires at exactly 5% of mean context and claims half the removable tokens per turn at its own price", () => {
    const db = mkDb(100);
    fourTurns(db);
    item(db, "skill", "unused", 1000);
    const r = oracleD10(db, NOW);
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    if (!f) throw new Error("no finding");
    expect(f.scope).toEqual({ workspace_id: null, key: "D10|global|MCP_SCHEMAS" });
    // round(1000 x 0.5) = 500 tokens x 2 µ$ = 1000 per turn x 4 turns.
    expect(f.modeled_u).toBe(4000);
    expect(f.count).toBe(4);
    expect(f.assumptions.map((a) => a.name)).toContain("D1_D10_AVOIDANCE_FRACTION");
  });

  it("near miss: one token under 5% of mean context is silent", () => {
    const db = mkDb(100);
    fourTurns(db);
    item(db, "skill", "unused", 999);
    expect(oracleD10(db, NOW).findings).toEqual([]);
  });

  it("gate (a) alone can fire: 0.5% of spend", () => {
    const db = mkDb(0);
    for (let i = 0; i < 4; i++) turn(db, { read: 1_000_000, input: 0 });
    // removable 100 << 5% of mean (50000), so gate (b) is off. Modelled 100 x 4 x 2 x 0.5 = 400; spend 8,000,000 -> 0.005%.
    item(db, "skill", "unused", 100);
    expect(oracleD10(db, NOW).findings).toEqual([]);
    // Raise removable so modelled is 0.5% of spend while still under gate (b): 40000 x 4 x 2 x 0.5 = 160000 = 2%.
    const db2 = mkDb(0);
    for (let i = 0; i < 4; i++) turn(db2, { read: 1_000_000, input: 0 });
    item(db2, "skill", "unused", 40000);
    expect(oracleD10(db2, NOW).findings).toHaveLength(1);
  });

  it("caps the claim at the turn's cache reads and skips zero-cache-read turns", () => {
    const db = mkDb(100);
    turn(db, { read: 600, input: 19400, out: 20000 }); // claim min(1000, 600) = 600 -> 300 tokens x 2 = 600
    turn(db, { read: 0, input: 20000, out: 20000 }); // nothing
    turn(db, { read: 19900, out: 20000 }); // 500 x 2 = 1000
    item(db, "skill", "unused", 1000);
    const f = oracleD10(db, NOW).findings[0];
    expect(f?.modeled_u).toBe(1600);
    expect(f?.count).toBe(2);
  });

  it("excludes used skills and used plugin children; plugin-owned skills are not listed on their own", () => {
    const db = mkDb(100);
    fourTurns(db);
    item(db, "skill", "used-one", 5000);
    skillCall(db, "used-one");
    item(db, "skill", "stale-use", 7000);
    skillCall(db, "stale-use", "2026-12-01T00:00:00.000Z"); // outside the window: still a candidate
    item(db, "plugin", "pa@m", 300, "pa@m", null);
    item(db, "skill", "pa:child", 50, "pa@m", "pa:child");
    skillCall(db, "pa:child"); // child used -> plugin pa is not a candidate
    item(db, "plugin", "pb@m", 200, "pb@m", null);
    item(db, "skill", "pb:child", 40, "pb@m", "pb:child"); // unused: plugin counts 200, child not listed
    item(db, "plugin", "pc@m", 100, "pc@m", null);
    item(db, "mcp_server", "pc:srv", null, "pc@m", "mcp__plugin_pc_srv__");
    toolCall(db, "mcp__plugin_pc_srv__do_it"); // MCP child used by prefix -> plugin pc is not a candidate
    item(db, "mcp_server", "lone", null, null, "mcp__lone__"); // unsized: adds 0
    const f = oracleD10(db, NOW).findings[0];
    const removable = f?.quantities.find((q) => q.name === "removable_tokens")?.value;
    expect(removable).toBe(7000 + 200); // stale-use skill + plugin pb; NULL MCP counts 0
    // claim per turn = round(min(7200, 19900) x 0.5) = 3600 tokens x 2 µ$ x 4 turns.
    expect(f?.modeled_u).toBe(28800);
  });

  it("ignores provisional turns and prices an unpriced turn at $0", () => {
    const db = mkDb(100);
    fourTurns(db);
    turn(db, { out: 20000, prov: true });
    turn(db, { out: 20000, snap: null }); // counts for mean/turn set but claims $0
    item(db, "skill", "unused", 1000);
    const f = oracleD10(db, NOW).findings[0];
    expect(f?.modeled_u).toBe(4000);
  });

  it("is NOT_EVALUATED (silent) with no catalog rows", () => {
    const db = mkDb(100);
    fourTurns(db);
    expect(oracleD10(db, NOW).findings).toEqual([]);
  });
});
