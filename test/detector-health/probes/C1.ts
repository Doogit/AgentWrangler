/**
 * C1 TOOL_ERROR_RATE_V2 silence probe (card: docs/plans/dh-contracts.md C1). Independent recount.
 * Reads base ingest rows only (tool_events, tool_event_metadata, tool_event_content error text, turns, sessions).
 * No classifier columns (exit_class / tool_error_class) are read.
 */

import type Database from "better-sqlite3";
import { isShellLevelError, shellAnalysis, startsWithExitCode } from "./D11.js";
import type { ProbeGate, ProbeResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_CALLS = 20;
const MIN_ERRORS = 3;
const MULTIPLIER = 2;

const HOOK_BLOCK = /hook (blocked|denied|error)|blocked by (a )?hook|PreToolUse|PostToolUse/i;
const USER_REJECT =
  /user (doesn'?t want|rejected|declined|denied)|doesn'?t want to proceed|request interrupted by user|tool use was rejected/i;
const BROWSER_TIMEOUT = /timed? ?out|timeout/i;
const MISSING_PATH =
  /does not exist|no such file|not found|no (matches|files) found|enoent|path .* not found/i;
const NOT_READ = /has not been read|must read .* first|read it first/i;
const ARTIFACT_GUARD = /conflict|has not been (read|published)|newer/i;

/** Non-shell tools: benign failures count as OK. */
function isBenign(tool: string, err: string): boolean {
  if (HOOK_BLOCK.test(err) || USER_REJECT.test(err)) return true;
  if (tool.startsWith("mcp__") && BROWSER_TIMEOUT.test(err)) return true;
  if ((tool === "Read" || tool === "Grep" || tool === "Glob") && MISSING_PATH.test(err))
    return true;
  if ((tool === "Edit" || tool === "Write") && NOT_READ.test(err)) return true;
  if (tool === "Artifact" && ARTIFACT_GUARD.test(err)) return true;
  return false;
}

export function probeC1(db: Database.Database, now: Date): ProbeResult {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  // D11-worse shell per workspace is excluded entirely.
  const excluded = new Map<string, string>();
  for (const w of shellAnalysis(db, now)) if (w.fires) excluded.set(w.workspace, w.worse);

  const rows = db
    .prepare(
      `SELECT s.workspace_id AS ws, e.tool_name AS tool,
              json_extract(c.content_json, '$.error') AS err
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         JOIN tool_event_metadata m ON m.event_id = e.event_id
         JOIN turns t ON t.message_id = m.owner_message_id AND t.session_id = e.session_id
                     AND t.is_sidechain = 0 AND t.provisional = 0
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.ts >= ? AND e.ts < ?`,
    )
    .all(from, to) as { ws: string; tool: string; err: unknown }[];

  const per = new Map<string, { calls: number; errors: number }>();
  let corpusCalls = 0;
  let corpusErrors = 0;
  for (const r of rows) {
    const err = typeof r.err === "string" ? r.err : null;
    const isShell = r.tool === "Bash" || r.tool === "PowerShell";
    let isError = false;
    if (isShell) {
      if (excluded.get(r.ws) === r.tool) continue;
      if (err !== null && !startsWithExitCode(err)) continue; // never ran: left out
      isError = err !== null && isShellLevelError(err);
    } else {
      isError = err !== null && !isBenign(r.tool, err);
    }
    let p = per.get(r.tool);
    if (!p) {
      p = { calls: 0, errors: 0 };
      per.set(r.tool, p);
    }
    p.calls += 1;
    corpusCalls += 1;
    if (isError) {
      p.errors += 1;
      corpusErrors += 1;
    }
  }

  const cands = [...per.entries()].filter(([, p]) => p.errors >= 1);
  // tool rate > 2 x corpus rate, in integers: errors * corpusCalls > 2 * corpusErrors * calls
  const multipleOf = (p: { calls: number; errors: number }): number =>
    corpusErrors > 0 && p.calls > 0 && corpusCalls > 0
      ? p.errors / p.calls / (corpusErrors / corpusCalls)
      : 0;
  const fires = (p: { calls: number; errors: number }): boolean =>
    corpusErrors > 0 &&
    p.calls >= MIN_CALLS &&
    p.errors >= MIN_ERRORS &&
    p.errors * corpusCalls > MULTIPLIER * corpusErrors * p.calls;
  const qual = cands.filter(([, p]) => fires(p));
  const best = qual[0] ?? [...cands].sort((a, b) => multipleOf(b[1]) - multipleOf(a[1]))[0] ?? null;

  const gates: ProbeGate[] = [
    {
      name: "C1 corpus errors",
      value: corpusErrors,
      threshold: 0,
      op: ">",
      pass: corpusErrors > 0,
    },
  ];
  if (best) {
    const [, p] = best;
    const m = multipleOf(p);
    gates.push(
      {
        name: "C1_MIN_TOOL_CALLS",
        value: p.calls,
        threshold: MIN_CALLS,
        op: ">=",
        pass: p.calls >= MIN_CALLS,
      },
      {
        name: "C1_MIN_TOOL_ERRORS",
        value: p.errors,
        threshold: MIN_ERRORS,
        op: ">=",
        pass: p.errors >= MIN_ERRORS,
      },
      {
        name: "C1_BASELINE_MULTIPLIER",
        value: m,
        threshold: MULTIPLIER,
        op: ">",
        pass: p.errors * corpusCalls > MULTIPLIER * corpusErrors * p.calls && corpusErrors > 0,
      },
    );
  }
  return {
    candidates: cands.length,
    qualifying: qual.length,
    gates,
    note:
      "Tools with >=1 counted error (candidates); qualifying = >=20 calls, >=3 errors, rate > 2x corpus rate. " +
      "Derivation: reconciled sessions, ts in [now-7d, now), event owned (tool_event_metadata) by a non-sidechain, non-provisional turn. " +
      "Error text = tool_event_content $.error (raw tool_result is_error text); the 'classified outcome' requirement is not " +
      "re-derived (exit_class not read). Bash/PowerShell: left out if error text lacks 'Exit code N' prefix; error only if it also " +
      "matches a shell-level pattern (see D11 probe); shells that D11 flags as worse in a workspace are excluded. Other tools: " +
      "error = any stored error text except benign (hook block, user rejection, mcp__ timeout, Read/Grep/Glob missing path or " +
      "no match, Edit/Write not-read, Artifact guard), which count as OK. Not modelled: passing browser batch answers, " +
      "taskkill/git-diff/port-probe (shell, already OK unless shell-level). Needs a raw-JSONL is_error sample count on live copy.",
  };
}
