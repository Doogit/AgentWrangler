/**
 * A1 TOOL_RESULT_BLOAT_V2 headline oracle, written only from the amended dh-contracts.md A1 card.
 * Fires per workspace on any tool result in [now-7d, now) with a whole-number result_bytes > 25600 linked to a session
 * in a workspace. Graded on the card's NET ledger headline (card "Card quantity" steps 1-10):
 *  - results oldest first (ts, event_id); owner turn must exist; raw = round((bytes-25600)/2.7), 0 skipped;
 *  - chain = owner's (session, sidechain flag, agent id) turns with ts strictly after the result's ts; stops before a
 *    verified compact boundary after the result, a context collapse (prev > 50000 and this < 0.5 x prev), or after 75;
 *  - first later turn: write claim split by that turn's own 5m/1h mix; later turns: cache-read claims;
 *  - capped at the turn's billed tokens per component (own earlier results first); x 0.5 (ASSUMED), capped again;
 *  - priced at the claimed turn's own snapshot; only settled (provisional = 0) in-window turns can be claimed.
 * Higher-priority D1/D10 cache-read prefix claims are not modelled (no card rule gives their base-table quantity).
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const THRESHOLD = 25600;
const BYTES_PER_TOKEN = 2.7;
const CARRY_CAP = 75;
const COLLAPSE_MIN_PREV = 50_000;
const COLLAPSE_SHARE = 0.5;
const AVOIDANCE = 0.5;

interface Ev {
  event_id: string;
  ts: string;
  session_id: string;
  workspace_id: string;
  result_bytes: number;
  owner_message_id: string | null;
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

export const oracleA1: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();

  const evs = db
    .prepare(
      `SELECT e.event_id, e.ts, e.session_id, s.workspace_id, e.result_bytes, m.owner_message_id
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
       WHERE e.ts >= ? AND e.ts < ? AND e.result_bytes > ? AND CAST(e.result_bytes AS INTEGER) = e.result_bytes
       ORDER BY e.ts, e.event_id`,
    )
    .all(fromIso, toIso, THRESHOLD) as Ev[];

  const ownerStmt = db.prepare(
    "SELECT session_id, is_sidechain, agent_id FROM turns WHERE message_id = ?",
  );
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
  const used = new Map<string, number>(); // raw tokens claimed per (turn, component)
  const usedFinal = new Map<string, number>();

  const byWs = new Map<
    string,
    { events: number; bytes: number; tokens: number; value: number; owners: Set<string> }
  >();

  for (const ev of evs) {
    const w = byWs.get(ev.workspace_id) ?? {
      events: 0,
      bytes: 0,
      tokens: 0,
      value: 0,
      owners: new Set<string>(),
    };
    byWs.set(ev.workspace_id, w);
    w.events++;
    w.bytes += ev.result_bytes;
    if (!ev.owner_message_id) continue;
    const owner = ownerStmt.get(ev.owner_message_id) as
      | { session_id: string; is_sidechain: number; agent_id: string | null }
      | undefined;
    if (!owner) continue;
    const raw = Math.round((ev.result_bytes - THRESHOLD) / BYTES_PER_TOKEN);
    if (raw <= 0) continue;

    const agent = owner.is_sidechain ? owner.agent_id : null;
    const ck = `${ev.session_id}|${owner.is_sidechain}|${agent ?? ""}`;
    let chain = chains.get(ck);
    if (!chain) {
      chain = chainStmt.all(ev.session_id, owner.is_sidechain, agent, agent) as Turn[];
      chains.set(ck, chain);
    }
    const bound = (boundaryStmt.get(ev.session_id, ev.ts) as { ts: string | null }).ts;
    // Later turns: strictly after the result's timestamp, walking the chain in order.
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

    const claim = (t: Turn, comp: Comp, tokens: number): void => {
      if (tokens <= 0) return;
      if (t.provisional !== 0 || t.ts < fromIso || t.ts >= toIso) return;
      const billed =
        comp === "read" ? t.cache_read_tokens : comp === "w5" ? t.cache_write_5m : t.cache_write_1h;
      const key = `${t.message_id}|${comp}`;
      const rawClaim = Math.min(tokens, Math.max(0, billed - (used.get(key) ?? 0)));
      used.set(key, (used.get(key) ?? 0) + rawClaim);
      const frac = Math.min(
        Math.round(rawClaim * AVOIDANCE),
        Math.max(0, billed - (usedFinal.get(key) ?? 0)),
      );
      if (frac <= 0) return;
      usedFinal.set(key, (usedFinal.get(key) ?? 0) + frac);
      if (!t.unit_prices_json) return; // no usable snapshot: tokens kept, worth 0
      const [, , pread = 0, pw5 = 0, pw1 = 0] = JSON.parse(t.unit_prices_json) as number[];
      w.tokens += frac;
      w.value += frac * (comp === "read" ? pread : comp === "w5" ? pw5 : pw1);
      w.owners.add(t.message_id);
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

  const findings: OracleFinding[] = [];
  const turnsChecked = new Set<string>();
  for (const [ws, w] of byWs) {
    for (const o of w.owners) turnsChecked.add(o);
    const headline = Math.round(w.value);
    findings.push({
      scope: { workspace_id: ws, key: `A1|${ws}` },
      quantities: [
        { name: "oversized_results", unit: "events", value: w.events },
        { name: "total_bytes", unit: "bytes", value: w.bytes },
        { name: "claimed_tokens", unit: "tokens", value: w.tokens },
      ],
      measured_u: headline,
      assumptions: [
        {
          name: "A1_AVOIDANCE_FRACTION",
          value: AVOIDANCE,
          source: "dh-contracts.md A1 card (ASSUMED)",
        },
        {
          name: "ESTIMATOR_BYTES_PER_TOKEN",
          value: BYTES_PER_TOKEN,
          source: "dh-contracts.md A1 card (fixed)",
        },
      ],
      modeled_u: headline,
      count: w.events,
    });
  }
  return {
    findings,
    turns_checked: [...turnsChecked],
    note: `A1: ${evs.length} results over ${THRESHOLD} bytes in window across ${byWs.size} workspaces; D1/D10 higher-priority cache-read claims not modelled`,
  };
};
