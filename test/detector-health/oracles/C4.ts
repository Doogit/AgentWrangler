/**
 * C4 FAILED_EDIT_RECOVERY_LOOP_V2 reliability oracle. Written ONLY from the dh-contracts.md C4 card and Appendix S0/S2.
 * No imports from src/**.
 * Headline (reliability, upper bound) = full snapshot-priced cost of the RECOVERY turn R(t) of every issuing turn t
 * that owns an Edit in a run of >= 3 consecutive ERROR Edits (per workspace, session, chain, file hash).
 * One card per session. Main-chain figure is the graded headline; subagent runs go to a separate figure.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const MIN_RUN = 3;
const AVOIDANCE = 0.5;

interface EditRow {
  id: string;
  session: string;
  ts: string;
  bi: number;
  fp: string;
  exit: string | null;
  owner: string;
  ws: string;
  turn_ts: string;
  side: number;
  agent: string | null;
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

/** Card S0 item 6: components x snapshot price; invalid or missing snapshot adds 0; cache_write_other is not claimed. */
function claimU(t: TurnRow): number {
  if (!t.unit_prices_json) return 0;
  let p: unknown;
  try {
    p = JSON.parse(t.unit_prices_json);
  } catch {
    return 0;
  }
  if (!Array.isArray(p) || p.length !== 5) return 0;
  if (!p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) return 0;
  const [pin, pout, pread, pw5, pw1] = p as number[] as [number, number, number, number, number];
  return (
    t.input_tokens * pin +
    t.output_tokens * pout +
    t.cache_read_tokens * pread +
    t.cache_write_5m * pw5 +
    t.cache_write_1h * pw1
  );
}

