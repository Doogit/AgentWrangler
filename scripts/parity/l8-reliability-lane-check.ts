/**
 * P3.L L8 — independent oracle for "price failures at the recovery turn" (reliability lane).
 * Contract: docs/plans/Archive/2026-09-29-l8-reliability-lane-spec.md, "Invariants".
 *
 * Written before the implementation and without reading it. The one src/ import is `wastedTurnCensus`
 * (certified, unchanged by L8), loaded lazily and only for the issuing turns. Everything else is
 * restated below: recovery turns and pricing come from SQL over raw `turns` + `pricing_snapshots`.
 *
 *   npx tsx scripts/parity/l8-reliability-lane-check.ts --db <prepared copy> --views <dir> --as-of <iso>
 *       [--window 7|14|30]                                  I2, I3, I4
 *   npx tsx scripts/parity/l8-reliability-lane-check.ts --baseline <views dir> --baseline-db <db>
 *       --candidate <views dir> --candidate-db <db>          I1 (spend lane byte-identical)
 *   npx tsx scripts/parity/l8-reliability-lane-check.ts --self-check
 *
 * Both modes may be combined. Exit 0 = all gated checks passed; 1 = a check failed; 2 = bad flags/inputs.
 * DBs are opened read-only.
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
const BLOCKS = 9;
const iso = (ms: number) => new Date(ms).toISOString();
const dayStr = (ms: number) => iso(ms).slice(0, 10);

/** src/detector/ledger-daily.ts ledgerDailyGrid: block k = [E - 7(k+1) days, E - 7k days). */
function grid(e: number, blocks = BLOCKS): Array<{ start: string; end: string }> {
  return Array.from({ length: blocks }, (_, k) => ({
    start: iso(e - 7 * (k + 1) * DAY_MS),
    end: iso(e - 7 * k * DAY_MS),
  }));
}

/** src/detector/claim-ledger.ts LEDGER_PRIORITY, reliability lane part (first wins a shared cell). */
const FAMILIES = ["C7", "C3", "C4", "C1", "C2", "C9", "D14", "D11"] as const;
type Family = (typeof FAMILIES)[number];
const RANK = new Map<string, number>(FAMILIES.map((f, i) => [f, i]));

/**
 * src/query/api/diagnostics-causes.ts (section "reliability") + diagnostics-census.ts PATTERNS:
 * the wasted-turn families behind each Reliability cause row. C5/D7 (loop pool), G11 and C6
 * (anchors) are not families and have no ledger rows, so AGENT_REPEATS_SAME_ERROR has none.
 */
const CAUSE_FAMILIES: Readonly<Record<string, readonly Family[]>> = {
  BLOCKED_BY_PERMISSIONS: ["C9"],
  INTERRUPTED_OR_CANCELLED: ["D14"],
  SHELL_FAILS_IN_BURSTS: ["C7"],
  TOOLS_FAIL_MORE_THAN_USUAL: ["C1", "D11"],
  AGENT_REPEATS_SAME_ERROR: [],
  EDITS_FAIL_OR_UNDONE: ["C3", "C4"],
  SEARCHES_FOR_MISSING_CONTENT: ["C2"],
};

/** µ$ per token, `pricing_snapshots.unit_prices_json` = [in, out, cacheRead, cw5m, cw1h]. */
const PRICED_TOKENS = `(
  t.input_tokens * COALESCE(json_extract(p.unit_prices_json, '$[0]'), 0)
  + t.output_tokens * COALESCE(json_extract(p.unit_prices_json, '$[1]'), 0)
  + t.cache_read_tokens * COALESCE(json_extract(p.unit_prices_json, '$[2]'), 0)
  + t.cache_write_5m * COALESCE(json_extract(p.unit_prices_json, '$[3]'), 0)
  + t.cache_write_1h * COALESCE(json_extract(p.unit_prices_json, '$[4]'), 0))`;

/**
 * I2 tolerance. The ledger sums per-claim `tokens * price` in JS doubles, in component order and
 * across claims; this sums the same integer x price products in SQLite doubles. The only difference
 * is float summation order (~1e-16 relative), so 1e-6 µ$ + 1e-9 relative is far above noise and far
 * below one µ$: any real pricing difference (one wrong turn, one token) is orders of magnitude larger.
 */
