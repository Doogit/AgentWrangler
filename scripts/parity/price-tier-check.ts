/**
 * PRICE-O55-F1 — independent oracle for "the rec lane prices each turn at its own tier".
 * Contract: docs/plans/2026-10-01-price-tier-fix-spec.md, "Invariants" I1-I5.
 *
 * Written without reading the implementation. The price table below is this file's own, from
 * https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-01). It does not import
 * src/ingest/pricing.ts. The only src/ imports are the D4 detector, its context builder and the
 * migrator, loaded lazily to run the I3 fixture (the subject under test).
 *
 *   npx tsx scripts/parity/price-tier-check.ts --db <prepared copy> --views <dir> --as-of <iso>
 *       [--min-window-end <iso>] [--opus-swapped-views <dir>]       I1, I2, I3
 *   npx tsx scripts/parity/price-tier-check.ts --baseline <views> --baseline-db <db>
 *       --candidate <views> --candidate-db <db>                      I4, I5
 *   npx tsx scripts/parity/price-tier-check.ts --self-check
 *
 * Modes may be combined. Exit 0 = all gated checks passed; 1 = a check failed; 2 = bad flags/inputs.
 * DBs are opened read-only. `--views` is a directory written by l9-dump-views.ts.
 *
 * What each check recomputes (all from SQL over raw `turns`, price from the table below):
 *   B2  rank = 0.5 x sum over qualifying pairs of prev.cache_read x (write5m - read), tier of the
 *       pair's turns (prev or curr: both are accepted when they differ, see OPEN QUESTIONS).
 *   C5  rank = CONSERVATIVE_FLOOR_CEU x input price of the session's error-owner turns (exact when
 *       they share one price, else bounded by min/max: the per-error CEU split is not in the card).
 *   D7-XREAD rank = bytes x (reads-paths)/reads / 2.7 x blended cache-read price of the workspace's
 *       in-window turns (same turn set as the savings path, own-tier prices).
 *   D1  rank = delta x turns x 0.5 x blended cache-read price of the eligible turns (when they read
 *       nothing, the price must be one of the eligible turns' own tiers, never a fixed Opus one).
 *   D4  rank = 0.5 x sum over lookup-subagent turns of tokens x (own tier price - sonnet-5 price),
 *       all five components. Fires iff the gates pass and that differential > 0.
 * OPEN QUESTIONS (spec silent): see docs in the report written next to this file's commit.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type Db = Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: dump files are untrusted JSON; every read below is checked before use
type Json = any;

// ── Own price table (USD per MTok = µUSD per token) ───────────────────────────

/** [input, output, cache read, cache write 5m, cache write 1h]. */
export type Prices = readonly [number, number, number, number, number];
export type PriceTable = Readonly<Record<string, Prices>>;

/** Source: platform.claude.com/docs/en/about-claude/pricing, "Model pricing" table, read 2026-10-01. */
export const OWN_PRICES: PriceTable = {
  "fable-5-1": [10, 50, 0.25, 12.5, 20],
  "fable-5": [10, 50, 1, 12.5, 20],
  "opus-5-5": [4, 20, 0.2, 5, 8],
  // Opus 4.5 / 4.6 / 4.7 / 4.8 / 5 all list at $5 / $25, write 6.25 / 10, read 0.50.
  opus: [5, 25, 0.5, 6.25, 10],
  // Sonnet 5 and 5.5 list at $2 / $10.
  "sonnet-5": [2, 10, 0.2, 2.5, 4],
  // Sonnet 4 / 4.5 / 4.6 list at $3 / $15.
  "sonnet-4": [3, 15, 0.3, 3.75, 6],
  // Haiku 4.5 (the seed's `claude-haiku-4` has no page row of its own: priced as 4.5).
  haiku: [1, 5, 0.1, 1.25, 2],
};

/** Model id -> this file's tier name, or null for an unknown model. */
export function tierOf(model: string | null | undefined): string | null {
  const m = (model ?? "").toLowerCase();
  if (m.includes("fable")) return m.includes("fable-5-1") ? "fable-5-1" : "fable-5";
  if (m.includes("opus")) return m.includes("opus-5-5") ? "opus-5-5" : "opus";
  if (m.includes("sonnet")) return m.includes("sonnet-5") ? "sonnet-5" : "sonnet-4";
  if (m.includes("haiku")) return "haiku";
  return null;
}

/** I2 probe: the opus row scaled x1.4. Only figures with opus-tier source turns may move. */
export const SWAPPED_OPUS: PriceTable = { ...OWN_PRICES, opus: [7, 35, 0.7, 8.75, 14] };

const IN = 0;
const OUT = 1;
const READ = 2;
const W5 = 3;
const W1 = 4;

// ── Non-price constants of the formulas (restated from the detector docs) ─────

const DAY_MS = 86_400_000;
const AV_HALF = 0.5; // B1/D1/D4 avoidance fractions
const BYTES_PER_TOKEN = 2.7; // D7-XREAD estimator default
const B2_GAP_MS = 60 * 60 * 1000;
const D4_MIN_TURNS = 5;
const D4_MIN_FRACTION = 0.4;
const D4_MIN_CONTEXT = 50_000;
const D4_MAX_OUTPUT = 500;
const AFFECTED = new Set(["D4", "B2", "C5", "D7", "D1"]);
const LISTS = [
  "active",
  "limit_warnings",
  "adopted",
  "dismissed",
  "history",
  "below_floor",
] as const;
const iso = (ms: number) => new Date(ms).toISOString();

/** Rounded-integer figure vs an exact value: half a unit plus float noise. */
const slack = (x: number) => 0.5 + 1e-6 + 1e-9 * Math.abs(x);
const inRange = (actual: number, lo: number, hi: number) =>
  actual >= lo - slack(lo) && actual <= hi + slack(hi);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const unwrap = (j: Json): Json =>
  j && typeof j === "object" && "data" in j && j.data ? j.data : j;

// ── Check bookkeeping ─────────────────────────────────────────────────────────

class Check {
  pass = 0;
  fail = 0;
  rows: Array<Record<string, unknown>> = [];
  byWhat = new Map<string, number>();
  ok(cond: boolean, what: string, detail: Record<string, unknown> = {}) {
    if (cond) {
      this.pass++;
      return;
    }
    this.fail++;
    this.byWhat.set(what, (this.byWhat.get(what) ?? 0) + 1);
    if (this.rows.length < 8) this.rows.push({ what, ...detail });
  }
}
const CHECK_IDS = ["I1", "I2", "I3", "I4", "I5"] as const;
type CheckId = (typeof CHECK_IDS)[number];
const newChecks = () =>
  Object.fromEntries(CHECK_IDS.map((id) => [id, new Check()])) as Record<CheckId, Check>;
