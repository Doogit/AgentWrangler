/**
 * C6 EDIT_FLIP_FLOP_V2 quantity oracle. Written ONLY from the dh-contracts.md C6 card. No imports from src/**.
 * Card quantity: flip-flop count and $/wk = sum cost of the distinct turns that issued reverting edits x 0.5
 * (reliability figure: full cost of the redo turn, upper bound).
 */

import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const AVOIDANCE = 0.5;

export const oracleC6: Oracle = (db, now) => {
  const startIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();
  const edits = db
    .prepare(
      `SELECT e.event_id id, e.session_id session, e.ts ts, m.block_index bi, m.file_path_hash fp,
              m.edit_old_string_hash oh, m.edit_new_string_hash nh, m.owner_message_id owner,
              t.workspace_id ws, t.ts turn_ts
       FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       WHERE e.tool_name = 'Edit' AND e.ts >= ? AND e.ts < ?
         AND t.is_sidechain = 0 AND t.provisional = 0
         AND m.file_path_hash IS NOT NULL AND m.edit_old_string_hash IS NOT NULL AND m.edit_new_string_hash IS NOT NULL
         AND m.edit_old_string_hash <> m.edit_new_string_hash
       ORDER BY e.session_id, m.file_path_hash, e.ts, m.block_index, e.event_id`,
    )
    .all(startIso, nowIso) as Array<{
    id: string;
    session: string;
    ts: string;
    bi: number;
    fp: string;
    oh: string;
    nh: string;
    owner: string;
    ws: string;
    turn_ts: string;
  }>;

  interface Sess {
    ws: string;
    count: number;
    files: Set<string>;
    redoTurns: Set<string>;
  }
  const sessions = new Map<string, Sess>();
  let i = 0;
  while (i < edits.length) {
    let j = i;
    const first = edits[i] as (typeof edits)[number];
    while (
      j < edits.length &&
      (edits[j] as (typeof edits)[number]).session === first.session &&
      (edits[j] as (typeof edits)[number]).fp === first.fp
    )
      j++;
    for (let k = i + 1; k < j; k++) {
      const e = edits[k] as (typeof edits)[number];
      let reverts = false;
      for (let p = i; p < k; p++) {
        const q = edits[p] as (typeof edits)[number];
        if (q.nh === e.oh && q.oh === e.nh) {
          reverts = true;
          break;
        }
      }
      if (!reverts) continue;
      const s = sessions.get(e.session) ?? {
        ws: e.ws,
        count: 0,
        files: new Set(),
        redoTurns: new Set(),
      };
      s.count++;
      s.files.add(e.fp);
      s.redoTurns.add(e.owner);
      sessions.set(e.session, s);
    }
    i = j;
  }

  const allTurns = [...sessions.values()].flatMap((s) => [...s.redoTurns]);
  const price = priceTurns(db, allTurns);
  const inWindow = new Set(
    allTurns.filter((id) => {
      const r = db.prepare("SELECT ts FROM turns WHERE message_id = ?").get(id) as
        | { ts: string }
        | undefined;
      return r !== undefined && r.ts >= startIso && r.ts < nowIso;
    }),
  );
  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [sid, s] of sessions) {
    let measured = 0;
    for (const id of s.redoTurns) {
      checked.push(id);
      if (inWindow.has(id)) measured += price.get(id) ?? 0;
    }
    findings.push({
      scope: { workspace_id: s.ws, key: `C6|${sid}` },
      quantities: [
        { name: "flip_flops", unit: "events", value: s.count },
        { name: "affected_files", unit: "count", value: s.files.size },
        { name: "redo_turns", unit: "turns", value: s.redoTurns.size },
      ],
      measured_u: measured,
      // Reliability figure (dispatch: "card shows the full cost of the turn after each failure, an UPPER BOUND"):
      // modeled_u is the unscaled redo-turn cost. The card's x0.5 modelled share is exposed as an assumption only.
      assumptions: [
        {
          name: "wasted-turn avoidance fraction (modelled share, not applied to reliability)",
          value: AVOIDANCE,
          source: "dh-contracts.md C6 card, wasted-turn avoidance fraction",
        },
      ],
      modeled_u: measured,
      count: s.count,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "C6: Edit events in window on main-chain settled turns, per (session, file hash), old<>new hashes; reverting edit = " +
      "new==earlier.old and old==earlier.new. $ = recomputed full cost of distinct redo turns x 0.5 (upper bound, reliability " +
      "figure). No classifier-derived column used.",
  };
};
