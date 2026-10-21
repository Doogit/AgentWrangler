/**
 * Read-only, independent oracle for the diagnostics triage view (P4 U6).
 *
 * Recomputes, for a 7/14/30-day window on any DB, the figures the triage view shows, straight from
 * the raw tables with its own SQL, grouped by approved root cause. It imports nothing from src/:
 * every detector predicate below is restated here from its published definition, so a drift in the
 * engine shows up as a diff instead of being copied. Prints cause ids and counts only (SEC-101);
 * never session ids or content. The window is [as_of - N days, as_of): the end is exclusive (KTD-3).
 *
 *   node --import tsx/esm scripts/parity/diagnostics-triage-oracle.ts --db <path>
 *     [--window 7|14|30] [--as-of <iso>] [--compare <view.json>] [--self-check]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

type Db = Database.Database;
type Win = { from: string; to: string };

/**
 * Approved root-cause mapping (operator-approved), restated. Each cause lists its pattern codes: a
 * detector id, or the rule/template id where the key has one. D5 is excluded on purpose and never
 * becomes a cause. The D7 loop pool is one pattern: the pool does not tag excess events as C5 or
 * D7_RETRY_LOOP, so it is not split.
 */
type CauseDef = { cause_id: string; codes: string[] };
const LOOP = "D7_RETRY_LOOP+C5";
const AVOIDABLE: CauseDef[] = [
  { cause_id: "CONTEXT_TOO_LARGE", codes: ["D2_LONG_FULL_CONTEXT"] },
  { cause_id: "CACHE_REBUILT_MID_SESSION", codes: ["B1", "B2", "B3", "B4", "D8"] },
  { cause_id: "TOOL_RESULTS_TOO_LARGE", codes: ["A1", "A2", "D6", "C11"] },
  { cause_id: "ALWAYS_LOADED_TOO_BIG", codes: ["D1", "D10"] },
  { cause_id: "MODEL_BIGGER_THAN_NEEDED", codes: ["D4", "E2"] },
  // RC-FU1: E1/E2 joined the registry (diagnostics-causes.ts) after this map was written.
  { cause_id: "LONG_ORIENTATION_BEFORE_EDIT", codes: ["E1"] },
  { cause_id: "SUBAGENTS_COST_MORE_THAN_RETURN", codes: ["D12", "D9"] },
  { cause_id: "SAME_FILES_REREAD_ACROSS_SESSIONS", codes: ["D7_CROSS_SESSION_REREAD"] },
];
const RELIABILITY: CauseDef[] = [
  { cause_id: "BLOCKED_BY_PERMISSIONS", codes: ["C9"] }, // events
  { cause_id: "INTERRUPTED_OR_CANCELLED", codes: ["D2"] }, // D14, rule_id "D2"; failing turns
  { cause_id: "SHELL_FAILS_IN_BURSTS", codes: ["C7"] }, // failing turns
  { cause_id: "TOOLS_FAIL_MORE_THAN_USUAL", codes: ["C1", "D11", "G11"] }, // turns; G11 anchors
  { cause_id: "AGENT_REPEATS_SAME_ERROR", codes: [LOOP] }, // repeated calls
  { cause_id: "EDITS_FAIL_OR_UNDONE", codes: ["C3", "C4", "C6"] }, // turns; C6 anchors
  { cause_id: "SEARCHES_FOR_MISSING_CONTENT", codes: ["C2"] }, // failing turns
];
const RISK: CauseDef = { cause_id: "DESTRUCTIVE_COMMANDS_RAN", codes: ["H1"] }; // events

/** Finding keys: a RULE finding maps to `code` on detector_id, and on rule|template id if `key`. */
const FINDING_KEYS: Array<{ code: string; detector_id: string; key?: string }> = [
  { code: "D2_LONG_FULL_CONTEXT", detector_id: "D2", key: "D2_LONG_FULL_CONTEXT" },
  { code: "D7_CROSS_SESSION_REREAD", detector_id: "D7", key: "D7_CROSS_SESSION_REREAD" },
  ...["B1", "B2", "B3", "B4", "D8", "A1", "A2", "D6", "C11", "D1", "D10", "D4", "D12", "D9"].map(
    (d) => ({ code: d, detector_id: d }),
  ),
  { code: "G11", detector_id: "G11" },
  { code: "C6", detector_id: "C6" },
  { code: "E1", detector_id: "E1", key: "E1_ORIENTATION_BEFORE_FIRST_EDIT" },
  { code: "E2", detector_id: "E2", key: "E2_MAIN_THREAD_MECHANICAL_RUNS" },
];
const AVOIDABLE_CODES = new Set(AVOIDABLE.flatMap((c) => c.codes));
/** Findings of these detectors are not counted: D5 is excluded, the rest come from raw tables. */
const NOT_FROM_FINDINGS = new Set([
  "D5",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C7",
  "C9",
  "D11",
  "D14",
  "H1",
]);
const NOT_FROM_FINDINGS_KEYS = new Set(["D7_RETRY_LOOP"]);

const DAY_MS = 86_400_000;
const TREND_FLOOR = 5;
const WAIT_CAP_MS = 30 * 60_000;
const V2_ANCHOR_CAP = 5;
const V1_SESSION_CAP = 20;

/** Opaque finding session id, as V2 anchors publish it: sha256("session_id\0" + raw). */
const sid = (raw: string) =>
  `sid_${createHash("sha256").update("session_id").update("\0").update(raw).digest("hex")}`;

// ── Restated failure predicates ────────────────────────────────────────────────

/** Errors raised by the shell itself (it could not parse the command, or did not know it). */
const SHELL_FAILED = new RegExp(
  [
    "unexpected EOF while looking for matching",
    "syntax error near unexpected token",
    "syntax error: unexpected end of file",
    ": command not found",
    "bad substitution",
    "is not recognized as the name of a cmdlet",
    "^ParserError:",
    "CategoryInfo\\s*:\\s*ParserError",
    "Unexpected token .* in expression or statement",
    "The string is missing the terminator",
    "is not a valid statement separator",
    "An empty pipe element is not allowed",
    "Missing expression after",
  ].join("|"),
  "im",
);
/** Test, lint, typecheck and build runs: a non-zero exit reports the code, not the tool call. */
const CHECK_RUN =
  /\b(?:vitest|jest|mocha|pytest|tsc|biome|eslint|prettier|ruff|mypy)\b|\bnpm\s+(?:test|run\s+(?:-s\s+)?(?:test|lint|typecheck|build|check|verify)\b)|\b(?:cargo|go|dotnet)\s+(?:test|build|check|clippy|vet)\b/i;
const BROWSER = "mcp__claude-in-chrome__";
/** A PreToolUse guard hook blocked the call (card review F4/F7/F6, 2026-10-04). */
const GUARD_BLOCK = /^PreToolUse:\S+ hook error\b/;
const CDP_STALL = /\bCDP sendCommand "[^"\n]+" timed out after \d+ms/;
/** C1: a tool needs at least this many main-chain calls in the window to be an outlier (F4). */
const C1_MIN_TOOL_CALLS = 20;
/** C1: a tool needs at least this many counted errors to be an outlier (turn-claim C1_MIN_TOOL_ERRORS). */
const C1_MIN_TOOL_ERRORS = 3;
/** D7: polling tools end a run of identical calls without counting toward it (F7). */
const POLL_TOOLS = new Set(["Monitor", "TaskOutput", "BashOutput"]);

/** D11 outcome of one shell call: null = never ran; ERROR only for a shell-raised failure. */
function shellOutcome(exit: string | null, err: string | null): string | null {
  if (err !== null && !/^Exit code \d+/.test(err)) return null;
  return exit === "ERROR" && err !== null && SHELL_FAILED.test(err) ? "ERROR" : "OK";
}

/** A failed call that is really an answer ("nothing there"), which C1 counts as a success. */
function benign(cmd: string | null, err: string | null, tool: string | null): boolean {
  // card review F4 (2026-10-04): a guard-hook block (C9 reports it) and a Chrome CDP stall are
  // not the tool failing.
  if (err !== null && (GUARD_BLOCK.test(err) || CDP_STALL.test(err))) return true;
  if (err !== null) {
    // RC-FU1: turn-claim CDP_TIMEOUT also covers the tool-level "tool did not respond in time" text.
    if (/^The "[^"\n]+" tool did not respond in time\b/.test(err)) return true;
    // RC-FU1: turn-claim USER_REJECT, a declined call is C9's, no tool failure.
    if (/^The user doesn't want to (?:proceed with this tool use|take this action)/.test(err))
      return true;
    // RC-FU1: turn-claim NOT_READ_ERROR, an Edit/Write on an unread file is C3's.
    if (
      (tool === "Edit" || tool === "Write") &&
      /^(?:<tool_use_error>)?(?:File |The file ).*\bhas not been read\b/i.test(err)
    )
      return true;
    // RC-FU1: turn-claim ARTIFACT_GUARD, the Artifact overwrite guard working as designed.
    if (
      tool === "Artifact" &&
      /^(?:Nothing was published or removed:|conflict: nothing was published)/.test(err)
    )
      return true;
  }
  if (err !== null && tool?.startsWith(BROWSER)) {
    if (tool.endsWith("__browser_batch")) {
      if (/^actions\[\d+\] \([^)\n]*\) failed:.*$/m.test(err)) return false;
      if (/^\[[^\]\n]+\] /m.test(err)) return true;
      if (!/\bfailed\b|timed out|Couldn't|Can't|\bError\b|not in Claude's tab group/i.test(err))
        return true;
    } else if (
      tool.endsWith("__find") &&
      /does not appear anywhere|There is no .* visible|does not contain any\b/i.test(err) &&
      !/^\s*(?:Can't|Couldn't|Cannot|Failed|Error)\b/i.test(err)
    )
      return true;
  }
  if (cmd === null || err === null) return false;
  if (/^Exit code [1-9]\d*\b/.test(err) && CHECK_RUN.test(cmd)) return true;
  if (/^Exit code 128\b/.test(err) && /\btaskkill\b/i.test(cmd)) return true;
  if (
    /^Exit code 1\b/.test(err) &&
    /\bgit\b[^;&|\n]*\bdiff\b[^;&|\n]*--(quiet|exit-code)\b/.test(cmd)
  )
    return true;
  return err.trim() === "Exit code 1" && /\bGet-NetTCPConnection\b/i.test(cmd);
}

/** H1 (card review F6, 2026-10-04): the call was denied or blocked, so it never ran. */
function neverRan(interruptKind: string | null, err: string | null): boolean {
  return (
    interruptKind === "HUMAN_DENY" ||
    (err !== null &&
      (err.startsWith("The user doesn't want to proceed with this tool use") ||
        GUARD_BLOCK.test(err) ||
        /^Permission to use .* has been denied/.test(err)))
  );
}

