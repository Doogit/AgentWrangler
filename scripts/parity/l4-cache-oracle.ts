/**
 * P3.L L4 oracle: expected D8 / B1 / B3 ledger claims from plain SQL. Imports no src/ code, so it
 * is independent of the producers it checks (design §6 L4). Compare with
 * `ledger-conservation.ts` on the same --db/--from/--to window.
 *
 * Model (spec F2 v2 item 1: repricing, counterfactual = that turn's cacheRead price):
 * - Threads = (session_id, is_sidechain, agent_id) over reconciled turns before --to; an
 *   unattributed sidechain turn (agent_id NULL) has no predecessor. TTL = the thread's prior write
 *   tier (1h if cw1h > 0 and ≥ cw5m, else 5m if cw5m > 0), else this turn's tier, else 60 min main /
 *   5 min sidechain.
 * - D8: in-window main turn with a predecessor, creation (5m + 1h + other) ≥ 50k, gap > TTL, read
 *   < 0.2 × creation. Workspace fires on ≥ 3 events or creation ≥ 15% of its event sessions'
 *   cap-weighted tokens (creation + 0.1 × read + input + output; coeff from user_config).
 *   Net = max(0, creation − base prefix), base = median first-main-turn context of sessions that
 *   started in the window. Raw per cell = round(net × cell / creation); the cw_other share has no
 *   ledger cell and is reported as unclaimable.
 * - B1: in-window main turn with a predecessor, gap ≤ TTL, prev read > 20k, read × 10 < prev read.
 *   Every pair fires its workspace. Raw per cell = the whole cell.
 * - B3: first main turn of a session following, in the same workspace, the last main turn of
 *   another session (global ts order), gap ≤ 5 min, B1 collapse test, creation > 20k, both sessions
 *   uniquely linked to the same work item. Raw per cell as D8 (net of base over ALL sessions'
 *   first main turns that started in the window). One rec per event.
 * - value = round(raw × fraction) × (cell price − read price), clamped ≥ 0; unpriced turn = 0.
 */
import * as crypto from "node:crypto";
import Database from "better-sqlite3";

// Mirrors of src constants and operator decisions; a drift here is a finding, not a fix.
const D8_FRACTION = 0.64; // P3.2-F4a, operator 2026-09-28
const B_FRACTION = 0.5;
const D8_SPIKE = 50_000;
const D8_LOW_READ = 0.2;
const D8_MIN_EVENTS = 3;
const D8_SHARE = 0.15;
const B1_PREV_READ = 20_000;
const B3_GAP_MS = 5 * 60 * 1000;
const B3_CREATION = 20_000;
const CAP_READ_COEFF = 0.1;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i] ?? "", argv[i + 1] ?? "");
  const db = args.get("--db");
  if (!db) throw new Error("Usage: l4-cache-oracle.ts --db <path> [--from ISO --to ISO]");
  const to = new Date(args.get("--to") ?? Date.now());
  const from = new Date(args.get("--from") ?? to.getTime() - 7 * 86_400_000);
  return { db, fromIso: from.toISOString(), toIso: to.toISOString() };
}

function recId(detector: string, scopeWs: string | null, scopeKey: string): string {
  const hash = crypto.createHash("sha1").update(scopeKey).digest("hex").slice(0, 16);
  return `rec-${detector}-${scopeWs ?? "global"}-${hash}`;
}

interface Turn {
  message_id: string;
  session_id: string;
  is_sidechain: number;
  agent_id: string | null;
  workspace_id: string;
  ts: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_other: number;
  unit_prices_json: string | null;
}

const { db: dbPath, fromIso, toIso } = parseArgs(process.argv);
const db = new Database(dbPath, { readonly: true });

const coeffRaw = (
  db.prepare("SELECT value FROM user_config WHERE key = 'cap_read_coeff'").get() as
    | { value: string | null }
    | undefined
)?.value;
const coeffNum = coeffRaw == null || coeffRaw.trim() === "" ? Number.NaN : Number(coeffRaw);
const COEFF =
  Number.isFinite(coeffNum) && coeffNum > 0 && coeffNum <= 1 ? coeffNum : CAP_READ_COEFF;

const turns = db
  .prepare(
    `SELECT t.message_id, t.session_id, t.is_sidechain, t.agent_id, t.workspace_id, t.ts,
            t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m,
            t.cache_write_1h, t.cache_write_other, ps.unit_prices_json
       FROM turns t LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
      WHERE t.ts < ? AND t.provisional = 0
      ORDER BY t.session_id, t.is_sidechain, t.agent_id, t.ts, t.message_id`,
  )
  .all(toIso) as Turn[];

