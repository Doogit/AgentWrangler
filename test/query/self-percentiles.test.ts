import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionSpendPercentile, getWeeklySelfPercentile } from "../../src/query/api/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const REFERENCE = "2027-06-20T12:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

function insWs(workspaceId: string): void {
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  ).run(workspaceId, workspaceId, REFERENCE);
}

function insSess(sessionId: string, workspaceId: string, costEquivU: number, ts = REFERENCE): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',1,?,'[]')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`, ts, ts, costEquivU);
}

describe("getSessionSpendPercentile", () => {
  it("returns exact percentiles for the min, middle, and max of 25 sessions", () => {
    insWs("ws-population");
    for (let cost = 1; cost <= 25; cost += 1) {
      insSess(`sess-${cost}`, "ws-population", cost);
    }

    expect(getSessionSpendPercentile(db, "sess-1")).toEqual({
      percentile: 1 / 25,
      n: 25,
      window_days: 90,
    });
    expect(getSessionSpendPercentile(db, "sess-13")).toEqual({
      percentile: 13 / 25,
      n: 25,
      window_days: 90,
    });
    expect(getSessionSpendPercentile(db, "sess-25")).toEqual({
      percentile: 1,
      n: 25,
      window_days: 90,
    });
  });

  it("withholds the percentile when fewer than 20 sessions are in the peer set", () => {
    insWs("ws-small");
    for (let cost = 1; cost <= 5; cost += 1) {
      insSess(`small-${cost}`, "ws-small", cost);
    }

    expect(getSessionSpendPercentile(db, "small-3")).toEqual({
      percentile: null,
      n: 5,
      window_days: 90,
    });
  });

  it("withholds the percentile for a single-session workspace", () => {
    insWs("ws-single");
    insSess("only-session", "ws-single", 100);

    expect(getSessionSpendPercentile(db, "only-session")).toEqual({
      percentile: null,
      n: 1,
      window_days: 90,
    });
  });

  it("counts tied costs on the at-or-below side", () => {
    insWs("ws-ties");
    for (let cost = 1; cost <= 18; cost += 1) {
      insSess(`lower-${cost}`, "ws-ties", cost);
    }
    insSess("tied-a", "ws-ties", 100);
    insSess("tied-b", "ws-ties", 100);
    for (let cost = 101; cost <= 105; cost += 1) {
      insSess(`higher-${cost}`, "ws-ties", cost);
    }

    expect(getSessionSpendPercentile(db, "tied-a")).toEqual({
      percentile: 20 / 25,
      n: 25,
      window_days: 90,
    });
    expect(getSessionSpendPercentile(db, "tied-b").percentile).toBe(20 / 25);
  });

  it("isolates peers to the target workspace", () => {
    insWs("ws-a");
    insWs("ws-b");
    for (let cost = 1; cost <= 25; cost += 1) {
      insSess(`a-${cost}`, "ws-a", cost);
      insSess(`b-${cost}`, "ws-b", 1_000 + cost);
    }

    expect(getSessionSpendPercentile(db, "a-13")).toEqual({
      percentile: 13 / 25,
      n: 25,
      window_days: 90,
    });
  });

  it("excludes sessions outside the target-anchored trailing 90-day window", () => {
    insWs("ws-window");
    for (let cost = 1; cost <= 24; cost += 1) {
      insSess(`in-window-${cost}`, "ws-window", cost);
    }
    insSess("target", "ws-window", 25);
    insSess("out-of-window", "ws-window", 1, "2027-03-21T11:59:59.999Z");

    expect(getSessionSpendPercentile(db, "target")).toEqual({
      percentile: 1,
      n: 25,
      window_days: 90,
    });
  });
});

// --- Per-week self-percentiles --------------------------------------------
// 2024-01-01 is a Monday, so all week boundaries below are hand-verifiable.
// `NOW` is a Wednesday whose ISO week starts Monday 2024-03-04; the eight
// trailing full weeks start 2024-02-26 … 2024-01-08.
const NOW = new Date("2024-03-06T12:00:00.000Z");
const CURRENT_WEEK_TS = "2024-03-05T09:00:00.000Z"; // Tue of the current week
// Tuesday of trailing week k (k=1 nearest) — one whole-week step apart.
const TRAILING_WEEK_TS = [
  "2024-02-27T09:00:00.000Z",
  "2024-02-20T09:00:00.000Z",
  "2024-02-13T09:00:00.000Z",
  "2024-02-06T09:00:00.000Z",
  "2024-01-30T09:00:00.000Z",
  "2024-01-23T09:00:00.000Z",
  "2024-01-16T09:00:00.000Z",
  "2024-01-09T09:00:00.000Z",
];

