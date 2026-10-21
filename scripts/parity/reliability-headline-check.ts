/**
 * P3.L-F — independent oracle for "reliability cards get a ledger headline (recovery-turn $/wk)".
 * Contract: docs/plans/Archive/2026-09-30-reliability-card-headline-spec.md, "Invariants" (I1-I5).
 *
 * Written before the implementation. The only src/ imports are the two the spec allows:
 * `recId()` (pure hash) and `wastedTurnCensus` (certified, unchanged; loaded lazily, real runs only).
 * Everything else is restated: the per-family rec scope keys (read from the detector files, rebuilt
 * here from raw tables), the recovery turn R(t), the collision rule, and pricing (raw tokens x
 * `pricing_snapshots` unit prices).
 *
 *   npx tsx scripts/parity/reliability-headline-check.ts --db <prepared copy> --cards <cand cards.json>
 *       --baseline-cards <baseline cards.json> [--baseline-db <baseline prepared copy>]
 *       [--now <UTC midnight iso, default 2026-09-28T00:00:00.000Z>] [--seed]
 *   npx tsx scripts/parity/reliability-headline-check.ts --self-check
 *
 * `cards.json` is `buildRecommendations` output written by l9-dump-views.ts. It carries the full
 * card objects (so `reliability_u_per_wk` is visible) and the display groups. The card window is the
 * trailing 7d ending at --now, which for a UTC-midnight --now is exactly ledger block 0.
 *
 * I1  spend lane identical to baseline: every card's allocated_u_per_wk / modeled_savings_u_per_wk,
 *     list order, group membership and the rest of the document (reliability cards are compared on
 *     their spend fields only, non-reliability cards byte-for-byte minus `reliability_u_per_wk`;
 *     top-level meta.window is wall-clock and ignored); with --baseline-db also the ledger_daily
 *     spend rows.
 * I2  per day x family, sum of reliability value_u/tokens in ledger_daily == oracle claims (all 9
 *     blocks); with --baseline-db also == the baseline DB. If ledger_daily was written by candidate
 *     code (any reliability row has a rec_id) the per (day, family, rec_id) split must match too.
 *     A DB prepared by baseline code cannot show rec_id, so that part is skipped and noted.
 * I3  per reliability card: reliability_u_per_wk == oracle (issuing event -> rec key from raw tables
 *     -> R(t) -> collision rule 3 -> LEDGER_PRIORITY -> raw tokens x prices, rounded).
 * I4  sum of reliability cards + orphan (rec ids with no card) == reliability lane total in the window.
 * I5  non-reliability cards: reliability_u_per_wk null/absent; reliability cards: a finite number >= 0.
 *
 * Exit 0 = every invariant passed; 1 = a FAIL; 2 = bad flags/inputs. DBs are opened read-only.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { recId } from "../../src/detector/rec-id.js";

type Db = Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: dump files are untrusted JSON; every read below is checked before use
type Json = any;

// ── Restatements ──────────────────────────────────────────────────────────────

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

/** LEDGER_PRIORITY, reliability lane part (first wins a shared turn cell). */
const FAMILIES = ["C7", "C3", "C4", "C1", "C2", "C9", "D14", "D11"] as const;
type Family = (typeof FAMILIES)[number];
const RANK = new Map<string, number>(FAMILIES.map((f, i) => [f, i]));
const isFamily = (x: unknown): x is Family => typeof x === "string" && RANK.has(x);

const COMPONENTS = 5; // [in, out, cacheRead, cw5m, cw1h]
const TOKEN_COLS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_5m",
  "cache_write_1h",
] as const;

