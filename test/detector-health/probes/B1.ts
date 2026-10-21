/**
 * DH2 probe B1 CACHE_READ_COLLAPSE_V2, written from docs/plans/dh-contracts.md card B1 only.
 * Also exports the shared collapse-pair recount used by the B2 and B4 probes (same four-part test).
 * Reads base `turns` + `pricing_snapshots` columns only; no detector-written tables, no classifiers.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate, ProbeResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60_000;
/** List-price fallback ($/MTok: in, out, cacheRead, cw5m, cw1h) when a turn has no snapshot. */
const FALLBACK_PRICES = [3, 15, 0.3, 3.75, 6];

export interface PTurn {
  ws: string;
  session: string;
  thread: string;
  ms: number;
  ctx: number;
  reads: number;
  w5: number;
  w1: number;
  wo: number;
  creation: number;
  costU: number | null;
  prices: number[];
}

export interface Pair {
  ws: string;
  prev: PTurn;
  cur: PTurn;
  gapMin: number;
  ttlMin: number;
  rewriteU: number;
  /** Rewrite cost as a percent of the workspace's window spend; null when spend is unknown. */
  pct: number | null;
}

export interface Workspace {
  threads: Map<string, PTurn[]>;
  /** Window spend in micro-dollars (sum of turns.cost_equiv_u in window); 0 = unknown. */
  spendU: number;
}

export function isCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/** Tier of one turn: 60 (1h) if 1h write > 0 and >= 5m write, 5 if any tier written, else null. */
export function tierMin(t: PTurn): number | null {
  if (t.w1 > 0 && t.w1 >= t.w5) return 60;
  if (t.w5 > 0 || t.w1 > 0) return 5;
  return null;
}

/** Thread TTL: latest earlier turn that wrote a tier, else the later turn's own tier, else 60. */
export function ttlFor(thread: PTurn[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    const t = tierMin(thread[j] as PTurn);
    if (t !== null) return t;
  }
  return tierMin(thread[i] as PTurn) ?? 60;
}

