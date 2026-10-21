/**
 * P3.L L3 oracle: expected A1 / A2 / D7x ledger claims from plain SQL. Imports no src/ code, so it
 * is independent of the producers it checks (design §6 L3). Compare with
 * `ledger-conservation.ts` on the same --db/--from/--to window.
 *
 * Model (spec F2 v2; A1 absorbs D6 per P3.C 2026-09-28, so no D6 exclusion):
 * - Chain of an event = turns of its owner turn's session with the same is_sidechain AND agent_id.
 *   Later turns = chain turns with ts > event ts, cut at the first compacted / collapsed turn
 *   (collapse: prev context > 50k and context < 0.5 × prev), cap 75 (carryTurns).
 * - Later turn 1 ingests the result: write claim on its cw5m / cw1h, raw split by the cell sizes.
 *   Later turns 2..n carry it: cacheRead claim each. D7x the same; A2 writes only (main thread).
 * - raw tokens: A1 round((bytes − 25600) / 2.7); A2 round((bytes − 10240) / bpt);
 *   D7x round(bytes / bpt); bpt = user_config bytes_per_token when valid, else 2.7.
 * - Per detector and cell, Σ raw ≤ cell tokens (events in ts, event_id order).
 * - fraction 0.5 for all three; value = round(raw × 0.5) × that turn's unit price.
 * - Only turns the ledger bills count (window, provisional = 0; no agent-type filter).
 * Ignores cross-detector caps (D1/D10 above A1 on cacheRead): the ledger may allocate less.
 */
import * as crypto from "node:crypto";
import Database from "better-sqlite3";

// Mirrors of src constants; a drift here is a finding, not a fix.
const A1_BYTES = 25_600;
const A2_BYTES = 10_240;
const EST_BPT = 2.7;
const FRACTION = 0.5;
const CARRY_CAP = 75;
const XREAD_MIN_READS = 10;
const XREAD_MAX_SHARE = 0.8;
const XREAD_ROW_CAP = 500;
const COMPONENTS = ["input", "output", "cacheRead", "cw5m", "cw1h"] as const;
type Component = (typeof COMPONENTS)[number];

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i] ?? "", argv[i + 1] ?? "");
  const db = args.get("--db");
  if (!db) throw new Error("Usage: l3-result-oracle.ts --db <path> [--from ISO --to ISO]");
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
  ts: string;
  context_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  unit_prices_json: string | null;
}
interface Ev {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  result_bytes: number;
  sc: number | null;
  agent_id: string | null;
  owner_read: number | null;
  owner_write: number | null;
}

const { db: dbPath, fromIso, toIso } = parseArgs(process.argv);
const db = new Database(dbPath, { readonly: true });

const bptRaw = (
  db.prepare("SELECT value FROM user_config WHERE key = 'bytes_per_token'").get() as
    | { value: string | null }
    | undefined
)?.value;
const bptNum = bptRaw == null ? Number.NaN : Number(bptRaw);
const BPT = Number.isFinite(bptNum) && bptNum > 0 ? bptNum : EST_BPT;

