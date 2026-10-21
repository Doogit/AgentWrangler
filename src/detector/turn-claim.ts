/**
 * Turn-grain claim partition for B3 wasted-turn $ attribution.
 *
 * B3 attributes an avoidance fraction of each failed/retried turn's
 * `turns.cost_equiv_u` to the finding that explains the waste. Several families
 * (C2/C9/D14/D11/C7/C3/C4/C1) can fire on the SAME turn, and C5/D7 already price a token-CEU
 * basis on overlapping turns. To avoid economic double-count, every turn's cost
 * is claimed by at most one detector.
 *
 * This helper computes that partition ONCE per (db, ctx) from the raw rows —
 * a pure exported function each detector calls, at turn grain. Each wasted-turn detector calls
 * `wastedTurnClaims` and consumes its own claimed set; the recommendations query
 * never sees turns, so attribution must live here at detector-eval grain.
 *
 * Claim order (fixed, highest first): C5/D7 loop-cluster turns are pre-excluded,
 * then existing families C7 > C3 > C4 > C1 are assigned (their sets are
 * identical to what they would be without the new families), and new families
 * C2 > C9 > D14 > D11 are appended after C1. Appending new families last
 * preserves the existing families' values unchanged. A turn excluded as a
 * C5/D7 cluster turn is claimed by none of these families. The gate logic below
 * intentionally duplicates each detector's firing predicate; the family tests pin
 * the partition so drift is caught.
 */

import type { Db } from "../db/open.js";
import { type D7LoopEvent, analyzeD7LoopEvents, isClaimedByC3 } from "./d7-loop-analysis.js";
import { isD7NonLoopCall, normalizedClusterText } from "./detectors/d7_loop_retry_waste.js";
import type { DetectorContext } from "./types.js";

export type WastedTurnFamily = "D14" | "C9" | "C2" | "D11" | "C7" | "C3" | "C4" | "C1";

/** One turn = `${session_id}|${owner_message_id}`. */
export type TurnKey = string;

export const C7_MIN_FAILURES = 3;
/** Three failed Edits in a row on one file: the real maximum run was 1, so the old 5 never fired. */
export const C4_MIN_CONSECUTIVE_FAILURES = 3;
export const C1_BASELINE_MULTIPLIER = 2;
/** A tool needs this many counted errors to be an outlier: one error in 43 calls is noise. */
export const C1_MIN_TOOL_ERRORS = 3;
/**
 * A tool needs this many main-chain calls in the window before its error rate can make it an
 * outlier: below it one or two failures double the rate (card review 2026-10-04: most outlier
 * tools had n ≤ 14). Repeated failures of a rarely used tool are C5/C7's to report.
 */
export const C1_MIN_TOOL_CALLS = 20;
/**
 * C9's denial filter over `ingest_metric_events` aliased `e`. A rejected AskUserQuestion is the
 * user answering in chat, not friction. Denial rows carry no tool name, so each rejection is paired
 * with its session's latest human-denied tool call at or before it.
 */
export const C9_DENIAL_WHERE = `e.is_sidechain = 0
  AND e.is_interrupt = 0
  AND e.classifier_label IN ('hook-block', 'deny-rule', 'user-rejected')
  AND NOT (e.classifier_label = 'user-rejected' AND (
    SELECT t.tool_name FROM tool_events t
     WHERE t.session_id = e.session_id AND t.interrupt_kind = 'HUMAN_DENY' AND t.ts <= e.event_ts
     ORDER BY t.ts DESC LIMIT 1) IS 'AskUserQuestion')`;
/**
 * A failed call whose failure is the expected "nothing there" answer, so C1 counts it as a
 * success: `taskkill` exits 128 when a process is already gone or cannot be killed in a tree kill,
 * a silent `Get-NetTCPConnection` probe exits 1 with no output when the port is free, and
 * `git diff --quiet` / `--exit-code` exits 1 to say there are changes. A git exit 128 is a real
 * failure, so the command must match too. A test, lint, typecheck or build run that exits non-zero
 * reports a fault in the code, not in the shell or the tool call (review 2 D11a/C1b).
 */
const CHECK_COMMAND =
  /\b(?:vitest|jest|mocha|pytest|tsc|biome|eslint|prettier|ruff|mypy)\b|\bnpm\s+(?:test|run\s+(?:-s\s+)?(?:test|lint|typecheck|build|check|verify)\b)|\b(?:cargo|go|dotnet)\s+(?:test|build|check|clippy|vet)\b/i;

