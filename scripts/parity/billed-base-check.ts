/**
 * P3.L follow-up — independent oracle for "billed base = every non-provisional turn; D1 eligibility per agent".
 * Contract: docs/plans/Archive/2026-09-30-billed-base-explore-plan-spec.md, "Invariants".
 *
 * Written before the implementation. Expectations come from raw `turns` / `subagent_meta` /
 * `context_inventory` / `pricing_snapshots` SQL restated below; no src/ rule is reused. The ONLY src/ import
 * is the thing under test, lazily: `buildClaimLedger` (its `billed` maps and its per-turn `claims` are read
 * as output, never used to compute an expectation). The L9 SQL oracle (`ledger-sql-oracle.ts`, no src/
 * imports) and the sidechain reliability oracle (run as a child process) are reused as-is.
 *
 *   I1  billed base = SQL          per day x component tokens and value of the ledger's billed maps equal
 *                                  Σ over ALL non-provisional turns (own price validity SQL); same turn set.
 *   I2  nothing moves outside      per (day, lane, detector, session) `ledger_daily_sessions` value equals the
 *                                  baseline for every session with no Explore/Plan/fork agent; and every cell
 *                                  movement (`ledger_daily`) is explained by the affected sessions' movement.
 *   I3  affected sessions only     (a) no D1 CLAUDE.md claim on a turn whose own agent is Explore/Plan;
 *                                  (b) no D1 MEMORY claim on a sidechain turn whose own agent is not a fork;
 *                                  (c) metamorphic: rewriting subagent_meta Explore/Plan/fork -> general-purpose
 *                                      on a copy moves NO claim except D1 claims on turns of those agents
 *                                      (proves nothing but D1 reads the agent type, so every other family is
 *                                      billed-base-blind, incl. result claims' own billed set);
 *                                  (d) reliability claims = sidechain-reliability-check.ts (child process).
 *   I4  conservation              L9 1a/1b/2/3/4 pass; per (lane, day, component) claimed <= non-provisional billed.
 *   I5  seed unchanged             a DB with no Explore/Plan/fork agent has ledger tables identical to baseline
 *                                  (and optionally golden-ledger.json byte-identical to a git ref).
 *
 *   npx tsx scripts/parity/billed-base-check.ts --db <prepared> --views <dir> --as-of <iso> --baseline-db <prepared pre-change>
 *       [--window 7|14|30] [--blocks 9] [--work-dir <dir>] [--skip-mr] [--skip-reliability] [--skip-l9]
 *       [--golden <path> --golden-ref <git ref>]
 *   npx tsx scripts/parity/billed-base-check.ts --self-check
 *
 * Exit 0 = all gated checks passed; 1 = a check failed; 2 = bad flags/inputs. DBs are opened read-only
 * (the metamorphic check clones the candidate into --work-dir, default the OS temp dir, and deletes it).
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { verify as l9Verify } from "./ledger-sql-oracle.js";

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

const COMPONENTS = ["input", "output", "cacheRead", "cw5m", "cw1h"] as const;
const TOKEN_COLS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_5m",
  "cache_write_1h",
] as const;

/** The ledger prices only a finite, non-negative 5-number vector; anything else is unpriced (value 0). */
const PRICES_OK = `CASE WHEN p.unit_prices_json IS NOT NULL AND json_valid(p.unit_prices_json)
    THEN (json_type(p.unit_prices_json) = 'array' AND json_array_length(p.unit_prices_json) = 5
      ${[0, 1, 2, 3, 4]
        .map(
          (i) =>
            `AND json_type(p.unit_prices_json, '$[${i}]') IN ('integer', 'real') AND json_extract(p.unit_prices_json, '$[${i}]') >= 0`,
        )
        .join(" ")})
    ELSE 0 END`;
const PRICE = (i: number) =>
  `CASE WHEN ${PRICES_OK} THEN json_extract(p.unit_prices_json, '$[${i}]') ELSE 0 END`;
const AGG = COMPONENTS.map(
  (_, i) =>
    `SUM(t.${TOKEN_COLS[i]}) AS tok_${i}, SUM(t.${TOKEN_COLS[i]} * (${PRICE(i)})) AS usd_${i}`,
).join(", ");
const FROM_TURNS =
  "FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id";

const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);
const near = (a: number, b: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b)));
const usd = (u: number) => Math.round(u) / 1e6;
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

// ── The code under test (read as output) ──────────────────────────────────────

export interface LClaim {
  detectorId: string;
  lane: string;
  turnKey: string;
  component: string;
  slice: string;
  recId: string;
  tokens: number;
  value_u: number;
}
export interface BlockRun {
  /** JSON [turnKey, component] -> tokens / µ$ */
  billedTokens: ReadonlyMap<string, number>;
  billedValue: ReadonlyMap<string, number>;
  claims: LClaim[];
}
export interface Engine {
  run(db: Db, fromIso: string, toIso: string): BlockRun;
}

async function realEngine(): Promise<Engine> {
  const mod = await import("../../src/detector/claim-ledger.js");
  return {
    run(db, fromIso, toIso) {
      const l = mod.buildClaimLedger(
        db as never,
        { now: new Date(toIso), fromIso, toIso } as never,
      );
      return {
        billedTokens: l.billed,
        billedValue: l.billedValue,
        claims: l.claims.map((c) => ({
          detectorId: c.detectorId,
          lane: c.lane,
          turnKey: c.turnKey,
          component: c.component,
          slice: c.slice,
          recId: c.recId ?? "",
          tokens: c.tokens,
          value_u: c.value_u,
        })),
      };
    },
  };
}

// ── Verify ────────────────────────────────────────────────────────────────────

