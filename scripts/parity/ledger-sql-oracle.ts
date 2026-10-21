/**
 * P3.L L9 — independent SQL oracle for the stored claim ledger (`ledger_daily*`).
 *
 * Proves the design's invariants 1-4 and reports 5 (docs/plans/Archive/2026-09-29-l9-sql-oracle-spec.md) with SQL over the
 * DB plus JSON dumps of what the app shows (`l9-dump-views.ts`). It imports nothing from src/: every
 * rule it relies on is restated below with the file it came from, so a bug in the ledger cannot hide
 * itself. If a restatement drifts from src/, the checks fail; that is the point.
 *
 *   npx tsx scripts/parity/ledger-sql-oracle.ts --db <sqlite> --views <dir> --as-of <iso>
 *     [--window 7|14|30] [--allow-incomplete] [--emit-golden <path>] [--self-check]
 *
 * Exit 0 = every gated check passed; 1 = a check failed (or was skipped without --allow-incomplete);
 * 2 = bad flags or unreadable inputs. The DB is opened read-only.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type Db = Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: dump files are untrusted JSON; every read below is checked before use
type Json = any;

// ── Restatements (no src/ imports) ────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** src/detector/ledger-daily.ts LEDGER_DAILY_BLOCKS: 9 blocks of 7 days cover 30d + its previous 30d. */
const BLOCKS = 9;

/** src/detector/ledger-daily.ts ledgerDailyGrid: block k = [E - 7(k+1) days, E - 7k days). */
function grid(e: number, blocks = BLOCKS): Array<{ start: string; end: string }> {
  return Array.from({ length: blocks }, (_, k) => ({
    start: iso(e - 7 * (k + 1) * DAY_MS),
    end: iso(e - 7 * k * DAY_MS),
  }));
}

/** src/detector/claim-ledger.ts CLAIM_PRODUCERS minus RELIABILITY_LANE_FAMILY_IDS: the spend producers. */
const SPEND_PRODUCERS = new Set(["D1", "D10", "A1", "A2", "D7", "D2", "D8", "B1", "B3", "D4"]);
/** src/detector/claim-ledger.ts RELIABILITY_LANE_FAMILY_IDS. */
const RELIABILITY_PRODUCERS = new Set(["C7", "C3", "C4", "C1", "C2", "C9", "D14", "D11"]);

/** src/query/api/diagnostics-causes.ts CAUSES, section "spend": cause -> detector ids of its keys. */
const SPEND_CAUSES: ReadonlyArray<{ id: string; detectors: readonly string[] }> = [
  { id: "CONTEXT_TOO_LARGE", detectors: ["D2"] },
  { id: "CACHE_REBUILT_MID_SESSION", detectors: ["B1", "B2", "B3", "B4", "D8"] },
  { id: "TOOL_RESULTS_TOO_LARGE", detectors: ["A1", "A2", "D6", "C11"] },
  { id: "ALWAYS_LOADED_TOO_BIG", detectors: ["D1", "D10"] },
  { id: "MODEL_BIGGER_THAN_NEEDED", detectors: ["D4"] },
  { id: "SUBAGENTS_COST_MORE_THAN_RETURN", detectors: ["D12", "D9"] },
  { id: "SAME_FILES_REREAD_ACROSS_SESSIONS", detectors: ["D7"] },
];
/** A cause counts only the detectors that have a spend producer (ledger-daily-provider.ts). */
const producersOf = (detectors: readonly string[]) =>
  detectors.filter((d) => SPEND_PRODUCERS.has(d));

/**
 * src/detector/claim-ledger.ts COMPONENTS / TOKEN_COLUMNS: ledger component -> `turns` token column
 * -> index in `pricing_snapshots.unit_prices_json` ([in, out, cacheRead, cw5m, cw1h], µ$ per token).
 */
const COMPONENTS = [
  { name: "input", column: "input_tokens" },
  { name: "output", column: "output_tokens" },
  { name: "cacheRead", column: "cache_read_tokens" },
  { name: "cw5m", column: "cache_write_5m" },
  { name: "cw1h", column: "cache_write_1h" },
] as const;

