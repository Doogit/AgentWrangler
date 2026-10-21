/**
 * DH2 probe B2 TTL_GAP_MISS_V2, written from docs/plans/dh-contracts.md card B2 only.
 * Reuses the B1 probe's raw-turn collapse recount (same four-part test), with gap > thread TTL.
 */

import {
  type PTurn,
  type Pair,
  type Workspace,
  collapsePairs,
  loadWorkspaces,
  median,
  netPriceU,
  summarize,
} from "./B1.js";
import type { Probe } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Median first main-thread turn context of sessions whose first main turn is in the window. */
function basePrefix(ws: Workspace, now: Date): number {
  const from = now.getTime() - 7 * DAY_MS;
  const firstBySession = new Map<string, { ms: number; ctx: number }>();
  for (const thread of ws.threads.values()) {
    const t = thread[0] as PTurn;
    const cur = firstBySession.get(t.session);
    if (!cur || t.ms < cur.ms) firstBySession.set(t.session, { ms: t.ms, ctx: t.ctx });
  }
  const ctxs = [...firstBySession.values()].filter((f) => f.ms >= from).map((f) => f.ctx);
  return median(ctxs) ?? 0;
}

export const probeB2: Probe = (db, now) => {
  const wss = loadWorkspaces(db, now);
  const pairs = collapsePairs(wss, now).filter((p) => p.gapMin > p.ttlMin);
  const avoidable = new Map<Pair, { tokens: number; pct: number | null }>();
  for (const p of pairs) {
    const ws = wss.get(p.ws) as Workspace;
    const tokens = p.cur.creation - basePrefix(ws, now);
    const costU = tokens * netPriceU(p.cur);
    avoidable.set(p, { tokens, pct: ws.spendU > 0 ? (costU / ws.spendU) * 100 : null });
    // The floor for B2 is on the avoidable cost, not the whole rewrite.
    p.pct = avoidable.get(p)?.pct ?? null;
  }
  return summarize(
    pairs,
    (p) => (avoidable.get(p)?.tokens ?? 0) > 0 && (p.pct === null || p.pct >= 0.1),
    (b) => [
      {
        name: "AVOIDABLE_TOKENS",
        value: avoidable.get(b)?.tokens ?? null,
        threshold: 0,
        op: ">",
        pass: (avoidable.get(b)?.tokens ?? 0) > 0,
      },
      {
        name: "GAP_MIN_VS_TTL",
        value: b.gapMin,
        threshold: b.ttlMin,
        op: ">",
        pass: b.gapMin > b.ttlMin,
      },
    ],
    "Candidates/qualifying = workspaces. Same raw-turn collapse test as the B1 probe (turns provisional=0, " +
      "main thread, thread = session+agent_id), but gap > thread TTL (latest earlier write tier, else own " +
      "tier, else 60 min). Avoidable tokens = cur creation - base prefix, where base prefix = median (mean of " +
      "middle two when even) first main-thread turn context of sessions whose first turn is in the window. " +
      "Qualifying = avoidable>0 and avoidable*(write-read price) >= 0.1% of window sum(cost_equiv_u) " +
      "(unknown spend passes); EVENT_FLOOR_PCT gate shown is on the avoidable cost.",
  );
};
