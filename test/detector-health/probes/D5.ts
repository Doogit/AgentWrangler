/**
 * D5 LIMIT_BURN_FORECAST silence probe. Written from the dh-contracts.md D5 card only.
 * Reads limit_snapshots and user_config (non-transcript, allowed for D5) and turns token columns.
 *
 * Derivation rules (paths tried in order, as on the card):
 * 1. Snapshot: latest limit_snapshots row with ts <= now, resets_at > now, used_pct not null; usable if
 *    now - ts <= 48h. No forecast when < 6h of the week (reset - 7d) have passed at the latest reading.
 *    Pace = rise in used_pct over the 24h before the latest reading (from the reset if sooner). Used % at
 *    that start is read between the same-week readings around it (|resets_at diff| < 1h; the reset is
 *    0%), split by cap-weighted turn tokens on each side, or by time when there are none (REL-FIX pace:
 *    a 3h..36h-gap reference read a 5h burst as the day's pace — the D5 card predates this).
 *    Projected = used + pace x hours from the latest reading to its reset (card says "hours to reset";
 *    reading-to-reset is used, which is what the DH1 positive fixture assumes - ambiguity logged).
 *    Fires when used >= 100 or projected >= 85. A usable snapshot never falls through.
 * 2. No usable snapshot, user_config limit_tokens > 0: cap-weighted tokens over [now-7d, now)
 *    (input + output + all cache writes + cap_read_coeff x cache reads, default 0.1; weights other than the
 *    read coefficient assumed 1; settled and provisional turns). Fires when used >= limit or ETA days <= 2
 *    where ETA = (limit - used) / (used / elapsed days since first turn in window); elapsed < 0.25d is silent.
 * 3. Neither: degraded fires when >= 1 turn in the last 1 day or the 7 days before that.
 */

import type { Probe, ProbeGate } from "./types.js";

const H = 3_600_000;
const DAY = 24 * H;

function gate(
  name: string,
  value: number | null,
  threshold: number,
  op: ProbeGate["op"],
): ProbeGate {
  let pass = false;
  if (value !== null) {
    pass =
      op === ">"
        ? value > threshold
        : op === ">="
          ? value >= threshold
          : op === "<"
            ? value < threshold
            : value <= threshold;
  }
  return { name, value, threshold, op, pass };
}

interface Snap {
  ts: string;
  resets_at: string;
  used_pct: number;
}

