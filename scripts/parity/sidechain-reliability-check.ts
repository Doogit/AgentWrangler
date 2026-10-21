/**
 * P3.L follow-up — independent oracle for "price sidechain (subagent) failures" (reliability lane).
 * Contract: docs/plans/Archive/2026-09-29-sidechain-failure-pricing-spec.md, "Invariants".
 *
 * Written before the implementation and without importing it. The sidechain family rules
 * (C7/C3/C4/C1/C2/D11, chain-keyed), the recovery turn R(t) and the pricing are all restated
 * below from raw `turns` / `tool_events` / `pricing_snapshots`. The only src/ imports, all lazy:
 *   - `wastedTurnCensus`   : the certified MAIN-chain issuing turns (I1b baseline only);
 *   - `analyzeD7LoopEvents`: D7's shared loop matcher (spec: allowed);
 *   - `d11WorseShells`     : the workspace worse-shell (spec: unchanged, allowed).
 *
 * `ledger_daily` has no chain column, so the oracle works on (day, family, component) cells:
 *   ledger cell = main-chain expected (census) + sidechain expected (this file).
 *   I2  : ledger - main == sidechain expected       (value_u and tokens)
 *   I1b : ledger - sidechain expected == baseline   (baseline ledger if given, else main expected)
 *
 *   npx tsx scripts/parity/sidechain-reliability-check.ts --db <prepared copy> --views <dir> --as-of <iso>
 *       [--window 7|14|30] [--baseline-db <pre-feature prepared copy>]      I1b, I2, I3, I4
 *   (l8-style aliases: --candidate-db = --db, --candidate = --views, --baseline = ignored views dir)
 *   npx tsx scripts/parity/sidechain-reliability-check.ts --self-check
 *
 * Exit 0 = all gated checks passed; 1 = a check failed; 2 = bad flags/inputs. DBs are opened read-only.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type Db = Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: dump files are untrusted JSON; every read below is checked before use
type Json = any;

// ── Restatements (no src/ imports of the feature) ─────────────────────────────

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

/** LEDGER_PRIORITY, reliability lane part (first wins a shared cell). */
const FAMILIES = ["C7", "C3", "C4", "C1", "C2", "C9", "D14", "D11"] as const;
type Family = (typeof FAMILIES)[number];
const RANK = new Map<string, number>(FAMILIES.map((f, i) => [f, i]));
/** The sidechain pass' families, in its own priority order. C9/D14 are main-chain only. */
const SC_FAMILIES = ["C7", "C3", "C4", "C1", "C2", "D11"] as const;
type ScFamily = (typeof SC_FAMILIES)[number];

/** Diagnostics reliability cause rows -> families (as in the L8 oracle). */
const CAUSE_FAMILIES: Readonly<Record<string, readonly Family[]>> = {
  BLOCKED_BY_PERMISSIONS: ["C9"],
  INTERRUPTED_OR_CANCELLED: ["D14"],
  SHELL_FAILS_IN_BURSTS: ["C7"],
  TOOLS_FAIL_MORE_THAN_USUAL: ["C1", "D11"],
  AGENT_REPEATS_SAME_ERROR: [],
  EDITS_FAIL_OR_UNDONE: ["C3", "C4"],
  SEARCHES_FOR_MISSING_CONTENT: ["C2"],
};

const COMPONENTS = ["input", "output", "cacheRead", "cw5m", "cw1h"] as const;
const TOKEN_COLS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_5m",
  "cache_write_1h",
] as const;

/** µ$ per token, `pricing_snapshots.unit_prices_json` = [in, out, cacheRead, cw5m, cw1h]. */
const PRICED_TOKENS = `(
  t.input_tokens * COALESCE(json_extract(p.unit_prices_json, '$[0]'), 0)
  + t.output_tokens * COALESCE(json_extract(p.unit_prices_json, '$[1]'), 0)
  + t.cache_read_tokens * COALESCE(json_extract(p.unit_prices_json, '$[2]'), 0)
  + t.cache_write_5m * COALESCE(json_extract(p.unit_prices_json, '$[3]'), 0)
  + t.cache_write_1h * COALESCE(json_extract(p.unit_prices_json, '$[4]'), 0))`;

/** Float summation order is the only difference to the ledger: 1e-6 µ$ + 1e-9 relative is ample. */
const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);
const near = (a: number, b: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b)));
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
const CHECK_IDS = ["I1b", "I2", "I3", "I4"] as const;
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

// ── Failure rules, restated from turn-claim.ts (rules only; chain-keyed below) ─

const C7_MIN_FAILURES = 3;
const C4_MIN_CONSECUTIVE_FAILURES = 5;
const C1_BASELINE_MULTIPLIER = 2;
/**
 * card review F4 (2026-10-04): a tool needs at least this many calls in the window to be a C1
 * outlier. The oracle's C1 corpus is the sidechain rows pooled across chains (rate = errors / calls
 * over all of them), so the count is per TOOL over the whole window's sidechain rows, not per chain.
 */
const C1_MIN_TOOL_CALLS = 20;
/** card review F4 (2026-10-04): hook-blocked calls and CDP timeouts are no tool failure. */
const HOOK_BLOCK_ERROR = /^PreToolUse:\S+ hook error\b/;
const CDP_TIMEOUT_ERROR = /\bCDP sendCommand "[^"\n]+" timed out after \d+ms/;

const CHECK_COMMAND =
  /\b(?:vitest|jest|mocha|pytest|tsc|biome|eslint|prettier|ruff|mypy)\b|\bnpm\s+(?:test|run\s+(?:-s\s+)?(?:test|lint|typecheck|build|check|verify)\b)|\b(?:cargo|go|dotnet)\s+(?:test|build|check|clippy|vet)\b/i;
const FAILED_STEP = /\bfailed\b|timed out|Couldn't|Can't|\bError\b|not in Claude's tab group/i;
const STEP_LINE = /^\[[^\]\n]+\] /m;
const FAILED_STEP_LINE = /^actions\[\d+\] \([^)\n]*\) failed:.*$/m;
const SEARCH_MISS = /does not appear anywhere|There is no .* visible|does not contain any\b/i;
const TOOL_FAILURE = /^\s*(?:Can't|Couldn't|Cannot|Failed|Error)\b/i;
const SHELL_FAILURE =
  /unexpected EOF while looking for matching|syntax error near unexpected token|syntax error: unexpected end of file|: command not found|bad substitution|is not recognized as the name of a cmdlet|^ParserError:|CategoryInfo\s*:\s*ParserError|Unexpected token .* in expression or statement|The string is missing the terminator|is not a valid statement separator|An empty pipe element is not allowed|Missing expression after/im;