/** [read, cw5m, cw1h] µ$/token, or null when unpriced. */
function cachePrices(t: Turn): [number, number, number] | null {
  if (t.unit_prices_json === null) return null;
  try {
    const p = JSON.parse(t.unit_prices_json) as unknown;
    if (Array.isArray(p) && p.length === 5)
      return [Number(p[2]) || 0, Number(p[3]) || 0, Number(p[4]) || 0];
  } catch {
    /* unpriced */
  }
  return null;
}

const tierOf = (t: Turn): "5m" | "1h" | null =>
  t.cache_write_1h > 0 && t.cache_write_1h >= t.cache_write_5m
    ? "1h"
    : t.cache_write_5m > 0
      ? "5m"
      : null;
const creationOf = (t: Turn) => t.cache_write_5m + t.cache_write_1h + t.cache_write_other;
const key = (t: Turn) => `${t.session_id}|${t.message_id}`;

// --- thread walk (gap vs TTL) ---
interface Step {
  t: Turn;
  prev: Turn;
  gapMin: number;
  ttlMin: number;
}
const steps: Step[] = [];
{
  let prev: Turn | undefined;
  let priorTier: "5m" | "1h" | null = null;
  for (const t of turns) {
    const unattributed = t.is_sidechain !== 0 && t.agent_id === null;
    const same =
      !unattributed &&
      prev !== undefined &&
      prev.session_id === t.session_id &&
      prev.is_sidechain === t.is_sidechain &&
      prev.agent_id === t.agent_id;
    if (!same) priorTier = null;
    const cur = tierOf(t);
    const tier = priorTier ?? cur;
    const ttlMin = tier === "1h" ? 60 : tier === "5m" ? 5 : t.is_sidechain !== 0 ? 5 : 60;
    if (same && prev)
      steps.push({ t, prev, gapMin: (Date.parse(t.ts) - Date.parse(prev.ts)) / 60_000, ttlMin });
    priorTier = cur ?? priorTier;
    prev = t;
  }
}

// --- base prefix (median first-main-turn context of sessions started in the window) ---
function medianBase(firsts: Turn[]): Map<string, number> {
  const lists = new Map<string, number[]>();
  for (const t of firsts) {
    if (t.ts < fromIso) continue;
    const l = lists.get(t.workspace_id) ?? [];
    l.push(t.input_tokens + t.cache_read_tokens + creationOf(t));
    lists.set(t.workspace_id, l);
  }
  const out = new Map<string, number>();
  for (const [ws, l] of lists) {
    l.sort((a, b) => a - b);
    const m = Math.floor(l.length / 2);
    out.set(ws, l.length % 2 ? (l[m] ?? 0) : Math.round(((l[m - 1] ?? 0) + (l[m] ?? 0)) / 2));
  }
  return out;
}
const mainTurns = turns
  .filter((t) => t.is_sidechain === 0)
  .sort((a, b) =>
    a.workspace_id < b.workspace_id
      ? -1
      : a.workspace_id > b.workspace_id
        ? 1
        : a.ts < b.ts
          ? -1
          : a.ts > b.ts
            ? 1
            : a.session_id < b.session_id
              ? -1
              : a.session_id > b.session_id
                ? 1
                : a.message_id < b.message_id
                  ? -1
                  : a.message_id > b.message_id
                    ? 1
                    : 0,
  );
const firstBySession = new Map<string, Turn>();
const lastBySession = new Map<string, Turn>();
for (const t of mainTurns) {
  if (!firstBySession.has(t.session_id)) firstBySession.set(t.session_id, t);
  lastBySession.set(t.session_id, t);
}
// D8 takes each session's MIN(ts) main turn (first by ts only); B3 the first in its sort order.
// Both pick the same turn unless two main turns share the session's first ts.
const base = medianBase([...firstBySession.values()]);

// --- claim accumulation ---
interface Totals {
  events: number;
  claims: number;
  tokens: number;
  value_u: number;
  unclaimableOtherRaw: number;
  unpricedEvents: number;
}
const newTotals = (): Totals => ({
  events: 0,
  claims: 0,
  tokens: 0,
  value_u: 0,
  unclaimableOtherRaw: 0,
  unpricedEvents: 0,
});
const byRec: Record<string, Totals & { detector: string }> = {};

