import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineTrace } from "../pipeline.js";
import { gradeOracle } from "./grade.js";
import { priceCrossCheck, priceTurns } from "./price.js";
import { rawCheck } from "./raw-check.js";
import type { OracleFinding, OracleResult } from "./types.js";

let dir: string;
let file: string;
let db: Database.Database;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-dh3-"));
  file = path.join(dir, "s1.jsonl");
  const line = (id: string, side: boolean, ts: string) =>
    JSON.stringify({
      type: "assistant",
      uuid: `u-${id}`,
      isSidechain: side,
      timestamp: ts,
      message: {
        id,
        usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
      },
    });
  fs.writeFileSync(
    file,
    [
      line("m1", false, "2027-01-01T00:00:00.000Z"),
      line("m2", false, "2027-01-01T00:01:00.000Z"),
    ].join("\n"),
  );

  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL);
    CREATE TABLE turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, is_sidechain INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_5m INTEGER, cache_write_1h INTEGER, cache_write_other INTEGER,
      context_tokens AS (input_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other) STORED,
      pricing_snapshot_id TEXT, cost_equiv_u INTEGER);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p1', '[5, 25, 0.5, 6.25, 10]')").run();
  db.prepare("INSERT INTO sessions VALUES ('s1', ?)").run(file);
  // 1M in, 1M out, 1M read, 1M cw5m, 1M cw1h, 1M other = 5+25+.5+6.25+10+6.25 = 53 $ = 53e6 µ$
  db.prepare(
    "INSERT INTO turns (message_id, session_id, ts, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id, cost_equiv_u) VALUES ('big','s1','2027-01-01T00:00:00.000Z',0,1000000,1000000,1000000,1000000,1000000,1000000,'p1',53000000)",
  ).run();
  db.prepare(
    "INSERT INTO turns (message_id, session_id, ts, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id, cost_equiv_u) VALUES ('nosnap','s1','2027-01-01T00:00:00.000Z',0,1,1,1,1,1,1,NULL,NULL)",
  ).run();
  // m1 matches raw (ctx 115); m2 has a deliberate is_sidechain mismatch.
  db.prepare(
    "INSERT INTO turns (message_id, session_id, ts, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id, cost_equiv_u) VALUES ('m1','s1','2027-01-01T00:00:00.000Z',0,10,0,100,5,0,0,'p1',131.25)",
  ).run();
  db.prepare(
    "INSERT INTO turns (message_id, session_id, ts, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id, cost_equiv_u) VALUES ('m2','s1','2027-01-01T00:01:00.000Z',1,10,0,100,5,0,0,'p1',131.25)",
  ).run();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const finding = (ws: string | null, modeled: number, assumptions = false): OracleFinding => ({
  scope: { workspace_id: ws, key: `X|${ws}` },
  quantities: [],
  measured_u: modeled,
  assumptions: assumptions ? [{ name: "k", value: 0.5, source: "card" }] : [],
  modeled_u: modeled,
});
const result = (findings: OracleFinding[], turns: string[] = ["m1"]): OracleResult => ({
  findings,
  turns_checked: turns,
  note: "",
});
const trace = (cards: Array<[string | null, number]>): PipelineTrace =>
  ({
    status: "ACTIVE",
    money: cards.map(([ws, modeled]) => ({
      kind: "net-$",
      headline: modeled,
      modeled,
      reliability: null,
      range: null,
      pct_of_weekly_spend: null,
      scope_workspace_id: ws,
    })),
  }) as unknown as PipelineTrace;

describe("DH3 harness", () => {
  it("prices a turn from its token columns and snapshot", () => {
    const m = priceTurns(db, ["big", "nosnap"]);
    expect(m.get("big")).toBeCloseTo(53_000_000, 3);
    expect(m.has("nosnap")).toBe(false);
    const x = priceCrossCheck(db, ["big", "nosnap"]);
    expect(x.n).toBe(1);
    expect(x.max_rel_diff).toBeLessThan(1e-9);
  });

  it("grades a match PASS, 5% off FAIL, oracle-only workspace FAIL miss", () => {
    const ok = gradeOracle(result([finding("w1", 100)]), trace([["w1", 101]]), "modeled", db);
    expect(ok.verdict).toMatch(/^PASS \(1 ws, mean err \+1\.0%, raw n=1/);
    const off = gradeOracle(result([finding("w1", 100)]), trace([["w1", 105]]), "modeled", db);
    expect(off.verdict).toMatch(/^FAIL \(.*err \+5\.0%/);
    const miss = gradeOracle(
      result([finding("w1", 100), finding("w2", 50)]),
      trace([["w1", 100]]),
      "modeled",
      db,
    );
    expect(miss.verdict).toMatch(/^FAIL \(miss:/);
    const extra = gradeOracle(
      result([finding("w1", 100)]),
      trace([
        ["w1", 100],
        ["w2", 5],
      ]),
      "modeled",
      db,
    );
    expect(extra.verdict).toMatch(/^FAIL \(extra:/);
  });

  it("marks assumption-bound and handles silent INACTIVE", () => {
    const g = gradeOracle(result([finding("w1", 100, true)]), trace([["w1", 100]]), "modeled", db);
    expect(g.verdict).toMatch(/^PASS .*assumption-bound\)$/);
    const inactive = { ...trace([]), status: "INACTIVE" } as PipelineTrace;
    expect(gradeOracle(result([], []), inactive, "modeled", db).verdict).toBe(
      "PASS (silent, 0 findings)",
    );
    expect(gradeOracle(result([finding("w1", 1)]), inactive, "modeled", db).verdict).toMatch(
      /^FAIL \(miss:/,
    );
  });

  it("raw check passes matching turns and FAILs a deliberate is_sidechain mismatch", () => {
    expect(rawCheck(db, ["m1"]).mismatches).toEqual([]);
    const bad = rawCheck(db, ["m1", "m2"]);
    expect(bad.sampled).toBe(2);
    expect(bad.mismatches).toEqual([{ field: "is_sidechain", count: 1 }]);
    const g = gradeOracle(
      result([finding("w1", 100)], ["m1", "m2"]),
      trace([["w1", 100]]),
      "modeled",
      db,
    );
    expect(g.verdict).toMatch(/^FAIL \(raw mismatch is_sidechain×1/);
  });
});
