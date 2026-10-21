/**
 * DH2 probe for C3 EDIT_BEFORE_READ_V2, written from its contract card only.
 * Counts workspaces with an Edit/Write call in the window rejected as "file has not been read",
 * on a reconciled session and a settled turn (main chain, or subagent turn with an agent id).
 * Reads base columns only: the rejection is derived from the stored error text.
 */

import type Database from "better-sqlite3";
import type { Probe } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_CALLS = 1;
/** Probe's own rule: the tool's "has not been read" rejection message. */
const NOT_READ_RE = /not been read/i;

interface CallRow {
  workspace_id: string;
  state: string;
  turn_id: string | null;
  provisional: number | null;
  is_sidechain: number | null;
  agent_id: string | null;
  err: string | null;
}

export const probeC3: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const rows = db
    .prepare(
      `SELECT s.workspace_id AS workspace_id, s.state AS state,
              t.message_id AS turn_id, t.provisional AS provisional, t.is_sidechain AS is_sidechain,
              t.agent_id AS agent_id, json_extract(c.content_json, '$.error') AS err
         FROM tool_events te
         JOIN sessions s ON s.session_id = te.session_id
         JOIN tool_event_content c ON c.event_id = te.event_id
         LEFT JOIN tool_event_metadata m ON m.event_id = te.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
        WHERE te.tool_name IN ('Edit', 'Write')
          AND te.ts >= ? AND te.ts < ?`,
    )
    .all(from, to) as CallRow[];

  const hits = rows.filter((r) => typeof r.err === "string" && NOT_READ_RE.test(r.err));
  const eligible = hits.filter(
    (r) =>
      r.state === "RECONCILED" &&
      r.turn_id !== null &&
      r.provisional === 0 &&
      (r.is_sidechain === 0 || (r.is_sidechain === 1 && r.agent_id !== null)),
  );

  const perWs = new Map<string, number>();
  for (const r of eligible) perWs.set(r.workspace_id, (perWs.get(r.workspace_id) ?? 0) + 1);
  const qualifying = [...perWs.values()].filter((n) => n >= MIN_CALLS).length;
  const bestCount = Math.max(0, ...perWs.values());

  return {
    candidates: new Set(hits.map((r) => r.workspace_id)).size,
    qualifying,
    gates: [
      {
        name: "minimum qualifying calls",
        value: bestCount,
        threshold: MIN_CALLS,
        op: ">=",
        pass: bestCount >= MIN_CALLS,
      },
    ],
    note: `${hits.length} Edit/Write not-read rejection(s), ${eligible.length} on reconciled settled turns; rejection read from error text`,
  };
};
