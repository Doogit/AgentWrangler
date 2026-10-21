/**
 * src/query/limits/cli-usage.ts — usage limits read through the user's own `claude -p /usage` (USAGE-CLI).
 *
 * The unmodified Claude Code binary makes the upstream call; AgentWrangler never reads or sends the OAuth
 * token (terms audit .claude/audits/2026-10-13-jms-p2-terms.md, spec docs/plans/spec-usage-cli-reader.md).
 * A background refresher, kicked by GET /api/query/limits, runs the CLI as rarely as the spec's "When to call"
 * rules allow. The reading and the call budget live in one file under ~/.agentwrangler/ (not the DB), so every
 * daemon — prod and review copies — shares them, and a restart neither resets the backoff nor triggers a call.
 *
 * Privacy (SEC-101): only percentages, ISO timestamps and model labels are stored. Failure reasons come from a
 * fixed enum; CLI stdout/stderr never reaches a log, the state file or the UI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type JudgeSpawnResult, buildCliEnv, spawnCli } from "../../judge/claude-cli.js";
import type { OAuthUsageData, OAuthUsagePerModel, OAuthUsagePeriod } from "../../oauth/usage.js";

export type CliUsageFailure = "not_found" | "outdated" | "timeout" | "parse" | "guard" | "error";

export interface CliReading {
  /** When the CLI call finished. */
  asOf: string;
  data: OAuthUsageData;
}

/** The shared state file. Every field is optional so a partial or older file still loads. */
export interface CliUsageState {
  /** When the last call started (written before spawning). */
  lastAttemptAt?: string;
  outcome?: "ok" | CliUsageFailure;
  /** Index into BACKOFF_MS; 0 after a success. */
  backoffStep?: number;
  /** `claude --version` when the guard tripped; no calls until it changes. */
  guardTrippedVersion?: string;
  versionCheckedAt?: string;
  reading?: CliReading;
}

export type CliSpawn = (
  cmd: string,
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; input: string; timeoutMs: number },
) => Promise<JudgeSpawnResult>;

const MIN = 60_000;
/** A statusline file at most this old means no CLI call (separate from its 30-min display age). */
export const CLI_SKIP_STATUSLINE_MS = 5 * MIN;
const TURN_INTERVAL_ACTIVE_MS = 5 * MIN;
const TURN_INTERVAL_IDLE_MS = 60 * MIN;
/** Wait after 0, 1, 2, 3, 4+ consecutive failures. */
const BACKOFF_MS = [0, 5 * MIN, 10 * MIN, 20 * MIN, 60 * MIN] as const;
const VERSION_RECHECK_MS = 60 * MIN;
const CALL_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 10_000;
/** A lock older than this belongs to a process that died mid-call. */
const LOCK_STALE_MS = 2 * MIN;

/** The spec spawn. Never `--disable-slash-commands`: it would disable `/usage` itself. */
export const USAGE_ARGV = [
  "-p",
  "/usage",
  "--safe-mode",
  "--tools",
  "",
  "--strict-mcp-config",
  "--max-turns",
  "1",
  "--no-session-persistence",
  "--output-format",
  "json",
] as const;

export function defaultCliStateDir(home: string = os.homedir()): string {
  return path.join(home, ".agentwrangler");
}
const stateFile = (dir: string) => path.join(dir, "usage-cli.json");
const lockFile = (dir: string) => path.join(dir, "usage-cli.lock");

// ── Parser ────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LINE_RE =
  /^Current (session|week \((.+)\)):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?)\s*\(([^)]+)\))?\s*$/;
const RESET_RE = /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;

/** Wall clock in `tz` minus UTC at `utcMs`. Throws RangeError on an unknown zone. */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const p = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  const wall = Date.UTC(
    p("year"),
    p("month") - 1,
    p("day"),
    p("hour") % 24,
    p("minute"),
    p("second"),
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock time in `tz` as UTC ms; the second probe settles a DST change between guess and answer. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const first = wall - zoneOffsetMs(wall, tz);
  return wall - zoneOffsetMs(first, tz);
}

