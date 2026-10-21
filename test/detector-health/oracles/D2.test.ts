import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD2 } from "./D2.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const T0 = Date.parse("2027-01-03T00:00:00.000Z");

function mkDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, ts TEXT, is_sidechain INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED,
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER, provisional INTEGER DEFAULT 0, agent_id TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, commit_sha TEXT);
  `);
  // [in, out, cacheRead, cw5m, cw1h] = µ$/token: cache read 2, cache write 3.
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p', '[0,0,2,3,0]')").run();
  return db;
}

/** S sessions of N main turns, context A + 1000 i, all cache reads, one turn per minute, sessions 3 h apart. */
function seed(db: Database.Database, S: number, N: number, A: number): void {
  const ins = db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, pricing_snapshot_id) VALUES (?,?,?,?,?,'p')",
  );
  for (let s = 0; s < S; s++)
    for (let i = 0; i < N; i++)
      ins.run(
        `m${s}-${String(i).padStart(3, "0")}`,
        `s${s}`,
        "w1",
        new Date(T0 + s * 3 * 3600_000 + i * 60_000).toISOString(),
        A + 1000 * i,
      );
}

describe("oracleD2 (net headline)", () => {
  it("positive: 3 sessions x 151 turns, hand-computed ledger headline", () => {
    const db = mkDb();
    seed(db, 3, 151, 110000);
    // base 110000; 1 split/session at row 76, atSplit = 185000, avoided 185000-110000-2000 = 73000 on rows 76..150
    // (75 rows) = 5,475,000/session, 16,425,000 total; context total 3x151x185000 = 83,805,000 -> reduction 0.1960.
    // readSpend 167,610,000; rebuild 3 x 112000 x 3 = 1,008,000; savings 167,610,000x0.196 - 1,008,000 = 31,843,560.
    // fraction = 31,843,560 / (16,425,000 x 2) = 0.96936; per row round(73000 x f) = 70,763 tokens x 2 x 225 rows.
    const r = oracleD2(db, NOW);
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    if (!f) throw new Error("no finding");
    expect(f.scope).toEqual({ workspace_id: null, key: "D2|global|D2_LONG_CONTEXT_CACHE_READ_V1" });
    const q = (n: string) => f.quantities.find((x) => x.name === n)?.value;
    expect(q("split_count")).toBe(3);
    expect(q("avoided_tokens")).toBe(16_425_000);
    expect(q("claimed_turns")).toBe(225);
    expect(f.modeled_u).toBe(225 * 70_763 * 2);
    expect(f.assumptions.map((a) => a.name)).toEqual(
      expect.arrayContaining(["D2_CALLS_PER_SPLIT", "D2_SUMMARY_TOKENS", "D2_NO_COMPETING_CLAIMS"]), // gitleaks:allow (identifier, not a key)
    );
  });

  it("near-miss: exactly 150 turns does not qualify", () => {
    const db = mkDb();
    seed(db, 3, 150, 110000);
    expect(oracleD2(db, NOW).findings).toEqual([]);
  });

  it("near-miss: mean context exactly 180000 does not qualify", () => {
    const db = mkDb();
    seed(db, 3, 151, 105000);
    expect(oracleD2(db, NOW).findings).toEqual([]);
  });

  it("near-miss: 2 qualifying sessions is silent", () => {
    const db = mkDb();
    seed(db, 2, 151, 110000);
    expect(oracleD2(db, NOW).findings).toEqual([]);
  });

  it("a commit inside reach moves the split; one outside reach does not", () => {
    const sha = (db: Database.Database, minuteAfter: number) =>
      db
        .prepare("INSERT INTO tool_events VALUES ('e', 's0', ?, 'abc')")
        .run(new Date(T0 + minuteAfter * 60_000 + 30_000).toISOString());
    const avoided = (db: Database.Database) =>
      oracleD2(db, NOW).findings[0]?.quantities.find((x) => x.name === "avoided_tokens")?.value;
    // Commit between rows 79 and 80: boundary j = 80, |80-76| = 4 <= reach 18. s0 split at 80: atSplit = ctx(79) =
    // 189000, avoided min(ctx, 77000)? ctx(row 80) = 190000 so 77000... but base+2000 = 112000 -> 189000-112000 = 77000
    // on rows 80..150 (71 rows) = 5,467,000; other two sessions unchanged 5,475,000 each.
    const near = mkDb();
    seed(near, 3, 151, 110000);
    sha(near, 79);
    expect(avoided(near)).toBe(5_467_000 + 2 * 5_475_000);
    // Commit between rows 119 and 120: j = 120, |120-76| = 44 > 18, ignored.
    const far = mkDb();
    seed(far, 3, 151, 110000);
    sha(far, 119);
    expect(avoided(far)).toBe(16_425_000);
  });

  it("1% spend gate: just under is silent, just over fires", () => {
    const build = (sideReads: number) => {
      const db = mkDb();
      seed(db, 3, 151, 110000);
      db.prepare(
        "INSERT INTO turns (message_id, session_id, workspace_id, ts, is_sidechain, cache_read_tokens, pricing_snapshot_id) VALUES ('side','x','w1','2027-01-04T00:00:00.000Z',1,?,'p')",
      ).run(sideReads);
      return db;
    };
    // savings 31,843,560; spend = 167,610,000 + 2 x sideReads. 1% needs spend <= 3,184,356,000.
    expect(oracleD2(build(2_000_000_000), NOW).findings).toEqual([]); // spend 4.17e9 -> 0.76%
    expect(oracleD2(build(1_500_000_000), NOW).findings).toHaveLength(1); // spend 3.17e9 -> 1.005%
  });

  it("ignores provisional and sidechain turns", () => {
    const db = mkDb();
    seed(db, 3, 150, 110000);
    // The 151st turn of each session is provisional: still 150 settled turns -> not qualifying.
    const ins = db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, cache_read_tokens, pricing_snapshot_id, provisional) VALUES (?,?,?,?,?,'p',1)",
    );
    for (let s = 0; s < 3; s++)
      ins.run(
        `pv${s}`,
        `s${s}`,
        "w1",
        new Date(T0 + s * 3 * 3600_000 + 200 * 60_000).toISOString(),
        300000,
      );
    expect(oracleD2(db, NOW).findings).toEqual([]);
  });
});
