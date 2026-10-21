/**
 * D12 SUBAGENT_OVERSPAWN modeled-figure oracle, written only from the dh-contracts.md D12 card ("Carry and price rule").
 * Per workspace, over main-thread Agent calls in [now-7d, now) that have a subagent_meta row (tool_use_id = event_id)
 * and an owner turn (tool_event_metadata.owner_message_id) with is_sidechain = 0 (provisional / session state not checked):
 *  - return = the subagent's LAST sidechain turn in that session (ts DESC, message_id DESC), no window filter;
 *    qualifies when output_tokens x bpt > 10,240 (bpt = user_config bytes_per_token if finite > 0, else 2.7);
 *  - carry = later turns of the owner chain (same session, is_sidechain 0, agent_id NULL) with ts after the Agent call,
 *    stopping before a verified compact boundary, a context collapse (prev > 50,000 and this < half), or after 75;
 *  - W = owner turn's 5m write price (snapshot idx 3), R = its cache-read price (idx 2), each missing value falling back to
 *    the owner model's tier list price, else 0; carryPrice = W + R x (carry - 1), 0 when carry = 0;
 *  - value = output_tokens x 0.5 x carryPrice, summed unrounded per workspace; fires on >= 3 distinct sessions and
 *    sum >= 0.25 percent of the workspace's window spend; figure = round(sum).
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const MIN_RETURN_BYTES = 10240;
const MIN_SESSIONS = 3;
const MIN_PCT = 0.25;
const AVOIDANCE = 0.5;
const DEFAULT_BPT = 2.7;
const CARRY_CAP = 75;
const COLLAPSE_MIN_PREV = 50_000;
const COLLAPSE_SHARE = 0.5;

interface Call {
  event_id: string;
  ts: string;
  session_id: string;
  agent_id: string;
  owner_message_id: string;
}
interface Owner {
  session_id: string;
  workspace_id: string;
  model: string | null;
  prices: string | null;
}
interface Chain {
  message_id: string;
  ts: string;
  context_tokens: number;
}

function tierOf(model: string | null): string | null {
  const m = (model ?? "").toLowerCase();
  for (const t of ["opus", "sonnet", "haiku", "fable"]) if (m.includes(t)) return t;
  return null;
}

export const oracleD12: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();

  const bptRow = db.prepare("SELECT value FROM user_config WHERE key = 'bytes_per_token'").get() as
    | { value: string | null }
    | undefined;
  const bptN = bptRow?.value == null ? Number.NaN : Number(bptRow.value);
  const calibrated = Number.isFinite(bptN) && bptN > 0;
  const bpt = calibrated ? bptN : DEFAULT_BPT;

  const calls = db
    .prepare(
      `SELECT e.event_id, e.ts, e.session_id, sm.agent_id, m.owner_message_id
       FROM tool_events e
       JOIN subagent_meta sm ON sm.tool_use_id = e.event_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       WHERE e.tool_name = 'Agent' AND e.ts >= ? AND e.ts < ? AND m.owner_message_id IS NOT NULL
       ORDER BY e.ts, e.event_id`,
    )
    .all(fromIso, toIso) as Call[];

  const ownerStmt = db.prepare(
    `SELECT t.session_id, t.workspace_id, t.model, p.unit_prices_json AS prices
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.message_id = ? AND t.is_sidechain = 0`,
  );
  const lastStmt = db.prepare(
    `SELECT output_tokens FROM turns WHERE session_id = ? AND agent_id = ? AND is_sidechain = 1
     ORDER BY ts DESC, message_id DESC LIMIT 1`,
  );
  const chainStmt = db.prepare(
    `SELECT message_id, ts, context_tokens FROM turns
     WHERE session_id = ? AND is_sidechain = 0 AND agent_id IS NULL ORDER BY ts, message_id`,
  );
  const boundaryStmt = db.prepare(
    `SELECT MIN(event_ts) AS ts FROM ingest_metric_events
     WHERE session_id = ? AND boundary_kind = 'compact-boundary' AND boundary_verification = 'VERIFIED' AND event_ts > ?`,
  );
  const listStmt = db.prepare(
    "SELECT unit_prices_json FROM pricing_snapshots WHERE model_tier = ? ORDER BY captured_at DESC LIMIT 1",
  );

  const chains = new Map<string, Chain[]>();
  const byWs = new Map<
    string,
    { sessions: Set<string>; qualifying: number; bytes: number; value: number; owners: string[] }
  >();

  const priceAt = (o: Owner, idx: number): number => {
    const own = o.prices ? (JSON.parse(o.prices) as unknown[])[idx] : undefined;
    if (typeof own === "number" && Number.isFinite(own)) return own;
    const tier = tierOf(o.model);
    const row = tier ? (listStmt.get(tier) as { unit_prices_json: string } | undefined) : undefined;
    const list = row ? (JSON.parse(row.unit_prices_json) as unknown[])[idx] : undefined;
    return typeof list === "number" && Number.isFinite(list) ? list : 0;
  };

  for (const c of calls) {
    const owner = ownerStmt.get(c.owner_message_id) as Owner | undefined;
    if (!owner || owner.session_id !== c.session_id) continue;
    const last = lastStmt.get(c.session_id, c.agent_id) as { output_tokens: number } | undefined;
    if (!last || !(last.output_tokens * bpt > MIN_RETURN_BYTES)) continue;

    let chain = chains.get(c.session_id);
    if (!chain) {
      chain = chainStmt.all(c.session_id) as Chain[];
      chains.set(c.session_id, chain);
    }
    const bound = (boundaryStmt.get(c.session_id, c.ts) as { ts: string | null }).ts;
    let carry = 0;
    const start = chain.findIndex((t) => t.ts > c.ts);
    if (start >= 0) {
      for (let i = start; i < chain.length && carry < CARRY_CAP; i++) {
        const t = chain[i] as Chain;
        const prev = i > 0 ? (chain[i - 1] as Chain) : null;
        if (bound !== null && t.ts >= bound) break;
        if (
          prev &&
          prev.context_tokens > COLLAPSE_MIN_PREV &&
          t.context_tokens < COLLAPSE_SHARE * prev.context_tokens
        )
          break;
        carry++;
      }
    }
    const carryPrice = carry === 0 ? 0 : priceAt(owner, 3) + priceAt(owner, 2) * (carry - 1);
    const w = byWs.get(owner.workspace_id) ?? {
      sessions: new Set<string>(),
      qualifying: 0,
      bytes: 0,
      value: 0,
      owners: [],
    };
    byWs.set(owner.workspace_id, w);
    w.sessions.add(c.session_id);
    w.qualifying++;
    w.bytes += last.output_tokens * bpt;
    w.value += last.output_tokens * AVOIDANCE * carryPrice;
    w.owners.push(c.owner_message_id);
  }

  const findings: OracleFinding[] = [];
  const checked = new Set<string>();
  for (const [ws, w] of byWs) {
    if (w.sessions.size < MIN_SESSIONS) continue;
    const ids = (
      db
        .prepare("SELECT message_id FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?")
        .all(ws, fromIso, toIso) as Array<{ message_id: string }>
    ).map((r) => r.message_id);
    let spend = 0;
    for (const v of priceTurns(db, ids).values()) spend += v;
    if (spend > 0 && (w.value / spend) * 100 < MIN_PCT) continue;
    if (spend <= 0 && w.value <= 0) continue;
    for (const o of w.owners) checked.add(o);
    const figure = Math.round(w.value);
    findings.push({
      scope: { workspace_id: ws, key: `D12|${ws}` },
      quantities: [
        { name: "qualifying_returns", unit: "count", value: w.qualifying },
        { name: "sessions", unit: "sessions", value: w.sessions.size },
        { name: "return_bytes", unit: "bytes", value: w.bytes },
      ],
      measured_u: figure,
      assumptions: [
        {
          name: "D12_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "dh-contracts.md D12 card, D12_AVOIDANCE_FRACTION (ASSUMED)",
        },
        {
          name: "D12_BYTES_PER_TOKEN",
          value: bpt,
          source:
            "dh-contracts.md D12 card: calibrated ratio else 2.7; read here from user_config bytes_per_token (gate only)",
        },
        {
          name: "D12_NO_CROSS_FAMILY_CUT",
          value: 1,
          source: "dh-contracts.md D12 card: no ledger producer, no competing claims",
        },
      ],
      // Card: modeled savings shown only when bytes/token is calibrated, otherwise null (rank value stays in measured_u).
      modeled_u: calibrated ? figure : null,
      count: w.qualifying,
    });
  }
  return {
    findings,
    turns_checked: [...checked],
    note: `D12: ${calls.length} linked main-thread Agent calls in window, ${byWs.size} workspaces with a qualifying return, ${findings.length} pass the 3-session and 0.25 percent gates; spend = all priced window turns`,
  };
};