/** `Oct 22, 11pm` / `12:49pm` in `tz` → the next occurrence at or after now (1-day rounding slack). */
function parseReset(text: string, tz: string, nowMs: number): string | null {
  const m = RESET_RE.exec(text.trim());
  if (m === null) return null;
  let hour = Number(m[3]);
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  hour = (hour % 12) + (m[5]?.toLowerCase() === "pm" ? 12 : 0);
  try {
    const nowWall = new Date(nowMs + zoneOffsetMs(nowMs, tz));
    const slack = 24 * 60 * MIN;
    if (m[1] === undefined) {
      // Time only: today in the zone, else tomorrow.
      for (let add = 0; add <= 1; add++) {
        const t = zonedToUtc(
          nowWall.getUTCFullYear(),
          nowWall.getUTCMonth(),
          nowWall.getUTCDate() + add,
          hour,
          minute,
          tz,
        );
        if (t >= nowMs - 5 * MIN) return new Date(t).toISOString();
      }
      return null;
    }
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const day = Number(m[2]);
    if (month < 0 || day < 1 || day > 31) return null;
    for (const y of [nowWall.getUTCFullYear(), nowWall.getUTCFullYear() + 1]) {
      const t = zonedToUtc(y, month, day, hour, minute, tz);
      if (t >= nowMs - slack) return new Date(t).toISOString();
    }
    return null;
  } catch {
    return null; // unknown time zone
  }
}

/**
 * Parse `/usage` result text. Unknown lines (the usage-drivers block) are ignored. A missing session or weekly
 * line is served as an idle window; neither line → null (parse failure).
 */
export function parseUsageText(text: string, nowMs: number): OAuthUsageData | null {
  let five: OAuthUsagePeriod | null = null;
  let seven: OAuthUsagePeriod | null = null;
  const perModel: OAuthUsagePerModel[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trim());
    if (m === null) continue;
    const pct = Number(m[3]);
    if (!Number.isFinite(pct)) continue;
    let resetsAt: string | null = null;
    if (m[4] !== undefined && m[5] !== undefined) {
      resetsAt = parseReset(m[4], m[5], nowMs);
      if (resetsAt === null) continue; // a reset we can't place is a line we can't trust
    }
    const period = { utilization: Math.min(100, Math.max(0, pct)) / 100, resets_at: resetsAt };
    if (m[1] === "session") five = period;
    else if (m[2]?.toLowerCase() === "all models") seven = period;
    else if (m[2] !== undefined)
      perModel.push({ model: m[2].trim().toLowerCase(), utilization: period.utilization });
  }
  if (five === null && seven === null) return null;
  const idle: OAuthUsagePeriod = { utilization: 0, resets_at: null };
  return {
    five_hour: five ?? idle,
    seven_day: seven ?? idle,
    ...(perModel.length > 0 ? { per_model: perModel } : {}),
  };
}

/**
 * Classify one CLI run. The guard comes first: `num_turns` and `total_cost_usd` must both be present and 0, or
 * a model turn may have been spent.
 */
export function classifyCliOutput(
  out: JudgeSpawnResult,
  nowMs: number,
): { ok: true; data: OAuthUsageData } | { ok: false; reason: CliUsageFailure } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object")
    return { ok: false, reason: out.code !== 0 && out.unknownOption ? "outdated" : "error" };
  const rec = parsed as {
    num_turns?: unknown;
    total_cost_usd?: unknown;
    is_error?: unknown;
    result?: unknown;
  };
  if (rec.num_turns !== 0 || rec.total_cost_usd !== 0) return { ok: false, reason: "guard" };
  if (out.code !== 0 || rec.is_error === true) return { ok: false, reason: "error" };
  if (typeof rec.result !== "string") return { ok: false, reason: "parse" };
  const data = parseUsageText(rec.result, nowMs);
  return data === null ? { ok: false, reason: "parse" } : { ok: true, data };
}

// ── Shared state ──────────────────────────────────────────────────────────────

function isPeriod(p: unknown): p is OAuthUsagePeriod {
  const v = p as { utilization?: unknown; resets_at?: unknown } | null;
  return (
    typeof v?.utilization === "number" && (v.resets_at === null || typeof v.resets_at === "string")
  );
}

/** The state file, or {} when absent or malformed. Never throws. */
export function readCliState(dir: string): CliUsageState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(dir), "utf8")) as CliUsageState;
    if (s === null || typeof s !== "object") return {};
    const r = s.reading;
    if (
      r !== undefined &&
      (typeof r?.asOf !== "string" || !isPeriod(r.data?.five_hour) || !isPeriod(r.data?.seven_day))
    ) {
      const { reading: _drop, ...rest } = s;
      return rest;
    }
    return s;
  } catch {
    return {};
  }
}

