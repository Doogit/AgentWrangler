/**
 * D2 SESSION_LONG_FULL_CONTEXT headline oracle, written only from the dh-contracts.md D2 card.
 * Graded on the card's NET headline ("Headline (net)"): the claim ledger's value for the single global rec,
 * round(sum of per-claim value), per-claim rounding as in the card.
 *
 * Steps (card numbering): (1) qualifying sessions: >150 settled main-thread in-window turns and mean context
 * > 180,000; (2) cadence c = min(150, max(1, n-1)), parts = floor((n-1)/c)+1, splitCount = sum floor((n-1)/c);
 * (3) split starts: even_k = ceil(k n / parts), moved to the nearest commit boundary within reach = floor(n/parts/4);
 * (4) walk rows, avoided_i = min(context_i, max(0, atSplit - base - 2000)) after the first split; base = machine-wide
 * median first-turn context of sessions that started in the window; (5) reduction = (sum avoided / sum context) to
 * 4 dp; (6) rebuild = splitCount x (base + 2000) x writePrice; (7) savings = max(0, round(readSpend x reduction) -
 * round(rebuild)); (8) fraction = min(1, savings / sum(avoided x readPrice)); (9) one claim per row with avoided > 0,
 * tokens = min(round(avoided x fraction), cache_read_i), value = tokens x that turn's snapshot cache-read price.
 * Gates: >= 3 qualifying sessions, savings > 0, savings >= 1% of global window spend (zero spend passes).
 */

import type Database from "better-sqlite3";
import { priceTurns } from "./price.js";
import type { Oracle, OracleFinding } from "./types.js";

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const TURN_MIN = 150; // turns > 150
const AVG_MIN = 180_000; // avg > 180000
const MIN_SESSIONS = 3;
const MIN_PCT = 1;
const CALLS_PER_SPLIT = 150;
const SUMMARY_TOKENS = 2000;
const KEY = "D2|global|D2_LONG_CONTEXT_CACHE_READ_V1";

interface Row {
  message_id: string;
  session_id: string;
  ts: string;
  context_tokens: number;
  cache_read_tokens: number;
  cw5: number;
  cw1: number;
  cwo: number;
  prices: string | null;
}

const px = (r: Row, i: number): number => {
  if (!r.prices) return 0;
  const v = (JSON.parse(r.prices) as unknown[])[i];
  return typeof v === "number" ? v : 0;
};