export const oracleC4: Oracle = (db: Database.Database, now) => {
  const startIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();

  // Edits eligible to form runs: reconciled session, owner turn present and settled, file hash present, in window,
  // not rejected as "not read" (those neither join nor break a run). Main chain, or subagent with an agent id.
  const edits = db
    .prepare(
      `SELECT e.event_id id, e.session_id session, e.ts ts, m.block_index bi, m.file_path_hash fp, e.exit_class exit,
              m.owner_message_id owner, t.workspace_id ws, t.ts turn_ts, t.is_sidechain side, t.agent_id agent
       FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       JOIN sessions s ON s.session_id = e.session_id
       WHERE e.tool_name = 'Edit' AND e.ts >= ? AND e.ts < ?
         AND s.state = 'RECONCILED'
         AND t.provisional = 0
         AND m.file_path_hash IS NOT NULL
         AND (e.tool_error_class IS NULL OR e.tool_error_class <> 'NOT_READ')
         AND (t.is_sidechain = 0 OR (t.is_sidechain = 1 AND t.agent_id IS NOT NULL AND t.agent_id <> ''))
       ORDER BY e.session_id, t.is_sidechain, t.agent_id, m.file_path_hash, e.ts, m.block_index, e.event_id`,
    )
    .all(startIso, nowIso) as EditRow[];

  interface Sess {
    ws: string;
    failed: number;
    loops: number;
    files: Set<string>;
    mainIssuing: Set<string>;
    subIssuing: Map<string, { session: string; agent: string; ts: string }>;
  }
  const sessions = new Map<string, Sess>();
  const chainKey = (e: EditRow) => `${e.session}\u0000${e.side}\u0000${e.agent ?? ""}\u0000${e.fp}`;

  let i = 0;
  while (i < edits.length) {
    const first = edits[i] as EditRow;
    let j = i;
    while (j < edits.length && chainKey(edits[j] as EditRow) === chainKey(first)) j++;
    // Walk the (chain, file) group in order; collect unbroken ERROR runs.
    let k = i;
    while (k < j) {
      if ((edits[k] as EditRow).exit !== "ERROR") {
        k++;
        continue;
      }
      let end = k;
      while (end < j && (edits[end] as EditRow).exit === "ERROR") end++;
      if (end - k >= MIN_RUN) {
        const s = sessions.get(first.session) ?? {
          ws: first.ws,
          failed: 0,
          loops: 0,
          files: new Set<string>(),
          mainIssuing: new Set<string>(),
          subIssuing: new Map<string, { session: string; agent: string; ts: string }>(),
        };
        s.loops++;
        s.files.add(first.fp);
        for (let q = k; q < end; q++) {
          const e = edits[q] as EditRow;
          s.failed++;
          if (e.side === 0) s.mainIssuing.add(e.owner);
          else
            s.subIssuing.set(e.owner, { session: e.session, agent: e.agent ?? "", ts: e.turn_ts });
        }
        sessions.set(first.session, s);
      }
      k = end;
    }
    i = j;
  }

  const turnSql = `SELECT t.message_id, t.ts, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m,
                          t.cache_write_1h, p.unit_prices_json
                   FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id`;
  const mainRecovery = db.prepare(
    `${turnSql} WHERE t.session_id = ? AND t.is_sidechain = 0 AND t.provisional = 0 AND t.ts > ?
     ORDER BY t.ts, t.message_id LIMIT 1`,
  );
  const subRecovery = db.prepare(
    `${turnSql} WHERE t.session_id = ? AND t.is_sidechain = 1 AND t.agent_id = ? AND t.provisional = 0 AND t.ts > ?
     ORDER BY t.ts, t.message_id LIMIT 1`,
  );
  const issuingTs = db.prepare("SELECT ts FROM turns WHERE message_id = ?");

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  for (const [sid, s] of sessions) {
    const mainRec = new Map<string, TurnRow>();
    for (const id of s.mainIssuing) {
      const it = issuingTs.get(id) as { ts: string };
      const r = mainRecovery.get(sid, it.ts) as TurnRow | undefined;
      if (r && r.ts >= startIso && r.ts < nowIso) mainRec.set(r.message_id, r);
      checked.push(id);
    }
    const subRec = new Map<string, TurnRow>();
    for (const [id, v] of s.subIssuing) {
      const r = subRecovery.get(v.session, v.agent, v.ts) as TurnRow | undefined;
      if (r && r.ts >= startIso && r.ts < nowIso) subRec.set(r.message_id, r);
      checked.push(id);
    }
    let main = 0;
    for (const r of mainRec.values()) {
      main += claimU(r);
      checked.push(r.message_id);
    }
    let sub = 0;
    for (const r of subRec.values()) {
      sub += claimU(r);
      checked.push(r.message_id);
    }
    const mainU = Math.round(main);
    findings.push({
      scope: { workspace_id: s.ws, key: `C4|${s.ws}|${sid}` },
      quantities: [
        { name: "failed_edits", unit: "events", value: s.failed },
        { name: "recovery_loops", unit: "count", value: s.loops },
        { name: "affected_files", unit: "count", value: s.files.size },
        { name: "main_recovery_turns", unit: "turns", value: mainRec.size },
        { name: "subagent_recovery_turns", unit: "turns", value: subRec.size },
        { name: "subagent_reliability_u", unit: "count", value: Math.round(sub) },
      ],
      measured_u: mainU,
      assumptions: [
        {
          name: "wasted-turn avoidance fraction (modelled share only; NOT applied to the reliability headline)",
          value: AVOIDANCE,
          source: "dh-contracts.md C4 card",
        },
        {
          name: "no cross-family ownership cut (0 measured live)",
          value: 0,
          source: "dh-contracts.md Appendix S0 item 7, reviewer f9bdb7b3",
        },
        {
          name: "no D7 repeat-excess pre-exclusion replay",
          value: 0,
          source: "dh-contracts.md Appendix S2",
        },
      ],
      modeled_u: mainU,
      count: s.failed,
    });
  }
  return {
    findings,
    turns_checked: [...new Set(checked)],
    note:
      "C4: reconciled-session Edits in window, NOT_READ removed, per (session, chain, file hash) runs of >= 3 consecutive " +
      "ERROR Edits; headline = full snapshot price of distinct recovery turns R(t) (next settled turn of the chain, in window), " +
      "main chain only (subagent runs shown separately). Assumptions: no cross-family ownership cut (0 measured live), no D7 " +
      "repeat-excess pre-exclusion replay, classifier column tool_error_class used for NOT_READ.",
  };
};
