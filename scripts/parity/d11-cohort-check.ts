/**
 * P3.L follow-up — independent oracle for "D11 evidence cohort counts only real shell failures".
 * Contract: docs/plans/Archive/2026-09-30-d11-evidence-cohort-spec.md, "Invariants" (I1-I5).
 *
 * Written before the implementation and importing NOTHING from src/ (better-sqlite3 + node only).
 * For every D11 card with `trigger.evidence` the oracle rebuilds the cohort from raw tables over
 * the card's `trigger.window`: distinct RECONCILED sessions of the card's workspace with at least
 * one call of the card's `evidence.higher_error_tool` with `exit_class = 'ERROR'` whose stored
 * error `d11Outcome` calls ERROR (main-chain and sidechain calls both count).
 *
 * `SHELL_FAILURE` and the `^Exit code \d+` guard below are copied verbatim from
 * src/detector/turn-claim.ts (SHELL_FAILURE l.133-134, d11Outcome guard l.147-148).
 *
 *   npx tsx scripts/parity/d11-cohort-check.ts --db <prepared sqlite> --cards <candidate cards.json>
 *       --baseline-cards <baseline cards.json> [--seed]
 *   npx tsx scripts/parity/d11-cohort-check.ts --self-check
 *
 * `cards.json` is `buildRecommendations` output written by l9-dump-views.ts; cards are found by
 * walking the JSON for objects with `rec_id` and `detector_id`.
 * --seed: also require the whole cards.json to be byte-identical to the baseline when no D11 card
 * has a benign-only session (I5, spec last sentence).
 * Exit 0 = every invariant passed; 1 = a FAIL; 2 = bad flags/inputs. The DB is opened read-only.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type Db = Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: dump files are untrusted JSON; every read below is checked before use
type Json = any;

// ── Restatements (copied from src/detector/turn-claim.ts) ─────────────────────

const SHELL_FAILURE =
  /unexpected EOF while looking for matching|syntax error near unexpected token|syntax error: unexpected end of file|: command not found|bad substitution|is not recognized as the name of a cmdlet|^ParserError:|CategoryInfo\s*:\s*ParserError|Unexpected token .* in expression or statement|The string is missing the terminator|is not a valid statement separator|An empty pipe element is not allowed|Missing expression after/im;

/** Mutations of the oracle's own model; used only by --self-check to build a buggy candidate. */
export type BugName =
  | "no_outcome_filter" // the old rule: every ERROR call counts
  | "no_exit_guard" // the ^Exit code guard dropped (blocked calls counted)
  | "any_error_text" // SHELL_FAILURE replaced by "any error text"
  | "lower_shell" // the lower-error shell used
  | "no_workspace" // the workspace filter dropped
  | "no_sidechain"; // sidechain calls excluded
export type Bug = Partial<Record<BugName, true>>;

/** d11Outcome: null = never ran (blocked), ERROR = the shell itself failed, else OK. */
function d11IsError(exitClass: string | null, error: string | null, bug: Bug): boolean {
  if (bug.no_outcome_filter) return true;
  if (!bug.no_exit_guard && error !== null && !/^Exit code \d+/.test(error)) return false;
  if (exitClass !== "ERROR" || error === null) return false;
  return bug.any_error_text ? error.trim() !== "" : SHELL_FAILURE.test(error);
}

// ── Oracle cohort ─────────────────────────────────────────────────────────────

export interface D11Card {
  rec_id: string;
  tool: string;
  workspace: string;
  from: string;
  to: string;
}

const isShell = (t: unknown): t is "Bash" | "PowerShell" => t === "Bash" || t === "PowerShell";