const summarize = (checks: Record<CheckId, Check>, ids: readonly CheckId[]) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      {
        pass: checks[id].pass,
        fail: checks[id].fail,
        by_what: Object.fromEntries(checks[id].byWhat),
        first_failures: checks[id].rows,
      },
    ]),
  );

// ── Cards ─────────────────────────────────────────────────────────────────────

export interface Views {
  cards?: Json;
}

interface Card {
  list: string;
  recId: string;
  det: string;
  ws: string | null;
  model: string;
  rank: number | null;
  win: { from: string; to: string } | null;
  c: Json;
}

function collectCards(v: Views): Card[] {
  const d = unwrap(v.cards) ?? {};
  const out: Card[] = [];
  for (const list of LISTS)
    for (const c of Array.isArray(d[list]) ? d[list] : []) {
      const mf = c.modeled_formula ?? {};
      const w = mf.inputs?.window ?? c.trigger?.window ?? null;
      const rank = c.estimate?.rank_value_u_per_wk ?? mf.estimate?.rank_value_u_per_wk ?? null;
      out.push({
        list,
        recId: String(c.rec_id),
        det: String(c.detector_id),
        ws: c.scope_workspace_id ?? null,
        model: String(mf.model ?? mf.formula_id ?? ""),
        rank: isNum(rank) ? rank : null,
        win: w && typeof w.from === "string" && typeof w.to === "string" ? w : null,
        c,
      });
    }
  return out;
}

/** An input recorded on the card, wherever the card builder put it. */
const pick = (c: Json, k: string): Json =>
  c.modeled_formula?.inputs?.[k] ?? c.evidence?.[k] ?? c.evidence?.facts?.[k];

// ── Expected figures ──────────────────────────────────────────────────────────

interface Exp {
  lo: number;
  hi: number;
  /** Own-tier names of the turns the figure's tokens came from (I2 and unknown-model checks). */
  tiers: Set<string>;
  unknown: number;
  note?: string;
}

const priceVec = (t: PriceTable, model: string | null): Prices | null => {
  const k = tierOf(model);
  return k === null ? null : (t[k] ?? null);
};

/** B2: qualifying main-thread pairs of the card's workspace and window. */
function expB2(db: Db, t: PriceTable, card: Card, cache: Map<string, Json[]>): Exp {
  const to = card.win?.to ?? "";
  let rows = cache.get(to);
  if (rows === undefined) {
    rows = db
      .prepare(
        `SELECT session_id, workspace_id, ts, cache_read_tokens AS cr, model FROM turns
          WHERE ts < ? AND is_sidechain = 0 AND provisional = 0
          ORDER BY session_id ASC, ts ASC, message_id ASC`,
      )
      .all(to) as Json[];
    cache.set(to, rows);
  }
  const out: Exp = { lo: 0, hi: 0, tiers: new Set(), unknown: 0 };
  let prev: Json;
  for (const cur of rows) {
    if (
      prev !== undefined &&
      prev.session_id === cur.session_id &&
      cur.ts >= (card.win?.from ?? "") &&
      cur.workspace_id === card.ws &&
      prev.cr > 20_000 &&
      cur.cr >= 0 &&
      cur.cr * 10 < prev.cr &&
      new Date(cur.ts).getTime() - new Date(prev.ts).getTime() > B2_GAP_MS
    ) {
      const per = [prev.model, cur.model].map((m) => {
        const p = priceVec(t, m);
        if (p === null) {
          out.unknown++;
          return 0;
        }
        out.tiers.add(tierOf(m) ?? "");
        return prev.cr * (p[W5] - p[READ]) * AV_HALF;
      });
      out.lo += Math.min(...per);
      out.hi += Math.max(...per);
    }
    prev = cur;
  }
  return out;
}

/** C5: input price x conservative floor CEU, over the session's error-owner turns. */
function expC5(db: Db, t: PriceTable, card: Card): Exp {
  const ceu =
    pick(card.c, "metrics")?.CONSERVATIVE_FLOOR_CEU?.value ?? pick(card.c, "ceu")?.value ?? 0;
  const sessions: string[] = pick(card.c, "session_ids") ?? card.c.trigger?.session_ids ?? [];
  const out: Exp = { lo: 0, hi: 0, tiers: new Set(), unknown: 0, note: `ceu=${ceu}` };
  const prices: number[] = [];
  const q = db.prepare(
    `SELECT DISTINCT t.model AS model
       FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
       JOIN sessions s ON s.session_id = e.session_id
      WHERE e.session_id = ? AND e.ts >= ? AND e.ts < ? AND s.state = 'RECONCILED'
        AND m.owner_message_id IS NOT NULL AND t.is_sidechain = 0 AND t.provisional = 0
        AND e.exit_class = 'ERROR' AND e.tool_error_class IS NOT NULL
        AND e.tool_error_classifier_version = 'tool-error-1'`,
  );
  for (const sid of sessions)
    for (const r of q.all(sid, card.win?.from ?? "", card.win?.to ?? "") as Json[]) {
      const p = priceVec(t, r.model);
      if (p === null) out.unknown++;
      else {
        prices.push(p[IN]);
        out.tiers.add(tierOf(r.model) ?? "");
      }
    }
  if (prices.length === 0) {
    out.note = "no error-owner turns recomputed";
    out.lo = out.hi = Number.NaN;
  } else {
    out.lo = ceu * Math.min(...prices);
    out.hi = ceu * Math.max(...prices);
  }
  return out;
}

/** Cache-read tokens and turn count by model over a turn set. */
function readsByModel(db: Db, where: string, args: unknown[]): Json[] {
  return db
    .prepare(
      `SELECT model, COUNT(*) AS n, COALESCE(SUM(cache_read_tokens), 0) AS cr
         FROM turns t WHERE ${where} GROUP BY model`,
    )
    .all(...args) as Json[];
}

/** Blended read price over a model->tokens breakdown, with the tiers that carry tokens. */
function blend(t: PriceTable, rows: Json[]) {
  let spend = 0;
  let tokens = 0;
  let unknown = 0;
  const tiers = new Set<string>();
  const allPrices: number[] = [];
  for (const r of rows) {
    const p = priceVec(t, r.model);
    if (p === null) {
      if (r.cr > 0) unknown++;
      continue;
    }
    allPrices.push(p[READ]);
    if (r.cr > 0) tiers.add(tierOf(r.model) ?? "");
    spend += r.cr * p[READ];
    tokens += r.cr;
  }
  return { price: tokens > 0 ? spend / tokens : 0, tokens, tiers, unknown, allPrices };
}