let turnSeq = 0;
function insTurn(
  ts: string,
  opts: { cost: number | null; cw?: number; cr?: number; provisional?: 0 | 1 } = { cost: 0 },
): void {
  turnSeq += 1;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?,?,?,?,?,0, 0,0,?, ?,0,0, NULL,'snap-sonnet',?,'LIST_EQUIV',?,'test-v1')`,
  ).run(
    `msg-wk-${turnSeq}`,
    "wk-sess",
    "wk-ws",
    ts,
    "claude-sonnet",
    opts.cr ?? 0,
    opts.cw ?? 0,
    opts.cost,
    opts.provisional ?? 0,
  );
}

describe("getWeeklySelfPercentile", () => {
  beforeEach(() => {
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
    ).run("wk-ws", "wk-ws", REFERENCE);
    db.prepare(
      `INSERT INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('wk-sess','wk-ws','/fake/wk.jsonl',?,?,'RECONCILED',1,0,'[]')`,
    ).run(CURRENT_WEEK_TS, CURRENT_WEEK_TS);
    turnSeq = 0;
  });

  it("reports the window metadata and honest ISO week start", () => {
    const result = getWeeklySelfPercentile(db, NOW);
    expect(result.week_start).toBe("2024-03-04T00:00:00.000Z");
    expect(result.trailing_weeks).toBe(8);
    expect(result.min_weeks_with_data).toBe(4);
  });

  it("withholds the spend percentile when no trailing weeks carry data", () => {
    insTurn(CURRENT_WEEK_TS, { cost: 500 });
    const { spend } = getWeeklySelfPercentile(db, NOW);
    expect(spend.this_week).toBe(500);
    expect(spend.percentile).toBeNull();
    expect(spend.n).toBe(0);
    expect(spend.trailing_median).toBeNull();
  });

  it("withholds the spend percentile below the four-week minimum", () => {
    insTurn(CURRENT_WEEK_TS, { cost: 500 });
    for (let k = 0; k < 3; k += 1) insTurn(TRAILING_WEEK_TS[k] as string, { cost: 100 * (k + 1) });
    const { spend } = getWeeklySelfPercentile(db, NOW);
    expect(spend.percentile).toBeNull();
    expect(spend.n).toBe(3);
    expect(spend.trailing_median).toBe(200);
  });

  it("ranks this week's spend against eight trailing weeks, ties at or below", () => {
    insTurn(CURRENT_WEEK_TS, { cost: 50 });
    const spends = [10, 20, 30, 40, 50, 60, 70, 80];
    spends.forEach((cost, k) => insTurn(TRAILING_WEEK_TS[k] as string, { cost }));
    const { spend } = getWeeklySelfPercentile(db, NOW);
    // {10,20,30,40,50} are <= 50 → 5 of 8; the trailing 50 tie counts.
    expect(spend.this_week).toBe(50);
    expect(spend.n).toBe(8);
    expect(spend.percentile).toBe(5 / 8);
    expect(spend.trailing_median).toBe(45); // (40+50)/2
  });

  it("withholds the percentile when the current week has no activity", () => {
    const spends = [10, 20, 30, 40];
    spends.forEach((cost, k) => insTurn(TRAILING_WEEK_TS[k] as string, { cost }));
    const { spend } = getWeeklySelfPercentile(db, NOW);
    expect(spend.this_week).toBeNull();
    expect(spend.percentile).toBeNull();
    expect(spend.n).toBe(4);
  });

  it("ranks cache-write share and excludes weeks with no cache activity", () => {
    // Current week: 300 write / 100 read → share 0.75.
    insTurn(CURRENT_WEEK_TS, { cost: 100, cw: 300, cr: 100 });
    // Four trailing weeks with cache activity, shares 0.2/0.4/0.6/0.8.
    const shares = [
      { cw: 20, cr: 80 }, // 0.2
      { cw: 40, cr: 60 }, // 0.4
      { cw: 60, cr: 40 }, // 0.6
      { cw: 80, cr: 20 }, // 0.8
    ];
    shares.forEach((s, k) =>
      insTurn(TRAILING_WEEK_TS[k] as string, { cost: 10, cw: s.cw, cr: s.cr }),
    );
    // Two trailing weeks with spend but NO cache activity → excluded from share n.
    insTurn(TRAILING_WEEK_TS[4] as string, { cost: 10 });
    insTurn(TRAILING_WEEK_TS[5] as string, { cost: 10 });

    const { cache_write_share, spend } = getWeeklySelfPercentile(db, NOW);
    expect(cache_write_share.this_week).toBe(0.75);
    expect(cache_write_share.n).toBe(4); // cache-bearing trailing weeks only
    // {0.2,0.4,0.6} <= 0.75 → 3 of 4.
    expect(cache_write_share.percentile).toBe(3 / 4);
    expect(cache_write_share.trailing_median).toBeCloseTo(0.5, 10);
    // Spend counts all six trailing weeks with turns.
    expect(spend.n).toBe(6);
  });

  it("ignores provisional turns", () => {
    insTurn(CURRENT_WEEK_TS, { cost: 50 });
    [10, 20, 30, 40].forEach((cost, k) => insTurn(TRAILING_WEEK_TS[k] as string, { cost }));
    // A provisional turn in a fifth trailing week must not add to n.
    insTurn(TRAILING_WEEK_TS[4] as string, { cost: 999, provisional: 1 });
    const { spend } = getWeeklySelfPercentile(db, NOW);
    expect(spend.n).toBe(4);
    expect(spend.percentile).toBe(4 / 4);
  });
});
