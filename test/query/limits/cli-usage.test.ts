/**
 * USAGE-CLI — spec docs/plans/spec-usage-cli-reader.md success criteria 3-6 (+ failure enum, privacy).
 * Expected values are derived from the spec, not the implementation. No real `claude` is ever spawned:
 * every test injects a fake spawn and a temp state dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ISOLATION_ENV, buildCliEnv } from "../../../src/judge/claude-cli.js";
import {
  type CliRefresherDeps,
  type CliSpawn,
  USAGE_ARGV,
  _resetCliRefresher,
  classifyCliOutput,
  kickCliRefresh,
  parseUsageText,
  readCliState,
} from "../../../src/query/limits/cli-usage.js";
import { cliEnabled } from "../../../src/query/limits/usage-sources.js";

const MIN = 60_000;

const GOLDEN = [
  "Current session: 7% used · resets Oct 20, 12:49pm (America/Los_Angeles)",
  "Current week (all models): 32% used · resets Oct 22, 10:59pm (America/Los_Angeles)",
  "Current week (Fable): 0% used · resets Oct 22, 11pm (America/Los_Angeles)",
].join("\n");
const DRIVERS =
  "\n\nWhat's driving your usage\n  SENTINEL-DRIVER-XYZ 41% of usage came from big-project\n";
const NOW_GOLDEN = Date.parse("2026-10-20T16:00:00Z");

const cliJson = (text: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    num_turns: 0,
    total_cost_usd: 0,
    is_error: false,
    result: text,
    ...over,
  });
const okOut = (text: string, over: Record<string, unknown> = {}) => ({
  code: 0,
  stdout: cliJson(text, over),
});

describe("parseUsageText (criterion 5)", () => {
  it("golden: real 2026-10-20 output, drivers block ignored", () => {
    const d = parseUsageText(GOLDEN + DRIVERS, NOW_GOLDEN);
    expect(d).toEqual({
      // 12:49pm PDT (UTC-7) = 19:49Z; Oct 22 10:59pm PDT = Oct 23 05:59Z; 11pm = 06:00Z.
      five_hour: { utilization: 0.07, resets_at: "2026-10-20T19:49:00.000Z" },
      seven_day: { utilization: 0.32, resets_at: "2026-10-23T05:59:00.000Z" },
      per_model: [{ model: "fable", utilization: 0 }],
    });
  });

  it("11pm and 12:49pm both resolve (hour-only vs hour:minute)", () => {
    const d = parseUsageText(
      "Current session: 1% used · resets Oct 21, 11pm (America/Los_Angeles)\nCurrent week (all models): 2% used · resets Oct 22, 12:49pm (America/Los_Angeles)",
      NOW_GOLDEN,
    );
    expect(d?.five_hour.resets_at).toBe("2026-10-22T06:00:00.000Z");
    expect(d?.seven_day.resets_at).toBe("2026-10-22T19:49:00.000Z");
  });

  it("12am / 12pm map to midnight / noon", () => {
    const d = parseUsageText(
      "Current session: 1% used · resets Oct 21, 12am (America/Los_Angeles)\nCurrent week (all models): 2% used · resets Oct 21, 12pm (America/Los_Angeles)",
      NOW_GOLDEN,
    );
    expect(d?.five_hour.resets_at).toBe("2026-10-21T07:00:00.000Z");
    expect(d?.seven_day.resets_at).toBe("2026-10-21T19:00:00.000Z");
  });

  it("DST fall-back week (America/Los_Angeles, Nov 1 2026 02:00): offsets follow the zone", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    const d = parseUsageText(
      [
        "Current session: 3% used · resets Oct 31, 11pm (America/Los_Angeles)", // PDT -7 → Nov 1 06:00Z
        "Current week (all models): 10% used · resets Nov 2, 10:59pm (America/Los_Angeles)", // PST -8 → Nov 3 06:59Z
        "Current week (Fable): 4% used · resets Nov 1, 11pm (America/Los_Angeles)", // PST -8 → Nov 2 07:00Z
      ].join("\n"),
      now,
    );
    expect(d?.five_hour.resets_at).toBe("2026-11-01T06:00:00.000Z");
    expect(d?.seven_day.resets_at).toBe("2026-11-03T06:59:00.000Z");
    expect(d?.per_model).toEqual([{ model: "fable", utilization: 0.04 }]);
  });

  it("missing session line: session is idle, weekly kept", () => {
    const d = parseUsageText(
      "Current week (all models): 32% used · resets Oct 22, 10:59pm (America/Los_Angeles)",
      NOW_GOLDEN,
    );
    expect(d?.five_hour).toEqual({ utilization: 0, resets_at: null });
    expect(d?.seven_day.utilization).toBe(0.32);
  });

  it("missing weekly line: weekly is idle, session kept", () => {
    const d = parseUsageText(
      "Current session: 7% used · resets Oct 20, 12:49pm (America/Los_Angeles)",
      NOW_GOLDEN,
    );
    expect(d?.seven_day).toEqual({ utilization: 0, resets_at: null });
    expect(d?.five_hour.utilization).toBe(0.07);
  });

  it("neither line, or unknown format: null", () => {
    expect(parseUsageText("", NOW_GOLDEN)).toBeNull();
    expect(parseUsageText("Usage looks great today!", NOW_GOLDEN)).toBeNull();
    expect(parseUsageText(DRIVERS, NOW_GOLDEN)).toBeNull();
    expect(parseUsageText("Current session: lots used", NOW_GOLDEN)).toBeNull();
  });

  it("year rollover: now Dec 30, reset 'Jan 2' is in the next year", () => {
    const d = parseUsageText(
      "Current session: 5% used · resets Jan 2, 3pm (America/Los_Angeles)\nCurrent week (all models): 5% used · resets Jan 2, 3pm (America/Los_Angeles)",
      Date.parse("2026-12-30T12:00:00Z"),
    );
    expect(d?.five_hour.resets_at).toBe("2027-01-02T23:00:00.000Z"); // PST -8
  });
});

describe("classifyCliOutput guard (criterion 5)", () => {
  it("valid zero-turn zero-cost output is accepted", () => {
    const r = classifyCliOutput(okOut(GOLDEN), NOW_GOLDEN);
    expect(r.ok).toBe(true);
  });
  it("num_turns: 1 is a guard failure", () => {
    expect(classifyCliOutput(okOut(GOLDEN, { num_turns: 1 }), NOW_GOLDEN)).toEqual({
      ok: false,
      reason: "guard",
    });
  });
  it("missing num_turns is a guard failure", () => {
    const o = JSON.parse(cliJson(GOLDEN)) as Record<string, unknown>;
    o.num_turns = undefined;
    expect(classifyCliOutput({ code: 0, stdout: JSON.stringify(o) }, NOW_GOLDEN)).toEqual({
      ok: false,
      reason: "guard",
    });
  });
  it("total_cost_usd > 0, or missing, is a guard failure", () => {
    expect(classifyCliOutput(okOut(GOLDEN, { total_cost_usd: 0.002 }), NOW_GOLDEN)).toEqual({
      ok: false,
      reason: "guard",
    });
    const o = JSON.parse(cliJson(GOLDEN)) as Record<string, unknown>;
    o.total_cost_usd = undefined;
    expect(classifyCliOutput({ code: 0, stdout: JSON.stringify(o) }, NOW_GOLDEN)).toEqual({
      ok: false,
      reason: "guard",
    });
  });
});

// ── Refresher harness ────────────────────────────────────────────────────────

interface Call {
  cmd: string;
  argv: string[];
  opts: Parameters<CliSpawn>[2];
}

let stateDir: string;
let clock: number;
let calls: Call[];
let version: string;
let usageHandler: () => { code: number | null; stdout: string; unknownOption?: boolean };
let versionCalls: () => Call[];
let usageCalls: () => Call[];
const BASE_ENV = {
  PATH: "/bin",
  FOO: "bar",
  CLAUDECODE: "1",
  ANTHROPIC_API_KEY: "sk-test",
};

const spawn: CliSpawn = async (cmd, argv, opts) => {
  calls.push({ cmd, argv, opts });
  if (argv[0] === "--version") return { code: 0, stdout: `${version} (Claude Code)\n` };
  return usageHandler();
};

function deps(over: Partial<CliRefresherDeps> = {}): CliRefresherDeps {
  return {
    stateDir,
    now: () => clock,
    enabled: true,
    statuslineAgeMs: () => null,
    lastTurnAt: () => null,
    spawn,
    baseEnv: BASE_ENV,
    ...over,
  };
}

/** Kick at `clock`; true when a call started. Awaits it. */
async function kick(over: Partial<CliRefresherDeps> = {}): Promise<boolean> {
  const p = kickCliRefresh(deps(over));
  if (p === null) return false;
  await p;
  return true;
}

