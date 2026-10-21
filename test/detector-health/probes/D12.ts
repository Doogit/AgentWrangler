/**
 * DH2 probe for D12 (SUBAGENT_OVERSPAWN), written from its contract card only.
 * Read list: docs/plans/dh-contracts.md (header + D12 card); docs/plans/spec-detector-health.md (s2, s3 DH2 row);
 * base-table DDL dump (scratchpad ddl.sql); test/fixtures/detector-health/D12/{manifest.json,README.md,
 * positive/**, near-miss-sessions/**}; test/detector-health/{probes/types.ts,probes/index.ts,probes.test.ts,harness.ts,manifest.ts}.
 *
 * Reads tool_events (name, ts only), tool_event_metadata (owner message), subagent_meta, turns, sessions,
 * pricing_snapshots. No classifier columns.
 *
 * Card reading (open questions):
 *  - Bytes-per-token: the card says "calibrated ratio when available, else the estimator default" without giving the
 *    default; this probe assumes 4 bytes/token and ignores calibration (cannot read the calibration module).
 *  - Subagent last turn = the turn with the latest ts among turns.agent_id = subagent_meta.agent_id.
 *  - Carry price (u per token) = write price + (carry - 1) x read price, where carry = main-thread turns of the
 *    owning session after the owning turn (>= 1 required; otherwise "cannot be priced"); the write price is the 1h
 *    price when the owning turn wrote more 1h than 5m tokens, else the 5m price; prices from the owning turn's snapshot.
 *    Saving = return tokens x 0.5 x carry price. Rounded per call to whole micro-dollars.
 *  - Workspace spend = summed non-null turns.cost_equiv_u of the workspace in the window (sidechain included).
 *    Zero/unknown spend passes the percentage gate (not stated by the card for D12; same rule as sibling cards).
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_TOKEN = 4;
const MIN_BYTES = 10 * 1024;

export const probeD12: Probe = (db: Database.Database, now: Date) => {
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

  const calls = db
    .prepare(
      `SELECT e.event_id, e.session_id, s.workspace_id, md.owner_message_id,
              o.ts AS owner_ts, o.pricing_snapshot_id, o.cache_write_5m, o.cache_write_1h,
              (SELECT l.output_tokens FROM turns l WHERE l.agent_id = m.agent_id ORDER BY l.ts DESC, l.message_id DESC LIMIT 1) AS sub_out
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata md ON md.event_id = e.event_id
       JOIN turns o ON o.message_id = md.owner_message_id AND o.is_sidechain = 0
       JOIN subagent_meta m ON m.tool_use_id = e.event_id
       WHERE e.tool_name = 'Agent' AND e.ts >= ? AND e.ts < ?`,
    )
    .all(from, to) as {
    event_id: string;
    session_id: string;
    workspace_id: string;
    owner_message_id: string;
    owner_ts: string;
    pricing_snapshot_id: string | null;
    cache_write_5m: number;
    cache_write_1h: number;
    sub_out: number | null;
  }[];

  const carryStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND is_sidechain = 0 AND ts > ?",
  );
  const spendStmt = db.prepare(
    "SELECT SUM(cost_equiv_u) AS u FROM turns WHERE workspace_id = ? AND ts >= ? AND ts < ?",
  );

  interface Ws {
    oversized: number;
    maxBytes: number;
    sessions: Set<string>;
    savingU: number;
    allCalls: number;
  }
  const byWs = new Map<string, Ws>();
  for (const c of calls) {
    const w = byWs.get(c.workspace_id) ?? {
      oversized: 0,
      maxBytes: 0,
      sessions: new Set(),
      savingU: 0,
      allCalls: 0,
    };
    w.allCalls++;
    byWs.set(c.workspace_id, w);
    const bytes = (c.sub_out ?? 0) * BYTES_PER_TOKEN;
    if (bytes > w.maxBytes) w.maxBytes = bytes;
    if (bytes <= MIN_BYTES) continue;
    w.oversized++; // candidate-shaped: large return, before pricing/session/spend gates
    const px = c.pricing_snapshot_id ? prices.get(c.pricing_snapshot_id) : undefined;
    const carry = (carryStmt.get(c.session_id, c.owner_ts) as { n: number }).n;
    if (!px || carry < 1) continue;
    const write = (c.cache_write_1h > c.cache_write_5m ? px[4] : px[3]) as number;
    const price = write + (carry - 1) * (px[2] as number);
    if (price <= 0) continue;
    w.savingU += Math.round((c.sub_out as number) * 0.5 * price);
    w.sessions.add(c.session_id);
  }

  let candidates = 0;
  let qualifying = 0;
  let best: { score: number; gates: ProbeGate[] } | null = null;
  for (const [ws, w] of byWs) {
    if (w.oversized > 0) candidates++;
    const spend = ((spendStmt.get(ws, from, to) as { u: number | null }).u ?? 0) as number;
    const pct = spend > 0 ? (w.savingU / spend) * 100 : null;
    const gates: ProbeGate[] = [
      {
        name: "D12_MIN_RETURN_BYTES",
        value: w.maxBytes,
        threshold: MIN_BYTES,
        op: ">",
        pass: w.maxBytes > MIN_BYTES,
      },
      {
        name: "D12_MIN_SIDECHAIN_SESSIONS",
        value: w.sessions.size,
        threshold: 3,
        op: ">=",
        pass: w.sessions.size >= 3,
      },
      pct === null
        ? {
            name: "D12_MIN_PCT_OF_SPEND",
            value: null,
            threshold: 0.25,
            op: ">=",
            pass: w.sessions.size > 0,
          }
        : {
            name: "D12_MIN_PCT_OF_SPEND",
            value: pct,
            threshold: 0.25,
            op: ">=",
            pass: pct >= 0.25,
          },
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
    note: `${calls.length} linked main-thread Agent calls in window across ${byWs.size} workspaces; ${candidates} workspaces with a return over 10 KiB (assumed ${BYTES_PER_TOKEN} B/token); ${qualifying} pass all gates`,
  };
};
