/**
 * USAGE-CLI — spec criterion 2 (a hanging spawn never blocks a GET) and the source merge in getLimitsModel
 * (statusline vs stored CLI reading, per-model rows, stale, off, failure reasons, pending).
 * No real `claude` is ever spawned.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSpawn, CliUsageState } from "../../../src/query/limits/cli-usage.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";

const T0 = new Date("2026-10-20T16:00:00.000Z");
const MIN = 60_000;
const H = 36e5;
const iso = (ms: number) => new Date(ms).toISOString();

let db: Database.Database;
let dir: string;
let stateDir: string;
let slFile: string;
let spawnCalls: string[][];

const failSpawn: CliSpawn = async (_c, argv) => {
  spawnCalls.push(argv);
  return { code: 1, stdout: "" };
};

async function load() {
  vi.resetModules();
  const ctx = await import("../../../src/query/db-context.js");
  ctx.setQueryDb(db);
  const cli = await import("../../../src/query/limits/cli-usage.js");
  cli._resetCliRefresher();
  const idx = await import("../../../src/query/limits/index.js");
  return { get: idx.getLimitsModel, cli };
}

function writeState(s: CliUsageState) {
  fs.writeFileSync(path.join(stateDir, "usage-cli.json"), JSON.stringify(s));
}

/** A CLI reading taken `agoMin` before T0; `weeklyResetH` hours after T0. */
function reading(agoMin: number, over: { fiveH?: number; weeklyResetH?: number } = {}) {
  return {
    asOf: iso(T0.getTime() - agoMin * MIN),
    data: {
      five_hour: { utilization: 0.07, resets_at: iso(T0.getTime() + (over.fiveH ?? 1) * H) },
      seven_day: {
        utilization: 0.32,
        resets_at: iso(T0.getTime() + (over.weeklyResetH ?? 60) * H),
      },
      per_model: [{ model: "fable", utilization: 0.11 }],
    },
  };
}

/** State that blocks any new call (recent attempt) so the GET only reads. */
const quiet = (extra: Partial<CliUsageState> = {}): CliUsageState => ({
  lastAttemptAt: iso(T0.getTime() - MIN),
  outcome: "ok",
  backoffStep: 0,
  ...extra,
});

function writeStatusline(agoMin: number, weeklyResetH = 60) {
  fs.writeFileSync(
    slFile,
    JSON.stringify({
      at: iso(T0.getTime() - agoMin * MIN),
      rate_limits: {
        five_hour: { used_percentage: 41, resets_at: Math.floor((T0.getTime() + 2 * H) / 1000) },
        seven_day: {
          used_percentage: 63,
          resets_at: Math.floor((T0.getTime() + weeklyResetH * H) / 1000),
        },
      },
    }),
  );
}

const opts = (over: { enabled?: boolean; spawn?: CliSpawn } = {}) => ({
  now: T0,
  db,
  statuslinePath: slFile,
  cli: { stateDir, enabled: over.enabled ?? true, spawn: over.spawn ?? failSpawn },
});

