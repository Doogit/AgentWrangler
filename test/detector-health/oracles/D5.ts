/**
 * D5 LIMIT_BURN_FORECAST count oracle, from the dh-contracts.md D5 card only. Global: emits one finding
 * (count 1 = one warning) when the card's first applicable path fires, none otherwise.
 * Path 1 (usable snapshot) never falls through. Paths 2 and 3 apply only with no usable snapshot.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleResult } from "./types.js";

const H = 3_600_000;
const DAY = 86_400_000;
const WARN_PCT = 85;
const EXCEED_PCT = 100;
const SNAP_MAX_AGE = 48 * H;
const MIN_ELAPSED_AVG = 6 * H;
const WARN_DAYS = 2;
const ELAPSED_FLOOR_DAYS = 0.25;

interface Snap {
  ts: string;
  resets_at: string | null;
  used_pct: number | null;
}

const fire = (note: string, q: Array<{ name: string; value: number }>): OracleResult => ({
  findings: [
    {
      scope: { workspace_id: null, key: "D5|global" },
      quantities: q.map((x) => ({ ...x, unit: "count" as const })),
      measured_u: null,
      assumptions: [],
      modeled_u: null,
      count: 1,
    },
  ],
  turns_checked: [],
  note,
});
const silent = (note: string): OracleResult => ({ findings: [], turns_checked: [], note });

export const oracleD5: Oracle = (db: Database.Database, now: Date) => {
  const nowMs = now.getTime();
  const snaps = db
    .prepare("SELECT ts, resets_at, used_pct FROM limit_snapshots WHERE ts <= ? ORDER BY ts DESC")
    .all(now.toISOString()) as Snap[];

  // Path 1: latest reading at/before now, reset in the future, used% present, no older than 48h.
  const latest = snaps[0];
  const usable =
    latest !== undefined &&
    latest.resets_at !== null &&
    Date.parse(latest.resets_at) > nowMs &&
    latest.used_pct !== null &&
    nowMs - Date.parse(latest.ts) <= SNAP_MAX_AGE;
  if (usable) {
    const resetMs = Date.parse(latest.resets_at as string);
    const used = latest.used_pct as number;
    const latestMs = Date.parse(latest.ts);
    const hoursToReset = (resetMs - nowMs) / H;
    const weekStart = resetMs - 7 * DAY;
    const elapsed = latestMs - weekStart;
    if (elapsed < MIN_ELAPSED_AVG) return silent("snapshot path: < 6h into week, no forecast");

    const coeffS = (() => {
      const v = db.prepare("SELECT value FROM user_config WHERE key = 'cap_read_coeff'").get() as
        | { value: string | null }
        | undefined;
      return v?.value == null ? 0.1 : Number(v.value);
    })();
    const burn = (fromMs: number, toMs: number): number =>
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write_5m + cache_write_1h + cache_write_other
                                 + ? * cache_read_tokens), 0) b
             FROM turns WHERE ts >= ? AND ts < ?`,
          )
          .get(coeffS, new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as {
          b: number;
        }
      ).b;

    // Same-week readings with a used %, older than the latest one (oldest first).
    const earlier = snaps
      .slice(1)
      .filter(
        (s) =>
          s.resets_at !== null &&
          s.used_pct !== null &&
          Math.abs(Date.parse(s.resets_at) - resetMs) < H &&
          Date.parse(s.ts) < latestMs,
      )
      .reverse();

    const windowMs = Math.min(DAY, elapsed);
    const startMs = latestMs - windowMs;
    let startUsed: number;
    if (earlier.length === 0) {
      // No earlier reading: week-to-date average.
      startUsed = used - (used / (elapsed / H)) * (windowMs / H);
    } else {
      // Anchors around the window start; the reset (week start) counts as 0%.
      let lo = { ms: weekStart, pct: 0 };
      for (const s of earlier) {
        if (Date.parse(s.ts) <= startMs) lo = { ms: Date.parse(s.ts), pct: s.used_pct as number };
      }
      let hi = { ms: latestMs, pct: used };
      for (const s of earlier) {
        if (Date.parse(s.ts) > startMs) {
          hi = { ms: Date.parse(s.ts), pct: s.used_pct as number };
          break;
        }
      }
      if (lo.ms === startMs) startUsed = lo.pct;
      else {
        const total = burn(lo.ms, hi.ms);
        const frac = total > 0 ? burn(lo.ms, startMs) / total : (startMs - lo.ms) / (hi.ms - lo.ms);
        startUsed = lo.pct + (hi.pct - lo.pct) * frac;
      }
    }
    const pace = (used - startUsed) / (windowMs / H);
    const projected = used + pace * hoursToReset;
    const q = [
      { name: "used_pct", value: used },
      { name: "projected_pct", value: Math.round(projected * 10) / 10 },
    ];
    if (used >= EXCEED_PCT || projected >= WARN_PCT)
      return fire(`snapshot path fires: used ${used}%, projected ${projected.toFixed(1)}%`, q);
    return silent(
      `snapshot path: projected ${projected.toFixed(1)}% < ${WARN_PCT}, inactive (no fallthrough)`,
    );
  }

  // Path 2: token limit configured -> cap-weighted tokens over the last 7 days.
  const cfg = (key: string): string | null =>
    (
      db.prepare("SELECT value FROM user_config WHERE key = ?").get(key) as
        | { value: string | null }
        | undefined
    )?.value ?? null;
  const limit = Number(cfg("limit_tokens"));
  const coeff = cfg("cap_read_coeff") === null ? 0.1 : Number(cfg("cap_read_coeff"));
  const from7 = new Date(nowMs - 7 * DAY).toISOString();
  if (Number.isFinite(limit) && limit > 0) {
    const r = db
      .prepare(
        `SELECT MIN(ts) first_ts,
                COALESCE(SUM(input_tokens + output_tokens + cache_write_5m + cache_write_1h + cache_write_other
                             + ? * cache_read_tokens), 0) used
         FROM turns WHERE ts >= ? AND ts < ?`,
      )
      .get(coeff, from7, now.toISOString()) as { first_ts: string | null; used: number };
    if (r.first_ts === null) return silent("token path: no turns, no burn");
    const elapsedDays = (nowMs - Date.parse(r.first_ts)) / DAY;
    const q = [{ name: "cap_weighted_tokens", value: Math.round(r.used) }];
    if (r.used >= limit) return fire("token path EXCEEDED", q);
    if (elapsedDays < ELAPSED_FLOOR_DAYS) return silent("token path COLD_START");
    if (r.used <= 0) return silent("token path no burn");
    const eta = (limit - r.used) / (r.used / elapsedDays);
    return eta <= WARN_DAYS
      ? fire(`token path WARNING eta ${eta.toFixed(2)}d`, q)
      : silent("token path OK");
  }

  // Path 3: degraded burn trend: any turn in the last 1 day or the 7 days before that.
  const n = (
    db
      .prepare("SELECT COUNT(*) n FROM turns WHERE ts >= ? AND ts < ?")
      .get(new Date(nowMs - 8 * DAY).toISOString(), now.toISOString()) as { n: number }
  ).n;
  return n > 0
    ? fire("degraded path fires", [{ name: "turns_in_8d", value: n }])
    : silent("blocked: no snapshot, no limit, no turns");
};
