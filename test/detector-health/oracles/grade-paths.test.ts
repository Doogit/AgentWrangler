/** DH3b grade paths (per-scope, presence, B4 secondary, D7 lanes): each can go RED as well as green. Synthetic traces. */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineTrace } from "../pipeline.js";
import { gradeOracle } from "./grade.js";
import { ORACLES, laneTrace } from "./index.js";
import type { OracleFigure, OracleFinding, OracleResult } from "./types.js";

type Money = PipelineTrace["money"][number];

let db: Database.Database;
beforeAll(() => {
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
});
afterAll(() => db.close());

const finding = (
  p: Partial<OracleFinding> & { key: string; ws: string | null },
): OracleFinding => ({
  scope: { workspace_id: p.ws, key: p.key },
  quantities: p.quantities ?? [],
  measured_u: p.measured_u ?? null,
  assumptions: [],
  modeled_u: p.modeled_u ?? null,
  ...(p.count === undefined ? {} : { count: p.count }),
});
const result = (findings: OracleFinding[]): OracleResult => ({
  findings,
  turns_checked: [],
  note: "",
});
const money = (p: Partial<Money>): Money => ({
  kind: "net-$",
  headline: null,
  modeled: null,
  reliability: null,
  range: null,
  pct_of_weekly_spend: null,
  ...p,
});
const trace = (rows: Money[]): PipelineTrace =>
  ({ status: "ACTIVE", money: rows }) as unknown as PipelineTrace;
const grade = (r: OracleResult, rows: Money[], figure: OracleFigure) =>
  gradeOracle(r, trace(rows), figure, db).verdict;

describe("per-scope grading (global findings, rec scope keys)", () => {
  const oracle = result([
    finding({ key: "C1|a", ws: null, modeled_u: 100 }),
    finding({ key: "C1|b", ws: null, modeled_u: 200 }),
  ]);
  const card = (a: number, b: number) => [
    money({ reliability: a, scope_key: "C1|a" }),
    money({ reliability: b, scope_key: "C1|b" }),
  ];

  it("passes when each scope matches", () => {
    expect(grade(oracle, card(100, 200), "reliability")).toMatch(/^PASS \(2 ws/);
  });
  it("fails a mismatched scope even when the total agrees", () => {
    expect(grade(oracle, card(200, 100), "reliability")).toMatch(/^FAIL/);
    expect(grade(oracle, card(100, 150), "reliability")).toMatch(/^FAIL/);
  });
  it("fails a scope the card lacks", () => {
    expect(grade(oracle, [money({ reliability: 100, scope_key: "C1|a" })], "reliability")).toMatch(
      /^FAIL/,
    );
  });
});

describe("presence figure (B2)", () => {
  const f = (ws: string, read: number) =>
    finding({
      key: `B2|${ws}`,
      ws,
      count: 21,
      quantities: [{ name: "previous_cache_read_tokens", unit: "tokens", value: read }],
    });
  const row = (ws: string, read: number) =>
    money({
      kind: "folded",
      scope_workspace_id: ws,
      metrics: { PREVIOUS_CACHE_READ_TOKENS: read },
    });

  it("passes when workspaces and sums agree (pair count not compared)", () => {
    expect(
      grade(result([f("w1", 500), f("w2", 7)]), [row("w1", 500), row("w2", 7)], "presence"),
    ).toMatch(/^PASS \(2 ws/);
  });
  it("fails a missing workspace", () => {
    expect(grade(result([f("w1", 500), f("w2", 7)]), [row("w1", 500)], "presence")).toMatch(
      /^FAIL.*miss/,
    );
  });
  it("fails a wrong exact sum", () => {
    expect(grade(result([f("w1", 500)]), [row("w1", 501)], "presence")).toMatch(
      /^FAIL.*PREVIOUS_CACHE_READ_TOKENS/,
    );
  });
});

describe("B4 secondary checks", () => {
  const oracle = result([
    finding({
      key: "B4|w1",
      ws: "w1",
      count: 2,
      measured_u: 1_000_000,
      quantities: [{ name: "break_creation_tokens", unit: "tokens", value: 1000 }],
    }),
  ]);
  const card = (creation: number, rewrite: number) => [
    money({
      kind: "folded",
      count: 2,
      scope_workspace_id: "w1",
      metrics: { CURRENT_CACHE_CREATION_TOKENS: creation, REWRITE_COST_U: rewrite },
    }),
  ];
  it("passes exact creation and rewrite within 3%", () => {
    expect(grade(oracle, card(1000, 1_000_000), "count")).toMatch(/^PASS/);
    expect(grade(oracle, card(1000, 1_020_000), "count")).toMatch(/^PASS/);
  });
  it("fails creation off by 1", () => {
    expect(grade(oracle, card(1001, 1_000_000), "count")).toMatch(
      /^FAIL.*CURRENT_CACHE_CREATION_TOKENS/,
    );
  });
  it("fails rewrite cost off by more than 3%", () => {
    expect(grade(oracle, card(1000, 1_040_000), "count")).toMatch(/^FAIL.*REWRITE_COST_U/);
  });
});

describe("D7 lanes", () => {
  const loopRow = money({
    kind: "standalone-$",
    modeled: 100,
    scope_workspace_id: "w1",
    scope_key: "D7|w1",
  });
  const xreadRow = money({
    modeled: 999,
    headline: 50,
    scope_workspace_id: "w1",
    scope_key: "D7-XREAD|w1",
  });
  const t = trace([loopRow, xreadRow]);
  const loopResult = result([finding({ key: "D7|w1", ws: "w1", modeled_u: 100 })]);

  it("the loop lane excludes XREAD rows and the XREAD lane keeps only them", () => {
    expect(laneTrace(ORACLES.D7 as never, t).money).toEqual([loopRow]);
    expect(laneTrace(ORACLES.D7X as never, t).money).toEqual([xreadRow]);
    expect(ORACLES.D7X?.trace_id).toBe("D7");
  });
  it("loop grade passes with the XREAD row filtered out and fails without the filter", () => {
    expect(
      gradeOracle(loopResult, laneTrace(ORACLES.D7 as never, t), "modeled", db).verdict,
    ).toMatch(/^PASS/);
    expect(gradeOracle(loopResult, t, "modeled", db).verdict).toMatch(/^FAIL/);
  });
});