/** D7-XREAD: bytes x redundancy fraction / 2.7 x blended own-tier read price of the workspace. */
function expD7x(db: Db, t: PriceTable, card: Card): Exp {
  const bytes = pick(card.c, "total_redundant_result_bytes");
  const reads = pick(card.c, "total_redundant_read_count");
  const paths = pick(card.c, "redundant_path_count");
  const ws = pick(card.c, "workspace_id") ?? card.ws;
  const b = blend(
    t,
    readsByModel(db, "t.workspace_id = ? AND t.ts >= ? AND t.ts < ? AND t.provisional = 0", [
      ws,
      card.win?.from,
      card.win?.to,
    ]),
  );
  const frac = reads > 0 ? (reads - paths) / reads : 0;
  const v = ((bytes * frac) / BYTES_PER_TOKEN) * b.price;
  return { lo: v, hi: v, tiers: b.tiers, unknown: b.unknown, note: `blended=${b.price}` };
}

const D1_ELIGIBLE = {
  MEMORY:
    "(t.is_sidechain = 0 OR EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type = 'fork'))",
  CLAUDE_MD:
    "(t.is_sidechain = 0 OR NOT EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.agent_id = t.agent_id AND sm.agent_type IN ('Explore', 'Plan')))",
} as const;

/** D1: delta x turns x 0.5 x blended own-tier read price (fallback: an own tier, never fixed Opus). */
function expD1(db: Db, t: PriceTable, card: Card): Exp & { turns: number } {
  const comp = String(pick(card.c, "component"));
  const elig = D1_ELIGIBLE[comp as keyof typeof D1_ELIGIBLE];
  const delta = pick(card.c, "delta_context_tokens");
  const global = card.ws === null;
  const rows = readsByModel(
    db,
    `${global ? "t.workspace_id != ?" : "t.workspace_id = ?"} AND t.ts >= ? AND t.ts < ?
      AND t.provisional = 0 AND ${elig ?? "1=0"}`,
    [global ? "__global__" : card.ws, card.win?.from, card.win?.to],
  );
  const turnsMine = rows.reduce((s, r) => s + r.n, 0);
  const turns = pick(card.c, "turns_per_week");
  const b = blend(t, rows);
  if (b.tokens > 0) {
    const v = delta * turns * Number(b.price.toFixed(6)) * AV_HALF;
    return { lo: v, hi: v, tiers: b.tiers, unknown: b.unknown, turns: turnsMine };
  }
  // Nothing read: the price is not measurable, so any of the eligible turns' own tiers is fair.
  const tiers = new Set(rows.map((r) => tierOf(r.model) ?? "").filter((x) => x !== ""));
  const lo = delta * turns * Math.min(...b.allPrices) * AV_HALF;
  const hi = delta * turns * Math.max(...b.allPrices) * AV_HALF;
  return { lo, hi, tiers, unknown: 0, turns: turnsMine, note: "fallback: no cache reads in scope" };
}

interface D4Calc {
  total: number;
  mismatch: number;
  fraction: number;
  gates: boolean;
  diff: number;
  rank: number;
  fires: boolean;
  tiers: Set<string>;
  unknown: number;
}

/** D4 for one workspace and window: lookup subagents, gates, and the all-component differential. */
function d4Calc(db: Db, t: PriceTable, ws: string, from: string, to: string): D4Calc {
  const rows = db
    .prepare(
      `SELECT session_id, model, COALESCE(agent_id, 'session:' || session_id) AS agent_key,
              input_tokens AS i, output_tokens AS o, cache_read_tokens AS r,
              cache_write_5m AS w5, cache_write_1h AS w1, context_tokens AS ctx
         FROM turns
        WHERE workspace_id = ? AND model LIKE '%opus%' AND is_sidechain = 1
          AND ts >= ? AND ts < ? AND provisional = 0`,
    )
    .all(ws, from, to) as Json[];
  const lookup = new Map<string, boolean>();
  for (const r of rows)
    lookup.set(
      r.agent_key,
      (lookup.get(r.agent_key) ?? true) && r.ctx >= D4_MIN_CONTEXT && r.o <= D4_MAX_OUTPUT,
    );
  const tgt = t["sonnet-5"] as Prices;
  let mismatch = 0;
  let diff = 0;
  let unknown = 0;
  const tiers = new Set<string>();
  for (const r of rows) {
    if (lookup.get(r.agent_key) !== true) continue;
    mismatch++;
    const src = priceVec(t, r.model);
    if (src === null) {
      unknown++;
      continue;
    }
    tiers.add(tierOf(r.model) ?? "");
    diff +=
      r.i * (src[IN] - tgt[IN]) +
      r.o * (src[OUT] - tgt[OUT]) +
      r.r * (src[READ] - tgt[READ]) +
      r.w5 * (src[W5] - tgt[W5]) +
      r.w1 * (src[W1] - tgt[W1]);
  }
  const fraction = rows.length > 0 ? mismatch / rows.length : 0;
  const gates = rows.length >= D4_MIN_TURNS && mismatch > 0 && fraction >= D4_MIN_FRACTION;
  return {
    total: rows.length,
    mismatch,
    fraction,
    gates,
    diff,
    rank: Math.round(diff * AV_HALF),
    fires: gates && diff > 0,
    tiers,
    unknown,
  };
}

// ── I3: D4 on a fixture with only Opus 5.5 lookup turns ──────────────────────

const I3_TURNS = 5;
const I3_TURN = { i: 10, o: 100, r: 1_000_000 };
/** Hand derivation: read diff is 0.20 - 0.20 = 0; per turn 10 x (4-2) + 100 x (20-10) = 1020. */
export const I3_EXPECTED = Math.round(0.5 * I3_TURNS * (I3_TURN.i * 2 + I3_TURN.o * 10));

export type I3Result = { rank: number } | { error: string };

