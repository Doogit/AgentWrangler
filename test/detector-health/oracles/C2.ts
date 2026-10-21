/**
 * C2 CONTENT_NOT_FOUND_V2 oracle (count + reliability headline), from the dh-contracts.md C2 card only.
 * Graded figure: reliability (modeled_u = headline); count kept on each finding.
 * Count = Read / Grep / Glob tool calls per workspace in [now-7d, now) whose stored error class is NOT_FOUND
 * (classifier version tool-error-1), in a RECONCILED session, owned by a non-provisional turn that is on the main
 * chain or is a subagent turn with a known agent id. One call can fire; no minimum count.
 * Card assumptions: the wasted-turn claim partition is $-side and is not modelled (the partition is not given in
 * the card). RC-B removed the 0.1 percent claimed-spend floor. "Known agent id" = non-null, non-empty turns.agent_id.
 */

import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const TOOLS = ["Read", "Grep", "Glob"];

interface Row {
  event_id: string;
  session_id: string;
  ts: string;
  tool_name: string;
  workspace_id: string;
  file_path: string;
  owner: string;
  turn_ts: string;
  side: number;
  agent: string | null;
}

/** Raw reconciliation: the transcript line at the event ts is an errored tool_result answering a Read/Grep/Glob tool_use. */
function reconcile(rows: Row[]): { sampled: number; matched: number } {
  const files = new Map<string, string[] | null>();
  const errored = new Map<string, Set<string>>();
  let sampled = 0;
  let matched = 0;
  for (const r of rows) {
    if (!files.has(r.file_path)) {
      try {
        files.set(r.file_path, fs.readFileSync(r.file_path, "utf8").split("\n"));
      } catch {
        files.set(r.file_path, null);
      }
    }
    const lines = files.get(r.file_path);
    if (!lines) continue;
    // tool_events.ts is the assistant tool_use line's timestamp; the error is on the tool_result that answers it.
    const line = lines.find((l) => l.includes(`"timestamp":"${r.ts}"`) && l.includes('"tool_use"'));
    if (!line) continue;
    sampled++;
    try {
      const uses = (
        JSON.parse(line) as {
          message?: { content?: Array<{ type?: string; id?: string; name?: string }> };
        }
      ).message?.content?.filter((b) => b.type === "tool_use" && b.id && b.name === r.tool_name);
      if (!uses?.length) continue;
      let bad = errored.get(r.file_path);
      if (!bad) {
        bad = new Set();
        for (const l of lines) {
          if (!l.includes('"tool_result"') || !l.includes('"is_error":true')) continue;
          try {
            const o = JSON.parse(l) as {
              message?: {
                content?: Array<{ type?: string; is_error?: boolean; tool_use_id?: string }>;
              };
            };
            for (const c of o.message?.content ?? [])
              if (c.type === "tool_result" && c.is_error === true && c.tool_use_id)
                bad.add(c.tool_use_id);
          } catch {
            /* skip */
          }
        }
        errored.set(r.file_path, bad);
      }
      if (uses.some((u) => bad?.has(u.id as string))) matched++;
    } catch {
      /* unparsable line counts as not matched */
    }
  }
  return { sampled, matched };
}

/** S0 item 6: full tokens x snapshot price for the five components; no snapshot or a bad one adds 0. In-window only. */
function recoveryCosts(
  db: Database.Database,
  ids: string[],
  from: string,
  to: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const q = db.prepare(
    `SELECT t.ts, t.input_tokens i, t.output_tokens o, t.cache_read_tokens cr, t.cache_write_5m w5,
            t.cache_write_1h w1, p.unit_prices_json pj
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.message_id = ?`,
  );
  for (const id of new Set(ids)) {
    const r = q.get(id) as
      | { ts: string; i: number; o: number; cr: number; w5: number; w1: number; pj: string | null }
      | undefined;
    if (!r || r.ts < from || r.ts >= to) continue;
    let total = 0;
    try {
      const p = r.pj ? (JSON.parse(r.pj) as unknown) : null;
      if (
        Array.isArray(p) &&
        p.length >= 5 &&
        p.slice(0, 5).every((x) => Number.isFinite(x) && x >= 0)
      ) {
        const t = [r.i, r.o, r.cr, r.w5, r.w1];
        for (let k = 0; k < 5; k++)
          if ((t[k] as number) > 0) total += (t[k] as number) * (p[k] as number);
      }
    } catch {
      /* bad snapshot adds 0 */
    }
    out.set(id, total);
  }
  return out;
}

