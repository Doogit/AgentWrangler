/**
 * E2 MAIN_THREAD_MECHANICAL_RUNS count oracle, from the dh-contracts.md E2 card only.
 * Count = qualifying mechanical runs (>= 3 consecutive main-thread, non-provisional strong-model turns in a
 * reconciled session, each with >= 1 tool call, all calls in {Bash, PowerShell, Read, Grep, Glob}, output < 300)
 * in workspaces whose summed net saving (run cost - modelled Sonnet-subagent cost) is >= 1% of workspace spend in
 * [now-7d, now). A strong text-only turn neither counts nor breaks a run; any other main turn ends it.
 * The $ is ASSUMED-model-bound (30k subagent base, 0.5 avoidance); the graded figure is the run count.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_RUN = 3;
const MAX_OUT = 300;
const BASE_TOKENS = 30_000;
const MIN_PCT = 0.01;
const AVOIDANCE = 0.5;
const MECH = new Set(["Bash", "PowerShell", "Read", "Grep", "Glob"]);
const STRONG = /opus|fable|mythos/i;

interface T {
  message_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  model: string;
  output_tokens: number;
  context_tokens: number;
  cost_equiv_u: number | null;
}

export const oracleE2: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const sn = db
    .prepare(
      `SELECT unit_prices_json FROM pricing_snapshots WHERE model_tier = 'sonnet-5' ORDER BY captured_at DESC LIMIT 1`,
    )
    .get() as { unit_prices_json: string } | undefined;
  if (!sn) return { findings: [], turns_checked: [], note: "no sonnet-5 price vector" };
  const [, pOut, pRead, pW5] = JSON.parse(sn.unit_prices_json) as number[];

  const sessions = db
    .prepare(`SELECT session_id FROM sessions WHERE state = 'RECONCILED'`)
    .all() as Array<{ session_id: string }>;
  const turnStmt = db.prepare(
    `SELECT message_id, session_id, workspace_id, ts, model, output_tokens, context_tokens, cost_equiv_u
     FROM turns WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 ORDER BY ts, message_id`,
  );
  const toolStmt = db.prepare(
    `SELECT DISTINCT e.tool_name FROM tool_event_metadata m JOIN tool_events e ON e.event_id = m.event_id
     WHERE m.owner_message_id = ?`,
  );

  const spend = new Map<string, number>();
  for (const r of db
    .prepare(
      "SELECT workspace_id, COALESCE(SUM(cost_equiv_u), 0) s FROM turns WHERE ts >= ? AND ts < ? GROUP BY workspace_id",
    )
    .all(from, to) as Array<{ workspace_id: string; s: number }>)
    spend.set(r.workspace_id, r.s);

  const ws = new Map<string, { runs: number; turns: number; runCost: number; subCost: number }>();
  const checked: string[] = [];
  for (const { session_id } of sessions) {
    const all = turnStmt.all(session_id) as T[];
    let run: Array<{ t: T; growth: number }> = [];
    const flush = (): void => {
      if (run.length >= MIN_RUN) {
        const w = run[0]?.t.workspace_id as string;
        const g = ws.get(w) ?? { runs: 0, turns: 0, runCost: 0, subCost: 0 };
        let ctx = BASE_TOKENS;
        let sub = BASE_TOKENS * (pW5 as number);
        for (const { t, growth } of run) {
          // Cache read covers the context so far; this turn's growth is written, then joins the context.
          sub +=
            ctx * (pRead as number) + growth * (pW5 as number) + t.output_tokens * (pOut as number);
          ctx += growth;
        }
        sub += run[0]?.t.cost_equiv_u ?? 0;
        g.runs++;
        g.turns += run.length;
        g.runCost += run.reduce((s, x) => s + (x.t.cost_equiv_u ?? 0), 0);
        g.subCost += sub;
        ws.set(w, g);
        for (const x of run) checked.push(x.t.message_id);
      }
      run = [];
    };
    for (let i = 0; i < all.length; i++) {
      const t = all[i] as T;
      if (t.ts < from || t.ts >= to) {
        flush();
        continue;
      }
      const growth = i === 0 ? 0 : Math.max(0, t.context_tokens - (all[i - 1] as T).context_tokens);
      if (!STRONG.test(t.model)) {
        flush();
        continue;
      }
      const tools = (toolStmt.all(t.message_id) as Array<{ tool_name: string }>).map(
        (x) => x.tool_name,
      );
      if (tools.length === 0) continue; // text-only strong turn: neither counts nor breaks
      if (tools.every((n) => MECH.has(n)) && t.output_tokens < MAX_OUT) run.push({ t, growth });
      else flush();
    }
    flush();
  }

  const findings: OracleFinding[] = [];
  for (const [w, g] of [...ws].sort((a, b) => a[0].localeCompare(b[0]))) {
    const net = g.runCost - g.subCost;
    const s = spend.get(w) ?? 0;
    if (!(net > 0) || s <= 0 || net < MIN_PCT * s) continue;
    findings.push({
      scope: { workspace_id: w, key: `E2|${w}` },
      quantities: [
        { name: "runs", unit: "count", value: g.runs },
        { name: "run_turns", unit: "turns", value: g.turns },
      ],
      measured_u: Math.round(net),
      assumptions: [
        {
          name: "E2_SUBAGENT_BASE_TOKENS",
          value: BASE_TOKENS,
          source: "E2 card thresholds (ASSUMED)",
        },
        { name: "E2_AVOIDANCE_FRACTION", value: AVOIDANCE, source: "E2 card thresholds (ASSUMED)" },
      ],
      modeled_u: Math.round(net * AVOIDANCE),
      count: g.runs,
    });
  }
  const totalRuns = [...ws.values()].reduce((s, g) => s + g.runs, 0);
  return {
    findings,
    turns_checked: checked,
    note: `${totalRuns} candidate runs in ${ws.size} workspaces (net/spend ${[...ws]
      .map(([w, g]) => `${(((g.runCost - g.subCost) / (spend.get(w) || 1)) * 100).toFixed(2)}%`)
      .join(
        ", ",
      )}); ${findings.length} workspaces clear the 1% net-saving gate (assumption-bound $; graded on run count)`,
  };
};