const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);
const near = (a: number, b: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b)));
/** An API integer vs an unrounded figure (half-way cases may round either way). */
function roundEq(got: number, x: number): boolean {
  if (got === Math.round(x)) return true;
  const frac = x - Math.floor(x);
  return Math.abs(frac - 0.5) < 1e-6 && Math.abs(got - x) <= 0.5 + 1e-6;
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The C9 label the detector keys on (c9_denial_friction.ts labelFor). */
function c9Label(raw: string | null): string {
  if (raw === "hook-block") return "HOOK_BLOCK";
  if (raw === "deny-rule") return "DENY_RULE";
  return "USER_REJECTED";
}

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

// ── Issuing events and rec keys ───────────────────────────────────────────────

/** One failure event of a family, on the turn that issued it. */
export interface Issuing {
  family: Family;
  chain: "main" | "sidechain";
  session: string;
  /** The issuing (owner) turn. */
  message: string;
  /** The issuing session's workspace (null if the session row is missing). */
  ws: string | null;
  /** C9: classifier_label of the denial row; D14: tool_events.interrupt_kind. Else null. */
  extra: string | null;
}
export type IssuingFn = (db: Db, start: string, end: string) => Issuing[];

/** Mutations of the oracle's own model; used only by --self-check to build a buggy candidate. */
export type BugName =
  | "no_rec_id"
  | "c3_session_key"
  | "c1_ws_key"
  | "collision_split"
  | "collision_both"
  | "collision_first_seen"
  | "collision_tie_highest"
  | "no_sidechain";
export type Bug = Partial<Record<BugName, true>>;

/**
 * The rec id the detector would stamp on this event's rec (keys read from the detector files:
 * c7 `C7|ws`, c3 `C3|ws` (one card per workspace, U7), c4 `C4|ws|session`, c1 `C1` global, c2 `C2|ws`, c9 `C9|ws|label`,
 * d14 `D14|ws|session|interrupt_kind`, d11 `D11|tool-error-rate|ws`). null = not buildable.
 */
function recIdOf(ev: Issuing, bug: Bug): string | null {
  if (bug.no_rec_id) return "";
  const { family, ws, session, extra } = ev;
  if (family === "C1") return recId("C1", bug.c1_ws_key ? ws : null, "C1");
  if (ws === null) return null;
  switch (family) {
    case "C7":
      return recId("C7", ws, `C7|${ws}`);
    case "C3":
      return recId("C3", ws, bug.c3_session_key ? `C3|${ws}|${session}` : `C3|${ws}`);
    case "C4":
      return recId("C4", ws, `C4|${ws}|${session}`);
    case "C2":
      return recId("C2", ws, `C2|${ws}`);
    case "C9":
      return extra === null ? null : recId("C9", ws, `C9|${ws}|${c9Label(extra)}`);
    case "D14":
      return extra === null ? null : recId("D14", ws, `D14|${ws}|${session}|${extra}`);
    case "D11":
      return recId("D11", ws, `D11|tool-error-rate|${ws}`);
  }
}

/** Real issuing events: the certified census, main + sidechain pass (spec rules 1, 5). */
async function censusIssuing(): Promise<IssuingFn> {
  const mod = await import("../../src/detector/turn-claim.js");
  return (db, start, end) => {
    const ctx = { now: new Date(end), fromIso: start, toIso: end } as never;
    const wsQ = db.prepare("SELECT workspace_id FROM sessions WHERE session_id = ?");
    const toolQ = db.prepare(
      `SELECT e.session_id AS s, m.owner_message_id AS m, e.interrupt_kind AS kind
         FROM tool_events e JOIN tool_event_metadata m ON m.event_id = e.event_id
        WHERE e.event_id = ? AND m.owner_message_id IS NOT NULL`,
    );
    const denialQ = db.prepare(
      "SELECT session_id, event_ts, classifier_label FROM ingest_metric_events WHERE event_id = ?",
    );
    const c9OwnerQ = db.prepare(
      `SELECT message_id AS m FROM turns WHERE session_id = ? AND is_sidechain = 0 AND ts <= ?
        ORDER BY ts DESC LIMIT 1`,
    );
    const out: Issuing[] = [];
    for (const chain of ["main", "sidechain"] as const) {
      const census = mod.wastedTurnCensus(db as never, ctx, chain);
      for (const family of FAMILIES) {
        const claimed = census.claims.get(family) ?? new Set<string>();
        for (const eventId of census.claimEventIds.get(family) ?? []) {
          let session: string;
          let message: string;
          let extra: string | null = null;
          if (family === "C9") {
            const d = denialQ.get(eventId) as
              | { session_id: string; event_ts: string; classifier_label: string }
              | undefined;
            const o = d && (c9OwnerQ.get(d.session_id, d.event_ts) as { m: string } | undefined);
            if (!d || !o) continue;
            session = d.session_id;
            message = o.m;
            extra = d.classifier_label;
          } else {
            const r = toolQ.get(eventId) as
              | { s: string; m: string; kind: string | null }
              | undefined;
            if (r === undefined) continue;
            session = r.s;
            message = r.m;
            extra = family === "D14" ? r.kind : null;
          }
          if (!claimed.has(`${session}|${message}`)) continue;
          const ws = (wsQ.get(session) as { workspace_id: string } | undefined)?.workspace_id;
          out.push({ family, chain, session, message, ws: ws ?? null, extra });
        }
      }
    }
    return out;
  };
}

// ── Claims: R(t), collision rule, pricing ─────────────────────────────────────

export interface Claim {
  block: number;
  day: string;
  family: Family;
  recId: string;
  session: string;
  message: string;
  value: number;
  tokens: number;
  /** card review F2/F4/F5/F7 (2026-10-04): chain of the issuing turn; sidechain claims are priced at a sidechain R. */
  chain: "main" | "sidechain";
}

interface TurnRow {
  message: string;
  ts: string;
  unit_prices_json: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

function price(r: TurnRow): { value: number; tokens: number } {
  let p: number[] | null = null;
  if (r.unit_prices_json !== null) {
    try {
      const v: unknown = JSON.parse(r.unit_prices_json);
      if (
        Array.isArray(v) &&
        v.length === COMPONENTS &&
        v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
      )
        p = v;
    } catch {
      /* unpriceable: value 0 */
    }
  }
  let value = 0;
  let tokens = 0;
  TOKEN_COLS.forEach((col, i) => {
    const n = r[col];
    if (n > 0) {
      tokens += n;
      value += n * (p?.[i] ?? 0);
    }
  });
  return { value, tokens };
}

const R_SELECT = `SELECT r.message_id AS message, r.ts AS ts, p.unit_prices_json,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_5m, r.cache_write_1h
  FROM turns r LEFT JOIN pricing_snapshots p ON p.snapshot_id = r.pricing_snapshot_id`;

/**
 * Priced reliability claims of all blocks, with rec ids (spec rules 1-5):
 *  R(t) = first settled turn of t's chain after t (main: is_sidechain 0; sidechain: same agent_id);
 *  dropped when R is outside the producer block; dedup unit (family, rec, R); when several recs of
 *  one family share R the one with the most issuing events wins the whole turn (tie: lowest rec id);
 *  then a turn wanted by several families goes to the first in LEDGER_PRIORITY.
 */
export function oracleClaims(db: Db, e: number, issuing: IssuingFn, bug: Bug = {}): Claim[] {
  const tQ = db.prepare("SELECT ts, agent_id FROM turns WHERE session_id = ? AND message_id = ?");
  const mainQ = db.prepare(
    `${R_SELECT} WHERE r.session_id = ? AND r.is_sidechain = 0 AND r.provisional = 0 AND r.ts > ?
      ORDER BY r.ts, r.message_id LIMIT 1`,
  );
  const scQ = db.prepare(
    `${R_SELECT} WHERE r.session_id = ? AND r.is_sidechain = 1 AND r.provisional = 0
        AND r.agent_id = ? AND r.ts > ? ORDER BY r.ts, r.message_id LIMIT 1`,
  );
  const out: Claim[] = [];
  grid(e).forEach(({ start, end }, block) => {
    type Cell = {
      family: Family;
      session: string;
      r: TurnRow;
      chain: "main" | "sidechain";
      recs: Map<string, number>;
    };
    const cells = new Map<string, Cell>();
    for (const ev of issuing(db, start, end)) {
      if (bug.no_sidechain && ev.chain === "sidechain") continue;
      const t = tQ.get(ev.session, ev.message) as
        | { ts: string; agent_id: string | null }
        | undefined;
      if (t === undefined) continue;
      let r: TurnRow | undefined;
      if (ev.chain === "main") r = mainQ.get(ev.session, t.ts) as TurnRow | undefined;
      else if (t.agent_id !== null)
        r = scQ.get(ev.session, t.agent_id, t.ts) as TurnRow | undefined;
      if (r === undefined || r.ts < start || r.ts >= end) continue; // no recovery turn / outside window
      const rid = recIdOf(ev, bug) ?? `UNKEYABLE|${ev.family}|${ev.session}|${ev.message}`;
      const key = `${ev.family}\0${ev.session}\0${r.message}`;
      const cell = cells.get(key) ?? {
        family: ev.family,
        session: ev.session,
        r,
        chain: ev.chain,
        recs: new Map(),
      };
      cell.recs.set(rid, (cell.recs.get(rid) ?? 0) + 1);
      cells.set(key, cell);
    }
    // Rule 3: one winner rec per (family, R).
    const byTurn = new Map<
      string,
      Array<{ family: Family; rec: string; share: number; c: Cell }>
    >();
    for (const c of cells.values()) {
      const recs = [...c.recs];
      let picked: Array<[string, number]>;
      if (bug.collision_split || bug.collision_both) picked = recs;
      else if (bug.collision_first_seen) picked = recs.slice(0, 1);
      else {
        const sorted = [...recs].sort(
          (a, b) =>
            b[1] - a[1] ||
            (bug.collision_tie_highest ? (a[0] < b[0] ? 1 : -1) : a[0] < b[0] ? -1 : 1),
        );
        picked = sorted.slice(0, 1);
      }
      const share = bug.collision_split ? 1 / picked.length : 1;
      const tk = `${c.session}\0${c.r.message}`;
      const list = byTurn.get(tk) ?? [];
      for (const [rec] of picked) list.push({ family: c.family, rec, share, c });
      byTurn.set(tk, list);
    }
    // Rule 4: across families, LEDGER_PRIORITY wins the turn.
    for (const list of byTurn.values()) {
      const best = Math.min(...list.map((x) => RANK.get(x.family) ?? 99));
      for (const x of list) {
        if ((RANK.get(x.family) ?? 99) !== best) continue;
        const p = price(x.c.r);
        out.push({
          block,
          day: x.c.r.ts.slice(0, 10),
          family: x.family,
          recId: x.rec,
          session: x.c.session,
          message: x.c.r.message,
          value: p.value * x.share,
          tokens: p.tokens * x.share,
          chain: x.c.chain,
        });
      }
    }
  });
  return out;
}

// ── Cards ─────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, Json> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isCardObj = (v: unknown): v is Record<string, Json> =>
  isObj(v) && typeof v.rec_id === "string" && typeof v.detector_id === "string";

/**
 * card review F2/F4/F5/F7 (2026-10-04), F5: safety cards are every H1 card and the C9 HOOK_BLOCK cards
 * (rec key `C9|ws|HOOK_BLOCK`); other C9 cards (user-rejected, deny-rule) keep their $.
 */
function isSafetyCard(card: Record<string, Json>): boolean {
  if (card.detector_id === "H1") return true;
  if (card.detector_id !== "C9" || typeof card.scope_workspace_id !== "string") return false;
  const ws: string = card.scope_workspace_id;
  // The guard-block card has the workspace-level key and, in the dump, further per-rule recs under the
  // same title; the spec names the card by that title.
  return (
    card.rec_id === recId("C9", ws, `C9|${ws}|HOOK_BLOCK`) ||
    card.title === "Check the calls your PreToolUse guard keeps blocking."
  );
}

/** Every card object anywhere in the JSON; first rec_id wins. */
export function collectCards(json: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  const walk = (v: Json) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isObj(v)) return;
    if (isCardObj(v)) {
      if (!out.has(v.rec_id)) out.set(v.rec_id, v);
      return;
    }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(json);
  return out;
}

/** Spend-lane surface of a reliability card; everything else on it (text, trigger) may change. */
const RELIABILITY_CARD_KEYS = [
  "rec_id",
  "detector_id",
  "scope_workspace_id",
  "category",
  "allocated_u_per_wk",
  "modeled_savings_u_per_wk",
  "pct_of_weekly_spend",
  "range_u_per_wk",
] as const;

/** The document with the new field removed, reliability cards reduced to spend fields, no wall-clock window. */
function normalize(doc: Json): string {
  const norm = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(norm);
    if (!isObj(v)) return v;
    if (isCardObj(v)) {
      if (isFamily(v.detector_id))
        return Object.fromEntries(RELIABILITY_CARD_KEYS.map((k) => [k, v[k] ?? null]));
      // card review F2/F4/F5/F7 (2026-10-04): safety_lane / sidechain figure are new fields too.
      const {
        reliability_u_per_wk: _drop,
        reliability_sidechain_u_per_wk: _drop2,
        safety_lane: _drop3,
        ...rest
      } = v;
      return rest;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  };
  let d = doc;
  if (isObj(d) && isObj(d.meta)) {
    const { window: _w, ...meta } = d.meta;
    d = { ...d, meta };
  }
  return JSON.stringify(norm(d));
}

/** Path -> rec_id sequence of every array of cards (lists and group `recs`): order and membership. */
function listsOf(doc: Json): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (v: Json, p: string) => {
    if (Array.isArray(v)) {
      const ids = v.filter(isCardObj).map((c) => c.rec_id as string);
      if (ids.length > 0) out.set(p, ids);
      else v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (!isObj(v) || isCardObj(v)) return;
    for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
  };
  walk(doc, "$");
  return out;
}

// ── verify ────────────────────────────────────────────────────────────────────

export interface Opts {
  e: number;
  issuing: IssuingFn;
  seed: boolean;
  baselineDb?: Db;
}

const sumBy = (claims: Claim[], keyOf: (c: Claim) => string | null) => {
  const m = new Map<string, { v: number; t: number }>();
  for (const c of claims) {
    const k = keyOf(c);
    if (k === null) continue;
    const cur = m.get(k) ?? { v: 0, t: 0 };
    cur.v += c.value;
    cur.t += c.tokens;
    m.set(k, cur);
  }
  return m;
};

function ledgerByDayFamily(db: Db, e: number, withRec: boolean) {
  const starts = JSON.stringify(grid(e).map((b) => b.start));
  const rows = db
    .prepare(
      `SELECT day, detector_id AS family, ${withRec ? "rec_id" : "''"} AS rec, SUM(value_u) AS v,
              SUM(tokens) AS t
         FROM ledger_daily WHERE lane = 'reliability'
          AND block_start IN (SELECT value FROM json_each(?))
        GROUP BY day, detector_id${withRec ? ", rec_id" : ""}`,
    )
    .all(starts) as Array<{ day: string; family: string; rec: string; v: number; t: number }>;
  return new Map(
    rows.map((r) => [`${r.day}|${r.family}${withRec ? `|${r.rec}` : ""}`, { v: r.v, t: r.t }]),
  );
}

export function verify(db: Db, cand: Json, base: Json, opts: Opts) {
  const { e } = opts;
  const checks = Object.fromEntries(CHECK_IDS.map((id) => [id, new Check()])) as Record<
    CheckId,
    Check
  >;
  const info: Record<string, unknown> = {};
  const candCards = collectCards(cand);
  const baseCards = collectCards(base);
  const claims = oracleClaims(db, e, opts.issuing);

  // ── I1: spend lane identical to baseline.
  checks.I1.ok(
    candCards.size === baseCards.size && [...candCards.keys()].every((k) => baseCards.has(k)),
    "card-set-differs",
    { candidate: candCards.size, baseline: baseCards.size },
  );
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [id, card] of candCards) {
    const b = baseCards.get(id);
    if (b === undefined) continue;
    for (const f of ["allocated_u_per_wk", "modeled_savings_u_per_wk"] as const)
      checks.I1.ok(same(card[f], b[f]), `${f}-changed`, {
        rec_id: id,
        candidate: card[f],
        baseline: b[f],
      });
  }
  const cl = listsOf(cand);
  const bl = listsOf(base);
  for (const k of new Set([...cl.keys(), ...bl.keys()]))
    checks.I1.ok(same(cl.get(k), bl.get(k)), "order-or-membership-differs", {
      path: k,
      candidate: cl.get(k)?.slice(0, 6),
      baseline: bl.get(k)?.slice(0, 6),
    });
  checks.I1.ok(normalize(cand) === normalize(base), "document-differs");
  if (opts.baselineDb !== undefined) {
    const spend = (d: Db) =>
      JSON.stringify(
        d
          .prepare(
            `SELECT block_start, day, detector_id, rec_id, component, value_u, tokens,
                    pos0_u, pos1_u, pos2_u, pos3_u, pos4_u, pos5_u
               FROM ledger_daily WHERE lane = 'spend'
              ORDER BY block_start, day, detector_id, rec_id, component`,
          )
          .all(),
      );
    checks.I1.ok(spend(db) === spend(opts.baselineDb), "ledger-spend-rows-differ");
  }

  // ── I2: family totals per day (and per rec when the ledger was written by candidate code).
  const marks = db.prepare("SELECT block_end FROM ledger_daily_marks WHERE block_start = ?");
  const unmarked = grid(e).filter(
    (b) => (marks.get(b.start) as { block_end: string } | undefined)?.block_end !== b.end,
  );
  checks.I2.ok(unmarked.length === 0, "marks-incomplete", { missing: unmarked.length });
  const wantDF = sumBy(claims, (c) => `${c.day}|${c.family}`);
  const haveDF = ledgerByDayFamily(db, e, false);
  for (const k of new Set([...wantDF.keys(), ...haveDF.keys()])) {
    const w = wantDF.get(k) ?? { v: 0, t: 0 };
    const h = haveDF.get(k) ?? { v: 0, t: 0 };
    checks.I2.ok(near(h.v, w.v) && near(h.t, w.t), "family-day-total-mismatch", {
      day_family: k,
      ledger_u: h.v,
      oracle_u: w.v,
    });
  }
  if (opts.baselineDb !== undefined) {
    const baseDF = ledgerByDayFamily(opts.baselineDb, e, false);
    for (const k of new Set([...baseDF.keys(), ...haveDF.keys()])) {
      const b = baseDF.get(k)?.v ?? 0;
      const h = haveDF.get(k)?.v ?? 0;
      checks.I2.ok(near(h, b), "family-day-total-vs-baseline", {
        day_family: k,
        baseline_u: b,
        ledger_u: h,
      });
    }
  }
  const haveDFR = ledgerByDayFamily(db, e, true);
  const candidatePrepared = [...haveDFR.keys()].some((k) => !k.endsWith("|"));
  info.ledger_written_by_candidate_code = candidatePrepared;
  if (candidatePrepared) {
    const wantDFR = sumBy(claims, (c) => `${c.day}|${c.family}|${c.recId}`);
    for (const k of new Set([...wantDFR.keys(), ...haveDFR.keys()])) {
      const w = wantDFR.get(k)?.v ?? 0;
      const h = haveDFR.get(k)?.v ?? 0;
      checks.I2.ok(near(h, w), "family-day-rec-mismatch", {
        day_family_rec: k,
        ledger_u: h,
        oracle_u: w,
      });
    }
  } else
    info.note_i2 = "ledger_daily rec_id empty (baseline-prepared DB): per-rec split of I2 skipped";

  // ── I3 / I5: per card.
  const win = claims.filter((c) => c.block === 0);
  // card review F2/F4/F5/F7 (2026-10-04): F2 a card's reliability_u_per_wk is its MAIN-chain claims only;
  // sidechain claims (priced at a subagent recovery turn) go to reliability_sidechain_u_per_wk (absent/null = 0).
  const figure = sumBy(win, (c) => c.recId);
  const figureMain = sumBy(
    win.filter((c) => c.chain === "main"),
    (c) => c.recId,
  );
  const figureSide = sumBy(
    win.filter((c) => c.chain === "sidechain"),
    (c) => c.recId,
  );
  const famOfRec = new Map(win.map((c) => [c.recId, c.family]));
  let nonZero = 0;
  let relCards = 0;
  let safetyU = 0; // oracle $ of recs whose card is a safety card (shown as no $ on the card)
  for (const [id, card] of candCards) {
    const got: unknown = card.reliability_u_per_wk;
    const gotSide: unknown = card.reliability_sidechain_u_per_wk;
    // F5: H1 and C9 HOOK_BLOCK cards are safety cards: safety_lane true, no reliability $.
    const safety = isSafetyCard(card);
    checks.I5.ok(
      safety ? card.safety_lane === true : card.safety_lane !== true,
      safety ? "safety-card-without-safety_lane" : "safety_lane-on-non-safety-card",
      { rec_id: id, detector_id: card.detector_id, safety_lane: card.safety_lane },
    );
    if (!isFamily(card.detector_id) || safety) {
      checks.I5.ok(
        (got === null || got === undefined) && (gotSide === null || gotSide === undefined),
        safety && isFamily(card.detector_id)
          ? "safety-card-has-figure"
          : "non-reliability-card-has-figure",
        { rec_id: id, detector_id: card.detector_id, got, gotSide },
      );
      if (safety && isFamily(card.detector_id)) safetyU += figure.get(id)?.v ?? 0;
      continue;
    }
    relCards++;
    checks.I5.ok(isNum(got) && got >= 0, "reliability-card-without-number", {
      rec_id: id,
      detector_id: card.detector_id,
      got,
    });
    checks.I5.ok(
      gotSide === null || gotSide === undefined || (isNum(gotSide) && gotSide >= 0),
      "sidechain-figure-not-a-number",
      { rec_id: id, detector_id: card.detector_id, gotSide },
    );
    const want = figureMain.get(id)?.v ?? 0;
    const wantSide = figureSide.get(id)?.v ?? 0;
    if (want + wantSide > 0) nonZero++;
    checks.I3.ok(isNum(got) && roundEq(got, want), "reliability_u_per_wk!=oracle", {
      rec_id: id,
      detector_id: card.detector_id,
      got,
      oracle_u: want,
    });
    const sideGot = isNum(gotSide) ? gotSide : 0;
    checks.I3.ok(roundEq(sideGot, wantSide), "reliability_sidechain_u_per_wk!=oracle", {
      rec_id: id,
      detector_id: card.detector_id,
      got: gotSide,
      oracle_u: wantSide,
    });
  }
  const unkeyable = claims.filter((c) => c.recId.startsWith("UNKEYABLE|"));
  checks.I3.ok(unkeyable.length === 0, "unkeyable-issuing-event", {
    count: unkeyable.length,
    first: unkeyable[0]?.recId,
  });
  // Only meaningful when the seed's window has reliability $ to show (the shared seed's lane is $0).
  const windowHasLane = win.some((c) => c.value > 0);
  if (opts.seed && windowHasLane) checks.I3.ok(nonZero > 0, "seed-has-no-nonzero-reliability-card");
  if (opts.seed && !windowHasLane) info.seed_lane_empty = true;

  // ── I4: conservation. Orphan = oracle rec ids that have no card.
  const orphan: Record<string, number> = {};
  let orphanU = 0;
  for (const [rec, s] of figure)
    if (!candCards.has(rec)) {
      const f = famOfRec.get(rec) ?? "?";
      orphan[f] = (orphan[f] ?? 0) + s.v;
      orphanU += s.v;
    }
  let cardsU = 0;
  let cardN = 0;
  for (const card of candCards.values())
    if (isFamily(card.detector_id) && isNum(card.reliability_u_per_wk)) {
      cardsU += card.reliability_u_per_wk;
      if (isNum(card.reliability_sidechain_u_per_wk)) cardsU += card.reliability_sidechain_u_per_wk;
      cardN++;
    }
  const lane = (
    db
      .prepare(
        `SELECT COALESCE(SUM(value_u), 0) AS v FROM ledger_daily
          WHERE lane = 'reliability' AND block_start = ? AND day >= ? AND day < ?`,
      )
      .get(grid(e)[0]?.start, dayStr(e - 7 * DAY_MS), dayStr(e)) as { v: number }
  ).v;
  // F5: safety cards show no $, so their oracle $ joins the unattributed side (like orphans).
  checks.I4.ok(
    Math.abs(cardsU + orphanU + safetyU - lane) <= 1.0 * cardN + tol(lane),
    "cards+orphan+safety!=lane",
    {
      cards_u: cardsU,
      orphan_u: orphanU,
      safety_u: safetyU,
      lane_u: lane,
    },
  );

  // ── Info.
  info.reliability_cards = relCards;
  info.orphan_u_by_family = orphan;
  info.orphan_u_total = orphanU;
  info.cards_u_total = cardsU;
  info.lane_u = lane;
  info.collisions_same_family = collisionCount(db, e, opts.issuing);

  const failed = CHECK_IDS.filter((id) => checks[id].fail > 0);
  return {
    ok: failed.length === 0,
    failed_checks: failed,
    as_of: iso(e),
    checks: Object.fromEntries(
      CHECK_IDS.map((id) => [
        id,
        {
          pass: checks[id].pass,
          fail: checks[id].fail,
          by_what: Object.fromEntries(checks[id].byWhat),
          first_failures: checks[id].rows,
        },
      ]),
    ),
    info,
  };
}

