/**
 * D1 CTX_ALWAYS_LOADED_OVERSIZE headline oracle, written only from the dh-contracts.md D1 card.
 * Graded on the card's NET headline ("Headline (net)"), not the gross "Card quantity".
 * Card gate (per current context_inventory row, CLAUDE_MD / MEMORY): tokens > target (2000 / 1000), scope has eligible
 * settled turns in [now-7d, now), tokens >= 2% of their mean context, modelled saving (excess x eligible turns x
 * cache-read-weighted blended price x 0.5) > 0 and >= 0.2% of scope 7-day spend.
 * Headline, for each passing source (probe_id order), over its scope's eligible settled in-window turns with
 * cache_read_tokens > 0: asOf = latest context_inventory_history tokens at/before the turn (same workspace, component,
 * file_ref, attribution_version; MEMORY ignores history before 2026-09-23T23:08:00.000Z) else current tokens;
 * delta = asOf - target (skip if <= 0); claim = min(delta, remaining cache reads of the turn, shared by all sources);
 * tokens = round(claim x 0.5); value = tokens x that turn's own cache-read price (no snapshot = 0).
 * Findings are summed per card key D1|workspace|component|basename; headline = round(sum of value).
 * "Fork subagent" has no field on the card: read as subagent_meta.agent_type = 'fork'.
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const TARGETS: Record<string, number> = { CLAUDE_MD: 2000, MEMORY: 1000 };
const MIN_CONTEXT_SHARE = 0.02;
const MIN_PCT = 0.2;
const TRIM = 0.5;
const GLOBAL = "__global__";
const MEMORY_HISTORY_FLOOR = "2026-09-23T23:08:00.000Z";

interface Inv {
  probe_id: string;
  workspace_id: string;
  component: string;
  file_ref: string;
  tokens: number;
  attribution_version: string;
}
interface TurnRow {
  message_id: string;
  ts: string;
  is_sidechain: number;
  context_tokens: number;
  cache_read_tokens: number;
  agent_type: string | null;
  prices: string | null;
}
interface Hist {
  tokens: number;
  observed_at: string;
}

export const oracleD1: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();

  const inv = db
    .prepare(
      `SELECT c.probe_id, c.workspace_id, c.component, c.file_ref, c.tokens, c.attribution_version FROM context_inventory c
       WHERE c.component IN ('CLAUDE_MD','MEMORY')
         AND c.probed_at = (SELECT MAX(probed_at) FROM context_inventory x
                            WHERE x.workspace_id = c.workspace_id AND x.component = c.component AND x.file_ref = c.file_ref)
       ORDER BY c.probe_id`,
    )
    .all() as Inv[];

  const turnsOf = (ws: string): TurnRow[] =>
    db
      .prepare(
        `SELECT t.message_id, t.ts, t.is_sidechain, t.context_tokens, t.cache_read_tokens, sm.agent_type, p.unit_prices_json AS prices
         FROM turns t
         LEFT JOIN subagent_meta sm ON sm.agent_id = t.agent_id
         LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
         WHERE t.provisional = 0 AND t.ts >= ? AND t.ts < ? AND ${ws === GLOBAL ? "t.workspace_id != ?" : "t.workspace_id = ?"}
         ORDER BY t.ts, t.message_id`,
      )
      .all(fromIso, toIso, ws) as TurnRow[];

  const cache = new Map<string, { turns: TurnRow[]; spend: number }>();
  const scope = (ws: string) => {
    const hit = cache.get(ws);
    if (hit) return hit;
    const turns = turnsOf(ws);
    let spend = 0;
    for (const v of priceTurns(
      db,
      turns.map((t) => t.message_id),
    ).values())
      spend += v;
    const s = { turns, spend };
    cache.set(ws, s);
    return s;
  };

  const readPrice = (t: TurnRow): number =>
    t.prices ? ((JSON.parse(t.prices) as number[])[2] ?? 0) : 0;

  const histStmt = db.prepare(
    `SELECT tokens, observed_at FROM context_inventory_history
     WHERE workspace_id = ? AND component = ? AND file_ref = ? AND attribution_version = ?
     ORDER BY observed_at, id`,
  );

  const remaining = new Map<string, number>(); // shared across all sources
  const cards = new Map<
    string,
    { ws: string; tokens: number; excess: number; claimed: number; turns: number; value: number }
  >();
  const turnsChecked = new Set<string>();

  for (const r of inv) {
    const target = TARGETS[r.component] ?? 0;
    if (r.tokens <= target) continue;
    const { turns, spend } = scope(r.workspace_id);
    const elig = turns.filter((t) => {
      if (!t.is_sidechain) return true;
      if (r.component === "MEMORY") return t.agent_type === "fork";
      return t.agent_type !== "Explore" && t.agent_type !== "Plan";
    });
    if (elig.length === 0) continue;
    const mean = elig.reduce((a, t) => a + t.context_tokens, 0) / elig.length;
    if (r.tokens < MIN_CONTEXT_SHARE * mean) continue;
    const readTotal = elig.reduce((a, t) => a + t.cache_read_tokens, 0);
    if (readTotal === 0) continue; // card falls back to list price; headline would be $0 anyway
    const blended = elig.reduce((a, t) => a + t.cache_read_tokens * readPrice(t), 0) / readTotal;
    const modeled = (r.tokens - target) * elig.length * blended * TRIM;
    if (Math.round(modeled) <= 0) continue;
    if (spend > 0 && (modeled / spend) * 100 < MIN_PCT) continue;

    const hist = (
      histStmt.all(r.workspace_id, r.component, r.file_ref, r.attribution_version) as Hist[]
    ).filter((h) => r.component !== "MEMORY" || h.observed_at >= MEMORY_HISTORY_FLOOR);

    const base = r.file_ref.split(/[\\/]/).pop() ?? r.file_ref;
    const key = `D1|${r.workspace_id}|${r.component}|${base}`;
    const card = cards.get(key) ?? {
      ws: r.workspace_id,
      tokens: 0,
      excess: 0,
      claimed: 0,
      turns: 0,
      value: 0,
    };
    cards.set(key, card);
    card.tokens += r.tokens;
    card.excess += r.tokens - target;

    let hi = -1; // elig is ordered by ts: advance to the latest history row at/before the turn
    for (const t of elig) {
      if (t.cache_read_tokens <= 0) continue;
      while (hi + 1 < hist.length && (hist[hi + 1] as Hist).observed_at <= t.ts) hi++;
      const asOf = hi >= 0 ? (hist[hi] as Hist).tokens : r.tokens;
      const delta = asOf - target;
      if (delta <= 0) continue;
      const left = remaining.get(t.message_id) ?? t.cache_read_tokens;
      const claim = Math.min(delta, left);
      remaining.set(t.message_id, left - claim);
      const tokens = Math.round(claim * TRIM);
      if (tokens <= 0) continue;
      card.claimed += tokens;
      card.turns++;
      card.value += tokens * readPrice(t);
      turnsChecked.add(t.message_id);
    }
  }

  const findings: OracleFinding[] = [];
  for (const [key, c] of cards) {
    const headline = Math.round(c.value);
    findings.push({
      // OracleScope: null workspace_id = global (the card's "__global__" source); the key keeps the card's name.
      scope: { workspace_id: c.ws === GLOBAL ? null : c.ws, key },
      quantities: [
        { name: "source_tokens", unit: "tokens", value: c.tokens },
        { name: "excess_tokens", unit: "tokens", value: c.excess },
        { name: "claimed_tokens", unit: "tokens", value: c.claimed },
        { name: "claimed_turns", unit: "turns", value: c.turns },
      ],
      measured_u: headline,
      assumptions: [
        {
          name: "D1_TRIM_TO_TARGET_FRACTION",
          value: TRIM,
          source: "dh-contracts.md D1 card, D1_TRIM_TO_TARGET_FRACTION (ASSUMED, range 0.5 to 1)",
        },
        {
          name: "D1_NO_COMPETING_CLAIMS",
          value: 1,
          source:
            "dh-contracts.md D1 card, Headline assumptions: no claims above D1; measured 0.00 percent cut on live, assumed within +/-3 percent",
        },
      ],
      modeled_u: headline,
      count: c.turns,
    });
  }
  return {
    findings,
    turns_checked: [...turnsChecked],
    note: `D1: ${inv.length} CLAUDE_MD/MEMORY rows, ${cards.size} pass the card gate; net headline, no competing claims assumed`,
  };
};
