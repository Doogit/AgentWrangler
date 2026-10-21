/**
 * P3.L-F — independent oracle for "rank recommendation cards by the $ they show".
 * Contract: docs/plans/2026-10-03-rank-by-headline-spec.md, "Rule" and "Invariants" (I1-I5).
 *
 * Written before the implementation, from the spec alone. No src/ imports: the shown-$ rule, the
 * expected order and the expected group order are all restated here. `cards.json` is the
 * `/api/recommendations` response written by l9-dump-views.ts (`--prepare` for a fresh copy).
 *
 *   npx tsx scripts/parity/rank-by-headline-check.ts --cards <cand cards.json>
 *       --baseline-cards <baseline cards.json> [--db <cand prepared copy> --baseline-db <baseline copy>]
 *       [--now <UTC midnight iso, informational>]
 *   npx tsx scripts/parity/rank-by-headline-check.ts --self-check
 *
 * I1  candidate `active` is sorted by rule 2 (amended 2026-10-13: certification does not rank,
 *     operator chat): cards with a shown $ before cards
 *     without; shown $ descending ($0 is a shown $); tie -> rank_value_u_per_wk descending
 *     (basis X / missing last). The final tie keys (created_at, rec_id) are not asserted (the spec
 *     names no direction), so a tie on all four checked keys is accepted in either order.
 * I2  same cards, same numbers: after sorting every card list by rec_id (and groups by id), the
 *     candidate and baseline documents are deep-equal (ignoring meta.window, which is wall-clock).
 *     With --db and --baseline-db (different files) ledger_daily is identical.
 * I3  candidate `active_groups`: order = summed shown $ descending (amended 2026-10-13), ties in
 *     first-seen group order of the cards over candidate `active`,
 *     minor group (MINOR_ITEMS) last; each group's recs keep `active` order.
 * I4  UI sort: test/ui/rank-by-headline-sort.test.tsx (not part of this script).
 * I5  info only: adjacent pairs of the BASELINE `active` that violate rule 2 (does not fail). If 0
 *     the real data cannot discriminate and the mutation self-check carries discrimination.
 *
 * Exit 0 = I1-I3 passed; 1 = a FAIL; 2 = bad flags/inputs. DBs are opened read-only.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

// biome-ignore lint/suspicious/noExplicitAny: dump files are untrusted JSON; every read below is checked before use
type Json = any;

const MINOR_GROUP_ID = "MINOR_ITEMS";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, Json> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// ── Restatement of the spec ───────────────────────────────────────────────────

/** Mutations of the oracle's own expected order; used only by --self-check. */
export type BugName =
  | "rank_value_sort"
  | "reliability_no_shown"
  | "not_estimated_first"
  | "ascending"
  | "cert_first"
  | "zero_is_none"
  | "no_modeled_fallback"
  | "tie_rank_ascending"
  | "groups_reversed"
  | "groups_first_seen"
  | "groups_by_detector_id"
  | "minor_not_last"
  | "group_recs_reordered";
export type Bug = Partial<Record<BugName, true>>;

/** Rule 1: the $ the card shows, or null for "Not estimated". */
export function shownU(c: Json, bug: Bug = {}): number | null {
  let v: number | null;
  if (c.allocated_u_per_wk === undefined)
    v = isNum(c.modeled_savings_u_per_wk) ? c.modeled_savings_u_per_wk : null;
  else if (isNum(c.allocated_u_per_wk)) v = c.allocated_u_per_wk;
  else if (isNum(c.reliability_u_per_wk) && !bug.reliability_no_shown) v = c.reliability_u_per_wk;
  else if (isStandalone(c)) v = c.modeled_savings_u_per_wk;
  else v = null;
  if (bug.no_modeled_fallback && c.allocated_u_per_wk === undefined) return null;
  if (bug.zero_is_none && v === 0) return null;
  return v;
}

/** Standalone rank value; basis X or missing sorts last. */
export function rankValue(c: Json): number | null {
  const e = c.estimate;
  if (!isObj(e) || e.basis === "X" || !isNum(e.rank_value_u_per_wk)) return null;
  return e.rank_value_u_per_wk;
}