beforeEach(() => {
  _resetCliRefresher();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-usage-cli-test-"));
  clock = Date.now();
  calls = [];
  version = "2.1.304";
  usageHandler = () => okOut(GOLDEN + DRIVERS);
  usageCalls = () => calls.filter((c) => c.argv[0] === "-p");
  versionCalls = () => calls.filter((c) => c.argv[0] === "--version");
});
afterEach(() => {
  _resetCliRefresher();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const T0 = () => clock; // alias for readability in the advance helper below
const advance = (min: number, from = T0()) => {
  clock = from + min * MIN;
};

describe("spawn argv, env, cwd (criterion 6)", () => {
  it("passes the spec argv and no --disable-slash-commands", async () => {
    expect(await kick()).toBe(true);
    const c = usageCalls();
    expect(c).toHaveLength(1);
    const argv = c[0]?.argv ?? [];
    expect(c[0]?.cmd).toBe("claude");
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toBe("/usage");
    expect(argv).toContain("--safe-mode");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("1");
    expect(argv).toContain("--no-session-persistence");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv).not.toContain("--disable-slash-commands");
    expect([...USAGE_ARGV]).toEqual(argv);
    expect(c[0]?.opts.timeoutMs).toBe(20_000);
  });

  it("env has the isolation keys, lacks CLAUDECODE and ANTHROPIC_API_KEY, keeps the rest", async () => {
    await kick();
    const env = usageCalls()[0]?.opts.env ?? {};
    for (const [k, v] of Object.entries(ISOLATION_ENV)) expect(env[k]).toBe(v);
    expect("CLAUDECODE" in env).toBe(false);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect(env.FOO).toBe("bar");
  });

  it("cwd is an empty temp dir that is removed afterwards", async () => {
    let seen: { exists: boolean; entries: string[] } | null = null;
    usageHandler = () => {
      const cwd = usageCalls()[0]?.opts.cwd ?? "";
      seen = { exists: fs.existsSync(cwd), entries: fs.existsSync(cwd) ? fs.readdirSync(cwd) : [] };
      return okOut(GOLDEN);
    };
    await kick();
    const cwd = usageCalls()[0]?.opts.cwd ?? "";
    expect(seen).toEqual({ exists: true, entries: [] });
    expect(cwd.startsWith(os.tmpdir())).toBe(true);
    expect(cwd).not.toBe(stateDir);
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it("cwd is removed even when the call fails", async () => {
    usageHandler = () => ({ code: 1, stdout: "" });
    await kick();
    expect(fs.existsSync(usageCalls()[0]?.opts.cwd ?? "")).toBe(false);
  });

  it("buildCliEnv drops CLAUDECODE always and the named keys, adds isolation env", () => {
    const e = buildCliEnv({ A: "1", CLAUDECODE: "1", ANTHROPIC_API_KEY: "k", U: undefined });
    expect(e.A).toBe("1");
    expect("CLAUDECODE" in e).toBe(false);
    expect("U" in e).toBe(false);
    expect(e.ANTHROPIC_API_KEY).toBe("k");
    expect(
      "ANTHROPIC_API_KEY" in
        buildCliEnv({ ANTHROPIC_API_KEY: "k" }, { dropKeys: ["ANTHROPIC_API_KEY"] }),
    ).toBe(false);
    expect(e.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
  });
});

describe("rate rules (criterion 4)", () => {
  it("fresh install (no reading, no attempt) calls at once and stores the reading", async () => {
    expect(await kick()).toBe(true);
    expect(usageCalls()).toHaveLength(1);
    const s = readCliState(stateDir);
    expect(s.outcome).toBe("ok");
    expect(s.reading?.data.five_hour.utilization).toBe(0.07);
    expect(s.reading?.asOf).toBe(new Date(clock).toISOString());
  });

  it("statusline <= 5 min old: 0 calls; older or absent: call", async () => {
    expect(await kick({ statuslineAgeMs: () => 4 * MIN })).toBe(false);
    expect(await kick({ statuslineAgeMs: () => 5 * MIN })).toBe(false);
    expect(usageCalls()).toHaveLength(0);
    expect(await kick({ statuslineAgeMs: () => 5 * MIN + 1000 })).toBe(true);
    expect(usageCalls()).toHaveLength(1);
  });

  it("enabled:false: 0 calls", async () => {
    expect(await kick({ enabled: false })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("AW_USAGE_CLI=off disables; unset under VITEST disables; on enables", () => {
    expect(cliEnabled(null, { AW_USAGE_CLI: "off" })).toBe(false);
    expect(cliEnabled(null, { VITEST: "true" })).toBe(false);
    expect(cliEnabled(null, { AW_USAGE_CLI: "on", VITEST: "true" })).toBe(true);
    expect(cliEnabled(null, {})).toBe(true);
  });

  it("idle (no turns since the reading): at most one call per 60 min", async () => {
    const start = clock;
    await kick(); // t=0, reading at t=0
    advance(59, start);
    expect(await kick()).toBe(false);
    advance(60, start);
    expect(await kick()).toBe(true);
    expect(usageCalls()).toHaveLength(2);
    // A turn older than the reading is not activity.
    advance(61, start);
    expect(await kick({ lastTurnAt: () => new Date(start).toISOString() })).toBe(false);
  });

  it("active (turn newer than the reading): at most one call per 5 min", async () => {
    const start = clock;
    const turn = () => new Date(start + 60_000).toISOString();
    await kick({ lastTurnAt: turn }); // reading at t=0
    advance(4, start);
    expect(await kick({ lastTurnAt: turn })).toBe(false);
    advance(5, start);
    expect(await kick({ lastTurnAt: turn })).toBe(true);
    expect(usageCalls()).toHaveLength(2);
    // The new reading is newer than that turn: back to idle (60 min).
    advance(10, start);
    expect(await kick({ lastTurnAt: turn })).toBe(false);
  });

  it("backoff ladder 5 → 10 → 20 → 60 after failures, combined as max with the turn interval", async () => {
    const start = clock;
    const turn = () => new Date(start + 60_000).toISOString();
    await kick({ lastTurnAt: turn }); // success, step 0
    usageHandler = () => ({ code: 1, stdout: "" });
    const at = async (min: number) => {
      advance(min, start);
      return kick({ lastTurnAt: turn });
    };
    expect(await at(4)).toBe(false);
    expect(await at(5)).toBe(true); // fail → wait 5
    expect(await at(9)).toBe(false);
    expect(await at(10)).toBe(true); // fail → wait 10
    expect(await at(19)).toBe(false);
    expect(await at(20)).toBe(true); // fail → wait 20
    expect(await at(39)).toBe(false);
    expect(await at(40)).toBe(true); // fail → wait 60
    expect(await at(99)).toBe(false);
    expect(await at(100)).toBe(true);
    expect(usageCalls()).toHaveLength(6);
    // A success clears the backoff: the next wait is the turn interval only.
    usageHandler = () => okOut(GOLDEN);
    expect(await at(160)).toBe(true);
    expect(readCliState(stateDir).backoffStep).toBe(0);
  });

  it("idle turn interval (60) dominates a small backoff step", async () => {
    const start = clock;
    await kick();
    usageHandler = () => ({ code: 1, stdout: "" });
    advance(60, start);
    expect(await kick()).toBe(true); // fail → backoff 5, idle interval 60
    advance(119, start);
    expect(await kick()).toBe(false);
    advance(120, start);
    expect(await kick()).toBe(true);
  });

  it("a failed first call (no reading) still honours the backoff", async () => {
    usageHandler = () => ({ code: 1, stdout: "" });
    const start = clock;
    expect(await kick()).toBe(true);
    advance(4, start);
    expect(await kick()).toBe(false);
    advance(5, start);
    expect(await kick()).toBe(true);
  });

  it("guard trip: no usage calls until `claude --version` changes; re-check at most hourly", async () => {
    const start = clock;
    usageHandler = () => okOut(GOLDEN, { num_turns: 1 });
    expect(await kick()).toBe(true);
    let s = readCliState(stateDir);
    expect(s.outcome).toBe("guard");
    expect(s.guardTrippedVersion).toBe("2.1.304");
    expect(s.reading).toBeUndefined();
    expect(usageCalls()).toHaveLength(1);

    advance(1, start);
    expect(await kick()).toBe(false);
    expect(calls.filter((c) => c.argv[0] === "--version")).toHaveLength(1);

    usageHandler = () => okOut(GOLDEN);
    advance(61, start); // hourly re-check, version unchanged
    await kick();
    expect(usageCalls()).toHaveLength(1);
    expect(versionCalls()).toHaveLength(2);
    advance(90, start); // < 1 h since the check
    expect(await kick()).toBe(false);
    expect(versionCalls()).toHaveLength(2);

    version = "2.1.305";
    advance(122, start);
    expect(await kick()).toBe(true);
    expect(usageCalls()).toHaveLength(2);
    s = readCliState(stateDir);
    expect(s.guardTrippedVersion).toBeUndefined();
    expect(s.outcome).toBe("ok");
    expect(s.reading).toBeDefined();
  });

  it("single flight in-process: two concurrent kicks → one spawn", async () => {
    let release: (v: { code: number; stdout: string }) => void = () => {};
    const gate = new Promise<{ code: number; stdout: string }>((r) => {
      release = r;
    });
    usageHandler = (() => gate) as unknown as typeof usageHandler;
    const p1 = kickCliRefresh(deps());
    const p2 = kickCliRefresh(deps());
    expect(p1).not.toBeNull();
    expect(p2).toBeNull();
    release(okOut(GOLDEN));
    await p1;
    expect(usageCalls()).toHaveLength(1);
    expect(fs.existsSync(path.join(stateDir, "usage-cli.lock"))).toBe(false);
  });

  it("single flight across processes: a fresh lock file held by another process → 0 spawns", async () => {
    const lock = path.join(stateDir, "usage-cli.lock");
    fs.writeFileSync(lock, "99999");
    const t = new Date(clock);
    fs.utimesSync(lock, t, t);
    await kick();
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(lock)).toBe(true); // not ours: left alone
  });

  it("a lock older than its stale age is taken over", async () => {
    const lock = path.join(stateDir, "usage-cli.lock");
    fs.writeFileSync(lock, "99999");
    const old = new Date(clock - 10 * MIN);
    fs.utimesSync(lock, old, old);
    expect(await kick()).toBe(true);
    expect(usageCalls()).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("guard tripped while --version failed: the next readable version is pinned, guard stays (review M1)", async () => {
    const start = clock;
    usageHandler = () => okOut(GOLDEN, { num_turns: 1 });
    version = "garbage"; // unreadable at trip time
    await kick();
    expect(readCliState(stateDir).guardTrippedVersion).toBe("unknown");
    version = "2.1.304";
    advance(61, start);
    await kick();
    expect(usageCalls()).toHaveLength(1); // same CLI: no second /usage
    expect(readCliState(stateDir).guardTrippedVersion).toBe("2.1.304");
    version = "2.1.305";
    usageHandler = () => okOut(GOLDEN);
    advance(122, start);
    await kick();
    expect(usageCalls()).toHaveLength(2);
    expect(readCliState(stateDir).guardTrippedVersion).toBeUndefined();
  });

  it("state file can't be written: no spawn, and at most one attempt per 5 min in-process (review M2)", async () => {
    fs.mkdirSync(path.join(stateDir, "usage-cli.json")); // rename onto a directory fails
    const start = clock;
    expect(await kick()).toBe(true);
    expect(usageCalls()).toHaveLength(0);
    advance(1, start);
    expect(await kick()).toBe(false);
    advance(6, start);
    await kick();
    expect(usageCalls()).toHaveLength(0);
  });

  it("restart mid-call on a fresh install: no immediate re-call (review M4)", async () => {
    const start = clock;
    usageHandler = (() => new Promise(() => {})) as unknown as typeof usageHandler; // never lands
    expect(kickCliRefresh(deps())).not.toBeNull();
    const s = readCliState(stateDir);
    expect(s.lastAttemptAt).toBeDefined();
    expect(s.backoffStep).toBe(1); // recorded pessimistically before the spawn
    _resetCliRefresher();
    fs.rmSync(path.join(stateDir, "usage-cli.lock"), { force: true }); // the dead owner's lock
    usageHandler = () => okOut(GOLDEN);
    advance(1, start);
    expect(await kick()).toBe(false);
    advance(5, start);
    expect(await kick()).toBe(true);
    expect(usageCalls()).toHaveLength(2);
    expect(readCliState(stateDir).backoffStep).toBe(0);
  });

  it("a lastAttemptAt in the future (clock set back) does not freeze calls (review L7)", async () => {
    const start = clock;
    await kick();
    const s = readCliState(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "usage-cli.json"),
      JSON.stringify({ ...s, lastAttemptAt: new Date(start + 48 * 60 * MIN).toISOString() }),
    );
    _resetCliRefresher();
    advance(61, start);
    expect(await kick()).toBe(true);
    expect(usageCalls()).toHaveLength(2);
  });
});

describe("restart and second daemon (criterion 3)", () => {
  it("restart (_resetCliRefresher) right after a call: no extra call", async () => {
    const start = clock;
    await kick();
    _resetCliRefresher();
    advance(1, start);
    expect(await kick()).toBe(false);
    expect(usageCalls()).toHaveLength(1);
  });

  it("second daemon, same state dir, different DB (lastTurnAt): no extra call", async () => {
    const start = clock;
    await kick({ lastTurnAt: () => null });
    _resetCliRefresher(); // a different process has its own in-flight slot
    advance(2, start);
    expect(await kick({ lastTurnAt: () => new Date(start + 90_000).toISOString() })).toBe(false);
    expect(usageCalls()).toHaveLength(1);
  });

  it("restart during backoff: no call", async () => {
    const start = clock;
    usageHandler = () => ({ code: 1, stdout: "" });
    await kick();
    _resetCliRefresher();
    advance(2, start);
    expect(await kick()).toBe(false);
    expect(usageCalls()).toHaveLength(1);
    // And the backoff survives in the file, not memory.
    expect(readCliState(stateDir).backoffStep).toBe(1);
  });
});

describe("failure enum and privacy", () => {
  async function outcomeOf(h: typeof usageHandler | (() => never)): Promise<string | undefined> {
    usageHandler = h as typeof usageHandler;
    await kick();
    return readCliState(stateDir).outcome;
  }

  it("ENOENT → not_found", async () => {
    expect(
      await outcomeOf(() => {
        throw Object.assign(new Error("x"), { code: "ENOENT" });
      }),
    ).toBe("not_found");
  });
  it("ETIMEDOUT → timeout", async () => {
    expect(
      await outcomeOf(() => {
        throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
      }),
    ).toBe("timeout");
  });
  it("unknown option + non-JSON → outdated", async () => {
    expect(await outcomeOf(() => ({ code: 1, stdout: "", unknownOption: true }))).toBe("outdated");
  });
  it("is_error → error", async () => {
    expect(await outcomeOf(() => okOut("Something broke", { is_error: true }))).toBe("error");
  });
  it("unparseable result → parse", async () => {
    expect(await outcomeOf(() => okOut("not a usage screen"))).toBe("parse");
  });

  it("a failure keeps the previous reading and bumps the backoff", async () => {
    const start = clock;
    await kick();
    const before = readCliState(stateDir).reading;
    usageHandler = () => okOut("nonsense");
    advance(60, start);
    await kick();
    const s = readCliState(stateDir);
    expect(s.reading).toEqual(before);
    expect(s.backoffStep).toBe(1);
  });

  it("nothing from stdout reaches the state file (success and failures)", async () => {
    const file = path.join(stateDir, "usage-cli.json");
    await kick();
    expect(fs.readFileSync(file, "utf8")).not.toContain("SENTINEL-DRIVER-XYZ");
    expect(fs.readFileSync(file, "utf8")).not.toContain("big-project");

    for (const h of [
      () => okOut("SENTINEL-DRIVER-XYZ only"),
      () => ({ code: 1, stdout: "SENTINEL-DRIVER-XYZ crash" }),
      () => okOut("SENTINEL-DRIVER-XYZ", { is_error: true }),
      () => okOut(`${GOLDEN}\nSENTINEL-DRIVER-XYZ`, { num_turns: 2 }),
    ]) {
      _resetCliRefresher();
      fs.rmSync(file, { force: true });
      usageHandler = h;
      await kick();
      expect(fs.readFileSync(file, "utf8")).not.toContain("SENTINEL-DRIVER-XYZ");
    }
  });
});
