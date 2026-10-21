/**
 * E2 MAIN_THREAD_MECHANICAL_RUNS silence probe. Written from the dh-contracts.md E2 card only.
 *
 * Derivation rules (base columns only: turns, tool_events, tool_event_metadata, sessions, pricing_snapshots):
 * - Per RECONCILED session, main-thread (is_sidechain 0) settled (provisional 0) turns in the window, by ts.
 * - Strong = model name contains opus, fable or mythos. A turn's calls = tool_events whose
 *   tool_event_metadata.owner_message_id is the turn. Mechanical call = Bash/PowerShell/Read/Grep/Glob.
 * - Mechanical turn = strong, >=1 call, all calls mechanical, output_tokens < 300 (extends the run).
 *   Strong text-only (no calls) turn: neutral. Any other main turn ends the run.
 * - Run = >=3 consecutive mechanical turns. Run cost = sum cost_equiv_u.
 * - Modelled Sonnet-subagent cost, the card's formula (F15): sonnet-5 prices; one 30000-token 5m write; per
 *   run turn, cache-read of the subagent context (30000 + earlier growth) + growth at 5m write + output at
 *   output price, growth = max(0, main context − previous main turn's context); plus the handoff turn priced
 *   as the run's first turn's cost_equiv_u.
 * - Saving = Σ run cost − Σ subagent cost per workspace (signed); gate = saving / workspace window spend >= 1%.
 */

import type { Probe, ProbeGate } from "./types.js";

const DAY = 86_400_000;
const MECH = new Set(["Bash", "PowerShell", "Read", "Grep", "Glob"]);

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

interface T {
  message_id: string;
  session_id: string;
  workspace_id: string;
  model: string;
  output_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  cost_equiv_u: number | null;
}

export const probeE2: Probe = (db, now) => {
  const from = new Date(now.getTime() - 7 * DAY).toISOString();
  const to = now.toISOString();

  const turns = db
    .prepare(
      `SELECT t.message_id, t.session_id, t.workspace_id, t.model, t.output_tokens, t.input_tokens,
              t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h, t.cache_write_other, t.cost_equiv_u
       FROM turns t JOIN sessions s ON s.session_id = t.session_id
       WHERE t.ts >= ? AND t.ts < ? AND t.is_sidechain = 0 AND t.provisional = 0 AND s.state = 'RECONCILED'
       ORDER BY t.session_id, t.ts, t.message_id`,
    )
    .all(from, to) as T[];

  const toolRows = db
    .prepare(
      `SELECT m.owner_message_id AS mid, e.tool_name AS name FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id WHERE m.owner_message_id IS NOT NULL`,
    )
    .all() as { mid: string; name: string }[];
  const calls = new Map<string, string[]>();
  for (const r of toolRows) {
    const l = calls.get(r.mid);
    if (l) l.push(r.name);
    else calls.set(r.mid, [r.name]);
  }

  const spendRows = db
    .prepare(
      "SELECT workspace_id, COALESCE(SUM(cost_equiv_u),0) AS s FROM turns WHERE ts >= ? AND ts < ? GROUP BY workspace_id",
    )
    .all(from, to) as { workspace_id: string; s: number }[];
  const spend = new Map(spendRows.map((r) => [r.workspace_id, r.s]));

  const priceRow = db
    .prepare(
      "SELECT unit_prices_json AS j FROM pricing_snapshots WHERE model_tier = 'sonnet-5' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { j: string } | undefined;
  const sp = priceRow ? (JSON.parse(priceRow.j) as number[]) : null;

  const ctxOf = (t: T): number =>
    t.input_tokens +
    t.cache_read_tokens +
    t.cache_write_5m +
    t.cache_write_1h +
    t.cache_write_other;
  const runs: { ws: string; turns: { t: T; growth: number }[] }[] = [];
  let cur: { t: T; growth: number }[] = [];
  let curKey = "";
  let prev: T | null = null;
  const flush = (): void => {
    if (cur.length >= 3) runs.push({ ws: cur[0]?.t.workspace_id ?? "", turns: cur });
    cur = [];
  };
  for (const t of turns) {
    if (t.session_id !== curKey) {
      flush();
      curKey = t.session_id;
      prev = null;
    }
    const m = t.model.toLowerCase();
    const strong = m.includes("opus") || m.includes("fable") || m.includes("mythos");
    const cs = calls.get(t.message_id) ?? [];
    if (strong && cs.length > 0 && cs.every((c) => MECH.has(c)) && t.output_tokens < 300) {
      cur.push({ t, growth: prev === null ? 0 : Math.max(0, ctxOf(t) - ctxOf(prev)) });
    } else if (!(strong && cs.length === 0)) flush();
    prev = t;
  }
  flush();

  const perWs = new Map<
    string,
    { runs: number; runCost: number; saving: number | null; maxRunLen: number }
  >();
  for (const r of runs) {
    const runCost = r.turns.reduce((s, { t }) => s + (t.cost_equiv_u ?? 0), 0);
    let sub: number | null = null;
    if (sp) {
      let context = 30_000;
      sub = 30_000 * (sp[3] ?? 0);
      for (const { t, growth } of r.turns) {
        sub += context * (sp[2] ?? 0) + growth * (sp[3] ?? 0) + t.output_tokens * (sp[1] ?? 0);
        context += growth;
      }
      sub += r.turns[0]?.t.cost_equiv_u ?? 0;
    }
    const cell = perWs.get(r.ws) ?? {
      runs: 0,
      runCost: 0,
      saving: 0 as number | null,
      maxRunLen: 0,
    };
    cell.runs++;
    cell.runCost += runCost;
    cell.maxRunLen = Math.max(cell.maxRunLen, r.turns.length);
    cell.saving = sub === null || cell.saving === null ? null : cell.saving + runCost - sub;
    perWs.set(r.ws, cell);
  }

  let qualifying = 0;
  let best: { score: number; tiebreak: number; gates: ProbeGate[] } | null = null;
  for (const [ws, c] of perWs) {
    const s = spend.get(ws) ?? 0;
    const pct = c.saving !== null && s > 0 ? (c.saving / s) * 100 : null;
    const gates = [
      gate("E2_MIN_RUN_TURNS (longest run)", c.maxRunLen, 3, ">="),
      gate("E2_MIN_PCT_OF_SPEND (net saving %)", pct, 1, ">="),
    ];
    const ok = gates.every((g) => g.pass);
    if (ok) qualifying++;
    const score = gates.filter((g) => g.pass).length + (ok ? 10 : 0);
    if (!best || score > best.score || (score === best.score && (c.saving ?? 0) > best.tiebreak))
      best = { score, tiebreak: c.saving ?? 0, gates };
  }

  return {
    candidates: perWs.size,
    qualifying,
    gates: best?.gates ?? [],
    note: "E2: candidate = workspace with >=1 run of >=3 consecutive strong-model (opus/fable/mythos) main-thread settled turns in RECONCILED sessions, each with >=1 call, all Bash/PowerShell/Read/Grep/Glob (owner turn via tool_event_metadata), output<300; strong text-only turns neutral. Subagent cost = the card's ASSUMED model on sonnet-5 prices (F15: 30k base write + context reads + growth writes + output; handoff = the run's first turn's cost); saving summed signed per workspace.",
  };
};
