/**
 * P1-U7 (A-13): the default-path limits GET never waits on upstream once a memo exists.
 * An expired memo is served at once and exactly one background refresh replaces it.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthUsageResult } from "../../../src/oauth/usage.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";

const upstream = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../../src/oauth/usage.js", () => ({
  noUsageApi: () => upstream.fn(),
}));

const T0 = new Date("2026-09-14T00:00:00.000Z");
const ok = (fiveHour: number): OAuthUsageResult => ({
  ok: true,
  data: {
    five_hour: { utilization: fiveHour, resets_at: "2026-09-14T03:00:00.000Z" },
    seven_day: { utilization: 0.5, resets_at: "2026-09-17T00:00:00.000Z" },
    per_model: [],
  },
});

let db: Database.Database;
let getLimitsModel: typeof import("../../../src/query/limits/index.js").getLimitsModel;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.resetModules();
  upstream.fn.mockReset();
  db = createInMemoryFixtureDb();
  (await import("../../../src/query/db-context.js")).setQueryDb(db);
  ({ getLimitsModel } = await import("../../../src/query/limits/index.js"));
});
afterEach(async () => {
  (await import("../../../src/query/db-context.js")).resetQueryDb();
  db.close();
  vi.useRealTimers();
});

const sessionPct = (m: Awaited<ReturnType<typeof getLimitsModel>>) =>
  m.rows.find((r) => r.id === "session")?.usedPct;

describe("limits GET off the upstream path (P1-U7)", () => {
  it("the first GET after boot fetches once; a memo newer than 30 s makes 0 more calls", async () => {
    upstream.fn.mockResolvedValue(ok(0.3));
    expect(sessionPct(await getLimitsModel())).toBeCloseTo(30);
    vi.setSystemTime(T0.getTime() + 29_000);
    await getLimitsModel();
    expect(upstream.fn).toHaveBeenCalledTimes(1);
  });

  it("an expired memo is served at once; 5 concurrent GETs make exactly 1 upstream call", async () => {
    upstream.fn.mockResolvedValueOnce(ok(0.3));
    await getLimitsModel();

    let release: (r: OAuthUsageResult) => void = () => {};
    upstream.fn.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    vi.setSystemTime(T0.getTime() + 61_000);
    // Upstream is still pending, so these resolve only if they don't wait on it.
    const served = await Promise.all(Array.from({ length: 5 }, () => getLimitsModel()));
    expect(served.map(sessionPct)).toEqual([30, 30, 30, 30, 30].map((n) => expect.closeTo(n)));
    expect(upstream.fn).toHaveBeenCalledTimes(2);

    release(ok(0.4));
    await vi.waitFor(async () => expect(sessionPct(await getLimitsModel())).toBeCloseTo(40));
    expect(upstream.fn).toHaveBeenCalledTimes(2);
  });

  it("a failed background refresh serves last-good rows (stale) and a later GET retries", async () => {
    upstream.fn.mockResolvedValueOnce(ok(0.3));
    await getLimitsModel();
    vi.setSystemTime(T0.getTime() + 61_000);
    upstream.fn.mockRejectedValueOnce(new Error("network"));
    expect(sessionPct(await getLimitsModel())).toBeCloseTo(30);
    await vi.waitFor(async () => expect((await getLimitsModel()).state).toBe("error"));
    const failed = await getLimitsModel();
    expect(failed.stale).toBe(true);
    expect(sessionPct(failed)).toBeCloseTo(30);

    upstream.fn.mockResolvedValue(ok(0.4));
    vi.setSystemTime(T0.getTime() + 92_000);
    await vi.waitFor(async () => expect(sessionPct(await getLimitsModel())).toBeCloseTo(40));
    expect(upstream.fn).toHaveBeenCalledTimes(3);
  });
});
