/**
 * D11 TOOL_ERROR_RATE silence probe (card: docs/plans/dh-contracts.md D11). Independent recount.
 * Reads base ingest rows only: tool_events (tool_name, ts), tool_event_content.error text, sessions.
 * No classifier columns (exit_class / tool_error_class) are read.
 */

import type Database from "better-sqlite3";
import type { ProbeGate, ProbeResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_CALLS = 50;
const MIN_HIGHER_ERRORS = 3;
const RATE_RATIO = 1.5;

/** Stored error text of a call that actually ran begins "Exit code N". */
export function startsWithExitCode(err: string): boolean {
  return /^\s*Exit code -?\d+/i.test(err);
}

/** Shell-level failures: the shell itself failed, not the script it ran. */
const SHELL_LEVEL =
  /command not found|is not recognized as|CommandNotFoundException|syntax error|unexpected (eof|token|end of file)|unmatched|unterminated|bad substitution|ParserError|not a valid statement separator|missing (closing|terminator)|ambiguous redirect/i;

export function isShellLevelError(err: string): boolean {
  return startsWithExitCode(err) && SHELL_LEVEL.test(err);
}

export interface ShellSide {
  calls: number;
  errors: number;
}
export interface WorkspaceShells {
  workspace: string;
  bash: ShellSide;
  ps: ShellSide;
  worse: "Bash" | "PowerShell";
  worseErrors: number;
  fires: boolean;
  /** worse rate / other rate; null when the other rate is 0. */
  ratio: number | null;
}

/** Per-workspace Bash vs PowerShell counts and the D11 rule, recounted from stored rows. */
export function shellAnalysis(db: Database.Database, now: Date): WorkspaceShells[] {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT s.workspace_id AS ws, e.tool_name AS tool,
              json_extract(c.content_json, '$.error') AS err
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id AND s.state = 'RECONCILED'
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.tool_name IN ('Bash', 'PowerShell') AND e.ts >= ? AND e.ts < ?`,
    )
    .all(from, to) as { ws: string; tool: string; err: unknown }[];

  const byWs = new Map<string, { bash: ShellSide; ps: ShellSide }>();
  for (const r of rows) {
    let w = byWs.get(r.ws);
    if (!w) {
      w = { bash: { calls: 0, errors: 0 }, ps: { calls: 0, errors: 0 } };
      byWs.set(r.ws, w);
    }
    const side = r.tool === "Bash" ? w.bash : w.ps;
    const err = typeof r.err === "string" ? r.err : null;
    if (err !== null && !startsWithExitCode(err)) continue; // never ran: left out
    side.calls += 1;
    if (err !== null && isShellLevelError(err)) side.errors += 1;
  }

  const out: WorkspaceShells[] = [];
  for (const [workspace, { bash, ps }] of byWs) {
    const bRate = bash.calls > 0 ? bash.errors / bash.calls : 0;
    const pRate = ps.calls > 0 ? ps.errors / ps.calls : 0;
    const worse: "Bash" | "PowerShell" = pRate > bRate ? "PowerShell" : "Bash"; // ties -> Bash
    const w = worse === "Bash" ? bash : ps;
    const o = worse === "Bash" ? ps : bash;
    const wRate = w.calls > 0 ? w.errors / w.calls : 0;
    const oRate = o.calls > 0 ? o.errors / o.calls : 0;
    const ratioOk = oRate === 0 ? wRate > 0 : w.errors * o.calls * 2 >= 3 * o.errors * w.calls;
    const fires =
      bash.calls >= MIN_CALLS && ps.calls >= MIN_CALLS && w.errors >= MIN_HIGHER_ERRORS && ratioOk;
    out.push({
      workspace,
      bash,
      ps,
      worse,
      worseErrors: w.errors,
      fires,
      ratio: oRate === 0 ? null : wRate / oRate,
    });
  }
  return out;
}

export function probeD11(db: Database.Database, now: Date): ProbeResult {
  const all = shellAnalysis(db, now);
  const cands = all.filter((w) => w.bash.errors + w.ps.errors >= 1);
  const qual = cands.filter((w) => w.fires);
  const best = qual[0] ?? [...cands].sort((a, b) => b.worseErrors - a.worseErrors)[0] ?? null;
  const gates: ProbeGate[] = [];
  if (best) {
    const minCalls = Math.min(best.bash.calls, best.ps.calls);
    gates.push({
      name: "D11_MIN_CALLS",
      value: minCalls,
      threshold: MIN_CALLS,
      op: ">=",
      pass: minCalls >= MIN_CALLS,
    });
    gates.push({
      name: "D11_MIN_HIGHER_ERRORS",
      value: best.worseErrors,
      threshold: MIN_HIGHER_ERRORS,
      op: ">=",
      pass: best.worseErrors >= MIN_HIGHER_ERRORS,
    });
    if (best.ratio === null) {
      // Other shell's rate is 0: the ratio test is replaced by "worse rate > 0".
      gates.push({
        name: "D11_RATE_RATIO (other rate 0: worse errors > 0)",
        value: best.worseErrors,
        threshold: 0,
        op: ">",
        pass: best.worseErrors > 0,
      });
    } else {
      gates.push({
        name: "D11_RATE_RATIO",
        value: best.ratio,
        threshold: RATE_RATIO,
        op: ">=",
        pass: best.ratio >= RATE_RATIO,
      });
    }
  }
  return {
    candidates: cands.length,
    qualifying: qual.length,
    gates,
    note:
      "Workspaces with >=1 shell-level Bash/PowerShell error (candidates); qualifying = both shells >=50 counted calls, " +
      "worse shell (higher rate, tie -> Bash) >=3 errors, rate >=1.5x other (or other rate 0 and worse >0). " +
      "Derivation: reconciled sessions, ts in [now-7d, now); counted call = no stored error OR stored error text starts 'Exit code N'; " +
      "error = that text also matches a shell-level pattern (command not found, not recognized as cmdlet, syntax error, " +
      "unexpected token/EOF, unmatched/unterminated quote, bad substitution, ParserError, '&&' not a valid statement separator). " +
      "Error text = tool_event_content.content_json $.error (raw tool_result is_error text); no exit_class read, so a live-copy run " +
      "should cross-check with a raw-JSONL is_error sample count. Gates shown are for the best workspace.",
  };
}
