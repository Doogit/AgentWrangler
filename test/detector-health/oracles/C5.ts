/**
 * C5 SAME_ERROR_LOOP_V2 oracle. Written ONLY from the dh-contracts.md C5 card + Appendix S0/S3. No imports from src/**.
 * Loop = in one reconciled session, main chain, settled turns: >= 3 errored calls (exit class ERROR) of one tool with
 * the same normalised error text, one error per owning turn, consecutive errors <= 10 min apart.
 * The card carries no $ (modeled $/wk is null by design), so the reliability figure is absent; the checkable
 * quantity is the loop count, exposed as `count` with repeated/excess error counts as quantities.
 */

import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_ERRORS = 3;
const MAX_GAP_MS = 600_000;

// Appendix S3 rules, verbatim.
const CHECK_COMMAND =
  /\b(?:vitest|jest|mocha|pytest|tsc|biome|eslint|prettier|ruff|mypy)\b|\bnpm\s+(?:test|run\s+(?:-s\s+)?(?:test|lint|typecheck|build|check|verify)\b)|\b(?:cargo|go|dotnet)\s+(?:test|build|check|clippy|vet)\b/i; // 1
const FAILED_STEP = /\bfailed\b|timed out|Couldn't|Can't|\bError\b|not in Claude's tab group/i; // 2
const STEP_LINE = /^\[[^\]\n]+\] /m; // 3
const FAILED_STEP_LINE = /^actions\[\d+\] \([^)\n]*\) failed:.*$/m; // 4
const SEARCH_MISS = /does not appear anywhere|There is no .* visible|does not contain any\b/i; // 5
const TOOL_FAILURE = /^\s*(?:Can't|Couldn't|Cannot|Failed|Error)\b/i; // 6
const HOOK_BLOCK = /^PreToolUse:\S+ hook error\b/; // 7
const CDP_TIMEOUT =
  /\bCDP sendCommand "[^"\n]+" timed out after \d+ms|^The "[^"\n]+" tool did not respond in time\b/; // 8
const USER_REJECT = /^The user doesn't want to (?:proceed with this tool use|take this action)/; // 9
const ARTIFACT_GUARD = /^(?:Nothing was published or removed:|conflict: nothing was published)/; // 10
const NOT_READ_ERROR = /^(?:<tool_use_error>)?(?:File |The file ).*\bhas not been read\b/i; // 11
const EXIT_NONZERO = /^Exit code [1-9]\d*\b/; // 13
const TASKKILL = /\btaskkill\b/i; // 14
const GIT_DIFF = /\bgit\b[^;&|\n]*\bdiff\b[^;&|\n]*--(quiet|exit-code)\b/; // 15
const PORT_PROBE = /\bGet-NetTCPConnection\b/i; // 16
// F32: C9's ingest label is not joinable per event, so the card excludes by the call's own text.
const DENY_RULE =
  /^Permission to use .* has been denied\.$|^File is in a directory that is denied by your permission settings\./; // 28
const SHELL_RAN = /^\s*Exit code -?\d+/; // 26 (F30 never-ran rule)

function isBrowserAnswer(tool: string, error: string): boolean {
  if (!tool.startsWith("mcp__claude-in-chrome__")) return false;
  if (tool.endsWith("__browser_batch")) {
    if (FAILED_STEP_LINE.test(error)) return false;
    return STEP_LINE.test(error) || !FAILED_STEP.test(error);
  }
  if (tool.endsWith("__find")) return SEARCH_MISS.test(error) && !TOOL_FAILURE.test(error);
  return false;
}

/** isBenignFailure(command, error, tool), card order. */
function isBenign(command: string | null, error: string | null, tool: string): boolean {
  if (error !== null) {
    if (isBrowserAnswer(tool, error)) return true;
    if (HOOK_BLOCK.test(error) || CDP_TIMEOUT.test(error) || USER_REJECT.test(error)) return true;
    if ((tool === "Edit" || tool === "Write") && NOT_READ_ERROR.test(error)) return true;
    if (tool === "Artifact" && ARTIFACT_GUARD.test(error)) return true;
  }
  if (command === null || error === null) return false;
  if (EXIT_NONZERO.test(error) && CHECK_COMMAND.test(command)) return true;
  if (/^Exit code 128\b/.test(error) && TASKKILL.test(command)) return true;
  if (/^Exit code 1\b/.test(error) && GIT_DIFF.test(command)) return true;
  if (error.trim() === "Exit code 1" && PORT_PROBE.test(command)) return true;
  return false;
}

/** Rule 25. */
const norm = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim().replace(/\s+/g, " ").toLowerCase();
  return t === "" ? null : t;
};

interface Row {
  event_id: string;
  session_id: string;
  ts: string;
  tool_name: string;
  owner: string;
  ws: string;
  err: string | null;
  cmd: string | null;
}

