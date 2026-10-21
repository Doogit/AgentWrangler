/**
 * D2 SESSION_LONG_FULL_CONTEXT probe. Written from the D2 contract card only.
 * Reads base `turns` (+ pricing_snapshots) only. A session qualifies with > 150 settled main-thread
 * turns in the window and mean context_tokens > 180000 over those turns.
 */

import type Database from "better-sqlite3";
import type { Probe } from "./types.js";

const TURNS = 150;
const AVG_CTX = 180_000;
const MIN_SESSIONS = 3;
const MIN_PCT = 1;
const CALLS_PER_SPLIT = 150;
const SUMMARY_TOKENS = 2000;
const FALLBACK_PRICES = [3, 15, 0.3, 3.75, 6]; // $/MTok [in,out,cacheRead,cw5m,cw1h] when no snapshot

interface T {
  session_id: string;
  ts: string;
  ctx: number;
  cost: number | null;
  prices: string | null;
}

function prices(p: string | null): number[] {
  if (!p) return FALLBACK_PRICES;
  try {
    const a = JSON.parse(p) as unknown;
    return Array.isArray(a) && a.length >= 4 ? (a as number[]) : FALLBACK_PRICES;
  } catch {
    return FALLBACK_PRICES;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0
    ? 0
    : s.length % 2
      ? (s[m] as number)
      : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export const probeD2: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT t.session_id, t.ts, t.context_tokens AS ctx, t.cost_equiv_u AS cost,
              p.unit_prices_json AS prices
         FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
        WHERE t.provisional = 0 AND t.is_sidechain = 0 AND t.ts >= ? AND t.ts < ?
        ORDER BY t.session_id, t.ts, t.rowid`,
    )
    .all(from, to) as T[];
  const allSpend = db
    .prepare(
      "SELECT COALESCE(SUM(cost_equiv_u),0) AS s FROM turns WHERE provisional = 0 AND ts >= ? AND ts < ?",
    )
    .get(from, to) as { s: number };

  const bySession = new Map<string, T[]>();
  for (const r of rows) {
    const list = bySession.get(r.session_id) ?? [];
    list.push(r);
    bySession.set(r.session_id, list);
  }

  // Relaxed candidate: a session with many turns OR a big average (either clause).
  let candidates = 0;
  const qualified: T[][] = [];
  for (const list of bySession.values()) {
    const avg = list.reduce((a, t) => a + t.ctx, 0) / list.length;
    if (list.length > TURNS || avg > AVG_CTX) candidates++;
    if (list.length > TURNS && avg > AVG_CTX) qualified.push(list);
  }

  // Base prefix: median context of the first main turn of sessions that started in the window.
  const starts = db
    .prepare(
      `SELECT t.session_id, t.context_tokens AS ctx, t.ts FROM turns t
        WHERE t.provisional = 0 AND t.is_sidechain = 0
          AND t.ts = (SELECT MIN(u.ts) FROM turns u WHERE u.session_id = t.session_id
                       AND u.provisional = 0 AND u.is_sidechain = 0)
        GROUP BY t.session_id`,
    )
    .all() as { session_id: string; ctx: number; ts: string }[];
  const base = median(starts.filter((s) => s.ts >= from && s.ts < to).map((s) => s.ctx));

  // Net saving model: split every 150 calls; after a split, context restarts at base + summary and
  // regrows by the same per-turn growth. Saved cache-read tokens priced at the turn's cache-read
  // price; each split re-writes (base + summary) tokens at the cache-write (5m) price.
  let grossU = 0;
  let rebuildU = 0;
  for (const list of qualified) {
    let segStart = list[0] as T;
    list.forEach((t, i) => {
      if (i > 0 && i % CALLS_PER_SPLIT === 0) {
        segStart = t;
        rebuildU += (base + SUMMARY_TOKENS) * (prices(t.prices)[3] ?? 0);
      }
      const after = Math.min(t.ctx, base + SUMMARY_TOKENS + (t.ctx - segStart.ctx));
      grossU += (t.ctx - after) * (prices(t.prices)[2] ?? 0);
    });
  }
  const netU = Math.max(0, grossU - rebuildU);
  const pct = allSpend.s > 0 ? (netU / allSpend.s) * 100 : null;
  const spendOk = pct === null || pct >= MIN_PCT;
  const sessionsOk = qualified.length >= MIN_SESSIONS;

  return {
    candidates,
    // The spend gate depends on the detector's undocumented derived reduction fraction, so it is
    // reported (gates[]) but does not zero `qualifying`; the orchestrator grades it.
    qualifying: sessionsOk ? qualified.length : 0,
    gates: [
      {
        name: "D2_MIN_QUALIFYING_SESSIONS",
        value: qualified.length,
        threshold: MIN_SESSIONS,
        op: ">=",
        pass: sessionsOk,
      },
      { name: "D2_MIN_PCT_OF_SPEND", value: pct, threshold: MIN_PCT, op: ">=", pass: spendOk },
    ],
    note:
      "Per session: settled (provisional=0) main-thread (is_sidechain=0) turns in window; qualifies when " +
      "count > 150 and mean context_tokens > 180000. Spend gate uses my own net-saving model (split every 150 " +
      "calls, context restarts at median first-turn base + 2000 summary, savings at cache-read price minus " +
      "rebuild at cache-write price); the card does not define the detector's derived reduction fraction, so " +
      "this gate value is approximate and NOT applied to `qualifying` (only the >=3 sessions clause is). Spend pct passes when global window spend is 0.",
  };
};
