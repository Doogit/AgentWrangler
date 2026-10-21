/**
 * C4 FAILED_EDIT_RECOVERY_LOOP_V2 silence probe (card: docs/plans/dh-contracts.md C4). Independent recount.
 * Reads base ingest rows only (tool_events, tool_event_metadata, tool_event_content error text, turns, sessions).
 * No classifier columns (exit_class / tool_error_class) are read.
 */

import type Database from "better-sqlite3";
import type { ProbeGate, ProbeResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RUN = 3;
/** C3's "file has not been read" rejections are removed before runs form. */
const NOT_READ = /has not been read|must read .* first|read it first/i;

interface Ev {
  ts: string;
  block: number;
  failed: boolean;
}

export function probeC4(db: Database.Database, now: Date): ProbeResult {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.session_id AS sid, t.agent_id AS agent, m.file_path_hash AS fh,
              e.ts AS ts, m.block_index AS block,
              json_extract(c.content_json, '$.error') AS err
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
                     AND t.provisional = 0 AND (t.is_sidechain = 0 OR t.agent_id IS NOT NULL)
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.tool_name = 'Edit' AND m.file_path_hash IS NOT NULL
          AND e.ts >= ? AND e.ts < ?`,
    )
    .all(from, to) as {
    sid: string;
    agent: string | null;
    fh: string;
    ts: string;
    block: number;
    err: unknown;
  }[];

  const groups = new Map<string, { sid: string; evs: Ev[] }>();
  for (const r of rows) {
    const err = typeof r.err === "string" ? r.err : null;
    if (err !== null && NOT_READ.test(err)) continue;
    const key = `${r.sid}|${r.agent ?? ""}|${r.fh}`;
    let g = groups.get(key);
    if (!g) {
      g = { sid: r.sid, evs: [] };
      groups.set(key, g);
    }
    g.evs.push({ ts: r.ts, block: r.block, failed: err !== null });
  }

  // Longest unbroken failed run per session.
  const longest = new Map<string, number>();
  for (const g of groups.values()) {
    g.evs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.block - b.block));
    let run = 0;
    let max = 0;
    for (const ev of g.evs) {
      run = ev.failed ? run + 1 : 0;
      if (run > max) max = run;
    }
    if (max > (longest.get(g.sid) ?? 0)) longest.set(g.sid, max);
  }

  const cands = [...longest.entries()].filter(([, n]) => n >= 2);
  const qual = cands.filter(([, n]) => n >= MIN_RUN);
  const bestLen = Math.max(0, ...cands.map(([, n]) => n));
  const gates: ProbeGate[] =
    cands.length > 0
      ? [
          {
            name: "C4_MIN_CONSECUTIVE_FAILURES",
            value: bestLen,
            threshold: MIN_RUN,
            op: ">=",
            pass: bestLen >= MIN_RUN,
          },
        ]
      : [];
  return {
    candidates: cands.length,
    qualifying: qual.length,
    gates,
    note:
      "Sessions with a run of >=2 consecutive failed Edits on one file (candidates); qualifying = run >=3 (sessions counted). " +
      "Derivation: Edit events in reconciled sessions, ts in [now-7d, now), with a file path hash and an owning settled turn " +
      "(main chain, or sidechain with agent_id); grouped by session + agent + file hash, ordered by ts then block_index; " +
      "failed = tool_event_content $.error present (raw tool_result is_error); errors saying the file 'has not been read' are " +
      "dropped first (neither join nor break a run); any Edit without error ends the run. exit_class not read; a live-copy run " +
      "should cross-check with a raw-JSONL is_error sample count.",
  };
}