/** Block-0 count of (family, recovery turn) cells where two or more recs of one family compete (rule 3). */
function collisionCount(db: Db, e: number, issuing: IssuingFn): Record<string, number> {
  const withBoth = oracleClaims(db, e, issuing, { collision_both: true }).filter(
    (c) => c.block === 0,
  );
  const normal = oracleClaims(db, e, issuing).filter((c) => c.block === 0);
  const key = (c: Claim) => `${c.family}\0${c.session}\0${c.message}`;
  const n = new Map<string, number>();
  for (const c of withBoth) n.set(key(c), (n.get(key(c)) ?? 0) + 1);
  const out: Record<string, number> = {};
  for (const c of normal) if ((n.get(key(c)) ?? 0) > 1) out[c.family] = (out[c.family] ?? 0) + 1;
  return out;
}

// ── Self-check ────────────────────────────────────────────────────────────────

const SELF_E = Date.UTC(2026, 8, 28);
const T = (s: string) => `2026-${s}:00.000Z`;

/** Prices [in, out, cacheRead, cw5m, cw1h] = [2, 10, 1, 3, 4] µ$/token. */
function selfDb(bug: Bug, o: { baseline?: boolean; mutate?: (db: Db) => void } = {}): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT, workspace_id TEXT, state TEXT);
    CREATE TABLE turns (message_id TEXT, session_id TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_5m INTEGER, cache_write_1h INTEGER, pricing_snapshot_id TEXT,
      is_sidechain INTEGER NOT NULL DEFAULT 0, provisional INTEGER NOT NULL DEFAULT 0, agent_id TEXT);
    CREATE TABLE ledger_daily (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, rec_id TEXT,
      component TEXT, value_u REAL, tokens INTEGER,
      pos0_u REAL DEFAULT 0, pos1_u REAL DEFAULT 0, pos2_u REAL DEFAULT 0, pos3_u REAL DEFAULT 0,
      pos4_u REAL DEFAULT 0, pos5_u REAL DEFAULT 0);
    CREATE TABLE ledger_daily_marks (block_start TEXT PRIMARY KEY, block_end TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p1', '[2,10,1,3,4]')").run();
  const sess = db.prepare("INSERT INTO sessions VALUES (?,?,'RECONCILED')");
  for (const [s, w] of [
    ["s1", "w1"],
    ["s2", "w1"],
    ["s4", "w1"],
    ["s5", "w1"],
    ["s6", "w1"],
    ["s9", "w3"],
    ["s10", "w1"],
    ["s11", "w1"],
    ["s7", "w2"],
    ["s8", "w2"],
  ] as const)
    sess.run(s, w);
  const insT = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,0,'p1',?,?,?)");
  const turn = (
    m: string,
    s: string,
    ts: string,
    tok: [number, number, number, number] = [0, 0, 0, 0],
    x: { sc?: 1; prov?: 1; agent?: string } = {},
  ) => insT.run(m, s, ts, tok[0], tok[1], tok[2], tok[3], x.sc ?? 0, x.prov ?? 0, x.agent ?? null);
  // s1: C7 failures a1 (x2) -> r1 (3000), a2 -> r2 (3500); a2 also has a C3 event (C7 wins r2).
  turn("a1", "s1", T("09-27T10:00"));
  turn("pv1", "s1", T("09-27T10:01"), [7777, 777, 0, 0], { prov: 1 });
  turn("r1", "s1", T("09-27T10:03"), [1000, 100, 0, 0]);
  turn("a2", "s1", T("09-27T11:00"));
  turn("r2", "s1", T("09-27T11:05"), [500, 50, 2000, 0]);
  // s1 sidechain agent A: sa1 -> sa2 (800); agent B and main turns in between are traps.
  turn("sa1", "s1", T("09-27T14:00"), [0, 0, 0, 0], { sc: 1, agent: "A" });
  turn("sb1", "s1", T("09-27T14:01"), [9000, 0, 0, 0], { sc: 1, agent: "B" });
  turn("sa2", "s1", T("09-27T14:02"), [400, 0, 0, 0], { sc: 1, agent: "A" });
  turn("m3", "s1", T("09-27T14:03"), [8000, 0, 0, 0]);
  // C3 per workspace: s2 -> b2 (600) and s4 -> c2 (200) share w1's card; s9 is in w3 -> h2 (1400, no card = orphan).
  turn("b1", "s2", T("09-26T08:00"));
  turn("b2", "s2", T("09-26T08:01"), [300, 0, 0, 0]);
  turn("c1", "s4", T("09-26T09:00"));
  turn("c2", "s4", T("09-26T09:01"), [100, 0, 0, 0]);
  turn("h1", "s9", T("09-26T10:00"));
  turn("h2", "s9", T("09-26T10:01"), [700, 0, 0, 0]);
  // C9 collision: d1 has 1 deny-rule + 2 hook-block denials -> d2 (4000) goes to HOOK_BLOCK.
  turn("d1", "s5", T("09-25T12:00"));
  turn("d2", "s5", T("09-25T12:01"), [0, 0, 1000, 1000]);
  // D14 tie: one PURE_INTERRUPT + one KILLED_NO_PROMPT on e1 -> e2 (400) goes to the lowest rec id.
  turn("e1", "s6", T("09-24T10:00"));
  turn("e2", "s6", T("09-24T10:01"), [200, 0, 0, 0]);
  // C1 (global) and D11 in workspace w2.
  turn("f1", "s7", T("09-23T09:00"));
  turn("f2", "s7", T("09-23T09:01"), [150, 0, 0, 0]);
  turn("g1", "s8", T("09-22T09:00"));
  turn("g2", "s8", T("09-22T09:01"), [50, 5, 0, 0]);
  // s10: C2 k1 -> k2 in block 1 (600); i1's recovery lands after the window (dropped).
  turn("k1", "s10", T("09-20T10:00"));
  turn("k2", "s10", T("09-20T10:02"), [300, 0, 0, 0]);
  turn("i1", "s10", T("09-27T23:59"));
  turn("i2", "s10", T("09-28T00:05"), [800, 0, 0, 0]);
  // s11: the failing turn is its last turn: no claim, the card shows 0.
  turn("j1", "s11", T("09-27T09:00"));

  // Claims -> ledger_daily. The baseline DB carries no rec ids; the candidate DB has them.
  const claims = oracleClaims(db as unknown as Db, SELF_E, selfIssuing, bug);
  const g = grid(SELF_E);
  const ins = db.prepare(
    "INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens) VALUES (?,?,'reliability',?,?,'input',?,?)",
  );
  const rows = sumBy(claims, (c) => `${c.block}|${c.day}|${c.family}|${o.baseline ? "" : c.recId}`);
  for (const [k, s] of rows) {
    const [b = "0", day = "", fam = "", rec = ""] = k.split("|");
    ins.run(g[Number(b)]?.start, day, fam, rec, s.v, s.t);
  }
  db.prepare(
    "INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens) VALUES (?, '2026-09-27', 'spend', 'D2', 'recA', 'cacheRead', 900, 900)",
  ).run(g[0]?.start);
  const mark = db.prepare("INSERT INTO ledger_daily_marks VALUES (?,?)");
  for (const b of g) mark.run(b.start, b.end);
  o.mutate?.(db as unknown as Db);
  return db as unknown as Db;
}

