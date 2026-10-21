/**
 * DH2 probe for D9 (FORK_SUBAGENT), written from its contract card only.
 * Read list: docs/plans/dh-contracts.md (header + D9 card); docs/plans/spec-detector-health.md (s2, s3 DH2 row);
 * base-table DDL dump (scratchpad ddl.sql); test/fixtures/detector-health/D9/{manifest.json,README.md,
 * positive/**, near-miss/**}; test/detector-health/{probes/types.ts,probes/index.ts,probes.test.ts,harness.ts,manifest.ts}.
 *
 * Reads subagent_meta, sessions, turns, pricing_snapshots. subagent_meta.agent_type is ingest metadata (card).
 *
 * Card reading (open questions):
 *  - A fork is in the window when one of its settled (provisional=0) turns (turns.agent_id = agent_id) has ts in the
 *    window; with no turns at all, when the parent session's last_turn_at is in the window.
 *  - Estimate: per priced in-window fork turn, round(cache_read_tokens x snapshot cache-read price) micro-dollars,
 *    summed. The card says money is in whole micro-dollars; rounding is what makes the fixture's 2682-token boundary land.
 *  - Spend = summed non-null turns.cost_equiv_u of the workspace in the window (all turns, sidechain included).
 *    Unknown/zero spend, or no priced cache-read tokens ("not measured"), passes.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const probeD9: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const prices = new Map<string, number[]>();
  for (const r of db
    .prepare("SELECT snapshot_id, unit_prices_json FROM pricing_snapshots")
    .all() as {
    snapshot_id: string;
    unit_prices_json: string;
  }[]) {
    prices.set(r.snapshot_id, JSON.parse(r.unit_prices_json) as number[]);
  }

  const metas = db
    .prepare(
      `SELECT m.agent_id, m.agent_type, m.session_id, s.workspace_id, s.last_turn_at
       FROM subagent_meta m JOIN sessions s ON s.session_id = m.session_id
       WHERE lower(coalesce(m.agent_type, '')) LIKE '%fork%'`,
    )
    .all() as {
    agent_id: string;
    agent_type: string;
    session_id: string;
    workspace_id: string;
    last_turn_at: string | null;
  }[];

  const forkTurns = db.prepare(
    `SELECT cache_read_tokens, pricing_snapshot_id, cost_equiv_u FROM turns
     WHERE agent_id = ? AND provisional = 0 AND ts >= ? AND ts < ?`,
  );
  const anyTurn = db.prepare("SELECT 1 FROM turns WHERE agent_id = ? LIMIT 1");
  const spendStmt = db.prepare(
    "SELECT SUM(cost_equiv_u) AS u FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?",
  );

  interface Ws {
    forks: number;
    exactForks: number;
    estimateU: number;
    priced: boolean;
  }
  const byWs = new Map<string, Ws>();
  for (const m of metas) {
    const turns = forkTurns.all(m.agent_id, from, to) as {
      cache_read_tokens: number;
      pricing_snapshot_id: string | null;
      cost_equiv_u: number | null;
    }[];
    let inWindow = turns.length > 0;
    if (!inWindow && !anyTurn.get(m.agent_id)) {
      inWindow = m.last_turn_at !== null && m.last_turn_at >= from && m.last_turn_at < to;
    }
    if (!inWindow) continue;
    const w = byWs.get(m.workspace_id) ?? { forks: 0, exactForks: 0, estimateU: 0, priced: false };
    w.forks++;
    if (m.agent_type === "fork") w.exactForks++;
    if (m.agent_type === "fork") {
      for (const t of turns) {
        const px = t.pricing_snapshot_id ? prices.get(t.pricing_snapshot_id) : undefined;
        if (!px || t.cost_equiv_u === null || t.cache_read_tokens <= 0) continue;
        w.estimateU += Math.round(t.cache_read_tokens * (px[2] as number));
        w.priced = true;
      }
    }
    byWs.set(m.workspace_id, w);
  }

  let candidates = 0;
  let qualifying = 0;
  let best: { score: number; gate: ProbeGate } | null = null;
  for (const [ws, w] of byWs) {
    candidates++;
    const spend = ((spendStmt.get(ws, from, to) as { u: number | null }).u ?? 0) as number;
    const measured = w.priced && w.exactForks > 0;
    const pct = measured && spend > 0 ? (w.estimateU / spend) * 100 : null;
    const gate: ProbeGate =
      pct === null
        ? {
            name: "D9_MIN_PCT_OF_SPEND",
            value: null,
            threshold: 0.25,
            op: ">=",
            pass: w.exactForks > 0,
          }
        : { name: "D9_MIN_PCT_OF_SPEND", value: pct, threshold: 0.25, op: ">=", pass: pct >= 0.25 };
    if (gate.pass) qualifying++;
    const score = gate.pass ? 2 : w.exactForks > 0 ? 1 : 0;
    if (!best || score > best.score) best = { score, gate };
  }

  return {
    candidates,
    qualifying,
    gates: best ? [best.gate] : [],
    note: `${metas.length} fork-like subagents known; ${candidates} workspaces with a fork active in window; ${qualifying} pass the spend gate (or are not measured)`,
  };
};
