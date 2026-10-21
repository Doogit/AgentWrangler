/**
 * D6 TOOL_RESULT_BLOAT probe. Written from the D6 contract card only.
 * Reads tool_events (result_bytes, ts, tool_name), tool_event_metadata.owner_message_id, turns, sessions.
 */

import type Database from "better-sqlite3";
import type { Probe } from "./types.js";

const A1_MAX = 25_600;
const A2_TASKOUTPUT = 10_240;
const EXCESS_FLOOR = 10_240;
const MIN_SESSIONS = 3;
const MIN_PCT = 1;
const CARRY_CAP = 75;
const BYTES_PER_TOKEN = 3.35; // card: uncalibrated point = mean of 2.7 and 4
const FALLBACK_PRICES = [3, 15, 0.3, 3.75, 6]; // $/MTok [in,out,cacheRead,cw5m,cw1h]

interface Ev {
  session_id: string;
  workspace_id: string;
  tool_name: string;
  result_bytes: number;
  owner_ts: string | null;
  owner_rowid: number | null;
  owner_sidechain: number | null;
  owner_agent: string | null;
  prices: string | null;
}

function prices(p: string | null): number[] {
  if (!p) return FALLBACK_PRICES;
  try {
    const a = JSON.parse(p) as unknown;
    return Array.isArray(a) && a.length >= 4 ? (a as number[]) : FALLBACK_PRICES;
  } catch {
    return FALLBACK_PRICES;
  }
}

export const probeD6: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const to = now.toISOString();

  // Relaxed: any non-empty result <= 25 KiB (not a TaskOutput above 10 KiB) in window.
  const evs = db
    .prepare(
      `SELECT e.session_id, s.workspace_id, e.tool_name, e.result_bytes,
              t.ts AS owner_ts, t.rowid AS owner_rowid, t.is_sidechain AS owner_sidechain,
              t.agent_id AS owner_agent, p.unit_prices_json AS prices
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id
         LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
         LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
        WHERE e.ts >= ? AND e.ts < ?
          AND e.result_bytes > 0 AND e.result_bytes <= ?
          AND NOT (e.tool_name = 'TaskOutput' AND e.result_bytes > ?)`,
    )
    .all(from, to, A1_MAX, A2_TASKOUTPUT) as Ev[];

  const laterTurns = db.prepare(
    `SELECT is_compaction_boundary AS cb FROM turns
      WHERE session_id = ? AND is_sidechain = ? AND COALESCE(agent_id,'') = ?
        AND (ts > ? OR (ts = ? AND rowid > ?))
      ORDER BY ts, rowid`,
  );

  const carrySessions = new Set<string>();
  const wsCostU = new Map<string, number>();
  const wsSessions = new Map<string, Set<string>>();
  for (const e of evs) {
    if (e.owner_ts === null || e.owner_rowid === null) continue; // needs an identified owner turn
    const excess = e.result_bytes - EXCESS_FLOOR;
    if (excess <= 0) continue; // under the floor: zero cost, session not counted
    const later = laterTurns.all(
      e.session_id,
      e.owner_sidechain ?? 0,
      e.owner_agent ?? "",
      e.owner_ts,
      e.owner_ts,
      e.owner_rowid,
    ) as { cb: number }[];
    let k = 0;
    for (const l of later) {
      if (l.cb === 1 || k >= CARRY_CAP) break; // carry stops at compaction or 75 turns
      k++;
    }
    if (k === 0) continue; // no later carry: dropped
    const tok = excess / BYTES_PER_TOKEN;
    const pr = prices(e.prices);
    const costU = tok * (pr[3] ?? 0) + tok * k * (pr[2] ?? 0); // one cache write + k cache reads ($/MTok x tok = micro-USD)
    carrySessions.add(e.session_id);
    wsCostU.set(e.workspace_id, (wsCostU.get(e.workspace_id) ?? 0) + costU);
    const set = wsSessions.get(e.workspace_id) ?? new Set<string>();
    set.add(e.session_id);
    wsSessions.set(e.workspace_id, set);
  }

  const spend = db
    .prepare(
      `SELECT workspace_id, COALESCE(SUM(cost_equiv_u),0) AS s FROM turns
        WHERE ts >= ? AND ts < ? GROUP BY workspace_id`,
    )
    .all(from, to) as { workspace_id: string; s: number }[];
  const spendBy = new Map(spend.map((r) => [r.workspace_id, r.s]));

  const sessionsOk = carrySessions.size >= MIN_SESSIONS;
  let qualifying = 0;
  let bestPct: number | null = null;
  for (const [ws, cost] of wsCostU) {
    const sp = spendBy.get(ws) ?? 0;
    const pct = sp > 0 ? (cost / sp) * 100 : null; // unknown/zero spend fails
    if (pct !== null && (bestPct === null || pct > bestPct)) bestPct = pct;
    if (sessionsOk && pct !== null && pct >= MIN_PCT) qualifying++;
  }

  return {
    candidates: wsCostU.size,
    qualifying,
    gates: [
      {
        name: "D6_MIN_SESSIONS",
        value: carrySessions.size,
        threshold: MIN_SESSIONS,
        op: ">=",
        pass: sessionsOk,
      },
      {
        name: "D6_MIN_PCT_OF_SPEND",
        value: bestPct,
        threshold: MIN_PCT,
        op: ">=",
        pass: bestPct !== null && bestPct >= MIN_PCT,
      },
    ],
    note:
      "tool_events in window with 0 < result_bytes <= 25600, minus TaskOutput > 10240, owned by a turn " +
      "(tool_event_metadata.owner_message_id -> turns); priced excess = bytes - 10240 > 0, tokens = excess / 3.35; " +
      "carry = later turns of the same session chain (same sidechain/agent id) up to 75, stopping at an " +
      "is_compaction_boundary turn (context collapse not modelled); cost = one cache write + k cache reads at the " +
      "owner turn's snapshot prices. Session counts only with k>0. Pct = carry cost / workspace window spend " +
      "(spend 0 fails). Candidates = workspaces with priced carry.",
  };
};
