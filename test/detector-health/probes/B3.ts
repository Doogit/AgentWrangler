/**
 * DH2 probe for B3 (RESUME_CACHE_MISS_V2), written from its contract card only.
 * Read list: docs/plans/dh-contracts.md (header + B3 card); docs/plans/spec-detector-health.md (s2, s3 DH2 row);
 * base-table DDL dump (scratchpad ddl.sql); test/fixtures/detector-health/B3/{manifest.json,README.md,positive/*.jsonl};
 * test/detector-health/{probes/types.ts,probes/index.ts,probes.test.ts,harness.ts,manifest.ts}.
 *
 * Reads base ingest columns only (turns, sessions, pricing_snapshots). No classifier columns.
 *
 * Card reading (ambiguities, each an open question for the reviewer):
 *  - "reconciled main-thread turn" = turns of sessions.state='RECONCILED' with is_sidechain=0 and provisional=0.
 *  - Adjacency: the new session's first such turn (ts in window) is immediately preceded, in (ts, message_id) order
 *    within the workspace, by the LAST such turn of a different session.
 *  - Base prefix = median (mean of the two middle values when even) first-turn context of the workspace's sessions
 *    whose first such turn is in the window.
 *  - Previous TTL: previous turn wrote 1h -> 60 min, else wrote 5m -> 5 min; none -> the new turn's tier; none -> 60.
 *    A turn writing both tiers counts as 1h.
 *  - Event cost for the 0.1% floor = avoidable tokens x (the new turn's write price - its read price), in micro-dollars,
 *    against the workspace's summed turns.cost_equiv_u in the window. Unknown spend or unpriced turn passes.
 *    (The card says "its cost"; the 0.5 avoidance fraction is NOT applied here. Alternative reading would halve it.)
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Turn {
  message_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  context_tokens: number;
  pricing_snapshot_id: string | null;
}

const COLS =
  "t.message_id, t.session_id, t.workspace_id, t.ts, t.input_tokens, t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h, t.cache_write_other, t.context_tokens, t.pricing_snapshot_id";
const MAIN = "t.is_sidechain = 0 AND t.provisional = 0 AND s.state = 'RECONCILED'";

const creation = (t: Turn): number => t.cache_write_5m + t.cache_write_1h + t.cache_write_other;
const tierMin = (t: Turn): number | null =>
  t.cache_write_1h > 0 ? 60 : t.cache_write_5m > 0 ? 5 : null;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function mk(name: string, value: number | null, threshold: number, op: ProbeGate["op"]): ProbeGate {
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

export const probeB3: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const prices = new Map<string, number[]>();
  for (const r of db
    .prepare("SELECT snapshot_id, unit_prices_json FROM pricing_snapshots")
    .all() as {
    snapshot_id: string;
    unit_prices_json: string;
  }[]) {
    prices.set(r.snapshot_id, JSON.parse(r.unit_prices_json) as number[]);
  }

  // First main reconciled turn of each session, with ts in the window.
  const firsts = db
    .prepare(
      `SELECT ${COLS} FROM turns t JOIN sessions s ON s.session_id = t.session_id
       WHERE ${MAIN} AND t.ts >= ? AND t.ts < ?
         AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.session_id = t.session_id AND u.is_sidechain = 0 AND u.provisional = 0
                         AND (u.ts < t.ts OR (u.ts = t.ts AND u.message_id < t.message_id)))`,
    )
    .all(from, to) as Turn[];

  const prevStmt = db.prepare(
    `SELECT ${COLS} FROM turns t JOIN sessions s ON s.session_id = t.session_id
     WHERE ${MAIN} AND t.workspace_id = ? AND (t.ts < ? OR (t.ts = ? AND t.message_id < ?))
     ORDER BY t.ts DESC, t.message_id DESC LIMIT 1`,
  );
  const laterInSession = db.prepare(
    `SELECT 1 FROM turns u WHERE u.session_id = ? AND u.is_sidechain = 0 AND u.provisional = 0
       AND (u.ts > ? OR (u.ts = ? AND u.message_id > ?)) LIMIT 1`,
  );
  const spendStmt = db.prepare(
    "SELECT SUM(cost_equiv_u) AS u, COUNT(cost_equiv_u) AS n FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?",
  );

  const baseByWs = new Map<string, number>();
  const wsFirsts = new Map<string, number[]>();
  for (const f of firsts) {
    const a = wsFirsts.get(f.workspace_id) ?? [];
    a.push(f.context_tokens);
    wsFirsts.set(f.workspace_id, a);
  }
  for (const [ws, a] of wsFirsts) baseByWs.set(ws, median(a));

  let candidates = 0;
  let qualifying = 0;
  let adjacentEvents = 0;
  let best: { score: number; gates: ProbeGate[] } | null = null;

  for (const n of firsts) {
    const p = prevStmt.get(n.workspace_id, n.ts, n.ts, n.message_id) as Turn | undefined;
    if (!p || p.session_id === n.session_id) continue;
    if (laterInSession.get(p.session_id, p.ts, p.ts, p.message_id)) continue; // p is not its session's last turn
    adjacentEvents++;

    const ctxPrev = p.context_tokens;
    const cr = creation(n);
    const ratio = ctxPrev > 0 ? cr / ctxPrev : null;
    const readShare = p.cache_read_tokens > 0 ? n.cache_read_tokens / p.cache_read_tokens : null;
    const readsOk = n.cache_read_tokens <= 0.5 * p.cache_read_tokens;
    const gapMs = Date.parse(n.ts) - Date.parse(p.ts);
    const ttlMin = tierMin(p) ?? tierMin(n) ?? 60;
    const base = baseByWs.get(n.workspace_id) ?? 0;
    const avoidable = cr - base;

    const sp = spendStmt.get(n.workspace_id, from, to) as { u: number | null; n: number };
    const px = n.pricing_snapshot_id ? prices.get(n.pricing_snapshot_id) : undefined;
    let eventPct: number | null = null;
    if (px && sp.n > 0 && (sp.u ?? 0) > 0) {
      const writePrice = (n.cache_write_1h > n.cache_write_5m ? px[4] : px[3]) as number;
      const cost = avoidable * (writePrice - (px[2] as number));
      eventPct = (cost / (sp.u as number)) * 100;
    }

    const gates: ProbeGate[] = [
      mk("B3_CACHE_CREATION_THRESHOLD", cr, 20000, ">"),
      mk("RESUME_CONTEXT_MATCH_LOW", ctxPrev > 0 ? ratio : null, 0.8, ">="),
      mk("RESUME_CONTEXT_MATCH_HIGH", ctxPrev > 0 ? ratio : null, 1.25, "<="),
      mk("COLLAPSE_READ_FALL_SHARE", readShare ?? (readsOk ? 0 : null), 0.5, "<="),
      mk("PREVIOUS_SESSION_TTL_MIN", gapMs / 60000, ttlMin, "<="),
      mk("GAP_NON_NEGATIVE_MS", gapMs, 0, ">="),
      mk("AVOIDABLE_TOKENS", avoidable, 0, ">"),
      // Unknown spend / unpriced passes (card).
      eventPct === null
        ? { name: "EVENT_FLOOR_PCT", value: null, threshold: 0.1, op: ">=", pass: true }
        : mk("EVENT_FLOOR_PCT", eventPct, 0.1, ">="),
    ];
    const shape = ctxPrev > 0 && ratio !== null && ratio >= 0.8 && ratio <= 1.25 && readsOk;
    if (shape) candidates++;
    const all = gates.every((g) => g.pass) && shape;
    if (all) qualifying++;
    const score = gates.filter((g) => g.pass).length + (all ? 100 : 0);
    if (!best || score > best.score) best = { score, gates };
  }

  return {
    candidates,
    qualifying,
    gates: best?.gates ?? [],
    note: `${firsts.length} session starts in window; ${adjacentEvents} directly follow another session's last main turn; ${candidates} re-create ~whole context with reads halved; ${qualifying} pass all gates`,
  };
};
