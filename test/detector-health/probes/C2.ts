/**
 * DH2 probe for C2 CONTENT_NOT_FOUND_V2, written from its contract card only.
 * Counts workspaces with a Read/Grep/Glob call in the window whose error text says "not found",
 * on a reconciled session and a settled turn (main chain, or subagent turn with an agent id).
 * RC-B removed the 0.1 percent spend floor. Reads base columns only: the app's error-class
 * columns are not used; "not found" is derived from the stored error text.
 */

import type Database from "better-sqlite3";
import type { Probe } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Probe's own rule: error text that reports a missing path or pattern target. */
const NOT_FOUND_RE = /not found|does not exist|no such file|enoent/i;

interface CallRow {
  workspace_id: string;
  session_id: string;
  state: string;
  turn_id: string | null;
  provisional: number | null;
  is_sidechain: number | null;
  agent_id: string | null;
  cost: number | null;
  err: string | null;
}

export const probeC2: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const rows = db
    .prepare(
      `SELECT s.workspace_id AS workspace_id, te.session_id AS session_id, s.state AS state,
              t.message_id AS turn_id, t.provisional AS provisional, t.is_sidechain AS is_sidechain,
              t.agent_id AS agent_id, t.cost_equiv_u AS cost,
              json_extract(c.content_json, '$.error') AS err
         FROM tool_events te
         JOIN sessions s ON s.session_id = te.session_id
         JOIN tool_event_content c ON c.event_id = te.event_id
         LEFT JOIN tool_event_metadata m ON m.event_id = te.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
        WHERE te.tool_name IN ('Read', 'Grep', 'Glob')
          AND te.ts >= ? AND te.ts < ?`,
    )
    .all(from, to) as CallRow[];

  const hits = rows.filter((r) => typeof r.err === "string" && NOT_FOUND_RE.test(r.err));
  const candidateWs = new Set(hits.map((r) => r.workspace_id));

  const eligible = hits.filter(
    (r) =>
      r.state === "RECONCILED" &&
      r.turn_id !== null &&
      r.provisional === 0 &&
      (r.is_sidechain === 0 || (r.is_sidechain === 1 && r.agent_id !== null)),
  );

  return {
    candidates: candidateWs.size,
    qualifying: new Set(eligible.map((r) => r.workspace_id)).size,
    gates: [],
    note: `${hits.length} Read/Grep/Glob not-found call(s) in ${candidateWs.size} workspace(s); not-found read from error text; no spend floor since RC-B`,
  };
};