/** A browser step that failed: its line names a failure, not only what the step did. */
const FAILED_STEP = /\bfailed\b|timed out|Couldn't|Can't|\bError\b|not in Claude's tab group/i;
/** A batch step's own line: `[navigate] Navigated to …`, or `actions[2] (find) failed: …`. */
const STEP_LINE = /^\[[^\]\n]+\] /m;
export const FAILED_STEP_LINE = /^actions\[\d+\] \([^)\n]*\) failed:.*$/m;
/** A page search that ran and found nothing: an answer, like an empty grep. */
const SEARCH_MISS = /does not appear anywhere|There is no .* visible|does not contain any\b/i;
/** A search the tool itself could not run ("Can't interact with …"). */
const TOOL_FAILURE = /^\s*(?:Can't|Couldn't|Cannot|Failed|Error)\b/i;

/**
 * A browser batch whose steps all succeeded ("Navigated to…", "Scrolled to…") and a page search
 * that found nothing are answers, not failures (P3.1 review 3 B7). A batch is read per step, so a
 * step's own output that mentions an error is not a failure; a search answer's prose may mention
 * one too (review 4 C1).
 */
function isBrowserAnswer(toolName: string | undefined, error: string): boolean {
  if (toolName === undefined || !toolName.startsWith("mcp__claude-in-chrome__")) return false;
  if (toolName.endsWith("__browser_batch")) {
    if (FAILED_STEP_LINE.test(error)) return false;
    return STEP_LINE.test(error) || !FAILED_STEP.test(error);
  }
  return toolName.endsWith("__find") && SEARCH_MISS.test(error) && !TOOL_FAILURE.test(error);
}

/** A PreToolUse hook blocked the call before it ran: C9 reports it, so it is no tool failure. */
const HOOK_BLOCK = /^PreToolUse:\S+ hook error\b/;
/**
 * The browser bridge timed out talking to Chrome: an infrastructure stall, not a bad call. Covers
 * the CDP string and the tool-level `The "<tool>" tool did not respond in time.` message.
 */