/** C7 cluster signature: exit code + first non-blank output line, masked. Null = never ran. */
function c7Signature(err: string | null): string | null {
  if (err === null) return "?";
  const m = /^Exit code (\d+)\r?\n?([\s\S]*)$/.exec(err);
  if (!m) return null;
  const line = (m[2] ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const said = (line ?? "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 80);
  return `${m[1]}|${said}`;
}

const registered = new WeakSet<Db>();
function registerFunctions(db: Db): void {
  if (registered.has(db)) return;
  registered.add(db);
  const opts = { deterministic: true };
  db.function("aw_c7sig", opts, (e: unknown) => c7Signature(e as string | null));
  db.function("aw_shell", opts, (x: unknown, e: unknown) =>
    shellOutcome(x as string | null, e as string | null),
  );
  db.function("aw_never_ran", opts, (k: unknown, e: unknown) =>
    neverRan(k as string | null, e as string | null) ? 1 : 0,
  );
  db.function("aw_not_found", opts, (e: unknown) =>
    /^(?:<tool_use_error>)?(?:File|Path|Directory|Pattern|No files?).*(?:not found|does not exist)\b/i.test(
      String(e),
    )
      ? 1
      : 0,
  );
  db.function("aw_guard", opts, (e: unknown) => (GUARD_BLOCK.test(String(e)) ? 1 : 0));
  db.function("aw_benign", opts, (c: unknown, e: unknown, t: unknown) =>
    benign(c as string | null, e as string | null, t as string | null) ? 1 : 0,
  );
}

/** Main-chain, reconciled, owned tool events in the window: the partition's input rows. */
const BASE = `base AS (
  SELECT e.event_id, e.session_id, s.workspace_id, e.ts, m.block_index, e.tool_name, e.exit_class,
         e.tool_error_class AS err_class, e.tool_error_classifier_version AS err_ver,
         e.bash_command_family AS fam, m.file_path_hash AS fp, e.input_hash, e.result_bytes AS rb,
         json_extract(c.content_json, '$.command') AS cmd,
         json_extract(c.content_json, '$.error') AS err,
         e.session_id || '|' || m.owner_message_id AS tk
    FROM tool_events e
    JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
    JOIN tool_event_metadata m ON m.event_id = e.event_id AND m.owner_message_id IS NOT NULL
    JOIN turns t ON t.session_id = e.session_id AND t.message_id = m.owner_message_id
                AND t.is_sidechain = 0 AND t.provisional = 0
    LEFT JOIN tool_event_content c ON c.event_id = e.event_id
   WHERE e.ts >= @from AND e.ts < @to)`;

const col = (db: Db, sql: string, w: Win, extra: Record<string, unknown> = {}) =>
  new Set(
    (db.prepare(sql).all({ ...w, ...extra }) as Array<{ tk: string | null }>)
      .map((r) => r.tk)
      .filter((k): k is string => k !== null),
  );

// ── D7 loop pool (restated structural matcher; friction signals on) ─────────────

type LoopRow = {
  event_id: string;
  session_id: string;
  ts: string;
  tool_name: string;
  key: string | null;
  exit_class: string | null;
  fp: string | null;
  tk: string;
  err?: string | null;
  err_class?: string | null;
  err_ver?: string | null;
  /** Result size; null/absent = unknown. */
  rb?: number | null;
};

/**
 * re-review N2 (2026-10-05): a Read that returns a different size got new content, so it is not
 * the same call as one that returned another size. Other tools match on input alone.
 */
function callKey(r: LoopRow): string | null {
  if (r.key === null) return null;
  return r.tool_name.toLowerCase() === "read" && r.rb != null ? `${r.key}#${r.rb}` : r.key;
}

/**
 * card review F7 (2026-10-04): a sequence boundary ends a run of identical calls but is not
 * loop evidence: a successful browser call, a poll tool, or a call a PreToolUse guard blocked.
 * A failing browser call repeated still counts.
 */
function isBoundary(r: LoopRow): boolean {
  if (POLL_TOOLS.has(r.tool_name)) return true;
  if (r.err != null && GUARD_BLOCK.test(r.err)) return true;
  // RC-FU1: a C3 Edit is C3's, never loop evidence (d7-loop-analysis isClaimedByC3; Edit only).
  if (r.tool_name === "Edit" && r.err_class === "NOT_READ" && r.err_ver === "tool-error-1")
    return true;
  return (
    r.tool_name.startsWith(BROWSER) && r.exit_class !== "ERROR" && r.exit_class !== "TEST_FAIL"
  );
}

/** Split `rows` into maximal runs; `join` says whether `cur` continues the run ending in `prev`. */
function runsOf(
  rows: LoopRow[],
  member: (r: LoopRow) => boolean,
  join: (prev: LoopRow, cur: LoopRow) => boolean,
): LoopRow[][] {
  const out: LoopRow[][] = [];
  let run: LoopRow[] = [];
  for (const r of rows) {
    const last = run[run.length - 1];
    if (isBoundary(r) || !member(r)) {
      out.push(run);
      run = [];
    } else if (last && join(last, r)) run.push(r);
    else {
      out.push(run);
      run = [r];
    }
  }
  out.push(run);
  return out.filter((r) => r.length >= 3);
}

/** Excess members (all but the first) of each loop in one session. */
function loopPool(sessionRows: LoopRow[]): LoopRow[] {
  const excess = new Map<string, LoopRow>();
  const addRun = (run: LoopRow[]) => {
    for (const r of run.slice(1)) excess.set(r.event_id, r);
  };
  // Identical calls: same tool, same normalized input.
  for (const run of runsOf(
    sessionRows,
    (r) => r.key !== null,
    (a, b) => a.tool_name === b.tool_name && callKey(a) === callKey(b),
  ))
    addRun(run);
  // Consecutive TEST_FAIL events.
  for (const run of runsOf(
    sessionRows,
    (r) => r.exit_class === "TEST_FAIL",
    () => true,
  ))
    addRun(run);
  // Same-tool ERROR runs, members at most 120 s apart.
  for (const run of runsOf(
    sessionRows,
    (r) => r.exit_class === "ERROR",
    (a, b) => {
      const gap = (Date.parse(b.ts) - Date.parse(a.ts)) / 1000;
      // RC-FU1: a changed call/error text ends the run (d7-loop-analysis markErrorRuns input_hash).
      return a.tool_name === b.tool_name && a.key === b.key && !Number.isNaN(gap) && gap <= 120;
    },
  ))
    addRun(run);
  // Redundant reads: >=3 identical reads of one path with no Edit/Write of it in between.
  const open = new Map<string, Map<string, LoopRow[]>>();
  const close = (fp: string) => {
    for (const reads of open.get(fp)?.values() ?? []) if (reads.length >= 3) addRun(reads);
    open.delete(fp);
  };
  for (const r of sessionRows) {
    const tool = r.tool_name.toLowerCase();
    // card review F7 (2026-10-04): a boundary also ends every open read sequence.
    if (isBoundary(r)) for (const fp of [...open.keys()]) close(fp);
    else if (tool === "edit" || tool === "write") {
      if (r.fp !== null) close(r.fp);
    } else if (tool === "read" && r.fp !== null && r.key !== null) {
      const byKey = open.get(r.fp) ?? new Map<string, LoopRow[]>();
      let reads = byKey.get(r.key) ?? [];
      // re-review N2: a read that returns another size than the previous one starts a new group.
      const prev = reads[reads.length - 1]?.rb;
      if (prev != null && r.rb != null && prev !== r.rb) {
        if (reads.length >= 3) addRun(reads);
        reads = [];
      }
      byKey.set(r.key, [...reads, r]);
      open.set(r.fp, byKey);
    }
  }
  for (const fp of [...open.keys()]) close(fp);
  // Three-call cycles repeated at least three times back to back.
  const k = (i: number) => {
    const r = sessionRows[i];
    const key = r === undefined ? null : callKey(r);
    return r === undefined || key === null || isBoundary(r) ? null : `${r.tool_name}\0${key}`;
  };
  for (let s = 0; s + 9 <= sessionRows.length; ) {
    const [a, b, c] = [k(s), k(s + 1), k(s + 2)];
    if (a === null || b === null || c === null || (a === b && b === c)) {
      s++;
      continue;
    }
    let e = s + 3;
    while (e + 3 <= sessionRows.length && k(e) === a && k(e + 1) === b && k(e + 2) === c) e += 3;
    if (e - s < 9) {
      s++;
      continue;
    }
    // The first cycle is the original; every later cycle is excess.
    for (const r of sessionRows.slice(s + 3, e)) excess.set(r.event_id, r);
    s = e;
  }
  return [...excess.values()];
}

// ── Per-window figures, per pattern code ──────────────────────────────────────

/** One pattern's figures. Sessions are held in the opaque sid form so every source can union. */
type Tally = { occurrences: number; sessions: Set<string>; lowerBound: boolean };
type Core = {
  spend: number;
  sessionCount: number;
  patterns: Map<string, Tally>;
  c9Breakdown: Map<string, number>;
  c9Waits: Array<{ event_ts: string; wait_ms: number }>;
  h1Breakdown: Map<string, number>;
  notes: string[];
};

const newTally = (): Tally => ({ occurrences: 0, sessions: new Set(), lowerBound: false });

function hasTable(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  );
}

function computeCore(db: Db, w: Win): Core {
  const notes: string[] = [];
  const patterns = new Map<string, Tally>();
  const tally = (code: string) => {
    const t = patterns.get(code) ?? newTally();
    patterns.set(code, t);
    return t;
  };
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(cost_equiv_u), 0) AS spend, COUNT(DISTINCT session_id) AS n
         FROM turns WHERE ts >= @from AND ts < @to`,
    )
    .get(w) as { spend: number; n: number };

  // D7 loop pool over the partition's base rows, in session order.
  const baseRows = db
    .prepare(
      `WITH ${BASE}
       SELECT event_id, session_id, ts, tool_name, exit_class, fp, tk, err, rb, err_class, err_ver,
              COALESCE(cmd, err) AS text, input_hash
         FROM base ORDER BY session_id, ts, block_index, event_id`,
    )
    .all(w) as Array<Omit<LoopRow, "key"> & { text: string | null; input_hash: string | null }>;
  const bySession = new Map<string, LoopRow[]>();
  for (const r of baseRows) {
    const norm = r.text?.trim().replace(/\s+/g, " ").toLowerCase() || null;
    const row: LoopRow = { ...r, key: norm ?? r.input_hash };
    bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), row]);
  }
  const loop = tally(LOOP);
  const excludedTurns = new Set<string>();
  for (const rows of bySession.values()) {
    for (const r of loopPool(rows)) {
      excludedTurns.add(r.tk);
      loop.occurrences++;
      loop.sessions.add(sid(r.session_id));
    }
  }

  // Failure-family candidates (turn keys), each restated from its published predicate.
  const c7 = col(
    db,
    `WITH ${BASE}, f AS (
       SELECT tk, workspace_id, session_id, COALESCE(fam, 'BASH_OTHER') AS fam, aw_c7sig(err) AS sig
         FROM base WHERE tool_name = 'Bash' AND exit_class IN ('ERROR', 'TEST_FAIL'))
     SELECT DISTINCT f.tk FROM f
       JOIN (SELECT workspace_id, session_id, fam, sig FROM f WHERE sig IS NOT NULL
              GROUP BY workspace_id, session_id, fam, sig HAVING COUNT(*) >= 3) g
         ON g.workspace_id = f.workspace_id AND g.session_id = f.session_id
        AND g.fam = f.fam AND g.sig = f.sig`,
    w,
  );
  const c3 = col(
    db,
    `WITH ${BASE} SELECT DISTINCT tk FROM base
      WHERE tool_name IN ('Edit', 'Write') AND err_class = 'NOT_READ' AND err_ver = 'tool-error-1'`,
    // RC-FU1: C3 is "Edit or Write" (turn-claim C3 candidates); only the loop exclusion is Edit-only.
    w,
  );
  const c4 = col(
    db,
    `WITH ${BASE}, ed AS (
       SELECT tk, workspace_id, session_id, fp,
              -- RC-FU1: view C4 = >=3 consecutive ERROR Edits on one file (C4_MIN_CONSECUTIVE_FAILURES), any
              -- error class; a tool-error-1 NOT_READ Edit (C3's) joins no run and does not break one.
              CASE WHEN exit_class = 'ERROR' THEN 1 ELSE 0 END AS bad,
              ts, block_index, event_id
         FROM base WHERE tool_name = 'Edit' AND fp IS NOT NULL
          AND COALESCE(err_class, '') || '|' || COALESCE(err_ver, '') <> 'NOT_READ|tool-error-1'),
     isl AS (
       SELECT tk, workspace_id, session_id, fp, bad,
              SUM(1 - bad) OVER (PARTITION BY workspace_id, session_id, fp
                                 ORDER BY ts, block_index, event_id ROWS UNBOUNDED PRECEDING) AS grp
         FROM ed)
     SELECT DISTINCT i.tk FROM isl i
       JOIN (SELECT workspace_id, session_id, fp, grp FROM isl WHERE bad = 1
              GROUP BY workspace_id, session_id, fp, grp HAVING COUNT(*) >= 3) r
         ON r.workspace_id = i.workspace_id AND r.session_id = i.session_id
        AND r.fp = i.fp AND r.grp = i.grp
      WHERE i.bad = 1`,
    w,
  );

  // D11: each workspace's higher-error shell, from all reconciled shell calls in the window.
  const shellRates = db
    .prepare(
      `WITH sh AS (
         SELECT s.workspace_id AS ws, e.tool_name AS tool,
                aw_shell(e.exit_class, json_extract(c.content_json, '$.error')) AS o
           FROM tool_events e
           JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
           LEFT JOIN tool_event_content c ON c.event_id = e.event_id
          WHERE e.ts >= @from AND e.ts < @to AND e.tool_name IN ('Bash', 'PowerShell')),
       r AS (SELECT ws, tool, COUNT(*) AS calls, SUM(o = 'ERROR') AS errs
               FROM sh WHERE o IS NOT NULL GROUP BY ws, tool)
       SELECT b.ws, b.calls AS bc, b.errs AS be, p.calls AS pc, p.errs AS pe
         FROM r b JOIN r p ON p.ws = b.ws AND p.tool = 'PowerShell'
        WHERE b.tool = 'Bash' AND b.calls >= 50 AND p.calls >= 50`,
    )
    .all(w) as Array<{ ws: string; bc: number; be: number; pc: number; pe: number }>;
  const worse: Record<string, string> = {};
  for (const r of shellRates) {
    const bashRate = r.be / r.bc;
    const psRate = r.pe / r.pc;
    const bashWorse = bashRate >= psRate;
    const [hi, lo, hiErrs] = bashWorse ? [bashRate, psRate, r.be] : [psRate, bashRate, r.pe];
    if (hiErrs >= 3 && (lo === 0 ? hi > 0 : hi >= 1.5 * lo))
      worse[r.ws] = bashWorse ? "Bash" : "PowerShell";
  }
  const worseJson = JSON.stringify(worse);
  const isWorse = `EXISTS (SELECT 1 FROM json_each(@worse) x
                            WHERE x.key = base.workspace_id AND x.value = base.tool_name)`;
  const d11 = col(
    db,
    `WITH ${BASE} SELECT DISTINCT tk FROM base
      WHERE ${isWorse} AND aw_shell(exit_class, err) = 'ERROR'`,
    w,
    { worse: worseJson },
  );
  const c1 = col(
    db,
    `WITH ${BASE}, c AS (
       SELECT tk, tool_name,
              CASE WHEN tool_name IN ('Bash', 'PowerShell') THEN aw_shell(exit_class, err) = 'ERROR'
                   WHEN tool_name IN ('Read', 'Grep', 'Glob') AND err IS NOT NULL
                        AND aw_not_found(err) = 1 THEN 0 -- RC-FU1: c1Outcome NOT_FOUND_ERROR → OK (C2 owns it)
                   WHEN exit_class IN ('ERROR', 'TEST_FAIL') AND aw_benign(cmd, err, tool_name) = 0
                   THEN 1 ELSE 0 END AS bad
         FROM base WHERE NOT ${isWorse}
          -- RC-FU1: c1Outcome returns null (out of the rates) for a hook block on any tool.
          AND NOT (err IS NOT NULL AND aw_guard(err) = 1)
          -- RC-FU1: a shell call is C1's error only when the shell raised it; one that never ran
          -- leaves the rates (turn-claim c1Outcome → d11Outcome). A script's non-zero exit is OK.
          AND NOT (tool_name IN ('Bash', 'PowerShell') AND aw_shell(exit_class, err) IS NULL)),
     corpus AS (SELECT SUM(bad) AS n, CAST(SUM(bad) AS REAL) / COUNT(*) AS rate FROM c),
     tools AS (SELECT tool_name, COUNT(*) AS calls, SUM(bad) AS errs,
                      CAST(SUM(bad) AS REAL) / COUNT(*) AS rate
                 FROM c GROUP BY tool_name)
     SELECT DISTINCT c.tk FROM c JOIN tools t ON t.tool_name = c.tool_name, corpus
      WHERE corpus.n > 0 AND c.bad = 1 AND t.rate > 2 * corpus.rate
        AND t.calls >= @minCalls AND t.errs >= @minErrors`,
    w,
    // card review F4 (2026-10-04): tools with fewer than C1_MIN_TOOL_CALLS calls never flag.
    // RC-FU1: nor tools with fewer than C1_MIN_TOOL_ERRORS counted errors (view rule, was unmirrored).
    { worse: worseJson, minCalls: C1_MIN_TOOL_CALLS, minErrors: C1_MIN_TOOL_ERRORS },
  );
  const c2 = col(
    db,
    `WITH ${BASE} SELECT DISTINCT tk FROM base
      WHERE tool_name IN ('Read', 'Grep', 'Glob') AND err_class = 'NOT_FOUND'
        AND err_ver = 'tool-error-1'`,
    w,
  );

  // C9 blocks: main-chain, non-interrupt denials; a rejected AskUserQuestion is an answer.
  const denials = db
    .prepare(
      `WITH d AS (
         SELECT e.session_id, e.event_ts, e.classifier_label AS label,
                (SELECT json_array(h.tool_name, h.ts) FROM tool_events h
                  WHERE h.session_id = e.session_id AND h.interrupt_kind = 'HUMAN_DENY'
                    AND h.ts <= e.event_ts ORDER BY h.ts DESC LIMIT 1) AS deny
           FROM ingest_metric_events e
          WHERE e.event_ts >= @from AND e.event_ts < @to AND e.is_sidechain = 0
            AND e.is_interrupt = 0
            AND e.classifier_label IN ('hook-block', 'deny-rule', 'user-rejected'))
       SELECT session_id, event_ts, label,
              json_extract(deny, '$[1]') AS deny_ts,
              (SELECT t.session_id || '|' || t.message_id FROM turns t
                WHERE t.session_id = d.session_id AND t.is_sidechain = 0 AND t.ts <= d.event_ts
                ORDER BY t.ts DESC LIMIT 1) AS owner_tk,
              (SELECT t.session_id || '|' || t.message_id FROM turns t
                WHERE t.session_id = d.session_id AND t.is_sidechain = 0 AND t.ts > d.event_ts
                ORDER BY t.ts ASC LIMIT 1) AS replan_tk
         FROM d
        WHERE NOT (label = 'user-rejected' AND json_extract(deny, '$[0]') IS 'AskUserQuestion')`,
    )
    .all(w) as Array<{
    session_id: string;
    event_ts: string;
    label: string;
    deny_ts: string | null;
    owner_tk: string | null;
    replan_tk: string | null;
  }>;
  const c9Turns = new Set<string>();
  const c9 = tally("C9");
  const c9Breakdown = new Map<string, number>();
  const c9Waits: Core["c9Waits"] = [];
  for (const d of denials) {
    c9.occurrences++;
    c9.sessions.add(sid(d.session_id));
    c9Breakdown.set(d.label, (c9Breakdown.get(d.label) ?? 0) + 1);
    if (d.label === "user-rejected")
      c9Waits.push({
        event_ts: d.event_ts,
        wait_ms:
          d.deny_ts === null
            ? 0
            : Math.min(Date.parse(d.event_ts) - Date.parse(d.deny_ts), WAIT_CAP_MS),
      });
    if (d.owner_tk) c9Turns.add(d.owner_tk);
    if (d.replan_tk) c9Turns.add(d.replan_tk);
  }

  // D14: classified interrupts not caused by session end and not followed by a prompt correction
  // within two main-chain turns. Claims the owner turn and the next main-chain turn.
  const d14Rows = db
    .prepare(
      `SELECT e.session_id || '|' || m.owner_message_id AS owner_tk,
              (SELECT e.session_id || '|' || n.message_id FROM turns n
                WHERE n.session_id = e.session_id AND n.is_sidechain = 0 AND n.provisional = 0
                  AND n.ts > t.ts ORDER BY n.ts ASC LIMIT 1) AS next_tk
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.session_id = e.session_id AND t.message_id = m.owner_message_id
                     AND t.is_sidechain = 0 AND t.provisional = 0
        WHERE e.ts >= @from AND e.ts < @to
          AND e.interrupt_kind IN ('PURE_INTERRUPT', 'KILLED_NO_PROMPT')
          AND e.interrupt_classifier_version = 'interrupt-1'
          AND NOT EXISTS (SELECT 1 FROM tool_event_content x WHERE x.event_id = e.event_id
                AND json_extract(x.content_json, '$.error')
                    LIKE '[Tool call interrupted: the session ended%')
          AND NOT EXISTS (SELECT 1 FROM ingest_metric_events u
                WHERE u.session_id = e.session_id AND u.is_user_turn = 1 AND u.user_turn_ts > e.ts
                  AND (SELECT COUNT(*) FROM turns l
                        WHERE l.session_id = e.session_id AND l.is_sidechain = 0
                          AND l.provisional = 0 AND l.ts > e.ts AND l.ts <= u.user_turn_ts) <= 2)`,
    )
    .all(w) as Array<{ owner_tk: string; next_tk: string | null }>;
  // RC-D14: D14's second source, the plain Esc user record (classifier-2 'interrupt-cancel'), same
  // session/chain/correction filters. Claims the stopped response (the latest main settled turn at
  // or before the Esc and after the latest main prompt before it) and the next main-chain turn.
  const d14EscRows = db
    .prepare(
      `SELECT (SELECT x.session_id || '|' || o.message_id FROM turns o
                WHERE o.session_id = x.session_id AND o.is_sidechain = 0 AND o.provisional = 0
                  AND o.ts <= x.event_ts
                  AND o.ts > COALESCE((SELECT MAX(p.user_turn_ts) FROM ingest_metric_events p
                        WHERE p.session_id = x.session_id AND p.is_user_turn = 1
                          AND p.is_sidechain = 0 AND p.user_turn_ts < x.event_ts), '')
                ORDER BY o.ts DESC LIMIT 1) AS owner_tk,
              (SELECT x.session_id || '|' || n.message_id FROM turns n
                WHERE n.session_id = x.session_id AND n.is_sidechain = 0 AND n.provisional = 0
                  AND n.ts > x.event_ts ORDER BY n.ts ASC LIMIT 1) AS next_tk
         FROM ingest_metric_events x
         JOIN sessions s ON s.session_id = x.session_id AND s.state = 'RECONCILED'
        WHERE x.event_ts >= @from AND x.event_ts < @to
          AND x.is_sidechain = 0 AND x.is_interrupt = 1
          AND x.classifier_label = 'interrupt-cancel' AND x.classifier_version = 'classifier-2'
          AND NOT EXISTS (SELECT 1 FROM ingest_metric_events u
                WHERE u.session_id = x.session_id AND u.is_user_turn = 1
                  AND u.user_turn_ts > x.event_ts
                  AND (SELECT COUNT(*) FROM turns l
                        WHERE l.session_id = x.session_id AND l.is_sidechain = 0
                          AND l.provisional = 0 AND l.ts > x.event_ts
                          AND l.ts <= u.user_turn_ts) <= 2)`,
    )
    .all(w) as Array<{ owner_tk: string | null; next_tk: string | null }>;
  const d14 = new Set<string>();
  for (const r of [...d14Rows, ...d14EscRows]) {
    if (r.owner_tk) d14.add(r.owner_tk);
    if (r.next_tk) d14.add(r.next_tk);
  }

  // Disjoint partition: loop-pool turns first, then LEDGER_PRIORITY order; one family per turn.
  // C9 claims its turns here but is counted in events (above). D14's pattern code is its rule "D2".
  const claimed = new Set(excludedTurns);
  for (const [code, candidates] of [
    ["C7", c7],
    ["C3", c3],
    ["C4", c4],
    ["C1", c1],
    ["C2", c2],
    [null, c9Turns],
    ["D2", d14],
    ["D11", d11],
  ] as const) {
    const t = code === null ? newTally() : tally(code);
    for (const k of candidates) {
      if (claimed.has(k)) continue;
      claimed.add(k);
      t.occurrences++;
      t.sessions.add(sid(k.slice(0, k.indexOf("|"))));
    }
  }

  // H1 risk row. card review F6 (2026-10-04): minus calls that never ran. A call never ran when
  // its Bash row (same session, same ts) was human-denied or its error shows a denial/guard block.
  // No Bash row: kept. Several Bash rows at that time: dropped only if none of them ran.
  const h1 = db
    .prepare(
      `SELECT e.session_id AS session_id, e.destructive_op AS label FROM ingest_metric_events e
        WHERE e.event_ts >= @from AND e.event_ts < @to
          AND e.destructive_op IN ('rm-rf', 'git-reset-hard', 'git-clean', 'sql-drop', 'truncate')
          AND e.is_sidechain = 0
          AND NOT (
            EXISTS (SELECT 1 FROM tool_events b WHERE b.session_id = e.session_id
                      AND b.ts = e.event_ts AND b.tool_name = 'Bash')
            AND NOT EXISTS (
              SELECT 1 FROM tool_events b
                LEFT JOIN tool_event_content c ON c.event_id = b.event_id
               WHERE b.session_id = e.session_id AND b.ts = e.event_ts AND b.tool_name = 'Bash'
                 AND aw_never_ran(b.interrupt_kind, json_extract(c.content_json, '$.error')) = 0))`,
    )
    .all(w) as Array<{ session_id: string; label: string }>;
  const h1Tally = tally("H1");
  const h1Breakdown = new Map<string, number>();
  for (const r of h1) {
    h1Tally.occurrences++;
    h1Tally.sessions.add(sid(r.session_id));
    h1Breakdown.set(r.label, (h1Breakdown.get(r.label) ?? 0) + 1);
  }

  // Findings (rec state ignored): V2 anchors in the window, or V1 session lists whose fired week
  // overlaps it. Anchor session ids are already opaque sids.
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  const inWin = (ts: unknown) =>
    typeof ts === "string" && Date.parse(ts) >= from && Date.parse(ts) < to;
  const recs = db
    .prepare(
      `SELECT detector_id, COALESCE(rule_id, template_id) AS k, contract_status AS cs,
              scope_workspace_id AS ws, evidence_json AS ev
         FROM recommendations WHERE provenance = 'RULE'`,
    )
    .all() as Array<{
    detector_id: string;
    k: string | null;
    cs: string;
    ws: string | null;
    ev: string;
  }>;
  const weeks = hasTable(db, "detector_week_results")
    ? (db
        .prepare(
          "SELECT detector_id, scope_workspace_id AS ws, week_start FROM detector_week_results WHERE fired = 1",
        )
        .all() as Array<{ detector_id: string; ws: string | null; week_start: string }>)
    : null;
  if (weeks === null) notes.push("NO_DETECTOR_WEEK_RESULTS: V1 findings contribute no sessions");
  for (const rec of recs) {
    const fk = FINDING_KEYS.find(
      (f) => f.detector_id === rec.detector_id && (f.key === undefined || f.key === rec.k),
    );
    if (!fk) {
      if (!NOT_FROM_FINDINGS.has(rec.detector_id) && !NOT_FROM_FINDINGS_KEYS.has(rec.k ?? ""))
        notes.push(`UNMAPPED_FINDING:${rec.detector_id}/${rec.k ?? "-"}`);
      continue;
    }
    const t = tally(fk.code);
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(rec.ev) as Record<string, unknown>;
    } catch {
      notes.push(`UNPARSEABLE_EVIDENCE:${fk.code}`);
      continue;
    }
    if (Array.isArray(ev.anchors)) {
      const anchors = ev.anchors as Array<Record<string, unknown>>;
      const hits = anchors.filter((a) => inWin(a.timestamp) && typeof a.session_id === "string");
      for (const a of hits) t.sessions.add(a.session_id as string);
      t.occurrences += hits.length;
      if (hits.length > 0 && anchors.length >= V2_ANCHOR_CAP) t.lowerBound = true;
    } else if (rec.cs === "V1_VALIDATED" && AVOIDABLE_CODES.has(fk.code) && weeks !== null) {
      const facts = ev.facts as Record<string, unknown> | undefined;
      const ids = Array.isArray(facts?.session_ids) ? (facts.session_ids as unknown[]) : [];
      const overlaps = weeks.some(
        (wk) =>
          wk.detector_id === rec.detector_id &&
          wk.ws === rec.ws &&
          Date.parse(wk.week_start) < to &&
          Date.parse(wk.week_start) + 7 * DAY_MS > from,
      );
      if (!overlaps) continue;
      for (const s of ids) if (typeof s === "string") t.sessions.add(sid(s));
      if (ids.length >= V1_SESSION_CAP) t.lowerBound = true;
    }
  }

  return {
    spend: totals.spend,
    sessionCount: totals.n,
    patterns,
    c9Breakdown,
    c9Waits,
    h1Breakdown,
    notes,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

type Breakdown = Array<{ label: string; count: number }>;
type CauseOut = {
  cause_id: string;
  patterns: Array<{ code: string; count: number }>;
  occurrences: number;
  sessions_affected: number;
  sessions_affected_is_lower_bound: boolean;
  share: number | null;
  trend: "rising" | "falling" | "steady";
  previous: { occurrences: number; rate: number | null };
  breakdown?: Breakdown;
  cost?: { wait_ms: number };
};
export type OracleReport = {
  window_days: number;
  as_of: string;
  window_rule: string;
  window: Win;
  previous_window: Win;
  tiles: {
    spend_u: number;
    session_count: number;
    friction_sessions: number;
    friction_share: number | null;
  };
  reliability: { causes: CauseOut[]; risk: CauseOut };
  avoidable: { causes: CauseOut[] };
  notes: string[];
};

const toBreakdown = (m: Map<string, number>): Breakdown =>
  [...m].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));

/** A cause's figures in one window: Σ pattern counts, and the distinct union of its sessions. */
function group(core: Core, def: CauseDef, bySessions: boolean) {
  const sessions = new Set<string>();
  let occurrences = 0;
  let lowerBound = false;
  const patterns = def.codes.map((code) => {
    const t = core.patterns.get(code) ?? newTally();
    for (const s of t.sessions) sessions.add(s);
    lowerBound ||= t.lowerBound;
    const count = bySessions ? t.sessions.size : t.occurrences;
    occurrences += count;
    return { code, count };
  });
  return { patterns, occurrences, sessions, lowerBound };
}

export function computeTriage(db: Db, windowDays: number, asOfIso: string): OracleReport {
  registerFunctions(db);
  const asOf = Date.parse(asOfIso);
  const iso = (ms: number) => new Date(ms).toISOString();
  const w = { from: iso(asOf - windowDays * DAY_MS), to: iso(asOf) };
  const p = { from: iso(asOf - 2 * windowDays * DAY_MS), to: w.from };
  const cur = computeCore(db, w);
  const prev = computeCore(db, p);
  const first = (db.prepare("SELECT MIN(ts) AS ts FROM turns").get() as { ts: string | null }).ts;
  const history = first !== null && Date.parse(p.from) >= Date.parse(first);
  const shares = cur.spend !== 0 && cur.sessionCount !== 0;
  const rate = (n: number, d: number) => (d === 0 ? null : n / d);

  const out = (def: CauseDef, bySessions: boolean): CauseOut => {
    const c = group(cur, def, bySessions);
    const q = group(prev, def, bySessions);
    const curRate = rate(c.sessions.size, cur.sessionCount);
    const prevRate = rate(q.sessions.size, prev.sessionCount);
    let trend: CauseOut["trend"] = "steady";
    if (
      history &&
      c.occurrences >= TREND_FLOOR &&
      q.occurrences >= TREND_FLOOR &&
      curRate !== null &&
      prevRate
    ) {
      const ratio = curRate / prevRate;
      trend = ratio >= 1.25 ? "rising" : ratio <= 0.8 ? "falling" : "steady";
    }
    return {
      cause_id: def.cause_id,
      patterns: c.patterns,
      occurrences: c.occurrences,
      sessions_affected: c.sessions.size,
      sessions_affected_is_lower_bound: c.lowerBound,
      share: shares ? c.sessions.size / cur.sessionCount : null,
      trend,
      previous: { occurrences: q.occurrences, rate: prevRate },
    };
  };

  const reliability = RELIABILITY.map((def) => out(def, false));
  const blocked = reliability.find((c) => c.cause_id === "BLOCKED_BY_PERMISSIONS");
  if (blocked) {
    blocked.breakdown = toBreakdown(cur.c9Breakdown);
    blocked.cost = { wait_ms: cur.c9Waits.reduce((s, x) => s + x.wait_ms, 0) };
  }
  const risk = { ...out(RISK, false), breakdown: toBreakdown(cur.h1Breakdown) };
  const friction = new Set<string>();
  for (const def of RELIABILITY) for (const s of group(cur, def, false).sessions) friction.add(s);

  return {
    window_days: windowDays,
    as_of: iso(asOf),
    window_rule: "[as_of - window_days, as_of): end exclusive (KTD-3)",
    window: w,
    previous_window: p,
    tiles: {
      spend_u: cur.spend,
      session_count: cur.sessionCount,
      friction_sessions: friction.size,
      friction_share: shares ? friction.size / cur.sessionCount : null,
    },
    reliability: { causes: reliability, risk },
    avoidable: { causes: AVOIDABLE.map((def) => out(def, true)) },
    notes: [...new Set([...cur.notes, ...prev.notes])],
  };
}

// ── --compare: diff against a built DiagnosticsTriageView (report only, never fix) ──

export type Diff = { cause_id: string; field: string; oracle: unknown; view: unknown };
const LABEL_ALIASES: Record<string, string> = {
  hook: "hook-block",
  "deny rule": "deny-rule",
  "rejected by you": "user-rejected",
  // RC-FU1: the view's H1 display labels (diagnostics-triage BREAKDOWN_LABELS).
  "rm -rf": "rm-rf",
  "git reset --hard": "git-reset-hard",
  "git clean": "git-clean",
  "drop table": "sql-drop",
};
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown) => (Array.isArray(v) ? v : []).map(rec);
const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 : a === b;
const normBreakdown = (v: unknown) =>
  JSON.stringify(
    list(v)
      .map((x) => {
        const label = String(x.label ?? "").toLowerCase();
        return [LABEL_ALIASES[label] ?? label, x.count];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

/** Diffs per cause_id; a pattern code missing on one side counts as 0 there. */
export function compareView(
  o: OracleReport,
  viewJson: unknown,
  ledger: LedgerReport | null = null,
): Diff[] {
  const diffs: Diff[] = [];
  const check = (cause_id: string, field: string, oracle: unknown, view: unknown) => {
    if (!same(oracle, view)) diffs.push({ cause_id, field, oracle, view });
  };
  const view = rec(viewJson);
  const tiles = rec(view.tiles);
  for (const f of ["spend_u", "session_count", "friction_sessions", "friction_share"] as const)
    check("tiles", f, o.tiles[f], tiles[f]);
  const rel = rec(view.reliability);
  const viewCauses = [
    ...list(rel.causes),
    ...(rel.risk === undefined ? [] : [rec(rel.risk)]),
    ...list(rec(view.avoidable).causes),
  ];
  const oracleCauses = [...o.reliability.causes, o.reliability.risk, ...o.avoidable.causes];
  const ledgerIds = new Set(ledger?.complete ? ledger.causes.map((c) => c.cause_id) : []);
  // RC-B U3: a cause is silent when it has no findings and no ledger dollars in the window.
  const silentLists = [rel.silent, rec(view.avoidable).silent].filter((s) => s !== undefined);
  const viewSilent = new Set(silentLists.flatMap((s) => list(s).map((x) => String(x.cause_id))));
  if (silentLists.length > 0) {
    for (const c of oracleCauses) {
      const ledgerU = ledger?.causes.find((x) => x.cause_id === c.cause_id)?.avoidable_u ?? 0;
      check(c.cause_id, "silent", c.occurrences === 0 && ledgerU <= 0, viewSilent.has(c.cause_id));
    }
    for (const v of viewCauses)
      if (viewSilent.has(String(v.cause_id)))
        diffs.push({
          cause_id: String(v.cause_id),
          field: "silent AND ranked",
          oracle: false,
          view: true,
        });
  }
  for (const c of oracleCauses) {
    const v = viewCauses.find((x) => x.cause_id === c.cause_id);
    if (!v) {
      if (!viewSilent.has(c.cause_id))
        diffs.push({ cause_id: c.cause_id, field: "ONLY_IN_ORACLE", oracle: true, view: null });
      continue;
    }
    // A ledger row (decided by the oracle's own complete ledger report, not by the view) takes share,
    // sessions and trend from the ledger (U8); compareLedger checks them.
    const ledgerRow = ledgerIds.has(c.cause_id);
    if (ledger === null && typeof v.avoidable_u === "number")
      diffs.push({
        cause_id: c.cause_id,
        field: "avoidable_u (no ledger report)",
        oracle: null,
        view: v.avoidable_u,
      });
    for (const f of [
      "occurrences",
      "sessions_affected",
      "sessions_affected_is_lower_bound",
      "share",
      "trend",
    ] as const)
      if (!ledgerRow || f === "occurrences")
        // RC-FU1: an avoidable cause's share is $-based, so a producerless cause has none.
        check(
          c.cause_id,
          f,
          f === "share" && ledger?.producerless.includes(c.cause_id) ? null : c[f],
          v[f],
        );
    const vp = new Map(list(v.patterns).map((x) => [String(x.code), x.count]));
    for (const code of new Set([...c.patterns.map((x) => x.code), ...vp.keys()]))
      check(
        c.cause_id,
        `patterns.${code}`,
        c.patterns.find((x) => x.code === code)?.count ?? 0,
        vp.get(code) ?? 0,
      );
    if (c.breakdown !== undefined || v.breakdown !== undefined)
      check(c.cause_id, "breakdown", normBreakdown(c.breakdown), normBreakdown(v.breakdown));
    if (c.cost !== undefined || v.cost !== undefined)
      // RC-FU1: absent and null both mean "no wait metric"; only values are compared.
      check(c.cause_id, "cost.wait_ms", c.cost?.wait_ms ?? null, rec(v.cost).wait_ms ?? null);
  }
  for (const v of viewCauses)
    if (!oracleCauses.some((c) => c.cause_id === v.cause_id))
      diffs.push({ cause_id: String(v.cause_id), field: "ONLY_IN_VIEW", oracle: null, view: true });
  return diffs;
}

// ── Ledger / AE4 checks (P4 U8): Avoidable $ straight from ledger_daily ────────

/**
 * Spend-lane producer detectors, restated from src/detector/claim-ledger.ts: SPEND_LANE_DETECTOR_IDS =
 * CLAIM_PRODUCERS detectorIds minus RELIABILITY_LANE_DETECTOR_IDS (C7 C3 C4 C1 C2 C9 D14 D11 + C6 C11),
 * i.e. the producers d1, d10, a1, d6, a2, d7x, d2, d8, b1, b3, d4. D6 joined in RR U13 (b36d0d7f).
 */
const SPEND_PRODUCERS = new Set([
  "D1",
  "D10",
  "A1",
  "D6",
  "A2",
  "D7",
  "D2",
  "D8",
  "B1",
  "B3",
  "D4",
]);
/** Pattern codes that are a rule id, not a detector id. */
const CODE_DETECTOR: Record<string, string> = {
  D2_LONG_FULL_CONTEXT: "D2",
  D7_CROSS_SESSION_REREAD: "D7",
};

export type LedgerCause = {
  cause_id: string;
  avoidable_u: number;
  coverage: "ALL" | "PARTIAL";
  sessions_affected: number;
  /** The same producers' ledger sum over [E-2w, E-w), from the same grid blocks. */
  prev_avoidable_u: number;
  /** The one rec's own ledger sum, when the cause's window rows carry exactly one rec_id (non-empty). */
  single_rec_u: number | null;
};
export type LedgerReport = {
  through: string;
  complete: boolean;
  /** Spend causes with at least one producer detector. */
  causes: LedgerCause[];
  /** Spend causes with no producer (their figure must stay null). */
  producerless: string[];
  spend_u: number;
  /** Spend over [E-2w, E-w). */
  prev_spend_u: number;
  /** E-2w is at or after the first turn. */
  has_history: boolean;
  /** Spend and session count over [as_of-w, as_of): the view nulls every share when either is 0. */
  window_spend_u: number;
  window_sessions: number;
  tile_u: number;
};

/** Block grid ending at `e`: block k = [e - 7(k+1) d, e - 7k d). Needs ceil(2w/7) blocks. */
function blockGrid(e: number, windowDays: number): Array<{ start: string; end: string }> {
  return Array.from({ length: Math.ceil((2 * windowDays) / 7) }, (_, k) => ({
    start: new Date(e - 7 * (k + 1) * DAY_MS).toISOString(),
    end: new Date(e - 7 * k * DAY_MS).toISOString(),
  }));
}

/** Null when the DB has no ledger tables at all (nothing to check). */
export function computeLedger(db: Db, windowDays: number, asOfIso: string): LedgerReport | null {
  if (!hasTable(db, "ledger_daily_marks") || !hasTable(db, "ledger_daily")) return null;
  const e = Math.floor(Date.parse(asOfIso) / DAY_MS) * DAY_MS;
  const grid = blockGrid(e, windowDays);
  const marks = new Map(
    (
      db.prepare("SELECT block_start, block_end FROM ledger_daily_marks").all() as Array<{
        block_start: string;
        block_end: string;
      }>
    ).map((m) => [m.block_start, m.block_end]),
  );
  const complete = grid.every((b) => marks.get(b.start) === b.end);
  const from = new Date(e - windowDays * DAY_MS);
  const dayFrom = from.toISOString().slice(0, 10);
  const dayTo = new Date(e).toISOString().slice(0, 10);
  const spend = (
    db
      .prepare(
        "SELECT COALESCE(SUM(cost_equiv_u), 0) AS s FROM turns WHERE ts >= @from AND ts < @to",
      )
      .get({ from: from.toISOString(), to: new Date(e).toISOString() }) as { s: number }
  ).s;
  const prevFrom = new Date(e - 2 * windowDays * DAY_MS);
  const spendOver = (a: string, b: string) =>
    (
      db
        .prepare(
          "SELECT COALESCE(SUM(cost_equiv_u), 0) AS s FROM turns WHERE ts >= @from AND ts < @to",
        )
        .get({ from: a, to: b }) as { s: number }
    ).s;
  const asOfMs = Date.parse(asOfIso);
  const win = {
    from: new Date(asOfMs - windowDays * DAY_MS).toISOString(),
    to: new Date(asOfMs).toISOString(),
  };
  const first = (db.prepare("SELECT MIN(ts) AS ts FROM turns").get() as { ts: string | null }).ts;
  const report: LedgerReport = {
    through: new Date(e).toISOString(),
    complete,
    causes: [],
    producerless: [],
    spend_u: spend,
    prev_spend_u: spendOver(prevFrom.toISOString(), from.toISOString()),
    has_history: first !== null && prevFrom.getTime() >= Date.parse(first),
    window_spend_u: spendOver(win.from, win.to),
    window_sessions: (
      db
        .prepare("SELECT COUNT(DISTINCT session_id) AS n FROM turns WHERE ts >= @from AND ts < @to")
        .get(win) as { n: number }
    ).n,
    tile_u: 0,
  };
  if (!complete) return report;

  const marks_ = (n: number) => Array(n).fill("?").join(",");
  const starts = grid.map((b) => b.start);
  const base = `lane = 'spend' AND day >= ? AND day < ? AND block_start IN (${marks_(starts.length)})`;
  const baseArgs = [dayFrom, dayTo, ...starts];
  const dayPrevFrom = prevFrom.toISOString().slice(0, 10);
  for (const def of AVOIDABLE) {
    const detectors = [...new Set(def.codes.map((c) => CODE_DETECTOR[c] ?? c))];
    const producers = detectors.filter((d) => SPEND_PRODUCERS.has(d));
    if (producers.length === 0) {
      report.producerless.push(def.cause_id);
      continue;
    }
    const inDet = `${base} AND detector_id IN (${marks_(producers.length)})`;
    const args = [...baseArgs, ...producers];
    const v = (
      db
        .prepare(`SELECT COALESCE(SUM(value_u), 0) AS v FROM ledger_daily WHERE ${inDet}`)
        .get(...args) as { v: number }
    ).v;
    const prevV = (
      db
        .prepare(`SELECT COALESCE(SUM(value_u), 0) AS v FROM ledger_daily WHERE ${inDet}`)
        .get(dayPrevFrom, dayFrom, ...starts, ...producers) as { v: number }
    ).v;
    const n = (
      db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM ledger_daily_sessions WHERE ${inDet}`)
        .get(...args) as { n: number }
    ).n;
    const recIds = (
      db.prepare(`SELECT DISTINCT rec_id FROM ledger_daily WHERE ${inDet}`).all(...args) as Array<{
        rec_id: string;
      }>
    ).map((r) => r.rec_id);
    let single: number | null = null;
    const only = recIds.length === 1 ? recIds[0] : undefined;
    if (only !== undefined && only !== "") {
      const byRec = db
        .prepare(`SELECT rec_id, SUM(value_u) AS v FROM ledger_daily WHERE ${base} GROUP BY rec_id`)
        .all(...baseArgs) as Array<{ rec_id: string; v: number }>;
      single = Math.round(byRec.find((r) => r.rec_id === only)?.v ?? 0);
    }
    const avoidable = Math.round(v);
    report.tile_u += avoidable;
    report.causes.push({
      cause_id: def.cause_id,
      avoidable_u: avoidable,
      coverage: detectors.every((d) => SPEND_PRODUCERS.has(d)) ? "ALL" : "PARTIAL",
      sessions_affected: n,
      prev_avoidable_u: Math.round(prevV),
      single_rec_u: single,
    });
  }
  return report;
}

