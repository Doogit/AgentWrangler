/**
 * C3 EDIT_BEFORE_READ_V2 reliability oracle. Written ONLY from the dh-contracts.md C3 card + Appendix S0.
 * No imports from src/**. Graded figure: "reliability" = the card headline Math.round(main ?? 0), i.e. the full
 * snapshot-priced cost of the RECOVERY turn after each NOT_READ Edit/Write on the main chain (upper bound).
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const AVOIDANCE = 0.5;

interface Issue {
  event: string;
  session: string;
  ts: string;
  tool: string;
  owner: string;
  ws: string;
  turn_ts: string;
  side: number;
  agent: string | null;
}

/** Card S0 item 6: components with tokens > 0 priced from the turn's own snapshot; bad snapshot = 0. */
function recoveryCost(db: Database.Database, id: string): { cost: number; priced: boolean } {
  const r = db
    .prepare(
      `SELECT t.input_tokens a, t.output_tokens b, t.cache_read_tokens c, t.cache_write_5m d, t.cache_write_1h e,
              p.unit_prices_json j
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE t.message_id = ?`,
    )
    .get(id) as
    | { a: number; b: number; c: number; d: number; e: number; j: string | null }
    | undefined;
  if (!r || !r.j) return { cost: 0, priced: false };
  let p: unknown;
  try {
    p = JSON.parse(r.j);
  } catch {
    return { cost: 0, priced: false };
  }
  if (!Array.isArray(p) || p.length !== 5 || !p.every((x) => Number.isFinite(x) && x >= 0))
    return { cost: 0, priced: false };
  const toks = [r.a, r.b, r.c, r.d, r.e];
  let sum = 0;
  for (let i = 0; i < 5; i++)
    if ((toks[i] as number) > 0) sum += (toks[i] as number) * (p[i] as number);
  // snapshot prices are $/MTok == µ$/token, so tokens x price is already µ$.
  return { cost: sum, priced: true };
}

export const oracleC3: Oracle = (db, now) => {
  const startIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();
  const issues = db
    .prepare(
      `SELECT e.event_id event, e.session_id session, e.ts ts, e.tool_name tool, m.owner_message_id owner,
              t.workspace_id ws, t.ts turn_ts, t.is_sidechain side, t.agent_id agent
       FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       JOIN sessions s ON s.session_id = e.session_id
       WHERE e.tool_name IN ('Edit','Write') AND e.tool_error_class = 'NOT_READ'
         AND e.tool_error_classifier_version = 'tool-error-1'
         AND e.ts >= ? AND e.ts < ? AND s.state = 'RECONCILED' AND t.provisional = 0
         AND (t.is_sidechain = 0 OR (t.is_sidechain = 1 AND t.agent_id IS NOT NULL))
       ORDER BY e.session_id, e.ts, e.event_id`,
    )
    .all(startIso, nowIso) as Issue[];

  const mainNext = db.prepare(
    `SELECT message_id id, ts FROM turns
     WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts > ?
     ORDER BY ts, message_id LIMIT 1`,
  );
  const subNext = db.prepare(
    `SELECT message_id id, ts FROM turns
     WHERE session_id = ? AND agent_id = ? AND is_sidechain = 1 AND provisional = 0 AND ts > ?
     ORDER BY ts, message_id LIMIT 1`,
  );

  interface Ws {
    calls: number;
    writes: number;
    subCalls: number;
    sessions: Set<string>;
    mainRecovery: Set<string>;
    subRecovery: Set<string>;
    issuingTurns: Set<string>;
  }
  const byWs = new Map<string, Ws>();
  for (const i of issues) {
    const w = byWs.get(i.ws) ?? {
      calls: 0,
      writes: 0,
      subCalls: 0,
      sessions: new Set(),
      mainRecovery: new Set(),
      subRecovery: new Set(),
      issuingTurns: new Set(),
    };
    w.calls++;
    if (i.tool === "Write") w.writes++;
    if (i.side === 1) w.subCalls++;
    w.sessions.add(i.session);
    w.issuingTurns.add(i.owner);
    const rec = (
      i.side === 0 ? mainNext.get(i.session, i.turn_ts) : subNext.get(i.session, i.agent, i.turn_ts)
    ) as { id: string; ts: string } | undefined;
    if (rec && rec.ts >= startIso && rec.ts < nowIso)
      (i.side === 0 ? w.mainRecovery : w.subRecovery).add(rec.id);
    byWs.set(i.ws, w);
  }

  const checked: string[] = [];
  const findings: OracleFinding[] = [];
  for (const [ws, w] of byWs) {
    let main = 0;
    for (const id of w.mainRecovery) {
      main += recoveryCost(db, id).cost;
      checked.push(id);
    }
    let sub = 0;
    for (const id of w.subRecovery) sub += recoveryCost(db, id).cost;
    const headline = Math.round(main);
    findings.push({
      scope: { workspace_id: ws, key: `C3|${ws}` },
      quantities: [
        { name: "not_read_calls", unit: "events", value: w.calls },
        { name: "write_calls", unit: "events", value: w.writes },
        { name: "subagent_calls", unit: "events", value: w.subCalls },
        { name: "sessions", unit: "sessions", value: w.sessions.size },
        { name: "main_recovery_turns", unit: "turns", value: w.mainRecovery.size },
        { name: "subagent_recovery_u", unit: "count", value: Math.round(sub) },
      ],
      measured_u: headline,
      assumptions: [
        {
          name: "wasted-turn avoidance fraction (modelled share only; not applied to the reliability headline)",
          value: AVOIDANCE,
          source: "dh-contracts.md C3 card, Thresholds",
        },
        {
          name: "no cross-family ownership cut (0 measured live)",
          value: 0,
          source: "dh-contracts.md Appendix S0 item 7",
        },
        {
          name: "no D7 repeat-excess pre-exclusion of Write NOT_READ issuing turns (Edit is protected)",
          value: 0,
          source: "dh-contracts.md C3 card + Appendix S2",
        },
        {
          name: "recovery turn = first settled same-session main-chain turn after the issuing turn (subagent: same agent)",
          value: 1,
          source: "dh-contracts.md Appendix S0 item 5",
        },
        {
          name: "tool_error_class NOT_READ (classifier tool-error-1) taken as given, not re-derived from error text",
          value: 1,
          source: "dh-contracts.md C3 card, Trigger",
        },
      ],
      modeled_u: headline,
      count: w.calls,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note:
      "C3: NOT_READ Edit/Write calls in window (reconciled session, settled turn, main chain or agent-id subagent). " +
      "Headline = Math.round(sum of full snapshot-priced recovery-turn cost, main chain only); 0 when all failures are " +
      "on subagents. Subagent recovery $ reported as a quantity, not graded.",
  };
};