const CDP_TIMEOUT =
  /\bCDP sendCommand "[^"\n]+" timed out after \d+ms|^The "[^"\n]+" tool did not respond in time\b/;
/** The user declined the call: C9 reports it, so it is no tool failure. */
const USER_REJECT = /^The user doesn't want to (?:proceed with this tool use|take this action)/;
/**
 * The Artifact tool refused a publish that would overwrite a newer version: the guard working as
 * designed, not a failed call.
 */
const ARTIFACT_GUARD = /^(?:Nothing was published or removed:|conflict: nothing was published)/;
/**
 * An Edit or Write on a file the conversation had not read: C3 owns these events (U9 one-owner
 * rule), so C1 and C5 leave them out. Same wording as the classifier's NOT_READ label.
 */
const NOT_READ_ERROR = /^(?:<tool_use_error>)?(?:File |The file ).*\bhas not been read\b/i;

/**
 * A Read, Grep or Glob on a path that does not exist: C2 owns these events (U9 one-owner rule), so
 * C1 leaves them out. Same wording as the classifier's NOT_FOUND label.
 */
const NOT_FOUND_ERROR =
  /^(?:<tool_use_error>)?(?:File|Path|Directory|Pattern|No files?).*(?:not found|does not exist)\b/i;

export function isBenignFailure(
  command: string | null,
  error: string | null,
  toolName?: string,
): boolean {
  if (error !== null && isBrowserAnswer(toolName, error)) return true;
  if (
    error !== null &&
    (HOOK_BLOCK.test(error) ||
      CDP_TIMEOUT.test(error) ||
      USER_REJECT.test(error) ||
      ((toolName === "Edit" || toolName === "Write") && NOT_READ_ERROR.test(error)) ||
      (toolName === "Artifact" && ARTIFACT_GUARD.test(error)))
  ) {
    return true;
  }
  if (command === null || error === null) return false;
  if (/^Exit code [1-9]\d*\b/.test(error) && CHECK_COMMAND.test(command)) return true;
  if (/^Exit code 128\b/.test(error) && /\btaskkill\b/i.test(command)) return true;
  if (
    /^Exit code 1\b/.test(error) &&
    /\bgit\b[^;&|\n]*\bdiff\b[^;&|\n]*--(quiet|exit-code)\b/.test(command)
  ) {
    return true;
  }
  return error.trim() === "Exit code 1" && /\bGet-NetTCPConnection\b/i.test(command);
}
/**
 * What a failed Bash call's error says, for C7 clustering: the exit code and the first output
 * line, lowercased with ANSI codes, paths, hex and numbers masked. Null when the command never ran
 * (a hook or harness block, which C9 counts) or no error text was kept: a call with no text has no
 * known cause, so it joins no cluster.
 */
export function c7FailureSignature(error: string | null): string | null {
  const parts = c7FailureParts(error);
  if (parts === null) return null;
  const said = parts.firstLine
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .toLowerCase()
    .replace(/(?:[a-z]:|\.{1,2})?[\\/](?:[^\s\\/'"`:]+[\\/])*[^\s\\/'"`:]*/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${parts.exitCode}|${said}`;
}
/** The exit code and first non-empty output line of a failed Bash call; null when it never ran. */
export function c7FailureParts(
  error: string | null,
): { exitCode: string; firstLine: string } | null {
  if (error === null) return null;
  const ran = /^Exit code (\d+)\r?\n?([\s\S]*)$/.exec(error);
  if (ran === null) return null;
  const first = (ran[2] ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return { exitCode: ran[1] ?? "", firstLine: first ?? "" };
}
/**
 * D14 filter over `tool_events` aliased `e`: a call Claude Code marks as cut off because the
 * session ended was not stopped by the user, so it is not an interrupt to learn from.
 */
export const D14_NOT_SESSION_END = `NOT EXISTS (
  SELECT 1 FROM tool_event_content ended
   WHERE ended.event_id = e.event_id
     AND json_extract(ended.content_json, '$.error') LIKE '[Tool call interrupted: the session ended%')`;
/**
 * RC-D14: D14's second source, the user Esc records (`ingest_metric_events`, classifier-2) a
 * plain Esc leaves with no tool event. Only the plain variant carries `interrupt-cancel`: the
 * "for tool use" variant trails a rejected tool_result, which is a tool denial (HUMAN_DENY, C9).
 * Same filters as the tool source: reconciled session, main chain, and no prompt correction
 * within two later main-chain turns. Binds (fromIso, toIso); rows are (event_id, session_id,
 * workspace_id, ts).
 */
export const D14_ESC_SQL = `
  SELECT x.event_id, x.session_id, s.workspace_id, x.event_ts AS ts
    FROM ingest_metric_events x
    JOIN sessions s ON s.session_id = x.session_id
   WHERE x.event_ts >= ? AND x.event_ts < ?
     AND s.state = 'RECONCILED'
     AND x.is_sidechain = 0
     AND x.is_interrupt = 1
     AND x.classifier_label = 'interrupt-cancel'
     AND x.classifier_version = 'classifier-2'
     AND NOT EXISTS (
       SELECT 1
         FROM ingest_metric_events user_turn
        WHERE user_turn.session_id = x.session_id
          AND user_turn.is_user_turn = 1
          AND user_turn.user_turn_ts > x.event_ts
          AND (
            SELECT COUNT(*)
              FROM turns later_turn
             WHERE later_turn.session_id = x.session_id
               AND later_turn.is_sidechain = 0
               AND later_turn.provisional = 0
               AND later_turn.ts > x.event_ts
               AND later_turn.ts <= user_turn.user_turn_ts
          ) <= 2
     )`;
/**
 * The response an Esc stopped: the latest main settled turn at or before it, but after the
 * latest main user prompt before it. A stopped stream that wrote no usage record has no such
 * turn, so the previous prompt's answer is never priced as wasted. Binds (session_id, escTs,
 * escTs).
 */
export const D14_ESC_OWNER_SQL = `
  SELECT message_id FROM turns
   WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts <= ?
     AND ts > COALESCE((
       SELECT MAX(p.user_turn_ts) FROM ingest_metric_events p
        WHERE p.session_id = turns.session_id AND p.is_user_turn = 1 AND p.is_sidechain = 0
          AND p.user_turn_ts < ?), '')
   ORDER BY ts DESC LIMIT 1`;
/**
 * An error the shell itself raised: it could not parse the command, or did not know a command
 * name. Bash: unmatched quotes, syntax errors, "command not found", bad substitution. PowerShell:
 * parser errors, "is not recognized as the name of a cmdlet", `&&` in Windows PowerShell.
 */
const SHELL_FAILURE =
  /unexpected EOF while looking for matching|syntax error near unexpected token|syntax error: unexpected end of file|: command not found|bad substitution|is not recognized as the name of a cmdlet|^ParserError:|CategoryInfo\s*:\s*ParserError|Unexpected token .* in expression or statement|The string is missing the terminator|is not a valid statement separator|An empty pipe element is not allowed|Missing expression after/im;

/**
 * How D11 counts a shell call: null when its command never ran (a hook or harness block, which C9
 * counts); ERROR only when the shell itself failed (`SHELL_FAILURE`). A script, gate, hook, test
 * or program that ran and failed would fail the same way in the other shell, and a failure with no
 * stored error has no known cause, so both count as OK (P3.1 review 3 B3).
 */
export function d11Outcome(
  exitClass: string | null,
  _command: string | null,
  error: string | null,
): "ERROR" | "OK" | null {
  if (error !== null && !/^Exit code \d+/.test(error)) return null;
  return exitClass === "ERROR" && error !== null && SHELL_FAILURE.test(error) ? "ERROR" : "OK";
}
/**
 * How C1 counts a call: a shell call by `d11Outcome` (only a failure of the shell itself is an
 * error; a script or test that ran and exited non-zero is not), any other tool by its exit class
 * less benign failures. Null when the call never ran, so it is left out of the rates.
 */
export function c1Outcome(
  toolName: string,
  exitClass: string | null,
  command: string | null,
  error: string | null,
): "ERROR" | "OK" | null {
  if (toolName === "Bash" || toolName === "PowerShell")
    return d11Outcome(exitClass, command, error);
  if (error !== null && HOOK_BLOCK.test(error)) return null;
  // C2 owns a missing path on Read, Grep or Glob: it is no failed call here (U9 r3).
  if (
    error !== null &&
    (toolName === "Read" || toolName === "Grep" || toolName === "Glob") &&
    NOT_FOUND_ERROR.test(error)
  ) {
    return "OK";
  }
  const failed =
    (exitClass === "ERROR" || exitClass === "TEST_FAIL") &&
    !isBenignFailure(command, error, toolName);
  return failed ? "ERROR" : "OK";
}
export interface D11ShellRate {
  tool_name: string;
  calls: number;
  errors: number;
}
/** Bash and PowerShell call and error counts per workspace, as `d11Outcome` counts them. */
export function d11ShellRates(
  db: Db,
  ctx: DetectorContext,
): Map<string, Map<string, D11ShellRate>> {
  const rows = db
    .prepare(
      `SELECT s.workspace_id, e.tool_name, e.exit_class,
              json_extract(c.content_json, '$.command') AS command_text,
              json_extract(c.content_json, '$.error') AS error_text
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.ts >= ? AND e.ts < ? AND e.tool_name IN ('Bash', 'PowerShell')`,
    )
    .all(ctx.fromIso, ctx.toIso) as Array<{
    workspace_id: string;
    tool_name: string;
    exit_class: string | null;
    command_text: string | null;
    error_text: string | null;
  }>;
  const byWorkspace = new Map<string, Map<string, D11ShellRate>>();
  for (const row of rows) {
    const outcome = d11Outcome(row.exit_class, row.command_text, row.error_text);
    if (outcome === null) continue;
    let rates = byWorkspace.get(row.workspace_id);
    if (rates === undefined) {
      rates = new Map();
      byWorkspace.set(row.workspace_id, rates);
    }
    const rate = rates.get(row.tool_name) ?? { tool_name: row.tool_name, calls: 0, errors: 0 };
    rate.calls += 1;
    if (outcome === "ERROR") rate.errors += 1;
    rates.set(row.tool_name, rate);
  }
  return byWorkspace;
}
export const D11_MIN_CALLS = 50;
export const D11_RATE_RATIO = 1.5;
// Three errors keeps a single transient failure from producing workspace shell guidance.
export const D11_MIN_HIGHER_ERRORS = 3;

/** The higher-error shell of each workspace where D11 fires. C1 leaves these calls to D11 (T9). */
export function d11WorseShells(db: Db, ctx: DetectorContext): Map<string, string> {
  const worseTools = new Map<string, string>();
  for (const [workspaceId, rates] of d11ShellRates(db, ctx)) {
    const bash = rates.get("Bash");
    const powerShell = rates.get("PowerShell");
    if (
      bash === undefined ||
      powerShell === undefined ||
      bash.calls < D11_MIN_CALLS ||
      powerShell.calls < D11_MIN_CALLS
    )
      continue;
    const bashRate = bash.errors / bash.calls;
    const powerShellRate = powerShell.errors / powerShell.calls;
    const bashIsWorse = bashRate >= powerShellRate;
    const worse = bashIsWorse ? bash : powerShell;
    const higherRate = Math.max(bashRate, powerShellRate);
    const lowerRate = Math.min(bashRate, powerShellRate);
    const meetsMinimumErrors = worse.errors >= D11_MIN_HIGHER_ERRORS;
    const meetsRatio =
      lowerRate === 0
        ? meetsMinimumErrors && higherRate > 0
        : meetsMinimumErrors && higherRate >= D11_RATE_RATIO * lowerRate;
    if (meetsRatio) worseTools.set(workspaceId, worse.tool_name);
  }
  return worseTools;
}

interface ClaimRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly ts: string;
  readonly block_index: number;
  readonly tool_name: string;
  readonly exit_class: string | null;
  readonly tool_error_class: string | null;
  readonly tool_error_classifier_version: string | null;
  readonly bash_command_family: string | null;
  readonly file_path_hash: string | null;
  readonly input_hash: string | null;
  readonly result_bytes: number | null;
  readonly content_text: string | null;
  readonly command_text: string | null;
  readonly error_text: string | null;
  readonly owner_message_id: string;
  readonly agent_id: string | null;
}

export function turnKey(sessionId: string, ownerMessageId: string): TurnKey {
  return `${sessionId}|${ownerMessageId}`;
}

/** A group row carrying the turn identity + its priced cost, for attribution. */
export interface ClaimableRow {
  readonly session_id: string;
  readonly owner_message_id: string;
  readonly cost_equiv_u: number | null;
}

/**
 * Sum `cost_equiv_u` over the distinct turns in `rows` that this family claims
 * (present in `claimed`). Each turn is counted once even if it carries several
 * events; NULL (unpriceable) turns contribute 0 but are still counted as claimed.
 */
export function claimedTurnCost(
  rows: readonly ClaimableRow[],
  claimed: ReadonlySet<TurnKey>,
): { summedCostU: number; claimedTurnCount: number } {
  const seen = new Set<TurnKey>();
  let summedCostU = 0;
  for (const row of rows) {
    const k = turnKey(row.session_id, row.owner_message_id);
    if (!claimed.has(k) || seen.has(k)) continue;
    seen.add(k);
    summedCostU += row.cost_equiv_u ?? 0;
  }
  return { summedCostU, claimedTurnCount: seen.size };
}

function rowOrder(a: ClaimRow, b: ClaimRow): number {
  return (
    a.ts.localeCompare(b.ts) ||
    a.block_index - b.block_index ||
    a.event_id.localeCompare(b.event_id)
  );
}

/**
 * Partition wasted turns among D14/C9/C2/D11/C7/C3/C4/C1 after excluding C5/D7
 * loop-cluster turns. Returns a set of turn keys per family; the sets are
 * pairwise disjoint and disjoint from the excluded C5/D7 pool.
 */
export function wastedTurnClaims(
  db: Db,
  ctx: DetectorContext,
): Map<WastedTurnFamily, Set<TurnKey>> {
  return wastedTurnCensus(db, ctx).claims;
}

/** The partition plus what the Diagnostics census counts from it (P4 U3a). */
export interface WastedTurnCensus {
  /** Exactly `wastedTurnClaims`' output. */
  readonly claims: Map<WastedTurnFamily, Set<TurnKey>>;
  /**
   * Per family, the events behind its claimed turns: tool event ids, or `ingest_metric_events`
   * ids for C9 denials. A turn claimed only as a re-plan turn (C9, D14) adds no event.
   */
  readonly claimEventIds: Map<WastedTurnFamily, Set<string>>;
  /** The C5/D7 loop pool: each repeat-excess tool event id → its turn. */
  readonly loopExcessEvents: Map<string, TurnKey>;
}

/** A family's candidate turns, in first-seen order, each with the events that made it one. */
type Candidates = Map<TurnKey, string[]>;

function addCandidate(candidates: Candidates, turn: TurnKey, eventId?: string): void {
  let events = candidates.get(turn);
  if (events === undefined) {
    events = [];
    candidates.set(turn, events);
  }
  if (eventId !== undefined) events.push(eventId);
}

/** Which chains a census pass covers: the main chain, or every subagent chain (session_id, agent_id). */
export type CensusChain = "main" | "sidechain";

/**
 * `wastedTurnClaims`, plus the loop pool and the event ids behind each family.
 * The sidechain pass keys every per-session rule by (session_id, agent_id), reads C1's corpus rate
 * from sidechain rows only, and leaves C9 and D14 (user actions on the main chain) empty.
 */
export function wastedTurnCensus(
  db: Db,
  ctx: DetectorContext,
  chain: CensusChain = "main",
): WastedTurnCensus {
  const sidechain = chain === "sidechain";
  const chainWhere = sidechain
    ? "t.is_sidechain = 1 AND t.agent_id IS NOT NULL"
    : "t.is_sidechain = 0";
  const rows = db
    .prepare(
      `SELECT e.event_id, e.session_id, s.workspace_id, e.ts, m.block_index,
              e.tool_name, e.exit_class, e.tool_error_class,
              e.tool_error_classifier_version, e.bash_command_family,
              m.file_path_hash, e.input_hash, e.result_bytes,
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
        WHERE e.ts >= ? AND e.ts < ?
          AND s.state = 'RECONCILED'
          AND m.owner_message_id IS NOT NULL
          AND ${chainWhere}
          AND t.provisional = 0
        ORDER BY s.workspace_id, e.session_id, e.ts, m.block_index, e.event_id`,
    )
    .all(ctx.fromIso, ctx.toIso) as ClaimRow[];

  const key = (row: ClaimRow): TurnKey => turnKey(row.session_id, row.owner_message_id);
  /** The per-chain grouping key: the session on the main chain, (session, subagent) on a sidechain. */
  const chainOf = (row: ClaimRow): string =>
    sidechain ? `${row.session_id}\0${row.agent_id}` : row.session_id;

  // ── D7 loop pre-exclusion (MED-2 fix, operator 2026-09-22) ───────────────────
  // D7 is the single owner of loop economics. Previously this reimplemented a
  // NARROWER loop signature (session run of >=3 events sharing one non-null
  // input_hash), so loops D7 actually prices via other signals — Bash ERROR runs
  // with varying commands (markErrorRuns), TEST_FAIL runs, three-grams, redundant
  // reads — escaped the exclusion and were double-counted by a C-family B3 rec AND
  // by D7. Now we run D7's OWN matcher (`analyzeD7LoopEvents`, the shared source of
  // truth) per session and exclude exactly the turns D7 monetizes — the
  // `repeatExcessEventIds` set (the all-but-first members each D7 run prices). The
  // first member of a loop is NOT priced by D7, so it stays claimable by B3 (no
  // turn is priced twice, and no honest coverage is dropped). Friction signals are
  // enabled here so Bash ERROR runs are caught; D7 gates them per-session on a
  // coverage floor, so this is at most a slightly conservative over-exclusion in
  // low-coverage sessions (deflates B3, never inflates) — acceptable per the
  // inflation-first ruling.
  const excluded = new Set<TurnKey>();
  const loopExcessEvents = new Map<string, TurnKey>();
  const bySession = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    const group = bySession.get(chainOf(row));
    if (group === undefined) bySession.set(chainOf(row), [row]);
    else group.push(row);
  }
  for (const sessionRows of bySession.values()) {
    const loopEvents: D7LoopEvent[] = sessionRows.map((r) => ({
      event_id: r.event_id,
      ts: r.ts,
      tool_name: r.tool_name,
      // Match D7's key exactly: the captured content slice supersedes input_hash for
      // migration-028-backed events (d7_loop_retry_waste.ts). Feeding raw input_hash
      // here diverges from D7 on content-backed loops, so D7 prices repeat turns that
      // this exclusion misses and a C-family rec double-counts them.
      input_hash: normalizedClusterText(r.content_text) ?? r.input_hash,
      exit_class: r.exit_class,
      file_path_hash: r.file_path_hash,
      result_bytes: r.result_bytes,
      // F7: D7's own poll and guard-block boundaries.
      // U7: C3's events are no loop evidence for D7, so this pool leaves them to C3 too.
      eligible: !isD7NonLoopCall(r.tool_name, r.exit_class, r.error_text) && !isClaimedByC3(r),
      // F14: same-message calls count once, as in D7 itself.
      owner_message_id: r.owner_message_id,
    }));
    const { repeatExcessEventIds } = analyzeD7LoopEvents(loopEvents, {
      includeFrictionSignals: true,
    });
    if (repeatExcessEventIds.size === 0) continue;
    for (const row of sessionRows) {
      if (!repeatExcessEventIds.has(row.event_id)) continue;
      excluded.add(key(row));
      loopExcessEvents.set(row.event_id, key(row));
    }
  }

  // ── D14 candidates: classified interrupt/cancel events without a prompt correction.
  //    Claims the owner turn + the next same-chain turn (re-plan turn).
  const d14Candidates: Candidates = new Map();
  const d14Rows = sidechain
    ? []
    : (db
        .prepare(
          `SELECT e.event_id, e.session_id, m.owner_message_id, t.ts AS owner_ts
         FROM tool_events e
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
         JOIN sessions s ON s.session_id = e.session_id
        WHERE e.ts >= ? AND e.ts < ?
          AND s.state = 'RECONCILED'
          AND t.is_sidechain = 0
          AND t.provisional = 0
          AND e.interrupt_kind IN ('PURE_INTERRUPT', 'KILLED_NO_PROMPT')
          AND e.interrupt_classifier_version = 'interrupt-1'
          AND ${D14_NOT_SESSION_END}
          AND NOT EXISTS (
            SELECT 1
              FROM ingest_metric_events user_turn
             WHERE user_turn.session_id = e.session_id
               AND user_turn.is_user_turn = 1
               AND user_turn.user_turn_ts > e.ts
               AND (
                 SELECT COUNT(*)
                   FROM turns later_turn
                  WHERE later_turn.session_id = e.session_id
                    AND later_turn.is_sidechain = 0
                    AND later_turn.provisional = 0
                    AND later_turn.ts > e.ts
                    AND later_turn.ts <= user_turn.user_turn_ts
               ) <= 2
          )`,
        )
        .all(ctx.fromIso, ctx.toIso) as Array<{
        event_id: string;
        session_id: string;
        owner_message_id: string;
        owner_ts: string;
      }>);
  const d14NextQ = db.prepare(
    `SELECT message_id FROM turns
      WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0
        AND ts > ?
      ORDER BY ts ASC LIMIT 1`,
  );
  for (const d14 of d14Rows) {
    addCandidate(d14Candidates, turnKey(d14.session_id, d14.owner_message_id), d14.event_id);
    const next = d14NextQ.all(d14.session_id, d14.owner_ts) as Array<{ message_id: string }>;
    for (const n of next) addCandidate(d14Candidates, turnKey(d14.session_id, n.message_id));
  }
  // RC-D14 Esc source: the stopped response (D14_ESC_OWNER_SQL) and the re-plan turn after it.
  const d14EscRows = sidechain
    ? []
    : (db.prepare(D14_ESC_SQL).all(ctx.fromIso, ctx.toIso) as Array<{
        event_id: string;
        session_id: string;
        ts: string;
      }>);
  const d14EscOwnerQ = db.prepare(D14_ESC_OWNER_SQL);
  for (const esc of d14EscRows) {
    const owner = d14EscOwnerQ.all(esc.session_id, esc.ts, esc.ts) as Array<{
      message_id: string;
    }>;
    for (const o of owner)
      addCandidate(d14Candidates, turnKey(esc.session_id, o.message_id), esc.event_id);
    const next = d14NextQ.all(esc.session_id, esc.ts) as Array<{ message_id: string }>;
    for (const n of next) addCandidate(d14Candidates, turnKey(esc.session_id, n.message_id));
  }

  // ── C9 candidates: denial events → owner turn (latest ts ≤ event_ts) +
  //    re-plan turn (earliest ts > event_ts). No RECONCILED or provisional
  //    requirement — denial rows live in LIVE sessions too (confirmed oracle).
  const c9Candidates: Candidates = new Map();
  const c9Denials = sidechain
    ? []
    : (db
        .prepare(
          `SELECT e.event_id, e.session_id, e.event_ts
         FROM ingest_metric_events e
        WHERE e.event_ts >= ? AND e.event_ts < ?
          AND ${C9_DENIAL_WHERE}`,
        )
        .all(ctx.fromIso, ctx.toIso) as Array<{
        event_id: string;
        session_id: string;
        event_ts: string;
      }>);
  const c9OwnerQ = db.prepare(
    `SELECT message_id FROM turns
      WHERE session_id = ? AND is_sidechain = 0
        AND ts <= ?
      ORDER BY ts DESC LIMIT 1`,
  );
  const c9ReplanQ = db.prepare(
    `SELECT message_id FROM turns
      WHERE session_id = ? AND is_sidechain = 0
        AND ts > ?
      ORDER BY ts ASC LIMIT 1`,
  );
  for (const denial of c9Denials) {
    const owner = c9OwnerQ.all(denial.session_id, denial.event_ts) as Array<{ message_id: string }>;
    const replan = c9ReplanQ.all(denial.session_id, denial.event_ts) as Array<{
      message_id: string;
    }>;
    for (const r of owner)
      addCandidate(c9Candidates, turnKey(denial.session_id, r.message_id), denial.event_id);
    for (const r of replan) addCandidate(c9Candidates, turnKey(denial.session_id, r.message_id));
  }

  // ── C2 candidates: Read/Grep/Glob closed NOT_FOUND labels ─────────────────
  const c2Candidates: Candidates = new Map();
  for (const row of rows) {
    if (
      (row.tool_name === "Read" || row.tool_name === "Grep" || row.tool_name === "Glob") &&
      row.tool_error_class === "NOT_FOUND" &&
      row.tool_error_classifier_version === "tool-error-1"
    ) {
      addCandidate(c2Candidates, key(row), row.event_id);
    }
  }

  // ── D11 candidates: ERROR turns of each workspace's higher-error shell ──────
  const d11Candidates: Candidates = new Map();
  const d11WorseTools = d11WorseShells(db, ctx);
  for (const row of rows) {
    if (
      row.tool_name === d11WorseTools.get(row.workspace_id) &&
      d11Outcome(row.exit_class, row.command_text, row.error_text) === "ERROR"
    ) {
      addCandidate(d11Candidates, key(row), row.event_id);
    }
  }

  // ── C7 candidates: Bash ERROR, >=3 per (ws, session, error signature); a TEST_FAIL is a
  //    failing test, not a failing command, and a benign failure is not a failure ──────────
  const c7Candidates: Candidates = new Map();
  const byBashFamily = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    if (
      row.tool_name !== "Bash" ||
      row.exit_class !== "ERROR" ||
      isBenignFailure(row.command_text, row.error_text, row.tool_name)
    ) {
      continue;
    }
    const signature = c7FailureSignature(row.error_text);
    if (signature === null) continue;
    const k = `${row.workspace_id}\0${chainOf(row)}\0${signature}`;
    const group = byBashFamily.get(k);
    if (group === undefined) byBashFamily.set(k, [row]);
    else group.push(row);
  }
  for (const group of byBashFamily.values()) {
    if (group.length >= C7_MIN_FAILURES)
      for (const row of group) addCandidate(c7Candidates, key(row), row.event_id);
  }

  // ── C3 candidates: Edit or Write NOT_READ (no min gate) ──────────────────────
  const c3Candidates: Candidates = new Map();
  for (const row of rows) {
    if (
      (row.tool_name === "Edit" || row.tool_name === "Write") &&
      row.tool_error_class === "NOT_READ" &&
      row.tool_error_classifier_version === "tool-error-1"
    ) {
      addCandidate(c3Candidates, key(row), row.event_id);
    }
  }

  // ── C4 candidates: Edit STALE_STRING/PATCH_FAILED, consecutive run >=5 ────────
  const c4Candidates: Candidates = new Map();
  const byFile = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    if (row.tool_name !== "Edit" || row.file_path_hash === null) continue;
    // C3 owns a not-read Edit (U9): it joins no C4 run.
    if (
      row.tool_error_class === "NOT_READ" &&
      row.tool_error_classifier_version === "tool-error-1"
    ) {
      continue;
    }
    const k = `${row.workspace_id}\0${chainOf(row)}\0${row.file_path_hash}`;
    const group = byFile.get(k);
    if (group === undefined) byFile.set(k, [row]);
    else group.push(row);
  }
  const isRecoveryFailure = (row: ClaimRow): boolean => row.exit_class === "ERROR";
  for (const group of byFile.values()) {
    let run: ClaimRow[] = [];
    const flush = (): void => {
      if (run.length >= C4_MIN_CONSECUTIVE_FAILURES)
        for (const row of run) addCandidate(c4Candidates, key(row), row.event_id);
      run = [];
    };
    for (const row of [...group].sort(rowOrder)) {
      if (isRecoveryFailure(row)) run.push(row);
      else flush();
    }
    flush();
  }

  // ── C1 candidates: error turns of tools whose rate > 2x corpus rate ──────────
  const c1Candidates: Candidates = new Map();
  const c1Outcomes = new Map<ClaimRow, "ERROR" | "OK" | null>();
  for (const row of rows) {
    c1Outcomes.set(row, c1Outcome(row.tool_name, row.exit_class, row.command_text, row.error_text));
  }
  const c1Error = (row: ClaimRow): boolean => c1Outcomes.get(row) === "ERROR";
  const c1Rows = rows.filter(
    (row) => row.tool_name !== d11WorseTools.get(row.workspace_id) && c1Outcomes.get(row) !== null,
  );
  const corpusErrors = c1Rows.filter(c1Error).length;
  if (c1Rows.length > 0 && corpusErrors > 0) {
    const corpusRate = corpusErrors / c1Rows.length;
    const byTool = new Map<string, { total: number; errors: ClaimRow[] }>();
    for (const row of c1Rows) {
      const agg = byTool.get(row.tool_name) ?? { total: 0, errors: [] };
      agg.total += 1;
      if (c1Error(row)) agg.errors.push(row);
      byTool.set(row.tool_name, agg);
    }
    for (const agg of byTool.values()) {
      const toolRate = agg.errors.length / agg.total;
      if (
        agg.total >= C1_MIN_TOOL_CALLS &&
        agg.errors.length >= C1_MIN_TOOL_ERRORS &&
        toolRate > C1_BASELINE_MULTIPLIER * corpusRate
      ) {
        for (const row of agg.errors) addCandidate(c1Candidates, key(row), row.event_id);
      }
    }
  }

  // ── Priority assignment: C5/D7 excluded first, then C7 > C3 > C4 > C1 > C2 > C9 > D14 > D11 ──
  const claimed = new Set<TurnKey>(excluded);
  const result = new Map<WastedTurnFamily, Set<TurnKey>>();
  const claimEventIds = new Map<WastedTurnFamily, Set<string>>();
  for (const [family, candidates] of [
    ["C7", c7Candidates],
    ["C3", c3Candidates],
    ["C4", c4Candidates],
    ["C1", c1Candidates],
    ["C2", c2Candidates],
    ["C9", c9Candidates],
    ["D14", d14Candidates],
    ["D11", d11Candidates],
  ] as const) {
    const own = new Set<TurnKey>();
    const events = new Set<string>();
    for (const [k, eventIds] of candidates) {
      if (claimed.has(k)) continue;
      own.add(k);
      claimed.add(k);
      for (const eventId of eventIds) events.add(eventId);
    }
    result.set(family, own);
    claimEventIds.set(family, events);
  }
  return { claims: result, claimEventIds, loopExcessEvents };
}