type SelfEvent = Issuing & { ts: string };
const ev = (
  family: Family,
  session: string,
  message: string,
  ts: string,
  extra: string | null = null,
  chain: "main" | "sidechain" = "main",
  ws = "w1",
): SelfEvent => ({ family, chain, session, message, ws, extra, ts: T(ts) });
/** What the certified census would report (event ts = issuing turn ts). */
const SELF_EVENTS: SelfEvent[] = [
  ev("C7", "s1", "a1", "09-27T10:00"),
  ev("C7", "s1", "a1", "09-27T10:00"), // two failures, one recovery turn
  ev("C7", "s1", "a2", "09-27T11:00"),
  ev("C3", "s1", "a2", "09-27T11:00"), // loses r2 to C7 (rule 4)
  ev("C7", "s1", "sa1", "09-27T14:00", null, "sidechain"),
  ev("C3", "s2", "b1", "09-26T08:00"),
  ev("C3", "s4", "c1", "09-26T09:00"),
  ev("C3", "s9", "h1", "09-26T10:00", null, "main", "w3"),
  ev("C9", "s5", "d1", "09-25T12:00", "deny-rule"),
  ev("C9", "s5", "d1", "09-25T12:00", "hook-block"),
  ev("C9", "s5", "d1", "09-25T12:00", "hook-block"),
  ev("D14", "s6", "e1", "09-24T10:00", "PURE_INTERRUPT"),
  ev("D14", "s6", "e1", "09-24T10:00", "KILLED_NO_PROMPT"),
  ev("C1", "s7", "f1", "09-23T09:00", null, "main", "w2"),
  ev("D11", "s8", "g1", "09-22T09:00", null, "main", "w2"),
  ev("C2", "s10", "k1", "09-20T10:00"),
  ev("C2", "s10", "i1", "09-27T23:59"),
  ev("C4", "s11", "j1", "09-27T09:00"),
];
const selfIssuing: IssuingFn = (_db, start, end) =>
  SELF_EVENTS.filter((x) => x.ts >= start && x.ts < end);

