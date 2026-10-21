/**
 * DH2 probe for C11 MCP_OUTPUT_CAP_V2, written from its contract card only.
 * Counts sessions with a main-chain tool call in the window whose error says the result was over
 * the output cap (MCP content too large, or Read output too large), in a reconciled session on a
 * settled turn. Reads base columns only: the over-cap kind is derived from the stored error text.
 */

import type Database from "better-sqlite3";
import type { Probe } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_CALLS = 1;
/** Probe's own rules for the two over-cap kinds. */
const MCP_CAP_RE = /mcpcontenttoolarge|exceeds maximum allowed tokens|too large/i;
const READ_CAP_RE = /exceeds maximum allowed (tokens|size)|too large|too big/i;

interface CallRow {
  session_id: string;
  tool_name: string;
  state: string;
  turn_id: string | null;
  provisional: number | null;
  is_sidechain: number | null;
  err: string | null;
}

export const probeC11: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const rows = db
    .prepare(
      `SELECT te.session_id AS session_id, te.tool_name AS tool_name, s.state AS state,
              t.message_id AS turn_id, t.provisional AS provisional, t.is_sidechain AS is_sidechain,
              json_extract(c.content_json, '$.error') AS err
         FROM tool_events te
         JOIN sessions s ON s.session_id = te.session_id
         JOIN tool_event_content c ON c.event_id = te.event_id
         LEFT JOIN tool_event_metadata m ON m.event_id = te.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
        WHERE (te.tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\' OR te.tool_name = 'Read')
          AND te.ts >= ? AND te.ts < ?`,
    )
    .all(from, to) as CallRow[];

  const hits = rows.filter((r) => {
    if (typeof r.err !== "string") return false;
    return r.tool_name === "Read" ? READ_CAP_RE.test(r.err) : MCP_CAP_RE.test(r.err);
  });
  const eligible = hits.filter(
    (r) =>
      r.state === "RECONCILED" && r.turn_id !== null && r.provisional === 0 && r.is_sidechain === 0,
  );

  const perSession = new Map<string, number>();
  for (const r of eligible) {
    perSession.set(r.session_id, (perSession.get(r.session_id) ?? 0) + 1);
  }
  const qualifying = [...perSession.values()].filter((n) => n >= MIN_CALLS).length;
  const bestCount = Math.max(0, ...perSession.values());

  return {
    candidates: new Set(hits.map((r) => r.session_id)).size,
    qualifying,
    gates: [
      {
        name: "minimum capped-call errors per session",
        value: bestCount,
        threshold: MIN_CALLS,
        op: ">=",
        pass: bestCount >= MIN_CALLS,
      },
    ],
    note: `${hits.length} over-cap call(s), ${eligible.length} main-chain on reconciled settled turns; over-cap kind read from error text`,
  };
};