/** Runs the real D4 detector on the Opus-5.5-only fixture (the subject under test). */
async function runD4Fixture(): Promise<I3Result> {
  try {
    const { runMigrations } = await import("../../src/db/migrate.js");
    const { d4Detector } = await import("../../src/detector/detectors/d4_model_mismatch.js");
    const { buildContext } = await import("../../src/detector/engine.js");
    const db = new Database(":memory:");
    try {
      runMigrations(db as never);
      const ts = "2026-09-28T00:00:00.000Z";
      const snap = db.prepare(
        `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
         VALUES (?, ?, ?, ?, ?)`,
      );
      snap.run(
        "i3-o55",
        "opus-5-5",
        JSON.stringify(OWN_PRICES["opus-5-5"]),
        ts,
        "2026-12-01T00:00:00.000Z",
      );
      snap.run(
        "i3-s5",
        "sonnet-5",
        JSON.stringify(OWN_PRICES["sonnet-5"]),
        ts,
        "2026-12-01T00:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('i3', 'i3', ?)",
      ).run(ts);
      db.prepare(
        `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
           state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES ('i3-s', 'i3', '/fake/i3.jsonl', ?, ?, 'RECONCILED', 5, 0, '[]')`,
      ).run(ts, ts);
      const ins = db.prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
           cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
           provisional, parser_version, agent_id)
         VALUES (?, 'i3-s', 'i3', ?, 'claude-opus-5-5', 1, ?, ?, ?, 0, 0, 0, NULL, 'i3-o55', 0,
                 'LIST_EQUIV', 0, 'test-v1', 'lookup')`,
      );
      for (let i = 0; i < I3_TURNS; i++) ins.run(`i3-m${i}`, ts, I3_TURN.i, I3_TURN.o, I3_TURN.r);
      const out = d4Detector.evaluate(
        db as never,
        buildContext(new Date("2026-10-01T00:00:00.000Z")),
      );
      const est = (out.fired[0] as Json | undefined)?.modeled_formula_json?.estimate;
      if (!est || !isNum(est.rank_value_u_per_wk))
        return { error: `D4 did not fire on the fixture (${out.status}: ${out.note ?? ""})` };
      return { rank: est.rank_value_u_per_wk };
    } finally {
      db.close();
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── verify: I1, I2, I3 on one prepared copy ──────────────────────────────────

export interface VerifyOpts {
  asOf: string;
  /** Cards from the same candidate run with the opus tier row swapped (I2, optional). */
  swapped?: Views;
  /**
   * Cards whose window ends before this are stale history (stored by an older pass, never re-priced)
   * and are skipped. Default: 1 day before the newest card window end, capped at as-of.
   */
  minWindowEnd?: string;
  i3?: I3Result;
  table?: PriceTable;
}

/** The affected card kind this card is checked as, or null (D7's loop card is cost_equiv-based). */
function kindOf(card: Card): "B2" | "C5" | "D7-XREAD" | "D1" | "D4" | null {
  if (card.model.startsWith("V2_B2")) return "B2";
  if (card.model.startsWith("V2_C5")) return "C5";
  if (card.model.startsWith("D7_CROSS_SESSION")) return "D7-XREAD";
  if (card.model.startsWith("D1_ALWAYS")) return "D1";
  return card.det === "D4" ? "D4" : null;
}

export function verify(db: Db, views: Views, opts: VerifyOpts) {
  const t = opts.table ?? OWN_PRICES;
  const asOfMs = new Date(opts.asOf).getTime();
  const checks = newChecks();
  const cards = collectCards(views);
  const newestEnd = Math.max(
    ...cards.flatMap((c) =>
      c.win === null || kindOf(c) === null ? [] : [new Date(c.win.to).getTime()],
    ),
    0,
  );
  const minEnd = opts.minWindowEnd ?? iso(Math.min(asOfMs, newestEnd) - DAY_MS);
  const swapped = new Map(collectCards(opts.swapped ?? {}).map((c) => [c.recId, c.rank]));
  const b2cache = new Map<string, Json[]>();
  const info: Record<string, unknown> = {};
  const stat = (k: string, f: string) => {
    const s = (info[k] as Record<string, number> | undefined) ?? {
      checked: 0,
      skipped_stale: 0,
      skipped_nowindow: 0,
    };
    info[k] = s;
    s[f] = (s[f] ?? 0) + 1;
  };

  for (const card of cards) {
    const kind = kindOf(card);
    if (kind === null) continue;
    if (card.win === null) {
      stat(kind, "skipped_nowindow");
      continue;
    }
    if (card.win.to < minEnd) {
      stat(kind, "skipped_stale");
      continue;
    }
    stat(kind, "checked");
    const at = { kind, rec_id: card.recId, list: card.list, actual: card.rank };
    const calc = (table: PriceTable): Exp => {
      switch (kind) {
        case "B2":
          return expB2(db, table, card, b2cache);
        case "C5":
          return expC5(db, table, card);
        case "D7-XREAD":
          return expD7x(db, table, card);
        case "D1":
          return expD1(db, table, card);
        default: {
          const d = d4Calc(db, table, card.ws ?? "", card.win?.from ?? "", card.win?.to ?? "");
          return { lo: d.rank, hi: d.rank, tiers: d.tiers, unknown: d.unknown };
        }
      }
    };
    const e = calc(t);
    checks.I1.ok(e.unknown === 0, `${kind}:unknown-model-in-scope`, { ...at, unknown: e.unknown });
    if (kind === "D4") {
      const d = d4Calc(db, t, card.ws ?? "", card.win.from, card.win.to);
      checks.I1.ok(d.fires, "D4:card-but-recomputed-saving-is-not-positive", {
        ...at,
        diff: d.diff,
        gates: d.gates,
      });
    }
    if (kind === "D1") {
      const d = e as Exp & { turns: number };
      checks.I1.ok(d.turns === pick(card.c, "turns_per_week"), "D1:turns-mismatch", {
        ...at,
        mine: d.turns,
        card: pick(card.c, "turns_per_week"),
      });
    }
    if (card.rank === null || !Number.isFinite(e.lo)) {
      checks.I1.ok(false, `${kind}:no-figure-or-no-source-turns`, { ...at, note: e.note });
    } else {
      checks.I1.ok(inRange(card.rank, e.lo, e.hi), `${kind}:figure-off-own-tier`, {
        ...at,
        expected_lo: e.lo,
        expected_hi: e.hi,
        tiers: [...e.tiers],
        note: e.note,
      });
    }

    // I2 (a): my own recomputation must not depend on the opus row unless an opus-tier turn is in scope.
    const opusSourced = e.tiers.has("opus");
    const e2 = calc(SWAPPED_OPUS);
    const moved =
      Number.isFinite(e.lo) &&
      (Math.abs(e2.lo - e.lo) > slack(e.lo) || Math.abs(e2.hi - e.hi) > slack(e.hi));
    checks.I2.ok(opusSourced || !moved, `${kind}:oracle-moves-without-opus-source`, {
      ...at,
      tiers: [...e.tiers],
    });
    // I2 (b): the candidate run with the opus row swapped may move only opus-sourced cards.
    if (opts.swapped !== undefined) {
      const s = swapped.get(card.recId);
      checks.I2.ok(
        s !== undefined || card.list !== "active",
        `${kind}:card-missing-in-swapped-run`,
        at,
      );
      if (s !== undefined && !opusSourced)
        checks.I2.ok(s === card.rank, `${kind}:non-opus-figure-moved-with-opus-row`, {
          ...at,
          swapped: s,
          tiers: [...e.tiers],
        });
    }
  }

  // D4 must exist wherever the recomputed differential at the sonnet-5 target is positive.
  const d = unwrap(views.cards) ?? {};
  const status = (Array.isArray(d.detectors) ? d.detectors : []).find(
    (x: Json) => x.detector_id === "D4",
  )?.status;
  const from = iso(asOfMs - 7 * DAY_MS);
  const wss = db
    .prepare(
      "SELECT DISTINCT workspace_id AS w FROM turns WHERE ts >= ? AND ts < ? AND model LIKE '%opus%' AND provisional = 0",
    )
    .all(from, opts.asOf) as Array<{ w: string }>;
  const firing = wss.filter((x) => d4Calc(db, t, x.w, from, opts.asOf).fires).map((x) => x.w);
  const hasD4Card = (w: string) => cards.some((c) => c.det === "D4" && c.ws === w);
  for (const w of firing)
    checks.I1.ok(status === "ACTIVE" || hasD4Card(w), "D4:should-fire-at-sonnet-5-target", {
      workspace: w,
      detector_status: status,
    });
  if (firing.length === 0)
    checks.I1.ok(status !== "ACTIVE", "D4:fired-but-oracle-says-no-saving", { status });
  info.D4 = {
    ...(info.D4 as object | undefined),
    detector_status: status ?? null,
    oracle_firing_workspaces: firing,
    verdict: firing.length === 0 && status !== "ACTIVE" ? "not fired" : "fires",
  };

  // I3
  info.I3 = opts.i3 === undefined ? "not run" : { ...opts.i3, expected: I3_EXPECTED };
  if (opts.i3 !== undefined && "error" in opts.i3)
    checks.I3.ok(false, "d4-fixture-run-error", { error: opts.i3.error });
  else if (opts.i3 !== undefined)
    checks.I3.ok(Math.abs(opts.i3.rank - I3_EXPECTED) <= 1, "d4-opus-5-5-only-fixture-rank", {
      got: opts.i3.rank,
      expected: I3_EXPECTED,
      note: "read priced 0.20 vs 0.20; 0.50 or a sonnet-4 target moves this",
    });

  const ids: CheckId[] = ["I1", "I2", "I3"];
  const failed = ids.filter((id) => checks[id].fail > 0);
  return {
    ok: failed.length === 0,
    failed_checks: failed,
    as_of: opts.asOf,
    min_window_end: minEnd,
    checks: summarize(checks, ids),
    info,
  };
}

// ── compare: I4, I5 ───────────────────────────────────────────────────────────

export interface Side {
  db: Db;
  views: Views;
}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

function cardMap(v: Views): Map<string, { list: string; json: string }> {
  const out = new Map<string, { list: string; json: string }>();
  for (const c of collectCards(v))
    if (!AFFECTED.has(c.det)) out.set(c.recId, { list: c.list, json: canon(c.c) });
  return out;
}

export function compare(base: Side, cand: Side) {
  const checks = newChecks();
  // I4: cards of detectors outside {D4,B2,C5,D7,D1} are identical (parsed, not bytes; order ignored).
  const a = cardMap(base.views);
  const b = cardMap(cand.views);
  for (const [id, x] of a) {
    const y = b.get(id);
    checks.I4.ok(y !== undefined, "card-missing-in-candidate", { rec_id: id });
    if (y === undefined) continue;
    checks.I4.ok(x.list === y.list, "card-moved-list", { rec_id: id, from: x.list, to: y.list });
    checks.I4.ok(x.json === y.json, "card-differs", { rec_id: id });
  }
  for (const id of b.keys()) checks.I4.ok(a.has(id), "card-added-in-candidate", { rec_id: id });
  const det = (v: Views) =>
    canon(
      (unwrap(v.cards)?.detectors ?? []).filter((x: Json) => !AFFECTED.has(String(x.detector_id))),
    );
  checks.I4.ok(det(base.views) === det(cand.views), "unaffected-detector-status-differs");

  // I5: ledger_daily (all lanes) and its companions, per-turn spend, card spend allocations.
  const surf = (s: Side): Record<string, string> => {
    const q = (sql: string) => canon(s.db.prepare(sql).all());
    const out: Record<string, string> = {
      ledger_daily: q(
        "SELECT * FROM ledger_daily ORDER BY block_start, day, lane, detector_id, rec_id, component",
      ),
      ledger_daily_top: q(
        "SELECT * FROM ledger_daily_top ORDER BY block_start, day, lane, detector_id, session_id, message_id",
      ),
      ledger_daily_sessions: q(
        "SELECT * FROM ledger_daily_sessions ORDER BY block_start, day, lane, detector_id, session_id",
      ),
      turn_spend: q(
        "SELECT pricing_snapshot_id AS snap, COUNT(*) AS n, SUM(cost_equiv_u) AS u FROM turns GROUP BY pricing_snapshot_id ORDER BY 1",
      ),
    };
    out.card_allocations = canon(
      collectCards(s.views)
        .filter((c) => !AFFECTED.has(c.det))
        .map((c) => [c.recId, c.c.allocated_u_per_wk ?? null])
        .sort((p, q2) => String(p[0]).localeCompare(String(q2[0]))),
    );
    return out;
  };
  const sa = surf(base);
  const sb = surf(cand);
  for (const k of Object.keys(sa)) checks.I5.ok(sa[k] === sb[k], `spend-differs:${k}`, {});
  return {
    ok: checks.I4.fail + checks.I5.fail === 0,
    failed_checks: (["I4", "I5"] as CheckId[]).filter((id) => checks[id].fail > 0),
    checks: summarize(checks, ["I4", "I5"]),
  };
}

// ── Self-check ────────────────────────────────────────────────────────────────

const SELF_AS_OF = "2026-10-01T00:00:00.000Z";
const SELF_WIN = { from: "2026-09-24T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
const T = (s: string) => `2026-${s}:00.000Z`;

interface TurnSpec {
  m: string;
  s: string;
  ws: string;
  ts: string;
  model: string;
  i?: number;
  o?: number;
  r?: number;
  w5?: number;
  w1?: number;
  side?: number;
  agent?: string | null;
}

function selfDb(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE turns (message_id TEXT, session_id TEXT, workspace_id TEXT, ts TEXT, model TEXT,
      is_sidechain INTEGER DEFAULT 0, provisional INTEGER DEFAULT 0, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
      context_tokens INTEGER, agent_id TEXT, pricing_snapshot_id TEXT, cost_equiv_u REAL);
    CREATE TABLE sessions (session_id TEXT, state TEXT);
    CREATE TABLE tool_events (event_id TEXT, session_id TEXT, ts TEXT, exit_class TEXT,
      tool_error_class TEXT, tool_error_classifier_version TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT, owner_message_id TEXT);
    CREATE TABLE subagent_meta (agent_id TEXT, agent_type TEXT);
    CREATE TABLE ledger_daily (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, rec_id TEXT,
      component TEXT, value_u REAL, tokens INTEGER);
    CREATE TABLE ledger_daily_top (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT,
      session_id TEXT, message_id TEXT, ts TEXT, value_u REAL);
    CREATE TABLE ledger_daily_sessions (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT,
      session_id TEXT, value_u REAL);
  `);
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,'p',?)");
  const turn = (x: TurnSpec) => {
    const [i, o, r, w5, w1] = [x.i ?? 0, x.o ?? 0, x.r ?? 0, x.w5 ?? 0, x.w1 ?? 0];
    ins.run(
      x.m,
      x.s,
      x.ws,
      x.ts,
      x.model,
      x.side ?? 0,
      i,
      o,
      r,
      w5,
      w1,
      i + r + w5 + w1,
      x.agent ?? null,
      100,
    );
  };
  const S5 = "claude-sonnet-5-5";
  const O55 = "claude-opus-5-5";
  const O48 = "claude-opus-4-8";
  // B2, workspace wB: sonnet-5 pair (prior 100000) and opus-5-5 pair (prior 200000).
  turn({ m: "b1", s: "sB1", ws: "wB", ts: T("09-25T10:00"), model: S5, r: 100_000 });
  turn({ m: "b2", s: "sB1", ws: "wB", ts: T("09-25T12:00"), model: S5, r: 100 });
  turn({ m: "b3", s: "sB2", ws: "wB", ts: T("09-26T10:00"), model: O55, r: 200_000 });
  turn({ m: "b4", s: "sB2", ws: "wB", ts: T("09-26T12:00"), model: O55, r: 0 });
  // C5, workspace wC: sC1 all sonnet-5 errors; sC2 one opus-5-5 and one sonnet-5 error turn.
  for (const [m, s, model] of [
    ["c1", "sC1", S5],
    ["c2", "sC1", S5],
    ["c3", "sC1", S5],
    ["c4", "sC2", O55],
    ["c5", "sC2", S5],
  ] as const) {
    turn({ m, s, ws: "wC", ts: T("09-27T10:00"), model, i: 10 });
    db.prepare("INSERT INTO tool_events VALUES (?,?,?,'ERROR','x','tool-error-1')").run(
      `e-${m}`,
      s,
      T("09-27T10:00"),
    );
    db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)").run(`e-${m}`, m);
  }
  db.prepare("INSERT INTO sessions VALUES ('sC1','RECONCILED'), ('sC2','RECONCILED')").run();
  // D7-XREAD, workspace wD: reads 600 sonnet-5, 400 opus-5-5, 1000 opus-4.8 -> blended 0.35.
  turn({ m: "d1", s: "sD", ws: "wD", ts: T("09-27T10:00"), model: S5, r: 600 });
  turn({ m: "d2", s: "sD", ws: "wD", ts: T("09-27T11:00"), model: O55, r: 400 });
  turn({ m: "d3", s: "sD", ws: "wD", ts: T("09-27T12:00"), model: O48, r: 1000 });
  // D1, workspace wE: 4 sonnet-5 turns reading 1e6 each; wF: 2 turns reading nothing.
  for (let i = 0; i < 4; i++)
    turn({ m: `f${i}`, s: "sE", ws: "wE", ts: T("09-27T10:00"), model: S5, r: 1_000_000 });
  for (let i = 0; i < 2; i++)
    turn({ m: `g${i}`, s: "sF", ws: "wF", ts: T("09-27T10:00"), model: S5, i: 5 });
  // D4, workspace wG: 6 opus-5-5 lookup turns of one subagent.
  for (let i = 0; i < 6; i++)
    turn({
      m: `h${i}`,
      s: "sG",
      ws: "wG",
      ts: T("09-28T10:00"),
      model: O55,
      i: 100,
      o: 200,
      r: 1_000_000,
      w5: 10_000,
      w1: 5_000,
      side: 1,
      agent: "lk",
    });
  // Ledger rows for I5.
  const l = db.prepare("INSERT INTO ledger_daily VALUES (?,?,?,?,?,?,?,?)");
  l.run("2026-09-24", "2026-09-27", "spend", "D2", "recA", "cacheRead", 900, 900);
  l.run("2026-09-24", "2026-09-27", "reliability", "C7", "", "input", 300, 150);
  return db as unknown as Db;
}