/** < 0 if a belongs before b, > 0 if after, 0 if rule 2's checked keys tie. */
export function cmpRule2(a: Json, b: Json, bug: Bug = {}): number {
  const sign = bug.ascending ? -1 : 1;
  if (bug.cert_first) {
    const ca = a.certification === "CERTIFIED" ? 0 : 1;
    const cb = b.certification === "CERTIFIED" ? 0 : 1;
    if (ca !== cb) return ca - cb;
  }
  if (bug.rank_value_sort) return rankCmp(a, b, 1);
  const sa = shownU(a, bug);
  const sb = shownU(b, bug);
  if ((sa === null) !== (sb === null)) {
    const noneFirst = bug.not_estimated_first ? -1 : 1;
    return (sa === null ? 1 : -1) * noneFirst;
  }
  if (sa !== null && sb !== null && sa !== sb) return sign * (sb - sa);
  return rankCmp(a, b, bug.tie_rank_ascending ? -1 : 1);
}

/** rank_value descending (X/missing last), times `sign`. */
function rankCmp(a: Json, b: Json, sign: 1 | -1): number {
  const ra = rankValue(a);
  const rb = rankValue(b);
  if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
  if (ra !== null && rb !== null && ra !== rb) return sign * (rb - ra);
  return 0;
}

/** The oracle's own expected `active` order for a set of cards (used by the self-check only). */
function expectedActive(cards: Json[], bug: Bug): Json[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort(
      (x, y) =>
        cmpRule2(x.c, y.c, bug) ||
        String(x.c.created_at ?? "").localeCompare(String(y.c.created_at ?? "")) ||
        String(x.c.rec_id).localeCompare(String(y.c.rec_id)) ||
        x.i - y.i,
    )
    .map((x) => x.c);
}

/** Group id a card belongs to, given a candidate's own group membership. */
function groupIndex(groups: Json[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups) for (const r of g.recs ?? []) m.set(r.rec_id, g.detector_id);
  return m;
}

/** Standalone lane (E1/E2): no ledger figure; the meter shows the non-summable modeled $. */
function isStandalone(c: Json): boolean {
  return (
    c.allocated_u_per_wk === null &&
    !isNum(c.reliability_u_per_wk) &&
    isNum(c.modeled_savings_u_per_wk) &&
    c.modeled_savings_u_per_wk > 0 &&
    isObj(c.estimate) &&
    c.estimate.summable === false
  );
}

/**
 * A group's rank total: the sum of its cards' shown $ (rule 1); no shown $ counts 0. Standalone
 * estimates overlap, so they add only their largest card.
 */
export function groupTotalU(cards: Json[]): number {
  let sum = 0;
  let standaloneMax = 0;
  for (const c of cards) {
    const shown = shownU(c) ?? 0;
    if (isStandalone(c)) standaloneMax = Math.max(standaloneMax, shown);
    else sum += shown;
  }
  return sum + standaloneMax;
}

/**
 * Rule 3 / I3 (amended 2026-10-13): groups by summed shown $ descending (ties: first-seen over
 * `active`), minor group last, recs in `active` order.
 */