/** False when the file could not be replaced; the caller must not spawn on a budget it couldn't record. */
function writeCliState(dir: string, s: CliUsageState): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${stateFile(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), "utf8");
    fs.renameSync(tmp, stateFile(dir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Single flight across processes: an exclusive lock file holding a unique token. A lock whose age is beyond
 * LOCK_STALE_MS (either way, so a clock change can't wedge it) belongs to a process that died mid-call; it is
 * taken over by renaming it away, which only one contender can win.
 */
function tryLock(dir: string, nowMs: number): string | null {
  const file = lockFile(dir);
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, token, { flag: "wx" });
      return token;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return null;
      try {
        if (Math.abs(nowMs - fs.statSync(file).mtimeMs) < LOCK_STALE_MS) return null;
        const away = `${file}.${token}.stale`;
        fs.renameSync(file, away);
        fs.rmSync(away, { force: true });
      } catch {
        return null; // another contender took it over first
      }
    }
  }
  return null;
}

/** Remove the lock only if it is still ours (a slow owner may have been taken over). */
function unlock(dir: string, token: string): void {
  try {
    if (fs.readFileSync(lockFile(dir), "utf8") === token) fs.rmSync(lockFile(dir), { force: true });
  } catch {
    // Gone already, or a stale lock taken over after LOCK_STALE_MS.
  }
}

/** Parse an ISO time; NaN or one in the future (clock set back) reads as "long ago", so it can't freeze calls. */
function pastMs(iso: string | undefined, now: number): number {
  const t = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(t) && t <= now ? t : 0;
}

// ── Refresher ─────────────────────────────────────────────────────────────────

export interface CliRefresherDeps {
  stateDir: string;
  now: () => number;
  /** Settings toggle and AW_USAGE_CLI, resolved by the caller. */
  enabled: boolean;
  /** Age of the statusline file, or null when absent/unreadable. */
  statuslineAgeMs: () => number | null;
  /** MAX(turns.ts), or null when there are no turns. */
  lastTurnAt: () => string | null;
  spawn?: CliSpawn;
  baseEnv?: Record<string, string | undefined>;
  /** Called after a call finishes (success or failure), e.g. to drop a response memo. */
  onDone?: () => void;
}

/** Wait since the last attempt before the next one may start (rule 4). */
function waitMs(s: CliUsageState, lastTurnAt: string | null): number {
  const backoff = BACKOFF_MS[Math.min(s.backoffStep ?? 0, BACKOFF_MS.length - 1)] ?? 0;
  // Fresh install: no reading yet → call at once (the backoff still holds after a failure).
  if (s.reading === undefined) return backoff;
  const turned = lastTurnAt !== null && Date.parse(lastTurnAt) > Date.parse(s.reading.asOf);
  return Math.max(turned ? TURN_INTERVAL_ACTIVE_MS : TURN_INTERVAL_IDLE_MS, backoff);
}

/** Rules 1, 3, 4 and the cheap half of 5. Rule 2 (viewer active) holds by construction: only the GET kicks. */
export function callAllowed(s: CliUsageState, deps: CliRefresherDeps): boolean {
  if (!deps.enabled) return false;
  const age = deps.statuslineAgeMs();
  if (age !== null && age <= CLI_SKIP_STATUSLINE_MS) return false;
  const now = deps.now();
  if (s.guardTrippedVersion !== undefined) {
    // Tripped: only a version re-check, at most hourly.
    return now - pastMs(s.versionCheckedAt, now) >= VERSION_RECHECK_MS;
  }
  if (s.lastAttemptAt === undefined) return true;
  return now - pastMs(s.lastAttemptAt, now) >= waitMs(s, deps.lastTurnAt());
}

let inFlight: Promise<void> | null = null;
/**
 * In-process floor under the shared file: if the state file can't be written (AV lock, read-only), the
 * file-based rules can't see our attempts, so this process still calls at most once per 5 min.
 */
let lastLocalAttemptMs: number | null = null;
const LOCAL_FLOOR_MS = 5 * MIN;

/** Test hook: forget this process's in-flight call and local floor (a restart). */
export function _resetCliRefresher(): void {
  inFlight = null;
  lastLocalAttemptMs = null;
}

