/**
 * OV-12 Phase 2 U4 — limit_snapshots forward writes. One row per good (connected, non-stale)
 * weekly read, at most one per hour per source; the throttle is read from the DB so it holds
 * across a daemon restart. Only timestamps + percentages are stored (no token or $ sums).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthUsageResult } from "../../../src/oauth/usage.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";

const T0 = new Date("2026-09-14T12:00:00.000Z");
const MIN = 60_000;
const H = 36e5;
const at = (ms: number) => new Date(T0.getTime() + ms);
const reader = (r: OAuthUsageResult) => async () => r;
const RESETS = new Date(T0.getTime() + 70 * H).toISOString();
const ok = (u: number): OAuthUsageResult => ({
  ok: true,
  data: {
    five_hour: { utilization: 0.1, resets_at: new Date(T0.getTime() + 3 * H).toISOString() },
    seven_day: { utilization: u, resets_at: RESETS },
  },
});

let db: Database.Database;
let dir: string;

/** A fresh module graph = a daemon restart (in-memory state gone, DB kept). */
async function fresh() {
  vi.resetModules();
  const ctx = await import("../../../src/query/db-context.js");
  ctx.setQueryDb(db);
  return (await import("../../../src/query/limits/index.js")).getLimitsModel;
}
const rows = () =>
  db.prepare("SELECT ts, resets_at, used_pct, source FROM limit_snapshots ORDER BY ts").all() as {
    ts: string;
    resets_at: string;
    used_pct: number;
    source: string;
  }[];

beforeEach(() => {
  db = createInMemoryFixtureDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-snap-"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("limit_snapshots", () => {
  it("table holds only ts, resets_at, used_pct, source", () => {
    const cols = (db.prepare("PRAGMA table_info(limit_snapshots)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(["ts", "resets_at", "used_pct", "source"]);
  });

  it("api read writes one row: asOf, weekly reset, weekly %", async () => {
    const get = await fresh();
    await get({ reader: reader(ok(0.52)), now: T0, db });
    expect(rows()).toEqual([
      { ts: T0.toISOString(), resets_at: RESETS, used_pct: 52, source: "api" },
    ]);
  });

  it("normalizes the API's reset text and percentage float noise", async () => {
    const get = await fresh();
    await get({
      reader: reader({
        ok: true,
        data: {
          five_hour: { utilization: 0.1, resets_at: null },
          seven_day: { utilization: 0.07, resets_at: "2026-09-17T05:59:59.860652+00:00" },
        },
      }),
      now: T0,
      db,
    });
    expect(rows()[0]).toMatchObject({ resets_at: "2026-09-17T05:59:59.860Z", used_pct: 7 });
  });

  it("at most one row per hour per source", async () => {
    const get = await fresh();
    await get({ reader: reader(ok(0.5)), now: T0, db });
    await get({ reader: reader(ok(0.51)), now: at(30 * MIN), db });
    expect(rows()).toHaveLength(1);
    await get({ reader: reader(ok(0.53)), now: at(61 * MIN), db });
    expect(rows().map((r) => r.used_pct)).toEqual([50, 53]);
  });

  it("throttle survives a restart", async () => {
    await (await fresh())({ reader: reader(ok(0.5)), now: T0, db });
    await (await fresh())({ reader: reader(ok(0.51)), now: at(10 * MIN), db });
    expect(rows()).toHaveLength(1);
  });

  it("failed read with last-good (stale) writes nothing new", async () => {
    const get = await fresh();
    await get({ reader: reader(ok(0.5)), now: T0, db });
    await get({
      reader: reader({ ok: false, status: 503, reason: "down" }),
      now: at(2 * H),
      db,
      statuslinePath: path.join(dir, "missing.json"),
    });
    expect(rows()).toHaveLength(1);
  });

  it("statusline fallback writes source 'statusline'", async () => {
    const file = path.join(dir, "statusline-limits.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        at: new Date(T0.getTime() - 5 * MIN).toISOString(),
        rate_limits: {
          five_hour: { used_percentage: 41, resets_at: Math.floor((T0.getTime() + 2 * H) / 1000) },
          seven_day: { used_percentage: 63, resets_at: Math.floor((T0.getTime() + 60 * H) / 1000) },
        },
      }),
    );
    const get = await fresh();
    await get({
      reader: reader({ ok: false, status: 503, reason: "down" }),
      now: T0,
      db,
      statuslinePath: file,
    });
    expect(rows()).toEqual([
      {
        ts: new Date(T0.getTime() - 5 * MIN).toISOString(),
        resets_at: new Date(Math.floor((T0.getTime() + 60 * H) / 1000) * 1000).toISOString(),
        used_pct: 63,
        source: "statusline",
      },
    ]);
  });

  it("idle weekly window (no reset) writes nothing", async () => {
    const get = await fresh();
    await get({
      reader: reader({
        ok: true,
        data: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 0, resets_at: null },
        },
      }),
      now: T0,
      db,
    });
    expect(rows()).toHaveLength(0);
  });
});