export function expectedGroupOrder(active: Json[], groups: Json[]): Array<[string, string[]]> {
  const of = groupIndex(groups);
  const order: string[] = [];
  const recs = new Map<string, Json[]>();
  for (const c of active) {
    const g = of.get(c.rec_id);
    if (g === undefined) continue;
    if (!recs.has(g)) {
      order.push(g);
      recs.set(g, []);
    }
    recs.get(g)?.push(c);
  }
  const major = order
    .filter((g) => g !== MINOR_GROUP_ID)
    .sort((a, b) => groupTotalU(recs.get(b) ?? []) - groupTotalU(recs.get(a) ?? []));
  const ordered = [...major, ...order.filter((g) => g === MINOR_GROUP_ID)];
  return ordered.map((g) => [g, (recs.get(g) ?? []).map((c) => c.rec_id as string)]);
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
const CHECK_IDS = ["I1", "I2", "I3"] as const;
type CheckId = (typeof CHECK_IDS)[number];

const activeOf = (doc: Json): Json[] => (Array.isArray(doc?.data?.active) ? doc.data.active : []);
const groupsOf = (doc: Json): Json[] =>
  Array.isArray(doc?.data?.active_groups) ? doc.data.active_groups : [];

const brief = (c: Json) => ({
  rec_id: c.rec_id,
  detector_id: c.detector_id,
  cert: c.certification ?? null,
  alloc: c.allocated_u_per_wk ?? null,
  rel: c.reliability_u_per_wk ?? null,
  shown: shownU(c),
  rank: rankValue(c),
});

/** Adjacent pairs of `active` that rule 2 would order the other way. */
export function violations(active: Json[]): { count: number; pairs: number; first: unknown[] } {
  const first: unknown[] = [];
  let count = 0;
  for (let i = 0; i + 1 < active.length; i++) {
    const a = active[i];
    const b = active[i + 1];
    if (cmpRule2(a, b) > 0) {
      count++;
      if (first.length < 5) first.push({ at: i, a: brief(a), b: brief(b) });
    }
  }
  return { count, pairs: Math.max(0, active.length - 1), first };
}

// ── Canonical form for I2 ─────────────────────────────────────────────────────

const isCardObj = (v: unknown): v is Record<string, Json> =>
  isObj(v) && typeof v.rec_id === "string" && typeof v.detector_id === "string";
const isGroupObj = (v: unknown): v is Record<string, Json> =>
  isObj(v) && typeof v.detector_id === "string" && Array.isArray(v.recs) && !("rec_id" in v);

/** Key-sorted, card lists sorted by rec_id, group lists by group id; meta.window dropped. */
function canon(v: Json): Json {
  if (Array.isArray(v)) {
    const items = v.map(canon);
    if (v.length > 0 && v.every(isCardObj))
      return items.sort((a, b) => String(a.rec_id).localeCompare(String(b.rec_id)));
    if (v.length > 0 && v.every(isGroupObj))
      return items.sort((a, b) => String(a.detector_id).localeCompare(String(b.detector_id)));
    return items;
  }
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, canon(v[k])]),
  );
}
function canonDoc(doc: Json): Json {
  const c = canon(doc);
  if (isObj(c) && isObj(c.meta)) {
    const { window: _w, ...meta } = c.meta;
    return { ...c, meta };
  }
  return c;
}

// ── verify ────────────────────────────────────────────────────────────────────

export interface Opts {
  /** Extra ledger_daily comparison: [candidate rows JSON, baseline rows JSON]. Omit when same/absent. */
  ledger?: [string, string];
}

