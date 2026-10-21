/**
 * DH2 probe for G11 (HIGH_SPEND_OBSERVED_FAILURE_V2), written from its contract card only.
 * Read list: docs/plans/dh-contracts.md (header + G11 card); docs/plans/spec-detector-health.md (s2, s3 DH2 row);
 * base-table DDL dump (scratchpad ddl.sql); test/fixtures/detector-health/G11/{manifest.json,README.md,
 * rows-positive.json (head), positive/g11-cand.jsonl}; test/detector-health/{probes/types.ts,probes/index.ts,
 * probes.test.ts,harness.ts,manifest.ts}.
 *
 * Reads work_items, observed_outcomes, session_work_links (non-transcript inputs) plus sessions and turns.
 * No classifier columns. observed_outcomes is the card's declared input.
 *
 * Card reading (open questions):
 *  - Terminal time = merged_at for MERGED, closed_at for CLOSED (falling back to the other column if null).
 *  - Item tokens = sum over the item's assigned non-provisional turns of context_tokens + output_tokens
 *    (input + output + cache reads + all cache writes). Cost = sum of their non-null cost_equiv_u.
 *  - Baseline window [now-90d, now), lower bound inclusive; baseline outcomes = any outcome except IN_PROGRESS.
 *  - Fallback sessions: sessions of the workspace with non-provisional turns in the 90d window, per-session token
 *    totals over that window, excluding sessions linked to the candidate.
 *  - Workspace 90-day spend = summed non-null cost_equiv_u of the workspace's turns in [now-90d, now);
 *    zero/unknown spend skips the 1% test.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_BASELINE = 20;

interface Item {
  id: string;
  ws: string;
  state: string;
  outcome: string | null;
  term: number;
  tokens: number;
  cost: number;
  turns: number;
  sessions: string[];
}

function p90(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1] as number;
}

export const probeG11: Probe = (db: Database.Database, now: Date) => {
  const fromMs = now.getTime() - 7 * DAY_MS;
  const toMs = now.getTime();
  const baseFromMs = now.getTime() - 90 * DAY_MS;
  const baseFrom = new Date(baseFromMs).toISOString();
  const to = now.toISOString();

  const items = new Map<string, Item>();
  for (const r of db
    .prepare(
      `SELECT w.work_item_id, w.workspace_id, w.state, w.merged_at, w.closed_at, o.outcome
       FROM work_items w LEFT JOIN observed_outcomes o ON o.work_item_id = w.work_item_id
       WHERE w.state IN ('MERGED','CLOSED')`,
    )
    .all() as {
    work_item_id: string;
    workspace_id: string;
    state: string;
    merged_at: string | null;
    closed_at: string | null;
    outcome: string | null;
  }[]) {
    const t = r.state === "MERGED" ? (r.merged_at ?? r.closed_at) : (r.closed_at ?? r.merged_at);
    const term = t ? Date.parse(t) : Number.NaN;
    if (Number.isNaN(term)) continue;
    items.set(r.work_item_id, {
      id: r.work_item_id,
      ws: r.workspace_id,
      state: r.state,
      outcome: r.outcome,
      term,
      tokens: 0,
      cost: 0,
      turns: 0,
      sessions: [],
    });
  }

  const sessInfo = new Map<string, { ws: string; reconciled: boolean; settled: number }>();
  for (const s of db
    .prepare(
      "SELECT session_id, workspace_id, state FROM sessions WHERE session_id IN (SELECT session_id FROM session_work_links)",
    )
    .all() as { session_id: string; workspace_id: string; state: string }[]) {
    sessInfo.set(s.session_id, {
      ws: s.workspace_id,
      reconciled: s.state === "RECONCILED",
      settled: 0,
    });
  }

  const linksBySession = new Map<string, Item[]>();
  for (const l of db.prepare("SELECT session_id, work_item_id FROM session_work_links").all() as {
    session_id: string;
    work_item_id: string;
  }[]) {
    const it = items.get(l.work_item_id);
    if (!it) continue;
    it.sessions.push(l.session_id);
    const a = linksBySession.get(l.session_id) ?? [];
    a.push(it);
    linksBySession.set(l.session_id, a);
  }

  // Assign each settled turn of a linked session to the nearest item finishing at/after it, else the last to finish.
  for (const t of db
    .prepare(
      `SELECT session_id, ts, context_tokens + output_tokens AS tokens, cost_equiv_u AS cost
       FROM turns WHERE provisional = 0 AND session_id IN (SELECT session_id FROM session_work_links)`,
    )
    .all() as { session_id: string; ts: string; tokens: number; cost: number | null }[]) {
    const si = sessInfo.get(t.session_id);
    if (si) si.settled++;
    const linked = linksBySession.get(t.session_id);
    if (!linked || linked.length === 0) continue;
    const tm = Date.parse(t.ts);
    const sorted = [...linked].sort((a, b) => a.term - b.term || a.id.localeCompare(b.id));
    const owner = sorted.find((i) => i.term >= tm) ?? (sorted[sorted.length - 1] as Item);
    owner.tokens += t.tokens;
    owner.cost += t.cost ?? 0;
    owner.turns++;
  }

  const attributable = (it: Item): boolean =>
    it.sessions.length > 0 &&
    it.sessions.every((sid) => {
      const si = sessInfo.get(sid);
      return !!si && si.ws === it.ws && si.reconciled && si.settled > 0;
    });

  const spendStmt = db.prepare(
    "SELECT SUM(cost_equiv_u) AS u FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?",
  );
  const fallbackStmt = db.prepare(
    `SELECT session_id, SUM(context_tokens + output_tokens) AS tokens FROM turns
     WHERE workspace_id = ? AND provisional = 0 AND ts >= ? AND ts < ? GROUP BY session_id`,
  );

  let candidates = 0;
  let qualifying = 0;
  let best: { score: number; gates: ProbeGate[] } | null = null;

  for (const c of items.values()) {
    if (c.outcome !== "OBSERVED_FAILURE" || c.term < fromMs || c.term >= toMs) continue;
    candidates++;

    const baseline = [...items.values()].filter(
      (i) =>
        i.id !== c.id &&
        i.ws === c.ws &&
        i.outcome !== null &&
        i.outcome !== "IN_PROGRESS" &&
        i.term >= baseFromMs &&
        i.term < toMs &&
        attributable(i),
    );
    let baseN = baseline.length;
    let tokens = baseline.map((i) => i.tokens);
    if (baseN < MIN_BASELINE) {
      const exclude = new Set(c.sessions);
      const fb = (
        fallbackStmt.all(c.ws, baseFrom, to) as { session_id: string; tokens: number }[]
      ).filter((r) => !exclude.has(r.session_id));
      if (fb.length >= MIN_BASELINE) {
        baseN = fb.length;
        tokens = fb.map((r) => r.tokens);
      }
    }
    const haveBaseline = baseN >= MIN_BASELINE;
    const p = haveBaseline ? p90(tokens) : null;

    const spend = ((spendStmt.get(c.ws, baseFrom, to) as { u: number | null }).u ?? 0) as number;
    const pct = spend > 0 ? (c.cost / spend) * 100 : null;
    const attr = attributable(c);

    const gates: ProbeGate[] = [
      { name: "FULLY_ATTRIBUTABLE", value: attr ? 1 : 0, threshold: 1, op: ">=", pass: attr },
      {
        name: "G11_MIN_COMPARISON_WORK_ITEMS",
        value: baseN,
        threshold: MIN_BASELINE,
        op: ">=",
        pass: haveBaseline,
      },
      {
        name: "p90 of baseline tokens",
        value: c.tokens,
        threshold: p ?? 0,
        op: ">=",
        pass: p !== null && c.tokens >= p,
      },
      pct === null
        ? { name: "G11_MIN_PCT_OF_90D_SPEND", value: null, threshold: 1, op: ">=", pass: true }
        : { name: "G11_MIN_PCT_OF_90D_SPEND", value: pct, threshold: 1, op: ">=", pass: pct >= 1 },
      { name: "TURN_ANCHOR", value: c.turns, threshold: 0, op: ">", pass: c.turns > 0 },
    ];
    const all = gates.every((g) => g.pass);
    if (all) qualifying++;
    const score = gates.filter((g) => g.pass).length + (all ? 100 : 0);
    if (!best || score > best.score) best = { score, gates };
  }

  return {
    candidates,
    qualifying,
    gates: best?.gates ?? [],
    note: `${candidates} merged/closed observed-failure items with terminal time in window; ${qualifying} pass attribution, baseline, p90 and 1% spend gates`,
  };
};
