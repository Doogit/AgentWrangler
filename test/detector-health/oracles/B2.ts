/**
 * B2 TTL_GAP_MISS_V2 count oracle. Written ONLY from the dh-contracts.md B2 card (and the B1/B3 shared
 * definitions it points to). No imports from src/**.
 * Graded figure "count": the number of qualifying pairs per workspace (the card's RESUME_COUNT, F29).
 * B2 has no $ (D8 owns it), so the other stored figures ride in quantities for the secondary check.
 */

import { type MainTurn, loadMainThreads, oracleD8, rewriteRate, threadTtlMin } from "./D8.js";
import type { Oracle, OracleFinding } from "./types.js";

const MIN_CREATION_SHARE = 0.5;
const READ_FALL_SHARE = 0.5;
const SHRINK_GUARD = 0.9;
const EVENT_FLOOR_PCT = 0.1;

/** Card base-prefix definition: median first-turn context (in, read, 5m, 1h, other); even = rounded mean. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2
    ? (s[m] as number)
    : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

export const oracleB2: Oracle = (db, now) => {
  const th = loadMainThreads(db, now);
  const nowMs = now.getTime();

  // Base prefix per workspace: sessions whose first settled main turn is in [now-7d, now).
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

  interface Pair {
    t: MainTurn;
    p: MainTurn;
    gapMs: number;
    ttlMin: number;
    session: string;
  }
  const byWs = new Map<string, Pair[]>();
  const sessions = [...th.bySession.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const sess of sessions) {
    const list = th.bySession.get(sess) as MainTurn[];
    for (let i = 1; i < list.length; i++) {
      const t = list[i] as MainTurn;
      const p = list[i - 1] as MainTurn;
      if (t.ms < th.startMs || t.ms >= nowMs) continue; // only the later turn must be in the window
      if (!(p.ctx > 0 && p.read > 0)) continue;
      if (!(t.creation >= MIN_CREATION_SHARE * p.ctx)) continue;
      if (!(t.read < READ_FALL_SHARE * p.read)) continue;
      if (!(t.ctx >= SHRINK_GUARD * p.ctx)) continue;
      const ttlMin = threadTtlMin(list, i);
      const gapMs = t.ms - p.ms;
      if (!(gapMs / 60000 > ttlMin)) continue; // strictly longer than the thread TTL
      const avoidable = t.creation - (base.get(t.ws) ?? 0);
      if (!(avoidable > 0)) continue;
      const rate = rewriteRate(t);
      const spend = th.spend.get(t.ws) ?? 0;
      // Unknown spend passes; an unpriceable turn is not floor-tested (no list-price table in the oracle).
      if (
        spend > 0 &&
        rate !== null &&
        avoidable * Math.max(0, rate) < (EVENT_FLOOR_PCT / 100) * spend
      )
        continue;
      const a = byWs.get(t.ws) ?? [];
      a.push({ t, p, gapMs, ttlMin, session: sess });
      byWs.set(t.ws, a);
    }
  }

  // Card (F26): B2 is not shown in a workspace that has a D8 card.
  const d8Ws = new Set(oracleD8(db, now).findings.map((f) => f.scope.workspace_id));
  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, pairs] of byWs) {
    if (d8Ws.has(ws)) continue;
    let longest = pairs[0] as Pair; // pairs are in session-id order; first wins a tie
    for (const q of pairs) if (q.gapMs > longest.gapMs) longest = q;
    for (const q of pairs) checked.push(q.t.id, q.p.id);
    findings.push({
      scope: { workspace_id: ws, key: `B2|${ws}` },
      quantities: [
        { name: "pairs", unit: "count", value: pairs.length },
        {
          name: "previous_cache_read_tokens",
          unit: "tokens",
          value: pairs.reduce((s, q) => s + q.p.read, 0),
        },
        {
          name: "current_cache_read_tokens",
          unit: "tokens",
          value: pairs.reduce((s, q) => s + q.t.read, 0),
        },
        {
          name: "current_cache_creation_tokens",
          unit: "tokens",
          value: pairs.reduce((s, q) => s + q.t.creation, 0),
        },
        { name: "longest_gap_ms", unit: "count", value: longest.gapMs },
        { name: "longest_gap_ttl_ms", unit: "count", value: longest.ttlMin * 60000 },
      ],
      measured_u: null,
      assumptions: [
        {
          name: "B2_NO_LIST_PRICE_FALLBACK",
          value: 0,
          source:
            "dh-contracts.md B2 card (event floor): an unpriceable turn falls back to list price in the " +
            "detector; the oracle has no list-price table and lets such a turn pass the floor",
        },
        {
          name: "B2_BASE_PREFIX_CONTEXT",
          value: 1,
          source:
            "dh-contracts.md B2 card base prefix: context = input + cache_read + 5m + 1h + other, " +
            "median of in-window sessions' first settled main turn",
        },
      ],
      modeled_u: null,
      count: pairs.length,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "B2: later main-thread in-window turn is a B1-style collapse vs previous same-session turn but gap is " +
      "strictly longer than the thread TTL; avoidable (creation - median first-turn context) > 0 and " +
      "0.1% event floor. Count = qualifying pairs per workspace; no $ (card has none).",
  };
};