/** Claims for one event turn: raw per cell, fraction, (cell − read) price. */
function claim(
  detector: string,
  rec: string,
  t: Turn,
  raw5: number,
  raw1h: number,
  rawOther: number,
  fraction: number,
) {
  const r = byRec[rec] ?? { detector, ...newTotals() };
  byRec[rec] = r;
  r.events += 1;
  r.unclaimableOtherRaw += rawOther;
  const p = cachePrices(t);
  if (p === null) r.unpricedEvents += 1;
  for (const [raw, cellPrice] of [
    [raw5, p?.[1] ?? 0],
    [raw1h, p?.[2] ?? 0],
  ] as const) {
    if (raw <= 0) continue;
    const tokens = Math.round(raw * fraction);
    if (tokens <= 0) continue;
    const net = Math.max(0, cellPrice - (p?.[0] ?? 0));
    if (p !== null && net === 0) continue; // ledger rejects a $0 reprice on a priced turn
    r.claims += 1;
    r.tokens += tokens;
    r.value_u += tokens * net;
  }
}
function netSplit(t: Turn, net: number): [number, number, number] {
  const c = creationOf(t);
  if (c <= 0 || net <= 0) return [0, 0, 0];
  const r5 = Math.round((net * t.cache_write_5m) / c);
  const r1h = Math.round((net * t.cache_write_1h) / c);
  return [r5, r1h, Math.max(0, net - r5 - r1h)];
}

// D8
const d8Turns = new Set<string>();
const d8ByWs = new Map<string, { events: Turn[]; sessions: Set<string> }>();
for (const { t, gapMin, ttlMin } of steps) {
  if (t.ts < fromIso || t.is_sidechain !== 0) continue;
  const c = creationOf(t);
  if (c < D8_SPIKE || !(gapMin > ttlMin) || !(t.cache_read_tokens < D8_LOW_READ * c)) continue;
  d8Turns.add(key(t));
  const w = d8ByWs.get(t.workspace_id) ?? { events: [], sessions: new Set<string>() };
  w.events.push(t);
  w.sessions.add(t.session_id);
  d8ByWs.set(t.workspace_id, w);
}
const capStmt = db.prepare(
  `SELECT SUM((cache_write_5m + cache_write_1h + cache_write_other) + ${COEFF} * cache_read_tokens
              + (input_tokens + output_tokens)) AS cap
     FROM turns WHERE session_id = ? AND ts >= ? AND ts < ? AND provisional = 0`,
);
const d8Card: Record<string, unknown> = {};
for (const [ws, { events, sessions }] of d8ByWs) {
  const totalCreation = events.reduce((s, t) => s + creationOf(t), 0);
  let denom = 0;
  for (const sid of sessions)
    denom += (capStmt.get(sid, fromIso, toIso) as { cap: number | null }).cap ?? 0;
  const share = denom > 0 ? totalCreation / denom : 0;
  const fires = events.length >= D8_MIN_EVENTS || share >= D8_SHARE;
  const b = base.get(ws) ?? 0;
  // Card (independent recompute of the detector formula; unpriced turns at 0 here).
  let netU = 0;
  let netTokens = 0;
  for (const t of events) {
    const p = cachePrices(t) ?? [0, 0, 0];
    const c = creationOf(t);
    const n = Math.max(0, c - b);
    const writeU =
      t.cache_write_5m * (p[1] - p[0]) +
      t.cache_write_1h * (p[2] - p[0]) +
      t.cache_write_other * (p[1] - p[0]);
    netTokens += n;
    netU += c > 0 ? (writeU * n) / c : 0;
  }
  const rec = recId("D8", ws, `D8|${ws}`);
  d8Card[rec] = {
    fires,
    events: events.length,
    share: Number(share.toFixed(4)),
    base: b,
    netTokens,
    cardUsd_at_0_64: Number(((netU * D8_FRACTION) / 1e6).toFixed(4)),
    cardUsd_at_0_70: Number(((netU * 0.7) / 1e6).toFixed(4)),
  };
  if (!fires) continue;
  for (const t of events) {
    const [r5, r1h, rOther] = netSplit(t, Math.max(0, creationOf(t) - b));
    claim("D8", rec, t, r5, r1h, rOther, D8_FRACTION);
  }
}