beforeEach(() => {
  db = createInMemoryFixtureDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-usage-merge-"));
  stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  slFile = path.join(dir, "statusline-limits.json");
  spawnCalls = [];
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("criterion 2: a hanging spawn never blocks the GET", () => {
  it("returns promptly with pending:true and does not await the spawn", async () => {
    const { get, cli } = await load();
    let release: (v: { code: number; stdout: string }) => void = () => {};
    let spawned = 0;
    const hang: CliSpawn = () => {
      spawned++;
      return new Promise((r) => {
        release = r;
      });
    };
    const t = performance.now();
    const m = await get(opts({ spawn: hang }));
    const elapsed = performance.now() - t;
    expect(elapsed).toBeLessThan(250);
    expect(m.pending).toBe(true);
    expect(spawned).toBe(1);
    expect(cli.cliCallInFlight()).toBe(true);
    // Release and let the background call finish so no temp dir or lock leaks.
    release({ code: 1, stdout: "" });
    await vi.waitFor(() => expect(cli.cliCallInFlight()).toBe(false));
  });
});

describe("source merge", () => {
  it("CLI newer than statusline: source cli, CLI values and per-model rows", async () => {
    writeStatusline(10);
    writeState(quiet({ reading: reading(2) }));
    const { get } = await load();
    const m = await get(opts());
    expect(m.state).toBe("connected");
    expect(m.source).toBe("cli");
    expect(m.asOf).toBe(iso(T0.getTime() - 2 * MIN));
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly", "weekly:fable"]);
    expect(m.rows[0]?.usedPct).toBeCloseTo(7);
    expect(m.rows[1]?.usedPct).toBeCloseTo(32);
    expect(m.rows[2]?.usedPct).toBeCloseTo(11);
    expect(m.stale).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it("statusline newer, weekly resets within ±1 h: statusline values + CLI per-model rows with per-row source/asOf", async () => {
    writeStatusline(1, 60);
    writeState(quiet({ reading: reading(10, { weeklyResetH: 60.5 }) }));
    const { get } = await load();
    const m = await get(opts());
    expect(m.source).toBe("statusline");
    expect(m.asOf).toBe(iso(T0.getTime() - MIN));
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly", "weekly:fable"]);
    expect(m.rows[0]?.usedPct).toBe(41);
    expect(m.rows[1]?.usedPct).toBe(63);
    expect(m.rows[2]?.usedPct).toBeCloseTo(11);
    const [s, w, f] = m.rows;
    expect(s?.source).toBe("statusline");
    expect(w?.source).toBe("statusline");
    expect(s?.asOf).toBe(iso(T0.getTime() - MIN));
    expect(f?.source).toBe("cli");
    expect(f?.asOf).toBe(iso(T0.getTime() - 10 * MIN));
  });

  it("statusline newer, weekly resets exactly 1 h apart: still the same window", async () => {
    writeStatusline(1, 60);
    writeState(quiet({ reading: reading(10, { weeklyResetH: 61 }) }));
    const { get } = await load();
    const m = await get(opts());
    expect(m.rows.map((r) => r.id)).toContain("weekly:fable");
  });

  it("statusline newer, weekly resets > 1 h apart: no per-model rows", async () => {
    writeStatusline(1, 60);
    writeState(quiet({ reading: reading(10, { weeklyResetH: 62 }) }));
    const { get } = await load();
    const m = await get(opts());
    expect(m.source).toBe("statusline");
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly"]);
  });

  it("CLI reading older than 60 min is stale; 59 min is not", async () => {
    writeState(quiet({ reading: reading(61) }));
    let { get } = await load();
    let m = await get(opts());
    expect(m.source).toBe("cli");
    expect(m.stale).toBe(true);
    writeState(quiet({ reading: reading(59) }));
    ({ get } = await load());
    m = await get(opts());
    expect(m.stale).toBe(false);
  });

  it("a passed window reads 0% / idle with no new call", async () => {
    const r = reading(5);
    r.data.five_hour.resets_at = iso(T0.getTime() - MIN);
    writeState(quiet({ reading: r }));
    const { get } = await load();
    const m = await get(opts());
    const session = m.rows.find((x) => x.id === "session");
    expect(session?.usedPct).toBe(0);
    expect(session?.idle).toBe(true);
    expect(m.rows.find((x) => x.id === "weekly")?.usedPct).toBeCloseTo(32);
    expect(spawnCalls).toHaveLength(0);
  });

  it("a passed weekly window zeroes weekly and the per-model rows", async () => {
    const r = reading(5);
    r.data.seven_day.resets_at = iso(T0.getTime() - MIN);
    writeState(quiet({ reading: r }));
    const { get } = await load();
    const m = await get(opts());
    expect(m.rows.find((x) => x.id === "weekly")?.idle).toBe(true);
    expect(m.rows.find((x) => x.id === "weekly:fable")?.usedPct).toBe(0);
  });

  it("enabled:false: the stored reading is ignored, cliReason is off, no spawn", async () => {
    writeState(quiet({ reading: reading(2) }));
    const { get } = await load();
    const m = await get(opts({ enabled: false }));
    expect(m.source).not.toBe("cli");
    expect(m.rows).toEqual([]);
    expect(m.cliReason).toBe("off");
    expect(m.pending).toBeUndefined();
    expect(spawnCalls).toHaveLength(0);
  });

  it("enabled:false with a fresh statusline: statusline rows, no CLI per-model rows", async () => {
    writeStatusline(1);
    writeState(quiet({ reading: reading(2) }));
    const { get } = await load();
    const m = await get(opts({ enabled: false }));
    expect(m.source).toBe("statusline");
    expect(m.rows.map((r) => r.id)).toEqual(["session", "weekly"]);
  });

  it.each(["not_found", "outdated", "timeout", "parse", "error"] as const)(
    "failure outcome %s with no reading: cliReason is the enum value",
    async (reason) => {
      writeState(quiet({ outcome: reason, backoffStep: 1 }));
      const { get } = await load();
      const m = await get(opts());
      expect(m.cliReason).toBe(reason);
      expect(m.rows).toEqual([]);
      expect(spawnCalls).toHaveLength(0);
    },
  );

  it("guard-tripped: cliReason guard", async () => {
    writeState(
      quiet({
        outcome: "guard",
        guardTrippedVersion: "2.1.304",
        versionCheckedAt: iso(T0.getTime() - MIN),
      }),
    );
    const { get } = await load();
    const m = await get(opts());
    expect(m.cliReason).toBe("guard");
  });

  it("failure with an old reading: reading still served, reason shown", async () => {
    writeState(quiet({ outcome: "timeout", backoffStep: 1, reading: reading(30) }));
    const { get } = await load();
    const m = await get(opts());
    expect(m.source).toBe("cli");
    expect(m.cliReason).toBe("timeout");
    expect(m.rows.map((r) => r.id)).toContain("weekly:fable");
  });

  it("healthy: no cliReason", async () => {
    writeState(quiet({ reading: reading(2) }));
    const { get } = await load();
    expect((await get(opts())).cliReason).toBeUndefined();
  });
});

describe("pending and the response memo", () => {
  it("pending while the first call runs; cleared (memo dropped) once the call lands", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { get, cli } = await load();
    let release: (v: { code: number; stdout: string }) => void = () => {};
    const text = [
      "Current session: 7% used · resets Oct 20, 12:49pm (America/Los_Angeles)",
      "Current week (all models): 32% used · resets Oct 22, 10:59pm (America/Los_Angeles)",
      "Current week (Fable): 0% used · resets Oct 22, 11pm (America/Los_Angeles)",
    ].join("\n");
    const spawn: CliSpawn = async (_c, argv) => {
      spawnCalls.push(argv);
      return new Promise((r) => {
        release = r;
      });
    };
    // No now/db/reader → the default path with the 30 s memo.
    const o = { statuslinePath: slFile, cli: { stateDir, enabled: true, spawn } };
    const first = await get(o);
    expect(first.pending).toBe(true);
    expect(first.source).toBeUndefined();
    const second = await get(o); // memo
    expect(second.pending).toBe(true);
    expect(spawnCalls).toHaveLength(1);

    release({
      code: 0,
      stdout: JSON.stringify({ num_turns: 0, total_cost_usd: 0, is_error: false, result: text }),
    });
    await vi.waitFor(() => expect(cli.cliCallInFlight()).toBe(false));

    const third = await get(o); // memo was dropped when the call landed
    expect(third.pending).toBeUndefined();
    expect(third.source).toBe("cli");
    expect(third.rows.map((r) => r.id)).toEqual(["session", "weekly", "weekly:fable"]);
    expect(third.rows[0]?.usedPct).toBeCloseTo(7);
    expect(spawnCalls).toHaveLength(1);
  });

  it("a memo hit still starts the call once it is allowed, not at the next memo expiry", async () => {
    // Live-demo bug: the GET only kicked the refresher when it recomputed, so with a memo in place the
    // first call waited out the 30 s TTL (here: another process held the lock on the first GET).
    const lock = path.join(stateDir, "usage-cli.lock");
    fs.writeFileSync(lock, "other-daemon");
    const { get, cli } = await load();
    let release: (v: { code: number; stdout: string }) => void = () => {};
    const spawn: CliSpawn = async (_c, argv) => {
      spawnCalls.push(argv);
      return new Promise((r) => {
        release = r;
      });
    };
    const o = { statuslinePath: slFile, cli: { stateDir, enabled: true, spawn } };
    const first = await get(o);
    expect(spawnCalls).toHaveLength(0);
    expect(first.pending).toBe(true);

    fs.rmSync(lock);
    const second = await get(o); // within the 30 s memo
    expect(spawnCalls).toHaveLength(1);
    expect(second.pending).toBe(true);

    release({ code: 1, stdout: "" });
    await vi.waitFor(() => expect(cli.cliCallInFlight()).toBe(false));
  });

  it("a background refresh that overlaps the call's finish does not memo the pre-call model", async () => {
    // Race: the memo expires mid-call, the refresh reads the pre-call state, the call lands, then the
    // refresh would write that pre-call model over the dropped memo for another 30 s.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let gate: Promise<void> | null = null;
    vi.doMock("../../../src/oauth/usage.js", async (orig) => ({
      ...(await orig<typeof import("../../../src/oauth/usage.js")>()),
      noUsageApi: async () => {
        if (gate !== null) await gate;
        return { ok: false, reason: "no usage api" };
      },
    }));
    try {
      const { get, cli } = await load();
      let release: (v: { code: number; stdout: string }) => void = () => {};
      const text = [
        "Current session: 7% used · resets Oct 20, 12:49pm (America/Los_Angeles)",
        "Current week (all models): 32% used · resets Oct 22, 10:59pm (America/Los_Angeles)",
        "Current week (Fable): 0% used · resets Oct 22, 11pm (America/Los_Angeles)",
      ].join("\n");
      const spawn: CliSpawn = async (_c, argv) => {
        spawnCalls.push(argv);
        return new Promise((r) => {
          release = r;
        });
      };
      const o = { statuslinePath: slFile, cli: { stateDir, enabled: true, spawn } };
      expect((await get(o)).pending).toBe(true);

      vi.setSystemTime(T0.getTime() + 31_000); // memo expired, call still running
      let openGate: () => void = () => {};
      gate = new Promise((r) => {
        openGate = r;
      });
      expect((await get(o)).pending).toBe(true); // expired memo served; refresh parked on the reader

      release({
        code: 0,
        stdout: JSON.stringify({ num_turns: 0, total_cost_usd: 0, is_error: false, result: text }),
      });
      await vi.waitFor(() => expect(cli.cliCallInFlight()).toBe(false));
      gate = null;
      openGate();
      await new Promise((r) => setTimeout(r, 10)); // let the refresh finish

      const after = await get(o);
      expect(after.pending).toBeUndefined();
      expect(after.source).toBe("cli");
      expect(spawnCalls).toHaveLength(1);
    } finally {
      vi.doUnmock("../../../src/oauth/usage.js");
    }
  });
});
