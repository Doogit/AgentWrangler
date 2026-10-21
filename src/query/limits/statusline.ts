/**
 * src/query/limits/statusline.ts — usage-limits fallback from the Claude Code statusline (OV-7).
 *
 * Claude Code pipes JSON to the user's statusline command, including
 * `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` (used_percentage 0–100,
 * resets_at = Unix epoch SECONDS — code.claude.com/docs/en/statusline). `agentwrangler statusline`
 * (src/cli/statusline.ts) writes `{ at, rate_limits }` to ~/.agentwrangler/statusline-limits.json. Only the
 * percentages and reset times are stored (SEC-101). This module reads it back; it never throws.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuthUsageResult } from "../../oauth/usage.js";
import { isStatuslineInstalled } from "./statusline-install.js";

/**
 * A statusline file older than this is not shown. The statusline refreshes on every assistant
 * message, so a 30-minute-old value means the user has been idle or the script stopped writing;
 * the 5-hour window can move several points in that time, and showing it as current would be a
 * lie. Older than this the card says "unavailable" instead.
 */
export const STATUSLINE_MAX_AGE_MS = 30 * 60_000;
/** Clock-skew allowance for an `at` slightly in the future. */
const FUTURE_SKEW_MS = 5 * 60_000;

export function defaultStatuslinePath(home: string = os.homedir()): string {
  return path.join(home, ".agentwrangler", "statusline-limits.json");
}

/**
 * The manual alternative to the Install button: a statusLine command that prints the status line and
 * writes the limits file (src/cli/statusline.ts). Needs `agentwrangler` on PATH (npm i -g agentwrangler).
 */
export const STATUSLINE_SNIPPET = "agentwrangler statusline";

export interface StatuslineWindow {
  usedPct: number; // 0–100
  /** ISO, or null when the statusline reported no active window. */
  resetsAt: string | null;
}

export interface StatuslineLimits {
  atMs: number;
  five_hour: StatuslineWindow;
  seven_day: StatuslineWindow;
}

function parseWindow(w: unknown): StatuslineWindow | null {
  const v = w as { used_percentage?: unknown; resets_at?: unknown } | null;
  if (typeof v?.used_percentage !== "number" || !Number.isFinite(v.used_percentage)) return null;
  const r = v.resets_at;
  if (r === null || r === undefined) {
    return { usedPct: Math.min(100, Math.max(0, v.used_percentage)), resetsAt: null };
  }
  if (typeof r !== "number" || !Number.isFinite(r)) return null;
  return {
    usedPct: Math.min(100, Math.max(0, v.used_percentage)),
    resetsAt: new Date(r * 1000).toISOString(),
  };
}

/** Parse the file's shape only (no age check). Null when absent or malformed. */
export function loadStatuslineFile(filePath: string): StatuslineLimits | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      at?: unknown;
      rate_limits?: { five_hour?: unknown; seven_day?: unknown };
    };
    const atMs = typeof parsed.at === "number" ? parsed.at : Date.parse(String(parsed.at));
    if (!Number.isFinite(atMs)) return null;
    const five = parseWindow(parsed.rate_limits?.five_hour);
    const seven = parseWindow(parsed.rate_limits?.seven_day);
    if (five === null || seven === null) return null;
    return { atMs, five_hour: five, seven_day: seven };
  } catch {
    return null;
  }
}

function isFresh(s: StatuslineLimits, now: Date): boolean {
  const age = now.getTime() - s.atMs;
  return age <= STATUSLINE_MAX_AGE_MS && age >= -FUTURE_SKEW_MS;
}

/**
 * The file's values if usable now: well-formed, within STATUSLINE_MAX_AGE_MS, and neither window
 * already past its reset (that percentage belongs to a window that has since rolled over).
 */
export function readStatuslineLimits(o: { path: string; now: Date }): StatuslineLimits | null {
  const s = loadStatuslineFile(o.path);
  if (s === null || !isFresh(s, o.now)) return null;
  for (const w of [s.five_hour, s.seven_day]) {
    if (w.resetsAt !== null && Date.parse(w.resetsAt) <= o.now.getTime()) return null;
  }
  return s;
}

/**
 * OAUTH-1: the usage reader. Anthropic's terms bar third-party apps from using the Claude Code OAuth
 * token, so usage comes only from the statusline file. Under vitest with no path the real file is
 * never read, so a developer's own statusline can't leak into tests.
 */
export async function readStatuslineUsage(
  filePath: string | null = process.env.VITEST === undefined ? defaultStatuslinePath() : null,
): Promise<OAuthUsageResult> {
  const s = filePath === null ? null : readStatuslineLimits({ path: filePath, now: new Date() });
  if (s === null) {
    return {
      ok: false,
      reason: "No recent usage reading from the Claude Code statusline. Set it up in Settings.",
    };
  }
  return {
    ok: true,
    data: {
      five_hour: { utilization: s.five_hour.usedPct / 100, resets_at: s.five_hour.resetsAt },
      seven_day: { utilization: s.seven_day.usedPct / 100, resets_at: s.seven_day.resetsAt },
    },
  };
}

export interface StatuslineStatus {
  state: "found" | "stale" | "not-set-up";
  ageSec: number | null;
  snippet: string;
  /** settings.json's statusLine already runs `agentwrangler statusline` (OV-7b). */
  installed?: boolean;
}

/** Settings → Usage tracking: is the statusline writing, and how long ago. */
export function getStatuslineStatus(
  o: { path?: string; now?: Date; settingsPath?: string } = {},
): StatuslineStatus {
  const now = o.now ?? new Date();
  const installed = isStatuslineInstalled(o.settingsPath);
  const s = loadStatuslineFile(o.path ?? defaultStatuslinePath());
  if (s === null)
    return { state: "not-set-up", ageSec: null, snippet: STATUSLINE_SNIPPET, installed };
  return {
    state: isFresh(s, now) ? "found" : "stale",
    ageSec: Math.max(0, Math.round((now.getTime() - s.atMs) / 1000)),
    snippet: STATUSLINE_SNIPPET,
    installed,
  };
}