const CARD_KEYS: Array<[Family, string | null, string]> = [
  ["C7", "w1", "C7|w1"],
  ["C3", "w1", "C3|w1"],
  ["C4", "w1", "C4|w1|s11"],
  ["C2", "w1", "C2|w1"],
  ["C9", "w1", "C9|w1|HOOK_BLOCK"],
  ["C9", "w1", "C9|w1|DENY_RULE"],
  ["D14", "w1", "D14|w1|s6|PURE_INTERRUPT"],
  ["D14", "w1", "D14|w1|s6|KILLED_NO_PROMPT"],
  ["C1", null, "C1"],
  ["D11", "w2", "D11|tool-error-rate|w2"],
];

/**
 * A model of the candidate: card figures from `oracleClaims` with a bug, over `days` days (7 = the
 * card window); spend fields as on the baseline, which has no reliability_u_per_wk.
 */
function selfDocs(bug: Bug, days = 7) {
  const claims = oracleClaims(selfDb({}) as Db, SELF_E, selfIssuing, bug).filter(
    (c) => c.day >= dayStr(SELF_E - days * DAY_MS) && c.day < dayStr(SELF_E),
  );
  // card review F2/F4/F5/F7 (2026-10-04): main-chain figure, optional sidechain figure, safety cards.
  const fig = sumBy(
    claims.filter((c) => c.chain === "main"),
    (c) => c.recId,
  );
  const figSide = sumBy(
    claims.filter((c) => c.chain === "sidechain"),
    (c) => c.recId,
  );
  const mk = (withFigure: boolean): Json => {
    const active: Json[] = CARD_KEYS.map(([fam, ws, key], i) => {
      const id = recId(fam, ws, key);
      const safety = key === "C9|w1|HOOK_BLOCK";
      const side = Math.round(figSide.get(id)?.v ?? 0);
      return {
        rec_id: id,
        detector_id: fam,
        scope_workspace_id: ws,
        title: withFigure && fam === "C1" ? "C1 new text" : `${fam} title`,
        allocated_u_per_wk: null,
        modeled_savings_u_per_wk: 100 + i,
        ...(withFigure
          ? {
              reliability_u_per_wk: safety ? null : Math.round(fig.get(id)?.v ?? 0),
              ...(side > 0 && !safety ? { reliability_sidechain_u_per_wk: side } : {}),
              ...(safety ? { safety_lane: true } : {}),
            }
          : {}),
      };
    });
    active.push({
      rec_id: "rec-h1",
      detector_id: "H1",
      scope_workspace_id: "w1",
      title: "H1 title",
      allocated_u_per_wk: 50,
      modeled_savings_u_per_wk: 40,
      ...(withFigure ? { reliability_u_per_wk: null, safety_lane: true } : {}),
    });
    active.push({
      rec_id: "rec-a1",
      detector_id: "A1",
      scope_workspace_id: "w1",
      title: "A1 title",
      allocated_u_per_wk: 900,
      modeled_savings_u_per_wk: 800,
      ...(withFigure ? { reliability_u_per_wk: null } : {}),
    });
    const groups = [...new Set(active.map((c) => c.detector_id))].map((d) => {
      const recs = active.filter((c) => c.detector_id === d);
      return {
        detector_id: d,
        recs,
        total_savings_u_per_wk: recs.reduce((t, c) => t + (c.allocated_u_per_wk ?? 0), 0),
      };
    });
    return {
      data: { active, groups },
      meta: { window: { from: withFigure ? "x" : "y", to: "z" }, n: active.length },
    };
  };
  return { cand: mk(true), base: mk(false) };
}