/** Oracle cohort: distinct session ids for a card, from raw tool_events + the SHELL_FAILURE regex. */
export function oracleSet(db: Db, c: D11Card, bug: Bug = {}): Set<string> {
  const tool = bug.lower_shell ? (c.tool === "Bash" ? "PowerShell" : "Bash") : c.tool;
  const rows = db
    .prepare(
      `SELECT e.session_id AS session_id, e.exit_class AS exit_class,
              json_extract(c.content_json, '$.error') AS error_text
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
         ${
           bug.no_sidechain
             ? `LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id`
             : ""
         }
        WHERE e.ts >= @from AND e.ts < @to AND e.tool_name = @tool AND e.exit_class = 'ERROR'
          ${bug.no_workspace ? "" : "AND s.workspace_id = @ws"}
          ${bug.no_sidechain ? "AND COALESCE(t.is_sidechain, 0) = 0" : ""}`,
    )
    .all({
      from: c.from,
      to: c.to,
      tool,
      ...(bug.no_workspace ? {} : { ws: c.workspace }),
    }) as Array<{ session_id: string; exit_class: string | null; error_text: unknown }>;
  const out = new Set<string>();
  for (const r of rows) {
    const err = typeof r.error_text === "string" ? r.error_text : null;
    if (d11IsError(r.exit_class, err, bug)) out.add(r.session_id);
  }
  return out;
}

// ── Cards ─────────────────────────────────────────────────────────────────────

/** Every card object (has string rec_id + detector_id) anywhere in the JSON; first rec_id wins. */
export function collectCards(json: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  const walk = (v: Json) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (typeof v.rec_id === "string" && typeof v.detector_id === "string") {
      if (!out.has(v.rec_id)) out.set(v.rec_id, v);
      return;
    }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(json);
  return out;
}

/** The D11 card's cohort inputs, or null when the cohort query is not defined for it. */
function d11Card(card: Json): D11Card | null {
  if (card.detector_id !== "D11") return null;
  const tool = card.evidence?.higher_error_tool;
  const w = card.trigger?.window;
  if (!isShell(tool) || typeof card.scope_workspace_id !== "string") return null;
  if (!w || typeof w.from !== "string" || typeof w.to !== "string") return null;
  return {
    rec_id: card.rec_id,
    tool,
    workspace: card.scope_workspace_id,
    from: w.from,
    to: w.to,
  };
}

interface Listed {
  session_id: string;
  claimed_u: number | null;
  turn_count: number;
}
const listedOf = (card: Json): Listed[] | null => {
  const s = card.trigger?.evidence?.sessions;
  return Array.isArray(s) ? (s as Listed[]) : null;
};
const hasData = (s: Listed) => s.claimed_u !== null || s.turn_count !== 0;

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
    if (this.rows.length < 6) this.rows.push({ what, ...detail });
  }
}
const CHECK_IDS = ["I1", "I2", "I3", "I4", "I5"] as const;
type CheckId = (typeof CHECK_IDS)[number];

export interface Report {
  ok: boolean;
  failed: CheckId[];
  checks: Record<CheckId, Check>;
  cardLines: string[];
  notes: string[];
}

// ── verify ────────────────────────────────────────────────────────────────────

/** The order the card ranks its cohort in: claimed desc (null last), turns desc, id asc. */
const rankCmp = (a: Listed, b: Listed) =>
  (b.claimed_u ?? -1) - (a.claimed_u ?? -1) ||
  b.turn_count - a.turn_count ||
  (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0);