export const oracleC2: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.event_id, e.session_id, e.ts, e.tool_name, s.workspace_id, s.file_path,
              t.message_id AS owner, t.ts AS turn_ts, t.is_sidechain AS side, t.agent_id AS agent
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       WHERE e.ts >= ? AND e.ts < ?
         AND e.tool_name IN ('Read','Grep','Glob')
         AND e.tool_error_class = 'NOT_FOUND'
         AND e.tool_error_classifier_version = 'tool-error-1'
         AND s.state = 'RECONCILED'
         AND t.provisional = 0
         AND (t.is_sidechain = 0 OR (t.agent_id IS NOT NULL AND t.agent_id != ''))
       ORDER BY e.ts`,
    )
    .all(from, to) as Row[];

  // Recovery turn R(t): next settled turn of the same chain after the issuing turn (S0 item 5).
  const nextMain = db.prepare(
    `SELECT message_id FROM turns WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts > ?
     ORDER BY ts, message_id LIMIT 1`,
  );
  const nextSub = db.prepare(
    `SELECT message_id FROM turns WHERE session_id = ? AND agent_id = ? AND is_sidechain = 1 AND provisional = 0
       AND ts > ? ORDER BY ts, message_id LIMIT 1`,
  );
  const byWs = new Map<
    string,
    { n: number; sessions: Set<string>; mainR: Set<string>; subR: Set<string> }
  >();
  for (const r of rows) {
    const g = byWs.get(r.workspace_id) ?? {
      n: 0,
      sessions: new Set<string>(),
      mainR: new Set<string>(),
      subR: new Set<string>(),
    };
    g.n++;
    g.sessions.add(r.session_id);
    const rec = (
      r.side === 0
        ? nextMain.get(r.session_id, r.turn_ts)
        : nextSub.get(r.session_id, r.agent, r.turn_ts)
    ) as { message_id: string } | undefined;
    if (rec) (r.side === 0 ? g.mainR : g.subR).add(rec.message_id);
    byWs.set(r.workspace_id, g);
  }

  const allR = [...byWs.values()].flatMap((g) => [...g.mainR, ...g.subR]);
  const cost = recoveryCosts(db, allR, from, to);
  const sumOf = (ids: Set<string>): number => {
    let s = 0;
    for (const id of ids) s += cost.get(id) ?? 0;
    return s;
  };

  const findings: OracleFinding[] = [...byWs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ws, g]) => {
      const main = Math.round(sumOf(g.mainR));
      return {
        scope: { workspace_id: ws, key: `C2|${ws}` },
        quantities: [
          { name: "error_count", unit: "events" as const, value: g.n },
          { name: "session_count", unit: "sessions" as const, value: g.sessions.size },
          { name: "recovery_turns_main", unit: "turns" as const, value: g.mainR.size },
          {
            name: "subagent_reliability_u",
            unit: "count" as const,
            value: Math.round(sumOf(g.subR)),
          },
        ],
        measured_u: main,
        assumptions: [],
        // Reliability headline (S0): FULL recovery-turn cost, main chain only, rounded once. A real 0 when none.
        modeled_u: main,
        count: g.n,
      };
    });
  const rec = reconcile(rows);
  return {
    findings,
    turns_checked: [...cost.keys()],
    note: `${rows.length} missing-path lookups in ${findings.length} workspaces; raw reconcile ${rec.matched}/${rec.sampled} of ${rows.length}. Reliability headline = full snapshot-priced cost of the recovery turn (next settled main-chain turn) of each issuing turn, rounded once. Assumptions: no cross-family ownership cut (0 measured live); D7 repeat-excess pre-exclusion and ledger priority not replayed; recovery turn must have ts in window; cache_write_other not priced.`,
  };
};
