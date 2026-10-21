/**
 * OV-12 U5 — per-week implied max from limit_snapshots + turns. Weeks group by resets_at rounded to
 * the hour; a week's max comes from its last reading ≥ 10%; spread from its readings ≥ 50%; a
 * statusline reading within an hour of an api reading is dropped. The first case mirrors the live
 * 2026-10-04 table (spec Evidence: $1,130 / $1,180 / $1,156).
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthUsageResult } from "../../../src/oauth/usage.js";
import { computeLimitHistory, computeWeightFit } from "../../../src/query/limits/history.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";

const D = 864e5;
const R1 = "2026-09-18T06:00:00.130Z";
const R2 = "2026-09-25T05:59:59.683Z";
const R4 = "2026-10-09T05:59:59.860Z"; // current week (week to Oct 2 has no reading)
const iso = (ms: number) => new Date(ms).toISOString();

let db: Database.Database;
let n = 0;
function turn(ts: string, costU: number, model = "claude-opus-5-5"): void {
  n += 1;
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-u5','ws-u5','2026-01-01T00:00:00Z')",
  ).run();
  db.prepare(`INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('s-u5','ws-u5','synthetic-not-a-transcript','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','RECONCILED',1,0,'[]')`).run();
  db.prepare(`INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, cost_claim, provisional, parser_version)
    VALUES (?, 's-u5', 'ws-u5', ?, ?, ?, 'LIST_EQUIV', 0, 'u5-synthetic')`).run(
    `u5-${n}`,
    ts,
    model,
    costU,
  );
}
function snap(ts: string, resetsAt: string, pct: number, source: string): void {
  db.prepare(
    "INSERT INTO limit_snapshots (ts, resets_at, used_pct, source) VALUES (?, ?, ?, ?)",
  ).run(ts, resetsAt, pct, source);
}
/** The live 2026-10-04 table, with turns that reproduce its implied maxes. */
function seedLive(): void {
  turn("2026-09-12T00:00:00.000Z", 226e6);
  turn("2026-09-15T00:00:00.000Z", 500e6); // after the 20% reading: not in its max
  turn("2026-09-20T00:00:00.000Z", 932e6);
  turn("2026-09-24T00:00:00.000Z", 224e6);
  turn("2026-10-03T00:00:00.000Z", 96e6);
  snap("2026-09-12T07:01:45.382Z", R1, 20, "calibration-backup");
  snap("2026-09-23T21:10:17.789Z", R2, 79, "calibration-backup");
  snap("2026-09-24T21:08:53.000Z", "2026-09-25T05:59:59.683Z", 100, "limit-hit");
  snap("2026-10-04T18:55:38.341Z", R4, 7, "api");
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare("DELETE FROM limit_snapshots").run();
});
afterEach(() => db.close());