export function verify(
  db: Db,
  cand: Json,
  base: Json,
  opts: { seed: boolean },
): Report {
  const checks = Object.fromEntries(CHECK_IDS.map((id) => [id, new Check()])) as Record<
    CheckId,
    Check
  >;
  const cardLines: string[] = [];
  const notes: string[] = [];
  const candCards = collectCards(withoutHeadlineChange(cand));
  const baseCards = collectCards(withoutHeadlineChange(base));
  let benignOnly = 0;

  for (const [recId, card] of candCards) {
    const c = d11Card(card);
    if (c === null) continue;
    const ev = card.trigger?.evidence;
    const set = oracleSet(db, c);
    const oldSet = oracleSet(db, c, { no_outcome_filter: true });
    for (const id of oldSet) if (!set.has(id)) benignOnly++;
    if (ev === undefined || ev === null) {
      checks.I2.ok(false, "evidence-missing", { rec_id: recId });
      cardLines.push(`D11 ${recId} tool=${c.tool} candidate=<no trigger.evidence> oracle=${set.size}`);
      continue;
    }
    const listed = listedOf(card) ?? [];
    cardLines.push(
      `D11 ${recId} tool=${c.tool} ws=${c.workspace} session_count candidate=${ev.session_count} oracle=${set.size} listed=${listed.length}`,
    );

    // I1: membership. Listed sessions that carry a claim or turns are cohort members; the oracle
    // set must contain them, and there cannot be more listed members than session_count says.
    const ids = listed.map((s) => s.session_id);
    checks.I1.ok(new Set(ids).size === ids.length, "listed-duplicate", { rec_id: recId });
    for (const s of listed)
      if (hasData(s))
        checks.I1.ok(set.has(s.session_id), "listed-member-not-in-oracle-set", {
          rec_id: recId,
          session_id: s.session_id,
          claimed_u: s.claimed_u,
          turn_count: s.turn_count,
        });
    const members = listed.filter((s) => hasData(s)).length;
    checks.I1.ok(
      typeof ev.session_count === "number" && members <= ev.session_count,
      "more-listed-members-than-session_count",
      { rec_id: recId, members, session_count: ev.session_count },
    );

    // I2: count.
    checks.I2.ok(ev.session_count === set.size, "session_count!=oracle", {
      rec_id: recId,
      candidate: ev.session_count,
      oracle: set.size,
    });

    // I3: values unchanged, for sessions in both cohorts (oracle set is inside the old cohort).
    const b = baseCards.get(recId);
    const bListed = b ? (listedOf(b) ?? []) : [];
    const bById = new Map(bListed.map((s) => [s.session_id, s]));
    for (const s of listed) {
      const old = bById.get(s.session_id);
      if (old === undefined || !set.has(s.session_id)) continue;
      checks.I3.ok(
        JSON.stringify({ claimed_u: s.claimed_u, turn_count: s.turn_count }) ===
          JSON.stringify({ claimed_u: old.claimed_u, turn_count: old.turn_count }),
        "values-changed",
        {
          rec_id: recId,
          session_id: s.session_id,
          candidate: [s.claimed_u, s.turn_count],
          baseline: [old.claimed_u, old.turn_count],
        },
      );
    }

    // I4: order. After the call-group leads, cohort members follow rank order.
    const leads = new Set<string>(
      (Array.isArray(card.trigger?.calls) ? card.trigger.calls : [])
        .map((x: Json) => x?.session_ids?.[0])
        .filter((x: unknown): x is string => typeof x === "string"),
    );
    let i = 0;
    while (i < listed.length && leads.has((listed[i] as Listed).session_id)) i++;
    const seq = listed.slice(i).filter((s) => set.has(s.session_id));
    for (let k = 1; k < seq.length; k++)
      checks.I4.ok(rankCmp(seq[k - 1] as Listed, seq[k] as Listed) <= 0, "out-of-order", {
        rec_id: recId,
        before: (seq[k - 1] as Listed).session_id,
        after: (seq[k] as Listed).session_id,
      });
  }

  // I5: nothing else moves.
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  checks.I5.ok(
    candCards.size === baseCards.size && [...candCards.keys()].every((k) => baseCards.has(k)),
    "card-set-differs",
    { candidate: candCards.size, baseline: baseCards.size },
  );
  for (const [recId, card] of candCards) {
    const b = baseCards.get(recId);
    if (b === undefined) continue;
    for (const f of ["allocated_u_per_wk", "modeled_savings_u_per_wk", "title"] as const)
      checks.I5.ok(same(card[f], b[f]), `${f}-changed`, {
        rec_id: recId,
        candidate: card[f],
        baseline: b[f],
      });
    if (card.detector_id !== "D11")
      checks.I5.ok(same(card.trigger, b.trigger), "non-d11-trigger-changed", {
        rec_id: recId,
        detector_id: card.detector_id,
      });
  }
  if (opts.seed) {
    if (benignOnly === 0)
      // meta.window is the response's wall-clock window, not pinned by --now; every card must match.
      checks.I5.ok(
        same(withoutMetaWindow(withoutHeadlineChange(cand)), withoutMetaWindow(withoutHeadlineChange(base))),
        "seed-cards-not-byte-identical",
        { reason: "no D11 card has a benign-only session" },
      );
    else notes.push(`I5 seed byte-identity not required: ${benignOnly} benign-only session(s) in D11 cards`);
  }

  const failed = CHECK_IDS.filter((id) => checks[id].fail > 0);
  return { ok: failed.length === 0, failed, checks, cardLines, notes };
}

