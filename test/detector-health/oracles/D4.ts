/**
 * D4 MODEL_MISMATCH quantity oracle. Written ONLY from the dh-contracts.md D4 card. No imports from src/**.
 * Card quantity (advisory): (Opus price - Sonnet-5 price) over all token components of the lookup turns x 0.5.
 */

import { loadMainThreads } from "./D8.js";
import type { Oracle, OracleFinding } from "./types.js";

const MIN_TURNS = 5;
const MIN_FRACTION = 0.4;
const MIN_CONTEXT = 50_000;
const MAX_OUTPUT = 500;
const LOOKUP_SHARE = 0.8;
const MIN_PCT_OF_SPEND = 0.25;
const REALIZABLE = 0.5;
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export const oracleD4: Oracle = (db, now) => {
  const startIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();
  const sonnet = db
    .prepare(
      "SELECT unit_prices_json pj FROM pricing_snapshots WHERE model_tier = 'sonnet-5' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { pj: string } | undefined;
  const sp = sonnet ? (JSON.parse(sonnet.pj) as number[]) : null;
  const editSessions = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT session_id s FROM tool_events WHERE tool_name IN (${EDIT_TOOLS.map(() => "?").join(",")})`,
        )
        .all(...EDIT_TOOLS) as Array<{ s: string }>
    ).map((r) => r.s),
  );
  const rows = db
    .prepare(
      `SELECT t.message_id id, t.session_id session, t.workspace_id ws, t.is_sidechain side, t.agent_id agent,
              t.input_tokens in_t, t.output_tokens out_t, t.cache_read_tokens rd, t.cache_write_5m w5,
              t.cache_write_1h w1, t.cache_write_other wo, p.unit_prices_json pj
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE t.provisional = 0 AND t.ts >= ? AND t.ts < ? AND lower(t.model) LIKE '%opus%'`,
    )
    .all(startIso, nowIso) as Array<{
    id: string;
    session: string;
    ws: string;
    side: number;
    agent: string | null;
    in_t: number;
    out_t: number;
    rd: number;
    w5: number;
    w1: number;
    wo: number;
    pj: string | null;
  }>;

  interface Tn {
    id: string;
    ws: string;
    lookupShaped: boolean;
    differential: number | null;
    tokens: number;
  }
  const agents = new Map<string, Tn[]>();
  for (const r of rows) {
    if (r.side === 0 && editSessions.has(r.session)) continue;
    const key = r.side !== 0 ? `sub|${r.agent ?? `s:${r.session}`}` : `main|${r.session}`;
    const ctx = r.in_t + r.rd + r.w5 + r.w1 + r.wo;
    let differential: number | null = null;
    if (r.pj && sp) {
      const o = JSON.parse(r.pj) as number[];
      const comp = (i: number, n: number) => n * ((o[i] as number) - (sp[i] as number));
      differential =
        (comp(0, r.in_t) +
          comp(1, r.out_t) +
          comp(2, r.rd) +
          comp(3, r.w5 + r.wo) +
          comp(4, r.w1)) /
        1;
    }
    const arr = agents.get(key) ?? [];
    arr.push({
      id: r.id,
      ws: r.ws,
      lookupShaped: ctx >= MIN_CONTEXT && r.out_t <= MAX_OUTPUT,
      differential,
      tokens: ctx + r.out_t,
    });
    agents.set(key, arr);
  }

  const spend = loadMainThreads(db, now).spend;
  const total = new Map<string, number>();
  const lookup = new Map<string, Tn[]>();
  const lookupAgents = new Map<string, number>();
  for (const turns of agents.values()) {
    const ws = (turns[0] as Tn).ws;
    total.set(ws, (total.get(ws) ?? 0) + turns.length);
    if (turns.filter((t) => t.lookupShaped).length >= LOOKUP_SHARE * turns.length) {
      lookup.set(ws, [...(lookup.get(ws) ?? []), ...turns]);
      lookupAgents.set(ws, (lookupAgents.get(ws) ?? 0) + 1);
    }
  }

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [ws, n] of total) {
    if (n < MIN_TURNS) continue;
    const lk = lookup.get(ws) ?? [];
    if (!(lk.length / n >= MIN_FRACTION)) continue;
    const priced = lk.filter((t) => t.differential !== null);
    const measured = priced.reduce((s, t) => s + (t.differential as number), 0); // µ$ ($/MTok x tokens)
    const modeled = measured * REALIZABLE;
    if (!(modeled > 0)) continue;
    const sp0 = spend.get(ws) ?? 0;
    // $/MTok x tokens = µ$ directly
    if (sp0 > 0 && modeled < (MIN_PCT_OF_SPEND / 100) * sp0) continue;
    for (const t of lk) checked.push(t.id);
    findings.push({
      scope: { workspace_id: ws, key: `D4|${ws}` },
      quantities: [
        { name: "in_scope_opus_turns", unit: "turns", value: n },
        { name: "mismatch_turns", unit: "turns", value: lk.length },
        { name: "lookup_agents", unit: "count", value: lookupAgents.get(ws) ?? 0 },
        { name: "lookup_turn_tokens", unit: "tokens", value: lk.reduce((s, t) => s + t.tokens, 0) },
      ],
      measured_u: measured,
      assumptions: [
        {
          name: "D4_REALIZABLE_AVOIDANCE_FRACTION",
          value: REALIZABLE,
          source: "dh-contracts.md D4 card, D4_REALIZABLE_AVOIDANCE_FRACTION",
        },
      ],
      modeled_u: modeled,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "D4: in-scope Opus turns = settled in-window turns with model containing 'opus' that are sidechain, or main-thread of a " +
      "session with no Edit/Write/MultiEdit/NotebookEdit tool_event ever. Agent = agent_id (else session) / whole main thread. " +
      "Lookup agent >=80% turns with ctx>=50k & out<=500. Estimate = sum over lookup turns of (own Opus price - sonnet-5 " +
      "list snapshot price) x tokens per component x 0.5; measured_u is the pre-0.5 differential. Workspace spend recomputed.",
  };
};
