/**
 * State-machine + endpoint-model tests for getLimitsModel. Exclusive states
 * (audit §6 / spec §1) verified with injected readers; a fixture DB is set so
 * the live line and forecast reads resolve.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REF_PRICE_U_PER_TOKEN } from "../../../src/ingest/pricing.js";
import type { OAuthUsageResult } from "../../../src/oauth/usage.js";
import { resetQueryDb, setQueryDb } from "../../../src/query/db-context.js";
import { getLimitsModel } from "../../../src/query/limits/index.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";

const T0 = new Date("2026-09-14T00:00:00.000Z");
const H = 36e5;
const resetAfter = (hours: number) => new Date(T0.getTime() + hours * H).toISOString();
const reader = (r: OAuthUsageResult) => async () => r;

const okResult: OAuthUsageResult = {
  ok: true,
  data: {
    five_hour: { utilization: 0.33, resets_at: resetAfter(3.5) },
    seven_day: { utilization: 0.52, resets_at: resetAfter(70) },
    per_model: [{ model: "fable-5", utilization: 0.2 }],
  },
};

let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("getLimitsModel state machine", () => {
  it("connected: builds session + weekly + per-model rows, not stale", async () => {
    const m = await getLimitsModel({ reader: reader(okResult), now: T0, db });
    expect(m.state).toBe("connected");
    expect(m.stale).toBe(false);
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly", "weekly:fable-5"]);
    expect(m.rows[2]?.label).toBe("Weekly · Fable");
    expect(m.asOf).toBe(T0.toISOString());
    expect(typeof m.live.sessions).toBe("number");
    expect(typeof m.live.runningSpendUsd).toBe("number");
  });

  it("idle 5h window (resets_at null): connected, session row marked idle, weekly not", async () => {
    const m = await getLimitsModel({
      reader: reader({
        ok: true,
        data: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 0.94, resets_at: resetAfter(70) },
        },
      }),
      now: T0,
      db,
    });
    expect(m.state).toBe("connected");
    expect(m.rows[0]?.idle).toBe(true);
    expect(m.rows[0]?.usedPct).toBe(0);
    expect(m.rows[1]?.idle).toBeUndefined();
    expect(m.rows[1]?.resetsAt).toBe(resetAfter(70));
  });

  it("error state carries the reader's reason", async () => {
    const m = await getLimitsModel({
      reader: reader({ ok: false, reason: "oauth/usage returned an invalid seven_day." }),
      now: T0,
      db,
    });
    expect(m.state).toBe("error");
    expect(m.reason).toBe("oauth/usage returned an invalid seven_day.");
  });

  it("signed-out (401): empty rows, not stale, no retry", async () => {
    const m = await getLimitsModel({
      reader: reader({ ok: false, status: 401, reason: "x" }),
      now: T0,
      db,
    });
    expect(m.state).toBe("signed-out");
    expect(m.rows).toEqual([]);
    expect(m.stale).toBe(false);
    expect(m.retryInSec).toBeUndefined();
    expect(m.localHistory).toMatchObject({
      basis: "cap-weighted",
      fiveHourTokens: expect.any(Number),
      sevenDayTokens: expect.any(Number),
      weeklyLimitTokens: null,
      weeklyUtilizationPct: null,
    });
  });

  describe("local % of the weekly limit uses the limit's own reset window (REL-FIX 3)", () => {
    const D = 24 * H;
    const turn = (id: string, ts: Date, outputTokens: number) =>
      db
        .prepare(
          `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model,
            is_sidechain, input_tokens, output_tokens,
            cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
            tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
            provisional, parser_version)
           VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?)`,
        )
        .run(
          id,
          "sess-a1",
          "ws-alpha",
          ts.toISOString(),
          "claude-sonnet",
          0,
          0,
          outputTokens,
          0,
          0,
          0,
          0,
          null,
          "snap-sonnet",
          0,
          "LIST_EQUIV",
          0,
          "test-v1",
        );
    const config = (key: string, value: string) =>
      db
        .prepare(
          "INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value, T0.toISOString());
    const signedOut = reader({ ok: false, status: 401, reason: "x" });

    beforeEach(() => {
      // Live-DB shape: a heavy previous week, a light current one. The limit was
      // calibrated on the current window [resets_at - 7d, resets_at).
      turn("prev-week", new Date(T0.getTime() - 5 * D), 1_000_000);
      turn("this-week", new Date(T0.getTime() - 1 * D), 100_000);
      config("limit_tokens", "1000000");
      config("limit_provenance", "calibrated 2026-09-13 @ 10.0%; cap-weighted");
    });

    it("counts only the current window, not the trailing 7 days", async () => {
      config("limit_resets_at", new Date(T0.getTime() + 2.5 * D).toISOString());
      const m = await getLimitsModel({ reader: signedOut, now: T0, db });
      expect(m.localHistory?.sevenDayTokens).toBe(1_100_000);
      expect(m.localHistory?.weeklyUtilizationPct).toBeCloseTo(10, 5);
    });

    it("rolls a past resets_at forward by whole weeks", async () => {
      config("limit_resets_at", new Date(T0.getTime() - 4.5 * D).toISOString());
      const m = await getLimitsModel({ reader: signedOut, now: T0, db });
      expect(m.localHistory?.weeklyUtilizationPct).toBeCloseTo(10, 5);
    });
  });

  it("rate-limited (429): stale, default retry 240 when no Retry-After", async () => {
    const m = await getLimitsModel({
      reader: reader({ ok: false, status: 429, reason: "x" }),
      now: T0,
      db,
    });
    expect(m.state).toBe("rate-limited");
    expect(m.stale).toBe(true);
    expect(m.retryInSec).toBe(240);
  });

  it("rate-limited (429): honors numeric Retry-After", async () => {
    const m = await getLimitsModel({
      reader: reader({ ok: false, status: 429, reason: "x", retryAfterSec: 90 }),
      now: T0,
      db,
    });
    expect(m.retryInSec).toBe(90);
  });

  it("error (5xx) after a good read serves last-good rows, stale", async () => {
    await getLimitsModel({ reader: reader(okResult), now: T0, db });
    const m = await getLimitsModel({
      reader: reader({ ok: false, status: 503, reason: "x" }),
      now: T0,
      db,
    });
    expect(m.state).toBe("error");
    expect(m.stale).toBe(true);
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly", "weekly:fable-5"]);
  });
});

// OV-1: a restart is a fresh module (in-memory last-good gone); the DB carries it over.
describe("getLimitsModel last-good across a daemon restart (OV-1)", () => {
  async function restartedGetLimitsModel(): Promise<typeof getLimitsModel> {
    vi.resetModules();
    const ctx = await import("../../../src/query/db-context.js");
    ctx.setQueryDb(db);
    return (await import("../../../src/query/limits/index.js")).getLimitsModel;
  }
  const later = new Date(T0.getTime() + 2 * H);

  it("shows the last good rows, stale with the original asOf, when the first fetch after restart fails", async () => {
    await (await restartedGetLimitsModel())({ reader: reader(okResult), now: T0, db });

    const afterRestart = await restartedGetLimitsModel();
    const m = await afterRestart({
      reader: reader({ ok: false, status: 429, reason: "x" }),
      now: later,
      db,
    });
    expect(m.state).toBe("rate-limited");
    expect(m.stale).toBe(true);
    expect(m.asOf).toBe(T0.toISOString());
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly", "weekly:fable-5"]);
    expect(m.rows[0]?.usedPct).toBeCloseTo(33);
    expect(m.rows[1]?.usedPct).toBeCloseTo(52);
    // Same figures the card showed at fetch time (rows are computed at asOf, not now).
    const fresh = await (await restartedGetLimitsModel())({
      reader: reader(okResult),
      now: T0,
      db,
    });
    expect(m.rows[0]?.hoursUntilReset).toBeCloseTo(fresh.rows[0]?.hoursUntilReset ?? -1);
  });

  it("a later good fetch replaces the stored values", async () => {
    await (await restartedGetLimitsModel())({ reader: reader(okResult), now: T0, db });
    const newer: OAuthUsageResult = {
      ok: true,
      data: {
        five_hour: { utilization: 0.71, resets_at: resetAfter(4) },
        seven_day: { utilization: 0.6, resets_at: resetAfter(70) },
      },
    };
    const live = await (await restartedGetLimitsModel())({ reader: reader(newer), now: later, db });
    expect(live.state).toBe("connected");
    expect(live.stale).toBe(false);
    expect(live.rows[0]?.usedPct).toBeCloseTo(71);

    const afterRestart = await restartedGetLimitsModel();
    const m = await afterRestart({
      reader: reader({ ok: false, status: 503, reason: "x" }),
      now: later,
      db,
    });
    expect(m.state).toBe("error");
    expect(m.asOf).toBe(later.toISOString());
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly"]);
    expect(m.rows[0]?.usedPct).toBeCloseTo(71);
  });

  it("ignores a malformed stored value", async () => {
    db.prepare(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('usage_last_good', '{not json', ?)",
    ).run(T0.toISOString());
    const afterRestart = await restartedGetLimitsModel();
    const m = await afterRestart({
      reader: reader({ ok: false, status: 503, reason: "x" }),
      now: T0,
      db,
    });
    expect(m.state).toBe("error");
    expect(m.stale).toBe(false);
    expect(m.rows).toEqual([]);
  });
});

// OV-12 U1: implied weekly max = spend so far this limit week ÷ weekly % used.
describe("weeklyMax", () => {
  // Fresh module per test so in-memory last-good never leaks between cases.
  async function fresh(): Promise<typeof getLimitsModel> {
    vi.resetModules();
    const ctx = await import("../../../src/query/db-context.js");
    ctx.setQueryDb(db);
    return (await import("../../../src/query/limits/index.js")).getLimitsModel;
  }
  const RESET = resetAfter(70); // weekStart = T0 − 98h
  const WEEK_START = new Date(Date.parse(RESET) - 168 * H).toISOString();
  const at = (hours: number) => new Date(T0.getTime() + hours * H).toISOString();
  let n = 0;
  function turn(ts: string, model: string, costU: number, provisional = 0): void {
    n += 1;
    db.prepare(
      "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-ov12','ws-ov12',?)",
    ).run(WEEK_START);
    db.prepare(`INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
      VALUES ('s-ov12','ws-ov12','synthetic-not-a-transcript',?,?,'RECONCILED',1,0,'[]')`).run(
      WEEK_START,
      WEEK_START,
    );
    db.prepare(`INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, cost_claim, provisional, parser_version)
      VALUES (?, 's-ov12', 'ws-ov12', ?, ?, ?, 'LIST_EQUIV', ?, 'ov12-synthetic')`).run(
      `ov12-${n}`,
      ts,
      model,
      costU,
      provisional,
    );
  }
  const weekly = (pct: number, perModel?: { model: string; utilization: number }[]) =>
    reader({
      ok: true,
      data: {
        five_hour: { utilization: 0.1, resets_at: resetAfter(3) },
        seven_day: { utilization: pct / 100, resets_at: RESET },
        ...(perModel ? { per_model: perModel } : {}),
      },
    });

  it("known answer: $40 at 25% → $160 max, 80M Sonnet-equivalent tokens", async () => {
    const pre = db
      .prepare("SELECT COALESCE(SUM(cost_equiv_u),0) AS s FROM turns WHERE ts >= ? AND ts < ?")
      .get(WEEK_START, T0.toISOString()) as { s: number };
    expect(pre.s).toBe(0);
    turn(at(-50), "claude-sonnet-5", 25e6);
    turn(at(-10), "claude-sonnet-5", 15e6);
    const m = await (await fresh())({ reader: weekly(25), now: T0, db });
    expect(m.weeklyMax).toEqual({
      weekStart: WEEK_START,
      resetsAt: RESET,
      usedPct: 25,
      spendSoFarU: 40e6,
      impliedMaxSpendU: 160e6,
      impliedMaxPwTokens: 80e6,
      stale: false,
      state: "ok",
    });
  });

  it("counts provisional (in-progress) turns", async () => {
    turn(at(-5), "claude-sonnet-5", 30e6);
    turn(at(-1), "claude-sonnet-5", 10e6, 1);
    const m = await (await fresh())({ reader: weekly(25), now: T0, db });
    expect(m.weeklyMax?.spendSoFarU).toBe(40e6);
  });

  it("window is half-open [weekStart, asOf)", async () => {
    turn(WEEK_START, "claude-sonnet-5", 20e6);
    turn(new Date(Date.parse(WEEK_START) - 1).toISOString(), "claude-sonnet-5", 99e6);
    turn(T0.toISOString(), "claude-sonnet-5", 99e6);
    turn(at(1), "claude-sonnet-5", 99e6);
    const m = await (await fresh())({ reader: weekly(20), now: T0, db });
    expect(m.weeklyMax?.spendSoFarU).toBe(20e6);
  });

  it("stale: spend after the last-good asOf is excluded", async () => {
    const get = await fresh();
    turn(at(-10), "claude-sonnet-5", 40e6);
    await get({ reader: weekly(25), now: T0, db });
    turn(at(1), "claude-sonnet-5", 99e6);
    const m = await get({
      reader: reader({ ok: false, status: 429, reason: "x" }),
      now: new Date(at(2)),
      db,
    });
    expect(m.weeklyMax?.stale).toBe(true);
    expect(m.weeklyMax?.spendSoFarU).toBe(40e6);
  });

  it.each([
    [1.5, "too-early", null],
    [5, "low-confidence", 800e6],
    [10, "ok", 400e6],
  ] as const)("usedPct %s → %s", async (pct, state, max) => {
    turn(at(-10), "claude-sonnet-5", 40e6);
    const m = await (await fresh())({ reader: weekly(pct), now: T0, db });
    expect(m.weeklyMax?.state).toBe(state);
    expect(m.weeklyMax?.impliedMaxSpendU).toBe(max);
    expect(m.weeklyMax?.impliedMaxPwTokens).toBe(max === null ? null : max / 2);
  });

  it("zero local spend at ≥ 2% → unavailable, not a $0 max", async () => {
    const m = await (await fresh())({ reader: weekly(25), now: T0, db });
    expect(m.weeklyMax?.state).toBe("unavailable");
    expect(m.weeklyMax?.impliedMaxSpendU).toBeNull();
  });

  describe("unavailable", () => {
    const unavailable = {
      weekStart: null,
      resetsAt: null,
      usedPct: null,
      spendSoFarU: null,
      impliedMaxSpendU: null,
      impliedMaxPwTokens: null,
      stale: false,
      state: "unavailable",
    };
    beforeEach(() => turn(at(-10), "claude-sonnet-5", 40e6));

    it("signed-out", async () => {
      const m = await (await fresh())({
        reader: reader({ ok: false, status: 401, reason: "x" }),
        now: T0,
        db,
      });
      expect(m.weeklyMax).toEqual(unavailable);
    });

    it("error with no last-good", async () => {
      const m = await (await fresh())({
        reader: reader({ ok: false, status: 503, reason: "x" }),
        now: T0,
        db,
      });
      expect(m.weeklyMax).toEqual(unavailable);
    });

    it("weekly row idle", async () => {
      const m = await (await fresh())({
        reader: reader({
          ok: true,
          data: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 0.25, resets_at: null },
          },
        }),
        now: T0,
        db,
      });
      expect(m.weeklyMax).toEqual(unavailable);
    });

    it("resetsAt ≤ now", async () => {
      const m = await (await fresh())({
        reader: reader({
          ok: true,
          data: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 0.25, resets_at: T0.toISOString() },
          },
        }),
        now: T0,
        db,
      });
      expect(m.weeklyMax).toEqual(unavailable);
    });
  });

  it("stale in week → last-good values, stale: true; stale past reset → unavailable", async () => {
    turn(at(-10), "claude-sonnet-5", 40e6);
    const get = await fresh();
    await get({ reader: weekly(25), now: T0, db });
    const rl = reader({ ok: false, status: 429, reason: "x" });
    const inWeek = await get({ reader: rl, now: new Date(at(2)), db });
    expect(inWeek.weeklyMax).toMatchObject({
      usedPct: 25,
      impliedMaxSpendU: 160e6,
      stale: true,
      state: "ok",
    });
    const pastReset = await get({ reader: rl, now: new Date(at(71)), db });
    expect(pastReset.weeklyMax?.state).toBe("unavailable");
  });

  it("per-model: own max per family; a family with no local spend is unavailable", async () => {
    turn(at(-10), "claude-sonnet-5", 30e6);
    turn(at(-9), "claude-fable-5", 10e6);
    const m = await (await fresh())({
      reader: weekly(25, [
        { model: "fable-5", utilization: 0.2 },
        { model: "opus-5-5", utilization: 0.05 },
      ]),
      now: T0,
      db,
    });
    expect(m.weeklyMax?.spendSoFarU).toBe(40e6);
    expect(m.weeklyMax?.perModel).toEqual([
      {
        id: "weekly:fable-5",
        label: "Fable",
        usedPct: 20,
        impliedMaxSpendU: 50e6,
        impliedMaxPwTokens: 25e6,
        state: "ok",
      },
      {
        id: "weekly:opus-5-5",
        label: "Opus",
        usedPct: 5,
        impliedMaxSpendU: null,
        impliedMaxPwTokens: null,
        state: "unavailable",
      },
    ]);
  });

  it("no per-model rows → no perModel field", async () => {
    turn(at(-10), "claude-sonnet-5", 40e6);
    const m = await (await fresh())({ reader: weekly(25), now: T0, db });
    expect(m.weeklyMax?.perModel).toBeUndefined();
  });

  it("REF_PRICE_U_PER_TOKEN is the Sonnet 5 input price, 2 µUSD/token", () => {
    expect(REF_PRICE_U_PER_TOKEN).toBe(2);
  });
});