function printReport(r: Report) {
  for (const l of r.cardLines) console.log(l);
  for (const n of r.notes) console.log(`NOTE  ${n}`);
  for (const id of CHECK_IDS) {
    const c = r.checks[id];
    console.log(`${c.fail === 0 ? "PASS" : "FAIL"}  ${id}  pass=${c.pass} fail=${c.fail}`);
    if (c.fail > 0) {
      console.log(`      by_what ${JSON.stringify(Object.fromEntries(c.byWhat))}`);
      for (const row of c.rows) console.log(`      ${JSON.stringify(row)}`);
    }
  }
}

// ── Self-check ────────────────────────────────────────────────────────────────

const T = (s: string) => `2026-${s}:00.000Z`;
const WIN = { from: T("09-21T00:00"), to: T("09-28T00:00") };

/** Claimed $ per session (fixture stand-in for the ledger). */
const CLAIMS: Record<string, number> = { s1: 500, s4: 300, s6: 200, s5: 150 };

function selfDb(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT, workspace_id TEXT, state TEXT);
    CREATE TABLE tool_events (event_id TEXT, session_id TEXT, ts TEXT, tool_name TEXT, exit_class TEXT);
    CREATE TABLE tool_event_metadata (event_id TEXT, owner_message_id TEXT);
    CREATE TABLE tool_event_content (event_id TEXT, content_json TEXT);
    CREATE TABLE turns (message_id TEXT, session_id TEXT, ts TEXT, is_sidechain INTEGER, provisional INTEGER);
  `);
  const sess = db.prepare("INSERT INTO sessions VALUES (?,?,?)");
  const insE = db.prepare("INSERT INTO tool_events VALUES (?,?,?,?,?)");
  const insM = db.prepare("INSERT INTO tool_event_metadata VALUES (?,?)");
  const insC = db.prepare("INSERT INTO tool_event_content VALUES (?,?)");
  const insT = db.prepare("INSERT INTO turns VALUES (?,?,?,?,0)");
  let n = 0;
  const turns = (s: string, count: number) => {
    for (let i = 0; i < count; i++) insT.run(`${s}-t${i}`, s, T(`09-22T10:${String(i).padStart(2, "0")}`), 0);
  };
  const call = (
    s: string,
    tool: string,
    exit: string,
    error: string | null,
    o: { ts?: string; side?: boolean } = {},
  ) => {
    const id = `e${++n}`;
    const owner = `${s}-o${n}`;
    insE.run(id, s, o.ts ?? T("09-23T09:00"), tool, exit);
    insT.run(owner, s, o.ts ?? T("09-23T09:00"), o.side ? 1 : 0);
    insM.run(id, owner);
    if (error !== null) insC.run(id, JSON.stringify({ command: "x", error }));
  };
  const REAL = "Exit code 1\nParserError: bad token";
  const BLOCKED = "PreToolUse hook denied: foo: command not found";
  const BENIGN = "Exit code 1\nError: boom";
  const w1 = (...ids: string[]) => {
    for (const id of ids) sess.run(id, "w1", "RECONCILED");
  };
  w1("s1", "s2", "s3", "s4", "s5", "s7", "s10", "s11", "s12", "s13");
  sess.run("s6", "w2", "RECONCILED");
  sess.run("s9", "w1", "OPEN");
  // Cohort of the PowerShell card (w1): s1, s4 (sidechain only), s10, s11, s12.
  call("s1", "PowerShell", "ERROR", REAL);
  call("s4", "PowerShell", "ERROR", "Exit code 1\nx is not recognized as the name of a cmdlet", {
    side: true,
  });
  for (const s of ["s10", "s11", "s12"]) call(s, "PowerShell", "ERROR", REAL);
  // Never ran (blocked), script that ran and failed, no stored error: not D11 failures.
  call("s2", "PowerShell", "ERROR", BLOCKED);
  call("s3", "PowerShell", "ERROR", BENIGN);
  call("s13", "PowerShell", "ERROR", null);
  // Lower shell, other workspace, outside window, session not reconciled: not in the card.
  call("s5", "Bash", "ERROR", "Exit code 2\nsyntax error near unexpected token `)'");
  call("s6", "PowerShell", "ERROR", REAL);
  call("s7", "PowerShell", "ERROR", REAL, { ts: T("09-10T09:00") });
  call("s9", "PowerShell", "ERROR", REAL);
  // Empty-cohort card (workspace w3, Bash): only a benign failure.
  sess.run("s20", "w3", "RECONCILED");
  call("s20", "Bash", "ERROR", BENIGN);
  turns("s1", 4);
  turns("s4", 3);
  turns("s10", 9);
  turns("s11", 9);
  turns("s12", 2);
  turns("s2", 20);
  turns("s3", 15);
  turns("s13", 12);
  turns("s5", 5);
  turns("s6", 6);
  turns("s20", 2);
  return db;
}

