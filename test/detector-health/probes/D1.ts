/**
 * D1 CTX_ALWAYS_LOADED_OVERSIZE probe. Written from the D1 contract card only.
 * Derivation: latest context_inventory row per (workspace, component, file) for CLAUDE_MD / MEMORY.
 * `context_inventory` is probe-written by ContextInventoryProbe (not a classifier); no raw-JSONL
 * sample count is available inside a DB-only probe, so the orchestrator must add one on live copies.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate } from "./types.js";

const TARGETS: Record<string, number> = { CLAUDE_MD: 2000, MEMORY: 1000 };
const MIN_SHARE = 0.02;
const MIN_PCT = 0.2;
const TRIM = 0.5;
const FALLBACK_CACHE_READ_PRICE = 0.3; // $/MTok when a turn has no pricing snapshot (assumption)
const GLOBAL = "__global__";

interface InvRow {
  workspace_id: string;
  component: string;
  file_ref: string;
  tokens: number;
}
interface TurnRow {
  workspace_id: string;
  is_sidechain: number;
  agent_type: string | null;
  context_tokens: number;
  cache_read_tokens: number;
  cost_equiv_u: number | null;
  prices: string | null;
}

function cacheReadPrice(prices: string | null): number | null {
  if (!prices) return null;
  try {
    const p = JSON.parse(prices) as unknown;
    return Array.isArray(p) && typeof p[2] === "number" ? p[2] : null;
  } catch {
    return null;
  }
}

export const probeD1: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const to = now.toISOString();

  // Current snapshot: newest probe per (workspace, component, file_ref).
  const inv = db
    .prepare(
      `SELECT i.workspace_id, i.component, i.file_ref, i.tokens
         FROM context_inventory i
        WHERE i.component IN ('CLAUDE_MD','MEMORY')
          AND i.probed_at = (SELECT MAX(j.probed_at) FROM context_inventory j
                              WHERE j.workspace_id = i.workspace_id
                                AND j.component = i.component AND j.file_ref = i.file_ref)`,
    )
    .all() as InvRow[];

  // Settled turns in window, with subagent type (by agent id) and cache-read price (index 2).
  const turns = db
    .prepare(
      `SELECT t.workspace_id, t.is_sidechain, sm.agent_type, t.context_tokens,
              t.cache_read_tokens, t.cost_equiv_u, p.unit_prices_json AS prices
         FROM turns t
         LEFT JOIN subagent_meta sm ON sm.agent_id = t.agent_id
         LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
        WHERE t.provisional = 0 AND t.ts >= ? AND t.ts < ?`,
    )
    .all(from, to) as TurnRow[];

  let candidates = 0;
  let qualifying = 0;
  let best: { score: number; gates: ProbeGate[] } | null = null;

  for (const row of inv) {
    const target = TARGETS[row.component] as number;
    const excess = row.tokens - target;
    if (excess <= 0) continue;
    const inScope = (t: TurnRow): boolean =>
      row.workspace_id === GLOBAL ? t.workspace_id !== GLOBAL : t.workspace_id === row.workspace_id;
    const isFork = (t: TurnRow): boolean => /fork/i.test(t.agent_type ?? "");
    const isExcludedAgent = (t: TurnRow): boolean => /^(explore|plan)$/i.test(t.agent_type ?? "");
    const eligible = turns.filter((t) => {
      if (!inScope(t)) return false;
      if (t.is_sidechain === 0) return true;
      return row.component === "MEMORY" ? isFork(t) : !isExcludedAgent(t);
    });
    if (eligible.length === 0) continue;
    candidates++;

    const n = eligible.length;
    const mean = eligible.reduce((a, t) => a + t.context_tokens, 0) / n;
    // Blended cache-read price: cache-read-token weighted over turns with a snapshot, else fallback.
    let wSum = 0;
    let wTok = 0;
    for (const t of eligible) {
      const pr = cacheReadPrice(t.prices);
      if (pr !== null && t.cache_read_tokens > 0) {
        wSum += pr * t.cache_read_tokens;
        wTok += t.cache_read_tokens;
      }
    }
    const price = wTok > 0 ? wSum / wTok : FALLBACK_CACHE_READ_PRICE;
    const savingU = Math.round(excess * n * price * TRIM); // tokens x $/MTok = micro-USD
    const spendU = turns.filter(inScope).reduce((a, t) => a + (t.cost_equiv_u ?? 0), 0);
    const share = mean > 0 ? row.tokens / mean : 0;
    const pct = spendU > 0 ? (savingU / spendU) * 100 : null;

    const gates: ProbeGate[] = [
      {
        name: `D1_SOURCE_TARGET_${row.component}`,
        value: row.tokens,
        threshold: target,
        op: ">",
        pass: true,
      },
      { name: "D1_SAVING_NONZERO_U", value: savingU, threshold: 0, op: ">", pass: savingU > 0 },
      {
        name: "D1_MIN_CONTEXT_SHARE",
        value: share,
        threshold: MIN_SHARE,
        op: ">=",
        pass: share >= MIN_SHARE,
      },
      {
        name: "D1_MIN_PCT_OF_SPEND",
        value: pct,
        threshold: MIN_PCT,
        op: ">=",
        pass: pct === null || pct >= MIN_PCT,
      },
    ];
    const passed = gates.filter((g) => g.pass).length;
    if (passed === gates.length) qualifying++;
    if (!best || passed > best.score) best = { score: passed, gates };
  }

  return {
    candidates,
    qualifying,
    gates: best?.gates ?? [],
    note:
      "Latest context_inventory CLAUDE_MD/MEMORY rows (probe-written table; raw-sample count not available here) " +
      "with tokens > target (2000/1000) and >=1 eligible settled window turn (MEMORY: main + 'fork' agent_type; " +
      "CLAUDE_MD: main + any subagent except Explore/Plan; global source = all non-global workspaces). " +
      "Saving = excess x eligible turns x cache-read-weighted price (snapshot idx 2) x 0.5; share = tokens / mean " +
      "eligible context; spend pct passes when scope spend is 0. Fork identification (agent_type contains 'fork') " +
      "is a guess; the card does not say how forks are stored.",
  };
};
