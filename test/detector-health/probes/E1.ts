/**
 * E1 ORIENTATION_BEFORE_FIRST_EDIT silence probe. Written from the dh-contracts.md E1 card only.
 *
 * Derivation rules (base columns only: tool_events, tool_event_metadata, turns, sessions):
 * - Edit turn = a non-sidechain, non-provisional turn that owns (tool_event_metadata.owner_message_id) a
 *   tool_events row named Edit/Write/MultiEdit/NotebookEdit. A session's first edit = its earliest such turn.
 * - Editing session = RECONCILED session whose first edit ts is in [now-7d, now).
 * - Pre-edit turns = non-sidechain, non-provisional turns of the session with ts strictly before the first edit
 *   turn's ts (counted from session start, even before the window).
 * - Nearest-rank percentiles over the workspace's editing sessions: p50 = c[ceil(.5n)-1], p75 = c[ceil(.75n)-1].
 *   Long = pre-edit count > p75. Excess turns of a long session = its pre-edit turns after the first p50.
 * - Excess cost = sum of cost_equiv_u over excess turns; workspace spend = sum of cost_equiv_u of all
 *   workspace turns in the window.
 */

import type { Probe, ProbeGate } from "./types.js";

const DAY = 86_400_000;
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

function gate(
  name: string,
  value: number | null,
  threshold: number,
  op: ProbeGate["op"],
): ProbeGate {
  let pass = false;
  if (value !== null) {
    pass =
      op === ">"
        ? value > threshold
        : op === ">="
          ? value >= threshold
          : op === "<"
            ? value < threshold
            : value <= threshold;
  }
  return { name, value, threshold, op, pass };
}

export const probeE1: Probe = (db, now) => {
  const from = new Date(now.getTime() - 7 * DAY).toISOString();
  const to = now.toISOString();

  const firsts = db
    .prepare(
      `SELECT s.session_id AS sid, s.workspace_id AS ws, MIN(t.ts) AS first_edit
       FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       JOIN sessions s ON s.session_id = e.session_id
       WHERE e.tool_name IN (${EDIT_TOOLS.map(() => "?").join(",")})
         AND t.is_sidechain = 0 AND t.provisional = 0 AND s.state = 'RECONCILED'
       GROUP BY s.session_id, s.workspace_id
       HAVING MIN(t.ts) >= ? AND MIN(t.ts) < ?`,
    )
    .all(...EDIT_TOOLS, from, to) as { sid: string; ws: string; first_edit: string }[];

  const preStmt = db.prepare(
    `SELECT cost_equiv_u AS c FROM turns
     WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts < ? ORDER BY ts, message_id`,
  );
  const spendRows = db
    .prepare(
      "SELECT workspace_id, COALESCE(SUM(cost_equiv_u),0) AS s FROM turns WHERE ts >= ? AND ts < ? GROUP BY workspace_id",
    )
    .all(from, to) as { workspace_id: string; s: number }[];
  const spend = new Map(spendRows.map((r) => [r.workspace_id, r.s]));

  const byWs = new Map<string, { costs: (number | null)[] }[]>();
  for (const f of firsts) {
    const costs = (preStmt.all(f.sid, f.first_edit) as { c: number | null }[]).map((r) => r.c);
    const list = byWs.get(f.ws) ?? [];
    byWs.set(f.ws, list);
    list.push({ costs });
  }

  let candidates = 0;
  let qualifying = 0;
  let best: { score: number; tiebreak: number; gates: ProbeGate[] } | null = null;
  for (const [ws, sessions] of byWs) {
    const counts = sessions.map((s) => s.costs.length).sort((a, b) => a - b);
    const n = counts.length;
    const p50 = counts[Math.ceil(0.5 * n) - 1] ?? 0;
    const p75 = counts[Math.ceil(0.75 * n) - 1] ?? 0;
    const long = sessions.filter((s) => s.costs.length > p75);
    if (long.length > 0) candidates++;
    let excessTurns = 0;
    let excessCost = 0;
    for (const s of long) {
      const rest = s.costs.slice(p50);
      excessTurns += rest.length;
      for (const c of rest) excessCost += c ?? 0;
    }
    const sp = spend.get(ws) ?? 0;
    const pct = sp > 0 ? (excessCost / sp) * 100 : null;
    const gates = [
      gate("E1_MIN_EDITING_SESSIONS", n, 8, ">="),
      gate("long sessions (> p75)", long.length, 0, ">"),
      gate("E1_MIN_PCT_OF_SPEND (excess cost %)", pct, 1, ">="),
    ];
    const ok = gates.every((g) => g.pass);
    if (ok) qualifying++;
    const score = gates.filter((g) => g.pass).length + (ok ? 10 : 0);
    if (!best || score > best.score || (score === best.score && excessTurns > best.tiebreak))
      best = { score, tiebreak: excessTurns, gates };
  }

  return {
    candidates,
    qualifying,
    gates: best?.gates ?? [],
    note: "E1: editing sessions = RECONCILED sessions whose first main-thread settled edit turn (owner turn of an Edit/Write/MultiEdit/NotebookEdit tool_events row) is in the window; candidate = workspace with >=1 session whose pre-edit turn count exceeds the workspace nearest-rank p75; excess = pre-edit turns after the first p50.",
  };
};