/**
 * A model of the candidate implementation: cohort from `oracleSet` with a bug, claimed $ from
 * CLAIMS, turns from raw `turns`, order claimed desc / turns desc / id asc, listed top 5.
 */
function selfCards(db: Db, bug: Bug, mutate?: (cards: Json[]) => void): Json {
  const turnQ = db.prepare(
    "SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND ts >= ? AND ts < ? AND provisional = 0 AND is_sidechain = 0",
  );
  const mk = (rec: string, tool: string, ws: string, stored: string[]): Json => {
    const c: D11Card = { rec_id: rec, tool, workspace: ws, ...WIN };
    const cohort = [...oracleSet(db, c, bug)]
      .map((id) => ({
        session_id: id,
        claimed_u: CLAIMS[id] ?? null,
        turn_count: (turnQ.get(id, WIN.from, WIN.to) as { n: number }).n,
      }))
      .sort(rankCmp);
    const sessions =
      cohort.length > 0
        ? cohort.slice(0, 5)
        : stored.map((id) => ({ session_id: id, claimed_u: null, turn_count: 0 }));
    return {
      rec_id: rec,
      detector_id: "D11",
      scope_workspace_id: ws,
      title: `Fix ${tool}`,
      allocated_u_per_wk: 1000,
      modeled_savings_u_per_wk: 500,
      evidence: { higher_error_tool: tool },
      trigger: {
        window: WIN,
        session_ids: sessions.map((s) => s.session_id),
        evidence: { session_count: cohort.length, sessions },
        calls: [],
      },
    };
  };
  const cards = [
    mk("rec-ps", "PowerShell", "w1", ["s1"]),
    mk("rec-empty", "Bash", "w3", ["s20"]),
    {
      rec_id: "rec-c1",
      detector_id: "C1",
      scope_workspace_id: "w1",
      title: "Tool errors",
      allocated_u_per_wk: 77,
      modeled_savings_u_per_wk: 33,
      evidence: {},
      trigger: { window: WIN, session_ids: ["s3", "s2"] },
    },
  ];
  mutate?.(cards);
  return { data: { active: cards } };
}