function isBrowserAnswer(toolName: string, error: string): boolean {
  if (!toolName.startsWith("mcp__claude-in-chrome__")) return false;
  if (toolName.endsWith("__browser_batch")) {
    if (FAILED_STEP_LINE.test(error)) return false;
    return STEP_LINE.test(error) || !FAILED_STEP.test(error);
  }
  return toolName.endsWith("__find") && SEARCH_MISS.test(error) && !TOOL_FAILURE.test(error);
}
function isBenign(
  command: string | null,
  error: string | null,
  toolName: string,
  oldRules = false,
): boolean {
  if (error !== null && isBrowserAnswer(toolName, error)) return true;
  if (
    !oldRules &&
    error !== null &&
    (HOOK_BLOCK_ERROR.test(error) || CDP_TIMEOUT_ERROR.test(error))
  )
    return true;
  if (command === null || error === null) return false;
  if (/^Exit code [1-9]\d*\b/.test(error) && CHECK_COMMAND.test(command)) return true;
  if (/^Exit code 128\b/.test(error) && /\btaskkill\b/i.test(command)) return true;
  if (
    /^Exit code 1\b/.test(error) &&
    /\bgit\b[^;&|\n]*\bdiff\b[^;&|\n]*--(quiet|exit-code)\b/.test(command)
  )
    return true;
  return error.trim() === "Exit code 1" && /\bGet-NetTCPConnection\b/i.test(command);
}
/** C7 cluster signature: exit code + first output line, lowercased, digits masked. */
function c7Signature(error: string | null): string | null {
  if (error === null) return "?";
  const ran = /^Exit code (\d+)\r?\n?([\s\S]*)$/.exec(error);
  if (ran === null) return null;
  const first = (ran[2] ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return `${ran[1]}|${(first ?? "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 80)}`;
}
function d11IsError(exitClass: string | null, error: string | null): boolean | null {
  if (error !== null && !/^Exit code \d+/.test(error)) return null;
  return exitClass === "ERROR" && error !== null && SHELL_FAILURE.test(error);
}
const isErr = (c: string | null) => c === "ERROR" || c === "TEST_FAIL";
const normText = (t: string | null): string | null => {
  if (t === null) return null;
  const n = t.trim().replace(/\s+/g, " ").toLowerCase();
  return n === "" ? null : n;
};

// ── Dependencies (real: lazy src imports; self-check: fakes) ──────────────────

interface LoopEvent {
  event_id: string;
  ts: string;
  tool_name: string;
  input_hash: string | null;
  exit_class: string | null;
  file_path_hash: string | null;
  /** False = a run boundary that is not loop evidence (D7's matcher contract, card review F7). */
  eligible?: boolean;
}
/**
 * card review F7 (2026-10-04): successful browser MCP calls, poll tools and PreToolUse-guard-blocked
 * calls end a run of identical calls but are not loop evidence. A FAILING browser call stays eligible.
 */
const POLL_TOOLS = new Set(["Monitor", "TaskOutput", "BashOutput"]);
function loopEligible(r: {
  tool_name: string;
  exit_class: string | null;
  error_text: string | null;
}): boolean {
  if (POLL_TOOLS.has(r.tool_name)) return false;
  if (r.error_text !== null && HOOK_BLOCK_ERROR.test(r.error_text)) return false;
  if (r.tool_name.startsWith("mcp__claude-in-chrome__") && !isErr(r.exit_class)) return false;
  return true;
}
/** One failure event of a family on the turn that issued it (main chain baseline). */
export interface Issuing {
  family: Family;
  session: string;
  message: string;
}
export type IssuingFn = (db: Db, start: string, end: string) => Issuing[];
export interface Deps {
  d7Excess: (events: LoopEvent[]) => ReadonlySet<string>;
  worseShells: (db: Db, start: string, end: string) => Map<string, string>;
  mainIssuing: IssuingFn;
}

/** Main-chain issuing turns from the certified census (restated from the L8 oracle). */
async function censusIssuing(): Promise<IssuingFn> {
  const mod = await import("../../src/detector/turn-claim.js");
  return (db, start, end) => {
    const census = mod.wastedTurnCensus(
      db as never,
      { now: new Date(end), fromIso: start, toIso: end } as never,
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

async function realDeps(): Promise<Deps> {
  const d7 = await import("../../src/detector/d7-loop-analysis.js");
  const tc = await import("../../src/detector/turn-claim.js");
  return {
    d7Excess: (ev) =>
      d7.analyzeD7LoopEvents(ev as never, { includeFrictionSignals: true }).repeatExcessEventIds,
    worseShells: (db, start, end) =>
      tc.d11WorseShells(db as never, { now: new Date(end), fromIso: start, toIso: end } as never),
    mainIssuing: await censusIssuing(),
  };
}

// ── Expected claims ───────────────────────────────────────────────────────────

/** One priced recovery turn, per family. `comps` are the ledger cells it would fill. */
export interface Claim {
  day: string;
  family: Family;
  session: string;
  message: string;
  comps: Array<{ component: string; tokens: number; value: number }>;
}

interface TurnRow {
  message: string;
  session: string;
  ts: string;
  sc: number;
  explore: number;
  unit_prices_json: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

/** The ledger only accepts a 5-number, finite, non-negative price vector. */
function unitPrices(json: string | null): number[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (
      Array.isArray(v) &&
      v.length === COMPONENTS.length &&
      v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)
    )
      return v;
  } catch {
    /* unpriceable: value 0 */
  }
  return null;
}
function comps(r: TurnRow): Claim["comps"] {
  const p = unitPrices(r.unit_prices_json);
  const out: Claim["comps"] = [];
  COMPONENTS.forEach((component, i) => {
    const tokens = r[TOKEN_COLS[i] as (typeof TOKEN_COLS)[number]];
    if (tokens > 0) out.push({ component, tokens, value: tokens * (p?.[i] ?? 0) });
  });
  return out;
}

const TURN_SELECT = `SELECT r.message_id AS message, r.session_id AS session, r.ts AS ts,
    r.is_sidechain AS sc, r.input_tokens, r.output_tokens, r.cache_read_tokens,
    r.cache_write_5m, r.cache_write_1h, p.unit_prices_json,
    EXISTS (SELECT 1 FROM subagent_meta sm WHERE sm.session_id = r.session_id
              AND sm.agent_type IN ('Explore', 'Plan')) AS explore /* only models the OLD billed base (mutation) */
  FROM turns r LEFT JOIN pricing_snapshots p ON p.snapshot_id = r.pricing_snapshot_id`;

/** Per (session, R message): the highest-priority family owns the cell (shared turn:* slice). */
function resolveOwners(claims: Claim[], noDedup: boolean): Claim[] {
  if (noDedup) return claims;
  const owner = new Map<string, Claim>();
  for (const c of claims) {
    const k = `${c.session}\0${c.message}`;
    const cur = owner.get(k);
    if (cur === undefined || (RANK.get(c.family) ?? 99) < (RANK.get(cur.family) ?? 99))
      owner.set(k, c);
  }
  return [...owner.values()];
}

/** Main-chain expected claims (L8 rules), component-level. Baseline side of I1b/I2 only. */
function mainClaims(db: Db, e: number, deps: Deps): Claim[] {
  const tsQ = db.prepare("SELECT ts FROM turns WHERE session_id = ? AND message_id = ?");
  const rQ = db.prepare(
    `${TURN_SELECT} WHERE r.session_id = ? AND r.is_sidechain = 0 AND r.provisional = 0 AND r.ts > ?
      ORDER BY r.ts, r.message_id LIMIT 1`,
  );
  const out: Claim[] = [];
  for (const { start, end } of grid(e)) {
    const seen = new Set<string>();
    const blockClaims: Claim[] = [];
    for (const ev of deps.mainIssuing(db, start, end)) {
      const dk = `${ev.family}\0${ev.session}\0${ev.message}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      const t = tsQ.get(ev.session, ev.message) as { ts: string } | undefined;
      if (t === undefined) continue;
      const r = rQ.get(ev.session, t.ts) as TurnRow | undefined;
      if (r === undefined || r.ts < start || r.ts >= end) continue;
      blockClaims.push({
        day: r.ts.slice(0, 10),
        family: ev.family,
        session: ev.session,
        message: r.message,
        comps: comps(r),
      });
    }
    out.push(...resolveOwners(blockClaims, false));
  }
  return out;
}

/** Mutations of the oracle's own model, used only by --self-check to build a buggy "ledger". */
export type BugName =
  | "r_cross_agent"
  | "r_on_main"
  | "null_agent"
  | "c1_pooled"
  | "d7_skipped"
  | "no_dedup"
  | "c7_session_key"
  | "c4_session_key"
  | "old_billed_base_kept"
  | "window_ignored"
  | "issuing_priced"
  | "provisional_r"
  | "hook_cdp_priced" // card review F4: pre-F4 benign rules
  | "c1_no_min_calls" // card review F4: no 20-call floor
  | "f7_pre" // card review F7: successful polls/browser calls counted as loop evidence
  | "f7_overbroad"; // card review F7: failing browser calls wrongly exempt from loops
export type Bug = Partial<Record<BugName, true>>;

interface Row {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  block_index: number;
  tool_name: string;
  exit_class: string | null;
  tool_error_class: string | null;
  tool_error_classifier_version: string | null;
  bash_command_family: string | null;
  file_path_hash: string | null;
  input_hash: string | null;
  result_bytes: number | null;
  content_text: string | null;
  command_text: string | null;
  error_text: string | null;
  owner_message_id: string;
  agent_id: string | null;
}

function loadRows(db: Db, start: string, end: string, sc: 0 | 1, needAgent: boolean): Row[] {
  return db
    .prepare(
      `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, m.block_index,
              e.tool_name, e.exit_class, e.tool_error_class, e.tool_error_classifier_version,
              e.bash_command_family, m.file_path_hash, e.input_hash, e.result_bytes,
              COALESCE(json_extract(c.content_json, '$.command'),
                       json_extract(c.content_json, '$.error')) AS content_text,
              json_extract(c.content_json, '$.command') AS command_text,
              json_extract(c.content_json, '$.error') AS error_text,
              m.owner_message_id, t.agent_id
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
         JOIN sessions s ON s.session_id = e.session_id
        WHERE e.ts >= ? AND e.ts < ? AND s.state = 'RECONCILED'
          AND m.owner_message_id IS NOT NULL
          AND t.is_sidechain = ? AND t.provisional = 0
          ${needAgent ? "AND t.agent_id IS NOT NULL" : ""}
        ORDER BY s.workspace_id, e.session_id, e.ts, m.block_index, e.event_id`,
    )
    .all(start, end, sc) as Row[];
}

type Candidates = Map<string, string[]>;
const addCand = (c: Candidates, turn: string, eventId: string) => {
  const list = c.get(turn);
  if (list === undefined) c.set(turn, [eventId]);
  else list.push(eventId);
};
const rowOrder = (a: Row, b: Row) =>
  a.ts.localeCompare(b.ts) || a.block_index - b.block_index || a.event_id.localeCompare(b.event_id);

/**
 * Sidechain expected claims (spec rules 2-4), component-level, from raw rows.
 * Chain = (session_id, agent_id); every per-session key of the main rules is per-chain here.
 */
export function sidechainClaims(db: Db, e: number, deps: Deps, bug: Bug = {}): Claim[] {
  const tQ = db.prepare(`${TURN_SELECT} WHERE r.session_id = ? AND r.message_id = ?`);
  const tsAgent = db.prepare(
    "SELECT ts, agent_id FROM turns WHERE session_id = ? AND message_id = ?",
  );
  const recoverySql = `${TURN_SELECT}
    WHERE r.session_id = @s AND r.is_sidechain = ${bug.r_on_main ? 0 : 1}
      ${bug.r_on_main || bug.r_cross_agent ? "" : "AND r.agent_id IS @a"}
      ${bug.provisional_r ? "" : "AND r.provisional = 0"} AND r.ts > @ts
    ORDER BY r.ts, r.message_id LIMIT 1`;
  const rQ = db.prepare(recoverySql);
  const out: Claim[] = [];

  for (const { start, end } of grid(e)) {
    const rows = loadRows(db, start, end, 1, !bug.null_agent);
    const poolRows = bug.c1_pooled ? loadRows(db, start, end, 0, false) : [];
    const chainOf = (r: Row) => `${r.session_id}\0${r.agent_id ?? ""}`;
    const tkey = (r: Row) => `${r.session_id}|${r.owner_message_id}`;

    // D7 loop pre-exclusion, per chain.
    const excluded = new Set<string>();
    if (!bug.d7_skipped) {
      const byChain = new Map<string, Row[]>();
      for (const r of rows) {
        const g = byChain.get(chainOf(r));
        if (g === undefined) byChain.set(chainOf(r), [r]);
        else g.push(r);
      }
      for (const group of byChain.values()) {
        const excess = deps.d7Excess(
          group.map((r) => ({
            event_id: r.event_id,
            ts: r.ts,
            tool_name: r.tool_name,
            input_hash: normText(r.content_text) ?? r.input_hash,
            exit_class: r.exit_class,
            file_path_hash: r.file_path_hash,
            // re-review N2 (2026-10-05): the matcher splits reads whose result size changed.
            result_bytes: r.result_bytes,
            eligible: bug.f7_pre
              ? true
              : bug.f7_overbroad
                ? loopEligible(r) && !r.tool_name.startsWith("mcp__claude-in-chrome__")
                : loopEligible(r),
          })),
        );
        for (const r of group) if (excess.has(r.event_id)) excluded.add(tkey(r));
      }
    }
    const worse = deps.worseShells(db, start, end);

    const cand = new Map<ScFamily, Candidates>(SC_FAMILIES.map((f) => [f, new Map()]));
    const c = (f: ScFamily) => cand.get(f) as Candidates;
    // C7: Bash ERROR/TEST_FAIL, >= 3 per (workspace, chain, command family, signature).
    const c7 = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.tool_name !== "Bash" || !isErr(r.exit_class)) continue;
      const sig = c7Signature(r.error_text);
      if (sig === null) continue;
      const fam = r.bash_command_family ?? "BASH_OTHER";
      const k = `${r.workspace_id}\0${bug.c7_session_key ? r.session_id : chainOf(r)}\0${fam}\0${sig}`;
      const g = c7.get(k);
      if (g === undefined) c7.set(k, [r]);
      else g.push(r);
    }
    for (const g of c7.values())
      if (g.length >= C7_MIN_FAILURES) for (const r of g) addCand(c("C7"), tkey(r), r.event_id);
    // C3: Edit NOT_READ.
    for (const r of rows)
      if (
        r.tool_name === "Edit" &&
        r.tool_error_class === "NOT_READ" &&
        r.tool_error_classifier_version === "tool-error-1"
      )
        addCand(c("C3"), tkey(r), r.event_id);
    // C4: Edit STALE_STRING/PATCH_FAILED, consecutive run >= 5 per (workspace, chain, file).
    const byFile = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.tool_name !== "Edit" || r.file_path_hash === null) continue;
      const k = `${r.workspace_id}\0${bug.c4_session_key ? r.session_id : chainOf(r)}\0${r.file_path_hash}`;
      const g = byFile.get(k);
      if (g === undefined) byFile.set(k, [r]);
      else g.push(r);
    }
    const c4Fail = (r: Row) =>
      r.exit_class === "ERROR" &&
      r.tool_error_classifier_version === "tool-error-1" &&
      (r.tool_error_class === "STALE_STRING" || r.tool_error_class === "PATCH_FAILED");
    for (const g of byFile.values()) {
      let run: Row[] = [];
      const flush = () => {
        if (run.length >= C4_MIN_CONSECUTIVE_FAILURES)
          for (const r of run) addCand(c("C4"), tkey(r), r.event_id);
        run = [];
      };
      for (const r of [...g].sort(rowOrder)) {
        if (c4Fail(r)) run.push(r);
        else flush();
      }
      flush();
    }
    // C1: error calls of tools whose rate > 2x the corpus rate. Corpus = sidechain rows only.
    const c1Err = (r: Row) =>
      isErr(r.exit_class) &&
      !isBenign(r.command_text, r.error_text, r.tool_name, !!bug.hook_cdp_priced);
    const notWorse = (r: Row) => r.tool_name !== worse.get(r.workspace_id);
    const c1Rows = rows.filter(notWorse);
    const corpus = bug.c1_pooled ? [...c1Rows, ...poolRows.filter(notWorse)] : c1Rows;
    const corpusErrors = corpus.filter(c1Err).length;
    if (c1Rows.length > 0 && corpusErrors > 0) {
      const rate = corpusErrors / corpus.length;
      const byTool = new Map<string, { total: number; errors: Row[] }>();
      for (const r of c1Rows) {
        const a = byTool.get(r.tool_name) ?? { total: 0, errors: [] };
        a.total++;
        if (c1Err(r)) a.errors.push(r);
        byTool.set(r.tool_name, a);
      }
      for (const a of byTool.values())
        if (
          (bug.c1_no_min_calls || a.total >= C1_MIN_TOOL_CALLS) &&
          a.errors.length / a.total > C1_BASELINE_MULTIPLIER * rate
        )
          for (const r of a.errors) addCand(c("C1"), tkey(r), r.event_id);
    }
    // C2: Read/Grep/Glob NOT_FOUND.
    for (const r of rows)
      if (
        (r.tool_name === "Read" || r.tool_name === "Grep" || r.tool_name === "Glob") &&
        r.tool_error_class === "NOT_FOUND" &&
        r.tool_error_classifier_version === "tool-error-1"
      )
        addCand(c("C2"), tkey(r), r.event_id);
    // D11: shell ERROR calls of the workspace's worse shell.
    for (const r of rows)
      if (
        r.tool_name === worse.get(r.workspace_id) &&
        d11IsError(r.exit_class, r.error_text) === true
      )
        addCand(c("D11"), tkey(r), r.event_id);

    // Priority C7 > C3 > C4 > C1 > C2 > D11, after the loop pre-exclusion.
    const claimedTurns = new Set<string>(excluded);
    const blockClaims: Claim[] = [];
    for (const family of SC_FAMILIES) {
      const priced = new Set<string>();
      for (const [turn, events] of c(family)) {
        if (claimedTurns.has(turn)) continue;
        claimedTurns.add(turn);
        const bar = turn.indexOf("|");
        const session = turn.slice(0, bar);
        const message = turn.slice(bar + 1);
        const t = tsAgent.get(session, message) as
          | { ts: string; agent_id: string | null }
          | undefined;
        if (t === undefined) continue;
        const r = (
          bug.issuing_priced
            ? tQ.get(session, message)
            : rQ.get({
                s: session,
                ts: t.ts,
                ...(bug.r_on_main || bug.r_cross_agent ? {} : { a: t.agent_id }),
              })
        ) as TurnRow | undefined;
        if (r === undefined) continue; // the subagent ended on the failure: no claim
        const at = bug.issuing_priced ? t.ts : r.ts;
        if (!bug.window_ignored && (at < start || at >= end)) continue;
        // Billed base = every non-provisional turn (billed-base spec): no Explore/Plan exclusion.
        if (bug.old_billed_base_kept && r.sc === 1 && r.explore === 1) continue;
        const perEvent = bug.no_dedup ? events.length : 1;
        for (let i = 0; i < perEvent; i++) {
          const key = `${r.session}\0${r.message}`;
          if (!bug.no_dedup && priced.has(key)) continue;
          priced.add(key);
          blockClaims.push({
            day: at.slice(0, 10),
            family,
            session: r.session,
            message: r.message,
            comps: comps(r),
          });
        }
      }
    }
    out.push(...resolveOwners(blockClaims, !!bug.no_dedup));
  }
  return out;
}

/** day|family|component -> summed value_u and tokens. */
type Cell = { v: number; tokens: number };
function aggregate(claims: Claim[]): Map<string, Cell> {
  const m = new Map<string, Cell>();
  for (const c of claims)
    for (const p of c.comps) {
      const k = `${c.day}|${c.family}|${p.component}`;
      const cell = m.get(k) ?? { v: 0, tokens: 0 };
      cell.v += p.value;
      cell.tokens += p.tokens;
      m.set(k, cell);
    }
  return m;
}

/** Actual reliability cells of ledger_daily (all blocks of the grid). */
function ledgerCells(db: Db, e: number): Map<string, Cell> {
  const starts = JSON.stringify(grid(e).map((b) => b.start));
  const rows = db
    .prepare(
      `SELECT day, detector_id AS family, component, SUM(value_u) AS v, SUM(tokens) AS tokens
         FROM ledger_daily WHERE lane = 'reliability'
          AND block_start IN (SELECT value FROM json_each(?))
        GROUP BY day, detector_id, component`,
    )
    .all(starts) as Array<{
    day: string;
    family: string;
    component: string;
    v: number;
    tokens: number;
  }>;
  return new Map(
    rows.map((r) => [`${r.day}|${r.family}|${r.component}`, { v: r.v, tokens: r.tokens }]),
  );
}

/**
 * For the L8 oracle: sidechain expected reliability µ$ per `${day}|${family}` (the L8 oracle owns
 * main-chain claims only, and `ledger_daily` cannot tell the two apart).
 */
export async function sidechainValueMap(db: Db, asOf: string): Promise<Map<string, number>> {
  const e = Math.floor(new Date(asOf).getTime() / DAY_MS) * DAY_MS;
  const out = new Map<string, number>();
  for (const [k, cell] of aggregate(sidechainClaims(db, e, await realDeps()))) {
    const [day = "", family = ""] = k.split("|");
    out.set(`${day}|${family}`, (out.get(`${day}|${family}`) ?? 0) + cell.v);
  }
  return out;
}

// ── verify ────────────────────────────────────────────────────────────────────

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
  opts: { asOf: string; windows: Array<7 | 14 | 30> },
  deps: Deps,
  baseline?: Db,
) {
  const e = Math.floor(new Date(opts.asOf).getTime() / DAY_MS) * DAY_MS;
  const checks = newChecks();
  const info: Record<string, unknown> = {};

  const unmarked = markedBlocks(db, e);
  checks.I2.ok(unmarked.length === 0, "marks-incomplete", { missing: unmarked.length });
  const starts = JSON.stringify(grid(e).map((b) => b.start));

  const scClaims = sidechainClaims(db, e, deps);
  const S = aggregate(scClaims);
  const M = aggregate(mainClaims(db, e, deps));
  const L = ledgerCells(db, e);
  const B = baseline ? ledgerCells(baseline, e) : undefined;
  const zero: Cell = { v: 0, tokens: 0 };

  for (const k of L.keys())
    checks.I2.ok(RANK.has(k.split("|")[1] ?? ""), "foreign-detector-in-reliability-lane", {
      cell: k,
    });

  for (const k of new Set([...L.keys(), ...M.keys(), ...S.keys(), ...(B?.keys() ?? [])])) {
    const l = L.get(k) ?? zero;
    const m = M.get(k) ?? zero;
    const s = S.get(k) ?? zero;
    // I2: whatever the ledger holds beyond the main-chain claims is exactly the sidechain claims.
    checks.I2.ok(near(l.v - m.v, s.v) && l.tokens - m.tokens === s.tokens, "sidechain-mismatch", {
      cell: k,
      ledger_minus_main_u: l.v - m.v,
      expected_sidechain_u: s.v,
      ledger_minus_main_tokens: l.tokens - m.tokens,
      expected_sidechain_tokens: s.tokens,
    });
    // I1b: with the sidechain claims removed, the main-chain cells equal the baseline.
    const base = B ? (B.get(k) ?? zero) : m;
    checks.I1b.ok(
      near(l.v - s.v, base.v) && l.tokens - s.tokens === base.tokens,
      "main-chain-changed",
      { cell: k, candidate_minus_sidechain_u: l.v - s.v, baseline_u: base.v },
    );
  }

  // Info: what the oracle sees, per window, in dollars (µ$ / 1e6).
  const sum = (m: Map<string, Cell>, from: string, to: string, fam?: string) => {
    let v = 0;
    for (const [k, cell] of m) {
      const [day = "", f = ""] = k.split("|");
      if (day >= from && day < to && (fam === undefined || f === fam)) v += cell.v;
    }
    return v;
  };
  const minus = (a: Map<string, Cell>, b: Map<string, Cell>) => {
    const out = new Map<string, Cell>();
    for (const [k, cell] of a) {
      const o = b.get(k) ?? zero;
      out.set(k, { v: cell.v - o.v, tokens: cell.tokens - o.tokens });
    }
    return out;
  };
  const ledgerSide = minus(L, M);
  const usd = (u: number) => Math.round(u) / 1e6;
  info.sidechain_recovery_priced_turns = scClaims.length;
  info.sidechain_by_window_usd = Object.fromEntries(
    ([7, 14, 30] as const).map((w) => {
      const from = dayStr(e - w * DAY_MS);
      const to = dayStr(e);
      return [
        `${w}d`,
        { expected: usd(sum(S, from, to)), ledger_minus_main: usd(sum(ledgerSide, from, to)) },
      ];
    }),
  );
  info.sidechain_30d_per_family_usd = Object.fromEntries(
    SC_FAMILIES.map((f) => {
      const from = dayStr(e - 30 * DAY_MS);
      const to = dayStr(e);
      return [
        f,
        {
          expected: usd(sum(S, from, to, f)),
          ledger_minus_main: usd(sum(ledgerSide, from, to, f)),
        },
      ];
    }),
  );
  info.main_30d_expected_usd = usd(sum(M, dayStr(e - 30 * DAY_MS), dayStr(e)));

  // I3: reliability per day <= billed per day (sum of tokens x price over every turn of that day).
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
  for (const r of db
    .prepare(
      `SELECT day, SUM(value_u) AS v FROM ledger_daily WHERE lane = 'reliability'
          AND block_start IN (SELECT value FROM json_each(?)) GROUP BY day`,
    )
    .all(starts) as Array<{ day: string; v: number }>)
    perDay.set(r.day, r.v);
  for (const [day, v] of perDay) {
    const cap = billed.get(day) ?? 0;
    checks.I3.ok(v <= cap + tol(cap), "reliability<=billed", { day, ledger_u: v, billed_u: cap });
  }

  // I4: Diagnostics replan_u == sum of ledger reliability rows for the row's families in the window.
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

  const ids: CheckId[] = ["I1b", "I2", "I3", "I4"];
  const failed = ids.filter((id) => checks[id].fail > 0);
  info.i1b_reference = baseline ? "baseline ledger" : "main-chain expected (census)";
  return {
    ok: failed.length === 0,
    failed_checks: failed,
    as_of: iso(e),
    windows: opts.windows,
    checks: summarize(checks, ids),
    info,
  };
}

// ── Self-check ────────────────────────────────────────────────────────────────

const SELF_E = Date.UTC(2026, 8, 28);
const T = (s: string) => `2026-${s}:00.000Z`;

/** Prices [in, out, cacheRead, cw5m, cw1h] = [2, 10, 1, 3, 4] µ$/token. */
function selfDb(opts: { sidechain: boolean; bug?: Bug }): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pricing_snapshots (snapshot_id TEXT PRIMARY KEY, unit_prices_json TEXT NOT NULL);
    CREATE TABLE turns (message_id TEXT, session_id TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_5m INTEGER, cache_write_1h INTEGER, pricing_snapshot_id TEXT,
      is_sidechain INTEGER NOT NULL DEFAULT 0, provisional INTEGER NOT NULL DEFAULT 0, agent_id TEXT);
    CREATE TABLE sessions (session_id TEXT, workspace_id TEXT, state TEXT);
    CREATE TABLE subagent_meta (agent_id TEXT, session_id TEXT, agent_type TEXT);
    CREATE TABLE tool_events (event_id TEXT, session_id TEXT, ts TEXT, tool_name TEXT, exit_class TEXT,
      tool_error_class TEXT, tool_error_classifier_version TEXT, bash_command_family TEXT, input_hash TEXT,
      result_bytes INTEGER);
    CREATE TABLE tool_event_metadata (event_id TEXT, block_index INTEGER, file_path_hash TEXT, owner_message_id TEXT);
    CREATE TABLE tool_event_content (event_id TEXT, content_json TEXT);
    CREATE TABLE ledger_daily (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT, rec_id TEXT,
      component TEXT, value_u REAL, tokens INTEGER,
      pos0_u REAL DEFAULT 0, pos1_u REAL DEFAULT 0, pos2_u REAL DEFAULT 0, pos3_u REAL DEFAULT 0,
      pos4_u REAL DEFAULT 0, pos5_u REAL DEFAULT 0);
    CREATE TABLE ledger_daily_marks (block_start TEXT PRIMARY KEY, block_end TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO pricing_snapshots VALUES ('p1', '[2,10,1,3,4]')").run();
  for (const s of ["s1", "s2"])
    db.prepare("INSERT INTO sessions VALUES (?, 'w1', 'RECONCILED')").run(s);
  db.prepare("INSERT INTO subagent_meta VALUES ('X', 's2', 'Explore')").run();

  const insT = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,0,0,'p1',?,?,?)");
  const tsOf = new Map<string, { ts: string; session: string }>();
  // turn(message, session, ts, agent, sidechain, [in, out, cacheRead], provisional)
  const turn = (
    m: string,
    s: string,
    ts: string,
    agent: string | null,
    sc: 0 | 1,
    tok: [number, number, number] = [100, 10, 0],
    prov: 0 | 1 = 0,
  ) => {
    tsOf.set(m, { ts, session: s });
    insT.run(m, s, ts, tok[0], tok[1], tok[2], sc, prov, agent);
  };
  const insE = db.prepare("INSERT INTO tool_events VALUES (?,?,?,?,?,?,?,?,NULL,NULL)");
  const insM = db.prepare("INSERT INTO tool_event_metadata VALUES (?,?,?,?)");
  const insC = db.prepare("INSERT INTO tool_event_content VALUES (?,?)");
  let eid = 0;
  const ev = (
    owner: string,
    tool: string,
    exit: string,
    o: { cls?: string; fam?: string; file?: string; content?: Record<string, string> } = {},
  ) => {
    const id = `ev${++eid}`;
    const t = tsOf.get(owner) as { ts: string; session: string };
    insE.run(
      id,
      t.session,
      t.ts,
      tool,
      exit,
      o.cls ?? null,
      o.cls ? "tool-error-1" : null,
      o.fam ?? null,
    );
    insM.run(id, eid, o.file ?? null, owner);
    if (o.content) insC.run(id, JSON.stringify(o.content));
  };
  const bashErr = (owner: string, cmd: string) =>
    ev(owner, "Bash", "ERROR", {
      fam: "git",
      content: { command: cmd, error: "Exit code 1\nboom" },
    });
  const editNotRead = (owner: string, n: string) =>
    ev(owner, "Edit", "ERROR", {
      cls: "NOT_READ",
      content: { error: `File has not been read yet: ${n}` },
    });
  const editStale = (owner: string, file: string, n: string) =>
    ev(owner, "Edit", "ERROR", { cls: "STALE_STRING", file, content: { error: `stale ${n}` } });

  // Main chain (agent NULL): a filler of OK calls (dilutes a pooled C1 corpus), the L8-style
  // main claim mm1 -> mm2, and a main turn m3 that a wrong "R lands on main" would price.
  turn("mf", "s1", T("09-26T04:00"), null, 0);
  for (let i = 0; i < 600; i++) ev("mf", "Read", "OK");
  turn("mm1", "s1", T("09-26T08:00"), null, 0);
  turn("mm2", "s1", T("09-26T08:01"), null, 0, [100, 0, 0]); // 200
  turn("m3", "s1", T("09-27T10:02"), null, 0, [7000, 0, 0]); // 14000

  // Chain A: C7 (3 Bash errors + an Edit NOT_READ in one turn: C7 wins, one recovery turn).
  turn("a1", "s1", T("09-27T10:00"), "A", 1);
  bashErr("a1", "git a");
  bashErr("a1", "git b");
  bashErr("a1", "git c");
  editNotRead("a1", "f1");
  turn("b1", "s1", T("09-27T10:01"), "B", 1, [4000, 0, 0]); // 8000: another agent's turn
  turn("p1", "s1", T("09-27T10:03"), "A", 1, [9000, 0, 0], 1); // provisional
  turn("a2", "s1", T("09-27T10:04"), "A", 1, [1000, 100, 0]); // R(a1) = 2000 + 1000 = 3000
  // C3: a3 -> a4; a5's recovery a6 falls after the block end (dropped).
  turn("a3", "s1", T("09-27T11:00"), "A", 1);
  editNotRead("a3", "f2");
  turn("a4", "s1", T("09-27T11:05"), "A", 1, [500, 50, 2000]); // 1000 + 500 + 2000 = 3500
  turn("a5", "s1", T("09-27T23:59"), "A", 1);
  editNotRead("a5", "f3");
  turn("a6", "s1", T("09-28T00:05"), "A", 1, [800, 0, 0]); // 1600, outside block 0
  // Chain with agent_id NULL (pre-migration shape): never priced.
  turn("n1", "s1", T("09-27T12:00"), null, 1);
  editNotRead("n1", "f4");
  turn("n2", "s1", T("09-27T12:01"), null, 1, [300, 0, 0]); // 600
  // Chain D: three identical Grep NOT_FOUND = a D7 loop; d2/d3 are excluded, d1 is C2.
  turn("d1", "s1", T("09-26T09:00"), "D", 1);
  turn("d2", "s1", T("09-26T09:01"), "D", 1, [150, 15, 0]); // 300 + 150 = 450
  turn("d3", "s1", T("09-26T09:02"), "D", 1);
  turn("d4", "s1", T("09-26T09:03"), "D", 1, [100, 0, 0]); // 200
  for (const d of ["d1", "d2", "d3"])
    ev(d, "Grep", "ERROR", { cls: "NOT_FOUND", content: { error: "nothing here" } });
  // Chains F and G: two Bash errors each (below C7's 3 per chain, above it per session).
  for (const [agent, pre, hour] of [
    ["F", "f", "14"],
    ["G", "g", "15"],
  ] as const) {
    turn(`${pre}1`, "s1", T(`09-25T${hour}:00`), agent, 1);
    turn(`${pre}2`, "s1", T(`09-25T${hour}:01`), agent, 1);
    turn(`${pre}3`, "s1", T(`09-25T${hour}:02`), agent, 1);
    bashErr(`${pre}1`, `git ${pre}1`);
    bashErr(`${pre}2`, `git ${pre}2`);
  }
  // Chain E: D11 (PowerShell is the workspace's worse shell).
  turn("e1", "s1", T("09-22T09:00"), "E", 1);
  turn("e2", "s1", T("09-22T09:01"), "E", 1, [400, 0, 0]); // 800
  for (const c of ["ps a", "ps b"])
    ev("e1", "PowerShell", "ERROR", {
      content: { command: c, error: "Exit code 1\nParserError: bad" },
    });
  // Chain H: five consecutive stale-string Edit failures on one file = C4.
  turn("h1", "s1", T("09-24T09:00"), "H", 1);
  for (let i = 2; i <= 6; i++)
    turn(`h${i}`, "s1", T(`09-24T09:0${i - 1}`), "H", 1, [i === 6 ? 200 : 100, 0, 0]); // 200 x4, 400
  for (let i = 1; i <= 5; i++) editStale(`h${i}`, "fh1", `h${i}`);
  // Chains J and K interleave 3 + 2 failures on one file (5 in a session, 3 and 2 per chain).
  for (const [id, agent, hhmm] of [
    ["j1", "J", "10:00"],
    ["j2", "J", "10:01"],
    ["k1", "K", "10:02"],
    ["k2", "K", "10:03"],
    ["j3", "J", "10:04"],
    ["j4", "J", "10:05"],
    ["k3", "K", "10:06"],
  ] as const)
    turn(id, "s1", T(`09-25T${hhmm}`), agent, 1);
  for (const id of ["j1", "j2", "k1", "k2", "j3"]) editStale(id, "fh2", id);
  // Chain W: C1 (WebFetch fails at 50%, corpus ~12%): wf1 -> wf2, wf2 -> wf3.
  turn("wf1", "s1", T("09-23T13:00"), "W", 1);
  turn("wf2", "s1", T("09-23T13:01"), "W", 1, [200, 20, 0]); // 400 + 200 = 600
  turn("wf3", "s1", T("09-23T13:02"), "W", 1, [300, 0, 0]); // 600
  ev("wf1", "WebFetch", "ERROR", { content: { error: "boom fetch 1" } });
  ev("wf2", "WebFetch", "ERROR", { content: { error: "boom fetch 2" } });
  ev("wf3", "WebFetch", "OK");
  ev("wf3", "WebFetch", "OK");
  // card review F4 (2026-10-04): WebFetch reaches the 20-call floor (18 errors + 2 OK), all on wf1
  // beyond the first so the hand figures stay put; hook-blocked and CDP-timeout errors are benign.
  for (let i = 3; i <= 18; i++)
    ev("wf1", "WebFetch", "ERROR", { content: { error: `boom fetch ${i}` } });
  turn("wh1", "s1", T("09-23T13:10"), "W", 1);
  turn("wh2", "s1", T("09-23T13:11"), "W", 1, [900, 0, 0]); // 1800, priced only by a wrong benign rule
  ev("wh1", "WebFetch", "ERROR", {
    content: { error: "PreToolUse:Bash hook error: Blocked command shape" },
  });
  ev("wh1", "WebFetch", "ERROR", {
    content: { error: 'CDP sendCommand "Page.navigate" timed out after 30000ms' },
  });
  // card review F4: WebSearch has 100% errors but only 2 calls (< 20): not a C1 outlier.
  turn("v1", "s1", T("09-23T14:00"), "V", 1);
  turn("v2", "s1", T("09-23T14:01"), "V", 1, [700, 0, 0]); // 1400, priced only without the floor
  ev("v1", "WebSearch", "ERROR", { content: { error: "search boom 1" } });
  ev("v1", "WebSearch", "ERROR", { content: { error: "search boom 2" } });
  // card review F7 (2026-10-04): three identical Monitor polls (q1-q3) and three identical
  // guard-blocked calls (p1-p3) are not a loop, so the Edit NOT_READ in q3/p3 is priced (C3 +200 each).
  for (const [pre, hh] of [
    ["q", "15"],
    ["p", "16"],
  ] as const) {
    for (let i = 1; i <= 4; i++)
      turn(
        `${pre}${i}`,
        "s1",
        T(`09-23T${hh}:0${i}`),
        pre.toUpperCase(),
        1,
        i === 4 ? [100, 0, 0] : [100, 10, 0],
      );
    for (const i of [1, 2, 3])
      if (pre === "q") ev(`q${i}`, "Monitor", "OK", { content: { command: "mon" } });
      else
        ev(`p${i}`, "WebSearch", "ERROR", {
          content: { error: "PreToolUse:Guard hook error: blocked" },
        });
    editNotRead(`${pre}3`, `f${pre}`);
  }
  // card review F7: three identical FAILING browser calls ARE a loop, so r3's Edit NOT_READ is excluded.
  for (let i = 1; i <= 4; i++)
    turn(`r${i}`, "s1", T(`09-23T17:0${i}`), "R", 1, i === 4 ? [100, 0, 0] : [100, 10, 0]);
  for (const i of [1, 2, 3])
    ev(`r${i}`, "mcp__claude-in-chrome__navigate", "ERROR", { content: { error: "nav failed" } });
  editNotRead("r3", "fr");
  // Filler chain Z: OK calls that keep every non-WebFetch tool under 2x the sidechain corpus rate.
  turn("z1", "s1", T("09-26T05:00"), "Z", 1);
  for (let i = 0; i < 63; i++) ev("z1", "Bash", "OK");
  for (let i = 0; i < 56; i++) ev("z1", "Edit", "OK");
  for (let i = 0; i < 67; i++) ev("z1", "Grep", "OK");
  // Session s2 has an Explore subagent: its sidechain turns are still in the billed base.
  turn("x1", "s2", T("09-25T16:00"), "X", 1);
  editNotRead("x1", "f5");
  turn("x2", "s2", T("09-25T16:01"), "X", 1, [1000, 0, 0]); // 2000, billed (C3 total 3500 + 2000)

  // Ledger = main expected + (sidechain expected, possibly with a modelled bug).
  const deps = selfDeps();
  const claims = [
    ...mainClaims(db as unknown as Db, SELF_E, deps),
    ...(opts.sidechain ? sidechainClaims(db as unknown as Db, SELF_E, deps, opts.bug ?? {}) : []),
  ];
  const ins = db.prepare(
    "INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens) VALUES (?,?,'reliability',?, '', ?,?,?)",
  );
  const g = grid(SELF_E);
  const blockOf = (day: string) =>
    // A row for a day past the grid (a buggy out-of-window claim) is stored in block 0.
    g.find((b) => `${day}T00:00:00.000Z` >= b.start && `${day}T00:00:00.000Z` < b.end)?.start ??
    g[0]?.start ??
    "";
  const sums = new Map<
    string,
    { b: string; day: string; fam: string; comp: string; v: number; t: number }
  >();
  for (const c of claims)
    for (const p of c.comps) {
      const k = `${c.day}|${c.family}|${p.component}`;
      const s = sums.get(k) ?? {
        b: blockOf(c.day),
        day: c.day,
        fam: c.family,
        comp: p.component,
        v: 0,
        t: 0,
      };
      s.v += p.value;
      s.t += p.tokens;
      sums.set(k, s);
    }
  for (const s of sums.values()) ins.run(s.b, s.day, s.fam, s.comp, s.v, s.t);
  const mark = db.prepare("INSERT INTO ledger_daily_marks VALUES (?,?)");
  for (const b of g) mark.run(b.start, b.end);
  return db as unknown as Db;
}

const SELF_MAIN: Array<Issuing & { ts: string }> = [
  { family: "C2", session: "s1", message: "mm1", ts: T("09-26T08:00") },
];
function selfDeps(): Deps {
  return {
    // Stand-in for D7's matcher: 3+ events sharing one loop key = a loop; all but the first are excess.
    d7Excess: (events) => {
      const by = new Map<string, string[]>();
      for (const ev of events) {
        if (ev.input_hash === null || ev.eligible === false) continue;
        const list = by.get(ev.input_hash);
        if (list === undefined) by.set(ev.input_hash, [ev.event_id]);
        else list.push(ev.event_id);
      }
      const out = new Set<string>();
      for (const ids of by.values())
        if (ids.length >= 3) for (const id of ids.slice(1)) out.add(id);
      return out;
    },
    worseShells: () => new Map([["w1", "PowerShell"]]),
    mainIssuing: (_db, start, end) => SELF_MAIN.filter((x) => x.ts >= start && x.ts < end),
  };
}

/** Hand-derived sidechain figures (µ$) from the comments in selfDb. */
const HAND_S: Record<string, number> = {
  C7: 3000,
  C3: 5900,
  C4: 1200,
  C1: 1200,
  C2: 450,
  D11: 800,
};

/** Diagnostics dumps; replan_u derived by hand: C7 3000, C1+D11 2000, C3+C4 7100, C2 450 + main 200. */
function selfViews(): Views {
  const diag = (w: number) => ({
    window_days: w,
    reliability: {
      causes: [
        ["SHELL_FAILS_IN_BURSTS", 3000],
        ["SEARCHES_FOR_MISSING_CONTENT", 650],
        ["TOOLS_FAIL_MORE_THAN_USUAL", 2000],
        ["EDITS_FAIL_OR_UNDONE", 7100],
        ["BLOCKED_BY_PERMISSIONS", null],
        ["INTERRUPTED_OR_CANCELLED", null],
        ["AGENT_REPEATS_SAME_ERROR", null],
      ].map(([cause_id, replan_u]) => ({ cause_id, cost: { wait_ms: null, replan_u } })),
      risk: null,
    },
  });
  return { diagnostics: { 7: diag(7), 14: diag(14), 30: diag(30) } };
}

interface Side {
  db: Db;
  views: Views;
}
const dump = (db: Db, sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

const MUTATIONS: Array<{
  name: string;
  fails: CheckId;
  what: string;
  bug?: Bug;
  sidechain?: boolean;
  apply?: (s: Side) => void;
}> = [
  {
    name: "R crosses to another agent_id (b1)",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { r_cross_agent: true },
  },
  {
    name: "R lands on the main chain (m3)",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { r_on_main: true },
  },
  {
    name: "agent_id NULL rows included",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { null_agent: true },
  },
  {
    name: "C1 corpus pooled with the main chain",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { c1_pooled: true },
  },
  {
    name: "D7 exclusion skipped for sidechain rows",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { d7_skipped: true },
  },
  {
    name: "no dedup (a1's 3 failures price R three times)",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { no_dedup: true },
  },
  {
    name: "C7 clusters per session, not per chain",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { c7_session_key: true },
  },
  {
    name: "C4 runs per session, not per chain",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { c4_session_key: true },
  },
  {
    name: "old session-scoped billed-base cap kept (Explore session)",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { old_billed_base_kept: true },
  },
  {
    name: "recovery turn outside the block kept",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { window_ignored: true },
  },
  {
    name: "issuing turn priced instead of R",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { issuing_priced: true },
  },
  {
    name: "provisional turn allowed as R",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { provisional_r: true },
  },
  {
    name: "card review F4: hook-blocked / CDP-timeout errors priced as C1 failures",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { hook_cdp_priced: true },
  },
  {
    name: "card review F4: C1 without the 20-call floor (WebSearch, 2 calls)",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { c1_no_min_calls: true },
  },
  {
    name: "card review F7: successful polls / guard-blocked calls counted as a loop",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { f7_pre: true },
  },
  {
    name: "card review F7: failing browser calls wrongly exempt from loops",
    fails: "I2",
    what: "sidechain-mismatch",
    bug: { f7_overbroad: true },
  },
  {
    name: "feature absent: no sidechain claims (pre-feature state)",
    fails: "I2",
    what: "sidechain-mismatch",
    sidechain: false,
  },
  {
    name: "sidechain claim in a main-only family (C9, 500 µ$)",
    fails: "I2",
    what: "sidechain-mismatch",
    apply: (s) =>
      void dump(
        s.db,
        "INSERT INTO ledger_daily (block_start, day, lane, detector_id, rec_id, component, value_u, tokens) VALUES (?, '2026-09-27', 'reliability', 'C9', '', 'input', 500, 250)",
        grid(SELF_E)[0]?.start,
      ),
  },
  {
    name: "detector that is not a family in the reliability lane",
    fails: "I2",
    what: "foreign-detector-in-reliability-lane",
    apply: (s) =>
      void dump(s.db, "UPDATE ledger_daily SET detector_id = 'D2' WHERE detector_id = 'D11'"),
  },
  {
    name: "main-chain claim changed by 1 µ$ (I1b)",
    fails: "I1b",
    what: "main-chain-changed",
    apply: (s) =>
      void dump(
        s.db,
        "UPDATE ledger_daily SET value_u = value_u + 1 WHERE day = '2026-09-26' AND detector_id = 'C2' AND component = 'input'",
      ),
  },
  {
    name: "main-chain claim dropped (I1b)",
    fails: "I1b",
    what: "main-chain-changed",
    apply: (s) =>
      void dump(
        s.db,
        "DELETE FROM ledger_daily WHERE day = '2026-09-26' AND detector_id = 'C2' AND component = 'input'",
      ),
  },
  {
    name: "I3 reliability on a day above everything billed that day",
    fails: "I3",
    what: "reliability<=billed",
    apply: (s) =>
      void dump(s.db, "UPDATE ledger_daily SET value_u = 5000000 WHERE detector_id = 'D11'"),
  },
  {
    name: "I4 replan_u off by one",
    fails: "I4",
    what: "replan_u!=sum(ledger)",
    apply: (s) => {
      s.views.diagnostics[7].reliability.causes[0].cost.replan_u = 3001;
    },
  },
  {
    name: "I4 replan_u null although the family has rows",
    fails: "I4",
    what: "replan_u!=sum(ledger)",
    apply: (s) => {
      s.views.diagnostics[30].reliability.causes[2].cost.replan_u = null;
    },
  },
  {
    name: "I4 loop cause (no family) shows a figure",
    fails: "I4",
    what: "replan_u-not-null-without-rows",
    apply: (s) => {
      s.views.diagnostics[14].reliability.causes[6].cost.replan_u = 3000;
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
  const deps = selfDeps();

  const cleanDb = selfDb({ sidechain: true });
  const clean = verify(cleanDb, selfViews(), opts, deps, selfDb({ sidechain: false }));
  report("clean case passes I1b/I2/I3/I4", clean.ok, JSON.stringify(clean.failed_checks));
  report(
    "clean case exercised every check",
    Object.values(clean.checks).every((c) => c.pass > 0),
    Object.values(clean.checks)
      .map((c) => c.pass)
      .join(","),
  );
  const got: Record<string, number> = {};
  for (const c of sidechainClaims(cleanDb, SELF_E, deps))
    for (const p of c.comps) got[c.family] = (got[c.family] ?? 0) + p.value;
  report(
    "hand-derived sidechain figures (C7 3000, C3 5900, C4 1200, C1 1200, C2 450, D11 800)",
    SC_FAMILIES.every((f) => near(got[f] ?? 0, HAND_S[f] ?? -1)) && Object.keys(got).length === 6,
    JSON.stringify(got),
  );
  const noBase = verify(cleanDb, selfViews(), opts, deps);
  report("clean case passes without a baseline (I1b vs census)", noBase.ok);

  for (const m of MUTATIONS) {
    const cand: Side = {
      db: selfDb({ sidechain: m.sidechain ?? true, ...(m.bug ? { bug: m.bug } : {}) }),
      views: selfViews(),
    };
    m.apply?.(cand);
    const r = verify(cand.db, cand.views, opts, deps, selfDb({ sidechain: false }));
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
    `${msg}\nUsage: sidechain-reliability-check.ts --db <sqlite> --views <dir> --as-of <iso> [--window 7|14|30] [--baseline-db <sqlite>]\n         (aliases: --candidate-db = --db, --candidate = --views, --baseline <views dir> ignored)\n         | --self-check`,
  );
  process.exit(2);
}

function readViews(dir: string, windows: Array<7 | 14 | 30>): Views {
  const read = (name: string): Json => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) usage(`missing views file: ${p}`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  return {
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
    if (!valued.has(a)) usage(`Unknown flag ${a}`);
    const val = argv[++i];
    if (val === undefined || val.startsWith("--")) usage(`Missing value for ${a}`);
    flags.set(a, val);
  }
  const win = flags.get("--window");
  if (win !== undefined && win !== "7" && win !== "14" && win !== "30")
    usage("--window must be 7, 14 or 30");
  const windows = (win === undefined ? [7, 14, 30] : [Number(win)]) as Array<7 | 14 | 30>;
  const dbPath = flags.get("--db") ?? flags.get("--candidate-db");
  const viewsDir = flags.get("--views") ?? flags.get("--candidate");
  const asOf = flags.get("--as-of");
  if (!dbPath) usage("--db (or --candidate-db) is required");
  if (!asOf || !Number.isFinite(new Date(asOf).getTime())) usage("--as-of must be an ISO date");
  if (!viewsDir) usage("--views (or --candidate) is required");

  const db = openDb(dbPath);
  const baselinePath = flags.get("--baseline-db");
  const baseline = baselinePath ? openDb(baselinePath) : undefined;
  try {
    const report = verify(
      db,
      readViews(viewsDir, windows),
      { asOf, windows },
      await realDeps(),
      baseline,
    );
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    db.close();
    baseline?.close();
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