export function verify(cand: Json, base: Json, opts: Opts = {}) {
  const checks = Object.fromEntries(CHECK_IDS.map((id) => [id, new Check()])) as Record<
    CheckId,
    Check
  >;
  const active = activeOf(cand);
  const groups = groupsOf(cand);

  // ── I1: order.
  checks.I1.ok(Array.isArray(cand?.data?.active), "active-missing");
  checks.I1.ok(
    new Set(active.map((c) => c.rec_id)).size === active.length,
    "duplicate-rec-in-active",
  );
  for (let i = 0; i + 1 < active.length; i++) {
    const a = active[i];
    const b = active[i + 1];
    checks.I1.ok(cmpRule2(a, b) <= 0, "adjacent-pair-out-of-order", {
      at: i,
      a: brief(a),
      b: brief(b),
    });
  }

  // ── I2: same cards, same numbers.
  const cc = canonDoc(cand);
  const bc = canonDoc(base);
  const keys = new Set([...Object.keys(cc?.data ?? {}), ...Object.keys(bc?.data ?? {})]);
  for (const k of keys) {
    const same = JSON.stringify(cc?.data?.[k]) === JSON.stringify(bc?.data?.[k]);
    const ids = (d: Json) =>
      Array.isArray(d?.data?.[k])
        ? d.data[k].map((x: Json) => x?.rec_id ?? x?.detector_id).filter(Boolean).length
        : null;
    checks.I2.ok(same, `data.${k}-differs`, { candidate_n: ids(cc), baseline_n: ids(bc) });
  }
  checks.I2.ok(
    JSON.stringify({ ...cc, data: undefined }) === JSON.stringify({ ...bc, data: undefined }),
    "non-data-document-differs",
  );
  const idSet = (doc: Json) => new Set(activeOf(doc).map((c) => c.rec_id as string));
  const cs = idSet(cand);
  const bs = idSet(base);
  checks.I2.ok(cs.size === bs.size && [...cs].every((x) => bs.has(x)), "active-rec-ids-differ", {
    only_candidate: [...cs].filter((x) => !bs.has(x)).slice(0, 5),
    only_baseline: [...bs].filter((x) => !cs.has(x)).slice(0, 5),
  });
  if (opts.ledger !== undefined)
    checks.I2.ok(opts.ledger[0] === opts.ledger[1], "ledger_daily-differs");

  // ── I3: groups.
  const want = expectedGroupOrder(active, groups);
  const have: Array<[string, string[]]> = groups.map((g) => [
    g.detector_id as string,
    (g.recs ?? []).map((r: Json) => r.rec_id as string),
  ]);
  checks.I3.ok(
    JSON.stringify(want.map(([g]) => g)) === JSON.stringify(have.map(([g]) => g)),
    "group-order-differs",
    { want: want.map(([g]) => g).slice(0, 12), have: have.map(([g]) => g).slice(0, 12) },
  );
  const wantMap = new Map(want);
  for (const [g, recs] of have)
    checks.I3.ok(
      JSON.stringify(wantMap.get(g)) === JSON.stringify(recs),
      "group-recs-not-in-active-order",
      {
        group: g,
        want: wantMap.get(g)?.slice(0, 6),
        have: recs.slice(0, 6),
      },
    );
  const inGroups = have.reduce((n, [, r]) => n + r.length, 0);
  checks.I3.ok(
    inGroups === active.length || groups.length === 0,
    "group-membership-not-all-active",
    {
      in_groups: inGroups,
      active: active.length,
    },
  );

  const failed = CHECK_IDS.filter((id) => checks[id].fail > 0);
  const i5 = violations(activeOf(base));
  return {
    ok: failed.length === 0,
    failed_checks: failed,
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
    i5: {
      baseline_adjacent_pairs_violating_rule2: i5.count,
      adjacent_pairs: i5.pairs,
      note:
        i5.count === 0
          ? "0 violating pairs: this data cannot discriminate old vs new order; the self-check carries discrimination"
          : "baseline orders these pairs differently from rule 2",
      first: i5.first,
    },
    info: {
      cards_active: active.length,
      shown_none: active.filter((c) => shownU(c) === null).length,
      shown_zero: active.filter((c) => shownU(c) === 0).length,
      reliability_shown: active.filter(
        (c) => c.allocated_u_per_wk === null && isNum(c.reliability_u_per_wk),
      ).length,
      certified: active.filter((c) => c.certification === "CERTIFIED").length,
      groups: groups.length,
    },
  };
}

// ── Self-check ────────────────────────────────────────────────────────────────

const SELF_CARDS: Json[] = (() => {
  const est = (basis: string, rank: number | null) => ({ basis, rank_value_u_per_wk: rank });
  const mk = (rec_id: string, detector_id: string, patch: Json): Json => ({
    rec_id,
    detector_id,
    created_at: "2026-10-01T00:00:00.000Z",
    title: rec_id,
    ...patch,
  });
  return [
    mk("cert-small", "D1", {
      certification: "CERTIFIED",
      allocated_u_per_wk: 1_000,
      estimate: est("P", 10),
    }),
    mk("cert-big", "D1", {
      certification: "CERTIFIED",
      allocated_u_per_wk: 90_000,
      estimate: est("P", 5),
    }),
    mk("big-shown", "D2", { allocated_u_per_wk: 11_000_000, estimate: est("P", 100) }),
    mk("high-rank-small-shown", "D4", {
      allocated_u_per_wk: 400_000,
      estimate: est("P", 9_000_000),
    }),
    mk("reliability", "C7", {
      allocated_u_per_wk: null,
      reliability_u_per_wk: 5_000_000,
      estimate: est("E", 50),
    }),
    // D7 sums to $9 and so leads C7 ($5) although its best card ($4.5) is smaller.
    mk("d7-a", "D7", { allocated_u_per_wk: 4_500_000, estimate: est("P", 40) }),
    mk("d7-b", "D7", { allocated_u_per_wk: 4_500_000, estimate: est("P", 35) }),
    mk("tie-low-rank", "D2", { allocated_u_per_wk: 3_000_000, estimate: est("P", 20) }),
    mk("tie-high-rank", "D9", { allocated_u_per_wk: 3_000_000, estimate: est("P", 30) }),
    mk("pre-l6-modeled", "B1", { modeled_savings_u_per_wk: 2_000_000, estimate: est("P", 7) }),
    mk("zero", "D4", { allocated_u_per_wk: 0, modeled_savings_u_per_wk: 9, estimate: est("P", 3) }),
    mk("not-estimated", "C9", {
      allocated_u_per_wk: null,
      reliability_u_per_wk: null,
      modeled_savings_u_per_wk: null,
      estimate: est("P", 1_000),
    }),
    mk("not-estimated-x", "C9", { allocated_u_per_wk: null, estimate: est("X", null) }),
    mk("minor-a", "C2", { allocated_u_per_wk: 2_500_000, estimate: est("P", 1), minor: true }),
    mk("minor-b", "D11", { allocated_u_per_wk: 10, estimate: est("P", 1), minor: true }),
  ];
})();

