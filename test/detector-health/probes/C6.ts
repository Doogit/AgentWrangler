/**
 * C6 EDIT_FLIP_FLOP_V2 silence probe (card: docs/plans/dh-contracts.md C6). Independent recount.
 * Reads base ingest rows only (tool_events, tool_event_metadata edit text hashes, turns). No classifier columns.
 * Sessions need not be reconciled (card).
 */

import type Database from "better-sqlite3";
import type { ProbeGate, ProbeResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_REVERTS = 1;

interface Ed {
  ts: string;
  block: number;
  oldH: string;
  newH: string;
}

export function probeC6(db: Database.Database, now: Date): ProbeResult {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.session_id AS sid, m.file_path_hash AS fh, e.ts AS ts, m.block_index AS block,
              m.edit_old_string_hash AS oldH, m.edit_new_string_hash AS newH
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
                     AND t.is_sidechain = 0 AND t.provisional = 0
        WHERE e.tool_name = 'Edit' AND m.file_path_hash IS NOT NULL
          AND m.edit_old_string_hash IS NOT NULL AND m.edit_new_string_hash IS NOT NULL
          AND m.edit_old_string_hash <> m.edit_new_string_hash
          AND e.ts >= ? AND e.ts < ?`,
    )
    .all(from, to) as {
    sid: string;
    fh: string;
    ts: string;
    block: number;
    oldH: string;
    newH: string;
  }[];

  const groups = new Map<string, { sid: string; eds: Ed[] }>();
  for (const r of rows) {
    const key = `${r.sid}|${r.fh}`;
    let g = groups.get(key);
    if (!g) {
      g = { sid: r.sid, eds: [] };
      groups.set(key, g);
    }
    g.eds.push({ ts: r.ts, block: r.block, oldH: r.oldH, newH: r.newH });
  }

  const full = new Map<string, number>(); // session -> reverting edits (A->B then B->A)
  const half = new Set<string>(); // sessions with only a one-sided text match
  for (const g of groups.values()) {
    g.eds.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.block - b.block));
    for (let i = 1; i < g.eds.length; i++) {
      const e = g.eds[i] as Ed;
      let isFull = false;
      let isHalf = false;
      for (let j = 0; j < i; j++) {
        const p = g.eds[j] as Ed;
        if (e.newH === p.oldH && e.oldH === p.newH) isFull = true;
        else if (e.newH === p.oldH || e.oldH === p.newH) isHalf = true;
      }
      if (isFull) full.set(g.sid, (full.get(g.sid) ?? 0) + 1);
      else if (isHalf) half.add(g.sid);
    }
  }

  const candSessions = new Set<string>([...full.keys(), ...half]);
  const bestCount = Math.max(0, ...full.values());
  const gates: ProbeGate[] =
    candSessions.size > 0
      ? [
          {
            name: "C6 minimum reversal pairs",
            value: bestCount,
            threshold: MIN_REVERTS,
            op: ">=",
            pass: bestCount >= MIN_REVERTS,
          },
        ]
      : [];
  return {
    candidates: candSessions.size,
    qualifying: full.size,
    gates,
    note:
      "Sessions with an Edit whose old or new text hash matches an earlier Edit's new or old hash on the same file (candidates); " +
      "qualifying = true swap (new == earlier old AND old == earlier new). " +
      "Derivation: Edit events with file hash and both edit text hashes (migration 044+) and old != new, owned by a settled " +
      "main-chain turn, ts in [now-7d, now), any session state; per session + file hash ordered by ts then block_index; " +
      "any earlier edit in the window counts. No exit_class read; edit success not required. Redo-turn cost is $ only (no gate).",
  };
}
