/**
 * D6 TOOL_RESULT_BLOAT headline oracle, written only from the dh-contracts.md D6 card ("Headline (net)").
 * Result set: tool_events in [now-7d, now) with 0 < result_bytes <= 25600, an owner turn, not TaskOutput > 10240.
 * raw = round((bytes - 10240) / bytesPerToken) (user_config bytes_per_token when valid, else 3.35); skip raw <= 0.
 * Chain = owner's (session, sidechain flag, agent id) turns after the result's ts; stops before a verified compact
 * boundary, a context collapse (prev > 50000 and this < 0.5 x prev) or after 75 turns. Write turn: raw split by the
 * turn's own 5m/1h mix; other turns: cache-read. Per cell the raw claims sum, cap at the turn's billed tokens, then
 * tokens = min(round(sum x 0.5), billed), priced at THAT turn's own snapshot. Headline = round(sum of values).
 * Gate (card Trigger): >= 3 carrying sessions machine-wide and ws gross carry cost (owner snapshot) >= 1% of ws spend;
 * the ws also needs a D6 `recommendations` row (when that table exists), since the card only exists then.
 * Higher-priority claims (D1, D10, A1, A2, D7, D12) are not modelled: see the assumptions list.
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const A1_BYTES = 25600;
const A2_BYTES = 10240;
const EXCESS_FLOOR = 10240;
const MIN_SESSIONS = 3;
const MIN_PCT = 1;
const CARRY_CAP = 75;
const COLLAPSE_MIN_PREV = 50_000;
const COLLAPSE_SHARE = 0.5;
const AVOIDANCE = 0.5;
const BYTES_PER_TOKEN_FALLBACK = (2.7 + 4) / 2;

interface Ev {
  event_id: string;
  ts: string;
  session_id: string;
  workspace_id: string;
  tool_name: string;
  result_bytes: number;
  owner_message_id: string;
  owner_ts: string;
  owner_side: number;
  owner_agent: string | null;
  owner_prices: string | null;
}

interface Turn {
  message_id: string;
  ts: string;
  context_tokens: number;
  provisional: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  unit_prices_json: string | null;
}

type Comp = "read" | "w5" | "w1";

interface Cell {
  ws: string;
  turn: Turn;
  comp: Comp;
  raw: number;
}

export const oracleD6: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const hasTable = (n: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n) !== undefined;

  let bytesPerToken = BYTES_PER_TOKEN_FALLBACK;
  if (hasTable("user_config")) {
    const row = db.prepare("SELECT value FROM user_config WHERE key = 'bytes_per_token'").get() as
      | { value: string | null }
      | undefined;
    const v = row?.value == null ? Number.NaN : Number(row.value);
    if (Number.isFinite(v) && v > 0) bytesPerToken = v;
  }

  const evs = db
    .prepare(
      `SELECT e.event_id, e.ts, e.session_id, s.workspace_id, e.tool_name, e.result_bytes, m.owner_message_id,
              t.ts AS owner_ts, t.is_sidechain AS owner_side, t.agent_id AS owner_agent, p.unit_prices_json AS owner_prices
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE e.ts >= ? AND e.ts < ? AND e.result_bytes > 0 AND e.result_bytes <= ?
         AND NOT (e.tool_name = 'TaskOutput' AND e.result_bytes > ?)
       ORDER BY e.ts, e.event_id`,
    )
    .all(fromIso, toIso, A1_BYTES, A2_BYTES) as Ev[];

  const chainStmt = db.prepare(
    `SELECT t.message_id, t.ts, t.context_tokens, t.provisional, t.cache_read_tokens, t.cache_write_5m,
            t.cache_write_1h, p.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.session_id = ? AND t.is_sidechain = ? AND ((? IS NULL AND t.agent_id IS NULL) OR t.agent_id = ?)
     ORDER BY t.ts, t.message_id`,
  );
  const boundaryStmt = db.prepare(
    `SELECT MIN(event_ts) AS ts FROM ingest_metric_events
     WHERE session_id = ? AND boundary_kind = 'compact-boundary' AND boundary_verification = 'VERIFIED'
       AND event_ts > ?`,
  );

  const chains = new Map<string, Turn[]>();
  const cells = new Map<string, Cell>();
  const byWs = new Map<
    string,
    { cost: number; events: number; bytes: number; sessions: Set<string>; owners: Set<string> }
  >();
  const carrying = new Set<string>();

  for (const ev of evs) {
    const raw = Math.round((ev.result_bytes - EXCESS_FLOOR) / bytesPerToken);
    if (raw <= 0) continue;
    const agent = ev.owner_side ? ev.owner_agent : null;
    const ck = `${ev.session_id}|${ev.owner_side}|${agent ?? ""}`;
    let chain = chains.get(ck);
    if (!chain) {
      chain = chainStmt.all(ev.session_id, ev.owner_side, agent, agent) as Turn[];
      chains.set(ck, chain);
    }
    const bound = (boundaryStmt.get(ev.session_id, ev.ts) as { ts: string | null }).ts;
    const startIdx = chain.findIndex((t) => t.ts > ev.ts);
    if (startIdx < 0) continue;
    const later: Turn[] = [];
    for (let i = startIdx; i < chain.length && later.length < CARRY_CAP; i++) {
      const t = chain[i] as Turn;
      const prev = i > 0 ? (chain[i - 1] as Turn) : null;
      if (bound !== null && t.ts >= bound) break;
      if (
        prev &&
        prev.context_tokens > COLLAPSE_MIN_PREV &&
        t.context_tokens < COLLAPSE_SHARE * prev.context_tokens
      )
        break;
      later.push(t);
    }
    if (later.length === 0) continue;

    // Gate input: gross carry cost with the owner turn's snapshot (write once, re-read on the other later turns).
    if (ev.owner_prices) {
      const [, , pread = 0, pw5 = 0] = JSON.parse(ev.owner_prices) as number[];
      const cost =
        ((ev.result_bytes - EXCESS_FLOOR) / bytesPerToken) * (pw5 + (later.length - 1) * pread);
      carrying.add(ev.session_id);
      const w = byWs.get(ev.workspace_id) ?? {
        cost: 0,
        events: 0,
        bytes: 0,
        sessions: new Set<string>(),
        owners: new Set<string>(),
      };
      byWs.set(ev.workspace_id, w);
      w.cost += cost;
      w.events++;
      w.bytes += ev.result_bytes;
      w.sessions.add(ev.session_id);
    }

    // Net-headline claims. Only settled in-window turns are billed cells; D6 raw claims cap at the billed tokens.
    const claim = (t: Turn, comp: Comp, tokens: number): void => {
      if (tokens <= 0) return;
      if (t.provisional !== 0 || t.ts < fromIso || t.ts >= toIso) return;
      const billed =
        comp === "read" ? t.cache_read_tokens : comp === "w5" ? t.cache_write_5m : t.cache_write_1h;
      const key = `${t.message_id}|${comp}`;
      const cell = cells.get(key) ?? { ws: ev.workspace_id, turn: t, comp, raw: 0 };
      const take = Math.min(tokens, Math.max(0, billed - cell.raw));
      if (take <= 0) return;
      cell.raw += take;
      cells.set(key, cell);
    };
    const first = later[0] as Turn;
    const cw = first.cache_write_5m + first.cache_write_1h;
    if (cw > 0) {
      const r5 = Math.round((raw * first.cache_write_5m) / cw);
      claim(first, "w5", r5);
      claim(first, "w1", raw - r5);
    }
    for (const t of later.slice(1)) claim(t, "read", raw);
  }

  // Ledger per cell, then sum per workspace (a turn without a snapshot is worth $0).
  const valueBy = new Map<string, number>();
  const tokensBy = new Map<string, number>();
  const turnsBy = new Map<string, Set<string>>();
  for (const c of cells.values()) {
    const billed =
      c.comp === "read"
        ? c.turn.cache_read_tokens
        : c.comp === "w5"
          ? c.turn.cache_write_5m
          : c.turn.cache_write_1h;
    const tokens = Math.min(Math.round(c.raw * AVOIDANCE), billed);
    if (tokens <= 0 || !c.turn.unit_prices_json) continue;
    const [, , pread = 0, pw5 = 0, pw1 = 0] = JSON.parse(c.turn.unit_prices_json) as number[];
    valueBy.set(
      c.ws,
      (valueBy.get(c.ws) ?? 0) + tokens * (c.comp === "read" ? pread : c.comp === "w5" ? pw5 : pw1),
    );
    tokensBy.set(c.ws, (tokensBy.get(c.ws) ?? 0) + tokens);
    const s = turnsBy.get(c.ws) ?? new Set<string>();
    s.add(c.turn.message_id);
    turnsBy.set(c.ws, s);
  }

  const recWs = hasTable("recommendations")
    ? new Set(
        (
          db
            .prepare(
              "SELECT DISTINCT scope_workspace_id AS ws FROM recommendations WHERE detector_id = 'D6'",
            )
            .all() as { ws: string | null }[]
        ).map((r) => r.ws),
      )
    : null;

  const findings: OracleFinding[] = [];
  const turnsChecked = new Set<string>();
  if (carrying.size >= MIN_SESSIONS) {
    for (const [ws, w] of byWs) {
      if (recWs && !recWs.has(ws)) continue;
      const ids = (
        db
          .prepare(
            "SELECT message_id FROM turns WHERE workspace_id = ? AND provisional = 0 AND ts >= ? AND ts < ?",
          )
          .all(ws, fromIso, toIso) as { message_id: string }[]
      ).map((x) => x.message_id);
      let spend = 0;
      for (const v of priceTurns(db, ids).values()) spend += v;
      if (spend <= 0 || (w.cost / spend) * 100 < MIN_PCT) continue;
      for (const m of turnsBy.get(ws) ?? []) turnsChecked.add(m);
      const headline = Math.round(valueBy.get(ws) ?? 0);
      findings.push({
        scope: { workspace_id: ws, key: `D6|${ws}` },
        quantities: [
          { name: "carrying_results", unit: "events", value: w.events },
          { name: "carrying_sessions", unit: "sessions", value: w.sessions.size },
          { name: "result_bytes", unit: "bytes", value: w.bytes },
          { name: "claimed_tokens", unit: "tokens", value: tokensBy.get(ws) ?? 0 },
        ],
        measured_u: headline,
        assumptions: [
          {
            name: "D6_AVOIDANCE_FRACTION",
            value: AVOIDANCE,
            source: "dh-contracts.md D6 card, ASSUMED (range 0.33 to 0.7)",
          },
          {
            name: "bytes_per_token",
            value: bytesPerToken,
            source:
              "dh-contracts.md D6 card; user_config bytes_per_token when calibrated, else 3.35 (mean of 2.7 and 4)",
          },
          {
            name: "no_competing_claims",
            value: 0,
            source:
              "dh-contracts.md D6 headline assumptions: D1/D10/A1/A2/D7/D12 rank above D6 and are not modelled; measured 0.00% cut on live 2026-10-14, write cells likeliest to be shared",
          },
        ],
        modeled_u: headline,
        count: w.events,
      });
    }
  }
  return {
    findings,
    turns_checked: [...turnsChecked],
    note: `D6: ${evs.length} candidate results, ${carrying.size} carrying sessions machine-wide (need ${MIN_SESSIONS}), ${findings.length} workspaces fire`,
  };
};
