/**
 * DH2 probe for A2 BACKGROUND_AGENT_TRANSCRIPT_BLOAT_V2 (contract card A2).
 * Per workspace: TaskOutput results > 10,240 bytes in the window, owned by a reconciled
 * (non-provisional) main-chain turn; after dropping results > 25,600 bytes, the carry cost of the
 * rest must be >= 0.1% of the workspace's window spend.
 *
 * Carry cost is APPROXIMATED from raw tables (the card prices it through pricing snapshots and a
 * calibrated ratio the probe may not use): bytes / 2.7 tokens, times the workspace's average
 * cost per context token in the window, times (1 + later turns in the same session). It is a
 * proxy for the percentage gate only; the byte, owner and chain clauses are exact.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeResult } from "./types.js";

const A2_TASK_OUTPUT_BYTES_THRESHOLD = 10_240;
const A1_RESULT_BYTES_THRESHOLD = 25_600;
const A2_MIN_PCT_OF_SPEND = 0.1;
const BYTES_PER_TOKEN = 2.7;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface EvRow {
  workspace_id: string;
  session_id: string;
  result_bytes: number;
  owner_ok: number;
  owner_ts: string | null;
}

interface SpendRow {
  workspace_id: string;
  spend_u: number;
  ctx_tokens: number;
}

export const probeA2: Probe = (db: Database.Database, now: Date): ProbeResult => {
  const to = now.toISOString();
  const from = new Date(now.getTime() - WEEK_MS).toISOString();

  const events = db
    .prepare(
      `SELECT s.workspace_id AS workspace_id, e.session_id AS session_id, e.result_bytes AS result_bytes,
              CASE WHEN t.message_id IS NOT NULL AND t.is_sidechain = 0 AND t.provisional = 0
                   THEN 1 ELSE 0 END AS owner_ok,
              t.ts AS owner_ts
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id
         LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
        WHERE e.tool_name = 'TaskOutput'
          AND e.ts >= ? AND e.ts < ?
          AND typeof(e.result_bytes) = 'integer'
          AND e.result_bytes > ?`,
    )
    .all(from, to, A2_TASK_OUTPUT_BYTES_THRESHOLD) as EvRow[];

  const spendRows = db
    .prepare(
      `SELECT workspace_id, COALESCE(SUM(cost_equiv_u), 0) AS spend_u, COALESCE(SUM(context_tokens), 0) AS ctx_tokens
         FROM turns WHERE ts >= ? AND ts < ? GROUP BY workspace_id`,
    )
    .all(from, to) as SpendRow[];
  const spend = new Map(spendRows.map((r) => [r.workspace_id, r]));

  const laterTurns = db.prepare(
    "SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts > ?",
  );

  const candidateWs = new Set<string>();
  const carryByWs = new Map<string, number>();
  let maxBytes: number | null = null;
  for (const ev of events) {
    candidateWs.add(ev.workspace_id);
    if (!ev.owner_ok) continue;
    if (maxBytes === null || ev.result_bytes > maxBytes) maxBytes = ev.result_bytes;
    if (ev.result_bytes > A1_RESULT_BYTES_THRESHOLD) continue; // A1's, not priced here
    const sp = spend.get(ev.workspace_id);
    const perToken = sp && sp.ctx_tokens > 0 ? sp.spend_u / sp.ctx_tokens : 0;
    const later = (laterTurns.get(ev.session_id, ev.owner_ts ?? "") as { n: number }).n;
    const carry = (ev.result_bytes / BYTES_PER_TOKEN) * perToken * (1 + later);
    carryByWs.set(ev.workspace_id, (carryByWs.get(ev.workspace_id) ?? 0) + carry);
  }

  let qualifying = 0;
  let bestPct: number | null = null;
  for (const [ws, carry] of carryByWs) {
    const spendU = spend.get(ws)?.spend_u ?? 0;
    const pct = spendU > 0 ? (carry / spendU) * 100 : 0;
    if (bestPct === null || pct > bestPct) bestPct = pct;
    if (pct >= A2_MIN_PCT_OF_SPEND) qualifying++;
  }

  return {
    candidates: candidateWs.size,
    qualifying,
    gates: [
      {
        name: "A2_TASK_OUTPUT_BYTES_THRESHOLD",
        value: maxBytes,
        threshold: A2_TASK_OUTPUT_BYTES_THRESHOLD,
        op: ">",
        pass: maxBytes !== null && maxBytes > A2_TASK_OUTPUT_BYTES_THRESHOLD,
      },
      {
        name: "A2_MIN_PCT_OF_SPEND",
        value: bestPct,
        threshold: A2_MIN_PCT_OF_SPEND,
        op: ">=",
        pass: bestPct !== null && bestPct >= A2_MIN_PCT_OF_SPEND,
      },
    ],
    note: "Workspaces with TaskOutput results over 10,240 bytes (candidates), of which those with a reconciled main-chain owner turn, results at or under 25,600 bytes, and carry cost >= 0.1% of spend (qualifying). Carry cost is a proxy (bytes/2.7 x avg cost per context token x later turns), so the pct gate is approximate.",
  };
};