export interface Ctx {
  db: Db;
  baseline: Db;
  engine: Engine;
  e: number;
  blocks: number;
  windows: Array<7 | 14 | 30>;
  /** Clone the candidate into a writable scratch DB, run `fn`, dispose. Undefined = skip the metamorphic check. */
  withClone?: <T>(fn: (clone: Db) => T) => T;
  reliability?: () => { ok: boolean; detail: Json };
  l9?: () => { ok: boolean; failed: string[]; detail: Json };
  goldenSame?: () => boolean;
}

interface TurnInfo {
  sidechain: number;
  agentId: string | null;
}

/** All rows of the three ledger tables in a canonical order (marks excluded: they carry sigs and clocks). */
function ledgerDump(db: Db): string {
  const h = crypto.createHash("sha256");
  for (const [table, order] of [
    ["ledger_daily", "block_start, day, lane, detector_id, rec_id, component"],
    ["ledger_daily_top", "block_start, day, lane, detector_id"],
    ["ledger_daily_sessions", "block_start, day, lane, detector_id, session_id"],
  ] as const) {
    h.update(`#${table}\n`);
    for (const r of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate())
      h.update(`${JSON.stringify(r)}\n`);
  }
  return h.digest("hex");
}

const isD1Claim = (c: LClaim) => c.detectorId === "D1";
const claimKey = (c: LClaim) =>
  `${c.lane}|${c.detectorId}|${c.component}|${c.slice}|${c.recId}|${c.tokens}|${c.value_u}`;

