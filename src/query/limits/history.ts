/**
 * src/query/limits/history.ts — OV-12 U5: per-week implied max from limit_snapshots + local spend.
 *
 * Readings are grouped by limit week (resets_at rounded to the hour). Only readings ≥ 10% count.
 * A week's max comes from its last reading; its spread from its readings ≥ 50%, where whole-%
 * rounding is ≤ ±1%. A statusline reading within an hour of an api reading is dropped (api wins).
 * Spend is recomputed from turns on read: walking a week's readings in time order sums each turn
 * once, so the cost is one week-scan per week however many readings it has. Memoized until a new
 * snapshot lands.
 */

import type { Db } from "../../db/open.js";
import { REF_PRICE_U_PER_TOKEN } from "../../ingest/pricing.js";
import type { WeeklyHistoryWeek, WeightFit } from "./types.js";
import { type FitSample, fitWeights } from "./weight-fit.js";

const H = 36e5;
const WEEK = 168 * H;
/** 12 slots on the card: this week + 11 past weeks. */
const PAST_WEEKS = 11;
const MIN_PCT = 10;
const SPREAD_MIN_PCT = 50;
const NOISE_FLOOR_PCT = 3;
const FIT_READINGS_PER_WEEK = 4;

/** Family label for a model id (spec examples: "Fable", "Opus"). */
export function modelLabel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("fable")) return "Fable";
  if (m.includes("mythos")) return "Mythos";
  return model;
}

interface Reading {
  ts: string;
  usedPct: number;
  source: string;
  /** Spend by family in [reset − 7d, ts), µUSD. */
  spendU: Record<string, number>;
  totalU: number;
}
interface Week {
  resetMs: number;
  readings: Reading[]; // oldest first
}

const roundHour = (iso: string) => Math.round(Date.parse(iso) / H) * H;

/** Weeks with a reading ≥ 10% whose reset is ≥ sinceMs, each reading's spend filled in. */
function loadWeeks(db: Db, sinceMs: number): Week[] {
  const raw = db
    .prepare(
      "SELECT ts, resets_at, used_pct, source FROM limit_snapshots WHERE used_pct >= ? ORDER BY ts",
    )
    .all(MIN_PCT) as { ts: string; resets_at: string; used_pct: number; source: string }[];
  const byWeek = new Map<number, typeof raw>();
  for (const r of raw) {
    const reset = roundHour(r.resets_at);
    if (reset < sinceMs || Date.parse(r.ts) >= reset) continue;
    byWeek.set(reset, [...(byWeek.get(reset) ?? []), r]);
  }
  const sum = db.prepare(
    "SELECT model, COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns WHERE ts >= ? AND ts < ? GROUP BY model",
  );
  return [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([resetMs, rs]) => {
      // Exact readings (API era, or `claude /usage`) win over a statusline one in the same hour.
      const api = rs.filter((r) => r.source !== "statusline").map((r) => Date.parse(r.ts));
      const kept = rs.filter(
        (r) => r.source !== "statusline" || !api.some((t) => Math.abs(t - Date.parse(r.ts)) < H),
      );
      const acc: Record<string, number> = {};
      let from = new Date(resetMs - WEEK).toISOString();
      const readings = kept.map((r) => {
        const to = new Date(r.ts).toISOString();
        for (const t of sum.all(from, to) as { model: string; u: number }[]) {
          const f = modelLabel(t.model);
          acc[f] = (acc[f] ?? 0) + t.u;
        }
        from = to;
        const spendU = { ...acc };
        const totalU = Object.values(spendU).reduce((a, u) => a + u, 0);
        return { ts: r.ts, usedPct: r.used_pct, source: r.source, spendU, totalU };
      });
      return { resetMs, readings };
    });
}

const capU = (r: Reading) => r.totalU / (r.usedPct / 100);

/** n readings evenly spaced across the list, first and last included. */
function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))] as T);
}

let memo: { db: Db; key: string; weeks: Week[] } | null = null;

/** The 12 weeks up to the newest reading's week. Snapshots are insert-only, so count + newest ts is the key. */
function recentWeeks(db: Db): Week[] {
  const s = db
    .prepare("SELECT COUNT(*) AS n, MAX(ts) AS ts, MAX(resets_at) AS reset FROM limit_snapshots")
    .get() as { n: number; ts: string | null; reset: string | null };
  if (s.reset === null) return [];
  const key = `${s.n}|${s.ts}`;
  if (memo?.db !== db || memo.key !== key) {
    memo = { db, key, weeks: loadWeeks(db, roundHour(s.reset) - PAST_WEEKS * WEEK) };
  }
  return memo.weeks;
}

/**
 * Past weeks before the week resetting at `currentResetsAt`, newest first, plus the noise band:
 * the largest same-week spread, at least 3%.
 */
export function computeLimitHistory(
  db: Db,
  currentResetsAt: string,
): { history: WeeklyHistoryWeek[]; noisePct: number } {
  const current = roundHour(currentResetsAt);
  const weeks = recentWeeks(db).filter(
    (w) => w.resetMs < current && w.resetMs >= current - PAST_WEEKS * WEEK,
  );
  const history = weeks
    .flatMap((w): WeeklyHistoryWeek[] => {
      const last = w.readings.at(-1);
      if (last === undefined || last.totalU <= 0) return [];
      const max = capU(last);
      const high = w.readings.filter((r) => r.usedPct >= SPREAD_MIN_PCT && r.totalU > 0).map(capU);
      const lo = Math.min(...high);
      const hi = Math.max(...high);
      return [
        {
          resetsAt: new Date(w.resetMs).toISOString(),
          impliedMaxSpendU: max,
          impliedMaxPwTokens: max / REF_PRICE_U_PER_TOKEN,
          usedPctAtSample: last.usedPct,
          source: last.source,
          ...(high.length >= 2
            ? {
                spread: {
                  readings: high.length,
                  pct: ((hi - lo) / lo) * 100,
                  minSpendU: lo,
                  maxSpendU: hi,
                },
              }
            : {}),
        },
      ];
    })
    .reverse();
  const noisePct = Math.max(NOISE_FLOOR_PCT, ...history.map((h) => h.spread?.pct ?? 0));
  return { history, noisePct };
}

/** D6 weight fit over the 12 latest limit weeks with readings, ≤ 4 readings per week. */
export function computeWeightFit(db: Db): WeightFit {
  const samples: FitSample[] = recentWeeks(db)
    .flatMap((w) =>
      thin(w.readings, FIT_READINGS_PER_WEEK).map((r) => ({
        week: String(w.resetMs),
        usedPct: r.usedPct,
        spendByFamilyU: r.spendU,
      })),
    )
    .filter((s) => Object.values(s.spendByFamilyU).some((u) => (u ?? 0) > 0));
  return fitWeights(samples);
}