function mkCard(
  det: string,
  model: string,
  ws: string | null,
  rank: number | null,
  inputs: Json = {},
  extra: Json = {},
): Json {
  return {
    rec_id: `rec-${det}-${ws ?? "global"}-${model}`,
    detector_id: det,
    scope_workspace_id: ws,
    allocated_u_per_wk: 10,
    modeled_formula: { model, inputs: { window: SELF_WIN, ...inputs } },
    estimate: { rank_value_u_per_wk: rank },
    trigger: { window: SELF_WIN },
    evidence: {},
    ...extra,
  };
}

/** The correct card set for the fixture, hand-derived (see comments). */
function selfViews(): { cards: Json } {
  const active = [
    // 100000 x (2.5-0.2) x 0.5 + 200000 x (5-0.2) x 0.5 = 115000 + 480000.
    mkCard("B2", "V2_B2_TTL_GAP_MISS", "wB", 595_000),
    // 1000 CEU x sonnet-5 input $2.
    mkCard("C5", "V2_C5_SAME_ERROR_LOOP", "wC", 2000, {
      session_ids: ["sC1"],
      metrics: { CONSERVATIVE_FLOOR_CEU: { value: 1000 } },
    }),
    // 1000 CEU, errors on opus-5-5 ($4) and sonnet-5 ($2): anywhere in [2000, 4000].
    {
      ...mkCard("C5", "V2_C5_SAME_ERROR_LOOP", "wC", 3000, {
        session_ids: ["sC2"],
        metrics: { CONSERVATIVE_FLOOR_CEU: { value: 1000 } },
      }),
      rec_id: "rec-C5-wC-mixed",
    },
    // 2.7e6 x 0.8 / 2.7 = 800000 tokens x blended 0.35.
    mkCard("D7", "D7_CROSS_SESSION_REDUNDANT_READ_V1", "wD", 280_000, {
      total_redundant_result_bytes: 2_700_000,
      total_redundant_read_count: 10,
      redundant_path_count: 2,
      workspace_id: "wD",
    }),
    // 3000 x 4 turns x blended 0.2 x 0.5.
    mkCard("D1", "D1_ALWAYS_LOADED_TRIM_V1", "wE", 1200, {
      component: "CLAUDE_MD",
      delta_context_tokens: 3000,
      turns_per_week: 4,
    }),
    // No cache reads in scope: only the turns' own tier read price (0.20) is fair: 3000 x 2 x 0.2 x 0.5.
    mkCard("D1", "D1_ALWAYS_LOADED_TRIM_V1", "wF", 600, {
      component: "CLAUDE_MD",
      delta_context_tokens: 3000,
      turns_per_week: 2,
    }),
    // 6 turns x (100x2 + 200x10 + 1e6x0 + 10000x2.5 + 5000x4) = 283200, x 0.5.
    mkCard("D4", "D4_MODEL_MISMATCH_V1", "wG", 141_600),
    // Unaffected detector.
    mkCard("A1", "A1_V1", "wB", 777, {}, { allocated_u_per_wk: 55 }),
  ];
  return {
    cards: {
      data: {
        active,
        limit_warnings: [],
        adopted: [],
        dismissed: [],
        history: [],
        below_floor: [],
        detectors: [
          { detector_id: "D4", status: "ACTIVE", note: "1" },
          { detector_id: "A1", status: "ACTIVE", note: "a" },
        ],
      },
      meta: { window: "wall clock" },
    },
  };
}