export function cliCallInFlight(): boolean {
  return inFlight !== null;
}

async function cliVersion(
  spawn: CliSpawn,
  env: Record<string, string>,
  cwd: string,
): Promise<string | null> {
  try {
    const out = await spawn("claude", ["--version"], {
      cwd,
      env,
      input: "",
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const v = out.code === 0 ? out.stdout.trim().split(/\s+/)[0] : undefined;
    return v !== undefined && /^\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** True when a /usage call (or guard version re-check) actually ran. */
async function runCall(deps: CliRefresherDeps): Promise<boolean> {
  const dir = deps.stateDir;
  const token = tryLock(dir, deps.now());
  if (token === null) return false;
  let cwd: string | null = null;
  try {
    // Re-check under the lock: another daemon may have just finished a call.
    let s = readCliState(dir);
    if (!callAllowed(s, deps)) return false;
    lastLocalAttemptMs = deps.now();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aw-usage-cwd-"));
    const spawn: CliSpawn = deps.spawn ?? spawnCli;
    const env = buildCliEnv(deps.baseEnv ?? process.env, { dropKeys: ["ANTHROPIC_API_KEY"] });

    if (s.guardTrippedVersion !== undefined) {
      const v = await cliVersion(spawn, env, cwd);
      s = { ...s, versionCheckedAt: new Date(deps.now()).toISOString() };
      // Tripped while the version was unreadable: pin the first version we can read, stay tripped.
      if (v !== null && s.guardTrippedVersion === "unknown") s = { ...s, guardTrippedVersion: v };
      if (v === null || v === s.guardTrippedVersion) {
        writeCliState(dir, s);
        return true;
      }
      const { guardTrippedVersion: _cleared, ...rest } = s;
      s = { ...rest, backoffStep: 0 };
    }

    // Record the attempt pessimistically (backoff advanced) before spawning: a restart or crash mid-call
    // then waits out the backoff instead of calling again at once. Success resets it below.
    const failedStep = Math.min((s.backoffStep ?? 0) + 1, BACKOFF_MS.length - 1);
    s = { ...s, lastAttemptAt: new Date(deps.now()).toISOString() };
    if (!writeCliState(dir, { ...s, backoffStep: failedStep })) return false;

    let result: ReturnType<typeof classifyCliOutput>;
    try {
      const out = await spawn("claude", [...USAGE_ARGV], {
        cwd,
        env,
        input: "",
        timeoutMs: CALL_TIMEOUT_MS,
      });
      result = classifyCliOutput(out, deps.now());
    } catch (err) {
      const code = (err as { code?: string }).code;
      result = {
        ok: false,
        reason: code === "ENOENT" ? "not_found" : code === "ETIMEDOUT" ? "timeout" : "error",
      };
    }
    const finishedAt = new Date(deps.now()).toISOString();
    if (result.ok) {
      s = { ...s, outcome: "ok", backoffStep: 0, reading: { asOf: finishedAt, data: result.data } };
    } else {
      s = { ...s, outcome: result.reason, backoffStep: failedStep };
      if (result.reason === "guard") {
        s = {
          ...s,
          guardTrippedVersion: (await cliVersion(spawn, env, cwd)) ?? "unknown",
          versionCheckedAt: finishedAt,
        };
      }
    }
    writeCliState(dir, s);
    // Outcome enum only, never CLI text (SEC-101); the soak counts these lines.
    console.info(`usage-cli: /usage call ${s.outcome} (backoff step ${s.backoffStep ?? 0})`);
    return true;
  } finally {
    unlock(dir, token);
    if (cwd !== null) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // A just-killed child may still hold it on Windows; the OS temp cleanup gets it.
      }
    }
  }
}

/**
 * Start a background call when every rule allows it; never awaited by the GET. Returns the call's promise (for
 * tests) or null when no call started.
 */
export function kickCliRefresh(deps: CliRefresherDeps): Promise<void> | null {
  if (inFlight !== null) return null;
  if (lastLocalAttemptMs !== null && deps.now() - lastLocalAttemptMs < LOCAL_FLOOR_MS) return null;
  if (!callAllowed(readCliState(deps.stateDir), deps)) return null;
  inFlight = runCall(deps)
    .catch(() => false)
    .then((ran) => {
      inFlight = null;
      if (ran) deps.onDone?.();
    });
  return inFlight;
}