/** Diffs of the view's Avoidable figures against the ledger. Ids and counts only (SEC-101). */
export function compareLedger(
  o: LedgerReport,
  viewJson: unknown,
  base: OracleReport | null = null,
): Diff[] {
  const diffs: Diff[] = [];
  const check = (cause_id: string, field: string, oracle: unknown, view: unknown) => {
    if (!same(oracle, view ?? null)) diffs.push({ cause_id, field, oracle, view: view ?? null });
  };
  const view = rec(viewJson);
  const tiles = rec(view.tiles);
  const rows = list(rec(view.avoidable).causes);
  if (!o.complete) {
    // Incomplete marks: nothing is estimated.
    for (const r of rows)
      check(String(r.cause_id), "avoidable_u (incomplete marks)", null, r.avoidable_u);
    check("tiles", "avoidable_u (incomplete marks)", null, tiles.avoidable_u);
    return diffs;
  }
  let viewSum = 0;
  for (const r of rows) if (typeof r.avoidable_u === "number") viewSum += r.avoidable_u;
  // The view nulls every share when spend or sessions over [as_of-w, as_of) is 0, or ledger spend is 0.
  const shares = o.spend_u !== 0 && o.window_spend_u !== 0 && o.window_sessions !== 0;
  // Trend on the $ share of spend: the census rule (occurrence floor of 5 in both windows, ratio
  // >= 1.25 rising, <= 0.80 falling, no history or a zero/unknown previous rate is steady), restated.
  const trendFor = (c: LedgerCause): string => {
    const occ = base?.avoidable.causes.find((x) => x.cause_id === c.cause_id);
    if (occ === undefined) return "n/a";
    const cur = o.spend_u === 0 ? null : c.avoidable_u / o.spend_u;
    const prev = o.prev_spend_u === 0 ? null : c.prev_avoidable_u / o.prev_spend_u;
    if (
      !o.has_history ||
      occ.occurrences < TREND_FLOOR ||
      occ.previous.occurrences < TREND_FLOOR ||
      cur === null ||
      !prev
    )
      return "steady";
    const ratio = cur / prev;
    return ratio >= 1.25 ? "rising" : ratio <= 0.8 ? "falling" : "steady";
  };
  for (const c of o.causes) {
    const v = rows.find((x) => x.cause_id === c.cause_id);
    if (!v) {
      // A zero-value producer cause with no findings may be absent; anything else must show.
      if (c.avoidable_u !== 0) check(c.cause_id, "avoidable_u", c.avoidable_u, null);
      continue;
    }
    check(c.cause_id, "avoidable_u", c.avoidable_u, v.avoidable_u);
    check(c.cause_id, "coverage", c.coverage, v.coverage);
    check(c.cause_id, "sessions_affected", c.sessions_affected, v.sessions_affected);
    check(
      c.cause_id,
      "lower_bound flag (ledger is exact)",
      false,
      v.sessions_affected_is_lower_bound,
    );
    check(
      c.cause_id,
      "share (spend over [E-w, E))",
      shares ? c.avoidable_u / o.spend_u : null,
      v.share,
    );
    // A ledger row always has a previous ledger figure, so its trend is on the spend share.
    check(c.cause_id, "trend_basis", "spend_share", v.trend_basis);
    const trend = trendFor(c);
    if (trend !== "n/a") check(c.cause_id, "trend (spend share)", trend, v.trend);
    if (c.single_rec_u !== null)
      check(c.cause_id, "ae4 (single rec ledger sum)", c.single_rec_u, v.avoidable_u);
  }
  for (const id of o.producerless) {
    const v = rows.find((x) => x.cause_id === id);
    if (v) check(id, "avoidable_u (no producer)", null, v.avoidable_u);
  }
  const tile = tiles.avoidable_u;
  check("tiles", "avoidable_u = sum of causes", viewSum, tile);
  check("tiles", "avoidable_u = ledger sum", o.tile_u, tile);
  if (typeof tile === "number" && tile > o.spend_u)
    diffs.push({
      cause_id: "tiles",
      field: "avoidable_u <= spend [E-w, E)",
      oracle: o.spend_u,
      view: tile,
    });
  const share = typeof tile === "number" && shares ? tile / o.spend_u : null;
  check("tiles", "avoidable_share (spend over [E-w, E))", share, tiles.avoidable_share);
  return diffs;
}

