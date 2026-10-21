/**
 * OV-7 — statusline fallback. When the usage API fails, getLimitsModel may read
 * ~/.agentwrangler/statusline-limits.json (written by the user's statusline script).
 * Rules under test: API ok ignores the file; failure + fresh file → statusline rows;
 * stale/malformed/rolled-over file → unavailable; newest of last-good vs file wins.
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
const reader = (r: OAuthUsageResult) => async () => r;
const fail: OAuthUsageResult = { ok: false, status: 503, reason: "down" };
const okResult: OAuthUsageResult = {
  ok: true,
  data: {
    five_hour: { utilization: 0.1, resets_at: new Date(T0.getTime() + 3 * H).toISOString() },
    seven_day: { utilization: 0.2, resets_at: new Date(T0.getTime() + 70 * H).toISOString() },
    per_model: [{ model: "fable-5", utilization: 0.2 }],
  },
};

let db: Database.Database;
let dir: string;
let file: string;

function payload(atMs: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    at: new Date(atMs).toISOString(),
    rate_limits: {
      five_hour: { used_percentage: 41, resets_at: Math.floor((T0.getTime() + 2 * H) / 1000) },
      seven_day: { used_percentage: 63, resets_at: Math.floor((T0.getTime() + 60 * H) / 1000) },
    },
    ...over,
  });
}

async function fresh() {
  vi.resetModules();
  const ctx = await import("../../../src/query/db-context.js");
  ctx.setQueryDb(db);
  return (await import("../../../src/query/limits/index.js")).getLimitsModel;
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-statusline-"));
  file = path.join(dir, "statusline-limits.json");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("statusline fallback in getLimitsModel", () => {
  it("API ok: source api, file ignored", async () => {
    fs.writeFileSync(file, payload(T0.getTime() - MIN));
    const get = await fresh();
    const m = await get({ reader: reader(okResult), now: T0, db, statuslinePath: file });
    expect(m.source).toBe("api");
    expect(m.rows[0]?.usedPct).toBeCloseTo(10);
    expect(m.rows.map((r) => r.id)).toContain("weekly:fable-5");
  });

  it("API fails + fresh file: statusline rows with pace, no per-model rows", async () => {
    fs.writeFileSync(file, payload(T0.getTime() - 5 * MIN));
    const get = await fresh();
    const m = await get({ reader: reader(fail), now: T0, db, statuslinePath: file });
    expect(m.source).toBe("statusline");
    expect(m.state).toBe("connected");
    expect(m.stale).toBe(false);
    expect(m.asOf).toBe(new Date(T0.getTime() - 5 * MIN).toISOString());
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly"]);
    expect(m.rows[0]?.usedPct).toBe(41);
    expect(m.rows[1]?.usedPct).toBe(63);
    expect(m.rows[0]?.hoursUntilReset).toBeCloseTo(2);
  });

  it("API fails + signed out (401) + fresh file: statusline rows", async () => {
    fs.writeFileSync(file, payload(T0.getTime() - MIN));
    const get = await fresh();
    const m = await get({
      reader: reader({ ok: false, status: 401, reason: "x" }),
      now: T0,
      db,
      statuslinePath: file,
    });
    expect(m.source).toBe("statusline");
  });

  it("API fails + stale file (over 30 min): unavailable", async () => {
    fs.writeFileSync(file, payload(T0.getTime() - 31 * MIN));
    const get = await fresh();
    const m = await get({ reader: reader(fail), now: T0, db, statuslinePath: file });
    expect(m.state).toBe("error");
    expect(m.rows).toEqual([]);
    expect(m.source).toBeUndefined();
  });

  it("malformed file: unavailable, no crash", async () => {
    for (const body of [
      "{not json",
      JSON.stringify({ at: "nope", rate_limits: {} }),
      JSON.stringify({
        at: T0.toISOString(),
        rate_limits: { five_hour: { used_percentage: "x" } },
      }),
    ]) {
      fs.writeFileSync(file, body);
      const get = await fresh();
      const m = await get({ reader: reader(fail), now: T0, db, statuslinePath: file });
      expect(m.state).toBe("error");
      expect(m.rows).toEqual([]);
    }
  });

  it("missing file: unavailable", async () => {
    const get = await fresh();
    const m = await get({ reader: reader(fail), now: T0, db, statuslinePath: file });
    expect(m.state).toBe("error");
  });

  it("file window already reset: unavailable (its percentage is from a rolled window)", async () => {
    fs.writeFileSync(
      file,
      payload(T0.getTime() - MIN, {
        rate_limits: {
          five_hour: { used_percentage: 90, resets_at: Math.floor((T0.getTime() - MIN) / 1000) },
          seven_day: { used_percentage: 10, resets_at: Math.floor((T0.getTime() + H) / 1000) },
        },
      }),
    );
    const get = await fresh();
    const m = await get({ reader: reader(fail), now: T0, db, statuslinePath: file });
    expect(m.state).toBe("error");
  });

  it("last-good newer than the file: last-good wins", async () => {
    const get = await fresh();
    await get({ reader: reader(okResult), now: new Date(T0.getTime() - MIN), db });
    fs.writeFileSync(file, payload(T0.getTime() - 10 * MIN));
    const m = await get({ reader: reader(fail), now: T0, db, statuslinePath: file });
    expect(m.source).not.toBe("statusline");
    expect(m.stale).toBe(true);
    expect(m.rows.map((r) => r.id)).toContain("weekly:fable-5");
  });

  it("file newer than last-good: statusline wins", async () => {
    const get = await fresh();
    await get({ reader: reader(okResult), now: new Date(T0.getTime() - 20 * MIN), db });
    fs.writeFileSync(file, payload(T0.getTime() - MIN));
    const m = await get({ reader: reader(fail), now: T0, db, statuslinePath: file });
    expect(m.source).toBe("statusline");
  });
});

describe("statusline status + snippet", () => {
  it("reports found / stale / not-set-up with age", async () => {
    const { getStatuslineStatus } = await import("../../../src/query/limits/statusline.js");
    expect(
      getStatuslineStatus({ path: file, now: T0, settingsPath: `${file}.no-settings.json` }).state,
    ).toBe("not-set-up");
    fs.writeFileSync(file, payload(T0.getTime() - 4 * MIN));
    expect(
      getStatuslineStatus({ path: file, now: T0, settingsPath: `${file}.no-settings.json` }),
    ).toMatchObject({
      state: "found",
      ageSec: 240,
    });
    fs.writeFileSync(file, payload(T0.getTime() - 2 * H));
    expect(
      getStatuslineStatus({ path: file, now: T0, settingsPath: `${file}.no-settings.json` }).state,
    ).toBe("stale");
    fs.writeFileSync(file, "garbage");
    expect(
      getStatuslineStatus({ path: file, now: T0, settingsPath: `${file}.no-settings.json` }).state,
    ).toBe("not-set-up");
  });

  it("the copy-line snippet is the CLI command; the file it writes is one the reader accepts", async () => {
    const { STATUSLINE_SNIPPET, readStatuslineLimits } = await import(
      "../../../src/query/limits/statusline.js"
    );
    const { runStatusline } = await import("../../../src/cli/statusline.js");
    expect(STATUSLINE_SNIPPET).toBe("agentwrangler statusline");
    const home = dir;
    const nowSec = Math.floor(Date.now() / 1000);
    runStatusline({
      stdin: JSON.stringify({
        model: { display_name: "x" },
        rate_limits: {
          five_hour: { used_percentage: 12.5, resets_at: nowSec + 7200, extra: "drop" },
          seven_day: { used_percentage: 40, resets_at: nowSec + 86400 },
        },
      }),
      home,
      nowMs: Date.now(),
    });
    const written = path.join(home, ".agentwrangler", "statusline-limits.json");
    const raw = fs.readFileSync(written, "utf8");
    expect(raw).not.toContain("drop");
    expect(raw).not.toContain("display_name");
    const parsed = readStatuslineLimits({ path: written, now: new Date() });
    expect(parsed?.five_hour.usedPct).toBe(12.5);
  });
});