const find = (doc: Json, det: string, nth = 0): Json =>
  doc.data.active.filter((c: Json) => c.detector_id === det)[nth];

const MUTATIONS: Array<{
  name: string;
  fails: CheckId;
  bug?: Bug;
  days?: number;
  /** Bug applied to the candidate ledger too (the candidate's own producer has it). */
  ledgerBug?: boolean;
  mutateDoc?: (cand: Json) => void;
  mutateDb?: (db: Db) => void;
}> = [
  { name: "no recId on claims", fails: "I3", bug: { no_rec_id: true }, ledgerBug: true },
  {
    name: "wrong key: C3 per session instead of per workspace",
    fails: "I3",
    bug: { c3_session_key: true },
    ledgerBug: true,
  },
  {
    name: "wrong key: C1 given a workspace scope",
    fails: "I3",
    bug: { c1_ws_key: true },
    ledgerBug: true,
  },
  {
    name: "collision split between recs instead of one winner",
    fails: "I3",
    bug: { collision_split: true },
    ledgerBug: true,
  },
  {
    name: "collision: first-seen rec wins, not the one with most events",
    fails: "I3",
    bug: { collision_first_seen: true },
    ledgerBug: true,
  },
  {
    name: "collision tie: highest rec id wins instead of lowest",
    fails: "I3",
    bug: { collision_tie_highest: true },
    ledgerBug: true,
  },
  {
    name: "collision: every rec priced the whole turn (family totals inflated)",
    fails: "I2",
    bug: { collision_both: true },
    ledgerBug: true,
  },
  {
    name: "sidechain pass left out of the per-rec figures",
    fails: "I3",
    bug: { no_sidechain: true },
    ledgerBug: true,
  },
  { name: "wrong window: 14d instead of 7d", fails: "I3", days: 14 },
  {
    name: "reliability $ added into allocated_u_per_wk",
    fails: "I1",
    mutateDoc: (d) => {
      const c = find(d, "C7");
      c.allocated_u_per_wk = c.reliability_u_per_wk;
    },
  },
  {
    name: "spend card allocated_u_per_wk changed",
    fails: "I1",
    mutateDoc: (d) => {
      find(d, "A1").allocated_u_per_wk = 901;
    },
  },
  {
    name: "card order changed",
    fails: "I1",
    mutateDoc: (d) => {
      d.data.active.reverse();
    },
  },
  {
    name: "group total includes reliability $",
    fails: "I1",
    mutateDoc: (d) => {
      d.data.groups[0].total_savings_u_per_wk += d.data.active[0].reliability_u_per_wk;
    },
  },
  {
    name: "a card moved to another group",
    fails: "I1",
    mutateDoc: (d) => {
      const [first, second] = d.data.groups;
      second.recs.push(first.recs.shift());
    },
  },
  {
    name: "ledger spend row changed",
    fails: "I1",
    mutateDb: (db) =>
      void db.prepare("UPDATE ledger_daily SET value_u = value_u + 1 WHERE lane = 'spend'").run(),
  },
  {
    name: "ledger family total changed (a claim lost)",
    fails: "I2",
    mutateDb: (db) =>
      void db
        .prepare("DELETE FROM ledger_daily WHERE lane = 'reliability' AND detector_id = 'C2'")
        .run(),
  },
  {
    name: "ledger rec_id points at the wrong rec",
    fails: "I2",
    mutateDb: (db) =>
      void db
        .prepare(
          "UPDATE ledger_daily SET rec_id = 'rec-wrong' WHERE lane = 'reliability' AND detector_id = 'C1'",
        )
        .run(),
  },
  {
    name: "orphan $ missing from the lane (conservation broken)",
    fails: "I4",
    mutateDb: (db) =>
      void db
        .prepare(
          "UPDATE ledger_daily SET value_u = value_u + 1000 WHERE lane = 'reliability' AND detector_id = 'D11'",
        )
        .run(),
  },
  {
    name: "non-reliability card carries a figure",
    fails: "I5",
    mutateDoc: (d) => {
      find(d, "A1").reliability_u_per_wk = 5;
    },
  },
  {
    name: "F2 sidechain $ folded into the main figure",
    fails: "I3",
    mutateDoc: (d) => {
      const c = find(d, "C7");
      c.reliability_u_per_wk += c.reliability_sidechain_u_per_wk;
      delete c.reliability_sidechain_u_per_wk;
    },
  },
  {
    name: "F2 sidechain figure dropped from the card",
    fails: "I3",
    mutateDoc: (d) => {
      delete find(d, "C7").reliability_sidechain_u_per_wk;
    },
  },
  {
    name: "F2 sidechain figure on a card with no sidechain claims",
    fails: "I3",
    mutateDoc: (d) => {
      find(d, "C3").reliability_sidechain_u_per_wk = 7;
    },
  },
  {
    name: "F5 C9 guard-block (safety) card carries $",
    fails: "I5",
    mutateDoc: (d) => {
      find(d, "C9", 0).reliability_u_per_wk = 4000;
    },
  },
  {
    name: "F5 C9 guard-block card missing safety_lane",
    fails: "I5",
    mutateDoc: (d) => {
      delete find(d, "C9", 0).safety_lane;
    },
  },
  {
    name: "F5 H1 card missing safety_lane",
    fails: "I5",
    mutateDoc: (d) => {
      delete find(d, "H1").safety_lane;
    },
  },
  {
    name: "F5 C9 deny-rule card wrongly marked safety",
    fails: "I5",
    mutateDoc: (d) => {
      const c = find(d, "C9", 1);
      c.safety_lane = true;
      c.reliability_u_per_wk = null;
    },
  },
  {
    name: "reliability card without a number",
    fails: "I5",
    mutateDoc: (d) => {
      find(d, "C4").reliability_u_per_wk = null;
    },
  },
  {
    name: "reliability card figure off by 2 µ$",
    fails: "I3",
    mutateDoc: (d) => {
      find(d, "D11").reliability_u_per_wk += 2;
    },
  },
];