const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));
const find = (v: { cards: Json }, id: string): Json =>
  v.cards.data.active.find((c: Json) => c.rec_id === id);

interface Mutation {
  name: string;
  fails: CheckId;
  what: string;
  apply: (v: { cards: Json }, s: SelfCtx) => void;
}
interface SelfCtx {
  swapped?: { cards: Json };
  i3?: I3Result;
  db: Db;
}

const R = (det: string, model: string, ws: string) => `rec-${det}-${ws}-${model}`;
const MUTATIONS: Mutation[] = [
  {
    name: "B2 priced at the opus row instead of its own tiers (862500)",
    fails: "I1",
    what: "B2:figure-off-own-tier",
    apply: (v) => {
      find(v, R("B2", "V2_B2_TTL_GAP_MISS", "wB")).estimate.rank_value_u_per_wk = 862_500;
    },
  },
  {
    name: "C5 priced at opus input $5 (5000), session is all sonnet-5",
    fails: "I1",
    what: "C5:figure-off-own-tier",
    apply: (v) => {
      find(v, R("C5", "V2_C5_SAME_ERROR_LOOP", "wC")).estimate.rank_value_u_per_wk = 5000;
    },
  },
  {
    name: "C5 mixed-tier session above the max tier price (5000 > 4000)",
    fails: "I1",
    what: "C5:figure-off-own-tier",
    apply: (v) => {
      find(v, "rec-C5-wC-mixed").estimate.rank_value_u_per_wk = 5000;
    },
  },
  {
    name: "D7-XREAD estimate at opus read $0.50 (400000) instead of blended 0.35",
    fails: "I1",
    what: "D7-XREAD:figure-off-own-tier",
    apply: (v) => {
      find(v, R("D7", "D7_CROSS_SESSION_REDUNDANT_READ_V1", "wD")).estimate.rank_value_u_per_wk =
        400_000;
    },
  },
  {
    name: "D1 priced at opus read $0.50 (3000) although every turn is sonnet-5",
    fails: "I1",
    what: "D1:figure-off-own-tier",
    apply: (v) => {
      find(v, R("D1", "D1_ALWAYS_LOADED_TRIM_V1", "wE")).estimate.rank_value_u_per_wk = 3000;
    },
  },
  {
    name: "D1 no-cache-read fallback at opus read $0.50 (1500)",
    fails: "I1",
    what: "D1:figure-off-own-tier",
    apply: (v) => {
      find(v, R("D1", "D1_ALWAYS_LOADED_TRIM_V1", "wF")).estimate.rank_value_u_per_wk = 1500;
    },
  },
  {
    name: "D4 target still sonnet-4 (3/15/0.3/3.75/6): card figure -229200",
    fails: "I1",
    what: "D4:figure-off-own-tier",
    apply: (v) => {
      const per = 100 * 1 + 200 * 5 + 1_000_000 * -0.1 + 10_000 * 1.25 + 5000 * 2;
      find(v, R("D4", "D4_MODEL_MISMATCH_V1", "wG")).estimate.rank_value_u_per_wk = Math.round(
        6 * per * 0.5,
      );
    },
  },
  {
    name: "D4 opus-5-5 turns priced at the opus row (5/25/0.5/6.25/10) vs sonnet-5",
    fails: "I1",
    what: "D4:figure-off-own-tier",
    apply: (v) => {
      const per = 100 * 3 + 200 * 15 + 1_000_000 * 0.3 + 10_000 * 3.75 + 5000 * 6;
      find(v, R("D4", "D4_MODEL_MISMATCH_V1", "wG")).estimate.rank_value_u_per_wk = Math.round(
        6 * per * 0.5,
      );
    },
  },
  {
    name: "D4 positive differential at sonnet-5 but the card is gone and the detector is INACTIVE",
    fails: "I1",
    what: "D4:should-fire-at-sonnet-5-target",
    apply: (v) => {
      v.cards.data.active = v.cards.data.active.filter((c: Json) => c.detector_id !== "D4");
      v.cards.data.detectors[0].status = "INACTIVE";
    },
  },
  {
    name: "I3 fixture ranks Opus 5.5 read at $0.50 (rank 502550)",
    fails: "I3",
    what: "d4-opus-5-5-only-fixture-rank",
    apply: (_v, s) => {
      s.i3 = {
        rank: Math.round(0.5 * I3_TURNS * (I3_TURN.i * 2 + I3_TURN.o * 10 + I3_TURN.r * 0.2)),
      };
    },
  },
  {
    name: "I3 fixture run crashed",
    fails: "I3",
    what: "d4-fixture-run-error",
    apply: (_v, s) => {
      s.i3 = { error: "boom" };
    },
  },
  {
    name: "I2 opus row swapped and a non-Opus figure moves (C5 sonnet-5 card 2000 -> 5000)",
    fails: "I2",
    what: "C5:non-opus-figure-moved-with-opus-row",
    apply: (_v, s) => {
      const w = clone(selfViews());
      find(w, R("C5", "V2_C5_SAME_ERROR_LOOP", "wC")).estimate.rank_value_u_per_wk = 5000;
      s.swapped = w;
    },
  },
];

