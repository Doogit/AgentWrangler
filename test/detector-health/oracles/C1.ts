/**
 * C1 TOOL_ERROR_RATE_V2 reliability oracle. Written ONLY from the dh-contracts.md C1 card, Appendix S0/S2/S3.
 * No imports from src/**.
 * Headline = reliability $/wk upper bound: FULL snapshot-priced cost of each issuing ERROR call's RECOVERY turn
 * (first settled main-chain turn of the same session after the issuing turn), one owner per recovery turn
 * (most issuing events, tie lowest rec id), summed per tool and rounded once. Main chain only (the subagent
 * "+ $X in subagents" figure is not graded).
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

/** Card tie-break id: rec-C1-global- + first 16 hex of sha1("C1|<full tool name>"), compared with plain `<`. */
const recId = (tool: string): string =>
  `rec-C1-global-${createHash("sha1").update(`C1|${tool}`).digest("hex").slice(0, 16)}`;

const MIN_CALLS = 20;
const MIN_ERRORS = 3;
const MULTIPLIER = 2;
const D11_MIN_CALLS = 50;
const D11_MIN_ERRORS = 3;
const D11_RATE_RATIO = 1.5;

// Appendix S3 rules (verbatim).
const CHECK_COMMAND =
  /\b(?:vitest|jest|mocha|pytest|tsc|biome|eslint|prettier|ruff|mypy)\b|\bnpm\s+(?:test|run\s+(?:-s\s+)?(?:test|lint|typecheck|build|check|verify)\b)|\b(?:cargo|go|dotnet)\s+(?:test|build|check|clippy|vet)\b/i;
const FAILED_STEP = /\bfailed\b|timed out|Couldn't|Can't|\bError\b|not in Claude's tab group/i;
const STEP_LINE = /^\[[^\]\n]+\] /m;
const FAILED_STEP_LINE = /^actions\[\d+\] \([^)\n]*\) failed:.*$/m;
const SEARCH_MISS = /does not appear anywhere|There is no .* visible|does not contain any\b/i;
const TOOL_FAILURE = /^\s*(?:Can't|Couldn't|Cannot|Failed|Error)\b/i;
const HOOK_BLOCK = /^PreToolUse:\S+ hook error\b/;
const CDP_TIMEOUT =
  /\bCDP sendCommand "[^"\n]+" timed out after \d+ms|^The "[^"\n]+" tool did not respond in time\b/;
const USER_REJECT = /^The user doesn't want to (?:proceed with this tool use|take this action)/;
const ARTIFACT_GUARD = /^(?:Nothing was published or removed:|conflict: nothing was published)/;
const NOT_READ_ERROR = /^(?:<tool_use_error>)?(?:File |The file ).*\bhas not been read\b/i;
const NOT_FOUND_ERROR =
  /^(?:<tool_use_error>)?(?:File|Path|Directory|Pattern|No files?).*(?:not found|does not exist)\b/i;
const EXIT_GT0 = /^Exit code [1-9]\d*\b/;
const EXIT_128 = /^Exit code 128\b/;
const TASKKILL = /\btaskkill\b/i;
const EXIT_1 = /^Exit code 1\b/;
const GIT_DIFF_QUIET = /\bgit\b[^;&|\n]*\bdiff\b[^;&|\n]*--(quiet|exit-code)\b/;
const NETTCP = /\bGet-NetTCPConnection\b/i;
const SHELL_FAILURE =
  /unexpected EOF while looking for matching|syntax error near unexpected token|syntax error: unexpected end of file|: command not found|bad substitution|is not recognized as the name of a cmdlet|^ParserError:|CategoryInfo\s*:\s*ParserError|Unexpected token .* in expression or statement|The string is missing the terminator|is not a valid statement separator|An empty pipe element is not allowed|Missing expression after/im;
const EXIT_PREFIX = /^Exit code \d+/;

function isBrowserAnswer(tool: string, error: string | null): boolean {
  if (error === null || !tool.startsWith("mcp__claude-in-chrome__")) return false;
  if (tool === "mcp__claude-in-chrome__browser_batch") {
    if (FAILED_STEP_LINE.test(error)) return false;
    return STEP_LINE.test(error) || !FAILED_STEP.test(error);
  }
  if (tool === "mcp__claude-in-chrome__find")
    return SEARCH_MISS.test(error) && !TOOL_FAILURE.test(error);
  return false;
}

function isBenignFailure(command: string | null, error: string | null, tool: string): boolean {
  if (isBrowserAnswer(tool, error)) return true;
  if (error !== null) {
    if (HOOK_BLOCK.test(error)) return true;
    if (CDP_TIMEOUT.test(error)) return true;
    if (USER_REJECT.test(error)) return true;
    if ((tool === "Edit" || tool === "Write") && NOT_READ_ERROR.test(error)) return true;
    if (tool === "Artifact" && ARTIFACT_GUARD.test(error)) return true;
  }
  if (command === null || error === null) return false;
  if (EXIT_GT0.test(error) && CHECK_COMMAND.test(command)) return true;
  if (EXIT_128.test(error) && TASKKILL.test(command)) return true;
  if (EXIT_1.test(error) && GIT_DIFF_QUIET.test(command)) return true;
  if (error.trim() === "Exit code 1" && NETTCP.test(command)) return true;
  return false;
}

type Outcome = "OK" | "ERROR" | null;

function d11Outcome(error: string | null, exitClass: string | null): Outcome {
  if (error !== null && !EXIT_PREFIX.test(error)) return null;
  return exitClass === "ERROR" && error !== null && SHELL_FAILURE.test(error) ? "ERROR" : "OK";
}

function c1Outcome(
  tool: string,
  exitClass: string | null,
  command: string | null,
  error: string | null,
): Outcome {
  if (tool === "Bash" || tool === "PowerShell") return d11Outcome(error, exitClass);
  if (error !== null && HOOK_BLOCK.test(error)) return null;
  if (
    (tool === "Read" || tool === "Grep" || tool === "Glob") &&
    error !== null &&
    NOT_FOUND_ERROR.test(error)
  )
    return "OK";
  return (exitClass === "ERROR" || exitClass === "TEST_FAIL") &&
    !isBenignFailure(command, error, tool)
    ? "ERROR"
    : "OK";
}

interface Ev {
  tool: string;
  ws: string;
  session: string;
  owner: string;
  ownerTs: string;
  outcome: Outcome;
}

function snapshotPrice(row: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  unit_prices_json: string | null;
}): number {
  if (!row.unit_prices_json) return 0;
  let p: unknown;
  try {
    p = JSON.parse(row.unit_prices_json);
  } catch {
    return 0;
  }
  if (!Array.isArray(p) || p.length < 5) return 0;
  const pr = p.slice(0, 5) as number[];
  if (!pr.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) return 0;
  const toks = [
    row.input_tokens,
    row.output_tokens,
    row.cache_read_tokens,
    row.cache_write_5m,
    row.cache_write_1h,
  ];
  let sum = 0;
  for (let i = 0; i < 5; i++)
    if ((toks[i] as number) > 0) sum += (toks[i] as number) * (pr[i] as number);
  return sum;
}

