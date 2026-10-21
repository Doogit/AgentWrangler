import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD1 } from "./D1.js";

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
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED,
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER, provisional INTEGER DEFAULT 0, agent_id TEXT);
    CREATE TABLE subagent_meta (agent_id TEXT PRIMARY KEY, agent_type TEXT);
    CREATE TABLE context_inventory (
      probe_id TEXT PRIMARY KEY, workspace_id TEXT, probed_at TEXT, component TEXT, file_ref TEXT, tokens INTEGER,
      attribution_version TEXT NOT NULL DEFAULT 'v1');
    CREATE TABLE context_inventory_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, component TEXT, file_ref TEXT, tokens INTEGER,
      attribution_version TEXT, observed_at TEXT);
  `);
  // [in, out, cacheRead, cw5m, cw1h] $/MTok = µ$/token: cache read 2.
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[0,0,2,0,0]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','w1','s1.jsonl','RECONCILED')").run();
  return db;
}

let n = 0;
function addTurn(
  db: Database.Database,
  ctx: number,
  opts: { side?: boolean; agent?: string; prov?: boolean; ts?: string; input?: number } = {},
): void {
  // ctx = cache_read_tokens; opts.input adds uncached input (counts in context, not in cache reads).
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, is_sidechain, cache_read_tokens, input_tokens, pricing_snapshot_id, provisional, agent_id) VALUES (?,?,?,?,?,?,?,'p',?,?)",
  ).run(
    `m${n++}`,
    "s1",
    "w1",
    opts.ts ?? "2027-01-03T00:00:00.000Z",
    opts.side ? 1 : 0,
    ctx,
    opts.input ?? 0,
    opts.prov ? 1 : 0,
    opts.agent ?? null,
  );
}
function inv(
  db: Database.Database,
  id: string,
  component: string,
  ref: string,
  tokens: number,
  at = "2027-01-05T00:00:00.000Z",
): void {
  db.prepare(
    "INSERT INTO context_inventory (probe_id, workspace_id, probed_at, component, file_ref, tokens) VALUES (?,?,?,?,?,?)",
  ).run(id, "w1", at, component, ref, tokens);
}
function hist(
  db: Database.Database,
  component: string,
  ref: string,
  tokens: number,
  at: string,
): void {
  db.prepare(
    "INSERT INTO context_inventory_history (workspace_id, component, file_ref, tokens, attribution_version, observed_at) VALUES ('w1',?,?,?,'v1',?)",
  ).run(component, ref, tokens, at);
}

describe("oracleD1 (net headline)", () => {
  it("claims half the excess per eligible cache-reading turn at its own read price, and skips near-misses", () => {
    const db = mkDb();
    // 4 eligible turns: 3 main + 1 general-purpose subagent; Explore subagent and provisional turns are excluded.
    // Each turn: 100000 cache reads, read price 2 µ$/token.
    addTurn(db, 100000);
    addTurn(db, 100000);
    addTurn(db, 100000);
    addTurn(db, 100000, { side: true, agent: "gp" });
    addTurn(db, 100000, { side: true, agent: "ex" });
    addTurn(db, 100000, { prov: true });
    db.prepare("INSERT INTO subagent_meta VALUES ('gp','general-purpose'), ('ex','Explore')").run();
    // CLAUDE_MD 4000 (target 2000): delta 2000 per turn, claim 2000, tokens round(1000), value 1000 x 2 = 2000/turn
    // x 4 turns = 8000 µ$. Gate: modelled 2000x4x2x0.5 = 8000; spend 5 x 100000 x 2 = 1,000,000 -> 0.8% >= 0.2%.
    inv(db, "p1", "CLAUDE_MD", "/c/CLAUDE.md", 4000);
    // Near misses: at target exactly, MEMORY under its target, and a stale larger probe superseded by a smaller one.
    inv(db, "p2", "CLAUDE_MD", "/c/other.md", 2000);
    inv(db, "p3", "MEMORY", "/m/MEMORY.md", 900);
    inv(db, "p4", "CLAUDE_MD", "/c/old.md", 9000, "2027-01-02T00:00:00.000Z");
    inv(db, "p5", "CLAUDE_MD", "/c/old.md", 1500, "2027-01-06T00:00:00.000Z");

    const r = oracleD1(db, NOW);
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    if (!f) throw new Error("no finding");
    expect(f.scope.key).toBe("D1|w1|CLAUDE_MD|CLAUDE.md");
    expect(f.count).toBe(4);
    expect(f.modeled_u).toBeCloseTo(8000, 6);
    expect(f.measured_u).toBeCloseTo(8000, 6);
    expect(f.assumptions.map((a) => a.name)).toContain("D1_NO_COMPETING_CLAIMS");
  });

  it("sizes each turn from the as-of history row, else the current size", () => {
    const db = mkDb();
    addTurn(db, 100000, { ts: "2027-01-03T00:00:00.000Z" });
    addTurn(db, 100000, { ts: "2027-01-04T00:00:00.000Z" });
    // Current size 4000; history 3000 from Jan 1, 2600 from Jan 3 12:00.
    inv(db, "p1", "CLAUDE_MD", "/c/CLAUDE.md", 4000);
    hist(db, "CLAUDE_MD", "/c/CLAUDE.md", 3000, "2027-01-01T00:00:00.000Z");
    hist(db, "CLAUDE_MD", "/c/CLAUDE.md", 2600, "2027-01-03T12:00:00.000Z");
    // Jan 3 turn: delta 1000 -> 500 tokens x 2 = 1000. Jan 4 turn: delta 600 -> 300 x 2 = 600. Total 1600 (not 4000).
    const f = oracleD1(db, NOW).findings[0];
    expect(f?.modeled_u).toBeCloseTo(1600, 6);
    // A history row at or below the target stops that turn from claiming anything.
    hist(db, "CLAUDE_MD", "/c/CLAUDE.md", 1800, "2027-01-03T18:00:00.000Z");
    expect(oracleD1(db, NOW).findings[0]?.modeled_u).toBeCloseTo(1000, 6);
  });

  it("ignores MEMORY history before the floor date", () => {
    const db = mkDb();
    addTurn(db, 100000);
    inv(db, "p1", "MEMORY", "/m/MEMORY.md", 3000);
    hist(db, "MEMORY", "/m/MEMORY.md", 1100, "2026-09-01T00:00:00.000Z"); // ignored
    // delta 2000 -> 1000 tokens x 2 = 2000 (using the 1100 row would give 50 x 2 = 100).
    expect(oracleD1(db, NOW).findings[0]?.modeled_u).toBeCloseTo(2000, 6);
  });

  it("caps claims at the turn's cache reads, shared across sources in probe_id order", () => {
    const db = mkDb();
    addTurn(db, 3000); // one turn, 3000 cache reads
    inv(db, "p1", "CLAUDE_MD", "/a/one.md", 4000);
    inv(db, "p2", "CLAUDE_MD", "/b/two.md", 4000);
    // p1 claims min(2000, 3000) = 2000 -> 1000 tokens -> 2000 µ$; p2 gets the remaining 1000 -> 500 tokens -> 1000 µ$.
    const r = oracleD1(db, NOW);
    const by = new Map(r.findings.map((f) => [f.scope.key, f.modeled_u]));
    expect(by.get("D1|w1|CLAUDE_MD|one.md")).toBeCloseTo(2000, 6);
    expect(by.get("D1|w1|CLAUDE_MD|two.md")).toBeCloseTo(1000, 6);
  });

  it("zero-cache-read turns count for the gate but add nothing to the headline", () => {
    const db = mkDb();
    addTurn(db, 100000);
    addTurn(db, 0, { input: 100000 });
    inv(db, "p1", "CLAUDE_MD", "/c/CLAUDE.md", 4000);
    // Only the cache-reading turn claims: 1000 tokens x 2 = 2000 (modelled gross would use 2 eligible turns).
    const f = oracleD1(db, NOW).findings[0];
    expect(f?.modeled_u).toBeCloseTo(2000, 6);
    expect(f?.count).toBe(1);
  });

  it("applies the 2% context-share gate", () => {
    const db = mkDb();
    for (let i = 0; i < 4; i++) addTurn(db, 1_000_000); // mean context 1,000,000
    // 2500 tokens: > 2000 target but 2500 < 2% x 1,000,000 = 20000 -> no finding.
    inv(db, "p1", "CLAUDE_MD", "/c/CLAUDE.md", 2500);
    expect(oracleD1(db, NOW).findings).toEqual([]);
  });

  it("applies the 0.2% spend gate: just under is silent, just over fires", () => {
    // One eligible main turn (100000 reads) -> modelled 2000x1x2x0.5 = 2000 µ$. An Explore subagent turn is not
    // eligible for CLAUDE_MD but counts in scope spend (x2 µ$/token).
    const build = (exploreReads: number) => {
      const db = mkDb();
      addTurn(db, 100000);
      addTurn(db, exploreReads, { side: true, agent: "ex" });
      db.prepare("INSERT INTO subagent_meta VALUES ('ex','Explore')").run();
      inv(db, "p1", "CLAUDE_MD", "/c/CLAUDE.md", 4000);
      return db;
    };
    // spend 1,020,000 -> 2000/1,020,000 = 0.196% < 0.2%: silent.
    expect(oracleD1(build(410000), NOW).findings).toEqual([]);
    // spend 980,000 -> 0.204% >= 0.2%: fires with headline 1000 tokens x 2 = 2000.
    const f = oracleD1(build(390000), NOW).findings[0];
    expect(f?.modeled_u).toBeCloseTo(2000, 6);
  });

  it("MEMORY counts main turns only (non-fork subagent turns are not eligible)", () => {
    const db = mkDb();
    addTurn(db, 50000);
    addTurn(db, 50000, { side: true, agent: "gp" });
    db.prepare("INSERT INTO subagent_meta VALUES ('gp','general-purpose')").run();
    inv(db, "p1", "MEMORY", "/m/MEMORY.md", 3000);
    // 1 eligible turn: claim 2000 -> 1000 tokens x 2 = 2000 µ$.
    const f = oracleD1(db, NOW).findings[0];
    expect(f?.count).toBe(1);
    expect(f?.modeled_u).toBeCloseTo(2000, 6);
  });
});