function selfCheck(): number {
  let bad = 0;
  const report = (name: string, ok: boolean, detail = "") => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  };
  const okI3: I3Result = { rank: I3_EXPECTED };
  const run = (v: { cards: Json }, s: Partial<SelfCtx> = {}) =>
    verify(selfDb(), v, {
      asOf: SELF_AS_OF,
      i3: s.i3 ?? okI3,
      ...(s.swapped ? { swapped: s.swapped } : {}),
    });

  // A run with the opus row swapped: only D7-XREAD has an opus-tier (4.8) turn in scope, so only it may move.
  const swappedOk = selfViews();
  find(
    swappedOk,
    R("D7", "D7_CROSS_SESSION_REDUNDANT_READ_V1", "wD"),
  ).estimate.rank_value_u_per_wk += 1;
  const clean = run(selfViews(), { swapped: swappedOk });
  report("clean case passes I1/I2/I3", clean.ok, clean.ok ? "" : JSON.stringify(clean.checks));
  report(
    "clean case exercised every check",
    Object.values(clean.checks).every((c) => c.pass > 0),
    Object.values(clean.checks)
      .map((c) => c.pass)
      .join(","),
  );
  const hand = I3_EXPECTED === 2550;
  report("I3 hand-derived rank is 2550", hand, String(I3_EXPECTED));

  const dbA = selfDb();
  const dA = d4Calc(dbA, OWN_PRICES, "wG", SELF_WIN.from, SELF_WIN.to);
  report(
    "D4 recomputation matches the hand figure (141600)",
    dA.rank === 141_600 && dA.fires,
    JSON.stringify({ rank: dA.rank }),
  );

  for (const m of MUTATIONS) {
    const v = selfViews();
    const s: SelfCtx = { db: dbA };
    m.apply(v, s);
    const r = run(v, s);
    const hit = (r.checks[m.fails]?.by_what?.[m.what] ?? 0) > 0;
    report(
      `mutation caught: ${m.name}`,
      r.failed_checks.includes(m.fails) && hit,
      `failed=${JSON.stringify(r.failed_checks)} want=${m.fails}/${m.what}`,
    );
  }

  // I4 / I5
  const base = (): Side => ({ db: selfDb(), views: selfViews() });
  const same = compare(base(), base());
  report(
    "I4/I5 identical sides pass",
    same.ok && Object.values(same.checks).every((c) => c.pass > 0),
  );
  // Affected-detector cards may move freely.
  const moveAffected = base();
  find(
    moveAffected.views as { cards: Json },
    R("B2", "V2_B2_TTL_GAP_MISS", "wB"),
  ).estimate.rank_value_u_per_wk = 1;
  report("I4 ignores a moved affected-detector card", compare(base(), moveAffected).ok);

  const sideMutations: Array<{
    name: string;
    want: CheckId;
    what: string;
    apply: (c: Side) => void;
  }> = [
    {
      name: "I4 unrelated (A1) card figure changed",
      want: "I4",
      what: "card-differs",
      apply: (c) => {
        find(c.views as { cards: Json }, R("A1", "A1_V1", "wB")).estimate.rank_value_u_per_wk = 778;
      },
    },
    {
      name: "I4 unrelated card removed",
      want: "I4",
      what: "card-missing-in-candidate",
      apply: (c) => {
        const d = (c.views as { cards: Json }).cards.data;
        d.active = d.active.filter((x: Json) => x.detector_id !== "A1");
      },
    },
    {
      name: "I5 ledger_daily row changed by 1 µ$",
      want: "I5",
      what: "spend-differs:ledger_daily",
      apply: (c) =>
        void c.db.exec("UPDATE ledger_daily SET value_u = value_u + 1 WHERE lane = 'reliability'"),
    },
    {
      name: "I5 per-turn spend changed",
      want: "I5",
      what: "spend-differs:turn_spend",
      apply: (c) => void c.db.exec("UPDATE turns SET cost_equiv_u = 101 WHERE message_id = 'b1'"),
    },
  ];
  for (const m of sideMutations) {
    const cand = base();
    m.apply(cand);
    const r = compare(base(), cand);
    report(
      `mutation caught: ${m.name}`,
      r.failed_checks.includes(m.want) && (r.checks[m.want]?.by_what?.[m.what] ?? 0) > 0,
      `failed=${JSON.stringify(r.failed_checks)}`,
    );
  }
  // The ratio test for I2 (a): an oracle with a hidden opus fallback would be caught by SWAPPED_OPUS.
  const leaky = [R("C5", "V2_C5_SAME_ERROR_LOOP", "wC")].map((id) => {
    const v = selfViews();
    const card = collectCards(v).find((c) => c.recId === id) as Card;
    const e = expC5(dbA, OWN_PRICES, card);
    const e2 = expC5(dbA, SWAPPED_OPUS, card);
    return e.lo === e2.lo && e.hi === e2.hi;
  });
  report(
    "oracle recomputation is independent of the opus row for a sonnet-5-only card",
    leaky.every(Boolean),
  );

  console.log(bad === 0 ? "SELF-CHECK PASS" : `SELF-CHECK FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: price-tier-check.ts --db <sqlite> --views <dir> --as-of <iso> [--min-window-end <iso>] [--opus-swapped-views <dir>]\n         | --baseline <views dir> --baseline-db <sqlite> --candidate <views dir> --candidate-db <sqlite>\n         | --self-check`,
  );
  process.exit(2);
}