export const oracleC1: Oracle = (db: Database.Database, now: Date) => {
  const startIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.tool_name tool, e.exit_class xc, e.session_id session, t.workspace_id ws,
              m.owner_message_id owner, t.ts owner_ts,
              json_extract(c.content_json, '$.error') err, json_extract(c.content_json, '$.command') cmd
       FROM tool_events e
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       JOIN sessions s ON s.session_id = e.session_id
       LEFT JOIN tool_event_content c ON c.event_id = e.event_id
       WHERE e.ts >= ? AND e.ts < ? AND s.state = 'RECONCILED'
         AND t.is_sidechain = 0 AND t.provisional = 0`,
    )
    .all(startIso, nowIso) as Array<{
    tool: string;
    xc: string | null;
    session: string;
    ws: string;
    owner: string;
    owner_ts: string;
    err: unknown;
    cmd: unknown;
  }>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

  // D11 per-workspace worse-shell exclusion (only when both shells have >= 50 classified calls).
  const shell = new Map<string, { calls: number; errors: number }>();
  const evs: Array<Ev & { d11: Outcome }> = [];
  for (const r of rows) {
    const error = str(r.err);
    const command = str(r.cmd);
    const isShell = r.tool === "Bash" || r.tool === "PowerShell";
    const outcome = c1Outcome(r.tool, r.xc, command, error);
    if (isShell) {
      const d = d11Outcome(error, r.xc);
      if (d !== null) {
        const k = `${r.ws}|${r.tool}`;
        const s = shell.get(k) ?? { calls: 0, errors: 0 };
        s.calls++;
        if (d === "ERROR") s.errors++;
        shell.set(k, s);
      }
    }
    evs.push({
      tool: r.tool,
      ws: r.ws,
      session: r.session,
      owner: r.owner,
      ownerTs: r.owner_ts,
      outcome,
      d11: null,
    });
  }
  const excludedShell = new Set<string>();
  const wsList = new Set(rows.map((r) => r.ws));
  for (const ws of wsList) {
    const b = shell.get(`${ws}|Bash`);
    const p = shell.get(`${ws}|PowerShell`);
    if (!b || !p || b.calls < D11_MIN_CALLS || p.calls < D11_MIN_CALLS) continue;
    const rb = b.errors / b.calls;
    const rp = p.errors / p.calls;
    const worse = (x: { errors: number }, rx: number, ry: number) =>
      x.errors >= D11_MIN_ERRORS && (ry === 0 ? rx > 0 : rx >= D11_RATE_RATIO * ry);
    if (worse(b, rb, rp)) excludedShell.add(`${ws}|Bash`);
    else if (worse(p, rp, rb)) excludedShell.add(`${ws}|PowerShell`);
  }

  // Corpus and per-tool counts.
  let corpusCalls = 0;
  let corpusErrors = 0;
  const byTool = new Map<string, { calls: number; errors: number; issuing: Ev[] }>();
  for (const e of evs) {
    if (e.outcome === null) continue;
    if (excludedShell.has(`${e.ws}|${e.tool}`)) continue;
    corpusCalls++;
    const t = byTool.get(e.tool) ?? { calls: 0, errors: 0, issuing: [] };
    t.calls++;
    if (e.outcome === "ERROR") {
      corpusErrors++;
      t.errors++;
      t.issuing.push(e);
    }
    byTool.set(e.tool, t);
  }
  const firing: string[] = [];
  if (corpusErrors > 0 && corpusCalls > 0) {
    for (const [tool, t] of byTool) {
      // rate > 2 x corpus rate, kept in integer cross-multiplied form.
      if (
        t.calls >= MIN_CALLS &&
        t.errors >= MIN_ERRORS &&
        t.errors * corpusCalls > MULTIPLIER * corpusErrors * t.calls
      )
        firing.push(tool);
    }
  }

  // Recovery turns and ownership.
  const recoveryStmt = db.prepare(
    `SELECT message_id, ts FROM turns
     WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts > ?
     ORDER BY ts, message_id LIMIT 1`,
  );
  const recFor = new Map<string, string | null>();
  const behind = new Map<string, Map<string, number>>();
  const checked = new Set<string>();
  for (const tool of firing) {
    for (const e of byTool.get(tool)?.issuing ?? []) {
      checked.add(e.owner);
      const key = `${e.session}|${e.owner}`;
      if (!recFor.has(key)) {
        const r = recoveryStmt.get(e.session, e.ownerTs) as
          | { message_id: string; ts: string }
          | undefined;
        recFor.set(key, r && r.ts >= startIso && r.ts < nowIso ? r.message_id : null);
      }
      const rid = recFor.get(key);
      if (!rid) continue;
      const m = behind.get(rid) ?? new Map<string, number>();
      m.set(tool, (m.get(tool) ?? 0) + 1);
      behind.set(rid, m);
    }
  }
  const owned = new Map<string, string[]>();
  for (const [rid, m] of behind) {
    let best: string | null = null;
    let bestId = "";
    let bestN = -1;
    for (const [tool, n] of m) {
      const id = recId(tool);
      if (n > bestN || (n === bestN && id < bestId)) {
        best = tool;
        bestId = id;
        bestN = n;
      }
    }
    if (best) owned.set(best, [...(owned.get(best) ?? []), rid]);
    checked.add(rid);
  }

  const priceStmt = db.prepare(
    `SELECT t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h,
            p.unit_prices_json
     FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
     WHERE t.message_id = ?`,
  );
  const findings: OracleFinding[] = [];
  for (const tool of firing.sort()) {
    const t = byTool.get(tool) as { calls: number; errors: number };
    let sum = 0;
    const rids = owned.get(tool) ?? [];
    for (const rid of rids) {
      const row = priceStmt.get(rid) as Parameters<typeof snapshotPrice>[0] | undefined;
      if (row) sum += snapshotPrice(row);
    }
    const v = Math.round(sum);
    findings.push({
      scope: { workspace_id: null, key: `C1|${tool}` },
      quantities: [
        { name: "tool_calls", unit: "count", value: t.calls },
        { name: "tool_errors", unit: "count", value: t.errors },
        { name: "corpus_calls", unit: "count", value: corpusCalls },
        { name: "corpus_errors", unit: "count", value: corpusErrors },
        { name: "recovery_turns", unit: "turns", value: rids.length },
      ],
      measured_u: v,
      assumptions: [
        {
          name: "no cross-family ownership cut (0 measured live); D7 repeat-excess pre-exclusion not replayed",
          value: 0,
          source: "dh-contracts.md Appendix S0 item 7 and S2; reviewer f9bdb7b3",
        },
        {
          name: "D11 counts = main-chain calls with a non-null d11Outcome, per workspace and shell",
          value: 0,
          source: "dh-contracts.md C1 card D11_MIN_CALLS",
        },
        {
          name: "wasted-turn avoidance fraction not applied to the reliability headline",
          value: 0.5,
          source: "dh-contracts.md C1 card, Appendix S0 item 6",
        },
      ],
      modeled_u: v,
    });
  }
  return {
    findings,
    turns_checked: [...checked],
    note:
      "C1: per-tool counted main-chain error calls (c1Outcome, S3) over reconciled settled turns in the window; " +
      "fires on >=20 calls, >=3 errors, rate > 2x corpus rate (D11 worse shell excluded). Headline = full " +
      "snapshot-priced recovery turn (first settled main-chain turn after the issuing turn, in window), one owner " +
      "per recovery turn (most issuing events, lowest rec id), rounded once per tool. Subagent figure not graded.",
  };
};