const iso = (ms: number) => new Date(ms).toISOString();
/** ts -> UTC day. ledger-daily.ts uses `new Date(ts).toISOString().slice(0, 10)`; SQLite `date(ts)` is the same. */
const dayStr = (ms: number) => iso(ms).slice(0, 10);
const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);
const near = (a: number, b: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b)));
/** An API integer vs an unrounded SQL figure: exact after round(), except a hair from a .5 boundary. */
function roundEq(got: number, x: number): boolean {
  if (got === Math.round(x)) return true;
  const frac = x - Math.floor(x);
  return Math.abs(frac - 0.5) < 1e-6 && Math.abs(got - x) <= 0.5 + 1e-6;
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ── Check bookkeeping ─────────────────────────────────────────────────────────

type Row = { what: string; [key: string]: unknown };
class Check {
  pass = 0;
  fail = 0;
  rows: Row[] = [];
  byWhat = new Map<string, number>();
  ok(cond: boolean, what: string, detail: Record<string, unknown> = {}) {
    if (cond) {
      this.pass++;
      return;
    }
    this.fail++;
    this.byWhat.set(what, (this.byWhat.get(what) ?? 0) + 1);
    if (this.rows.length < 5) this.rows.push({ what, ...detail });
  }
}
const CHECK_IDS = ["1a", "1b", "2", "3", "4", "marks", "lanes"] as const;
type CheckId = (typeof CHECK_IDS)[number];

export interface Views {
  cards: Json;
  diagnostics: Partial<Record<7 | 14 | 30, Json>>;
}
export interface Options {
  asOf: string;
  windows: Array<7 | 14 | 30>;
  allowIncomplete: boolean;
}

// ── SQL figures ───────────────────────────────────────────────────────────────

interface CauseFigure {
  cause_id: string;
  producers: string[];
  total: number; // one SQL SUM, like the provider
  perDay: Map<string, number>;
}

/** Spend-lane cause figures over whole UTC days [E - fromDays, E - toDays), from `ledger_daily` only. */
function causeFigures(db: Db, e: number, fromDays: number, toDays: number): CauseFigure[] {
  const from = dayStr(e - fromDays * DAY_MS);
  const to = dayStr(e - toDays * DAY_MS);
  const starts = JSON.stringify(grid(e).map((b) => b.start));
  const total = db.prepare(
    `SELECT COALESCE(SUM(value_u), 0) AS v FROM ledger_daily
      WHERE lane = 'spend' AND day >= ? AND day < ?
        AND block_start IN (SELECT value FROM json_each(?))
        AND detector_id IN (SELECT value FROM json_each(?))`,
  );
  const days = db.prepare(
    `SELECT day, SUM(value_u) AS v FROM ledger_daily
      WHERE lane = 'spend' AND day >= ? AND day < ?
        AND block_start IN (SELECT value FROM json_each(?))
        AND detector_id IN (SELECT value FROM json_each(?))
      GROUP BY day`,
  );
  return SPEND_CAUSES.map((c) => {
    const producers = producersOf(c.detectors);
    const ids = JSON.stringify(producers);
    const perDay = new Map<string, number>();
    for (const r of days.all(from, to, starts, ids) as Array<{ day: string; v: number }>)
      perDay.set(r.day, r.v);
    const t = (total.get(from, to, starts, ids) as { v: number }).v;
    return { cause_id: c.id, producers, total: t, perDay };
  });
}

const tileOf = (figs: CauseFigure[]) =>
  figs.filter((f) => f.producers.length > 0).reduce((t, f) => t + Math.round(f.total), 0);

/** Marks gate input: the blocks a window and its previous window need that lack a matching mark. */
function missingBlocks(db: Db, e: number, w: number): string[] {
  const get = db.prepare("SELECT block_end FROM ledger_daily_marks WHERE block_start = ?");
  return grid(e, Math.ceil((2 * w) / 7))
    .filter((b) => (get.get(b.start) as { block_end: string } | undefined)?.block_end !== b.end)
    .map((b) => b.start);
}

/** Σ cost_equiv_u of all turns in [E - w, E): the loosest spend bound (provisional turns included). */
function spendBetween(db: Db, e: number, w: number): number {
  return (
    db
      .prepare("SELECT COALESCE(SUM(cost_equiv_u), 0) AS u FROM turns WHERE ts >= ? AND ts < ?")
      .get(iso(e - w * DAY_MS), iso(e)) as { u: number }
  ).u;
}

/** The seed-golden figures: per window, the SQL tile and per-cause avoidable µ$ (rounded per cause). */
export function goldenWindows(db: Db, asOf: string) {
  const e = Math.floor(new Date(asOf).getTime() / DAY_MS) * DAY_MS;
  const out: Record<string, { tile_u: number; causes: Record<string, number> }> = {};
  for (const w of [7, 14, 30]) {
    if (missingBlocks(db, e, w).length > 0)
      throw new Error(`marks incomplete for the ${w}d window at ${iso(e)}; write the ledger first`);
    const figs = causeFigures(db, e, w, 0);
    out[String(w)] = {
      tile_u: tileOf(figs),
      causes: Object.fromEntries(
        figs.filter((f) => f.producers.length > 0).map((f) => [f.cause_id, Math.round(f.total)]),
      ),
    };
  }
  return out;
}

// ── The checks ────────────────────────────────────────────────────────────────

const unwrap = (j: Json): Json =>
  j && typeof j === "object" && "data" in j && j.data ? j.data : j;

function cardsOf(cards: Json): Map<string, { allocated: unknown; modeled: unknown }> {
  const view = unwrap(cards) ?? {};
  const out = new Map<string, { allocated: unknown; modeled: unknown }>();
  for (const list of ["active", "limit_warnings", "adopted", "dismissed", "history", "below_floor"])
    for (const c of Array.isArray(view[list]) ? view[list] : [])
      out.set(c.rec_id, { allocated: c.allocated_u_per_wk, modeled: c.modeled_savings_u_per_wk });
  return out;
}

export function verify(db: Db, views: Views, opts: Options) {
  const e = Math.floor(new Date(opts.asOf).getTime() / DAY_MS) * DAY_MS;
  const checks = Object.fromEntries(CHECK_IDS.map((id) => [id, new Check()])) as Record<
    CheckId,
    Check
  >;
  const skipped: Array<{ check: string; window: number; why: string }> = [];
  const marks: Record<string, { complete: boolean; missing: string[] }> = {};

  // Check 1a: per (lane, day, component) tokens and $ <= billed; per (lane, day) $ <= Σ cost_equiv_u.
  // Billed $ = billed tokens × unit price, priced in SQL from pricing_snapshots.unit_prices_json.
  {
    const price = (i: number) => `COALESCE(json_extract(p.unit_prices_json, '$[${i}]'), 0)`;
    const sel = COMPONENTS.map(
      (c, i) => `SUM(t.${c.column}) AS tok_${i}, SUM(t.${c.column} * ${price(i)}) AS usd_${i}`,
    ).join(", ");
    const billedRows = db
      .prepare(
        `SELECT date(t.ts) AS day, COUNT(*) AS n, COALESCE(SUM(t.cost_equiv_u), 0) AS cost, ${sel}
           FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
          GROUP BY date(t.ts)`,
      )
      .all() as Array<Record<string, number | string>>;
    const billed = new Map(billedRows.map((r) => [String(r.day), r]));
    const compRows = db
      .prepare(
        `SELECT lane, day, component, SUM(tokens) AS tokens, SUM(value_u) AS value_u
           FROM ledger_daily GROUP BY lane, day, component`,
      )
      .all() as Array<{
      lane: string;
      day: string;
      component: string;
      tokens: number;
      value_u: number;
    }>;
    for (const r of compRows) {
      const i = COMPONENTS.findIndex((c) => c.name === r.component);
      const b = billed.get(r.day);
      const at = { lane: r.lane, day: r.day, component: r.component };
      if (i < 0) {
        checks["1a"].ok(false, "unknown-component", at);
        continue;
      }
      const tokens = Number(b?.[`tok_${i}`] ?? 0);
      const usd = Number(b?.[`usd_${i}`] ?? 0);
      checks["1a"].ok(r.tokens <= tokens, "tokens<=billed", {
        ...at,
        ledger: r.tokens,
        billed: tokens,
      });
      checks["1a"].ok(r.value_u <= usd + tol(usd), "value<=billed$", {
        ...at,
        ledger: r.value_u,
        billed: usd,
      });
    }
    const dayRows = db
      .prepare("SELECT lane, day, SUM(value_u) AS v FROM ledger_daily GROUP BY lane, day")
      .all() as Array<{ lane: string; day: string; v: number }>;
    for (const r of dayRows) {
      const b = billed.get(r.day);
      const cap = Number(b?.cost ?? 0) + Number(b?.n ?? 0); // +1 µ$ rounding per turn
      checks["1a"].ok(r.v <= cap + tol(cap), "day<=cost_equiv", {
        lane: r.lane,
        day: r.day,
        ledger: r.v,
        cost_equiv_plus_rounding: cap,
      });
    }
  }

  // Check 1b: every ledger_daily_top row <= its turn's cost_equiv_u (+1 µ$).
  for (const r of db
    .prepare(
      `SELECT top.day, top.lane, top.detector_id, top.value_u, top.session_id, top.message_id, t.cost_equiv_u
         FROM ledger_daily_top top
         LEFT JOIN turns t ON t.session_id = top.session_id AND t.message_id = top.message_id`,
    )
    .all() as Array<{
    day: string;
    lane: string;
    detector_id: string;
    value_u: number;
    session_id: string;
    message_id: string;
    cost_equiv_u: number | null;
  }>) {
    const at = { day: r.day, lane: r.lane, detector: r.detector_id, message: r.message_id };
    if (r.cost_equiv_u === null) checks["1b"].ok(false, "top-turn-missing-or-unpriced", at);
    else
      checks["1b"].ok(r.value_u <= r.cost_equiv_u + 1 + tol(r.cost_equiv_u), "top<=turn-cost", {
        ...at,
        top: r.value_u,
        turn_cost: r.cost_equiv_u,
      });
  }

  // Lane separation: no (day, detector) in both lanes; lane matches the restated producer sets.
  for (const r of db
    .prepare(
      `SELECT day, detector_id FROM ledger_daily GROUP BY day, detector_id
        HAVING COUNT(DISTINCT lane) > 1`,
    )
    .all() as Array<{ day: string; detector_id: string }>)
    checks.lanes.ok(false, "detector-in-both-lanes", r);
  for (const r of db.prepare("SELECT DISTINCT lane, detector_id FROM ledger_daily").all() as Array<{
    lane: string;
    detector_id: string;
  }>) {
    const good =
      (r.lane === "spend" && SPEND_PRODUCERS.has(r.detector_id)) ||
      (r.lane === "reliability" && RELIABILITY_PRODUCERS.has(r.detector_id));
    checks.lanes.ok(good, "lane-vs-producer-set", r);
  }
  checks.lanes.ok(true, "lane-scan");

  const cardMap = cardsOf(views.cards);

  // Per window: marks gate, then checks 2 and 4 on the diagnostics dump.
  for (const w of opts.windows) {
    const missing = missingBlocks(db, e, w);
    marks[String(w)] = { complete: missing.length === 0, missing };
    const dump = views.diagnostics[w];
    const v = unwrap(dump);
    if (v === undefined || v === null || typeof v !== "object")
      throw new Error(`missing diagnostics dump for window ${w}`);
    const causesRows: Json[] = Array.isArray(v.avoidable?.causes) ? v.avoidable.causes : [];
    const tile: unknown = v.tiles?.avoidable_u;

    if (missing.length > 0) {
      const allNull = tile === null && causesRows.every((r) => r.avoidable_u === null);
      checks.marks.ok(allNull, "unmarked-block-with-figures", {
        window: w,
        missing: missing.length,
      });
      for (const id of w === 7 ? ["2", "3", "4"] : ["2", "4"])
        skipped.push({ check: id, window: w, why: "marks incomplete" });
      continue;
    }
    checks.marks.ok(true, "marks-complete");

    // Check 2 (internal): tile == Σ causes, through == E, tile <= spend over [E-w, E).
    checks["2"].ok(v.window_days === w, "window-mismatch", { window: w, got: v.window_days });
    const sumRows = causesRows.reduce((t, r) => t + (isNum(r.avoidable_u) ? r.avoidable_u : 0), 0);
    checks["2"].ok(isNum(tile) && tile === sumRows, "tile==sum(causes)", {
      window: w,
      tile,
      sum: sumRows,
    });
    checks["2"].ok(v.tiles?.avoidable_through === iso(e), "through==E", {
      window: w,
      got: v.tiles?.avoidable_through,
    });
    const spend = spendBetween(db, e, w);
    checks["2"].ok(isNum(tile) && tile <= spend, "tile<=spend", { window: w, tile, spend });

    const figs = causeFigures(db, e, w, 0);
    const known = new Set(SPEND_CAUSES.map((c) => c.id));
    const dumpRow = (id: string) => causesRows.find((r) => r.cause_id === id);
    for (const r of causesRows)
      if (!known.has(r.cause_id)) checks["2"].ok(false, "unknown-cause-row", { cause: r.cause_id });

    if (w === 7) {
      // Check 2 (SQL): the 7d dump equals the SQL figure, per cause and for the tile.
      checks["2"].ok(tile === tileOf(figs), "tile==sql", { window: w, tile, sql: tileOf(figs) });
      for (const f of figs) {
        const row = dumpRow(f.cause_id);
        if (f.producers.length === 0) {
          checks["2"].ok(row === undefined || row.avoidable_u === null, "no-producer-cause-null", {
            cause: f.cause_id,
            got: row?.avoidable_u,
          });
          continue;
        }
        const got = row === undefined ? 0 : row.avoidable_u;
        checks["2"].ok(isNum(got) && roundEq(got, f.total), "cause==sql", {
          window: w,
          cause: f.cause_id,
          got,
          sql: f.total,
        });
      }
    }

    // Check 4: 14d / 30d dump figures == Σ of the SQL per-day sums; 14d == 7d(E) + 7d(E-7).
    if (w !== 7) {
      const rounded = (f: CauseFigure) => [...f.perDay.values()].reduce((t, x) => t + x, 0);
      let tileWant = 0;
      for (const f of figs) {
        const row = dumpRow(f.cause_id);
        if (f.producers.length === 0) continue;
        const want = rounded(f);
        tileWant += Math.round(want);
        const got = row === undefined ? 0 : row.avoidable_u;
        checks["4"].ok(isNum(got) && roundEq(got, want), "cause==sum(days)", {
          window: w,
          cause: f.cause_id,
          got,
          sum_of_days: want,
        });
      }
      checks["4"].ok(isNum(tile) && tile === tileWant, "tile==sum(days)", {
        window: w,
        tile,
        want: tileWant,
      });
      if (w === 14) {
        const a = causeFigures(db, e, 7, 0);
        const b = causeFigures(db, e, 14, 7);
        for (const [i, f] of figs.entries()) {
          if (f.producers.length === 0) continue;
          const sum = (a[i]?.total ?? 0) + (b[i]?.total ?? 0);
          const row = dumpRow(f.cause_id);
          const got = row === undefined ? 0 : row.avoidable_u;
          checks["4"].ok(near(sum, f.total) && isNum(got) && roundEq(got, sum), "14d==7d+7d", {
            cause: f.cause_id,
            got,
            first_week: a[i]?.total,
            second_week: b[i]?.total,
          });
        }
      }
    }
  }

  // Checks 3 and 5 use the cards dump, which is always the trailing 7d at E.
  const missing7 = missingBlocks(db, e, 7);
  const rows7 = db
    .prepare(
      `SELECT day, detector_id, rec_id, component, SUM(value_u) AS v FROM ledger_daily
        WHERE lane = 'spend' AND day >= ? AND day < ?
          AND block_start IN (SELECT value FROM json_each(?))
        GROUP BY day, detector_id, rec_id, component`,
    )
    .all(dayStr(e - 7 * DAY_MS), dayStr(e), JSON.stringify(grid(e).map((b) => b.start))) as Array<{
    day: string;
    detector_id: string;
    rec_id: string;
    component: string;
    v: number;
  }>;
  let noCard = 0;
  if (missing7.length > 0) {
    if (!skipped.some((s) => s.check === "3"))
      skipped.push({ check: "3", window: 7, why: "marks incomplete" });
  } else {
    // Check 3: a cause whose 7d rows carry exactly one rec id (and no unattributed rows) == its card.
    const figs7 = causeFigures(db, e, 7, 0);
    for (const f of figs7) {
      if (f.producers.length === 0) continue;
      const recs = new Set(
        rows7.filter((r) => f.producers.includes(r.detector_id)).map((r) => r.rec_id),
      );
      const [only] = [...recs];
      if (recs.size !== 1 || only === undefined || only === "") continue;
      const card = cardMap.get(only);
      if (card === undefined) {
        noCard++;
        continue;
      }
      checks["3"].ok(isNum(card.allocated) && roundEq(card.allocated, f.total), "card==cause", {
        cause: f.cause_id,
        rec: only.slice(0, 12),
        card: card.allocated,
        sql: f.total,
      });
    }
  }

  // Invariant 5 is info only (OD-L9-4): modeled is stored from the daemon's last run (another
  // window), and D1 prices each turn at its as-of file size, so allocated <= modeled is not a gate.
  const allocVsModeled: Array<Record<string, unknown>> = [];
  for (const [rec, c] of cardMap)
    if (isNum(c.allocated) && isNum(c.modeled))
      allocVsModeled.push({
        rec: rec.slice(0, 12),
        allocated: c.allocated,
        modeled: c.modeled,
        ratio: c.modeled > 0 ? Math.round((c.allocated / c.modeled) * 1000) / 1000 : null,
      });
  const solo: Array<Record<string, unknown>> = [];
  {
    const detsOfRec = new Map<string, Set<string>>();
    const cellsOfRec = new Map<string, Set<string>>();
    const totalOfRec = new Map<string, number>();
    for (const r of rows7) {
      if (r.rec_id === "") continue;
      if (!detsOfRec.has(r.rec_id)) detsOfRec.set(r.rec_id, new Set());
      detsOfRec.get(r.rec_id)?.add(r.detector_id);
      if (!cellsOfRec.has(r.rec_id)) cellsOfRec.set(r.rec_id, new Set());
      cellsOfRec.get(r.rec_id)?.add(`${r.day}|${r.component}`);
      totalOfRec.set(r.rec_id, (totalOfRec.get(r.rec_id) ?? 0) + r.v);
    }
    for (const [rec, cells] of cellsOfRec) {
      const mine = detsOfRec.get(rec) ?? new Set<string>();
      const shared = rows7.some(
        (r) => cells.has(`${r.day}|${r.component}`) && !mine.has(r.detector_id),
      );
      if (shared) continue;
      const card = cardMap.get(rec);
      solo.push({
        rec: rec.slice(0, 12),
        ledger_7d_u: Math.round(totalOfRec.get(rec) ?? 0),
        allocated_u_per_wk: card?.allocated ?? null,
        modeled_savings_u_per_wk: card?.modeled ?? null,
      });
    }
  }

  // Top-3 spend causes per window, for the operator's live review (all three windows, whenever marked).
  const top3: Record<string, unknown> = {};
  for (const w of [7, 14, 30] as const) {
    if (missingBlocks(db, e, w).length > 0) {
      top3[String(w)] = null;
      continue;
    }
    const figs = causeFigures(db, e, w, 0).filter((f) => f.producers.length > 0);
    top3[String(w)] = {
      tile_u: tileOf(figs),
      top: figs
        .map((f) => ({ cause_id: f.cause_id, avoidable_u: Math.round(f.total) }))
        .sort((a, b) => b.avoidable_u - a.avoidable_u)
        .slice(0, 3),
    };
  }

  const summary = Object.fromEntries(
    CHECK_IDS.map((id) => {
      const c = checks[id];
      return [
        id,
        {
          pass: c.pass,
          fail: c.fail,
          by_what: Object.fromEntries(c.byWhat),
          first_failures: c.rows,
        },
      ];
    }),
  );
  const failedChecks = CHECK_IDS.filter((id) => checks[id].fail > 0);
  const skippedFails = !opts.allowIncomplete && skipped.length > 0;
  return {
    ok: failedChecks.length === 0 && !skippedFails,
    failed_checks: failedChecks,
    as_of: iso(e),
    windows: opts.windows,
    checks: summary,
    marks,
    skipped: skipped.map((s) => `SKIPPED: marks incomplete (check ${s.check}, ${s.window}d)`),
    info: {
      inv5_allocated_vs_modeled: allocVsModeled.sort((a, b) => Number(b.ratio) - Number(a.ratio)),
      od_l9_3_solo_recs: solo.slice(0, 100),
      solo_recs_total: solo.length,
      check3_recs_without_card: noCard,
    },
    top3,
  };
}

// ── Self-check ────────────────────────────────────────────────────────────────

const SELF_E = Date.UTC(2026, 8, 28);

function selfDb(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE turns (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_5m INTEGER, cache_write_1h INTEGER, pricing_snapshot_id TEXT, cost_equiv_u INTEGER);
    CREATE TABLE ledger_daily (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, rec_id TEXT,
      component TEXT, value_u REAL, tokens INTEGER);
    CREATE TABLE ledger_daily_top (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT,
      session_id TEXT, message_id TEXT, ts TEXT, value_u REAL);
    CREATE TABLE ledger_daily_marks (block_start TEXT PRIMARY KEY, block_end TEXT NOT NULL);
  `);
  // Prices [in, out, cacheRead, cw5m, cw1h] = [2, 10, 1, 3, 4] µ$/token.
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p1', '[2,10,1,3,4]')").run();
  const t = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,'p1',?)");
  // cost = 2*in + 10*out + 1*cr + 3*cw5m + 4*cw1h
  t.run("m1", "s1", "2026-09-27T10:00:00.000Z", 1000, 100, 5000, 2000, 0, 14000);
  t.run("m2", "s2", "2026-09-25T12:00:00.000Z", 500, 50, 10000, 0, 1000, 15500);
  t.run("m3", "s3", "2026-09-15T09:00:00.000Z", 2000, 0, 0, 0, 0, 4000);
  t.run("m4", "s4", "2026-09-05T09:00:00.000Z", 3000, 0, 0, 0, 0, 6000);
  const grids = grid(SELF_E);
  const b0 = grids[0]?.start ?? "";
  const b1 = grids[1]?.start ?? "";
  const b3 = grids[3]?.start ?? "";
  const ins = db.prepare("INSERT INTO ledger_daily VALUES (?,?,?,?,?,?,?,?)");
  ins.run(b0, "2026-09-27", "spend", "D2", "recA", "cacheRead", 3000, 3000);
  ins.run(b0, "2026-09-27", "spend", "D1", "recB", "input", 1000, 500);
  ins.run(b0, "2026-09-25", "spend", "B1", "recC", "cw1h", 2000, 500);
  ins.run(b0, "2026-09-25", "spend", "D8", "", "cacheRead", 4000, 4000);
  ins.run(b0, "2026-09-27", "reliability", "C7", "", "input", 500, 200);
  ins.run(b1, "2026-09-15", "spend", "D2", "recA", "input", 1500, 1000);
  ins.run(b3, "2026-09-05", "spend", "A1", "recD", "input", 2500, 1200);
  const top = db.prepare("INSERT INTO ledger_daily_top VALUES (?,?,?,?,?,?,?,?)");
  top.run(b0, "2026-09-27", "spend", "D2", "s1", "m1", "2026-09-27T10:00:00.000Z", 3000);
  top.run(b0, "2026-09-25", "spend", "B1", "s2", "m2", "2026-09-25T12:00:00.000Z", 2000);
  const mark = db.prepare("INSERT INTO ledger_daily_marks VALUES (?,?)");
  for (const b of grids) mark.run(b.start, b.end);
  return db as unknown as Db;
}

/** Hand-written view JSON for the clean fixture (figures derived by hand in the comments above). */
function selfViews(): Views {
  const diag = (w: number, tile: number, rows: Array<[string, number | null]>, spend: number) => ({
    window_days: w,
    tiles: { spend_u: spend, avoidable_u: tile, avoidable_through: iso(SELF_E) },
    avoidable: { causes: rows.map(([cause_id, avoidable_u]) => ({ cause_id, avoidable_u })) },
  });
  const sub: [string, number | null] = ["SUBAGENTS_COST_MORE_THAN_RETURN", null];
  return {
    cards: {
      data: {
        active: [
          { rec_id: "recA", allocated_u_per_wk: 3000, modeled_savings_u_per_wk: 5000 },
          { rec_id: "recB", allocated_u_per_wk: 1000, modeled_savings_u_per_wk: 1000 },
          { rec_id: "recC", allocated_u_per_wk: 2000, modeled_savings_u_per_wk: 2500 },
        ],
        limit_warnings: [],
        adopted: [],
        dismissed: [],
        history: [{ rec_id: "recD", allocated_u_per_wk: 2500, modeled_savings_u_per_wk: null }],
      },
    },
    diagnostics: {
      7: diag(
        7,
        10000,
        [
          ["CONTEXT_TOO_LARGE", 3000],
          ["CACHE_REBUILT_MID_SESSION", 6000],
          ["ALWAYS_LOADED_TOO_BIG", 1000],
          sub,
        ],
        29500,
      ),
      14: diag(
        14,
        11500,
        [
          ["CONTEXT_TOO_LARGE", 4500],
          ["CACHE_REBUILT_MID_SESSION", 6000],
          ["ALWAYS_LOADED_TOO_BIG", 1000],
          sub,
        ],
        33500,
      ),
      30: diag(
        30,
        14000,
        [
          ["CONTEXT_TOO_LARGE", 4500],
          ["CACHE_REBUILT_MID_SESSION", 6000],
          ["TOOL_RESULTS_TOO_LARGE", 2500],
          ["ALWAYS_LOADED_TOO_BIG", 1000],
          sub,
        ],
        39500,
      ),
    },
  };
}

/**
 * Expected results, written before the code was run. Each mutation must fail exactly `fails`
 * (and only that check id), and the named `what` label must be among its failures.
 */
const MUTATIONS: Array<{
  name: string;
  fails: CheckId;
  what: string;
  allowIncomplete?: boolean;
  apply: (db: Db, v: Views) => void;
}> = [
  {
    name: "1a value over billed $ (reliability input 2500 > 1000 tokens x 2)",
    fails: "1a",
    what: "value<=billed$",
    apply: (db) =>
      void db.prepare("UPDATE ledger_daily SET value_u = 2500 WHERE detector_id = 'C7'").run(),
  },
  {
    name: "1a tokens over billed tokens (1500 > 1000 input)",
    fails: "1a",
    what: "tokens<=billed",
    apply: (db) =>
      void db.prepare("UPDATE ledger_daily SET tokens = 1500 WHERE detector_id = 'C7'").run(),
  },
  {
    name: "1a day total over Σ cost_equiv_u (m1 cost 14000 -> 3000)",
    fails: "1a",
    what: "day<=cost_equiv",
    apply: (db) =>
      void db.prepare("UPDATE turns SET cost_equiv_u = 3000 WHERE message_id = 'm1'").run(),
  },
  {
    name: "1b top row over its turn's cost",
    fails: "1b",
    what: "top<=turn-cost",
    apply: (db) =>
      void db.prepare("UPDATE ledger_daily_top SET value_u = 14002 WHERE message_id = 'm1'").run(),
  },
  {
    name: "2 tile != Σ causes (7d tile 10001)",
    fails: "2",
    what: "tile==sum(causes)",
    apply: (_db, v) => {
      v.diagnostics[7].tiles.avoidable_u = 10001;
    },
  },
  {
    name: "2 a cause off by 1 (CONTEXT 3001, tile kept equal to Σ causes)",
    fails: "2",
    what: "cause==sql",
    apply: (_db, v) => {
      v.diagnostics[7].avoidable.causes[0].avoidable_u = 3001;
      v.diagnostics[7].tiles.avoidable_u = 10001;
    },
  },
  {
    name: "2 tile over spend (30000 > 29500)",
    fails: "2",
    what: "tile<=spend",
    apply: (_db, v) => {
      v.diagnostics[7].tiles.avoidable_u = 30000;
    },
  },
  {
    name: "3 card allocated off by 1 on a single-rec cause (recA 3001)",
    fails: "3",
    what: "card==cause",
    apply: (_db, v) => {
      v.cards.data.active[0].allocated_u_per_wk = 3001;
    },
  },
  {
    name: "4 14d figure != Σ days (CONTEXT 4501, tile kept consistent)",
    fails: "4",
    what: "cause==sum(days)",
    apply: (_db, v) => {
      v.diagnostics[14].avoidable.causes[0].avoidable_u = 4501;
      v.diagnostics[14].tiles.avoidable_u = 11501;
    },
  },
  {
    name: "marks: block 8 unmarked while the 30d view shows figures",
    fails: "marks",
    what: "unmarked-block-with-figures",
    allowIncomplete: true,
    apply: (db) => {
      const b8 = grid(SELF_E)[8]?.start ?? "";
      db.prepare("DELETE FROM ledger_daily_marks WHERE block_start = ?").run(b8);
    },
  },
  {
    name: "lanes: (day, detector) in both lanes",
    fails: "lanes",
    what: "detector-in-both-lanes",
    apply: (db) =>
      void db
        .prepare(
          `INSERT INTO ledger_daily VALUES (?, '2026-09-27', 'reliability', 'D2', '', 'input', 100, 50)`,
        )
        .run(grid(SELF_E)[0]?.start ?? ""),
  },
];

function selfCheck(): number {
  const opts = (allowIncomplete = false): Options => ({
    asOf: iso(SELF_E),
    windows: [7, 14, 30],
    allowIncomplete,
  });
  let bad = 0;
  const report = (name: string, ok: boolean, detail: string) => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const clean = verify(selfDb(), selfViews(), opts());
  report("clean case passes", clean.ok, clean.ok ? "" : JSON.stringify(clean.failed_checks));
  const passes = Object.values(clean.checks).map((c) => c.pass);
  report(
    "clean case exercised every check",
    passes.every((p) => p > 0),
    passes.join(","),
  );

  // Honest incomplete: block 8 unmarked, 30d view all-null -> marks pass, skipped, exit only with the flag.
  {
    const db = selfDb();
    db.prepare("DELETE FROM ledger_daily_marks WHERE block_start = ?").run(
      grid(SELF_E)[8]?.start ?? "",
    );
    const v = selfViews();
    v.diagnostics[30].tiles.avoidable_u = null;
    for (const r of v.diagnostics[30].avoidable.causes) r.avoidable_u = null;
    const strict = verify(db, v, opts());
    const lax = verify(db, v, opts(true));
    report(
      "unmarked + honest all-null view: skipped, fails unless --allow-incomplete",
      !strict.ok && lax.ok && strict.skipped.length > 0 && strict.failed_checks.length === 0,
      strict.skipped.join("; "),
    );
  }

  for (const m of MUTATIONS) {
    const db = selfDb();
    const v = selfViews();
    m.apply(db, v);
    const r = verify(db, v, opts(m.allowIncomplete ?? false));
    const only = r.failed_checks.length === 1 && r.failed_checks[0] === m.fails;
    const labelled = (r.checks[m.fails]?.by_what?.[m.what] ?? 0) > 0;
    report(
      `mutation caught: ${m.name}`,
      only && labelled,
      `failed=${JSON.stringify(r.failed_checks)} want=${m.fails}/${m.what} got_whats=${JSON.stringify(r.checks[m.fails]?.by_what)}`,
    );
  }
  console.log(bad === 0 ? "SELF-CHECK PASS" : `SELF-CHECK FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: ledger-sql-oracle.ts --db <sqlite> --views <dir> --as-of <iso> [--window 7|14|30] [--allow-incomplete] [--emit-golden <path>] | --self-check`,
  );
  process.exit(2);
}

function main(): number {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  const bool = new Set<string>();
  const valued = new Set(["--db", "--views", "--as-of", "--window", "--emit-golden"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--self-check" || a === "--allow-incomplete") bool.add(a);
    else if (valued.has(a)) {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) usage(`Missing value for ${a}`);
      flags.set(a, val);
    } else usage(`Unknown flag ${a}`);
  }
  if (bool.has("--self-check")) return selfCheck();

  const dbPath = flags.get("--db");
  const asOf = flags.get("--as-of");
  if (!dbPath) usage("--db is required");
  if (!asOf || !Number.isFinite(new Date(asOf).getTime())) usage("--as-of must be an ISO date");
  const win = flags.get("--window");
  if (win !== undefined && win !== "7" && win !== "14" && win !== "30")
    usage("--window must be 7, 14 or 30");
  if (!fs.existsSync(dbPath)) usage(`db not found: ${dbPath}`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const emit = flags.get("--emit-golden");
    if (emit !== undefined) {
      const windows = goldenWindows(db, asOf);
      const e = Math.floor(new Date(asOf).getTime() / DAY_MS) * DAY_MS;
      fs.writeFileSync(
        emit,
        `${JSON.stringify({ version: 1, frozen_at: new Date().toISOString(), source: "seed", as_of: iso(e), windows }, null, 2)}\n`,
      );
      console.log(`golden-ledger written: ${emit}`);
      return 0;
    }
    const viewsDir = flags.get("--views");
    if (!viewsDir) usage("--views is required");
    const read = (name: string): Json => {
      const p = path.join(viewsDir, name);
      if (!fs.existsSync(p)) usage(`missing views file: ${p}`);
      return JSON.parse(fs.readFileSync(p, "utf8"));
    };
    const windows = (win === undefined ? [7, 14, 30] : [Number(win)]) as Array<7 | 14 | 30>;
    const views: Views = {
      cards: read("cards.json"),
      diagnostics: Object.fromEntries(windows.map((w) => [w, read(`diagnostics-${w}.json`)])),
    };
    const report = verify(db, views, {
      asOf,
      windows,
      allowIncomplete: bool.has("--allow-incomplete"),
    });
    console.log(JSON.stringify(report, null, 2));
    for (const s of report.skipped) console.log(s);
    return report.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 2;
  }
}
