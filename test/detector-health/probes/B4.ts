/**
 * DH2 probe B4 MID_SESSION_PREFIX_BREAK_V2, written from docs/plans/dh-contracts.md card B4 only.
 * A B4 event is a B1 event (in-TTL, event floor) that is also rapid: 0 <= gap <= 5 min,
 * creation > 20,000 and creation > 2 x previous creation.
 */

import { type Pair, collapsePairs, floorPasses, loadWorkspaces, summarize } from "./B1.js";
import type { Probe } from "./types.js";

const RAPID_MAX_GAP_MIN = 5;
const RAPID_CREATION = 20_000;
const RAPID_RATIO = 2;

const isRapid = (p: Pair): boolean =>
  p.gapMin >= 0 &&
  p.gapMin <= RAPID_MAX_GAP_MIN &&
  p.cur.creation > RAPID_CREATION &&
  p.cur.creation > RAPID_RATIO * p.prev.creation;

export const probeB4: Probe = (db, now) => {
  const pairs = collapsePairs(loadWorkspaces(db, now), now);
  return summarize(
    pairs.filter(isRapid),
    (p) => p.gapMin <= p.ttlMin && floorPasses(p),
    (b) => [
      {
        name: "GAP_MIN_VS_TTL",
        value: b.gapMin,
        threshold: b.ttlMin,
        op: "<=",
        pass: b.gapMin <= b.ttlMin,
      },
      {
        name: "RAPID_CREATION_THRESHOLD",
        value: b.cur.creation,
        threshold: RAPID_CREATION,
        op: ">",
        pass: b.cur.creation > RAPID_CREATION,
      },
    ],
    "Candidates/qualifying = workspaces. B1 collapse recount from raw turns (provisional=0, main thread, " +
      "thread = session+agent_id; creation=5m+1h+other; collapse = cur creation>=0.5*prev ctx, cur reads<" +
      "0.5*prev reads, cur ctx>=0.9*prev ctx, prev reads>0). Candidate = collapse pair that is rapid: " +
      "0<=gap<=5 min, creation>20,000 and >2x prev creation, any TTL/floor. Qualifying also needs gap<=thread " +
      "TTL (latest earlier write tier, else own tier, else 60) and the B1 event floor (rewrite cost >=0.1% of " +
      "window sum(cost_equiv_u); unknown spend passes).",
  );
};
