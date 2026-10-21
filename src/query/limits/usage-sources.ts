/**
 * src/query/limits/usage-sources.ts — merge the statusline and CLI usage readings (USAGE-CLI).
 *
 * Shared by the Usage limits card (limits/index.ts) and burn status / D4 (oauth/usage-cache.ts) so both read
 * the same values. Session and weekly come from whichever reading is newer; per-model rows come only from the
 * CLI reading, and only while its weekly reset matches the current weekly window.
 */

import type { Db } from "../../db/open.js";
import type { OAuthUsageData, OAuthUsagePeriod, OAuthUsageResult } from "../../oauth/usage.js";
import { type CliReading, defaultCliStateDir, readCliState } from "./cli-usage.js";
import { defaultStatuslinePath, readStatuslineLimits } from "./statusline.js";

/** user_config key for the Settings toggle "Read usage via Claude Code /usage" (absent = on). */
export const USAGE_CLI_ENABLED_KEY = "usage_cli_enabled";
/**
 * A CLI reading older than this is shown greyed (stale), and its per-model rows are not mixed into statusline
 * rows or passed to burn status (spec "UI": > 60 min).
 */
export const CLI_STALE_MS = 60 * 60_000;
/** The CLI prints resets to the minute and rounds (`10:59pm` vs `11pm` for one window). */
const SAME_WEEK_TOLERANCE_MS = 60 * 60_000;

/**
 * The reader is on unless AW_USAGE_CLI=off or the Settings toggle is off. Under vitest it is off unless
 * AW_USAGE_CLI is set, so no test spawns the real CLI.
 */
export function cliEnabled(
  db: Db | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.AW_USAGE_CLI;
  if (v === "off") return false;
  if (v === undefined && env.VITEST !== undefined) return false;
  if (db === null) return true;
  try {
    const row = db
      .prepare("SELECT value FROM user_config WHERE key = ?")
      .get(USAGE_CLI_ENABLED_KEY) as { value: string | null } | undefined;
    return row?.value !== "false";
  } catch {
    return true;
  }
}

function roll(p: OAuthUsagePeriod, nowMs: number): OAuthUsagePeriod {
  return p.resets_at !== null && Date.parse(p.resets_at) <= nowMs
    ? { utilization: 0, resets_at: null }
    : p;
}

/** A stored reading as of now: a window whose reset has passed reads 0% / idle, with no new call. */
export function cliUsageData(r: CliReading, nowMs: number): OAuthUsageData {
  const seven = roll(r.data.seven_day, nowMs);
  const weekRolled = seven !== r.data.seven_day;
  const perModel = r.data.per_model?.map((m) => (weekRolled ? { ...m, utilization: 0 } : m));
  return {
    five_hour: roll(r.data.five_hour, nowMs),
    seven_day: seven,
    ...(perModel !== undefined && perModel.length > 0 ? { per_model: perModel } : {}),
  };
}

export interface MergedUsage {
  data: OAuthUsageData;
  asOf: string;
  source: "statusline" | "cli";
  /** Set when session/weekly are the statusline's and the per-model rows the CLI's. */
  perModelAsOf?: string;
}

function sameWeek(a: string | null, b: string | null): boolean {
  return (
    a !== null && b !== null && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WEEK_TOLERANCE_MS
  );
}

export function mergeUsage(
  statusline: { data: OAuthUsageData; asOf: string } | null,
  cli: CliReading | null,
  nowMs: number,
): MergedUsage | null {
  if (cli !== null && (statusline === null || Date.parse(cli.asOf) > Date.parse(statusline.asOf)))
    return { data: cliUsageData(cli, nowMs), asOf: cli.asOf, source: "cli" };
  if (statusline === null) return null;
  const perModel = cli === null ? undefined : cliUsageData(cli, nowMs).per_model;
  if (
    cli !== null &&
    perModel !== undefined &&
    nowMs - Date.parse(cli.asOf) <= CLI_STALE_MS &&
    sameWeek(cli.data.seven_day.resets_at, statusline.data.seven_day.resets_at)
  )
    return {
      data: { ...statusline.data, per_model: perModel },
      asOf: statusline.asOf,
      source: "statusline",
      perModelAsOf: cli.asOf,
    };
  return { data: statusline.data, asOf: statusline.asOf, source: "statusline" };
}

/**
 * Burn status's reader: the merged statusline + CLI values. A CLI reading older than CLI_STALE_MS is left out
 * (burn status stamps what it gets as current). Under vitest no real file is read.
 */
export async function readMergedUsage(db: Db | null): Promise<OAuthUsageResult> {
  const now = Date.now();
  const testing = process.env.VITEST !== undefined;
  const s = testing
    ? null
    : readStatuslineLimits({ path: defaultStatuslinePath(), now: new Date(now) });
  const statusline =
    s === null
      ? null
      : {
          asOf: new Date(s.atMs).toISOString(),
          data: {
            five_hour: { utilization: s.five_hour.usedPct / 100, resets_at: s.five_hour.resetsAt },
            seven_day: { utilization: s.seven_day.usedPct / 100, resets_at: s.seven_day.resetsAt },
          },
        };
  const reading =
    testing || !cliEnabled(db) ? undefined : readCliState(defaultCliStateDir()).reading;
  const cli =
    reading !== undefined && now - Date.parse(reading.asOf) <= CLI_STALE_MS ? reading : null;
  const merged = mergeUsage(statusline, cli, now);
  if (merged === null)
    return {
      ok: false,
      reason: "No recent usage reading from the Claude Code statusline. Set it up in Settings.",
    };
  return { ok: true, data: merged.data };
}