export const probeD5: Probe = (db, now) => {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const snaps = db
    .prepare(
      "SELECT ts, resets_at, used_pct FROM limit_snapshots WHERE ts <= ? AND resets_at IS NOT NULL AND used_pct IS NOT NULL ORDER BY ts",
    )
    .all(nowIso) as Snap[];
  const live = snaps.filter((s) => Date.parse(s.resets_at) > nowMs);
  const latest = live[live.length - 1];

  if (latest && nowMs - Date.parse(latest.ts) <= 48 * H) {
    const latestMs = Date.parse(latest.ts);
    const resetMs = Date.parse(latest.resets_at);
    const weekStartMs = resetMs - 7 * DAY;
    const startMs = Math.max(weekStartMs, latestMs - DAY);
    let before = { ms: weekStartMs, pct: 0 };
    let after = { ms: latestMs, pct: latest.used_pct };
    for (const s of live) {
      const ms = Date.parse(s.ts);
      if (Math.abs(Date.parse(s.resets_at) - resetMs) >= H || ms < weekStartMs || ms >= latestMs)
        continue;
      if (ms <= startMs) before = { ms, pct: s.used_pct };
      else if (ms < after.ms) after = { ms, pct: s.used_pct };
    }
    const burn = (fromMs: number, toMs: number): number =>
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write_5m + cache_write_1h + cache_write_other + 0.1 * cache_read_tokens),0) AS u FROM turns WHERE ts >= ? AND ts < ?",
          )
          .get(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as { u: number }
      ).u;
    let pace: number | null = null;
    if (latestMs - weekStartMs >= 6 * H) {
      const total = burn(before.ms, after.ms);
      const frac =
        startMs <= before.ms
          ? 0
          : total > 0
            ? burn(before.ms, startMs) / total
            : (startMs - before.ms) / (after.ms - before.ms);
      const startPct = before.pct + (after.pct - before.pct) * frac;
      pace = Math.max(0, (latest.used_pct - startPct) / ((latestMs - startMs) / H));
    }
    const hoursToReset = (resetMs - latestMs) / H;
    const projected = pace === null ? null : latest.used_pct + pace * hoursToReset;
    const gates = [
      gate("EXCEED_PROJECTED_PCT (used %)", latest.used_pct, 100, ">="),
      gate("WARN_PROJECTED_PCT (projected %)", projected, 85, ">="),
    ];
    return {
      candidates: 1,
      qualifying: gates.some((g) => g.pass) ? 1 : 0,
      gates,
      note: `D5 snapshot path: usable latest reading (age ${((nowMs - latestMs) / H).toFixed(2)}h, pace ${pace === null ? "n/a" : pace.toFixed(4)} %/h over the ${((latestMs - startMs) / H).toFixed(1)}h before the reading, ${hoursToReset.toFixed(1)}h reading-to-reset). No fall-through to other paths.`,
    };
  }

  const cfg = db
    .prepare("SELECT key, value FROM user_config WHERE key IN ('limit_tokens','cap_read_coeff')")
    .all() as {
    key: string;
    value: string | null;
  }[];
  const cfgMap = new Map(cfg.map((r) => [r.key, r.value]));
  const limit = Number(cfgMap.get("limit_tokens"));
  const coeffRaw = cfgMap.get("cap_read_coeff");
  const coeff =
    coeffRaw !== null && coeffRaw !== undefined && Number.isFinite(Number(coeffRaw))
      ? Number(coeffRaw)
      : 0.1;

  if (Number.isFinite(limit) && limit > 0 && cfgMap.get("limit_tokens") !== null) {
    const from = new Date(nowMs - 7 * DAY).toISOString();
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(ts) AS first,
                COALESCE(SUM(input_tokens + output_tokens + cache_write_5m + cache_write_1h + cache_write_other + ? * cache_read_tokens),0) AS used
         FROM turns WHERE ts >= ? AND ts < ?`,
      )
      .get(coeff, from, nowIso) as { n: number; first: string | null; used: number };
    const elapsedDays = r.first ? (nowMs - Date.parse(r.first)) / DAY : 0;
    let eta: number | null = null;
    if (r.n > 0 && elapsedDays >= 0.25 && r.used > 0)
      eta = (limit - r.used) / (r.used / elapsedDays);
    const gates = [
      gate("limit exceeded (used tokens)", r.used, limit, ">="),
      gate("DEFAULT_WARN_THRESHOLD_DAYS (ETA days)", eta, 2, "<="),
      gate("ELAPSED_FLOOR_DAYS", elapsedDays, 0.25, ">="),
    ];
    return {
      candidates: r.n > 0 ? 1 : 0,
      qualifying: r.used >= limit || (eta !== null && eta <= 2) ? 1 : 0,
      gates,
      note: "D5 token-limit path: no usable snapshot, limit_tokens configured; cap-weighted tokens over trailing 7d (cache reads x cap_read_coeff).",
    };
  }

  const recentFrom = new Date(nowMs - DAY).toISOString();
  const baseFrom = new Date(nowMs - 8 * DAY).toISOString();
  const recent = (
    db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE ts >= ? AND ts < ?")
      .get(recentFrom, nowIso) as { n: number }
  ).n;
  const base = (
    db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE ts >= ? AND ts < ?")
      .get(baseFrom, recentFrom) as { n: number }
  ).n;
  return {
    candidates: recent + base > 0 ? 1 : 0,
    qualifying: recent + base > 0 ? 1 : 0,
    gates: [gate("degraded path turns (last 1d + prior 7d)", recent + base, 1, ">=")],
    note: "D5 degraded path: no usable snapshot and no token limit; fires on any turn in the last 1 day or the 7 days before.",
  };
};
