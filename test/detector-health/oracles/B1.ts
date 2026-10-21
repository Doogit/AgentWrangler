/**
 * B1 CACHE_READ_COLLAPSE_V2 quantity oracle. Written ONLY from the dh-contracts.md B1 card. No imports from src/**.
 * Graded on the card's NET headline (card "Headline (net)"): per qualifying turn, per tier cell (5m, 1h),
 * round(0.5 x write) x max(0, tierPrice - readPrice), summed per workspace and rounded. modeled_u carries it
 * (figure "headline"); measured_u stays the gross rewrite cost.
 */

import { type MainTurn, loadMainThreads, rewriteRate, threadTtlMin } from "./D8.js";
import type { Oracle, OracleFinding } from "./types.js";

const MIN_CREATION_SHARE = 0.5;
const READ_FALL_SHARE = 0.5;
const SHRINK_GUARD = 0.9;
const EVENT_FLOOR_PCT = 0.1;
const AVOIDANCE = 0.5;

/**
 * Card "Headline (net)" steps 2-3: claim cache_write_5m and cache_write_1h (cache_write_other is dropped), each
 * min(round(0.5 x write), billed) tokens (no competing claims assumed, so the cap never binds), priced at
 * max(0, tierPrice - cacheReadPrice) from the turn's own snapshot. No usable snapshot (not 5 non-negative finite
 * numbers) = unpriced = $0; no list-price fallback.
 */
function netClaimValue(t: MainTurn): number {
  const p = t.prices;
  if (
    !Array.isArray(p) ||
    p.length !== 5 ||
    !p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
  )
    return 0;
  const [, , pread, pw5, pw1] = p as [number, number, number, number, number];
  const cell = (w: number, price: number) =>
    Math.min(Math.round(w * AVOIDANCE), w) * Math.max(0, price - (pread as number));
  return cell(t.w5, pw5 as number) + cell(t.w1, pw1 as number);
}

export const oracleB1: Oracle = (db, now) => {
  const th = loadMainThreads(db, now);
  const nowMs = now.getTime();
  interface Col {
    t: MainTurn;
    cost: number;
  }
  const byWs = new Map<string, Col[]>();
  for (const list of th.bySession.values()) {
    for (let i = 1; i < list.length; i++) {
      const t = list[i] as MainTurn;
      const p = list[i - 1] as MainTurn;
      if (t.ms < th.startMs || t.ms >= nowMs) continue; // only the later turn must be in the window
      if (!(p.ctx > 0 && p.read > 0)) continue;
      if (!(t.creation >= MIN_CREATION_SHARE * p.ctx)) continue;
      if (!(t.read < READ_FALL_SHARE * p.read)) continue;
      if (!(t.ctx >= SHRINK_GUARD * p.ctx)) continue;
      const gapMin = (t.ms - p.ms) / 60000;
      if (!(gapMin <= threadTtlMin(list, i))) continue;
      const rate = rewriteRate(t);
      const spend = th.spend.get(t.ws) ?? 0;
      const cost = rate === null ? 0 : t.creation * rate;
      if (spend > 0 && rate !== null && cost < (EVENT_FLOOR_PCT / 100) * spend) continue;
      const a = byWs.get(t.ws) ?? [];
      a.push({ t, cost });
      byWs.set(t.ws, a);
    }
  }
  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, cols] of byWs) {
    // Card "Headline (net)": never null; a workspace card with no priced claim is a real $0.
    const measured = cols.reduce((s, c) => s + c.cost, 0);
    const headline = Math.round(cols.reduce((s, c) => s + netClaimValue(c.t), 0));
    for (const c of cols) checked.push(c.t.id);
    findings.push({
      scope: { workspace_id: ws, key: `B1|${ws}` },
      quantities: [
        { name: "collapses", unit: "events", value: cols.length },
        {
          name: "collapse_creation_tokens",
          unit: "tokens",
          value: cols.reduce((s, c) => s + c.t.creation, 0),
        },
      ],
      measured_u: measured,
      assumptions: [
        {
          name: "B1_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "dh-contracts.md B1 card, B1_AVOIDANCE_FRACTION (ASSUMED, range 0.33 to 0.7)",
        },
        {
          name: "B1_NO_COMPETING_CLAIMS",
          value: 1,
          source:
            "dh-contracts.md B1 Headline assumptions: higher-priority ledger claims assumed absent " +
            "(measured 0.00% cut on live data, 2026-10-14)",
        },
      ],
      modeled_u: headline,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "B1: later main-thread in-window turn vs previous turn of same session thread (may precede window): " +
      "prev ctx>0 & reads>0, creation>=0.5*prev ctx, reads<0.5*prev reads, ctx>=0.9*prev ctx, gap<=thread TTL, " +
      "event floor 0.1% of recomputed workspace spend. $ recomputed via priceTurns rates; no classifier input.",
  };
};
