/**
 * C11 MCP_OUTPUT_CAP_V2 reliability oracle, from the dh-contracts.md C11 card + Appendix S0 only. No imports from src/**.
 * Per (workspace, session): every capped call (class MCP_CONTENT_TOO_LARGE or READ_OUTPUT_TOO_LARGE, classifier
 * tool-error-1, event ts in [now-7d, now), reconciled session, owner turn main-chain and settled) claims two turns IN
 * FULL: the issuing turn and the retry turn (first settled main-chain turn of the session, ordered by (ts, message_id),
 * with ts later than the issuing turn). Each distinct turn once, only if settled and inside the window. Priced per
 * component at the turn's own pricing snapshot, summed. Card count = MCP over-cap errors only (Read ones excluded).
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const AVOIDANCE = 0.5;

interface CallRow {
  session_id: string;
  ws: string;
  cls: string;
  turn_id: string;
  turn_ts: string;
}
interface TurnRow {
  message_id: string;
  ts: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  unit_prices_json: string | null;
}

/** Appendix S0 item 6: tokens x snapshot price per component; bad/absent snapshot adds 0; "other" bucket not claimed. */
function claimU(t: TurnRow): number {
  if (!t.unit_prices_json) return 0;
  let p: unknown;
  try {
    p = JSON.parse(t.unit_prices_json);
  } catch {
    return 0;
  }
  if (
    !Array.isArray(p) ||
    p.length !== 5 ||
    !p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
  )
    return 0;
  const [pin, pout, pread, pw5, pw1] = p as number[] as [number, number, number, number, number];
  return (
    t.input_tokens * pin +
    t.output_tokens * pout +
    t.cache_read_tokens * pread +
    t.cache_write_5m * pw5 +
    t.cache_write_1h * pw1
  );
}

export const oracleC11: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const calls = db
    .prepare(
      `SELECT e.session_id session_id, s.workspace_id ws, e.tool_error_class cls,
              t.message_id turn_id, t.ts turn_ts
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       WHERE e.ts >= ? AND e.ts < ?
         AND e.tool_error_class IN ('MCP_CONTENT_TOO_LARGE','READ_OUTPUT_TOO_LARGE')
         AND e.tool_error_classifier_version = 'tool-error-1'
         AND s.state = 'RECONCILED'
         AND t.is_sidechain = 0 AND t.provisional = 0
       ORDER BY e.session_id, e.ts, e.event_id`,
    )
    .all(from, to) as CallRow[];

  const bySession = new Map<
    string,
    { ws: string; mcp: number; read: number; issuing: Map<string, string> }
  >();
  for (const c of calls) {
    const g = bySession.get(c.session_id) ?? { ws: c.ws, mcp: 0, read: 0, issuing: new Map() };
    if (c.cls === "MCP_CONTENT_TOO_LARGE") g.mcp++;
    else g.read++;
    g.issuing.set(c.turn_id, c.turn_ts);
    bySession.set(c.session_id, g);
  }

  const turnsStmt = db.prepare(
    `SELECT t.message_id, t.ts, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m,
            t.cache_write_1h, p.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.session_id = ? AND t.is_sidechain = 0 AND t.provisional = 0
     ORDER BY t.ts, t.message_id`,
  );

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [sid, g] of [...bySession.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const turns = turnsStmt.all(sid) as TurnRow[];
    const claimed = new Map<string, TurnRow>();
    for (const [id, ts] of g.issuing) {
      const own = turns.find((t) => t.message_id === id);
      if (own) claimed.set(id, own);
      const retry = turns.find((t) => t.ts > ts);
      if (retry) claimed.set(retry.message_id, retry);
    }
    let measured = 0;
    for (const t of claimed.values()) {
      if (t.ts < from || t.ts >= to) continue;
      checked.push(t.message_id);
      measured += claimU(t);
    }
    findings.push({
      scope: { workspace_id: g.ws, key: `C11|${g.ws}|${sid}` },
      quantities: [
        { name: "mcp_overcap_errors", unit: "events", value: g.mcp },
        { name: "read_overcap_errors", unit: "events", value: g.read },
        { name: "claimed_turns", unit: "turns", value: claimed.size },
      ],
      measured_u: measured,
      assumptions: [
        {
          name: "no cross-family ownership cut (0 measured live)",
          value: 0,
          source: "dh-contracts.md Appendix S0 item 7, reviewer f9bdb7b3",
        },
        {
          name: "wasted-turn avoidance fraction (rank value only; headline claims turns in full)",
          value: AVOIDANCE,
          source: "dh-contracts.md C11 card",
        },
        {
          name: "classifier fields and session state read as stored; ingest reconcile is not re-derived",
          value: 1,
          source: "dh-contracts.md C11 card, Inputs",
        },
      ],
      modeled_u: measured,
      count: g.mcp,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note: `C11: ${calls.length} over-cap calls in ${findings.length} sessions; issuing + retry turns claimed in full, priced per component from snapshots`,
  };
};
