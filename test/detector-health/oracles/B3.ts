/**
 * B3 RESUME_CACHE_MISS_V2 quantity oracle. Written ONLY from the dh-contracts.md B3 card (plus the B2 card's
 * "context" definition it shares). No imports from src/**.
 * Graded on the card's NET headline (card "Headline (net)", figure "headline"), one finding per resume event:
 * avoidable = creation - base; raw5/raw1h = round(avoidable x cell / creation) (cw_other dropped); per cell
 * min(round(0.5 x raw), billed cell) x max(0, tierPrice - readPrice) from the turn's own snapshot.
 * modeled_u carries the per-event headline; the grader sums findings per workspace.
 */

import { type MainTurn, loadMainThreads, tierOf } from "./D8.js";
import type { Oracle, OracleFinding } from "./types.js";

const MATCH_LOW = 0.8;
const MATCH_HIGH = 1.25;
const READ_FALL_SHARE = 0.5;
const CREATION_THRESHOLD = 20_000;
const EVENT_FLOOR_PCT = 0.1;
const AVOIDANCE = 0.5;
const TTL_5M_MS = 5 * 60_000;
const TTL_1H_MS = 60 * 60_000;

/** Snapshot is usable only as 5 finite non-negative numbers (card step 5); else unpriced = $0. */
function usable(p: number[] | null): p is [number, number, number, number, number] {
  return (
    Array.isArray(p) &&
    p.length === 5 &&
    p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2
    ? (s[m] as number)
    : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

export const oracleB3: Oracle = (db, now) => {
  const th = loadMainThreads(db, now);
  const nowMs = now.getTime();

  // Base prefix per workspace: median "context" of the first settled main turn of sessions whose first turn is in window.
  const firstCtx = new Map<string, number[]>();
  const firstOf = new Map<string, MainTurn>();
  const lastOf = new Map<string, MainTurn>();
  const all: MainTurn[] = [];
  for (const [sess, list] of th.bySession) {
    // Card: first/last by (ts, message_id).
    const sorted = [...list].sort(
      (a, b) => a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    firstOf.set(sess, sorted[0] as MainTurn);
    lastOf.set(sess, sorted[sorted.length - 1] as MainTurn);
    all.push(...sorted);
    const f = sorted[0] as MainTurn;
    if (f.ms >= th.startMs && f.ms < nowMs) {
      const a = firstCtx.get(f.ws);
      if (a) a.push(f.ctx);
      else firstCtx.set(f.ws, [f.ctx]);
    }
  }
  const base = new Map<string, number>();
  for (const [ws, xs] of firstCtx) base.set(ws, median(xs));

  // Card: ordered (workspace, ts, session_id, message_id); previous = row immediately before.
  all.sort(
    (a, b) =>
      (a.ws < b.ws ? -1 : a.ws > b.ws ? 1 : 0) ||
      a.ms - b.ms ||
      (a.session < b.session ? -1 : a.session > b.session ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (let i = 1; i < all.length; i++) {
    const cur = all[i] as MainTurn;
    const prev = all[i - 1] as MainTurn;
    if (cur.ws !== prev.ws || cur.session === prev.session) continue;
    if (lastOf.get(prev.session) !== prev || firstOf.get(cur.session) !== cur) continue;
    if (!(cur.ms >= th.startMs && cur.ms < nowMs)) continue;
    // Resume rewrite test.
    if (!(prev.ctx > 0)) continue;
    const share = cur.creation / prev.ctx;
    if (!(share >= MATCH_LOW && share <= MATCH_HIGH)) continue;
    if (!(cur.read <= READ_FALL_SHARE * prev.read)) continue;
    // Gap and previous-session TTL (previous tier, else the new turn's tier, else 60 min).
    const gap = cur.ms - prev.ms;
    const tier = tierOf(prev) ?? tierOf(cur);
    const ttl = tier === "5m" ? TTL_5M_MS : TTL_1H_MS;
    if (!(gap >= 0 && gap <= ttl)) continue;
    if (!(cur.creation > CREATION_THRESHOLD)) continue;
    const b = base.get(cur.ws) ?? 0;
    const avoidable = cur.creation - b;
    if (!(avoidable > 0)) continue;
    // Event floor, list fallback not modelled (card detector-level pricing): unusable prices pass the floor.
    const spend = th.spend.get(cur.ws) ?? 0;
    const p = cur.prices;
    if (spend > 0 && usable(p)) {
      const [, , pread, pw5, pw1] = p;
      const ownWrite = ((cur.w5 + cur.wo) * pw5 + cur.w1 * pw1) / cur.creation;
      const cost = avoidable * Math.max(0, ownWrite - pread);
      if (cost < (EVENT_FLOOR_PCT / 100) * spend) continue;
    }
    // Headline (net): per-cell ledger claims at 0.5, own snapshot, no competing claims.
    let value = 0;
    if (usable(p)) {
      const [, , pread, pw5, pw1] = p;
      const cell = (w: number, price: number) => {
        const raw = Math.round((avoidable * w) / cur.creation);
        return Math.min(Math.round(raw * AVOIDANCE), w) * Math.max(0, price - pread);
      };
      value = cell(cur.w5, pw5) + cell(cur.w1, pw1);
    }
    checked.push(cur.id, prev.id);
    findings.push({
      scope: { workspace_id: cur.ws, key: `B3|${cur.ws}|${prev.session}|${cur.session}|${cur.id}` },
      quantities: [
        { name: "creation_tokens", unit: "tokens", value: cur.creation },
        { name: "avoidable_tokens", unit: "tokens", value: avoidable },
        { name: "base_prefix_tokens", unit: "tokens", value: b },
      ],
      measured_u: null,
      assumptions: [
        {
          name: "B3_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "dh-contracts.md B3 card, B3_AVOIDANCE_FRACTION (ASSUMED, range 0.33 to 0.7)",
        },
        {
          name: "B3_NO_COMPETING_CLAIMS",
          value: 1,
          source:
            "dh-contracts.md B3 Headline assumptions: no competing ledger claim on the new session's first turn cw cells, by construction (untested live: no event)",
        },
        {
          name: "B3_NO_LIST_FALLBACK_HEADLINE",
          value: 1,
          source:
            "dh-contracts.md B3 Headline assumptions: unusable snapshot = unpriced = $0 headline; event floor skipped for such turns (card list fallback not modelled)",
        },
        {
          name: "B3_CW_OTHER_DROPPED",
          value: 1,
          source: "dh-contracts.md B3 Headline (net) step 3: cache_write_other has no ledger cell",
        },
      ],
      modeled_u: Math.round(value),
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "B3: per resume event (new session's first settled main turn directly after another session's last in the " +
      "workspace order, in window): creation/prev ctx in [0.8,1.25], reads<=0.5*prev reads, 0<=gap<=prev TTL, " +
      "creation>20000, avoidable=creation-base>0, event floor 0.1% of recomputed workspace spend. Headline = " +
      "per-cell ledger claims (avoidable x cell share, x0.5, own snapshot), rounded per workspace sum.",
  };
};
