/**
 * B4 MID_SESSION_PREFIX_BREAK_V2 count oracle. Written ONLY from the dh-contracts.md B4 card (plus the B1 card's
 * collapse rules it reuses). No imports from src/**.
 * Graded on the card's headline COUNT (figure "count"): the $ is folded into B1, so the card shows a count of
 * mid-session breaks. Count = per workspace, the B1 collapses that are also "rapid": 0 <= gap <= 5 min,
 * later creation > 20,000 tokens and > 2 x previous creation.
 */

import { type MainTurn, loadMainThreads, rewriteRate, threadTtlMin } from "./D8.js";
import type { Oracle, OracleFinding } from "./types.js";

const MIN_CREATION_SHARE = 0.5;
const READ_FALL_SHARE = 0.5;
const SHRINK_GUARD = 0.9;
const EVENT_FLOOR_PCT = 0.1;
const RAPID_MAX_GAP_MS = 300_000;
const RAPID_CREATION_THRESHOLD = 20_000;
const RAPID_CREATION_RATIO = 2;
const AVOIDANCE = 0.5;

export const oracleB4: Oracle = (db, now) => {
  const th = loadMainThreads(db, now);
  const nowMs = now.getTime();
  const byWs = new Map<string, Array<{ t: MainTurn; cost: number }>>();
  for (const list of th.bySession.values()) {
    for (let i = 1; i < list.length; i++) {
      const t = list[i] as MainTurn;
      const p = list[i - 1] as MainTurn;
      if (t.ms < th.startMs || t.ms >= nowMs) continue; // only the later turn must be in the window
      // B1 collapse conditions
      if (!(p.ctx > 0 && p.read > 0)) continue;
      if (!(t.creation >= MIN_CREATION_SHARE * p.ctx)) continue;
      if (!(t.read < READ_FALL_SHARE * p.read)) continue;
      if (!(t.ctx >= SHRINK_GUARD * p.ctx)) continue;
      const gapMs = t.ms - p.ms;
      if (!(gapMs / 60000 <= threadTtlMin(list, i))) continue;
      const rate = rewriteRate(t);
      const spend = th.spend.get(t.ws) ?? 0;
      const cost = rate === null ? 0 : t.creation * rate;
      if (spend > 0 && rate !== null && cost < (EVENT_FLOOR_PCT / 100) * spend) continue;
      // B4 rapid conditions
      if (!(gapMs >= 0 && gapMs <= RAPID_MAX_GAP_MS)) continue;
      if (!(t.creation > RAPID_CREATION_THRESHOLD)) continue;
      if (!(t.creation > RAPID_CREATION_RATIO * p.creation)) continue;
      const a = byWs.get(t.ws) ?? [];
      a.push({ t, cost });
      byWs.set(t.ws, a);
    }
  }
  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, cols] of byWs) {
    const turns = cols.map((c) => c.t);
    for (const t of turns) checked.push(t.id);
    findings.push({
      scope: { workspace_id: ws, key: `B4|${ws}` },
      quantities: [
        { name: "breaks", unit: "events", value: turns.length },
        {
          name: "break_creation_tokens",
          unit: "tokens",
          value: turns.reduce((s, t) => s + t.creation, 0),
        },
      ],
      // Card REWRITE_COST_U: gross rewrite cost of the rapid collapses (B1 measured cost, same formula).
      measured_u: cols.reduce((s, c) => s + c.cost, 0),
      assumptions: [
        {
          name: "B4_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source:
            "dh-contracts.md B4 card, B4_AVOIDANCE_FRACTION (ASSUMED; rank only, $ folds into B1)",
        },
      ],
      modeled_u: null,
      count: turns.length,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "B4: B1 collapse (prev ctx>0 & reads>0, creation>=0.5*prev ctx, reads<0.5*prev reads, ctx>=0.9*prev ctx, " +
      "gap<=thread TTL, event floor 0.1%) that is also rapid (0<=gap<=5min, creation>20000 and >2x prev creation). " +
      "Count per workspace; $ folded into B1.",
  };
};