// ── --self-check: synthetic DBs with hand-written expectations ────────────────

function fixtureDb(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE turns (message_id TEXT, session_id TEXT, workspace_id TEXT, ts TEXT,
      is_sidechain INTEGER, provisional INTEGER, cost_equiv_u INTEGER);
    CREATE TABLE sessions (session_id TEXT, workspace_id TEXT, state TEXT);
    CREATE TABLE tool_events (event_id TEXT, session_id TEXT, ts TEXT, tool_name TEXT,
      input_hash TEXT, exit_class TEXT, tool_error_class TEXT, tool_error_classifier_version TEXT,
      bash_command_family TEXT, interrupt_kind TEXT, interrupt_classifier_version TEXT,
      result_bytes INTEGER);
    CREATE TABLE tool_event_metadata (event_id TEXT, file_path_hash TEXT, owner_message_id TEXT,
      block_index INTEGER);
    CREATE TABLE tool_event_content (event_id TEXT, content_json TEXT);
    CREATE TABLE ingest_metric_events (event_id TEXT, session_id TEXT, user_turn_ts TEXT,
      is_user_turn INTEGER, is_interrupt INTEGER, classifier_label TEXT, destructive_op TEXT,
      event_ts TEXT, is_sidechain INTEGER, classifier_version TEXT);
    CREATE TABLE recommendations (rec_id TEXT, provenance TEXT, detector_id TEXT,
      scope_workspace_id TEXT, evidence_json TEXT, contract_status TEXT, rule_id TEXT,
      template_id TEXT);
    CREATE TABLE detector_week_results (detector_id TEXT, scope_key TEXT, week_start TEXT,
      scope_workspace_id TEXT, fired INTEGER);`);
  return db;
}

function insert(db: Db, table: string, rows: unknown[][]): void {
  // Rows shorter than the table leave its later-added columns (e.g. result_bytes) NULL.
  const width = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown[]).length;
  for (const r of rows) {
    const row = [...r, ...Array(Math.max(0, width - r.length)).fill(null)];
    db.prepare(`INSERT INTO ${table} VALUES (${row.map(() => "?").join(",")})`).run(...row);
  }
}

export function selfCheck(): string[] {
  const fails: string[] = [];
  const expect = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      fails.push(`${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const d = (day: number, hms: string) => `2026-01-${String(day).padStart(2, "0")}T${hms}.000Z`;
  const db = fixtureDb();
  const ins = (table: string, rows: unknown[][]) => insert(db, table, rows);
  ins(
    "sessions",
    ["s1", "s2", "s3", "s4"].map((s) => [s, "w1", "RECONCILED"]),
  );
  ins("turns", [
    ["t1", "s1", "w1", d(10, "10:00:00"), 0, 0, 100],
    ["t2", "s1", "w1", d(10, "10:10:00"), 0, 0, 200],
    ["t3", "s1", "w1", d(10, "10:20:00"), 0, 0, 300],
    ["t4", "s1", "w1", d(10, "10:30:00"), 0, 0, 50],
    ["u1", "s2", "w1", d(11, "09:00:30"), 0, 0, 10],
    ["u2", "s2", "w1", d(11, "09:05:00"), 0, 0, 20],
    ["u3", "s2", "w1", d(11, "09:50:00"), 0, 0, 30],
    ["u4", "s2", "w1", d(11, "10:00:00"), 0, 0, 40],
    ["v1", "s3", "w1", d(12, "08:00:00"), 0, 0, 5],
    ["x1", "s4", "w1", d(5, "12:00:00"), 0, 0, 1000], // previous window
  ]);
  // s1: three Bash failures of one family/signature (C7), 10 min apart so no D7 ERROR run;
  // turn t3 also holds a Read NOT_FOUND (C2), which C7 outranks.
  ins("tool_events", [
    ["e1", "s1", d(10, "10:00:05"), "Bash", "h1", "ERROR", null, null, "git", null, null],
    ["e2", "s1", d(10, "10:10:05"), "Bash", "h2", "ERROR", null, null, "git", null, null],
    ["e3", "s1", d(10, "10:20:05"), "Bash", "h3", "ERROR", null, null, "git", null, null],
    [
      "e4",
      "s1",
      d(10, "10:20:10"),
      "Read",
      "h4",
      "ERROR",
      "NOT_FOUND",
      "tool-error-1",
      null,
      null,
      null,
    ],
    ["e5", "s1", d(10, "10:30:05"), "Read", "h5", "OK", null, null, null, null, null],
    // t4: three identical Reads (identical-call loop: 2 repeats), then three Bash errors 30 s
    // apart with no family (same-tool error run: 2 repeats; not C7). One pool: 4 repeats.
    // The errors repeat one command: a changed command/error text ends an error run (RC-FU1).
    ["e6", "s1", d(10, "10:30:06"), "Read", "h5", "OK", null, null, null, null, null],
    ["e7", "s1", d(10, "10:30:07"), "Read", "h5", "OK", null, null, null, null, null],
    ["e8", "s1", d(10, "10:31:00"), "Bash", "h8", "ERROR", null, null, null, null, null],
    ["e9", "s1", d(10, "10:31:30"), "Bash", "h9", "ERROR", null, null, null, null, null],
    ["e10", "s1", d(10, "10:32:00"), "Bash", "h10", "ERROR", null, null, null, null, null],
    // Human-denied tool calls in s2 (no owner metadata; they only pair with denials).
    ["hd1", "s2", d(11, "09:00:00"), "Bash", "k1", null, null, null, null, "HUMAN_DENY", null],
    [
      "hd2",
      "s2",
      d(11, "09:10:00"),
      "AskUserQuestion",
      "k2",
      null,
      null,
      null,
      null,
      "HUMAN_DENY",
      null,
    ],
    ["hd3", "s2", d(11, "09:20:00"), "Write", "k3", null, null, null, null, "HUMAN_DENY", null],
  ]);
  ins("tool_event_metadata", [
    ["e1", null, "t1", 0],
    ["e2", null, "t2", 0],
    ["e3", null, "t3", 0],
    ["e4", null, "t3", 1],
    ["e5", null, "t4", 0],
    ["e6", null, "t4", 1],
    ["e7", null, "t4", 2],
    ["e8", null, "t4", 3],
    ["e9", null, "t4", 4],
    ["e10", null, "t4", 5],
  ]);
  ins("tool_event_content", [
    ["e1", JSON.stringify({ command: "git push", error: "Exit code 1\nremote rejected" })],
    ["e2", JSON.stringify({ command: "git push origin", error: "Exit code 1\nremote rejected" })],
    ["e3", JSON.stringify({ command: "git push -f", error: "Exit code 1\nRemote  Rejected" })],
    ["e4", JSON.stringify({ error: "File does not exist." })],
    ["e5", "{}"],
    ["e8", JSON.stringify({ command: "ls a", error: "Exit code 2\nno such file" })],
    ["e9", JSON.stringify({ command: "ls a", error: "Exit code 2\nno such file" })],
    ["e10", JSON.stringify({ command: "ls a", error: "Exit code 2\nno such file" })],
  ]);
  const m = (
    id: string,
    s: string,
    label: string | null,
    op: string | null,
    ts: string,
    side = 0,
  ) => [id, s, null, 0, 0, label, op, ts, side];
  ins("ingest_metric_events", [
    m("m1", "s2", "hook-block", null, d(11, "09:01:00")),
    m("m2", "s2", "deny-rule", null, d(11, "09:02:00")),
    m("m3", "s2", "user-rejected", null, d(11, "09:02:00")), // 2 min after hd1 -> 120000
    m("m4", "s2", "user-rejected", null, d(11, "09:11:00")), // AskUserQuestion -> excluded
    m("m5", "s2", "user-rejected", null, d(11, "10:05:00")), // 45 min after hd3 -> capped
    m("m6", "s3", "user-rejected", null, d(12, "08:30:00")), // no earlier HUMAN_DENY -> 0
    m("m7", "s2", "hook-block", null, d(11, "09:03:00"), 1), // sidechain -> excluded
    m("m8", "s3", null, "rm-rf", d(12, "08:10:00")),
    m("m9", "s3", null, "force-push", d(12, "08:11:00"), 1), // sidechain -> excluded
    m("m10", "s1", null, "git-reset-hard", d(10, "10:40:00")),
    m("m11", "s4", "hook-block", null, d(5, "12:00:00")), // previous window
    // card review F6: destructive calls in s3, each tied to its Bash row(s) by session + ts.
    m("n1", "s3", null, "sql-drop", d(12, "09:00:00")), // HUMAN_DENY -> never ran
    m("n2", "s3", null, "truncate", d(12, "09:01:00")), // user declined -> never ran
    m("n3", "s3", null, "git-clean", d(12, "09:02:00")), // guard hook blocked -> never ran
    m("n4", "s3", null, "rm-rf", d(12, "09:03:00")), // permission denied -> never ran
    m("p1", "s3", null, "sql-drop", d(12, "09:04:00")), // Bash row, no error -> kept
    m("p2", "s3", null, "git-clean", d(12, "09:05:00")), // no Bash row -> kept
    m("p3", "s3", null, "truncate", d(12, "09:06:00")), // two rows, one ran -> kept
    m("p4", "s3", null, "sql-drop", d(12, "09:07:00")), // two rows, none ran -> never ran
    m("p5", "s3", null, "force-push", d(12, "09:08:00")), // not a counted op
  ]);
  const bashAt = (id: string, hms: string, kind: string | null) => [
    id,
    "s3",
    d(12, hms),
    "Bash",
    `k${id}`,
    null,
    null,
    null,
    null,
    kind,
    null,
  ];
  ins("tool_events", [
    bashAt("b1", "09:00:00", "HUMAN_DENY"),
    bashAt("b2", "09:01:00", null),
    bashAt("b3", "09:02:00", null),
    bashAt("b4", "09:03:00", null),
    bashAt("b5", "09:04:00", null),
    bashAt("b6a", "09:06:00", "HUMAN_DENY"),
    bashAt("b6b", "09:06:00", null),
    bashAt("b7a", "09:07:00", "HUMAN_DENY"),
    bashAt("b7b", "09:07:00", null),
  ]);
  ins("tool_event_content", [
    ["b2", JSON.stringify({ error: "The user doesn't want to proceed with this tool use. x" })],
    ["b3", JSON.stringify({ error: "PreToolUse:guard hook error: blocked" })],
    ["b4", JSON.stringify({ error: "Permission to use Bash has been denied." })],
    ["b7b", JSON.stringify({ error: "PreToolUse:guard hook error: blocked" })],
  ]);
  const anchor = (s: string, ts: string) => ({ session_id: sid(s), timestamp: ts });
  const finding = (
    id: string,
    detector: string,
    ev: unknown,
    status: string,
    rule: string | null,
    template: string | null,
  ) => [id, "RULE", detector, "w1", JSON.stringify(ev), status, rule, template];
  ins("recommendations", [
    finding(
      "r1",
      "C6",
      {
        anchors: [
          anchor("s1", d(10, "10:00:00")),
          anchor("s1", d(10, "10:10:00")),
          anchor("s1", d(2, "00:00:00")),
        ],
      },
      "V2_VALIDATED",
      "C6_EDIT_FLIP_FLOP",
      null,
    ),
    finding(
      "r2",
      "B1",
      { anchors: [1, 2, 3, 4, 5].map((i) => anchor("s2", d(11, `0${i}:00:00`))) },
      "V2_VALIDATED",
      "B1_CACHE_READ_COLLAPSE",
      null,
    ),
    // V1 D8 names s3 and s2: s2 is also a B1 session, so the cause's union stays at 2.
    finding(
      "r3",
      "D8",
      { facts: { session_ids: ["s3", "s2"] } },
      "V1_VALIDATED",
      null,
      "D8_CACHE_WRITE_CHURN",
    ),
    finding(
      "r4",
      "D5",
      { anchors: [anchor("s4", d(11, "00:00:00"))] },
      "V2_VALIDATED",
      null,
      "D5_LIMIT_BURN_DEGRADED",
    ),
    finding(
      "r5",
      "D2",
      { anchors: [anchor("s2", d(11, "01:00:00")), anchor("s3", d(12, "01:00:00"))] },
      "V2_VALIDATED",
      null,
      "D2_LONG_FULL_CONTEXT",
    ),
    // D14's rule id is "D2": it must not land in CONTEXT_TOO_LARGE, nor be noted as unmapped.
    finding(
      "r6",
      "D14",
      { anchors: [anchor("s1", d(10, "01:00:00"))] },
      "V2_VALIDATED",
      "D2",
      null,
    ),
    finding("r7", "Z9", { anchors: [] }, "V2_VALIDATED", "Z9_UNKNOWN", null),
    // H1 comes from raw events: its finding is neither counted nor noted.
    finding("r8", "H1", { anchors: [] }, "V2_VALIDATED", "H1_DESTRUCTIVE_OPERATION_REPORT", null),
  ]);
  ins("detector_week_results", [["D8", "k", d(5, "00:00:00"), "w1", 1]]);

  const r = computeTriage(db, 7, d(15, "00:00:00"));
  const cause = (id: string) =>
    [...r.reliability.causes, r.reliability.risk, ...r.avoidable.causes].find(
      (c) => c.cause_id === id,
    );
  expect("spend", r.tiles.spend_u, 755);
  expect("sessions", r.tiles.session_count, 3);
  expect("friction sessions", r.tiles.friction_sessions, 3);
  expect("friction share", r.tiles.friction_share, 1);
  expect("shell bursts turns", cause("SHELL_FAILS_IN_BURSTS")?.occurrences, 3);
  expect("shell bursts sessions", cause("SHELL_FAILS_IN_BURSTS")?.sessions_affected, 1);
  expect("shell bursts share", cause("SHELL_FAILS_IN_BURSTS")?.share, 1 / 3);
  expect("search misses (outranked by C7)", cause("SEARCHES_FOR_MISSING_CONTENT")?.occurrences, 0);
  expect("tools fail (s1..s3)", cause("TOOLS_FAIL_MORE_THAN_USUAL")?.occurrences, 0);
  expect("repeats patterns", cause("AGENT_REPEATS_SAME_ERROR")?.patterns, [
    { code: "D7_RETRY_LOOP+C5", count: 4 },
  ]);
  expect("repeats sessions", cause("AGENT_REPEATS_SAME_ERROR")?.sessions_affected, 1);
  expect("blocked events", cause("BLOCKED_BY_PERMISSIONS")?.occurrences, 5);
  expect("blocked sessions", cause("BLOCKED_BY_PERMISSIONS")?.sessions_affected, 2);
  expect("blocked breakdown", cause("BLOCKED_BY_PERMISSIONS")?.breakdown, [
    { label: "deny-rule", count: 1 },
    { label: "hook-block", count: 1 },
    { label: "user-rejected", count: 3 },
  ]);
  registerFunctions(db);
  const waits = computeCore(db, r.window).c9Waits;
  const waitAt = (ts: string) => waits.filter((x) => x.event_ts === ts).map((x) => x.wait_ms);
  expect("wait: 2 min after a prior deny", waitAt(d(11, "09:02:00")), [120_000]);
  expect("wait: 45 min capped at 30 min", waitAt(d(11, "10:05:00")), [1_800_000]);
  expect("wait: no prior HUMAN_DENY", waitAt(d(12, "08:30:00")), [0]);
  expect("wait: AskUserQuestion rejection not counted", waitAt(d(11, "09:11:00")), []);
  expect("blocked wait total", cause("BLOCKED_BY_PERMISSIONS")?.cost?.wait_ms, 1_920_000);
  expect("blocked previous", cause("BLOCKED_BY_PERMISSIONS")?.previous.occurrences, 1);
  expect("blocked trend", cause("BLOCKED_BY_PERMISSIONS")?.trend, "steady");
  expect("edits patterns", cause("EDITS_FAIL_OR_UNDONE")?.patterns, [
    { code: "C3", count: 0 },
    { code: "C4", count: 0 },
    { code: "C6", count: 2 },
  ]);
  expect("edits sessions", cause("EDITS_FAIL_OR_UNDONE")?.sessions_affected, 1);
  expect("interrupts (D14 finding ignored)", cause("INTERRUPTED_OR_CANCELLED")?.occurrences, 0);
  {
    // RC-D14 Esc source: only a plain, main-chain, classifier-2 Esc in a reconciled session with no
    // prompt correction within two later turns counts. x1 claims a2 (stopped) and a3 (next). x7
    // follows a prompt with no turn after it, so it claims only the next turn, never the prior
    // prompt's answer (b3 is a2-like but before the prompt).
    const de = fixtureDb();
    insert(de, "sessions", [
      ["s1", "w1", "RECONCILED"],
      ["s2", "w1", "RECONCILED"],
      ["s3", "w1", "LIVE"],
      ["s4", "w1", "RECONCILED"],
    ]);
    insert(de, "turns", [
      ["a1", "s1", "w1", d(10, "10:00:00"), 0, 0, 1],
      ["a2", "s1", "w1", d(10, "10:05:00"), 0, 0, 1],
      ["a3", "s1", "w1", d(10, "10:10:00"), 0, 0, 1],
      ["a4", "s1", "w1", d(10, "10:15:00"), 0, 0, 1],
      ["b1", "s2", "w1", d(10, "10:00:00"), 0, 0, 1],
      ["b2", "s2", "w1", d(10, "10:05:00"), 0, 0, 1],
      ["c1", "s3", "w1", d(10, "10:00:00"), 0, 0, 1],
      ["c2", "s3", "w1", d(10, "10:05:00"), 0, 0, 1],
      ["b3", "s4", "w1", d(10, "10:00:00"), 0, 0, 1],
      ["b4", "s4", "w1", d(10, "10:05:00"), 0, 0, 1],
    ]);
    const esc = (
      id: string,
      s: string,
      label: string | null,
      ts: string,
      side = 0,
      v = "classifier-2",
    ) => [id, s, null, 0, 1, label, null, ts, side, v];
    const prompt = (id: string, s: string, ts: string) => [id, s, ts, 1, 0, null, null, ts, 0];
    insert(de, "ingest_metric_events", [
      esc("x1", "s1", "interrupt-cancel", d(10, "10:06:00")), // counted: a2 + a3
      esc("x2", "s1", null, d(10, "10:07:00")), // "for tool use" variant: no label
      esc("x3", "s1", "interrupt-cancel", d(10, "10:08:00"), 1), // sidechain
      esc("x4", "s1", "interrupt-cancel", d(10, "10:09:00"), 0, "classifier-1"), // old classifier
      esc("x5", "s2", "interrupt-cancel", d(10, "10:01:00")), // corrected by the next prompt
      prompt("u5", "s2", d(10, "10:02:00")),
      esc("x6", "s3", "interrupt-cancel", d(10, "10:01:00")), // session not reconciled
      prompt("u7", "s4", d(10, "10:01:00")),
      esc("x7", "s4", "interrupt-cancel", d(10, "10:02:00")), // counted: b4 only
    ]);
    const dr = computeTriage(de, 7, d(15, "00:00:00"));
    const io = dr.reliability.causes.find((c) => c.cause_id === "INTERRUPTED_OR_CANCELLED");
    expect("esc interrupts turns", io?.occurrences, 3);
    expect("esc interrupts sessions", io?.sessions_affected, 2);
  }
  // F6: 2 plain events + 3 kept (p1 sql-drop, p2 git-clean, p3 truncate); n1-n4 and p4 never ran.
  expect("risk events", cause("DESTRUCTIVE_COMMANDS_RAN")?.occurrences, 5);
  expect("risk sessions", cause("DESTRUCTIVE_COMMANDS_RAN")?.sessions_affected, 2);
  expect("risk breakdown", cause("DESTRUCTIVE_COMMANDS_RAN")?.breakdown, [
    { label: "git-clean", count: 1 },
    { label: "git-reset-hard", count: 1 },
    { label: "rm-rf", count: 1 },
    { label: "sql-drop", count: 1 },
    { label: "truncate", count: 1 },
  ]);
  expect("cache rebuilt patterns", cause("CACHE_REBUILT_MID_SESSION")?.patterns, [
    { code: "B1", count: 1 },
    { code: "B2", count: 0 },
    { code: "B3", count: 0 },
    { code: "B4", count: 0 },
    { code: "D8", count: 2 },
  ]);
  expect("cache rebuilt occurrences", cause("CACHE_REBUILT_MID_SESSION")?.occurrences, 3);
  expect(
    "cache rebuilt sessions (union)",
    cause("CACHE_REBUILT_MID_SESSION")?.sessions_affected,
    2,
  );
  expect(
    "cache rebuilt lower bound (B1 at anchor cap)",
    cause("CACHE_REBUILT_MID_SESSION")?.sessions_affected_is_lower_bound,
    true,
  );
  expect("context patterns", cause("CONTEXT_TOO_LARGE")?.patterns, [
    { code: "D2_LONG_FULL_CONTEXT", count: 2 },
  ]);
  expect("context sessions", cause("CONTEXT_TOO_LARGE")?.sessions_affected, 2);
  expect("D5 appears nowhere", JSON.stringify([r.reliability, r.avoidable]).includes("D5"), false);
  expect("notes", r.notes, ["UNMAPPED_FINDING:Z9/Z9_UNKNOWN"]);

  // Compare: planted mismatches are reported against their cause, matching tiles are not.
  const diffs = compareView(r, {
    tiles: { spend_u: 755, session_count: 3, friction_sessions: 3, friction_share: 1 },
    reliability: {
      causes: [
        { cause_id: "SHELL_FAILS_IN_BURSTS", occurrences: 4, patterns: [{ code: "C7", count: 4 }] },
        { cause_id: "NOT_A_CAUSE" },
      ],
    },
  });
  const has = (cause_id: string, field: string) =>
    diffs.filter((x) => x.cause_id === cause_id && x.field === field).length;
  expect("compare tiles", diffs.filter((x) => x.cause_id === "tiles").length, 0);
  expect("compare occurrences", has("SHELL_FAILS_IN_BURSTS", "occurrences"), 1);
  expect("compare pattern", has("SHELL_FAILS_IN_BURSTS", "patterns.C7"), 1);
  expect("compare only in view", has("NOT_A_CAUSE", "ONLY_IN_VIEW"), 1);
  expect("compare only in oracle", has("BLOCKED_BY_PERMISSIONS", "ONLY_IN_ORACLE"), 1);
  // RC-B U3: a cause with findings listed as silent is a diff; a listed silent cause isn't "only in oracle".
  const zero = [...r.reliability.causes, ...r.avoidable.causes].find((c) => c.occurrences === 0);
  const silentDiffs = compareView(r, {
    reliability: {
      causes: [],
      silent: [
        { cause_id: "SHELL_FAILS_IN_BURSTS" },
        ...(zero ? [{ cause_id: zero.cause_id }] : []),
      ],
    },
  });
  const sHas = (cause_id: string, field: string) =>
    silentDiffs.filter((x) => x.cause_id === cause_id && x.field === field).length;
  expect("silent: active cause flagged", sHas("SHELL_FAILS_IN_BURSTS", "silent"), 1);
  expect("silent: zero cause matches", zero ? sHas(zero.cause_id, "silent") : 0, 0);
  expect(
    "silent: zero cause not only-in-oracle",
    zero ? sHas(zero.cause_id, "ONLY_IN_ORACLE") : 0,
    0,
  );
  db.close();

  // Cause grouping: one session with a C1 turn and a D11 turn counts once, with 2 occurrences.
  // w2 has 50 Bash calls (3 shell-raised errors, split by OK calls so no loop) and 50 clean
  // PowerShell calls, so Bash is its worse shell (D11); one failing WebFetch is C1's outlier.
  const db2 = fixtureDb();
  insert(db2, "sessions", [["s5", "w2", "RECONCILED"]]);
  insert(db2, "turns", [
    ["p1", "s5", "w2", d(10, "12:00:00"), 0, 0, 1],
    ["b1", "s5", "w2", d(10, "13:00:00"), 0, 0, 1],
    ["f1", "s5", "w2", d(10, "14:00:00"), 0, 0, 1],
  ]);
  const at = (hms: string, sec: number) =>
    new Date(Date.parse(d(10, hms)) + sec * 1000).toISOString();
  const nulls = [null, null, null, null, null];
  for (let i = 0; i < 50; i++) {
    const bad = i === 10 || i === 20 || i === 30;
    insert(db2, "tool_events", [
      [`p${i}`, "s5", at("12:00:00", i + 1), "PowerShell", `ph${i}`, "OK", ...nulls],
      [`b${i}`, "s5", at("13:00:00", i + 1), "Bash", `bh${i}`, bad ? "ERROR" : "OK", ...nulls],
    ]);
    insert(db2, "tool_event_metadata", [
      [`p${i}`, null, "p1", i],
      [`b${i}`, null, "b1", i],
    ]);
    // Three different errors: three identical ones would be a C7 cluster (C7@rcb-2 counts rows
    // with no command family), which owns the turn before D11.
    if (bad)
      insert(db2, "tool_event_content", [
        [
          `b${i}`,
          JSON.stringify({
            command: `x${i}`,
            error: `Exit code 127\n${["foo", "bar", "baz"][i / 10 - 1]}: command not found`,
          }),
        ],
      ]);
  }
  // F4: exactly C1_MIN_TOOL_CALLS WebFetch calls, C1_MIN_TOOL_ERRORS failing in one turn (split by
  // OK calls so no loop): the minimum-calls and minimum-errors positive case.
  for (let i = 0; i < C1_MIN_TOOL_CALLS; i++) {
    insert(db2, "tool_events", [
      [
        `f${i}`,
        "s5",
        at("14:00:00", i + 1),
        "WebFetch",
        `fh${i}`,
        i % 5 === 0 && i < 5 * C1_MIN_TOOL_ERRORS ? "ERROR" : "OK",
        ...nulls,
      ],
    ]);
    insert(db2, "tool_event_metadata", [[`f${i}`, null, "f1", i]]);
  }
  const r2 = computeTriage(db2, 7, d(15, "00:00:00"));
  const tools = r2.reliability.causes.find((c) => c.cause_id === "TOOLS_FAIL_MORE_THAN_USUAL");
  expect("C1+D11 patterns", tools?.patterns, [
    { code: "C1", count: 1 },
    { code: "D11", count: 1 },
    { code: "G11", count: 0 },
  ]);
  expect("C1+D11 occurrences", tools?.occurrences, 2);
  expect("C1+D11 sessions (distinct union)", tools?.sessions_affected, 1);
  expect("C1+D11 friction sessions", r2.tiles.friction_sessions, 1);
  db2.close();

  // card review F4 (2026-10-04): benign guard/CDP errors, and the minimum-calls rule (negatives).
  const hookErr = "PreToolUse:guard hook error: blocked";
  const cdpErr = 'CDP sendCommand "Page.navigate" timed out after 30000ms';
  expect("benign: guard-hook block", benign(null, hookErr, "Bash"), true);
  expect("benign: CDP stall", benign(null, cdpErr, "WebFetch"), true);
  expect("not benign: hook text mid-error", benign(null, `Exit code 1\n${hookErr}`, "Zed"), false);
  expect(
    "not benign: CDP empty command",
    benign(null, 'CDP sendCommand "" timed out after 5ms', "Zed"),
    false,
  );
  const db3 = fixtureDb();
  insert(db3, "sessions", [["s7", "w3", "RECONCILED"]]);
  insert(db3, "turns", [
    ["a1", "s7", "w3", d(10, "12:00:00"), 0, 0, 1],
    ["a2", "s7", "w3", d(10, "13:00:00"), 0, 0, 1],
    ["a3", "s7", "w3", d(10, "14:00:00"), 0, 0, 1],
  ]);
  // Alpha: 20 calls, 2 fail with benign text (not bad). Beta: 19 calls, 1 real failure (below the
  // minimum, so never an outlier). Zed: 60 clean calls keep the corpus rate low.
  const spec: Array<[string, string, number, number]> = [
    ["Alpha", "a1", 20, 12],
    ["Beta", "a2", 19, 13],
    ["Zed", "a3", 60, 14],
  ];
  for (const [tool, turn, n, hour] of spec) {
    for (let i = 0; i < n; i++) {
      const bad = (tool === "Alpha" && i < 2) || (tool === "Beta" && i === 0);
      const id = `${tool}${i}`;
      insert(db3, "tool_events", [
        [id, "s7", at(`${hour}:00:00`, i + 1), tool, `${id}h`, bad ? "ERROR" : "OK", ...nulls],
      ]);
      insert(db3, "tool_event_metadata", [[id, null, turn, i]]);
      if (bad)
        insert(db3, "tool_event_content", [
          [id, JSON.stringify({ error: tool === "Beta" ? "boom" : i === 0 ? hookErr : cdpErr })],
        ]);
    }
  }
  const r3 = computeTriage(db3, 7, d(15, "00:00:00"));
  expect(
    "C1 min calls + benign: no outliers",
    r3.reliability.causes.find((c) => c.cause_id === "TOOLS_FAIL_MORE_THAN_USUAL")?.occurrences,
    0,
  );
  db3.close();

  // card review F7 (2026-10-04): sequence boundaries in the D7 loop pool.
  const seq = (specs: Array<[string, string | null, string | null]>): LoopRow[] =>
    specs.map(([tool_name, exit_class, err], i) => ({
      event_id: `l${i}`,
      session_id: "sx",
      ts: d(10, `10:00:${String(i).padStart(2, "0")}`),
      tool_name,
      key: "same",
      exit_class,
      fp: null,
      tk: `tk${i}`,
      err,
    }));
  const rep = (n: number, tool: string, exit: string | null, err: string | null = null) =>
    Array.from({ length: n }, () => [tool, exit, err] as [string, string | null, string | null]);
  const ok = "mcp__claude-in-chrome__computer";
  expect("D7: successful browser calls are boundaries", loopPool(seq(rep(5, ok, "OK"))).length, 0);
  expect("D7: failing browser calls still loop", loopPool(seq(rep(5, ok, "ERROR"))).length, 4);
  expect("D7: poll tool is a boundary", loopPool(seq(rep(5, "Monitor", "OK"))).length, 0);
  expect("D7: non-poll identical calls loop", loopPool(seq(rep(5, "Grep", "OK"))).length, 4);
  const reads = (mid: string): LoopRow[] =>
    seq([
      ["Read", "OK", null],
      [mid, "OK", null],
      ["Read", "OK", null],
      [mid, "OK", null],
      ["Read", "OK", null],
    ]).map((r) => (r.tool_name === "Read" ? { ...r, fp: "p1" } : { ...r, key: "other" }));
  expect("D7: browser call splits redundant reads", loopPool(reads(ok)).length, 0);
  expect("D7: non-boundary call keeps redundant reads", loopPool(reads("Bash")).length, 2);
  // x, blocked x, x, x, x: the blocked call splits the run into 1 + 3, so only 2 are excess.
  expect(
    "D7: guard-blocked call is a boundary",
    loopPool(seq([["Bash", "OK", null], ["Bash", "ERROR", hookErr], ...rep(3, "Bash", "OK")]))
      .length,
    2,
  );
  // re-review N2: same-region reads whose size changes are new content, not repeats.
  const sized = (sizes: number[]): LoopRow[] =>
    seq(sizes.map(() => ["Read", "OK", null] as [string, string | null, string | null])).map(
      (r, i) => ({ ...r, fp: "p1", rb: sizes[i] ?? null }),
    );
  expect("D7: reads with changing sizes are no loop", loopPool(sized([1, 2, 3, 4, 5])).length, 0);
  expect("D7: same-size reads still loop", loopPool(sized([7, 7, 7])).length, 2);
  expect("D7: size change splits a read group", loopPool(sized([7, 7, 9, 9, 9])).length, 2);

  ledgerSelfCheck(expect);
  return fails;
}

/** Ledger fixture: as-of 2026-01-15T12:00Z, so E = 2026-01-15T00:00Z and the 7d window is Jan 8..14. */
function ledgerSelfCheck(expect: (what: string, got: unknown, want: unknown) => void): void {
  const asOf = "2026-01-15T12:00:00.000Z";
  const build = (marked: boolean) => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE turns (session_id TEXT, ts TEXT, cost_equiv_u INTEGER);
      CREATE TABLE ledger_daily (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT,
        rec_id TEXT, component TEXT, value_u REAL);
      CREATE TABLE ledger_daily_sessions (block_start TEXT, day TEXT, lane TEXT, detector_id TEXT,
        session_id TEXT, value_u REAL);
      CREATE TABLE ledger_daily_marks (block_start TEXT, block_end TEXT);`);
    const cur = "2026-01-08T00:00:00.000Z";
    const prv = "2026-01-01T00:00:00.000Z";
    insert(db, "turns", [
      ["sA", "2026-01-10T10:00:00.000Z", 5000],
      ["sB", "2026-01-12T10:00:00.000Z", 3000],
      ["sA", "2026-01-03T10:00:00.000Z", 700], // previous window
      ["sA", "2026-01-15T06:00:00.000Z", 90000], // between E and as-of: not in the denominator
      ["sA", "2025-12-30T10:00:00.000Z", 1], // earliest turn: E-2w has history
    ]);
    insert(db, "ledger_daily", [
      // CONTEXT_TOO_LARGE: D2 only, one rec. 1000.4 + 500.4 = 1500.8 -> 1501.
      [cur, "2026-01-10", "spend", "D2", "recA", "cache_read", 1000.4],
      [cur, "2026-01-12", "spend", "D2", "recA", "cache_read", 500.4],
      [prv, "2026-01-03", "spend", "D2", "recA", "cache_read", 50], // previous window: excluded
      [cur, "2026-01-11", "reliability", "D2", "", "output", 777], // reliability lane: excluded
      // CACHE_REBUILT_MID_SESSION: B1 + B3 (B2, B4 have no producer -> PARTIAL), two recs.
      [cur, "2026-01-09", "spend", "B1", "recB1", "cache_write", 200.4],
      [cur, "2026-01-13", "spend", "B3", "recB3", "cache_write", 100.4],
    ]);
    insert(db, "ledger_daily_sessions", [
      [cur, "2026-01-10", "spend", "D2", "sA", 1000.4],
      [cur, "2026-01-12", "spend", "D2", "sB", 500.4],
      [cur, "2026-01-12", "spend", "D2", "sA", 0.1],
      [cur, "2026-01-09", "spend", "B1", "sA", 200.4],
      [cur, "2026-01-13", "spend", "B3", "sC", 100.4],
    ]);
    if (marked) {
      insert(db, "ledger_daily_marks", [
        [cur, "2026-01-15T00:00:00.000Z"],
        [prv, cur],
      ]);
    } else insert(db, "ledger_daily_marks", [[cur, "2026-01-15T00:00:00.000Z"]]); // older block unmarked
    return db;
  };

  const db = build(true);
  const o = computeLedger(db, 7, asOf);
  expect("ledger complete", o?.complete, true);
  expect("ledger spend over [E-w, E)", o?.spend_u, 8000);
  expect("ledger spend over [E-2w, E-w)", o?.prev_spend_u, 700);
  expect("ledger history", o?.has_history, true);
  expect(
    "ledger prev sums",
    o?.causes.slice(0, 2).map((c) => c.prev_avoidable_u),
    [50, 0],
  );
  expect("ledger tile", o?.tile_u, 1802);
  expect(
    "ledger causes",
    o?.causes.map((c) => [
      c.cause_id,
      c.avoidable_u,
      c.coverage,
      c.sessions_affected,
      c.single_rec_u,
    ]),
    [
      ["CONTEXT_TOO_LARGE", 1501, "ALL", 2, 1501],
      ["CACHE_REBUILT_MID_SESSION", 301, "PARTIAL", 2, null],
      ["TOOL_RESULTS_TOO_LARGE", 0, "PARTIAL", 0, null],
      ["ALWAYS_LOADED_TOO_BIG", 0, "ALL", 0, null],
      ["MODEL_BIGGER_THAN_NEEDED", 0, "PARTIAL", 0, null], // E2 has no ledger producer
      ["SAME_FILES_REREAD_ACROSS_SESSIONS", 0, "ALL", 0, null],
    ],
  );
  expect("ledger producerless", o?.producerless.includes("SUBAGENTS_COST_MORE_THAN_RETURN"), true);
  if (!o) return;

  const good = () => ({
    tiles: { avoidable_u: 1802, avoidable_share: 1802 / 8000 },
    avoidable: {
      causes: [
        {
          cause_id: "CONTEXT_TOO_LARGE",
          avoidable_u: 1501,
          coverage: "ALL",
          sessions_affected: 2,
          sessions_affected_is_lower_bound: false,
          share: 1501 / 8000,
          trend: "rising", // 1501/8000 vs 50/700: x2.6, both windows past the occurrence floor
          trend_basis: "spend_share",
        },
        {
          cause_id: "CACHE_REBUILT_MID_SESSION",
          avoidable_u: 301,
          coverage: "PARTIAL",
          sessions_affected: 2,
          sessions_affected_is_lower_bound: false,
          share: 301 / 8000,
          trend: "steady", // previous ledger figure is 0, so no ratio
          trend_basis: "spend_share",
        },
        { cause_id: "SUBAGENTS_COST_MORE_THAN_RETURN", avoidable_u: null, coverage: null },
        // SAME_FILES_REREAD_ACROSS_SESSIONS (D7, 0 value) is legitimately absent.
      ],
    },
  });
  // Occurrence counts of the base oracle (window / previous window) that feed the trend floor.
  const occs = (cur: number, prev: number) =>
    ({
      avoidable: {
        causes: ["CONTEXT_TOO_LARGE", "CACHE_REBUILT_MID_SESSION"].map((cause_id) => ({
          cause_id,
          occurrences: cur,
          previous: { occurrences: prev, rate: null },
        })),
      },
    }) as unknown as OracleReport;
  const stub = occs(6, 6);
  const count = (o2: LedgerReport, v: unknown, cause_id?: string, field?: string, b = stub) =>
    compareLedger(o2, v, b).filter(
      (x) =>
        (cause_id === undefined || x.cause_id === cause_id) &&
        (field === undefined || x.field.startsWith(field)),
    ).length;
  expect("ledger correct view passes", compareLedger(o, good(), stub), []);

  const badTrend = good();
  const trendRow = badTrend.avoidable.causes[0];
  if (trendRow) trendRow.trend = "steady"; // a session-rate style answer on a $-share row
  expect("ledger wrong trend fails", count(o, badTrend, "CONTEXT_TOO_LARGE", "trend ("), 1);
  expect(
    "ledger trend under the occurrence floor is steady",
    count(o, good(), "CONTEXT_TOO_LARGE", "trend (", occs(6, 4)),
    1,
  );
  const badBasis = good();
  const basisRow = badBasis.avoidable.causes[0];
  if (basisRow) basisRow.trend_basis = "session_rate";
  expect(
    "ledger wrong trend basis fails",
    count(o, badBasis, "CONTEXT_TOO_LARGE", "trend_basis"),
    1,
  );

  const off = good();
  const ctx = off.avoidable.causes[0];
  if (ctx) ctx.avoidable_u = 1502; // off by 1 micro-dollar
  expect("ledger cause off by 1 fails", count(o, off, "CONTEXT_TOO_LARGE", "avoidable_u"), 1);
  expect("ledger cause off by 1 fails AE4", count(o, off, "CONTEXT_TOO_LARGE", "ae4"), 1);
  expect("ledger cause off by 1 breaks tile sum", count(o, off, "tiles", "avoidable_u = sum"), 1);

  const badTile = good();
  badTile.tiles.avoidable_u = 1803;
  expect("ledger tile != sum of causes fails", count(o, badTile, "tiles", "avoidable_u = sum"), 1);

  const badShare = good();
  badShare.tiles.avoidable_share = 1802 / 98000; // spend over [as_of - w, as_of) instead
  expect("ledger wrong share denominator fails", count(o, badShare, "tiles", "avoidable_share"), 1);

  const badRowShare = good();
  const rowShare = badRowShare.avoidable.causes[0];
  if (rowShare) rowShare.share = 1501 / 98000; // row share on the wrong denominator
  expect("ledger wrong row share fails", count(o, badRowShare, "CONTEXT_TOO_LARGE", "share"), 1);

  const overSpend = good();
  overSpend.tiles.avoidable_u = 8001;
  expect("ledger tile above spend fails", count(o, overSpend, "tiles", "avoidable_u <="), 1);

  const badCov = good();
  const cov = badCov.avoidable.causes[1];
  if (cov) cov.coverage = "ALL";
  expect("ledger coverage fails", count(o, badCov, "CACHE_REBUILT_MID_SESSION", "coverage"), 1);

  const badSessions = good();
  const ses = badSessions.avoidable.causes[0];
  if (ses) ses.sessions_affected = 3;
  expect(
    "ledger sessions fails",
    count(o, badSessions, "CONTEXT_TOO_LARGE", "sessions_affected"),
    1,
  );

  const missing = good();
  missing.avoidable.causes.splice(1, 1); // a non-zero cause may not be absent
  expect("ledger missing non-zero row fails", count(o, missing, "CACHE_REBUILT_MID_SESSION"), 1);

  const guessed = good();
  const sub = guessed.avoidable.causes[2];
  if (sub) sub.avoidable_u = 0 as unknown as null; // a producer-less cause stays null, never 0
  expect(
    "ledger producer-less cause must be null",
    count(o, guessed, "SUBAGENTS_COST_MORE_THAN_RETURN"),
    1,
  );
  db.close();

  // Incomplete marks: the older block is unmarked, so every figure must be null.
  const dbInc = build(false);
  const oi = computeLedger(dbInc, 7, asOf);
  expect("ledger incomplete", oi?.complete, false);
  if (oi) {
    const allNull = {
      tiles: { avoidable_u: null, avoidable_share: null },
      avoidable: {
        causes: [
          { cause_id: "CONTEXT_TOO_LARGE", avoidable_u: null },
          { cause_id: "CACHE_REBUILT_MID_SESSION", avoidable_u: null },
        ],
      },
    };
    expect("ledger incomplete: nulls pass", compareLedger(oi, allNull), []);
    expect("ledger incomplete: figures fail", count(oi, good()), 3);
  }
  dbInc.close();

  // Zero spend: share must be null.
  const dbZ = build(true);
  dbZ.prepare("DELETE FROM turns").run();
  const oz = computeLedger(dbZ, 7, asOf);
  if (oz) {
    const z = good();
    z.tiles.avoidable_share = 0.5;
    expect("ledger zero spend: share must be null", count(oz, z, "tiles", "avoidable_share"), 1);
    expect(
      "ledger zero spend tile above spend fails",
      count(oz, good(), "tiles", "avoidable_u <="),
      1,
    );
  }
  dbZ.close();

  // Ledger spend exists, but [as_of-w, as_of) has none: the view nulls every share.
  const dbW = build(true);
  dbW.prepare("DELETE FROM turns").run();
  insert(dbW, "turns", [["sA", "2026-01-08T06:00:00.000Z", 5000]]); // in [E-w, E), before as_of-w
  const ow = computeLedger(dbW, 7, asOf);
  expect("ledger quiet window: spend", [ow?.spend_u, ow?.window_spend_u], [5000, 0]);
  if (ow) {
    const shareDiffs = (v: unknown) =>
      compareLedger(ow, v, stub).filter(
        (x) => x.field.includes("share (") || x.field.includes("_share"),
      );
    const q = good();
    q.tiles.avoidable_share = null as unknown as number;
    for (const r of q.avoidable.causes) if ("share" in r) r.share = null as unknown as number;
    expect("ledger quiet window: null shares pass", shareDiffs(q), []);
    expect("ledger quiet window: numeric shares fail", shareDiffs(good()).length, 3);
  }
  dbW.close();

  // A view row with a $ figure but no ledger report is a diff, and its own checks still run.
  const baseCtx = {
    cause_id: "CONTEXT_TOO_LARGE",
    occurrences: 0,
    patterns: [],
    sessions_affected: 2,
    sessions_affected_is_lower_bound: false,
    share: null,
    trend: "steady",
    previous: { occurrences: 0, rate: null },
  };
  const rep = {
    tiles: { spend_u: 0, session_count: 0, friction_sessions: 0, friction_share: null },
    reliability: { causes: [], risk: { ...baseCtx, cause_id: "DESTRUCTIVE_COMMANDS_RAN" } },
    avoidable: { causes: [baseCtx] },
  } as unknown as OracleReport;
  const viewRow = { cause_id: "CONTEXT_TOO_LARGE", avoidable_u: 5, sessions_affected: 9 };
  const noLedger = compareView(rep, { avoidable: { causes: [viewRow] } }, null);
  const hasField = (ds: Diff[], f: string) => ds.filter((x) => x.field === f).length;
  expect(
    "no ledger report: $ figure is a diff",
    hasField(noLedger, "avoidable_u (no ledger report)"),
    1,
  );
  expect("no ledger report: sessions still checked", hasField(noLedger, "sessions_affected"), 1);
  const withLedger = compareView(rep, { avoidable: { causes: [viewRow] } }, o);
  expect(
    "ledger report: row checks come from the ledger",
    hasField(withLedger, "sessions_affected"),
    0,
  );
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export function runCli(argv: string[]): number {
  const args = new Map<string, string>();
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-check") check = true;
    else if (a?.startsWith("--") && argv[i + 1] !== undefined) args.set(a, argv[++i] ?? "");
    else return 2;
  }
  if (check) {
    const fails = selfCheck();
    for (const f of fails) console.error(`self-check FAIL ${f}`);
    console.log(`self-check: ${fails.length === 0 ? "PASS" : `${fails.length} mismatch(es)`}`);
    if (fails.length > 0 || !args.has("--db")) return fails.length > 0 ? 1 : 0;
  }
  const dbPath = args.get("--db");
  const win = args.get("--window");
  const windows = win === undefined ? [7, 14, 30] : [Number(win)];
  if (!dbPath || windows.some((n) => ![7, 14, 30].includes(n))) return 2;
  const compare = args.get("--compare");
  if (compare !== undefined && windows.length !== 1) return 2;
  const asOf = args.get("--as-of") ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) return 2;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let code = 0;
    for (const n of windows) {
      const report = computeTriage(db, n, asOf);
      console.log(JSON.stringify(report, null, 2));
      if (compare !== undefined) {
        const viewJson = JSON.parse(readFileSync(compare, "utf8"));
        const ledger = computeLedger(db, n, asOf);
        const diffs = [
          ...compareView(report, viewJson, ledger),
          ...(ledger === null ? [] : compareLedger(ledger, viewJson, report)),
        ];
        console.log(
          JSON.stringify(
            { compare: diffs.length === 0 ? "MATCH" : "DIFF", ledger, diffs },
            null,
            2,
          ),
        );
        if (diffs.length > 0) code = 1;
      }
    }
    return code;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `diagnostics triage oracle: ${error instanceof Error ? error.message.split("\n")[0] : "failed"}`,
    );
    process.exitCode = 1;
  }
}
