/**
 * D8 CACHE_WRITE_CHURN quantity oracle. Written ONLY from the dh-contracts.md D8 card (and shared with B1's
 * thread/TTL helpers, which come from the B1/D8 cards). No imports from src/**.
 *
 * Graded figure: the card's "Headline (net)" (figure: "headline"). Per churn event: net = max(0, creation - base),
 * raw5 = round(net x cw5m / creation), raw1h = round(net x cw1h / creation) (cw_other dropped), each cell
 * tokens = min(round(raw x 0.64), billed cell tokens), value = tokens x max(0, tierPrice - readPrice) from the
 * turn's own snapshot (no snapshot = $0). Headline = round(sum). Only for workspaces where the finding fires.
 * The gross "Card quantity" (net x blended rate x 0.64) is still used for the 1% materiality gate.
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const WEEK_MS = 7 * 24 * 3600 * 1000;
export const TTL_5M_MIN = 5; // card: D8_TTL_5M_GAP_MIN
export const TTL_1H_MIN = 60; // card: D8_TTL_1H_GAP_MIN
const LOW_READ_RATIO = 0.2;
const EVENT_FLOOR_PCT = 0.1;
const CREATION_SPIKE_TOKENS = 50_000;
const MIN_EVENTS = 3;
const CARD_GATE_PCT = 1;
const AVOIDANCE = 0.64;
const CREATION_SHARE = 0.15;
const CAP_READ_COEFF = 0.1; // card default; the oracle does not read user_config

export interface MainTurn {
  id: string;
  session: string;
  ws: string;
  ms: number;
  in: number;
  out: number;
  read: number;
  w5: number;
  w1: number;
  wo: number;
  creation: number;
  ctx: number;
  prices: number[] | null;
}

export interface MainThreads {
  startMs: number;
  /** Settled main-thread turns per session, oldest first, everything before `now`. */
  bySession: Map<string, MainTurn[]>;
  /** Priced spend (recomputed) of all settled turns in the window, per workspace. */
  spend: Map<string, number>;
  /** Recomputed cost of every settled in-window turn. */
  cost: Map<string, number>;
}

export function loadMainThreads(db: Database.Database, now: Date): MainThreads {
  const startMs = now.getTime() - WEEK_MS;
  const rows = db
    .prepare(
      `SELECT t.message_id id, t.session_id session, t.workspace_id ws, t.ts, t.is_sidechain side,
              t.input_tokens in_t, t.output_tokens out_t, t.cache_read_tokens rd, t.cache_write_5m w5,
              t.cache_write_1h w1, t.cache_write_other wo, p.unit_prices_json pj
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE t.provisional = 0 AND t.ts < ?
       ORDER BY t.session_id, t.ts, t.message_id`,
    )
    .all(now.toISOString()) as Array<{
    id: string;
    session: string;
    ws: string;
    ts: string;
    side: number;
    in_t: number;
    out_t: number;
    rd: number;
    w5: number;
    w1: number;
    wo: number;
    pj: string | null;
  }>;
  const bySession = new Map<string, MainTurn[]>();
  const windowIds: string[] = [];
  const windowWs = new Map<string, string>();
  for (const r of rows) {
    const ms = Date.parse(r.ts);
    if (ms >= startMs) {
      windowIds.push(r.id);
      windowWs.set(r.id, r.ws);
    }
    if (r.side !== 0) continue;
    const t: MainTurn = {
      id: r.id,
      session: r.session,
      ws: r.ws,
      ms,
      in: r.in_t,
      out: r.out_t,
      read: r.rd,
      w5: r.w5,
      w1: r.w1,
      wo: r.wo,
      creation: r.w5 + r.w1 + r.wo,
      ctx: r.in_t + r.rd + r.w5 + r.w1 + r.wo,
      prices: r.pj ? (JSON.parse(r.pj) as number[]) : null,
    };
    const list = bySession.get(r.session);
    if (list) list.push(t);
    else bySession.set(r.session, [t]);
  }
  const cost = priceTurns(db, windowIds);
  const spend = new Map<string, number>();
  for (const [id, c] of cost) {
    const ws = windowWs.get(id) as string;
    spend.set(ws, (spend.get(ws) ?? 0) + c);
  }
  return { startMs, bySession, spend, cost };
}