/** A candidate model: `active` in the (possibly mutated) expected order, groups derived from it. */
function selfDoc(bug: Bug): Json {
  const active = expectedActive(structuredClone(SELF_CARDS), bug);
  const gid = (c: Json) => (c.minor ? MINOR_GROUP_ID : (c.detector_id as string));
  let ids = [...new Set(active.filter((c) => !c.minor).map(gid))];
  const total = (id: string) => groupTotalU(active.filter((c) => gid(c) === id));
  if (!bug.groups_first_seen) ids.sort((a, b) => total(b) - total(a));
  if (bug.groups_reversed) ids.reverse();
  if (bug.groups_by_detector_id) ids.sort();
  if (!bug.minor_not_last && active.some((c) => c.minor)) ids.push(MINOR_GROUP_ID);
  else if (active.some((c) => c.minor)) ids.unshift(MINOR_GROUP_ID);
  ids = [...new Set(ids)];
  const groups = ids.map((id) => {
    let recs = active.filter((c) => gid(c) === id);
    if (bug.group_recs_reordered) recs = [...recs].reverse();
    return { detector_id: id, label: id, recs, total_savings_u_per_wk: 0 };
  });
  return {
    data: {
      active,
      active_groups: groups,
      below_floor: [],
      limit_warnings: [],
      adopted: [],
      dismissed: [],
      history: [],
    },
    meta: { window: { from: "x", to: "y" } },
  };
}
/** Baseline model: same cards, the old order (rank_value descending, nothing else). */
function selfBase(): Json {
  const doc = selfDoc({});
  const old = [...doc.data.active].sort((a: Json, b: Json) => rankCmp(a, b, 1));
  doc.data.active = old;
  return doc;
}

const MUTATIONS: Array<{ name: string; fails: CheckId; bug?: Bug; mutateDoc?: (d: Json) => void }> =
  [
    { name: "sort by rank_value (old order)", fails: "I1", bug: { rank_value_sort: true } },
    {
      name: "reliability card treated as no shown $",
      fails: "I1",
      bug: { reliability_no_shown: true },
    },
    { name: "Not estimated first", fails: "I1", bug: { not_estimated_first: true } },
    { name: "ascending shown $", fails: "I1", bug: { ascending: true } },
    { name: "CERTIFIED ranked first", fails: "I1", bug: { cert_first: true } },
    { name: "$0 treated as no shown $", fails: "I1", bug: { zero_is_none: true } },
    { name: "pre-L6 modeled fallback ignored", fails: "I1", bug: { no_modeled_fallback: true } },
    { name: "tie broken by rank_value ascending", fails: "I1", bug: { tie_rank_ascending: true } },
    { name: "groups in reverse order", fails: "I3", bug: { groups_reversed: true } },
    { name: "groups first-seen, not by total $", fails: "I3", bug: { groups_first_seen: true } },
    {
      name: "groups sorted by detector id, not by total $",
      fails: "I3",
      bug: { groups_by_detector_id: true },
    },
    { name: "minor group not last", fails: "I3", bug: { minor_not_last: true } },
    { name: "group recs not in active order", fails: "I3", bug: { group_recs_reordered: true } },
    {
      name: "a card number changed",
      fails: "I2",
      mutateDoc: (d) => {
        d.data.active[0].allocated_u_per_wk += 1;
      },
    },
    {
      name: "a card dropped from active",
      fails: "I2",
      mutateDoc: (d) => {
        d.data.active.pop();
      },
    },
    {
      name: "a below_floor card appeared",
      fails: "I2",
      mutateDoc: (d) => {
        d.data.below_floor.push({ rec_id: "x", detector_id: "D1" });
      },
    },
  ];

