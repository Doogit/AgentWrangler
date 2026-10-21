import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleD5 } from "./D5.js";

const NOW = new Date("2026-10-14T06:00:00.000Z");
const RESET = "2026-10-16T06:00:00.000Z"; // 48h after NOW

function seed(refUsed: number): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE limit_snapshots (ts TEXT PRIMARY KEY, resets_at TEXT, used_pct REAL, source TEXT);
    CREATE TABLE user_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE turns (message_id TEXT PRIMARY KEY, ts TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0);
  `);
  const ins = db.prepare(`INSERT INTO limit_snapshots VALUES (?,?,?,'api')`);
  ins.run("2026-10-13T05:00:00.000Z", RESET, refUsed); // 24h before the latest reading
  ins.run("2026-10-14T05:00:00.000Z", RESET, 50);
  return db;
}

describe("oracleD5", () => {
  it("fires when pace projects >= 85% at reset", () => {
    // Pace (50 - 26)/24h = 1 %/h; hours to reset 48; projected 50 + 48 = 98 >= 85 -> one warning.
    const r = oracleD5(seed(26), NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.count).toBe(1);
    expect(r.findings[0]?.quantities.find((q) => q.name === "projected_pct")?.value).toBe(98);
  });

  it("stays silent below 85% and does not fall through to the token path", () => {
    // Pace (50 - 49)/24h; projected ~52% -> INACTIVE, even though a token limit is exceeded by turns.
    const db = seed(49);
    db.prepare(`INSERT INTO user_config VALUES ('limit_tokens','10','x')`).run();
    db.prepare(
      `INSERT INTO turns (message_id, ts, input_tokens) VALUES ('m','2026-10-10T00:00:00.000Z', 1000)`,
    ).run();
    expect(oracleD5(db, NOW).findings).toHaveLength(0);
  });

  it("ignores a stale (> 48h) snapshot and, with no limit and no turns, is blocked (silent)", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE limit_snapshots (ts TEXT PRIMARY KEY, resets_at TEXT, used_pct REAL, source TEXT);
      CREATE TABLE user_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
      CREATE TABLE turns (message_id TEXT PRIMARY KEY, ts TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, cache_write_other INTEGER DEFAULT 0);
      INSERT INTO limit_snapshots VALUES ('2026-10-11T05:00:00.000Z','${RESET}',95,'api');
    `);
    expect(oracleD5(db, NOW).findings).toHaveLength(0);
  });
});