function readViews(dir: string): Views {
  const p = path.join(dir, "cards.json");
  if (!fs.existsSync(p)) usage(`missing views file: ${p}`);
  return { cards: JSON.parse(fs.readFileSync(p, "utf8")) };
}

function openDb(p: string): Db {
  if (!fs.existsSync(p)) usage(`db not found: ${p}`);
  return new Database(p, { readonly: true, fileMustExist: true });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  const valued = new Set([
    "--db",
    "--views",
    "--as-of",
    "--min-window-end",
    "--opus-swapped-views",
    "--baseline",
    "--baseline-db",
    "--candidate",
    "--candidate-db",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--self-check") return selfCheck();
    if (!valued.has(a)) usage(`Unknown flag ${a}`);
    const val = argv[++i];
    if (val === undefined || val.startsWith("--")) usage(`Missing value for ${a}`);
    flags.set(a, val);
  }
  const wantA = flags.has("--db");
  const wantB = flags.has("--baseline") || flags.has("--candidate");
  if (!wantA && !wantB) usage("nothing to check");
  let code = 0;

  if (wantA) {
    const asOf = flags.get("--as-of");
    const viewsDir = flags.get("--views");
    if (!asOf || !Number.isFinite(new Date(asOf).getTime())) usage("--as-of must be an ISO date");
    if (!viewsDir) usage("--views is required with --db");
    const swappedDir = flags.get("--opus-swapped-views");
    const minEnd = flags.get("--min-window-end");
    const db = openDb(flags.get("--db") ?? "");
    try {
      const report = verify(db, readViews(viewsDir), {
        asOf,
        i3: await runD4Fixture(),
        ...(swappedDir ? { swapped: readViews(swappedDir) } : {}),
        ...(minEnd ? { minWindowEnd: minEnd } : {}),
      });
      console.log(JSON.stringify(report, null, 2));
      console.log(report.ok ? "PASS" : `FAIL ${report.failed_checks.join(",")}`);
      if (!report.ok) code = 1;
    } finally {
      db.close();
    }
  }

  if (wantB) {
    for (const f of ["--baseline", "--baseline-db", "--candidate", "--candidate-db"])
      if (!flags.get(f)) usage(`${f} is required for I4/I5`);
    const b = openDb(flags.get("--baseline-db") ?? "");
    const c = openDb(flags.get("--candidate-db") ?? "");
    try {
      const report = compare(
        { db: b, views: readViews(flags.get("--baseline") ?? "") },
        { db: c, views: readViews(flags.get("--candidate") ?? "") },
      );
      console.log(JSON.stringify(report, null, 2));
      console.log(report.ok ? "PASS" : `FAIL ${report.failed_checks.join(",")}`);
      if (!report.ok) code = 1;
    } finally {
      b.close();
      c.close();
    }
  }
  return code;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 2;
    },
  );
}