const billed = new Set(
  (
    db
      .prepare(
        `SELECT t.session_id || '|' || t.message_id AS k FROM turns t
          WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
      )
      .all(fromIso, toIso) as Array<{ k: string }>
  ).map((r) => r.k),
);

const chainStmt = db.prepare(
  `SELECT t.message_id, t.ts, t.context_tokens, t.cache_read_tokens, t.cache_write_5m,
          t.cache_write_1h, ps.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id
    WHERE t.session_id = ? AND t.is_sidechain = ? AND t.agent_id IS ?
    ORDER BY t.ts ASC, t.message_id ASC`,
);
const mixedChainStmt = db.prepare(
  `SELECT t.message_id, t.ts, t.context_tokens FROM turns t
    WHERE t.session_id = ? AND t.is_sidechain = ? ORDER BY t.ts ASC, t.message_id ASC`,
);
const compactStmt = db.prepare(
  `SELECT MIN(event_ts) AS ts FROM ingest_metric_events
    WHERE session_id = ? AND event_ts > ?
      AND boundary_kind = 'compact-boundary' AND boundary_verification = 'VERIFIED'`,
);

function laterTurns<T extends { ts: string; context_tokens: number }>(chain: T[], ev: Ev): T[] {
  const compactTs = (compactStmt.get(ev.session_id, ev.ts) as { ts: string | null }).ts;
  const out: T[] = [];
  let prev: number | undefined;
  let stopped = false;
  for (const turn of chain) {
    const collapsed = prev !== undefined && prev > 50_000 && turn.context_tokens < prev * 0.5;
    if (turn.ts > ev.ts && !stopped) {
      if ((compactTs !== null && turn.ts >= compactTs) || collapsed || out.length === CARRY_CAP)
        stopped = true;
      else out.push(turn);
    }
    prev = turn.context_tokens;
  }
  return out;
}

function price(turn: Turn, component: Component): number {
  if (turn.unit_prices_json === null) return 0;
  try {
    const p = JSON.parse(turn.unit_prices_json) as unknown;
    if (Array.isArray(p) && p.length === 5) return Number(p[COMPONENTS.indexOf(component)]) || 0;
  } catch {
    /* unpriced */
  }
  return 0;
}

interface Totals {
  events: number;
  claims: number;
  raw: number;
  tokens: number;
  value_u: number;
  clampLossRaw: number;
  unbilledClaims: number;
  write_u: number;
  carry_u: number;
}
const newTotals = (): Totals => ({
  events: 0,
  claims: 0,
  raw: 0,
  tokens: 0,
  value_u: 0,
  clampLossRaw: 0,
  unbilledClaims: 0,
  write_u: 0,
  carry_u: 0,
});

/** Emits the claims of one detector; returns totals per rec. */
function run(detector: string, events: Array<Ev & { raw: number; rec: string }>, carry: boolean) {
  const used = new Map<string, number>();
  const byRec: Record<string, Totals> = {};
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.event_id < b.event_id ? -1 : 1));
  for (const ev of events) {
    const t = (byRec[ev.rec] ??= newTotals());
    t.events += 1;
    if (ev.sc === null) continue;
    const later = laterTurns(chainStmt.all(ev.session_id, ev.sc, ev.agent_id) as Turn[], ev);
    const claims: Array<[Turn, Component, number, "write" | "carry"]> = [];
    const write = later[0];
    if (write) {
      const cw = write.cache_write_5m + write.cache_write_1h;
      const r5 = cw > 0 ? Math.round((ev.raw * write.cache_write_5m) / cw) : ev.raw;
      claims.push([write, "cw5m", r5, "write"], [write, "cw1h", ev.raw - r5, "write"]);
    }
    if (carry) for (const turn of later.slice(1)) claims.push([turn, "cacheRead", ev.raw, "carry"]);
    for (const [turn, component, raw, kind] of claims) {
      if (raw <= 0) continue;
      const key = `${ev.session_id}|${turn.message_id}`;
      if (!billed.has(key)) {
        t.unbilledClaims += 1;
        continue;
      }
      const cellKey = `${key}|${component}`;
      const cell =
        component === "cacheRead"
          ? turn.cache_read_tokens
          : component === "cw5m"
            ? turn.cache_write_5m
            : turn.cache_write_1h;
      const room = Math.max(0, cell - (used.get(cellKey) ?? 0));
      const clamped = Math.min(raw, room);
      t.clampLossRaw += raw - clamped;
      if (clamped <= 0) continue;
      used.set(cellKey, (used.get(cellKey) ?? 0) + clamped);
      const tokens = Math.round(clamped * FRACTION);
      const value = tokens * price(turn, component);
      t.claims += 1;
      t.raw += clamped;
      t.tokens += tokens;
      t.value_u += value;
      if (kind === "write") t.write_u += value;
      else t.carry_u += value;
    }
  }
  return { detector, byRec };
}

const EVENT_COLS = `e.event_id, e.session_id, s.workspace_id, e.ts, e.result_bytes,
  t.is_sidechain AS sc, t.agent_id, CAST(json_extract(ps.unit_prices_json, '$[2]') AS REAL) AS owner_read,
  CAST(json_extract(ps.unit_prices_json, '$[3]') AS REAL) AS owner_write`;
const EVENT_JOINS = `FROM tool_events e JOIN sessions s ON s.session_id = e.session_id
  LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
  LEFT JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
  LEFT JOIN pricing_snapshots ps ON ps.snapshot_id = t.pricing_snapshot_id`;

// A1: every result over 25.6KB (D6 folded in: no session exclusion).
const a1Events = (
  db
    .prepare(`SELECT ${EVENT_COLS} ${EVENT_JOINS} WHERE e.ts >= ? AND e.ts < ? AND e.result_bytes > ?`)
    .all(fromIso, toIso, A1_BYTES) as Ev[]
).map((ev) => ({
  ...ev,
  raw: Math.round((ev.result_bytes - A1_BYTES) / EST_BPT),
  rec: recId("A1", ev.workspace_id, `A1|${ev.workspace_id}`),
}));

// Reference: the detector's own E-estimate (mixed sidechain chain, owner prices, write + read × n).
let a1EstimateU = 0;
for (const ev of a1Events) {
  if (ev.sc === null) continue;
  const n = laterTurns(mixedChainStmt.all(ev.session_id, ev.sc) as Turn[], ev).length;
  a1EstimateU +=
    ((ev.result_bytes - A1_BYTES) / EST_BPT) *
    FRACTION *
    ((ev.owner_write ?? 0) + (ev.owner_read ?? 0) * n);
}

// A2: main-thread TaskOutput over 10KB; results over 25.6KB are A1's (one owner per event).
const a2Events = (
  db
    .prepare(
      `SELECT ${EVENT_COLS} ${EVENT_JOINS}
        WHERE e.ts >= ? AND e.ts < ? AND e.tool_name = 'TaskOutput' AND e.result_bytes > ?
          AND e.result_bytes <= ? AND t.is_sidechain = 0 AND t.provisional = 0`,
    )
    .all(fromIso, toIso, A2_BYTES, A1_BYTES) as Ev[]
).map((ev) => ({
  ...ev,
  raw: Math.round((ev.result_bytes - A2_BYTES) / BPT),
  rec: recId("A2", ev.workspace_id, `A2|${ev.workspace_id}`),
}));

// D7x: qualifying paths (same gates as the detector); redundant = each session's first read of
// the path, except the session that read it first.
const paths = db
  .prepare(
    `WITH edited AS (
       SELECT DISTINCT e.session_id, m.file_path_hash FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE e.ts >= ? AND e.ts < ? AND e.tool_name IN ('Edit', 'MultiEdit', 'Write', 'NotebookEdit')
          AND m.file_path_hash IS NOT NULL),
     psr AS (
       SELECT s.workspace_id, m.file_path_hash, e.session_id, COUNT(*) AS n,
              SUM(COALESCE(e.result_bytes, 0)) AS b
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE e.ts >= ? AND e.ts < ? AND e.tool_name = 'Read' AND m.file_path_hash IS NOT NULL
          AND COALESCE(e.result_bytes, 0) <= ?
          AND NOT EXISTS (SELECT 1 FROM edited d WHERE d.session_id = e.session_id
                           AND d.file_path_hash = m.file_path_hash)
        GROUP BY s.workspace_id, m.file_path_hash, e.session_id)
     SELECT workspace_id, file_path_hash, SUM(n) AS reads, COUNT(*) AS sessions, SUM(b / n) AS bytes
       FROM psr GROUP BY workspace_id, file_path_hash
      HAVING reads >= ? AND sessions >= 2 AND CAST(MAX(n) AS REAL) / reads <= ?
      ORDER BY bytes DESC LIMIT ?`,
  )
  .all(fromIso, toIso, fromIso, toIso, A1_BYTES, XREAD_MIN_READS, XREAD_MAX_SHARE, XREAD_ROW_CAP) as Array<{
  workspace_id: string;
  file_path_hash: string;
  reads: number;
  sessions: number;
  bytes: number;
}>;
const firstReads = db.prepare(
  `SELECT ${EVENT_COLS} ${EVENT_JOINS}
    WHERE s.workspace_id = ? AND m.file_path_hash = ? AND e.ts >= ? AND e.ts < ?
      AND e.tool_name = 'Read' AND s.state = 'RECONCILED' AND COALESCE(e.result_bytes, 0) <= ?
      AND NOT EXISTS (SELECT 1 FROM tool_events x JOIN tool_event_metadata xm ON xm.event_id = x.event_id
            WHERE x.session_id = e.session_id AND xm.file_path_hash = m.file_path_hash
              AND x.ts >= ? AND x.ts < ? AND x.tool_name IN ('Edit', 'MultiEdit', 'Write', 'NotebookEdit'))
    ORDER BY e.ts ASC, e.event_id ASC`,
);
const d7Events: Array<Ev & { raw: number; rec: string }> = [];
const d7Card: Record<string, { paths: number; reads: number; bytes: number }> = {};
for (const p of paths) {
  const card = (d7Card[p.workspace_id] ??= { paths: 0, reads: 0, bytes: 0 });
  card.paths += 1;
  card.reads += p.sessions;
  card.bytes += p.bytes;
  const seen = new Set<string>();
  const firsts: Ev[] = [];
  for (const ev of firstReads.all(
    p.workspace_id,
    p.file_path_hash,
    fromIso,
    toIso,
    A1_BYTES,
    fromIso,
    toIso,
  ) as Ev[]) {
    if (seen.has(ev.session_id)) continue;
    seen.add(ev.session_id);
    firsts.push(ev);
  }
  for (const ev of firsts.slice(1))
    d7Events.push({
      ...ev,
      raw: Math.round((ev.result_bytes ?? 0) / BPT),
      rec: recId("D7", ev.workspace_id, `D7-XREAD|${ev.workspace_id}`),
    });
}

const results = [run("A1", a1Events, true), run("A2", a2Events, false), run("D7", d7Events, true)];

const owners = new Map<string, string[]>();
for (const [det, evs] of [
  ["A1", a1Events],
  ["A2", a2Events],
  ["D7", d7Events],
] as const)
  for (const ev of evs) owners.set(ev.event_id, [...(owners.get(ev.event_id) ?? []), det]);
const twiceOwned = [...owners.values()].filter((d) => d.length > 1).length;

const $ = (u: number) => Number((u / 1e6).toFixed(4));
const out = {
  window: { fromIso, toIso },
  bytesPerToken: { value: BPT, calibrated: BPT !== EST_BPT || bptRaw != null },
  byDetector: Object.fromEntries(
    results.map(({ detector, byRec }) => {
      const recs = Object.values(byRec);
      const sum = (f: (t: Totals) => number) => recs.reduce((s, t) => s + f(t), 0);
      return [
        detector,
        {
          recs: recs.length,
          events: sum((t) => t.events),
          claims: sum((t) => t.claims),
          tokens: sum((t) => t.tokens),
          usd: $(sum((t) => t.value_u)),
          write_usd: $(sum((t) => t.write_u)),
          carry_usd: $(sum((t) => t.carry_u)),
          clampLossRaw: sum((t) => t.clampLossRaw),
          unbilledClaims: sum((t) => t.unbilledClaims),
        },
      ];
    }),
  ),
  byRec: Object.fromEntries(
    results.flatMap(({ byRec }) =>
      Object.entries(byRec).map(([rec, t]) => [
        rec,
        { events: t.events, claims: t.claims, tokens: t.tokens, usd: $(t.value_u), value_u: t.value_u },
      ]),
    ),
  ),
  reference: {
    a1DetectorEstimateUsd: $(a1EstimateU),
    d7CardFacts: d7Card,
  },
  eventsOwnedTwice: twiceOwned,
};
console.log(JSON.stringify(out, null, 2));