const MUTATIONS: Array<{
  name: string;
  fails: CheckId;
  bug?: Bug;
  mutate?: (cards: Json[]) => void;
}> = [
  { name: "d11Outcome filter dropped (the old rule)", fails: "I2", bug: { no_outcome_filter: true } },
  { name: "^Exit code guard dropped (blocked calls counted)", fails: "I2", bug: { no_exit_guard: true } },
  { name: "SHELL_FAILURE replaced by any error text", fails: "I2", bug: { any_error_text: true } },
  { name: "lower-error shell used", fails: "I2", bug: { lower_shell: true } },
  { name: "workspace filter dropped", fails: "I1", bug: { no_workspace: true } },
  { name: "sidechain calls excluded", fails: "I2", bug: { no_sidechain: true } },
  {
    name: "session_count off by one",
    fails: "I2",
    mutate: (c) => {
      c[0].trigger.evidence.session_count += 1;
    },
  },
  {
    name: "listed session with a claim outside the cohort (s3)",
    fails: "I1",
    mutate: (c) => {
      c[0].trigger.evidence.sessions.push({ session_id: "s3", claimed_u: 10, turn_count: 15 });
    },
  },
  {
    name: "order: turn count before claimed $",
    fails: "I4",
    mutate: (c) => {
      c[0].trigger.evidence.sessions.sort(
        (a: Listed, b: Listed) => b.turn_count - a.turn_count || (a.session_id < b.session_id ? -1 : 1),
      );
    },
  },
  {
    name: "order: id ties reversed",
    fails: "I4",
    mutate: (c) => {
      const s: Listed[] = c[0].trigger.evidence.sessions;
      const i = s.findIndex((x) => x.session_id === "s10");
      const j = s.findIndex((x) => x.session_id === "s11");
      [s[i], s[j]] = [s[j] as Listed, s[i] as Listed];
    },
  },
  {
    name: "claimed_u changed for a cohort session",
    fails: "I3",
    mutate: (c) => {
      c[0].trigger.evidence.sessions[0].claimed_u = 499;
    },
  },
  {
    name: "turn_count changed for a cohort session",
    fails: "I3",
    mutate: (c) => {
      c[0].trigger.evidence.sessions[0].turn_count += 1;
    },
  },
  {
    name: "non-D11 card trigger changed",
    fails: "I5",
    mutate: (c) => {
      c[2].trigger.session_ids.reverse();
    },
  },
  {
    name: "allocated_u_per_wk changed",
    fails: "I5",
    mutate: (c) => {
      c[0].allocated_u_per_wk = 1001;
    },
  },
  {
    name: "modeled_savings_u_per_wk changed (non-D11)",
    fails: "I5",
    mutate: (c) => {
      c[2].modeled_savings_u_per_wk = 34;
    },
  },
  {
    name: "title changed",
    fails: "I5",
    mutate: (c) => {
      c[1].title = "Other";
    },
  },
  {
    name: "C1 problem changed before its savings derivation",
    fails: "I5",
    mutate: (c) => {
      c[2].trigger.problem = "Other failures. Estimated saving: 50% = $1 a week.";
    },
  },
  {
    name: "empty-cohort card lost its evidence",
    fails: "I2",
    mutate: (c) => {
      delete c[1].trigger.evidence;
    },
  },
];