export const oracleC5: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT e.event_id, e.session_id, e.ts, e.tool_name, m.owner_message_id owner, t.workspace_id ws,
              json_extract(c.content_json, '$.error') err, json_extract(c.content_json, '$.command') cmd
       FROM tool_events e
       JOIN sessions s ON s.session_id = e.session_id
       JOIN tool_event_metadata m ON m.event_id = e.event_id
       JOIN turns t ON t.message_id = m.owner_message_id
       JOIN tool_event_content c ON c.event_id = e.event_id
       WHERE e.ts >= ? AND e.ts < ? AND e.exit_class = 'ERROR'
         AND s.state = 'RECONCILED' AND t.is_sidechain = 0 AND t.provisional = 0
       ORDER BY e.session_id, e.tool_name, e.ts, m.block_index, e.event_id`,
    )
    .all(from, to) as Row[];

  // Group by (session, tool, normalised error); one error per owning turn (earliest event of that turn).
  const groups = new Map<
    string,
    { ws: string; session: string; tool: string; turns: Map<string, { ts: number; owner: string }> }
  >();
  for (const r of rows) {
    const text = norm(r.err);
    if (text === null) continue;
    if (DENY_RULE.test(r.err ?? "")) continue;
    if ((r.tool_name === "Bash" || r.tool_name === "PowerShell") && !SHELL_RAN.test(r.err ?? ""))
      continue;
    if (isBenign(r.cmd, r.err, r.tool_name)) continue;
    const key = `${r.session_id}\u0000${r.tool_name}\u0000${text}`;
    const g = groups.get(key) ?? {
      ws: r.ws,
      session: r.session_id,
      tool: r.tool_name,
      turns: new Map(),
    };
    if (!g.turns.has(r.owner)) g.turns.set(r.owner, { ts: Date.parse(r.ts), owner: r.owner });
    groups.set(key, g);
  }

  interface Sess {
    ws: string;
    loops: number;
    repeated: number;
    excess: number;
    tools: Set<string>;
    errors: Set<string>;
  }
  const sessions = new Map<string, Sess>();
  const checked: string[] = [];
  for (const [key, g] of groups) {
    const evs = [...g.turns.values()].sort((a, b) => a.ts - b.ts || a.owner.localeCompare(b.owner));
    let run = [] as typeof evs;
    const flush = (): void => {
      if (run.length >= MIN_ERRORS) {
        const s = sessions.get(g.session) ?? {
          ws: g.ws,
          loops: 0,
          repeated: 0,
          excess: 0,
          tools: new Set<string>(),
          errors: new Set<string>(),
        };
        s.loops++;
        s.repeated += run.length;
        s.excess += run.length - 2;
        s.tools.add(g.tool);
        s.errors.add(key);
        sessions.set(g.session, s);
        for (const x of run) checked.push(x.owner);
      }
      run = [];
    };
    for (const ev of evs) {
      const last = run[run.length - 1];
      if (last && ev.ts - last.ts > MAX_GAP_MS) flush();
      run.push(ev);
    }
    flush();
  }

  const findings: OracleFinding[] = [...sessions.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sid, s]) => ({
      scope: { workspace_id: s.ws, key: `C5|${sid}` },
      quantities: [
        { name: "loops", unit: "count" as const, value: s.loops },
        { name: "repeated_errors", unit: "events" as const, value: s.repeated },
        { name: "loop_excess_errors", unit: "events" as const, value: s.excess },
        { name: "affected_tools", unit: "count" as const, value: s.tools.size },
        { name: "affected_error_classes", unit: "count" as const, value: s.errors.size },
      ],
      measured_u: null,
      assumptions: [
        {
          name: "no cross-family ownership cut (0 measured live)",
          value: 0,
          source: "dh-contracts.md shared wasted-turn paragraph; reviewer f9bdb7b3",
        },
        {
          name: "hook-block / deny-rule / user-rejected exclusion done by error-text shape (rules 7, 9, C9 deny text), not by joining the ingest label",
          value: 0,
          source: "dh-contracts.md C5 card trigger",
        },
        {
          name: "C5 carries no $ (modeled $/wk null by design); reliability figure absent, graded on loop count",
          value: 0,
          source: "dh-contracts.md C5 card, Materiality gates",
        },
        {
          name: "event ts used for the 10 min gap = earliest errored event of the owning turn",
          value: MAX_GAP_MS,
          source:
            "dh-contracts.md C5 card, C5_MAX_RETRY_GAP_MS (assumption on which event of a turn)",
        },
      ],
      modeled_u: null,
      count: s.loops,
    }));
  return {
    findings,
    turns_checked: checked,
    note: `${rows.length} errored main-chain calls in window, ${groups.size} candidate (session, tool, error) groups, ${findings.length} sessions with a loop (>= ${MIN_ERRORS} turns, gap <= 10 min)`,
  };
};
