/**
 * E1 ORIENTATION_BEFORE_FIRST_EDIT quantity oracle, written only from the dh-contracts.md E1 card.
 * Per workspace: >= 8 reconciled sessions whose first main-thread edit falls in [now-7d, now); long = pre-edit
 * turn count > nearest-rank p75; excess = pre-edit turns after the first p50-count; fires when excess cost >= 1%
 * of the workspace's window spend; modeled = excess cost x 0.5 (ASSUMED).
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const MIN_SESSIONS = 8;
const MIN_PCT = 1;
const AVOIDANCE = 0.5;
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const nearestRank = (sorted: number[], q: number): number =>
  sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;

export const oracleE1: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();

  // First main-thread edit per reconciled session: earliest edit event owned by a non-sidechain, settled turn.
  const edits = db
    .prepare(
      `SELECT s.session_id, s.workspace_id, e.ts AS edit_ts, t.ts AS owner_ts, e.event_id
       FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       JOIN sessions s ON s.session_id = e.session_id
       WHERE s.state = 'RECONCILED' AND e.tool_name IN (${EDIT_TOOLS.map(() => "?").join(",")})
         AND t.is_sidechain = 0 AND t.provisional = 0 AND t.session_id = s.session_id
       ORDER BY e.ts, m.block_index`,
    )
    .all(...EDIT_TOOLS) as {
    session_id: string;
    workspace_id: string;
    edit_ts: string;
    owner_ts: string;
    event_id: string;
  }[];
  const first = new Map<string, (typeof edits)[number]>();
  for (const r of edits) if (!first.has(r.session_id)) first.set(r.session_id, r);

  const byWs = new Map<string, (typeof edits)[number][]>();
  for (const r of first.values()) {
    if (r.edit_ts < fromIso || r.edit_ts >= toIso) continue;
    const list = byWs.get(r.workspace_id) ?? [];
    list.push(r);
    byWs.set(r.workspace_id, list);
  }

  const findings: OracleFinding[] = [];
  const turnsChecked = new Set<string>();
  let skipped = 0;

  for (const [ws, rows] of byWs) {
    if (rows.length < MIN_SESSIONS) {
      skipped++;
      continue;
    }
    const pre = rows.map((r) => {
      const ids = (
        db
          .prepare(
            `SELECT message_id FROM turns WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts < ?
             ORDER BY ts, message_id`,
          )
          .all(r.session_id, r.owner_ts) as { message_id: string }[]
      ).map((x) => x.message_id);
      return { session_id: r.session_id, ids };
    });
    const counts = pre.map((p) => p.ids.length).sort((a, b) => a - b);
    const p50 = nearestRank(counts, 0.5);
    const p75 = nearestRank(counts, 0.75);
    const excessIds: string[] = [];
    let longSessions = 0;
    for (const p of pre) {
      if (p.ids.length > p75) {
        longSessions++;
        excessIds.push(...p.ids.slice(p50));
      }
    }
    if (excessIds.length === 0) continue;

    const priced = priceTurns(db, excessIds);
    let excessU = 0;
    for (const id of excessIds) excessU += priced.get(id) ?? 0;

    const spendIds = (
      db
        .prepare(
          "SELECT message_id FROM turns WHERE workspace_id = ? AND provisional = 0 AND ts >= ? AND ts < ?",
        )
        .all(ws, fromIso, toIso) as { message_id: string }[]
    ).map((x) => x.message_id);
    const spendPriced = priceTurns(db, spendIds);
    let spendU = 0;
    for (const v of spendPriced.values()) spendU += v;
    if (spendU <= 0 || (excessU / spendU) * 100 < MIN_PCT) continue;

    for (const id of excessIds) turnsChecked.add(id);
    findings.push({
      scope: { workspace_id: ws, key: `E1|${ws}` },
      quantities: [
        { name: "editing_sessions", unit: "sessions", value: rows.length },
        { name: "sessions_over_p75", unit: "sessions", value: longSessions },
        { name: "excess_turns", unit: "turns", value: excessIds.length },
        { name: "p50", unit: "turns", value: p50 },
        { name: "p75", unit: "turns", value: p75 },
      ],
      measured_u: excessU,
      assumptions: [
        {
          name: "E1_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "dh-contracts.md E1 card, E1_AVOIDANCE_FRACTION",
        },
      ],
      modeled_u: excessU * AVOIDANCE,
      count: excessIds.length,
    });
  }

  return {
    findings,
    turns_checked: [...turnsChecked],
    note: `E1: ${byWs.size} workspaces with first edits in window, ${skipped} under ${MIN_SESSIONS} sessions, ${findings.length} fire`,
  };
};
