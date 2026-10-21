/**
 * src/detector/waste-turn-claims.ts — whole-turn reliability-lane claims for C6 and C11 (RR U13).
 *
 * C6 (edit flip-flop) and C11 (output-cap error) price the turns they actually waste: the
 * reverting edit's turn, and a failed capped call's turn plus the retry turn after it. Each
 * wasted turn is claimed in full (every billed component), the same upper-bound convention as
 * the C1..C9 recovery-turn claims. The detector's own estimate takes the avoidable share of the
 * same turns' `cost_equiv_u`.
 */
import type { Db } from "../db/open.js";
import type { Claim, LedgerComponent } from "./claim-ledger.js";
import { turnKey } from "./turn-claim.js";
import type { DetectorContext } from "./types.js";

export interface WasteTurn {
  sessionId: string;
  messageId: string;
}

interface SessionTurn {
  message_id: string;
  workspace_id: string;
  ts: string;
  is_sidechain: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cost_equiv_u: number | null;
}

const COMPONENT_COLUMNS: ReadonlyArray<readonly [LedgerComponent, keyof SessionTurn]> = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_tokens"],
  ["cw5m", "cache_write_5m"],
  ["cw1h", "cache_write_1h"],
];

/** Settled turns, one query per session (cached), so a card's turns cost one statement per session. */
export function createTurnIndex(db: Db, ctx: DetectorContext) {
  const stmt = db.prepare(
    `SELECT message_id, workspace_id, ts, is_sidechain, input_tokens, output_tokens,
            cache_read_tokens, cache_write_5m, cache_write_1h, cost_equiv_u
       FROM turns WHERE session_id = ? AND provisional = 0
      ORDER BY ts, message_id`,
  );
  const bySession = new Map<string, { turns: SessionTurn[]; at: Map<string, number> }>();
  const load = (sessionId: string) => {
    let loaded = bySession.get(sessionId);
    if (loaded === undefined) {
      const turns = stmt.all(sessionId) as SessionTurn[];
      loaded = { turns, at: new Map(turns.map((t, i) => [t.message_id, i])) };
      bySession.set(sessionId, loaded);
    }
    return loaded;
  };
  return {
    /** The settled in-window turn, or undefined. */
    row(turn: WasteTurn): SessionTurn | undefined {
      const { turns, at } = load(turn.sessionId);
      const found = turns[at.get(turn.messageId) ?? -1];
      return found !== undefined && found.ts >= ctx.fromIso && found.ts < ctx.toIso
        ? found
        : undefined;
    },
    /** The first main-chain settled turn after `turn`: the turn that reads the result and retries. */
    retryOf(turn: WasteTurn): WasteTurn | undefined {
      const { turns, at } = load(turn.sessionId);
      const from = at.get(turn.messageId);
      const origin = from === undefined ? undefined : turns[from];
      if (from === undefined || origin === undefined) return undefined;
      for (let i = from + 1; i < turns.length; i++) {
        const next = turns[i];
        if (next !== undefined && next.is_sidechain === 0 && next.ts > origin.ts)
          return { sessionId: turn.sessionId, messageId: next.message_id };
      }
      return undefined;
    },
  };
}

export type TurnIndex = ReturnType<typeof createTurnIndex>;

/** Distinct turns, first occurrence order. */
export function distinctTurns(turns: Iterable<WasteTurn>): WasteTurn[] {
  const seen = new Set<string>();
  const result: WasteTurn[] = [];
  for (const turn of turns) {
    const key = turnKey(turn.sessionId, turn.messageId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(turn);
  }
  return result;
}

/** Summed `cost_equiv_u` (µ$) of the distinct settled in-window turns; unpriceable (NULL) turns add 0. */
export function wasteTurnCostU(index: TurnIndex, turns: Iterable<WasteTurn>): number {
  let total = 0;
  for (const turn of distinctTurns(turns)) total += index.row(turn)?.cost_equiv_u ?? 0;
  return total;
}

/** Full-turn reliability claims (`turn:*`) for the given turns, each owned by `recIdFor(turn)`. */
export function* wasteTurnClaims(
  index: TurnIndex,
  detectorId: string,
  recIdFor: (turn: WasteTurn) => string,
  turns: Iterable<WasteTurn>,
): Generator<Claim> {
  for (const turn of distinctTurns(turns)) {
    const row = index.row(turn);
    if (row === undefined) continue;
    for (const [component, column] of COMPONENT_COLUMNS) {
      const tokens = row[column] as number;
      if (tokens <= 0) continue;
      yield {
        detectorId,
        workspaceId: row.workspace_id,
        sessionId: turn.sessionId,
        turnKey: turnKey(turn.sessionId, turn.messageId),
        component,
        slice: "turn:*",
        tokens,
        assumed: true,
        lane: "reliability",
        recId: recIdFor(turn),
      };
    }
  }
}