/** Tier a turn wrote to: 1h if its 1h write is nonzero and >= its 5m write, else 5m, null if neither written. */
export function tierOf(t: MainTurn): "5m" | "1h" | null {
  if (t.w5 === 0 && t.w1 === 0) return null;
  return t.w1 > 0 && t.w1 >= t.w5 ? "1h" : "5m";
}

/** Thread cache lifetime in minutes for turn i: latest earlier writing turn's tier, else own tier, else 60. */
export function threadTtlMin(list: MainTurn[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    const tier = tierOf(list[j] as MainTurn);
    if (tier) return tier === "5m" ? TTL_5M_MIN : TTL_1H_MIN;
  }
  const own = tierOf(list[i] as MainTurn);
  if (own) return own === "5m" ? TTL_5M_MIN : TTL_1H_MIN;
  return TTL_1H_MIN;
}

/** Rewrite cost per creation token: blended write price minus read price (µ$/token). Null if unpriceable. */
export function rewriteRate(t: MainTurn): number | null {
  if (!t.prices || t.creation === 0) return null;
  const [, , pread, pw5, pw1] = t.prices as [number, number, number, number, number];
  const write = ((t.w5 + t.wo) * pw5 + t.w1 * pw1) / t.creation;
  return write - pread; // $/MTok == µ$/token
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  // Card Headline (net) step 2: even count = mean of the two middle values, rounded.
  return s.length % 2
    ? (s[m] as number)
    : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

export const oracleD8: Oracle = (db, now) => {
  const th = loadMainThreads(db, now);
  const nowMs = now.getTime();

  // Base prefix per workspace: median first-turn context of sessions whose first main turn is in the window.
  const firstCtx = new Map<string, number[]>();
  for (const list of th.bySession.values()) {
    const f = list[0] as MainTurn;
    if (f.ms >= th.startMs && f.ms < nowMs) {
      const a = firstCtx.get(f.ws);
      if (a) a.push(f.ctx);
      else firstCtx.set(f.ws, [f.ctx]);
    }
  }
  const base = new Map<string, number>();
  for (const [ws, xs] of firstCtx) base.set(ws, median(xs));

  interface Ev {
    t: MainTurn;
    net: number;
    netCost: number;
    /** Ledger value (µ$) of this event's 5m + 1h claims at 0.64, own snapshot. */
    claimValue: number;
    session: string;
  }

  /** Per-session cap-weighted tokens over ALL settled in-window turns (main + subagents), rounded per session. */
  const capRows = db
    .prepare(
      `SELECT session_id s, SUM(cache_write_5m + cache_write_1h + cache_write_other + input_tokens + output_tokens) w,
              SUM(cache_read_tokens) r
       FROM turns WHERE provisional = 0 AND ts >= ? AND ts < ? GROUP BY session_id`,
    )
    .all(new Date(th.startMs).toISOString(), now.toISOString()) as Array<{
    s: string;
    w: number;
    r: number;
  }>;
  const capWeighted = new Map<string, number>();
  for (const c of capRows) capWeighted.set(c.s, Math.round(c.w + CAP_READ_COEFF * c.r));
  const byWs = new Map<string, Ev[]>();
  for (const list of th.bySession.values()) {
    for (let i = 1; i < list.length; i++) {
      const t = list[i] as MainTurn;
      if (t.ms < th.startMs || t.ms >= nowMs) continue;
      if (t.creation <= 0) continue;
      const gapMin = (t.ms - (list[i - 1] as MainTurn).ms) / 60000;
      if (!(gapMin > threadTtlMin(list, i))) continue;
      if (!(t.read < LOW_READ_RATIO * t.creation)) continue;
      const rate = rewriteRate(t);
      const spend = th.spend.get(t.ws) ?? 0;
      if (spend > 0) {
        if (rate === null) continue;
        if (t.creation * rate < (EVENT_FLOOR_PCT / 100) * spend) continue;
      } else if (t.creation < CREATION_SPIKE_TOKENS) continue;
      const net = Math.max(0, t.creation - (base.get(t.ws) ?? 0));
      let claimValue = 0;
      if (net > 0 && t.prices) {
        const [, , pread, pw5, pw1] = t.prices as [number, number, number, number, number];
        const cell = (raw: number, billed: number, price: number): number =>
          Math.min(Math.round(raw * AVOIDANCE), billed) * Math.max(0, price - pread);
        claimValue =
          cell(Math.round((net * t.w5) / t.creation), t.w5, pw5) +
          cell(Math.round((net * t.w1) / t.creation), t.w1, pw1);
      }
      const arr = byWs.get(t.ws) ?? [];
      arr.push({ t, net, netCost: rate === null ? 0 : net * rate, claimValue, session: t.session });
      byWs.set(t.ws, arr);
    }
  }

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, evs] of byWs) {
    const churnCreation = evs.reduce((s, e) => s + e.t.creation, 0);
    let denom = 0;
    for (const sess of new Set(evs.map((e) => e.session))) denom += capWeighted.get(sess) ?? 0;
    const share = denom > 0 ? churnCreation / denom : 0;
    if (evs.length < MIN_EVENTS && !(share >= CREATION_SHARE)) continue;
    const gross = evs.reduce((s, e) => s + e.netCost, 0) * AVOIDANCE;
    const spend = th.spend.get(ws) ?? 0;
    if (!(gross > 0)) continue;
    if (spend > 0 && gross < (CARD_GATE_PCT / 100) * spend) continue;
    const headline = Math.round(evs.reduce((s, e) => s + e.claimValue, 0));
    for (const e of evs) checked.push(e.t.id);
    findings.push({
      scope: { workspace_id: ws, key: `D8|${ws}` },
      quantities: [
        { name: "churn_events", unit: "events", value: evs.length },
        {
          name: "churn_creation_tokens",
          unit: "tokens",
          value: evs.reduce((s, e) => s + e.t.creation, 0),
        },
        {
          name: "net_churn_creation_tokens",
          unit: "tokens",
          value: evs.reduce((s, e) => s + e.net, 0),
        },
        { name: "sessions", unit: "sessions", value: new Set(evs.map((e) => e.session)).size },
      ],
      measured_u: headline,
      assumptions: [
        {
          name: "D8_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "dh-contracts.md D8 card, D8_AVOIDANCE_FRACTION",
        },
        {
          name: "NO_COMPETING_CLAIMS",
          value: 0,
          source:
            "dh-contracts.md D8 card Headline assumptions: higher-priority claims (D1, D10, A1, A2, D7, D12, D6, D2) cut D8 by 0.00% on live data; oracle assumes none within +/-3%",
        },
        {
          name: "CAP_READ_COEFF",
          value: CAP_READ_COEFF,
          source: "dh-contracts.md D8 card default (user_config not read)",
        },
      ],
      modeled_u: headline,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "D8 net headline: churn events = settled main-thread in-window turns with creation>0, gap>thread TTL, " +
      "read<0.2*creation, per-event floor 0.1% of recomputed workspace spend (50k tokens if no spend); fires on " +
      ">=3 events or 15% cap-weighted creation share, and gross modelled saving >=1% of spend. " +
      "Headline = per-cell ledger claims (net x 0.64, capped at billed, own snapshot), no competing claims assumed. " +
      "Spend denominators are recomputed via priceTurns, not turns.cost_equiv_u.",
  };
};