const figMainOf = (claims: Claim[], rec: string) =>
  claims.filter((c) => c.chain === "main" && c.recId === rec).reduce((t, c) => t + c.value, 0);

function selfCheck(): number {
  let bad = 0;
  const report = (name: string, ok: boolean, detail = "") => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const run = (m?: (typeof MUTATIONS)[number]) => {
    const { cand, base } = selfDocs(m?.bug ?? {}, m?.days ?? 7);
    m?.mutateDoc?.(cand);
    const db = selfDb(m?.ledgerBug ? (m.bug ?? {}) : {}, m?.mutateDb ? { mutate: m.mutateDb } : {});
    const baseDb = selfDb({}, { baseline: true });
    return verify(db, cand, base, {
      e: SELF_E,
      issuing: selfIssuing,
      seed: false,
      baselineDb: baseDb,
    });
  };

  const clean = run();
  report("clean candidate passes I1-I5", clean.ok, JSON.stringify(clean.failed_checks));
  report(
    "clean case exercised every check",
    CHECK_IDS.every((id) => (clean.checks[id]?.pass ?? 0) > 0),
    CHECK_IDS.map((id) => clean.checks[id]?.pass).join(","),
  );

  // Hand-derived figures (µ$) from the comments in selfDb.
  const claims = oracleClaims(selfDb({}), SELF_E, selfIssuing).filter((c) => c.block === 0);
  const fig = sumBy(claims, (c) => c.recId);
  const f = (fam: Family, ws: string | null, key: string) => fig.get(recId(fam, ws, key))?.v ?? 0;
  const d14 = [
    recId("D14", "w1", "D14|w1|s6|KILLED_NO_PROMPT"),
    recId("D14", "w1", "D14|w1|s6|PURE_INTERRUPT"),
  ].sort();
  const hand: Array<[string, number, number]> = [
    ["C7|w1 = r1 + r2 + sidechain sa2", f("C7", "w1", "C7|w1"), 3000 + 3500 + 800],
    [
      "C7|w1 main-chain part (card reliability_u_per_wk, F2)",
      figMainOf(claims, recId("C7", "w1", "C7|w1")),
      3000 + 3500,
    ],
    // One C3 card per workspace: s1 loses r2 to C7 (0) + s2 (600) + s4 (200).
    ["C3|w1 = s1 (0) + s2 + s4", f("C3", "w1", "C3|w1"), 0 + 600 + 200],
    ["C3|w3 (orphan: no card)", f("C3", "w3", "C3|w3"), 1400],
    ["C9 HOOK_BLOCK wins d2 (2 events vs 1)", f("C9", "w1", "C9|w1|HOOK_BLOCK"), 4000],
    ["C9 DENY_RULE", f("C9", "w1", "C9|w1|DENY_RULE"), 0],
    ["D14 tie goes to the lowest rec id", fig.get(d14[0] ?? "")?.v ?? 0, 400],
    ["D14 tie loser", fig.get(d14[1] ?? "")?.v ?? 0, 0],
    ["C1 global", f("C1", null, "C1"), 300],
    ["D11 w2", f("D11", "w2", "D11|tool-error-rate|w2"), 150],
    ["C4 session ended on the failure", f("C4", "w1", "C4|w1|s11"), 0],
    ["C2 (block 1, not in the card window)", f("C2", "w1", "C2|w1"), 0],
  ];
  for (const [name, got, want] of hand)
    report(`hand-derived ${name}`, got === want, `${got} want ${want}`);
  const info = clean.info as Record<string, unknown>;
  report(
    "info: orphan $ = C3 s9 only, collisions = C9 + D14",
    info.orphan_u_total === 1400 &&
      JSON.stringify(info.collisions_same_family) === JSON.stringify({ C9: 1, D14: 1 }),
    JSON.stringify([info.orphan_u_by_family, info.collisions_same_family]),
  );
  report(
    "baseline-prepared DB (no rec ids) skips the per-rec I2 split",
    verify(selfDb({}, { baseline: true }), selfDocs({}).cand, selfDocs({}).base, {
      e: SELF_E,
      issuing: selfIssuing,
      seed: true,
    }).ok,
  );

  let caught = 0;
  for (const m of MUTATIONS) {
    const r = run(m);
    const ok = r.failed_checks.includes(m.fails);
    if (ok) caught++;
    report(
      `mutation caught: ${m.name}`,
      ok,
      `failed=${JSON.stringify(r.failed_checks)} want=${m.fails}`,
    );
  }
  report(
    ">= 5 mutations caught (all required)",
    caught === MUTATIONS.length && caught >= 5,
    `${caught}/${MUTATIONS.length}`,
  );
  console.log(bad === 0 ? "SELF-CHECK PASS" : `SELF-CHECK FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: reliability-headline-check.ts --db <sqlite> --cards <cards.json> --baseline-cards <cards.json>\n         [--baseline-db <sqlite>] [--now <UTC midnight iso>] [--seed]\n       | --self-check`,
  );
  process.exit(2);
}

