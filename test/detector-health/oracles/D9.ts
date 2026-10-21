/**
 * D9 FORK_SUBAGENT count oracle, from the dh-contracts.md D9 card only. Graded figure: the fork count.
 * A fork = subagent_meta.agent_type exactly "fork". It is in the window [now-7d, now) when at least one of its
 * settled turns (turns.agent_id) falls in the window; if none of its turns were ever ingested, when its parent
 * session's last_turn_at falls in the window. A workspace fires when it has >= 1 in-window fork and, if an
 * estimate exists, estimate >= 0.25% of the workspace's 7-day spend. Estimate = cache-read tokens of the forks'
 * priced in-window turns x each turn's own cache-read price; no priced cache reads = "not measured", never gated.
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_PCT_OF_SPEND = 0.25; // card: D9_MIN_PCT_OF_SPEND

interface ForkRow {
  agent_id: string;
  session_id: string | null;
}
interface TurnRow {
  message_id: string;
  workspace_id: string;
  ts: string;
  cache_read_tokens: number;
  unit_prices_json: string | null;
}

export const oracleD9: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const forks = db
    .prepare(`SELECT agent_id, session_id FROM subagent_meta WHERE agent_type = 'fork'`)
    .all() as ForkRow[];
  const turnStmt = db.prepare(
    `SELECT t.message_id, t.workspace_id, t.ts, t.cache_read_tokens, p.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.agent_id = ? AND t.provisional = 0`,
  );
  const sessStmt = db.prepare(
    "SELECT workspace_id, last_turn_at FROM sessions WHERE session_id = ?",
  );

  interface Ws {
    forks: number;
    sessions: Set<string>;
    readTokens: number;
    estimate: number;
    measured: boolean;
  }
  const byWs = new Map<string, Ws>();
  const checked: string[] = [];
  for (const f of forks) {
    const all = turnStmt.all(f.agent_id) as TurnRow[];
    let ws: string | null = null;
    const inWin = all.filter((t) => t.ts >= from && t.ts < to);
    if (all.length > 0) {
      if (inWin.length === 0) continue;
      ws = (inWin[0] as TurnRow).workspace_id;
    } else {
      const s = f.session_id
        ? (sessStmt.get(f.session_id) as
            | { workspace_id: string; last_turn_at: string | null }
            | undefined)
        : undefined;
      if (!s || !s.last_turn_at || s.last_turn_at < from || s.last_turn_at >= to) continue;
      ws = s.workspace_id;
    }
    const g = byWs.get(ws) ?? {
      forks: 0,
      sessions: new Set<string>(),
      readTokens: 0,
      estimate: 0,
      measured: false,
    };
    g.forks++;
    if (f.session_id) g.sessions.add(f.session_id);
    for (const t of inWin) {
      if (!t.unit_prices_json || t.cache_read_tokens <= 0) continue;
      const pread = (JSON.parse(t.unit_prices_json) as number[])[2] as number;
      g.readTokens += t.cache_read_tokens;
      g.estimate += t.cache_read_tokens * pread; // $/MTok == µ$/token
      g.measured = true;
      checked.push(t.message_id);
    }
    byWs.set(ws, g);
  }

  // Workspace 7-day spend: all settled in-window turns, recomputed.
  const spendRows = db
    .prepare(
      "SELECT message_id, workspace_id FROM turns WHERE provisional = 0 AND ts >= ? AND ts < ?",
    )
    .all(from, to) as Array<{ message_id: string; workspace_id: string }>;
  const cost = priceTurns(
    db,
    spendRows.map((r) => r.message_id),
  );
  const spend = new Map<string, number>();
  for (const r of spendRows)
    spend.set(r.workspace_id, (spend.get(r.workspace_id) ?? 0) + (cost.get(r.message_id) ?? 0));

  const findings: OracleFinding[] = [];
  const pcts: string[] = [];
  for (const [w, g] of [...byWs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = spend.get(w) ?? 0;
    if (g.measured && s > 0) {
      const pct = (g.estimate / s) * 100;
      pcts.push(pct.toFixed(4));
      if (pct < MIN_PCT_OF_SPEND) continue;
    }
    findings.push({
      scope: { workspace_id: w, key: `D9|${w}` },
      quantities: [
        { name: "forks", unit: "count", value: g.forks },
        { name: "fork_cache_read_tokens", unit: "tokens", value: g.readTokens },
        { name: "parent_sessions", unit: "sessions", value: g.sessions.size },
      ],
      measured_u: g.measured ? Math.round(g.estimate) : null,
      assumptions: [],
      modeled_u: g.measured ? Math.round(g.estimate) : null,
      count: g.forks,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note: `${forks.length} fork rows, ${byWs.size} workspaces with in-window forks (estimate pct of spend: ${pcts.join(", ") || "n/a"}); ${findings.length} fire (graded on fork count)`,
  };
};