const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);
const near = (a: number, b: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b)));
/** An API integer vs an unrounded SQL figure. */
function roundEq(got: number, x: number): boolean {
  if (got === Math.round(x)) return true;
  const frac = x - Math.floor(x);
  return Math.abs(frac - 0.5) < 1e-6 && Math.abs(got - x) <= 0.5 + 1e-6;
}
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
const CHECK_IDS = ["I1", "I2", "I3", "I4"] as const;
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

// ── Issuing turns ─────────────────────────────────────────────────────────────

/** One failure event of a family, on the turn that issued it. Several events may share a turn. */
export interface Issuing {
  family: Family;
  session: string;
  message: string;
}
/** The issuing events of one producer window [start, end). */
export type IssuingFn = (db: Db, start: string, end: string) => Issuing[];

/**
 * Issuing turns from the certified `wastedTurnCensus`: for family F, the owner turn of each event in
 * `claimEventIds[F]` (spec rule 2). Tool events -> `tool_event_metadata.owner_message_id`. C9 events are
 * `ingest_metric_events` denials, owned by the latest main-chain turn at or before the denial
 * (turn-claim.ts c9OwnerQ, restated). Kept only when the turn is in `claims[F]`.
 */
async function censusIssuing(): Promise<IssuingFn> {
  const mod = await import("../../src/detector/turn-claim.js");
  return (db, start, end) => {
    const census = mod.wastedTurnCensus(
      db as never,
      {
        now: new Date(end),
        fromIso: start,
        toIso: end,
      } as never,
    );
    const toolOwner = db.prepare(
      `SELECT e.session_id AS s, m.owner_message_id AS m FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id WHERE e.event_id = ?`,
    );
    const denial = db.prepare(
      "SELECT session_id, event_ts FROM ingest_metric_events WHERE event_id = ?",
    );
    const c9Owner = db.prepare(
      `SELECT message_id AS m FROM turns WHERE session_id = ? AND is_sidechain = 0 AND ts <= ?
        ORDER BY ts DESC LIMIT 1`,
    );
    const out: Issuing[] = [];
    for (const family of FAMILIES) {
      const claimed = census.claims.get(family) ?? new Set<string>();
      for (const eventId of census.claimEventIds.get(family) ?? []) {
        let owner: { s: string; m: string } | undefined;
        if (family === "C9") {
          const d = denial.get(eventId) as { session_id: string; event_ts: string } | undefined;
          const r = d && (c9Owner.get(d.session_id, d.event_ts) as { m: string } | undefined);
          if (d && r) owner = { s: d.session_id, m: r.m };
        } else owner = toolOwner.get(eventId) as { s: string; m: string } | undefined;
        if (owner === undefined) continue;
        if (!claimed.has(`${owner.s}|${owner.m}`)) continue;
        out.push({ family, session: owner.s, message: owner.m });
      }
    }
    return out;
  };
}

// ── I2: recovery-turn pricing in SQL ──────────────────────────────────────────

/**
 * Expected reliability µ$ per `${day}|${family}`, from SQL (spec rules 2-7):
 *  R(t) = earliest turn of t's session with is_sidechain = 0, provisional = 0, ts > t.ts (tie: message_id);
 *  priced set per family = distinct R(t) (several failures in one turn price one recovery turn);
 *  price = full billed tokens x unit prices; dropped if R(t).ts is outside the producer block [start, end);
 *  a turn wanted by several families goes to the first in LEDGER_PRIORITY; lands on R's UTC day.
 */