function readJson(p: string): Json {
  if (!fs.existsSync(p)) usage(`file not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function openDb(p: string): Db {
  if (!fs.existsSync(p)) usage(`db not found: ${p}`);
  return new Database(p, { readonly: true, fileMustExist: true });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  let seed = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--self-check") return selfCheck();
    if (a === "--seed") {
      seed = true;
      continue;
    }
    if (!["--db", "--cards", "--baseline-cards", "--baseline-db", "--now"].includes(a))
      usage(`Unknown flag ${a}`);
    const val = argv[++i];
    if (val === undefined || val.startsWith("--")) usage(`Missing value for ${a}`);
    flags.set(a, val);
  }
  const dbPath = flags.get("--db");
  const cardsPath = flags.get("--cards");
  const basePath = flags.get("--baseline-cards");
  if (!dbPath) usage("--db is required");
  if (!cardsPath) usage("--cards is required");
  if (!basePath) usage("--baseline-cards is required");
  const now = new Date(flags.get("--now") ?? "2026-09-28T00:00:00.000Z").getTime();
  if (!Number.isFinite(now) || now % DAY_MS !== 0) usage("--now must be a UTC midnight ISO date");
  const db = openDb(dbPath);
  const baseDbPath = flags.get("--baseline-db");
  const baselineDb = baseDbPath === undefined ? undefined : openDb(baseDbPath);
  try {
    const report = verify(db, readJson(cardsPath), readJson(basePath), {
      e: now,
      issuing: await censusIssuing(),
      seed,
      ...(baselineDb === undefined ? {} : { baselineDb }),
    });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      report.ok
        ? "RELIABILITY-HEADLINE-CHECK PASS"
        : `RELIABILITY-HEADLINE-CHECK FAIL (${report.failed_checks.join(",")})`,
    );
    return report.ok ? 0 : 1;
  } finally {
    db.close();
    baselineDb?.close();
  }
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