export const oracleD2: Oracle = (db: Database.Database, now) => {
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const empty = (note: string) => ({ findings: [], turns_checked: [], note });

  const rows = db
    .prepare(
      `SELECT t.message_id, t.session_id, t.ts, t.context_tokens, t.cache_read_tokens,
              t.cache_write_5m AS cw5, t.cache_write_1h AS cw1, t.cache_write_other AS cwo, p.unit_prices_json AS prices
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE t.is_sidechain = 0 AND t.provisional = 0 AND t.ts >= ? AND t.ts < ?
       ORDER BY t.session_id, t.ts, t.message_id`,
    )
    .all(fromIso, toIso) as Row[];
  const bySession = new Map<string, Row[]>();
  for (const r of rows) {
    const a = bySession.get(r.session_id);
    if (a) a.push(r);
    else bySession.set(r.session_id, [r]);
  }
  const qualifying = [...bySession.entries()]
    .filter(
      ([, rs]) =>
        rs.length > TURN_MIN && rs.reduce((s, r) => s + r.context_tokens, 0) / rs.length > AVG_MIN,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  if (qualifying.length < MIN_SESSIONS)
    return empty(`D2: ${qualifying.length} qualifying session(s), need ${MIN_SESSIONS}`);

  // Base prefix: median first settled main-thread turn context over sessions that started in the window.
  const firsts = db
    .prepare(
      `SELECT context_tokens FROM (
         SELECT t.session_id, t.ts, t.context_tokens,
                ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.ts, t.message_id) AS rn
         FROM turns t WHERE t.is_sidechain = 0 AND t.provisional = 0)
       WHERE rn = 1 AND ts >= ? AND ts < ? ORDER BY context_tokens`,
    )
    .all(fromIso, toIso) as { context_tokens: number }[];
  let base = 0;
  if (firsts.length > 0) {
    const m = firsts.length >> 1;
    base =
      firsts.length % 2 === 1
        ? (firsts[m] as { context_tokens: number }).context_tokens
        : Math.round(
            ((firsts[m - 1] as { context_tokens: number }).context_tokens +
              (firsts[m] as { context_tokens: number }).context_tokens) /
              2,
          );
  }

  const commitStmt = db.prepare(
    "SELECT ts FROM tool_events WHERE session_id = ? AND commit_sha IS NOT NULL AND ts >= ? AND ts < ? ORDER BY rowid",
  );

  let splitCount = 0;
  let contextTotal = 0;
  let sumAvoided = 0;
  let readSpend = 0;
  let avoidedValue = 0;
  let wNum = 0;
  let wDen = 0;
  let firstWritePrice = 0;
  const avoided = new Map<string, number>(); // message_id -> avoided tokens
  const all: Row[] = [];

  for (const [sid, rs] of qualifying) {
    const n = rs.length;
    const c = Math.min(CALLS_PER_SPLIT, Math.max(1, n - 1));
    const parts = Math.floor((n - 1) / c) + 1;
    splitCount += Math.floor((n - 1) / c);
    const bounds: number[] = [];
    for (const e of commitStmt.all(sid, fromIso, toIso) as { ts: string }[]) {
      const j = rs.findIndex((r) => r.ts > e.ts);
      if (j > 0) bounds.push(j);
    }
    const reach = Math.floor(n / parts / 4);
    const starts: number[] = [];
    for (let k = 1; k < parts; k++) {
      const even = Math.ceil((k * n) / parts);
      const prev = k === 1 ? 0 : (starts[k - 2] as number);
      let best: number | null = null;
      for (const j of bounds) {
        if (j <= prev || j >= n || Math.abs(j - even) > reach) continue;
        if (best === null || Math.abs(j - even) < Math.abs(best - even)) best = j;
      }
      starts.push(best ?? even);
    }
    let part = 0;
    let atSplit = 0;
    rs.forEach((r, i) => {
      if (part < starts.length && i >= (starts[part] as number)) {
        part++;
        atSplit = (rs[i - 1] as Row).context_tokens;
      }
      const av =
        part > 0 ? Math.min(r.context_tokens, Math.max(0, atSplit - base - SUMMARY_TOKENS)) : 0;
      avoided.set(r.message_id, av);
      sumAvoided += av;
      avoidedValue += av * px(r, 2);
      contextTotal += r.context_tokens;
      readSpend += r.cache_read_tokens * px(r, 2);
      wNum += (r.cw5 + r.cwo) * px(r, 3) + r.cw1 * px(r, 4);
      wDen += r.cw5 + r.cw1 + r.cwo;
      all.push(r);
    });
    if (firstWritePrice === 0) firstWritePrice = px(rs[0] as Row, 3);
  }

  const reduction = Number((sumAvoided / contextTotal).toFixed(4));
  const writePrice = wDen > 0 ? wNum / wDen : firstWritePrice;
  const rebuild = splitCount * (base + SUMMARY_TOKENS) * writePrice;
  const savings = Math.max(0, Math.round(readSpend * reduction) - Math.round(rebuild));

  let spend = 0;
  const ids = (
    db
      .prepare("SELECT message_id FROM turns WHERE provisional = 0 AND ts >= ? AND ts < ?")
      .all(fromIso, toIso) as { message_id: string }[]
  ).map((r) => r.message_id);
  for (const v of priceTurns(db, ids).values()) spend += v;

  const note = (s: string) => `D2: ${qualifying.length} qualifying sessions; ${s}`;
  if (savings <= 0) return empty(note("net saving 0, no claims"));
  if (spend > 0 && (savings / spend) * 100 < MIN_PCT)
    return empty(note("net saving under 1% of spend"));
  if (avoidedValue <= 0) return empty(note("no avoided value"));

  const fraction = Math.min(1, savings / avoidedValue);
  let value = 0;
  let claimedTokens = 0;
  let claimedTurns = 0;
  const checked: string[] = [];
  for (const r of all) {
    const av = avoided.get(r.message_id) ?? 0;
    if (av <= 0) continue;
    const tokens = Math.min(Math.round(av * fraction), r.cache_read_tokens);
    if (tokens <= 0) continue;
    value += tokens * px(r, 2);
    claimedTokens += tokens;
    claimedTurns++;
    checked.push(r.message_id);
  }
  const headline = Math.round(value);

  const finding: OracleFinding = {
    scope: { workspace_id: null, key: KEY },
    quantities: [
      { name: "qualifying_sessions", unit: "sessions", value: qualifying.length },
      { name: "split_count", unit: "count", value: splitCount },
      { name: "avoided_tokens", unit: "tokens", value: sumAvoided },
      { name: "claimed_tokens", unit: "tokens", value: claimedTokens },
      { name: "claimed_turns", unit: "turns", value: claimedTurns },
    ],
    measured_u: headline,
    assumptions: [
      {
        name: "D2_CALLS_PER_SPLIT",
        value: CALLS_PER_SPLIT,
        source: "dh-contracts.md D2 card (ASSUMED, range 75 to 300): split cadence",
      },
      {
        name: "D2_SUMMARY_TOKENS",
        value: SUMMARY_TOKENS,
        source:
          "dh-contracts.md D2 card (ASSUMED, range 1000 to 10000): summary re-written at a split",
      },
      {
        name: "D2_NO_COMPETING_CLAIMS",
        value: 1,
        source:
          "dh-contracts.md D2 card, Headline assumptions: D1, D10, A1, A2, D7, D6 sit above D2; alone vs full ledger within +/-3 percent",
      },
      {
        name: "D2_FRACTION_MEASURED",
        value: Number(fraction.toFixed(6)),
        source:
          "dh-contracts.md D2 card: no 0.5 factor; fraction = savings / avoided value, measured in window",
      },
      {
        name: "D2_BASE_PREFIX_ALL_FOUR_COLUMNS",
        value: base,
        source:
          "dh-contracts.md D2 card, CARD-VS-CODE: base = median first-turn input + cache_read + all cache-write columns, machine-wide",
      },
      {
        name: "D2_COMMIT_BOUNDARIES_MOVE_SPLITS",
        value: 1,
        source:
          "dh-contracts.md D2 card, CARD-VS-CODE: tool_events.commit_sha moves split starts within reach",
      },
      {
        name: "D2_NO_LIST_PRICE_FALLBACK",
        value: 1,
        source:
          "oracle choice: card names a list-price fallback for the net saving but its model prices are not on the card; unpriced turns count 0",
      },
      {
        name: "D2_CACHE_CAP_MAY_BIND",
        value: 1,
        source:
          "dh-contracts.md D2 card: avoided is a context quantity, the cell is cache_read_tokens_i, so a cap can bind",
      },
    ],
    modeled_u: headline,
    count: qualifying.length,
  };
  return {
    findings: [finding],
    turns_checked: checked,
    note: note(`net headline ${headline} u/wk, ${splitCount} splits, no competing claims assumed`),
  };
};
