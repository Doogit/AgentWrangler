/**
 * D4 MODEL_MISMATCH silence probe. Written from the dh-contracts.md D4 card only.
 *
 * Derivation rules (all from base ingest columns: turns, tool_events, pricing_snapshots; no classifier columns):
 * - Window [now-7d, now). Settled = provisional 0. Opus turn = model name contains "opus".
 * - Edit session = a session with any tool_events row named Edit/Write/MultiEdit/NotebookEdit, any time.
 * - In scope = settled Opus turn that is a sidechain turn, or a main-thread turn of a non-edit session.
 * - Agent = sidechain: agent_id (else session_id); main thread: whole session.
 * - Lookup-shaped turn = context_tokens >= 50000 and output_tokens <= 500. Lookup agent = >= 80% of its
 *   in-scope turns lookup-shaped.
 * - Saving = 0.5 x sum over lookup-agent turns of (Opus cost - Sonnet-5 cost), priced from
 *   pricing_snapshots ([in,out,cacheRead,cw5m,cw1h] $/MTok; cw_other priced as 5m). Opus tier: "opus-5-5" if the
 *   model name contains it, else "opus". Spend = sum of cost_equiv_u of all workspace turns in the window.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate } from "./types.js";

const DAY = 86_400_000;
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

type Prices = [number, number, number, number, number];

interface TurnRow {
  message_id: string;
  session_id: string;
  workspace_id: string;
  model: string;
  is_sidechain: number;
  agent_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  context_tokens: number;
}

function loadPrices(db: Database.Database): Map<string, Prices> {
  const m = new Map<string, Prices>();
  const rows = db
    .prepare("SELECT model_tier, unit_prices_json FROM pricing_snapshots ORDER BY captured_at")
    .all() as { model_tier: string; unit_prices_json: string }[];
  for (const r of rows) m.set(r.model_tier, JSON.parse(r.unit_prices_json) as Prices);
  return m;
}

function cost(t: TurnRow, p: Prices): number {
  return (
    t.input_tokens * p[0] +
    t.output_tokens * p[1] +
    t.cache_read_tokens * p[2] +
    (t.cache_write_5m + t.cache_write_other) * p[3] +
    t.cache_write_1h * p[4]
  );
}

function gate(
  name: string,
  value: number | null,
  threshold: number,
  op: ProbeGate["op"],
): ProbeGate {
  let pass = false;
  if (value !== null) {
    pass =
      op === ">"
        ? value > threshold
        : op === ">="
          ? value >= threshold
          : op === "<"
            ? value < threshold
            : value <= threshold;
  }
  return { name, value, threshold, op, pass };
}

export const probeD4: Probe = (db, now) => {
  const from = new Date(now.getTime() - 7 * DAY).toISOString();
  const to = now.toISOString();
  const prices = loadPrices(db);
  const sonnet = prices.get("sonnet-5");

  const editSessions = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT session_id FROM tool_events WHERE tool_name IN (${EDIT_TOOLS.map(() => "?").join(",")})`,
        )
        .all(...EDIT_TOOLS) as { session_id: string }[]
    ).map((r) => r.session_id),
  );

  const turns = db
    .prepare(
      `SELECT message_id, session_id, workspace_id, model, is_sidechain, agent_id, input_tokens, output_tokens,
              cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, context_tokens
       FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0 AND lower(model) LIKE '%opus%'`,
    )
    .all(from, to) as TurnRow[];

  const spendRows = db
    .prepare(
      "SELECT workspace_id, COALESCE(SUM(cost_equiv_u),0) AS s FROM turns WHERE ts >= ? AND ts < ? GROUP BY workspace_id",
    )
    .all(from, to) as { workspace_id: string; s: number }[];
  const spend = new Map(spendRows.map((r) => [r.workspace_id, r.s]));

  interface Agent {
    n: number;
    shaped: number;
    turns: TurnRow[];
  }
  const byWs = new Map<string, Map<string, Agent>>();
  const wsTotal = new Map<string, number>();
  for (const t of turns) {
    if (!t.is_sidechain && editSessions.has(t.session_id)) continue;
    const key = t.is_sidechain ? `sc:${t.agent_id ?? t.session_id}` : `main:${t.session_id}`;
    const agents = byWs.get(t.workspace_id) ?? new Map<string, Agent>();
    byWs.set(t.workspace_id, agents);
    const a = agents.get(key) ?? { n: 0, shaped: 0, turns: [] };
    agents.set(key, a);
    a.n++;
    a.turns.push(t);
    if (t.context_tokens >= 50_000 && t.output_tokens <= 500) a.shaped++;
    wsTotal.set(t.workspace_id, (wsTotal.get(t.workspace_id) ?? 0) + 1);
  }

  let candidates = 0;
  let qualifying = 0;
  let best: { score: number; tiebreak: number; gates: ProbeGate[] } | null = null;
  for (const [ws, agents] of byWs) {
    const total = wsTotal.get(ws) ?? 0;
    const lookupAgents = [...agents.values()].filter((a) => a.shaped / a.n >= 0.8);
    const bestShare = Math.max(...[...agents.values()].map((a) => a.shaped / a.n));
    if (lookupAgents.length > 0) candidates++;
    const lookupTurns = lookupAgents.reduce((s, a) => s + a.n, 0);
    const fraction = total > 0 ? lookupTurns / total : 0;
    let saving: number | null = null;
    if (sonnet) {
      let sum = 0;
      for (const a of lookupAgents)
        for (const t of a.turns) {
          const tier = t.model.toLowerCase().includes("opus-5-5") ? "opus-5-5" : "opus";
          const op = prices.get(tier);
          if (op) sum += cost(t, op) - cost(t, sonnet);
        }
      saving = sum * 0.5;
    }
    const sp = spend.get(ws) ?? 0;
    const pct = saving !== null && sp > 0 ? (saving / sp) * 100 : null;
    const gates = [
      gate("D4_OPUS_MIN_TURNS", total, 5, ">="),
      gate("D4_MISMATCH_MIN_FRACTION", fraction, 0.4, ">="),
      gate("D4_LOOKUP_TURN_SHARE (best agent)", bestShare, 0.8, ">="),
      gate("modelled saving positive (u)", saving, 0, ">"),
      // Card: not applied when spend is unknown/zero.
      sp > 0
        ? gate("D4_MIN_PCT_OF_SPEND (%)", pct, 0.25, ">=")
        : {
            name: "D4_MIN_PCT_OF_SPEND (%)",
            value: null,
            threshold: 0.25,
            op: ">=" as const,
            pass: true,
          },
    ];
    const all = gates.every((g) => g.pass) && lookupAgents.length > 0;
    if (all) qualifying++;
    const score = gates.filter((g) => g.pass).length + (all ? 10 : 0);
    if (!best || score > best.score || (score === best.score && (saving ?? 0) > best.tiebreak))
      best = { score, tiebreak: saving ?? 0, gates };
  }

  return {
    candidates,
    qualifying,
    gates: best?.gates ?? [],
    note: `D4: ${byWs.size} workspaces with in-scope settled Opus turns; candidate = workspace with >=1 lookup agent (>=80% of agent turns context>=50k and output<=500); edit sessions excluded from main-thread scope via tool_events names; prices from pricing_snapshots (Sonnet tier sonnet-5)${sonnet ? "" : " MISSING"}.`,
  };
};