function selfCheck(): number {
  let bad = 0;
  const report = (name: string, ok: boolean, detail = "") => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const base = selfBase();

  const clean = verify(selfDoc({}), base);
  report("clean candidate passes I1-I3", clean.ok, JSON.stringify(clean.failed_checks));
  report(
    "clean case exercised every check",
    CHECK_IDS.every((id) => (clean.checks[id]?.pass ?? 0) > 0),
    CHECK_IDS.map((id) => clean.checks[id]?.pass).join(","),
  );
  report(
    "I5 discriminates on the fixture (baseline has violating pairs)",
    clean.i5.baseline_adjacent_pairs_violating_rule2 > 0,
    String(clean.i5.baseline_adjacent_pairs_violating_rule2),
  );
  const ids = selfDoc({})
    .data.active.map((c: Json) => c.rec_id)
    .join(",");
  const hand =
    "big-shown,reliability,d7-a,d7-b,tie-high-rank,tie-low-rank,minor-a,pre-l6-modeled,high-rank-small-shown,cert-big,cert-small,minor-b,zero,not-estimated,not-estimated-x";
  report("hand-derived expected order", ids === hand, ids === hand ? "" : `got ${ids}`);

  let caught = 0;
  for (const m of MUTATIONS) {
    const doc = selfDoc(m.bug ?? {});
    m.mutateDoc?.(doc);
    const r = verify(doc, base);
    const ok = r.failed_checks.includes(m.fails);
    if (ok) caught++;
    report(
      `mutation caught: ${m.name}`,
      ok,
      `failed=${JSON.stringify(r.failed_checks)} want=${m.fails}`,
    );
  }
  report(
    ">= 6 mutations caught (all required)",
    caught === MUTATIONS.length && caught >= 6,
    `${caught}/${MUTATIONS.length}`,
  );
  console.log(
    "UI sort mutation (left on rank_value): covered by test/ui/rank-by-headline-sort.test.tsx",
  );
  console.log(bad === 0 ? "SELF-CHECK PASS" : `SELF-CHECK FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: rank-by-headline-check.ts --cards <cards.json> --baseline-cards <cards.json>\n         [--db <sqlite> --baseline-db <sqlite>] [--now <UTC midnight iso>]\n       | --self-check`,
  );
  process.exit(2);
}

function readJson(p: string): Json {
  if (!fs.existsSync(p)) usage(`file not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function ledgerRows(p: string): string {
  if (!fs.existsSync(p)) usage(`db not found: ${p}`);
  const db = new Database(p, { readonly: true, fileMustExist: true });
  try {
    return JSON.stringify(
      db
        .prepare(
          "SELECT * FROM ledger_daily ORDER BY block_start, day, lane, detector_id, rec_id, component",
        )
        .all(),
    );
  } finally {
    db.close();
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--self-check") return selfCheck();
    if (!["--db", "--cards", "--baseline-cards", "--baseline-db", "--now"].includes(a))
      usage(`Unknown flag ${a}`);
    const val = argv[++i];
    if (val === undefined || val.startsWith("--")) usage(`Missing value for ${a}`);
    flags.set(a, val);
  }
  const cardsPath = flags.get("--cards");
  const basePath = flags.get("--baseline-cards");
  if (!cardsPath) usage("--cards is required");
  if (!basePath) usage("--baseline-cards is required");
  const dbPath = flags.get("--db");
  const baseDbPath = flags.get("--baseline-db");
  if ((dbPath === undefined) !== (baseDbPath === undefined))
    usage("--db and --baseline-db go together");
  const now = flags.get("--now");
  if (now !== undefined && !Number.isFinite(new Date(now).getTime()))
    usage("--now must be an ISO date");
  let ledger: [string, string] | undefined;
  if (
    dbPath !== undefined &&
    baseDbPath !== undefined &&
    path.resolve(dbPath) !== path.resolve(baseDbPath)
  )
    ledger = [ledgerRows(dbPath), ledgerRows(baseDbPath)];
  const report = verify(
    readJson(cardsPath),
    readJson(basePath),
    ledger === undefined ? {} : { ledger },
  );
  console.log(JSON.stringify({ as_of: now ?? null, ...report }, null, 2));
  console.log(
    report.ok
      ? "RANK-BY-HEADLINE-CHECK PASS"
      : `RANK-BY-HEADLINE-CHECK FAIL (${report.failed_checks.join(",")})`,
  );
  return report.ok ? 0 : 1;
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