export function expectedReliability(db: Db, e: number, issuing: IssuingFn): Map<string, number> {
  const ts = db.prepare("SELECT ts FROM turns WHERE session_id = ? AND message_id = ?");
  const recovery = db.prepare(
    `SELECT t.message_id AS message, t.ts AS ts, ${PRICED_TOKENS} AS value_u
       FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
      WHERE t.session_id = ? AND t.is_sidechain = 0 AND t.provisional = 0 AND t.ts > ?
      ORDER BY t.ts ASC, t.message_id ASC LIMIT 1`,
  );
  const expected = new Map<string, number>();
  for (const { start, end } of grid(e)) {
    const seen = new Set<string>();
    const owner = new Map<string, { family: Family; day: string; value: number }>();
    for (const ev of issuing(db, start, end)) {
      const dedup = `${ev.family}\0${ev.session}\0${ev.message}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const t = ts.get(ev.session, ev.message) as { ts: string } | undefined;
      if (t === undefined) continue;
      const r = recovery.get(ev.session, t.ts) as
        | { message: string; ts: string; value_u: number }
        | undefined;
      if (r === undefined) continue; // the session ended: no claim
      if (r.ts < start || r.ts >= end) continue; // rule 7: outside the producer window
      const key = `${ev.session}\0${r.message}`;
      const cur = owner.get(key);
      if (cur === undefined || (RANK.get(ev.family) ?? 99) < (RANK.get(cur.family) ?? 99))
        owner.set(key, { family: ev.family, day: r.ts.slice(0, 10), value: r.value_u });
    }
    for (const o of owner.values()) {
      const k = `${o.day}|${o.family}`;
      expected.set(k, (expected.get(k) ?? 0) + o.value);
    }
  }
  return expected;
}

// ── verify: I2, I3, I4 ────────────────────────────────────────────────────────

export interface Views {
  cards?: Json;
  diagnostics: Partial<Record<7 | 14 | 30, Json>>;
}

const markedBlocks = (db: Db, e: number): string[] => {
  const get = db.prepare("SELECT block_end FROM ledger_daily_marks WHERE block_start = ?");
  return grid(e)
    .filter((b) => (get.get(b.start) as { block_end: string } | undefined)?.block_end !== b.end)
    .map((b) => b.start);
};

export function verify(
  db: Db,
  views: Views,
  opts: { asOf: string; windows: Array<7 | 14 | 30>; sidechain?: Map<string, number> },
  issuing: IssuingFn,
) {
  const e = Math.floor(new Date(opts.asOf).getTime() / DAY_MS) * DAY_MS;
  const checks = newChecks();
  const info: Record<string, unknown> = {};

  const unmarked = markedBlocks(db, e);
  checks.I2.ok(unmarked.length === 0, "marks-incomplete", { missing: unmarked.length });
  const starts = JSON.stringify(grid(e).map((b) => b.start));

  // Actual: reliability rows of ledger_daily, per day x detector.
  const actualRows = db
    .prepare(
      `SELECT day, detector_id AS family, SUM(value_u) AS v, COUNT(*) AS n FROM ledger_daily
        WHERE lane = 'reliability' AND block_start IN (SELECT value FROM json_each(?))
        GROUP BY day, detector_id`,
    )
    .all(starts) as Array<{ day: string; family: string; v: number; n: number }>;
  const actual = new Map(actualRows.map((r) => [`${r.day}|${r.family}`, r.v]));
  // Sidechain claims belong to sidechain-reliability-check.ts: compare main-chain claims only.
  for (const [k, v] of opts.sidechain ?? []) actual.set(k, (actual.get(k) ?? 0) - v);
  for (const r of actualRows)
    checks.I2.ok(RANK.has(r.family), "foreign-detector-in-reliability-lane", r);

  // I2: per day x family, ledger == SQL recovery-turn pricing.
  const want = expectedReliability(db, e, issuing);
  for (const k of new Set([...want.keys(), ...actual.keys()])) {
    const w = want.get(k) ?? 0;
    const a = actual.get(k) ?? 0;
    checks.I2.ok(near(a, w), "value-mismatch", { day_family: k, ledger_u: a, recovery_u: w });
  }
  const week = (m: Map<string, number>) => {
    const out: Record<string, number> = {};
    const from = dayStr(e - 7 * DAY_MS);
    const to = dayStr(e);
    for (const [k, v] of m) {
      const [day = "", fam = ""] = k.split("|");
      if (day >= from && day < to) out[fam] = (out[fam] ?? 0) + v;
    }
    return out;
  };
  const wk = { ledger: week(actual), recovery: week(want) };
  info.per_family_7d = Object.fromEntries(
    [...new Set([...Object.keys(wk.ledger), ...Object.keys(wk.recovery)])]
      .sort()
      .map((f) => [f, { ledger_u: wk.ledger[f] ?? 0, recovery_u: wk.recovery[f] ?? 0 }]),
  );

  // I3: reliability per day <= billed per day (Σ tokens x price over every turn of that day, loosest).
  const billed = new Map(
    (
      db
        .prepare(
          `SELECT date(t.ts) AS day, COALESCE(SUM(${PRICED_TOKENS}), 0) AS v
             FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
            GROUP BY date(t.ts)`,
        )
        .all() as Array<{ day: string; v: number }>
    ).map((r) => [r.day, r.v]),
  );
  const perDay = new Map<string, number>();
  for (const r of actualRows) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.v);
  for (const [day, v] of perDay) {
    const cap = billed.get(day) ?? 0;
    checks.I3.ok(v <= cap + tol(cap), "reliability<=billed", { day, ledger_u: v, billed_u: cap });
  }

  // I4: Diagnostics replan_u == Σ ledger reliability rows for the row's families in the window.
  for (const w of opts.windows) {
    const v = unwrap(views.diagnostics[w]);
    if (v === undefined || v === null || typeof v !== "object")
      throw new Error(`missing diagnostics dump for window ${w}`);
    const from = dayStr(e - w * DAY_MS);
    const to = dayStr(e);
    const q = db.prepare(
      `SELECT COALESCE(SUM(value_u), 0) AS v, COUNT(*) AS n FROM ledger_daily
        WHERE lane = 'reliability' AND day >= ? AND day < ?
          AND block_start IN (SELECT value FROM json_each(?))
          AND detector_id IN (SELECT value FROM json_each(?))`,
    );
    const rows: Json[] = Array.isArray(v.reliability?.causes) ? v.reliability.causes : [];
    checks.I4.ok(rows.length > 0, "no-reliability-rows", { window: w });
    for (const row of rows) {
      const fams = CAUSE_FAMILIES[row.cause_id];
      if (fams === undefined) {
        checks.I4.ok(false, "unknown-cause-row", { window: w, cause: row.cause_id });
        continue;
      }
      const s = q.get(from, to, starts, JSON.stringify(fams)) as { v: number; n: number };
      const got: unknown = row.cost?.replan_u;
      const at = { window: w, cause: row.cause_id, got, ledger_sum_u: s.v, ledger_rows: s.n };
      if (s.n === 0) checks.I4.ok(got === null, "replan_u-not-null-without-rows", at);
      else checks.I4.ok(isNum(got) && roundEq(got, s.v), "replan_u!=sum(ledger)", at);
    }
  }

  const ids: CheckId[] = ["I2", "I3", "I4"];
  const failed = ids.filter((id) => checks[id].fail > 0);
  return {
    ok: failed.length === 0,
    failed_checks: failed,
    as_of: iso(e),
    windows: opts.windows,
    checks: summarize(checks, ids),
    info,
  };
}

// ── I1: spend lane byte-identical ─────────────────────────────────────────────

export interface SideViews {
  db: Db;
  views: Views;
}

/** The spend-lane surface of one side, as canonical JSON strings keyed by what they are. */
function spendSurface(side: SideViews): Record<string, string> {
  const out: Record<string, string> = {};
  out.ledger_daily = JSON.stringify(
    side.db
      .prepare(
        `SELECT block_start, day, detector_id, rec_id, component, value_u, tokens,
                pos0_u, pos1_u, pos2_u, pos3_u, pos4_u, pos5_u
           FROM ledger_daily WHERE lane = 'spend'
          ORDER BY block_start, day, detector_id, rec_id, component`,
      )
      .all(),
  );
  out.ledger_daily_top = JSON.stringify(
    side.db
      .prepare(
        `SELECT block_start, day, detector_id, session_id, message_id, ts, value_u
           FROM ledger_daily_top WHERE lane = 'spend' ORDER BY block_start, day, detector_id`,
      )
      .all(),
  );
  out.ledger_daily_sessions = JSON.stringify(
    side.db
      .prepare(
        `SELECT block_start, day, detector_id, session_id, value_u
           FROM ledger_daily_sessions WHERE lane = 'spend'
          ORDER BY block_start, day, detector_id, session_id`,
      )
      .all(),
  );
  const cards = unwrap(side.views.cards) ?? {};
  const list: Array<[string, unknown]> = [];
  for (const l of ["active", "limit_warnings", "adopted", "dismissed", "history", "below_floor"])
    for (const c of Array.isArray(cards[l]) ? cards[l] : [])
      list.push([c.rec_id, c.allocated_u_per_wk]);
  out.cards_allocated_u_per_wk = JSON.stringify(
    list.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  for (const w of [7, 14, 30] as const) {
    const v = unwrap(side.views.diagnostics[w]) ?? {};
    out[`diagnostics_${w}_spend`] = JSON.stringify({
      avoidable: v.avoidable ?? null,
      tiles: {
        avoidable_u: v.tiles?.avoidable_u ?? null,
        avoidable_share: v.tiles?.avoidable_share ?? null,
        avoidable_through: v.tiles?.avoidable_through ?? null,
      },
    });
  }
  return out;
}

export function verifySpendIdentical(baseline: SideViews, candidate: SideViews) {
  const checks = newChecks();
  const a = spendSurface(baseline);
  const b = spendSurface(candidate);
  for (const k of Object.keys(a))
    checks.I1.ok(a[k] === b[k], `spend-differs:${k}`, {
      baseline_bytes: a[k]?.length,
      candidate_bytes: b[k]?.length,
    });
  const failed = checks.I1.fail > 0 ? (["I1"] as CheckId[]) : [];
  return {
    ok: failed.length === 0,
    failed_checks: failed,
    checks: summarize(checks, ["I1"]),
  };
}

// ── Self-check ────────────────────────────────────────────────────────────────

const SELF_E = Date.UTC(2026, 8, 28);
const T = (s: string) => `2026-${s}:00.000Z`;

/** Prices [in, out, cacheRead, cw5m, cw1h] = [2, 10, 1, 3, 4] µ$/token. */
function selfDb(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE turns (message_id TEXT, session_id TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_5m INTEGER, cache_write_1h INTEGER, pricing_snapshot_id TEXT,
      is_sidechain INTEGER NOT NULL DEFAULT 0, provisional INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ledger_daily (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, rec_id TEXT,
      component TEXT, value_u REAL, tokens INTEGER,
      pos0_u REAL DEFAULT 0, pos1_u REAL DEFAULT 0, pos2_u REAL DEFAULT 0, pos3_u REAL DEFAULT 0,
      pos4_u REAL DEFAULT 0, pos5_u REAL DEFAULT 0);
    CREATE TABLE ledger_daily_top (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT,
      session_id TEXT, message_id TEXT, ts TEXT, value_u REAL);
    CREATE TABLE ledger_daily_sessions (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT,
      session_id TEXT, value_u REAL);
    CREATE TABLE ledger_daily_marks (block_start TEXT PRIMARY KEY, block_end TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p1', '[2,10,1,3,4]')").run();
  const t = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,'p1',?,?)");
  // (message, session, ts, in, out, cr, cw5, cw1, sidechain, provisional)
  // s1, day 09-27: a1 (2 failures) -> sc1 (sidechain) / pv1 (provisional) skipped -> r1; a2 -> r2; a3 -> r3 (next day: dropped)
  t.run("a1", "s1", T("09-27T10:00"), 100, 10, 0, 0, 0, 0, 0);
  t.run("sc1", "s1", T("09-27T10:01"), 9999, 999, 0, 0, 0, 1, 0);
  t.run("pv1", "s1", T("09-27T10:02"), 7777, 777, 0, 0, 0, 0, 1);
  t.run("r1", "s1", T("09-27T10:03"), 1000, 100, 0, 0, 0, 0, 0); // 2000 + 1000 = 3000
  t.run("a2", "s1", T("09-27T11:00"), 100, 10, 0, 0, 0, 0, 0);
  t.run("r2", "s1", T("09-27T11:05"), 500, 50, 2000, 0, 0, 0, 0); // 1000 + 500 + 2000 = 3500
  t.run("a3", "s1", T("09-27T23:59"), 100, 10, 0, 0, 0, 0, 0);
  t.run("r3", "s1", T("09-28T00:05"), 800, 0, 0, 0, 0, 0, 0); // 1600, outside block 0
  // s2, day 09-25: C2 failure a4 -> r4
  t.run("a4", "s2", T("09-25T12:00"), 100, 10, 0, 0, 0, 0, 0);
  t.run("r4", "s2", T("09-25T12:01"), 0, 0, 1000, 1000, 0, 0, 0); // 1000 + 3000 = 4000
  // s3: a5 is the last turn of its session: no claim
  t.run("a5", "s3", T("09-26T08:00"), 100, 10, 0, 0, 0, 0, 0);
  // s1, 09-20 (block 1): D14 failure a6 -> r6
  t.run("a6", "s1", T("09-20T10:00"), 100, 10, 0, 0, 0, 0, 0);
  t.run("r6", "s1", T("09-20T10:02"), 300, 30, 0, 0, 0, 0, 0); // 600 + 300 = 900
  const g = grid(SELF_E);
  const b0 = g[0]?.start ?? "";
  const b1 = g[1]?.start ?? "";
  const ins = db.prepare(
    "INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens) VALUES (?,?,?,?,?,?,?,?)",
  );
  // C7 day 09-27: r1 + r2 = 6500; C2 09-25: r4 = 4000; D14 09-20: r6 = 900.
  ins.run(b0, "2026-09-27", "reliability", "C7", "", "input", 3000, 1500);
  ins.run(b0, "2026-09-27", "reliability", "C7", "", "output", 1500, 150);
  ins.run(b0, "2026-09-27", "reliability", "C7", "", "cacheRead", 2000, 2000);
  ins.run(b0, "2026-09-25", "reliability", "C2", "", "cacheRead", 1000, 1000);
  ins.run(b0, "2026-09-25", "reliability", "C2", "", "cw5m", 3000, 1000);
  ins.run(b1, "2026-09-20", "reliability", "D14", "", "input", 600, 300);
  ins.run(b1, "2026-09-20", "reliability", "D14", "", "output", 300, 30);
  ins.run(b0, "2026-09-27", "spend", "D2", "recA", "cacheRead", 900, 900);
  db.prepare(
    "INSERT INTO ledger_daily_top VALUES (?, '2026-09-27', 'spend', 'D2', 's1', 'a1', ?, 900)",
  ).run(b0, T("09-27T10:00"));
  db.prepare(
    "INSERT INTO ledger_daily_sessions VALUES (?, '2026-09-27', 'spend', 'D2', 's1', 900)",
  ).run(b0);
  const mark = db.prepare("INSERT INTO ledger_daily_marks VALUES (?,?)");
  for (const b of g) mark.run(b.start, b.end);
  return db as unknown as Db;
}

/** Issuing events the certified census would report for the fixture (event ts = turn ts). */
const SELF_EVENTS: Array<Issuing & { ts: string }> = [
  { family: "C7", session: "s1", message: "a1", ts: T("09-27T10:00") },
  { family: "C7", session: "s1", message: "a1", ts: T("09-27T10:00") }, // two failures, one turn
  { family: "C7", session: "s1", message: "a2", ts: T("09-27T11:00") },
  { family: "C7", session: "s1", message: "a3", ts: T("09-27T23:59") },
  { family: "C2", session: "s2", message: "a4", ts: T("09-25T12:00") },
  { family: "C7", session: "s3", message: "a5", ts: T("09-26T08:00") },
  { family: "D14", session: "s1", message: "a6", ts: T("09-20T10:00") },
];
const selfIssuing: IssuingFn = (_db, start, end) =>
  SELF_EVENTS.filter((ev) => ev.ts >= start && ev.ts < end);

/** Fixture dumps. Reliability replan_u derived by hand from the comments in selfDb. */
function selfViews(): Views {
  const diag = (w: number, replan: Array<[string, number | null]>) => ({
    window_days: w,
    tiles: { avoidable_u: 900, avoidable_share: 0.1, avoidable_through: iso(SELF_E) },
    avoidable: {
      banner: null,
      causes: [{ cause_id: "CONTEXT_TOO_LARGE", avoidable_u: 900, example: "x" }],
    },
    reliability: {
      causes: replan.map(([cause_id, replan_u]) => ({
        cause_id,
        cost: { wait_ms: null, replan_u },
      })),
      risk: null,
    },
  });
  const rows = (interrupted: number | null): Array<[string, number | null]> => [
    ["SHELL_FAILS_IN_BURSTS", 6500],
    ["SEARCHES_FOR_MISSING_CONTENT", 4000],
    ["INTERRUPTED_OR_CANCELLED", interrupted],
    ["AGENT_REPEATS_SAME_ERROR", null],
    ["TOOLS_FAIL_MORE_THAN_USUAL", null],
  ];
  return {
    cards: {
      data: { active: [{ rec_id: "recA", allocated_u_per_wk: 900 }], history: [], adopted: [] },
    },
    diagnostics: { 7: diag(7, rows(null)), 14: diag(14, rows(900)), 30: diag(30, rows(900)) },
  };
}

const dump = (db: Db, sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

const MUTATIONS: Array<{
  name: string;
  fails: CheckId;
  what: string;
  apply: (side: SideViews, base: SideViews) => void;
}> = [
  {
    name: "priced the issuing turns (a1+a2+a3, 220 each) instead of the recovery turns",
    fails: "I2",
    what: "value-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET value_u = value_u * 220 / 6500 WHERE detector_id = 'C7'",
      ),
  },
  {
    name: "recovery includes the sidechain turn (sc1 = 29 988 µ$ added)",
    fails: "I2",
    what: "value-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET value_u = value_u + 29988 WHERE detector_id = 'C7' AND component = 'input'",
      ),
  },
  {
    name: "recovery includes the provisional turn (pv1 = 23 324 µ$ added)",
    fails: "I2",
    what: "value-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET value_u = value_u + 23324 WHERE detector_id = 'C7' AND component = 'input'",
      ),
  },
  {
    name: "off by one: a2 (220) priced instead of r1 (3000)",
    fails: "I2",
    what: "value-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET value_u = value_u - 2780 WHERE detector_id = 'C7' AND component = 'input'",
      ),
  },
  {
    name: "no dedup: r1 (3000) priced twice for a1's two failures",
    fails: "I2",
    what: "value-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET value_u = value_u + 3000 WHERE detector_id = 'C7' AND component = 'input'",
      ),
  },
  {
    name: "recovery outside the window kept (r3 = 1600 on 09-28)",
    fails: "I2",
    what: "value-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens) VALUES (?, '2026-09-28', 'reliability', 'C7', '', 'input', 1600, 800)",
        grid(SELF_E)[0]?.start,
      ),
  },
  {
    name: "claim after the session ended (a5 has no recovery turn)",
    fails: "I2",
    what: "value-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens) VALUES (?, '2026-09-26', 'reliability', 'C7', '', 'input', 220, 110)",
        grid(SELF_E)[0]?.start,
      ),
  },
  {
    name: "reliability lane priced a detector that is not a family",
    fails: "I2",
    what: "foreign-detector-in-reliability-lane",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET detector_id = 'D2' WHERE lane = 'reliability' AND detector_id = 'D14'",
      ),
  },
  {
    name: "I3 reliability on a day above everything billed that day",
    fails: "I3",
    what: "reliability<=billed",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET value_u = 50000 WHERE detector_id = 'C2' AND component = 'cacheRead'",
      ),
  },
  {
    name: "I4 replan_u off by one",
    fails: "I4",
    what: "replan_u!=sum(ledger)",
    apply: (s) => {
      s.views.diagnostics[7].reliability.causes[0].cost.replan_u = 6501;
    },
  },
  {
    name: "I4 replan_u null although the family has rows (main's behaviour)",
    fails: "I4",
    what: "replan_u!=sum(ledger)",
    apply: (s) => {
      s.views.diagnostics[30].reliability.causes[1].cost.replan_u = null;
    },
  },
  {
    name: "I4 replan_u 0 instead of null for a family without rows",
    fails: "I4",
    what: "replan_u-not-null-without-rows",
    apply: (s) => {
      s.views.diagnostics[7].reliability.causes[2].cost.replan_u = 0;
    },
  },
  {
    name: "I4 loop cause (no family) shows a figure",
    fails: "I4",
    what: "replan_u-not-null-without-rows",
    apply: (s) => {
      s.views.diagnostics[14].reliability.causes[3].cost.replan_u = 6500;
    },
  },
  {
    name: "I1 spend ledger value perturbed by 1 µ$",
    fails: "I1",
    what: "spend-differs:ledger_daily",
    apply: (s) =>
      void dump(s.db, "UPDATE ledger_daily SET value_u = value_u + 1 WHERE lane = 'spend'"),
  },
  {
    name: "I1 card allocated_u_per_wk changed",
    fails: "I1",
    what: "spend-differs:cards_allocated_u_per_wk",
    apply: (s) => {
      s.views.cards.data.active[0].allocated_u_per_wk = 901;
    },
  },
  {
    name: "I1 Diagnostics spend tile changed",
    fails: "I1",
    what: "spend-differs:diagnostics_14_spend",
    apply: (s) => {
      s.views.diagnostics[14].tiles.avoidable_u = 901;
    },
  },
  {
    name: "I1 Diagnostics spend cause figure changed",
    fails: "I1",
    what: "spend-differs:diagnostics_30_spend",
    apply: (s) => {
      s.views.diagnostics[30].avoidable.causes[0].avoidable_u = 901;
    },
  },
];

function selfCheck(): number {
  let bad = 0;
  const report = (name: string, ok: boolean, detail = "") => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const opts = { asOf: iso(SELF_E), windows: [7, 14, 30] as Array<7 | 14 | 30> };
  const side = (): SideViews => ({ db: selfDb(), views: selfViews() });

  const clean = verify(selfDb(), selfViews(), opts, selfIssuing);
  report(
    "clean case passes I2/I3/I4",
    clean.ok,
    clean.ok ? "" : JSON.stringify(clean.failed_checks),
  );
  report(
    "clean case exercised every check",
    Object.values(clean.checks).every((c) => c.pass > 0),
    Object.values(clean.checks)
      .map((c) => c.pass)
      .join(","),
  );
  const want = clean.info.per_family_7d as Record<string, { ledger_u: number; recovery_u: number }>;
  report(
    "hand-derived 7d recovery figures (C7 6500, C2 4000)",
    want.C7?.recovery_u === 6500 && want.C2?.recovery_u === 4000 && want.D14 === undefined,
    JSON.stringify(want),
  );
  const same = verifySpendIdentical(side(), side());
  report("I1 identical sides pass", same.ok && (same.checks.I1?.pass ?? 0) > 0);

  for (const m of MUTATIONS) {
    const cand = side();
    m.apply(cand, side());
    const r =
      m.fails === "I1"
        ? verifySpendIdentical(side(), cand)
        : verify(cand.db, cand.views, opts, selfIssuing);
    const labelled = (r.checks[m.fails]?.by_what?.[m.what] ?? 0) > 0;
    report(
      `mutation caught: ${m.name}`,
      r.failed_checks.includes(m.fails) && labelled,
      `failed=${JSON.stringify(r.failed_checks)} want=${m.fails}/${m.what}`,
    );
  }
  console.log(bad === 0 ? "SELF-CHECK PASS" : `SELF-CHECK FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: l8-reliability-lane-check.ts --db <sqlite> --views <dir> --as-of <iso> [--window 7|14|30]\n         | --baseline <views dir> --baseline-db <sqlite> --candidate <views dir> --candidate-db <sqlite>\n         | --self-check`,
  );
  process.exit(2);
}

function readViews(dir: string, windows: Array<7 | 14 | 30>, withCards: boolean): Views {
  const read = (name: string): Json => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) usage(`missing views file: ${p}`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  return {
    ...(withCards ? { cards: read("cards.json") } : {}),
    diagnostics: Object.fromEntries(windows.map((w) => [w, read(`diagnostics-${w}.json`)])),
  };
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
    "--window",
    "--baseline",
    "--baseline-db",
    "--candidate",
    "--candidate-db",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--self-check") return selfCheck();
    if (a === "--no-sidechain-filter") continue;
    if (!valued.has(a)) usage(`Unknown flag ${a}`);
    const val = argv[++i];
    if (val === undefined || val.startsWith("--")) usage(`Missing value for ${a}`);
    flags.set(a, val);
  }
  const win = flags.get("--window");
  if (win !== undefined && win !== "7" && win !== "14" && win !== "30")
    usage("--window must be 7, 14 or 30");
  const windows = (win === undefined ? [7, 14, 30] : [Number(win)]) as Array<7 | 14 | 30>;
  const wantI2 = flags.has("--db");
  const wantI1 = flags.has("--baseline") || flags.has("--candidate");
  if (!wantI2 && !wantI1) usage("nothing to check");
  let code = 0;

  if (wantI2) {
    const asOf = flags.get("--as-of");
    const viewsDir = flags.get("--views");
    if (!asOf || !Number.isFinite(new Date(asOf).getTime())) usage("--as-of must be an ISO date");
    if (!viewsDir) usage("--views is required with --db");
    const db = openDb(flags.get("--db") ?? "");
    try {
      const report = verify(
        db,
        readViews(viewsDir, windows, false),
        {
          asOf,
          windows,
          ...(argv.includes("--no-sidechain-filter")
            ? {}
            : {
                sidechain: await (
                  await import("./sidechain-reliability-check.js")
                ).sidechainValueMap(db, asOf),
              }),
        },
        await censusIssuing(),
      );
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) code = 1;
    } finally {
      db.close();
    }
  }

  if (wantI1) {
    const need = ["--baseline", "--baseline-db", "--candidate", "--candidate-db"];
    for (const f of need) if (!flags.get(f)) usage(`${f} is required for I1`);
    const all: Array<7 | 14 | 30> = [7, 14, 30];
    const b = openDb(flags.get("--baseline-db") ?? "");
    const c = openDb(flags.get("--candidate-db") ?? "");
    try {
      const report = verifySpendIdentical(
        { db: b, views: readViews(flags.get("--baseline") ?? "", all, true) },
        { db: c, views: readViews(flags.get("--candidate") ?? "", all, true) },
      );
      console.log(JSON.stringify(report, null, 2));
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
