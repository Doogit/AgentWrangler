/**
 * G11 HIGH_SPEND_OBSERVED_FAILURE_V2 oracle, from the dh-contracts.md G11 card only.
 * Candidate = MERGED/CLOSED work item, OBSERVED_FAILURE, terminal time in [now-7d, now), fully attributable
 * (every linked session RECONCILED, same workspace, >= 1 non-provisional turn), item tokens >= baseline p90 and
 * item cost >= 1% of workspace 90d spend. Baseline = other fully attributable terminal items (success / deferrals /
 * failure) finishing in [now-90d, now), >= 20, else per-session token totals (>= 20). p90 = nearest rank ceil(0.9n).
 * Graded figure: modelled saving = item cost x (item - p90 tokens) x 0.5 / item tokens (u/wk); count = findings.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_BASELINE = 20;
const MIN_PCT = 0.01;
const AVOIDANCE = 0.5;
const TOKENS =
  "input_tokens + output_tokens + cache_read_tokens + cache_write_5m + cache_write_1h + cache_write_other";

interface Item {
  work_item_id: string;
  workspace_id: string;
  terminal: string;
}
interface TurnRow {
  message_id: string;
  ts: string;
  tokens: number;
  cost: number | null;
}

export const oracleG11: Oracle = (db: Database.Database, now: Date) => {
  const to = now.toISOString();
  const from7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const from90 = new Date(now.getTime() - 90 * DAY_MS).toISOString();

  const items = (
    db
      .prepare(
        `SELECT w.work_item_id, w.workspace_id,
                CASE w.state WHEN 'MERGED' THEN COALESCE(w.merged_at, w.closed_at)
                             ELSE COALESCE(w.closed_at, w.merged_at) END AS terminal
         FROM work_items w WHERE w.state IN ('MERGED','CLOSED')`,
      )
      .all() as Array<{ work_item_id: string; workspace_id: string; terminal: string | null }>
  ).filter((i): i is Item => i.terminal !== null);
  const terminalOf = new Map(items.map((i) => [i.work_item_id, i.terminal]));

  const outcome = new Map(
    (
      db.prepare("SELECT work_item_id, outcome FROM observed_outcomes").all() as Array<{
        work_item_id: string;
        outcome: string;
      }>
    ).map((r) => [r.work_item_id, r.outcome]),
  );

  const linkedSessions = db.prepare(
    `SELECT l.session_id, s.workspace_id, s.state,
            (SELECT COUNT(*) FROM turns t WHERE t.session_id = l.session_id AND t.provisional = 0) AS n
     FROM session_work_links l JOIN sessions s ON s.session_id = l.session_id WHERE l.work_item_id = ?`,
  );
  const sessionLinks = db.prepare(
    "SELECT work_item_id FROM session_work_links WHERE session_id = ?",
  );
  const sessionTurns = db.prepare(
    `SELECT message_id, ts, (${TOKENS}) AS tokens, cost_equiv_u AS cost
     FROM turns WHERE session_id = ? AND provisional = 0 ORDER BY ts, message_id`,
  );

  /** Assigned turns of a fully attributable item, or null when not fully attributable. */
  const itemTurns = (it: Item): TurnRow[] | null => {
    const ss = linkedSessions.all(it.work_item_id) as Array<{
      session_id: string;
      workspace_id: string;
      state: string;
      n: number;
    }>;
    if (ss.length === 0) return null;
    const out: TurnRow[] = [];
    for (const s of ss) {
      if (s.workspace_id !== it.workspace_id || s.state !== "RECONCILED" || s.n < 1) return null;
      const finishes = (sessionLinks.all(s.session_id) as Array<{ work_item_id: string }>)
        .map((r) => ({ id: r.work_item_id, t: terminalOf.get(r.work_item_id) }))
        .filter((x): x is { id: string; t: string } => x.t !== undefined)
        .sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id));
      for (const t of sessionTurns.all(s.session_id) as TurnRow[]) {
        const next = finishes.find((f) => f.t >= t.ts) ?? finishes[finishes.length - 1];
        if (next?.id === it.work_item_id) out.push(t);
      }
    }
    return out.length > 0 ? out : null;
  };

  const findings: OracleFinding[] = [];
  const checked: string[] = [];
  const notes: string[] = [];

  const candidates = items.filter(
    (i) =>
      outcome.get(i.work_item_id) === "OBSERVED_FAILURE" && i.terminal >= from7 && i.terminal < to,
  );
  for (const c of candidates) {
    const turns = itemTurns(c);
    if (!turns) {
      notes.push("candidate not fully attributable");
      continue;
    }
    const tokens = turns.reduce((s, t) => s + t.tokens, 0);
    const cost = turns.reduce((s, t) => s + (t.cost ?? 0), 0);

    // Baseline: other attributable terminal items of the workspace in the trailing 90 days.
    let base: number[] = [];
    for (const o of items) {
      if (o.workspace_id !== c.workspace_id || o.work_item_id === c.work_item_id) continue;
      if (o.terminal < from90 || o.terminal >= to) continue;
      const oc = outcome.get(o.work_item_id);
      if (
        oc !== "OBSERVED_SUCCESS" &&
        oc !== "OBSERVED_SUCCESS_WITH_DEFERRALS" &&
        oc !== "OBSERVED_FAILURE"
      )
        continue;
      const ot = itemTurns(o);
      if (ot) base.push(ot.reduce((s, t) => s + t.tokens, 0));
    }
    let basis = "work items";
    if (base.length < MIN_BASELINE) {
      basis = "sessions";
      base = (
        db
          .prepare(
            `SELECT SUM(${TOKENS}) AS tok FROM turns
             WHERE workspace_id = ? AND provisional = 0 AND ts >= ? AND ts < ?
               AND session_id NOT IN (SELECT session_id FROM session_work_links WHERE work_item_id = ?)
             GROUP BY session_id`,
          )
          .all(c.workspace_id, from90, to, c.work_item_id) as Array<{ tok: number }>
      ).map((r) => r.tok);
    }
    if (base.length < MIN_BASELINE) {
      notes.push(`baseline ${base.length} < ${MIN_BASELINE}`);
      continue;
    }
    base.sort((a, b) => a - b);
    const p90 = base[Math.ceil(0.9 * base.length) - 1] as number;
    if (tokens < p90) {
      notes.push(`tokens ${tokens} < p90 ${p90}`);
      continue;
    }
    const spend = (
      db
        .prepare(
          "SELECT COALESCE(SUM(cost_equiv_u), 0) AS s FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?",
        )
        .get(c.workspace_id, from90, to) as { s: number }
    ).s;
    if (spend > 0 && cost < MIN_PCT * spend) {
      notes.push(`share ${((cost / spend) * 100).toFixed(3)}% < 1%`);
      continue;
    }
    const modeled =
      cost > 0 && tokens > 0 ? Math.round((cost * (tokens - p90) * AVOIDANCE) / tokens) : null;
    for (const t of turns) checked.push(t.message_id);
    findings.push({
      scope: { workspace_id: c.workspace_id, key: `G11|${c.workspace_id}|${c.work_item_id}` },
      quantities: [
        { name: "item_tokens", unit: "tokens", value: tokens },
        { name: "p90_tokens", unit: "tokens", value: p90 },
        { name: "baseline_n", unit: "count", value: base.length },
      ],
      measured_u: cost,
      assumptions: [
        {
          name: "G11_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "G11 card thresholds (ASSUMED)",
        },
        {
          name: "G11_MIN_COMPARISON_WORK_ITEMS",
          value: MIN_BASELINE,
          source: "G11 card thresholds",
        },
        {
          name: "baseline_basis",
          value: basis === "work items" ? 0 : 1,
          source: "0 = work items, 1 = session fallback",
        },
        {
          name: "terminal_time",
          value: 0,
          source: "merged_at for MERGED, closed_at for CLOSED (card: 'merged or closed')",
        },
        {
          name: "spend_90d_scope",
          value: 0,
          source: "all workspace turns (incl. provisional) in [now-90d, now); card does not say",
        },
        {
          name: "unpriced_fallback",
          value: 0,
          source: "blended cache-read fallback not modelled: modeled_u null when item cost is 0",
        },
      ],
      modeled_u: modeled,
      count: 1,
    });
  }
  return {
    findings,
    turns_checked: checked,
    note: `${candidates.length} candidate failed items; ${findings.length} qualify${notes.length ? ` (${notes.join("; ")})` : ""}`,
  };
};