describe("computeLimitHistory", () => {
  it("live table → 2 weeks newest first, gap week absent, under-10% week absent", () => {
    seedLive();
    const { history, noisePct } = computeLimitHistory(db, R4);
    expect(history.map((h) => h.resetsAt)).toEqual([
      "2026-09-25T06:00:00.000Z",
      "2026-09-18T06:00:00.000Z",
    ]);
    expect(history[0]).toMatchObject({
      impliedMaxSpendU: 1156e6,
      impliedMaxPwTokens: 578e6,
      usedPctAtSample: 100,
      source: "limit-hit",
      spread: { readings: 2, minSpendU: 1156e6 },
    });
    expect(history[0]?.spread?.maxSpendU).toBeCloseTo(932e6 / 0.79, 0);
    expect(history[0]?.spread?.pct).toBeCloseTo(2.05, 2);
    expect(history[1]).toMatchObject({ impliedMaxSpendU: 1130e6, usedPctAtSample: 20 });
    expect(history[1]?.spread).toBeUndefined();
    expect(noisePct).toBe(3); // 2.05% spread < 3% floor
  });

  it("noise band = the largest same-week spread above the floor, from readings ≥ 50% only", () => {
    turn("2026-09-19T00:00:00.000Z", 500e6);
    turn("2026-09-22T00:00:00.000Z", 100e6);
    snap("2026-09-19T12:00:00.000Z", R2, 12, "api"); // $500 ÷ 12% = $4,167: ignored for spread
    snap("2026-09-21T00:00:00.000Z", R2, 50, "api"); // $1,000
    snap("2026-09-23T00:00:00.000Z", R2, 55, "api"); // $1,091
    const { history, noisePct } = computeLimitHistory(db, R4);
    expect(history[0]?.spread?.readings).toBe(2);
    expect(noisePct).toBeCloseTo(((600 / 0.55 - 1000) / 1000) * 100, 6);
  });

  it("drops a statusline reading within an hour of an api reading; keeps one further away", () => {
    turn("2026-09-20T00:00:00.000Z", 600e6);
    snap("2026-09-21T00:00:00.000Z", R2, 60, "api");
    snap("2026-09-21T00:20:00.000Z", R2, 58, "statusline");
    expect(computeLimitHistory(db, R4).history[0]).toMatchObject({
      source: "api",
      usedPctAtSample: 60,
    });
    snap("2026-09-21T03:00:00.000Z", R2, 61, "statusline");
    expect(computeLimitHistory(db, R4).history[0]).toMatchObject({
      source: "statusline",
      usedPctAtSample: 61,
    });
  });

  it("keeps only the 11 weeks before the current one", () => {
    const cur = Date.parse(R4);
    for (const k of [1, 11, 12]) {
      const reset = cur - k * 7 * D;
      turn(iso(reset - 3 * D), 300e6);
      snap(iso(reset - 2 * D), iso(reset), 30, "api");
    }
    expect(computeLimitHistory(db, R4).history.map((h) => Date.parse(h.resetsAt))).toEqual([
      cur - 7 * D + 140, // rounded to the hour
      cur - 77 * D + 140,
    ]);
  });

  it("a new snapshot refreshes the memo", () => {
    seedLive();
    expect(computeLimitHistory(db, R4).history).toHaveLength(2);
    turn("2026-10-01T00:00:00.000Z", 400e6);
    snap("2026-10-01T12:00:00.000Z", "2026-10-02T06:00:00.000Z", 40, "api");
    expect(computeLimitHistory(db, R4).history).toHaveLength(3);
  });
});

describe("computeWeightFit", () => {
  it("counts readings ≥ 10% across weeks; the live table is not enough yet", () => {
    seedLive();
    expect(computeWeightFit(db)).toMatchObject({ readings: 3, weeks: 2, ready: false });
  });
});

describe("weeklyMax.vsLastWeek (getLimitsModel)", () => {
  const T = new Date("2026-10-06T12:00:00.000Z");
  const reader = (pct: number) => async (): Promise<OAuthUsageResult> => ({
    ok: true,
    data: {
      five_hour: { utilization: 0.1, resets_at: "2026-10-06T15:00:00.000Z" },
      seven_day: { utilization: pct / 100, resets_at: R4 },
    },
  });
  async function get(pct: number) {
    vi.resetModules();
    (await import("../../../src/query/db-context.js")).setQueryDb(db);
    const { getLimitsModel } = await import("../../../src/query/limits/index.js");
    return (await getLimitsModel({ reader: reader(pct), now: T, db })).weeklyMax;
  }

  it("clear change: $1,290 vs the week to Sep 24's $1,156 (+11.6%), names that week", async () => {
    seedLive();
    turn("2026-10-05T00:00:00.000Z", 645e6 - 96e6);
    const wm = await get(50);
    expect(wm?.history).toHaveLength(2);
    expect(wm?.vsLastWeek).toMatchObject({
      clear: true,
      resetsAt: "2026-09-25T06:00:00.000Z",
      impliedMaxSpendU: 1156e6,
    });
    expect(wm?.vsLastWeek?.pct).toBeCloseTo(((1290 - 1156) / 1156) * 100, 6);
  });

  it("change inside the noise band → clear: false", async () => {
    seedLive();
    turn("2026-10-05T00:00:00.000Z", 585e6 - 96e6); // $1,170 at 50% (+1.2%)
    expect((await get(50))?.vsLastWeek?.clear).toBe(false);
  });

  it("this week under 10% → no comparison; no past weeks → no history fields", async () => {
    seedLive();
    expect((await get(7))?.vsLastWeek).toBeUndefined();
    db.prepare("DELETE FROM limit_snapshots").run();
    const wm = await get(50);
    expect(wm?.history).toBeUndefined();
    expect(wm?.noisePct).toBeUndefined();
  });
});