// B1
const b1Turns = new Set<string>();
const b1CardFullWriteUsd: Record<string, number> = {};
for (const { t, prev, gapMin, ttlMin } of steps) {
  if (t.ts < fromIso || t.is_sidechain !== 0 || !(gapMin <= ttlMin)) continue;
  if (
    !(
      prev.cache_read_tokens > B1_PREV_READ &&
      t.cache_read_tokens >= 0 &&
      t.cache_read_tokens * 10 < prev.cache_read_tokens
    )
  )
    continue;
  b1Turns.add(key(t));
  const rec = recId("B1", t.workspace_id, `B1|${t.workspace_id}`);
  claim("B1", rec, t, t.cache_write_5m, t.cache_write_1h, t.cache_write_other, B_FRACTION);
  b1CardFullWriteUsd[rec] = (b1CardFullWriteUsd[rec] ?? 0) + creationOf(t);
}

// B3
const links = new Map<string, Set<string>>();
for (const l of db
  .prepare("SELECT session_id, work_item_id FROM session_work_links")
  .all() as Array<{
  session_id: string;
  work_item_id: string;
}>) {
  const s = links.get(l.session_id) ?? new Set<string>();
  s.add(l.work_item_id);
  links.set(l.session_id, s);
}
const b3Turns = new Set<string>();
for (let i = 1; i < mainTurns.length; i++) {
  const prev = mainTurns[i - 1] as Turn;
  const cur = mainTurns[i] as Turn;
  if (prev.workspace_id !== cur.workspace_id || prev.session_id === cur.session_id) continue;
  if (lastBySession.get(prev.session_id) !== prev || firstBySession.get(cur.session_id) !== cur)
    continue;
  if (cur.ts < fromIso) continue;
  if (
    !(
      prev.cache_read_tokens > B1_PREV_READ &&
      cur.cache_read_tokens >= 0 &&
      cur.cache_read_tokens * 10 < prev.cache_read_tokens
    )
  )
    continue;
  const gap = Date.parse(cur.ts) - Date.parse(prev.ts);
  const a = links.get(prev.session_id);
  const b = links.get(cur.session_id);
  const shared = a && b && a.size === 1 && b.size === 1 && [...a][0] === [...b][0];
  if (!(gap >= 0 && gap <= B3_GAP_MS && creationOf(cur) > B3_CREATION && shared)) continue;
  b3Turns.add(key(cur));
  const scope = `B3|${cur.workspace_id}|${prev.session_id}|${cur.session_id}|${cur.message_id}`;
  const [r5, r1h, rOther] = netSplit(
    cur,
    Math.max(0, creationOf(cur) - (base.get(cur.workspace_id) ?? 0)),
  );
  claim("B3", recId("B3", cur.workspace_id, scope), cur, r5, r1h, rOther, B_FRACTION);
}

const inter = (a: Set<string>, b: Set<string>) => [...a].filter((k) => b.has(k)).length;
const $ = (u: number) => Number((u / 1e6).toFixed(4));
const byDetector: Record<string, Totals & { recs: number; usd: number }> = {};
for (const r of Object.values(byRec)) {
  const d = byDetector[r.detector] ?? { recs: 0, usd: 0, ...newTotals() };
  byDetector[r.detector] = d;
  d.recs += 1;
  d.events += r.events;
  d.claims += r.claims;
  d.tokens += r.tokens;
  d.value_u += r.value_u;
  d.unclaimableOtherRaw += r.unclaimableOtherRaw;
  d.unpricedEvents += r.unpricedEvents;
}
for (const d of Object.values(byDetector)) d.usd = $(d.value_u);

console.log(
  JSON.stringify(
    {
      window: { fromIso, toIso },
      capReadCoeff: COEFF,
      byDetector,
      byRec: Object.fromEntries(
        Object.entries(byRec).map(([rec, r]) => [
          rec,
          {
            detector: r.detector,
            events: r.events,
            claims: r.claims,
            tokens: r.tokens,
            usd: $(r.value_u),
            value_u: r.value_u,
          },
        ]),
      ),
      reference: {
        d8Card,
        b1CreationTokensByRec: b1CardFullWriteUsd,
      },
      turnIntersections: {
        b1_d8: inter(b1Turns, d8Turns),
        b3_d8: inter(b3Turns, d8Turns),
        b3_b1: inter(b3Turns, b1Turns),
        d8AllEventTurns: d8Turns.size,
        b1Turns: b1Turns.size,
        b3Turns: b3Turns.size,
      },
    },
    null,
    2,
  ),
);