export function verify(ctx: Ctx) {
  const { db, baseline, engine, e } = ctx;
  const checks = newChecks();
  const info: Record<string, unknown> = {};
  const g = grid(e, ctx.blocks);
  const zero = { tokens: 0, v: 0 };

  // Marks: both ledgers must be written for the whole grid, on the same grid.
  const markEnd = (d: Db, start: string) =>
    (
      d.prepare("SELECT block_end FROM ledger_daily_marks WHERE block_start = ?").get(start) as
        | { block_end: string }
        | undefined
    )?.block_end;
  for (const b of g) {
    checks.I2.ok(markEnd(db, b.start) === b.end, "marks-incomplete", {
      side: "candidate",
      block: b.start,
    });
    checks.I2.ok(markEnd(baseline, b.start) === b.end, "marks-incomplete", {
      side: "baseline",
      block: b.start,
    });
  }

  // ── Run the code under test once per block ──
  const runs = g.map((b) => ({ ...b, run: engine.run(db, b.start, b.end) }));

  // ── I1: billed base = SQL over every non-provisional turn ──
  const sqlAll = new Map<string, { n: number } & Record<string, number>>();
  const sqlTurns = new Set<string>();
  const dayOf = new Map<string, string>();
  const dayQ = db.prepare(
    `SELECT t.session_id AS s, t.message_id AS m, date(t.ts) AS day FROM turns t
      WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0`,
  );
  const perDayQ = db.prepare(
    `SELECT date(t.ts) AS day, COUNT(*) AS n, ${AGG} ${FROM_TURNS}
      WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0 GROUP BY date(t.ts)`,
  );
  const ledgerDay = new Map<string, { tokens: number; v: number }>(); // day|component
  const ledgerTurns = new Set<string>();
  for (const { start, end, run } of runs) {
    for (const r of perDayQ.all(start, end) as Array<Record<string, number | string>>)
      sqlAll.set(String(r.day), r as never);
    const blockSql = new Set<string>();
    for (const r of dayQ.iterate(start, end) as Iterable<{ s: string; m: string; day: string }>) {
      const k = `${r.s}|${r.m}`;
      blockSql.add(k);
      dayOf.set(k, r.day);
      sqlTurns.add(k);
    }
    const blockLedger = new Set<string>();
    for (const [cell, tokens] of run.billedTokens) {
      const [turn, component] = JSON.parse(cell) as [string, string];
      blockLedger.add(turn);
      ledgerTurns.add(turn);
      const day = dayOf.get(turn);
      if (day === undefined) continue; // reported by the turn-set check below
      const k = `${day}|${component}`;
      const cur = ledgerDay.get(k) ?? { tokens: 0, v: 0 };
      cur.tokens += tokens;
      cur.v += run.billedValue.get(cell) ?? 0;
      ledgerDay.set(k, cur);
    }
    const extra = [...blockLedger].filter((t) => !blockSql.has(t));
    const missing = [...blockSql].filter((t) => !blockLedger.has(t));
    checks.I1.ok(extra.length === 0 && missing.length === 0, "billed-turn-set", {
      block: start,
      ledger_only: extra.length,
      sql_only: missing.length,
      ledger_only_sample: extra.slice(0, 2),
      sql_only_sample: missing.slice(0, 2),
    });
  }
  for (const [day, row] of sqlAll) {
    COMPONENTS.forEach((component, i) => {
      const want = { tokens: Number(row[`tok_${i}`] ?? 0), v: Number(row[`usd_${i}`] ?? 0) };
      const got = ledgerDay.get(`${day}|${component}`) ?? zero;
      const at = { day, component, ledger_tokens: got.tokens, sql_tokens: want.tokens };
      checks.I1.ok(got.tokens === want.tokens, "billed-tokens", at);
      checks.I1.ok(near(got.v, want.v), "billed-value", {
        day,
        component,
        ledger_u: got.v,
        sql_u: want.v,
      });
    });
  }
  for (const k of ledgerDay.keys())
    checks.I1.ok(sqlAll.has(k.split("|")[0] ?? ""), "billed-day-not-in-sql", { cell: k });

  // Info: what the base is per window, the old rule's gap, all from SQL (µ$ -> $).
  const totalU = (r: Record<string, number>) =>
    COMPONENTS.reduce((t, _, i) => t + Number(r[`usd_${i}`] ?? 0), 0);
  const winRow = (w: number, extra: string) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n, ${AGG} ${FROM_TURNS} WHERE t.ts >= ? AND t.ts < ? AND t.provisional = 0 ${extra}`,
      )
      .get(iso(e - w * DAY_MS), iso(e)) as Record<string, number>;
  const OLD_EXCL = `AND t.is_sidechain = 1 AND EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.session_id = t.session_id AND sm.agent_type IN ('Explore','Plan'))`;
  const OWN = `AND EXISTS (SELECT 1 FROM subagent_meta sm2 WHERE sm2.agent_id = t.agent_id AND sm2.agent_type IN ('Explore','Plan'))`;
  const ledgerWindow = (w: number) => {
    const from = dayStr(e - w * DAY_MS);
    let v = 0;
    for (const [k, cell] of ledgerDay) if ((k.split("|")[0] ?? "") >= from) v += cell.v;
    return v;
  };
  info.billed_base_by_window_usd = Object.fromEntries(
    ([7, 14, 30] as const).map((w) => {
      const all = winRow(w, "");
      const excluded = winRow(w, OLD_EXCL);
      const own = winRow(w, `${OLD_EXCL} ${OWN}`);
      const ledger = ledgerWindow(w);
      return [
        `${w}d`,
        {
          sql_all_nonprovisional: usd(totalU(all)),
          sql_turns: all.n,
          ledger_billed: usd(ledger),
          gap_sql_minus_ledger: usd(totalU(all) - ledger),
          old_rule_excluded_total: usd(totalU(excluded)),
          old_rule_excluded_turns: excluded.n,
          of_which_own_agent_explore_plan: usd(totalU(own)),
          of_which_other_agents: usd(totalU(excluded) - totalU(own)),
        },
      ];
    }),
  );

  // ── I2: nothing moves outside the affected sessions ──
  const affected = new Set(
    (
      db
        .prepare(
          "SELECT DISTINCT session_id AS s FROM subagent_meta WHERE agent_type IN ('Explore', 'Plan', 'fork') AND session_id IS NOT NULL",
        )
        .all() as Array<{ s: string }>
    ).map((r) => r.s),
  );
  info.affected_sessions = affected.size;
  const starts = JSON.stringify(g.map((b) => b.start));
  const sessionRows = (d: Db) =>
    new Map(
      (
        d
          .prepare(
            `SELECT day, lane, detector_id AS det, session_id AS s, value_u AS v FROM ledger_daily_sessions
              WHERE block_start IN (SELECT value FROM json_each(?))`,
          )
          .all(starts) as Array<{ day: string; lane: string; det: string; s: string; v: number }>
      ).map((r) => [JSON.stringify([r.day, r.lane, r.det, r.s]), r.v]),
    );
  const sC = sessionRows(db);
  const sB = sessionRows(baseline);
  const cellSum = (d: Db) =>
    new Map(
      (
        d
          .prepare(
            `SELECT day, lane, detector_id AS det, SUM(value_u) AS v FROM ledger_daily
              WHERE block_start IN (SELECT value FROM json_each(?)) GROUP BY day, lane, detector_id`,
          )
          .all(starts) as Array<{ day: string; lane: string; det: string; v: number }>
      ).map((r) => [JSON.stringify([r.day, r.lane, r.det]), r.v]),
    );
  const cC = cellSum(db);
  const cB = cellSum(baseline);
  const affectedDelta = new Map<string, number>(); // [day,lane,det] -> Σ (cand - base) over affected sessions
  let moved = 0;
  for (const k of new Set([...sC.keys(), ...sB.keys()])) {
    const [day, lane, det, s] = JSON.parse(k) as [string, string, string, string];
    const c = sC.get(k) ?? 0;
    const b = sB.get(k) ?? 0;
    if (affected.has(s)) {
      const ck = JSON.stringify([day, lane, det]);
      affectedDelta.set(ck, (affectedDelta.get(ck) ?? 0) + (c - b));
    } else {
      if (!near(c, b)) moved++;
      checks.I2.ok(near(c, b), "unaffected-session-moved", {
        day,
        lane,
        detector: det,
        session: s,
        candidate_u: c,
        baseline_u: b,
      });
    }
  }
  for (const k of new Set([...cC.keys(), ...cB.keys()])) {
    const dc = (cC.get(k) ?? 0) - (cB.get(k) ?? 0);
    const ds = affectedDelta.get(k) ?? 0;
    checks.I2.ok(near(dc, ds), "cell-delta-unexplained", {
      cell: k,
      cell_delta_u: dc,
      affected_sessions_delta_u: ds,
    });
  }
  info.unaffected_session_rows_moved = moved;

  // ── I3a/b: D1 eligibility per agent, read off the code's own per-turn claims ──
  const sources = new Map(
    (
      db.prepare("SELECT probe_id, component FROM context_inventory").all() as Array<{
        probe_id: string;
        component: string;
      }>
    ).map((r) => [r.probe_id, r.component]),
  );
  const turnQ = db.prepare(
    "SELECT is_sidechain AS sc, agent_id FROM turns WHERE session_id = ? AND message_id = ?",
  );
  const typeQ = db.prepare("SELECT agent_type FROM subagent_meta WHERE agent_id = ?");
  const turnCache = new Map<string, TurnInfo>();
  const turnInfo = (key: string): TurnInfo => {
    let t = turnCache.get(key);
    if (t === undefined) {
      const bar = key.indexOf("|");
      const r = turnQ.get(key.slice(0, bar), key.slice(bar + 1)) as
        | { sc: number; agent_id: string | null }
        | undefined;
      t = { sidechain: r?.sc ?? 0, agentId: r?.agent_id ?? null };
      turnCache.set(key, t);
    }
    return t;
  };
  const agentType = (id: string | null) =>
    id === null
      ? null
      : ((typeQ.get(id) as { agent_type: string } | undefined)?.agent_type ?? null);
  let d1Claims = 0;
  let d1Sidechain = 0;
  for (const { run } of runs)
    for (const c of run.claims) {
      if (!isD1Claim(c)) continue;
      d1Claims++;
      const component = sources.get(c.slice.replace(/^prefix:/, ""));
      const t = turnInfo(c.turnKey);
      const type = agentType(t.agentId);
      const at = { turn: c.turnKey, slice: c.slice, agent: t.agentId, agent_type: type };
      checks.I3.ok(component !== undefined, "d1-unknown-source", at);
      if (t.sidechain === 1) d1Sidechain++;
      if (component === "CLAUDE_MD")
        checks.I3.ok(
          !(t.sidechain === 1 && (type === "Explore" || type === "Plan")),
          "d1-claude-on-explore-agent",
          at,
        );
      else if (component === "MEMORY")
        checks.I3.ok(t.sidechain === 0 || type === "fork", "d1-memory-on-non-fork", at);
    }
  info.d1_claims = d1Claims;
  info.d1_sidechain_claims = d1Sidechain;

  // ── I3c: metamorphic — only D1 may read the agent type ──
  if (ctx.withClone) {
    const rewritten = new Set(
      (
        db
          .prepare(
            "SELECT agent_id AS a FROM subagent_meta WHERE agent_type IN ('Explore', 'Plan', 'fork')",
          )
          .all() as Array<{ a: string }>
      ).map((r) => r.a),
    );
    const group = (claims: LClaim[]) => {
      const m = new Map<string, { d1: string[]; rest: string[] }>();
      for (const c of claims) {
        const cur = m.get(c.turnKey) ?? { d1: [], rest: [] };
        (isD1Claim(c) ? cur.d1 : cur.rest).push(claimKey(c));
        m.set(c.turnKey, cur);
      }
      for (const v of m.values()) {
        v.d1.sort();
        v.rest.sort();
      }
      return m;
    };
    ctx.withClone((clone) => {
      clone
        .prepare(
          "UPDATE subagent_meta SET agent_type = 'general-purpose' WHERE agent_type IN ('Explore', 'Plan', 'fork')",
        )
        .run();
      let d1Diff = 0;
      let turnsCompared = 0;
      for (const { start, end, run } of runs) {
        const A = group(run.claims);
        const B = group(engine.run(clone, start, end).claims);
        for (const t of new Set([...A.keys(), ...B.keys()])) {
          const a = A.get(t) ?? { d1: [], rest: [] };
          const b = B.get(t) ?? { d1: [], rest: [] };
          turnsCompared++;
          if (a.d1.join("\n") !== b.d1.join("\n")) {
            d1Diff++;
            const agent = turnInfo(t).agentId;
            checks.I3.ok(agent !== null && rewritten.has(agent), "mr-d1-outside-agent", {
              turn: t,
              agent,
            });
          } else {
            checks.I3.ok(a.rest.join("\n") === b.rest.join("\n"), "mr-nond1-moved", {
              turn: t,
              candidate: a.rest.slice(0, 3),
              agent_type_rewritten: b.rest.slice(0, 3),
            });
          }
        }
      }
      info.mr = {
        rewritten_agents: rewritten.size,
        turns_compared: turnsCompared,
        d1_turns_that_differ: d1Diff,
      };
    });
  } else info.mr = "skipped";

  // ── I3d: reliability lane = the sidechain oracle with the new billed base ──
  if (ctx.reliability) {
    const r = ctx.reliability();
    checks.I3.ok(r.ok, "reliability-oracle", { detail: r.detail });
  } else info.reliability = "skipped";

  // ── I4: conservation ──
  if (ctx.l9) {
    const r = ctx.l9();
    checks.I4.ok(r.ok, "l9", { failed: r.failed, detail: r.detail });
  } else info.l9 = "skipped";
  const claimedRows = db
    .prepare(
      `SELECT lane, day, component, SUM(tokens) AS tokens, SUM(value_u) AS v FROM ledger_daily
        WHERE block_start IN (SELECT value FROM json_each(?)) GROUP BY lane, day, component`,
    )
    .all(starts) as Array<{
    lane: string;
    day: string;
    component: string;
    tokens: number;
    v: number;
  }>;
  for (const r of claimedRows) {
    const i = COMPONENTS.indexOf(r.component as (typeof COMPONENTS)[number]);
    const row = sqlAll.get(r.day);
    const at = { lane: r.lane, day: r.day, component: r.component };
    if (i < 0) {
      checks.I4.ok(false, "unknown-component", at);
      continue;
    }
    const billedTokens = Number(row?.[`tok_${i}`] ?? 0);
    const billedU = Number(row?.[`usd_${i}`] ?? 0);
    checks.I4.ok(r.tokens <= billedTokens, "claimed>billed-tokens", {
      ...at,
      claimed: r.tokens,
      billed: billedTokens,
    });
    checks.I4.ok(r.v <= billedU + tol(billedU), "claimed>billed-value", {
      ...at,
      claimed: r.v,
      billed: billedU,
    });
  }

  // ── I5: no affected agents => ledger identical to baseline ──
  const anyAgentType = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM subagent_meta WHERE agent_type IN ('Explore', 'Plan', 'fork')",
      )
      .get() as { n: number }
  ).n;
  if (anyAgentType === 0) {
    checks.I5.ok(ledgerDump(db) === ledgerDump(baseline), "ledger-changed");
    if (ctx.goldenSame) checks.I5.ok(ctx.goldenSame(), "golden-changed");
  } else info.i5 = "n/a: the DB has Explore/Plan/fork agents";

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

// ── Self-check ────────────────────────────────────────────────────────────────

const SELF_E = Date.UTC(2026, 8, 28);
const TS = (s: string) => `2026-${s}:00.000Z`;

/** What the fake "ledger" does. Correct = the spec; each mutation flips one field. */
interface Cfg {
  /** billed base: every turn ("none"), or the OLD session-scoped Explore/Plan exclusion. */
  base: "none" | "old";
  /** result-claims' own billed set (loadBilledTurns). */
  resultBase: "none" | "old";
  claudeMd: "agent" | "session" | "off";
  memory: "agent" | "session";
  provisionalInBase: boolean;
}
const GOOD: Cfg = {
  base: "none",
  resultBase: "none",
  claudeMd: "agent",
  memory: "agent",
  provisionalInBase: false,
};
const OLD: Cfg = {
  base: "old",
  resultBase: "old",
  claudeMd: "session",
  memory: "session",
  provisionalInBase: false,
};

const OLD_EXCLUDED = `t.is_sidechain = 1 AND EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.session_id = t.session_id AND sm.agent_type IN ('Explore','Plan'))`;
const D1_TARGET = { CLAUDE_MD: 2000, MEMORY: 1000 } as const;

/** A miniature claim ledger over the fixture: D1 (agent-keyed), A1 (result family), D2 (main only). */
function fakeEngine(cfg: Cfg): Engine {
  return {
    run(db, fromIso, toIso) {
      const turns = db
        .prepare(
          `SELECT t.session_id AS s, t.message_id AS m, t.workspace_id AS w, t.is_sidechain AS sc, t.agent_id AS a,
                  t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h,
                  ${COMPONENTS.map((_, i) => `(${PRICE(i)}) AS pr${i}`).join(", ")},
                  (${OLD_EXCLUDED}) AS old_excluded,
                  (SELECT sm.agent_type FROM subagent_meta sm WHERE sm.agent_id = t.agent_id) AS own_type,
                  EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.session_id = t.session_id AND sm.agent_type IN ('Explore','Plan')) AS s_explore,
                  EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.session_id = t.session_id AND sm.agent_type = 'fork') AS s_fork
             ${FROM_TURNS} WHERE t.ts >= ? AND t.ts < ? ${cfg.provisionalInBase ? "" : "AND t.provisional = 0"}
            ORDER BY t.session_id, t.message_id`,
        )
        .all(fromIso, toIso) as Array<Record<string, number | string | null>>;
      const billedTokens = new Map<string, number>();
      const billedValue = new Map<string, number>();
      const claims: LClaim[] = [];
      const push = (
        r: Record<string, number | string | null>,
        det: string,
        lane: string,
        comp: number,
        tokens: number,
        slice: string,
        rec: string,
      ) => {
        if (tokens <= 0) return;
        claims.push({
          detectorId: det,
          lane,
          turnKey: `${r.s}|${r.m}`,
          component: COMPONENTS[comp] as string,
          slice,
          recId: rec,
          tokens,
          value_u: tokens * Number(r[`pr${comp}`]),
        });
      };
      for (const r of turns) {
        if (cfg.base === "old" && r.old_excluded === 1) continue;
        COMPONENTS.forEach((c, i) => {
          const cell = JSON.stringify([`${r.s}|${r.m}`, c]);
          billedTokens.set(cell, Number(r[TOKEN_COLS[i] as string]));
          billedValue.set(cell, Number(r[TOKEN_COLS[i] as string]) * Number(r[`pr${i}`]));
        });
        const cr = Number(r.cache_read_tokens);
        const side = r.sc === 1;
        const claudeOk =
          !side ||
          (cfg.claudeMd === "off"
            ? true
            : cfg.claudeMd === "session"
              ? r.s_explore === 0
              : r.own_type !== "Explore" && r.own_type !== "Plan");
        const memOk = !side || (cfg.memory === "session" ? r.s_fork === 1 : r.own_type === "fork");
        if (cr > 0 && claudeOk && cr > 0)
          push(
            r,
            "D1",
            "spend",
            2,
            Math.min(cr, D1_TARGET.CLAUDE_MD),
            "prefix:pc",
            "rec-D1-claude",
          );
        if (cr > 0 && memOk)
          push(r, "D1", "spend", 2, Math.min(cr, D1_TARGET.MEMORY), "prefix:pm", "rec-D1-mem");
        const resultOk = cfg.resultBase === "old" ? r.old_excluded !== 1 : true;
        if (side && resultOk)
          push(r, "A1", "spend", 1, Number(r.output_tokens), "result:x", "rec-A1");
        if (!side) push(r, "D2", "spend", 0, Number(r.input_tokens), "history:*", "rec-D2");
      }
      return { billedTokens, billedValue, claims };
    },
  };
}

interface Variant {
  cfg: Cfg;
  /** Fixture without Explore/Plan/fork agents (the seed shape). */
  plain?: boolean;
}

function selfDb(v: Variant): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE turns (message_id TEXT NOT NULL, session_id TEXT NOT NULL, ts TEXT NOT NULL, workspace_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_5m INTEGER,
      cache_write_1h INTEGER, pricing_snapshot_id TEXT, is_sidechain INTEGER NOT NULL DEFAULT 0,
      provisional INTEGER NOT NULL DEFAULT 0, agent_id TEXT, PRIMARY KEY (session_id, message_id));
    CREATE TABLE subagent_meta (agent_id TEXT PRIMARY KEY, session_id TEXT, agent_type TEXT);
    CREATE TABLE context_inventory (probe_id TEXT PRIMARY KEY, component TEXT);
    CREATE TABLE ledger_daily (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, rec_id TEXT,
      component TEXT, value_u REAL, tokens INTEGER);
    CREATE TABLE ledger_daily_top (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, session_id TEXT,
      message_id TEXT, ts TEXT, value_u REAL);
    CREATE TABLE ledger_daily_sessions (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, session_id TEXT, value_u REAL);
    CREATE TABLE ledger_daily_marks (block_start TEXT PRIMARY KEY, block_end TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p1', '[2,10,1,3,4]')").run();
  db.prepare("INSERT INTO context_inventory VALUES ('pc', 'CLAUDE_MD'), ('pm', 'MEMORY')").run();
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?, 'w1', ?,?,?,0,0,'p1',?,?,?)");
  // turn(message, session, ts, agent, sidechain, [in, out, cacheRead], provisional)
  const turn = (
    m: string,
    s: string,
    ts: string,
    agent: string | null,
    sc: 0 | 1,
    tok: [number, number, number],
    prov: 0 | 1 = 0,
  ) => ins.run(m, s, ts, tok[0], tok[1], tok[2], sc, prov, agent);
  const meta = db.prepare("INSERT INTO subagent_meta VALUES (?,?,?)");
  // S1: unaffected session (a general-purpose subagent), plus a pre-migration sidechain turn without an agent.
  turn("m1", "S1", TS("09-26T08:00"), null, 0, [100, 10, 4000]);
  turn("m2", "S1", TS("09-26T08:01"), null, 0, [200, 20, 3500]);
  meta.run("AH", "S1", "general-purpose");
  turn("h1", "S1", TS("09-26T09:00"), "AH", 1, [50, 500, 3000]);
  turn("z1", "S1", TS("09-26T09:30"), null, 1, [60, 600, 3000]);
  turn("p1", "S1", TS("09-26T10:00"), null, 0, [9000, 90, 9000], 1); // provisional, never billed
  if (!v.plain) {
    // S2: an Explore session: the Explore agent's own turns, and a general-purpose agent's turns.
    turn("n1", "S2", TS("09-25T08:00"), null, 0, [100, 10, 4000]);
    meta.run("AE", "S2", "Explore");
    turn("e1", "S2", TS("09-25T09:00"), "AE", 1, [70, 700, 3000]);
    turn("e2", "S2", TS("09-25T09:01"), "AE", 1, [80, 800, 3200]);
    meta.run("AG", "S2", "general-purpose");
    turn("g1", "S2", TS("09-25T09:10"), "AG", 1, [90, 900, 3000]);
    turn("g2", "S2", TS("09-25T09:11"), "AG", 1, [95, 950, 3100]);
    // S3: a fork session: the fork's turns, and another agent's turns.
    turn("f0", "S3", TS("09-24T08:00"), null, 0, [100, 10, 4000]);
    meta.run("AF", "S3", "fork");
    turn("f1", "S3", TS("09-24T09:00"), "AF", 1, [110, 1100, 3000]);
    meta.run("AK", "S3", "codex-worker");
    turn("k1", "S3", TS("09-24T09:10"), "AK", 1, [120, 1200, 3000]);
  }
  materialize(db, fakeEngine(v.cfg));
  return db;
}

/** Write ledger_daily / _sessions the way the real writer aggregates claims (per block, per day). */
function materialize(db: Db, engine: Engine) {
  const dayOfTurn = new Map(
    (
      db
        .prepare("SELECT session_id AS s, message_id AS m, date(ts) AS d FROM turns")
        .all() as Array<{ s: string; m: string; d: string }>
    ).map((r) => [`${r.s}|${r.m}`, r.d]),
  );
  const insC = db.prepare("INSERT INTO ledger_daily VALUES (?,?,?,?,?,?,?,?)");
  const insS = db.prepare("INSERT INTO ledger_daily_sessions VALUES (?,?,?,?,?,?)");
  const mark = db.prepare("INSERT INTO ledger_daily_marks VALUES (?,?)");
  for (const b of grid(SELF_E)) {
    mark.run(b.start, b.end);
    const cells = new Map<string, { v: number; t: number; a: unknown[] }>();
    const sess = new Map<string, number>();
    for (const c of engine.run(db, b.start, b.end).claims) {
      const day = dayOfTurn.get(c.turnKey) as string;
      const ck = JSON.stringify([day, c.lane, c.detectorId, c.recId, c.component]);
      const cell = cells.get(ck) ?? {
        v: 0,
        t: 0,
        a: [b.start, day, c.lane, c.detectorId, c.recId, c.component],
      };
      cell.v += c.value_u;
      cell.t += c.tokens;
      cells.set(ck, cell);
      const sk = JSON.stringify([
        day,
        c.lane,
        c.detectorId,
        c.turnKey.slice(0, c.turnKey.indexOf("|")),
      ]);
      sess.set(sk, (sess.get(sk) ?? 0) + c.value_u);
    }
    for (const c of cells.values()) insC.run(...c.a, c.v, c.t);
    for (const [k, v] of sess) {
      const [day, lane, det, s] = JSON.parse(k) as string[];
      insS.run(b.start, day, lane, det, s, v);
    }
  }
}

interface SelfMutation {
  name: string;
  fails: CheckId;
  what: string;
  variant?: Variant;
  /** Post-edit of the candidate's ledger tables. */
  apply?: (db: Db) => void;
}

const SELF_MUTATIONS: SelfMutation[] = [
  {
    name: "old session-scoped filter kept in the billed base",
    fails: "I1",
    what: "billed-turn-set",
    variant: { cfg: { ...GOOD, base: "old", resultBase: "old" } },
  },
  {
    name: "filter kept only in loadBilledTurns (result claims)",
    fails: "I3",
    what: "mr-nond1-moved",
    variant: { cfg: { ...GOOD, resultBase: "old" } },
  },
  {
    name: "D1 CLAUDE.md eligibility left session-scoped",
    fails: "I3",
    what: "mr-d1-outside-agent",
    variant: { cfg: { ...GOOD, claudeMd: "session" } },
  },
  {
    name: "D1 MEMORY eligibility left session-scoped",
    fails: "I3",
    what: "d1-memory-on-non-fork",
    variant: { cfg: { ...GOOD, memory: "session" } },
  },
  {
    name: "D1 keyed on the session instead of the agent (both components)",
    fails: "I3",
    what: "mr-d1-outside-agent",
    variant: { cfg: { ...GOOD, claudeMd: "session", memory: "session" } },
  },
  {
    name: "provisional turns let into the base",
    fails: "I1",
    what: "billed-turn-set",
    variant: { cfg: { ...GOOD, provisionalInBase: true } },
  },
  {
    name: "D1 CLAUDE.md claims the Explore agent's own turns",
    fails: "I3",
    what: "d1-claude-on-explore-agent",
    variant: { cfg: { ...GOOD, claudeMd: "off" } },
  },
  {
    name: "billed base tokens off by one on a day",
    fails: "I1",
    what: "billed-tokens",
    apply: () => undefined,
  },
  {
    name: "unaffected session's claim moved (S1 sessions row +5 µ$)",
    fails: "I2",
    what: "unaffected-session-moved",
    apply: (db) =>
      void db
        .prepare(
          "UPDATE ledger_daily_sessions SET value_u = value_u + 5 WHERE session_id = 'S1' AND detector_id = 'D2'",
        )
        .run(),
  },
  {
    name: "cell moved with no session to explain it",
    fails: "I2",
    what: "cell-delta-unexplained",
    apply: (db) =>
      void db
        .prepare("UPDATE ledger_daily SET value_u = value_u + 5 WHERE detector_id = 'D2'")
        .run(),
  },
  {
    name: "claimed tokens above billed",
    fails: "I4",
    what: "claimed>billed-tokens",
    apply: (db) =>
      void db
        .prepare("UPDATE ledger_daily SET tokens = tokens + 100000 WHERE detector_id = 'A1'")
        .run(),
  },
  {
    name: "seed-shaped DB (no Explore/Plan/fork) whose ledger changed",
    fails: "I5",
    what: "ledger-changed",
    variant: { cfg: GOOD, plain: true },
    apply: (db) =>
      void db
        .prepare("UPDATE ledger_daily SET value_u = value_u + 1 WHERE detector_id = 'D1'")
        .run(),
  },
];

function selfCtx(db: Db, baseline: Db, cfg: Cfg): Ctx {
  return {
    db,
    baseline,
    engine: fakeEngine(cfg),
    e: SELF_E,
    blocks: BLOCKS,
    windows: [7, 14, 30],
    withClone: (fn) => {
      const clone = new Database(db.serialize());
      try {
        return fn(clone as unknown as Db);
      } finally {
        clone.close();
      }
    },
  };
}

function selfCheck(): number {
  let bad = 0;
  const report = (name: string, ok: boolean, detail = "") => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const baseFull = selfDb({ cfg: OLD });
  const basePlain = selfDb({ cfg: OLD, plain: true });

  const clean = verify(selfCtx(selfDb({ cfg: GOOD }), baseFull, GOOD));
  report("clean case passes I1..I5", clean.ok, JSON.stringify(clean.failed_checks));
  report(
    "clean case exercised every check (I5 n/a with affected agents)",
    (["I1", "I2", "I3", "I4"] as const).every((id) => (clean.checks[id]?.pass ?? 0) > 0),
    (["I1", "I2", "I3", "I4"] as const).map((id) => clean.checks[id]?.pass).join(","),
  );
  const plainClean = verify(selfCtx(selfDb({ cfg: GOOD, plain: true }), basePlain, GOOD));
  report(
    "seed-shaped clean case passes and exercises I5",
    plainClean.ok && (plainClean.checks.I5?.pass ?? 0) > 0,
    JSON.stringify(plainClean.failed_checks),
  );

  // Hand figures: 12 non-provisional turns (p1 is provisional); the old rule would drop the 4 sidechain
  // turns of the Explore session S2 (e1, e2, g1, g2).
  const info = clean.info.billed_base_by_window_usd as Record<
    string,
    { sql_turns: number; old_rule_excluded_turns: number }
  >;
  report(
    "hand figure: 30d base has 12 turns, the old rule would drop the 4 Explore-session sidechain turns",
    info["30d"]?.sql_turns === 12 && info["30d"]?.old_rule_excluded_turns === 4,
    JSON.stringify(info["30d"]),
  );

  for (const m of SELF_MUTATIONS) {
    const v: Variant = m.variant ?? { cfg: GOOD };
    const db = selfDb(v);
    if (m.name === "billed base tokens off by one on a day") {
      // The ledger's billed map disagrees with SQL: an engine that under-reports one cell.
      const cfg = v.cfg;
      const inner = fakeEngine(cfg);
      const ctx = selfCtx(db, v.plain ? basePlain : baseFull, cfg);
      ctx.engine = {
        run(d, from, to) {
          const r = inner.run(d, from, to);
          const first = r.billedTokens.keys().next().value as string | undefined;
          if (first !== undefined)
            (r.billedTokens as Map<string, number>).set(
              first,
              (r.billedTokens.get(first) ?? 0) + 1,
            );
          return r;
        },
      };
      const r = verify(ctx);
      const hit = (r.checks.I1?.by_what["billed-tokens"] ?? 0) > 0;
      report(`mutation caught: ${m.name}`, hit, `failed=${JSON.stringify(r.failed_checks)}`);
      continue;
    }
    m.apply?.(db);
    const r = verify(selfCtx(db, v.plain ? basePlain : baseFull, v.cfg));
    const labelled = (r.checks[m.fails]?.by_what[m.what] ?? 0) > 0;
    report(
      `mutation caught: ${m.name}`,
      r.failed_checks.includes(m.fails) && labelled,
      `failed=${JSON.stringify(r.failed_checks)} want=${m.fails}/${m.what} got=${JSON.stringify(r.checks[m.fails]?.by_what)}`,
    );
  }
  console.log(bad === 0 ? "SELF-CHECK PASS" : `SELF-CHECK FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: billed-base-check.ts --db <prepared> --views <dir> --as-of <iso> --baseline-db <prepared pre-change>\n         [--window 7|14|30] [--blocks 9] [--work-dir <dir>] [--skip-mr] [--skip-reliability] [--skip-l9]\n         [--golden <path> --golden-ref <git ref>]\n         | --self-check`,
  );
  process.exit(2);
}

const openDb = (p: string, readonly = true): Db => {
  if (!fs.existsSync(p)) usage(`db not found: ${p}`);
  return new Database(p, { readonly, fileMustExist: true });
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const valued = new Set([
    "--db",
    "--views",
    "--as-of",
    "--baseline-db",
    "--window",
    "--blocks",
    "--work-dir",
    "--golden",
    "--golden-ref",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--self-check") return selfCheck();
    if (a === "--skip-mr" || a === "--skip-reliability" || a === "--skip-l9") bools.add(a);
    else if (valued.has(a)) {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) usage(`Missing value for ${a}`);
      flags.set(a, val);
    } else usage(`Unknown flag ${a}`);
  }
  const dbPath = flags.get("--db");
  const viewsDir = flags.get("--views");
  const asOf = flags.get("--as-of");
  const basePath = flags.get("--baseline-db");
  if (!dbPath) usage("--db is required");
  if (!basePath) usage("--baseline-db is required (a copy prepared on main before the change)");
  if (!asOf || !Number.isFinite(new Date(asOf).getTime())) usage("--as-of must be an ISO date");
  if (!viewsDir) usage("--views is required");
  const win = flags.get("--window");
  if (win !== undefined && win !== "7" && win !== "14" && win !== "30")
    usage("--window must be 7, 14 or 30");
  const windows = (win === undefined ? [7, 14, 30] : [Number(win)]) as Array<7 | 14 | 30>;
  const blocks = Number(flags.get("--blocks") ?? BLOCKS);
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > BLOCKS)
    usage(`--blocks must be 1..${BLOCKS}`);
  const e = Math.floor(new Date(asOf).getTime() / DAY_MS) * DAY_MS;

  const db = openDb(dbPath);
  const baseline = openDb(basePath);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const ctx: Ctx = { db, baseline, engine: await realEngine(), e, blocks, windows };

  if (!bools.has("--skip-mr"))
    ctx.withClone = (fn) => {
      const dir = flags.get("--work-dir") ?? os.tmpdir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `billed-base-mr-${process.pid}.sqlite`);
      fs.rmSync(file, { force: true });
      db.exec(`VACUUM INTO '${file.replace(/\\/g, "/").replace(/'/g, "''")}'`);
      const clone = new Database(file);
      try {
        return fn(clone as unknown as Db);
      } finally {
        clone.close();
        fs.rmSync(file, { force: true });
      }
    };
  if (!bools.has("--skip-reliability"))
    ctx.reliability = () => {
      const r = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(scriptDir, "sidechain-reliability-check.ts"),
          "--db",
          dbPath,
          "--views",
          viewsDir,
          "--as-of",
          asOf,
          // No --baseline-db: that oracle's baseline means "before sidechain pricing"; without it,
          // I1b checks main-chain claims against its own SQL expectation.
        ],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      );
      try {
        const j = JSON.parse(r.stdout) as Json;
        return {
          ok: r.status === 0 && j.ok === true,
          detail: {
            exit: r.status,
            failed_checks: j.failed_checks,
            info: j.info?.sidechain_by_window_usd,
          },
        };
      } catch {
        return { ok: false, detail: { exit: r.status, stderr: r.stderr.slice(0, 500) } };
      }
    };
  if (!bools.has("--skip-l9"))
    ctx.l9 = () => {
      const read = (name: string): Json =>
        JSON.parse(fs.readFileSync(path.join(viewsDir, name), "utf8"));
      const r = l9Verify(
        db,
        {
          cards: read("cards.json"),
          diagnostics: Object.fromEntries(windows.map((w) => [w, read(`diagnostics-${w}.json`)])),
        },
        { asOf, windows, allowIncomplete: false },
      );
      const failed = (["1a", "1b", "2", "3", "4"] as const).filter(
        (id) => (r.checks[id]?.fail ?? 0) > 0,
      );
      return {
        ok: failed.length === 0,
        failed,
        detail: {
          l9_failed_checks: r.failed_checks,
          by_what: Object.fromEntries(failed.map((id) => [id, r.checks[id]?.by_what])),
        },
      };
    };
  const golden = flags.get("--golden");
  const goldenRef = flags.get("--golden-ref");
  if (golden && goldenRef)
    ctx.goldenSame = () => {
      const rel = path.relative(repoRoot, path.resolve(golden)).replace(/\\/g, "/");
      const r = spawnSync("git", ["-C", repoRoot, "show", `${goldenRef}:${rel}`], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      return r.status === 0 && Buffer.compare(r.stdout, fs.readFileSync(golden)) === 0;
    };

  try {
    const report = verify(ctx);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    db.close();
    baseline.close();
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