/** Write price minus read price, per token, in micro-dollars (token-weighted over tiers). */
export function netPriceU(t: PTurn): number {
  const [read, p5, p1] = [t.prices[2] ?? 0, t.prices[3] ?? 0, t.prices[4] ?? 0];
  if (t.creation <= 0) return p5 - read;
  const write = ((t.w5 + t.wo) * p5 + t.w1 * p1) / t.creation;
  return write - read;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Load every settled (provisional = 0) turn before `now`, grouped workspace -> thread. */
export function loadWorkspaces(db: Database.Database, now: Date): Map<string, Workspace> {
  const from = now.getTime() - 7 * DAY_MS;
  const snaps = new Map<string, number[]>();
  const tiers = new Map<string, number[]>();
  for (const r of db
    .prepare("SELECT snapshot_id, model_tier, unit_prices_json FROM pricing_snapshots")
    .all() as { snapshot_id: string; model_tier: string; unit_prices_json: string }[]) {
    try {
      const p = JSON.parse(r.unit_prices_json) as number[];
      if (Array.isArray(p) && p.length >= 5) {
        snaps.set(r.snapshot_id, p);
        tiers.set(r.model_tier.toLowerCase(), p);
      }
    } catch {
      /* unparseable price row: fall through to fallback */
    }
  }
  const rows = db
    .prepare(
      `SELECT message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
              input_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
              cost_equiv_u, pricing_snapshot_id
         FROM turns WHERE provisional = 0 ORDER BY ts, message_id`,
    )
    .all() as {
    message_id: string;
    session_id: string;
    workspace_id: string;
    ts: string;
    model: string;
    is_sidechain: number;
    agent_id: string | null;
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_5m: number;
    cache_write_1h: number;
    cache_write_other: number;
    cost_equiv_u: number | null;
    pricing_snapshot_id: string | null;
  }[];
  const out = new Map<string, Workspace>();
  for (const r of rows) {
    const ms = Date.parse(r.ts);
    if (Number.isNaN(ms) || ms >= now.getTime()) continue;
    const ws = out.get(r.workspace_id) ?? { threads: new Map(), spendU: 0 };
    out.set(r.workspace_id, ws);
    if (ms >= from && r.cost_equiv_u !== null) ws.spendU += r.cost_equiv_u;
    const tierPrice = [...tiers.entries()].find(([k]) => r.model.toLowerCase().includes(k))?.[1];
    const prices =
      (r.pricing_snapshot_id ? snaps.get(r.pricing_snapshot_id) : undefined) ??
      tierPrice ??
      FALLBACK_PRICES;
    const t: PTurn = {
      ws: r.workspace_id,
      session: r.session_id,
      thread: `${r.session_id}|${r.is_sidechain}|${r.agent_id ?? ""}`,
      ms,
      ctx:
        r.input_tokens +
        r.cache_read_tokens +
        r.cache_write_5m +
        r.cache_write_1h +
        r.cache_write_other,
      reads: r.cache_read_tokens,
      w5: r.cache_write_5m,
      w1: r.cache_write_1h,
      wo: r.cache_write_other,
      creation: r.cache_write_5m + r.cache_write_1h + r.cache_write_other,
      costU: r.cost_equiv_u,
      prices,
    };
    // Main thread only: sidechain (subagent) turns count toward spend but never form pairs.
    if (r.is_sidechain === 0) {
      const list = ws.threads.get(t.thread) ?? [];
      list.push(t);
      ws.threads.set(t.thread, list);
    }
  }
  return out;
}

/** Four-part collapse test between two consecutive turns of one thread. */
export function isCollapse(prev: PTurn, cur: PTurn): boolean {
  const counts = [prev.ctx, prev.reads, prev.creation, cur.ctx, cur.reads, cur.creation];
  if (!counts.every(isCount)) return false;
  return (
    prev.ctx > 0 &&
    prev.reads > 0 &&
    cur.creation >= 0.5 * prev.ctx &&
    cur.reads < 0.5 * prev.reads &&
    cur.ctx >= 0.9 * prev.ctx
  );
}

/** Collapse-shaped pairs with cur in the window, for any gap (callers filter gap vs TTL). */
export function collapsePairs(wss: Map<string, Workspace>, now: Date): Pair[] {
  const from = now.getTime() - 7 * DAY_MS;
  const pairs: Pair[] = [];
  for (const [wsId, ws] of wss) {
    for (const thread of ws.threads.values()) {
      for (let i = 1; i < thread.length; i++) {
        const cur = thread[i] as PTurn;
        if (cur.ms < from) continue;
        const prev = thread[i - 1] as PTurn;
        if (!isCollapse(prev, cur)) continue;
        const rewriteU = cur.creation * netPriceU(cur);
        pairs.push({
          ws: wsId,
          prev,
          cur,
          gapMin: (cur.ms - prev.ms) / MIN_MS,
          ttlMin: ttlFor(thread, i),
          rewriteU,
          pct: ws.spendU > 0 ? (rewriteU / ws.spendU) * 100 : null,
        });
      }
    }
  }
  return pairs;
}

export const floorPasses = (p: Pair): boolean => p.pct === null || p.pct >= 0.1;

/** Shape the result from per-workspace pair lists: gates come from the best workspace. */
export function summarize(
  candidatePairs: Pair[],
  qualifies: (p: Pair) => boolean,
  extraGates: (best: Pair) => ProbeGate[],
  note: string,
): ProbeResult {
  const cands = new Set(candidatePairs.map((p) => p.ws));
  const qual = new Set(candidatePairs.filter(qualifies).map((p) => p.ws));
  const pool = candidatePairs.filter(qualifies);
  const best = (pool.length ? pool : candidatePairs).sort(
    (a, b) => (b.pct ?? Number.POSITIVE_INFINITY) - (a.pct ?? Number.POSITIVE_INFINITY),
  )[0];
  const gates: ProbeGate[] = best
    ? [
        {
          name: "EVENT_FLOOR_PCT",
          value: best.pct,
          threshold: 0.1,
          op: ">=",
          pass: floorPasses(best),
        },
        ...extraGates(best),
      ]
    : [];
  return { candidates: cands.size, qualifying: qual.size, gates, note };
}

export const probeB1: Probe = (db, now) => {
  const pairs = collapsePairs(loadWorkspaces(db, now), now);
  return summarize(
    pairs,
    (p) => p.gapMin >= 0 && p.gapMin <= p.ttlMin && floorPasses(p),
    (b) => [
      {
        name: "GAP_MIN_VS_TTL",
        value: b.gapMin,
        threshold: b.ttlMin,
        op: "<=",
        pass: b.gapMin <= b.ttlMin,
      },
    ],
    "Candidates/qualifying = workspaces. Derived from raw turns (provisional=0, main thread = is_sidechain 0, " +
      "thread = session+agent_id). Collapse: prev ctx>0 & reads>0, cur creation(5m+1h+other)>=0.5*prev ctx, " +
      "cur reads<0.5*prev reads, cur ctx>=0.9*prev ctx, counts non-negative ints. Candidate = collapse pair " +
      "with cur in [now-7d,now), any gap. Qualifying = gap<=TTL (latest earlier write tier: 1h if 1h>0 and >=5m, " +
      "else 5m; else own tier; else 60) and event floor: creation*(token-weighted write price - read price) " +
      ">=0.1% of window sum(cost_equiv_u) (unknown/zero spend passes). Prices from pricing_snapshots by " +
      "turn snapshot id, else model-tier match, else list fallback.",
  );
};
