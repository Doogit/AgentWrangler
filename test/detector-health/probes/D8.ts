/**
 * DH2 probe D8 CACHE_WRITE_CHURN, written from docs/plans/dh-contracts.md card D8 only.
 * Reads base `turns` + `pricing_snapshots` + `user_config` (cap_read_coeff) only.
 */

import type Database from "better-sqlite3";
import { type PTurn, type Workspace, loadWorkspaces, median, netPriceU, tierMin } from "./B1.js";
import type { Probe, ProbeGate } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60_000;
const LOW_READ_RATIO = 0.2;
const EVENT_FLOOR_PCT = 0.1;
const CREATION_SPIKE = 50_000;
const MIN_EVENTS = 3;
const CREATION_SHARE = 0.15;
const CARD_GATE_PCT = 1;
const AVOIDANCE = 0.64;
/** Assumed read weight when user_config has no cap_read_coeff (cache reads ~0.1x on the cap). */
const DEFAULT_CAP_READ_COEFF = 0.1;

interface Event {
  t: PTurn;
  gapMin: number;
}

function capReadCoeff(db: Database.Database): number {
  try {
    const r = db.prepare("SELECT value FROM user_config WHERE key = 'cap_read_coeff'").get() as
      | { value: string | null }
      | undefined;
    const n = r?.value == null ? Number.NaN : Number(r.value);
    return Number.isFinite(n) ? n : DEFAULT_CAP_READ_COEFF;
  } catch {
    return DEFAULT_CAP_READ_COEFF;
  }
}

/** Median first main-thread turn context of sessions whose first main turn is in the window. */
function basePrefix(ws: Workspace, from: number): number {
  const first = new Map<string, { ms: number; ctx: number }>();
  for (const thread of ws.threads.values()) {
    const t = thread[0] as PTurn;
    const c = first.get(t.session);
    if (!c || t.ms < c.ms) first.set(t.session, { ms: t.ms, ctx: t.ctx });
  }
  return median([...first.values()].filter((f) => f.ms >= from).map((f) => f.ctx)) ?? 0;
}

export const probeD8: Probe = (db, now) => {
  const from = now.getTime() - 7 * DAY_MS;
  const coeff = capReadCoeff(db);
  const wss = loadWorkspaces(db, now);

  // Per-turn session cap-weighted tokens (in + out + creation + coeff * reads), window turns,
  // including sidechain. Output tokens are not in loadWorkspaces, so query once here.
  const capBySession = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT session_id, ts, input_tokens, output_tokens, cache_read_tokens,
              cache_write_5m, cache_write_1h, cache_write_other
         FROM turns WHERE provisional = 0`,
    )
    .all() as {
    session_id: string;
    ts: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_5m: number;
    cache_write_1h: number;
    cache_write_other: number;
  }[]) {
    const ms = Date.parse(r.ts);
    if (Number.isNaN(ms) || ms < from || ms >= now.getTime()) continue;
    const w =
      r.input_tokens +
      r.output_tokens +
      r.cache_write_5m +
      r.cache_write_1h +
      r.cache_write_other +
      coeff * r.cache_read_tokens;
    capBySession.set(r.session_id, (capBySession.get(r.session_id) ?? 0) + w);
  }

  let candidates = 0;
  let qualifying = 0;
  let bestGates: ProbeGate[] = [];
  let bestScore = -1;
  for (const ws of wss.values()) {
    const events: Event[] = [];
    for (const thread of ws.threads.values()) {
      for (let i = 1; i < thread.length; i++) {
        const t = thread[i] as PTurn;
        if (t.ms < from || t.creation <= 0) continue;
        let ttl = tierMin(t) ?? 60;
        for (let j = i - 1; j >= 0; j--) {
          const tj = tierMin(thread[j] as PTurn);
          if (tj !== null) {
            ttl = tj;
            break;
          }
        }
        const gapMin = (t.ms - (thread[i - 1] as PTurn).ms) / MIN_MS;
        if (gapMin > ttl && t.reads < LOW_READ_RATIO * t.creation) events.push({ t, gapMin });
      }
    }
    if (events.length === 0) continue;
    candidates++;
    const sized = events.filter((e) =>
      ws.spendU > 0
        ? ((e.t.creation * netPriceU(e.t)) / ws.spendU) * 100 >= EVENT_FLOOR_PCT
        : e.t.creation >= CREATION_SPIKE,
    );
    const base = basePrefix(ws, from);
    const churnCreation = sized.reduce((s, e) => s + e.t.creation, 0);
    const sessions = new Set(sized.map((e) => e.t.session));
    const capTotal = [...sessions].reduce((s, id) => s + (capBySession.get(id) ?? 0), 0);
    const share = capTotal > 0 ? churnCreation / capTotal : null;
    const savingU = sized.reduce(
      (s, e) => s + Math.max(0, e.t.creation - base) * netPriceU(e.t) * AVOIDANCE,
      0,
    );
    const savingPct = ws.spendU > 0 ? (savingU / ws.spendU) * 100 : null;
    const trigger = sized.length >= MIN_EVENTS || (share !== null && share >= CREATION_SHARE);
    const pass = trigger && savingU > 0 && (savingPct === null || savingPct >= CARD_GATE_PCT);
    if (pass) qualifying++;
    const score = (pass ? 1e9 : 0) + sized.length * 1e3 + (savingPct ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestGates = [
        {
          name: "D8_MIN_EVENTS",
          value: sized.length,
          threshold: MIN_EVENTS,
          op: ">=",
          pass: sized.length >= MIN_EVENTS,
        },
        {
          name: "D8_CREATION_SHARE",
          value: share,
          threshold: CREATION_SHARE,
          op: ">=",
          pass: share !== null && share >= CREATION_SHARE,
        },
        {
          name: "D8_EVENT_FLOOR_PCT",
          value: events.length === sized.length ? EVENT_FLOOR_PCT : null,
          threshold: EVENT_FLOOR_PCT,
          op: ">=",
          pass: sized.length === events.length,
        },
        { name: "MODELLED_SAVING_U", value: savingU, threshold: 0, op: ">", pass: savingU > 0 },
        {
          name: "D8_CARD_GATE_PCT",
          value: savingPct,
          threshold: CARD_GATE_PCT,
          op: ">=",
          pass: savingPct === null || savingPct >= CARD_GATE_PCT,
        },
      ];
    }
  }
  return {
    candidates,
    qualifying,
    gates: bestGates,
    note:
      "Candidates/qualifying = workspaces. Raw turns (provisional=0, main thread is_sidechain=0, window " +
      "[now-7d,now), earlier turns used as history). Churn event: has an earlier turn in the same " +
      "session+agent_id thread, creation(5m+1h+other)>0, gap > TTL (latest earlier write tier 5m=5 / 1h=60, else " +
      "own tier, else 60), reads<0.2*creation, and size floor (creation*(write-read price) >=0.1% of window " +
      "sum(cost_equiv_u) when spend>0, else creation>=50,000). D8_EVENT_FLOOR_PCT gate = whether every raw " +
      "event cleared the size floor (value shown only when all did). Fires: >=3 sized events OR churn " +
      "creation/cap-weighted tokens of contributing sessions >=15% (cap = in+out+creation+cap_read_coeff*reads, " +
      "coeff from user_config else 0.1), AND saving>0 AND saving >=1% of spend. Saving = sum(max(0, creation - " +
      "base prefix)*(write-read price))*0.64, base prefix = median first-turn context of in-window sessions.",
  };
};