function selfCheck(): number {
  let bad = 0;
  const report = (name: string, ok: boolean, detail = "") => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const db = selfDb();
  const baseline = selfCards(db, { no_outcome_filter: true });
  const clean = verify(db, selfCards(db, {}), baseline, { seed: false });
  report("clean candidate passes I1-I5", clean.ok, JSON.stringify(clean.failed));
  report(
    "clean case exercised every check",
    CHECK_IDS.every((id) => clean.checks[id].pass > 0),
    CHECK_IDS.map((id) => clean.checks[id].pass).join(","),
  );
  const set = oracleSet(db, { rec_id: "x", tool: "PowerShell", workspace: "w1", ...WIN });
  report(
    "hand-derived cohort = s1,s10,s11,s12,s4",
    [...set].sort().join(",") === "s1,s10,s11,s12,s4",
    [...set].sort().join(","),
  );
  const empty = oracleSet(db, { rec_id: "y", tool: "Bash", workspace: "w3", ...WIN });
  report("hand-derived empty cohort for w3/Bash", empty.size === 0);
  report(
    "baseline (old rule) fails I2 against the oracle",
    !verify(db, baseline, baseline, { seed: false }).ok,
  );
  const seedClean = verify(db, selfCards(db, {}), baseline, { seed: true });
  report(
    "--seed: byte-identity waived while benign-only sessions exist",
    seedClean.ok && seedClean.notes.length === 1,
  );

  const c1Problem = (tail: string) => (c: Json[]) => {
    c[2].trigger.problem = `Tool calls failed. Estimated saving: ${tail}`;
  };
  const headline = verify(
    db,
    selfCards(db, {}, (c) => {
      c1Problem("50% of the cost = $1 a week. The card headline shows ...")(c);
      c[2].reliability_u_per_wk = 9;
    }),
    selfCards(db, { no_outcome_filter: true }, c1Problem("the turns cost $2 × 50% = $1 a week.")),
    { seed: false },
  );
  report(
    "headline change waived (reliability_u_per_wk, C1 derivation tail)",
    headline.ok,
    JSON.stringify(headline.failed),
  );

  let caught = 0;
  for (const m of MUTATIONS) {
    const cand = selfCards(db, m.bug ?? {}, m.mutate);
    const r = verify(db, cand, baseline, { seed: false });
    const ok = r.failed.includes(m.fails);
    if (ok) caught++;
    report(`mutation caught: ${m.name}`, ok, `failed=${JSON.stringify(r.failed)} want=${m.fails}`);
  }
  report(`>= 6 mutations caught`, caught >= 6, `${caught}/${MUTATIONS.length}`);
  console.log(bad === 0 ? "SELF-CHECK PASS" : `SELF-CHECK FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: d11-cohort-check.ts --db <sqlite> --cards <cards.json> --baseline-cards <cards.json> [--seed]\n         | --self-check`,
  );
  process.exit(2);
}

function readJson(p: string): Json {
  if (!fs.existsSync(p)) usage(`file not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * The reliability card headline (docs/plans/Archive/2026-09-30-reliability-card-headline-spec.md, operator
 * 2026-10-01) adds `reliability_u_per_wk` to cards and rewrites C1's savings derivation (rule 10).
 * Neither is a D11 cohort concern: drop the field and C1's derivation tail on both sides.
 */
export function withoutHeadlineChange(cards: Json): Json {
  const copy = JSON.parse(JSON.stringify(cards));
  // Every occurrence, not collectCards' first one: the seed byte-identity compares the whole file.
  const walk = (v: Json) => {
    if (v === null || typeof v !== "object") return;
    if (typeof v.rec_id === "string" && typeof v.detector_id === "string") {
      delete v.reliability_u_per_wk;
      const problem = v.trigger?.problem;
      const cut = typeof problem === "string" ? problem.indexOf(" Estimated saving:") : -1;
      if (v.detector_id === "C1" && cut >= 0) v.trigger.problem = problem.slice(0, cut);
    }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(copy);
  return copy;
}

function withoutMetaWindow(cards: Json): Json {
  const { meta, ...rest } = cards;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return cards;
  const { window: _window, ...metaRest } = meta as Record<string, unknown>;
  return { ...rest, meta: metaRest };
}

function main(): number {
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
    if (a !== "--db" && a !== "--cards" && a !== "--baseline-cards") usage(`Unknown flag ${a}`);
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
  if (!fs.existsSync(dbPath)) usage(`db not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const r = verify(db, readJson(cardsPath), readJson(basePath), { seed });
    printReport(r);
    console.log(r.ok ? "D11-COHORT-CHECK PASS" : `D11-COHORT-CHECK FAIL (${r.failed.join(",")})`);
    return r.ok ? 0 : 1;
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
