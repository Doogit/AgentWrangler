/**
 * DH2 probe for C5 SAME_ERROR_LOOP_V2 (contract card C5).
 * Per reconciled session: errored calls on main-chain settled turns, grouped by tool name and
 * normalized error text, one error per owning turn, split into runs at gaps > 10 min; a run of
 * >= 3 errors is a loop.
 *
 * No classifier columns are read. "Errored" = the stored raw error text exists (content_json.error).
 * Exclusions (hook-block / deny-rule / user-rejected / benign) are re-derived from the raw error
 * text and command text with the regexes below; the browser-batch-answer benign case is not
 * modelled (documented approximation).
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeResult } from "./types.js";

const C5_MIN_IDENTICAL_ERRORS = 3;
const C5_MAX_RETRY_GAP_MS = 600_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ErrCall {
  workspace_id: string;
  session_id: string;
  event_id: string;
  ts: string;
  tool_name: string;
  owner: string | null;
  owner_main: number;
  owner_settled: number;
  session_reconciled: number;
  error: string;
  command: string | null;
}

const DENIAL_RE =
  /doesn't want to proceed|user (rejected|declined|denied)|was rejected|blocked by (a |the )?hook|hook .*(blocked|denied|rejected)|operation blocked|permission (to use .*)?(has been )?denied|denied by|deny rule|permission denied by/i;
const NOT_READ_RE = /has not been read yet|file has not been read|must read .* first/i;
const BROWSER_TIMEOUT_RE = /timed out|timeout|bridge/i;
const BUILD_CMD_RE =
  /\b(npm (run )?(test|lint|build|typecheck)|npx (vitest|jest|tsc|biome|eslint)|vitest|jest|pytest|tsc|eslint|biome|cargo (test|build)|go (test|build)|make|mvn|gradle|dotnet (test|build))\b/i;
const GIT_QUIET_RE = /\bgit\b.*\bdiff\b.*(--quiet|--exit-code)/i;

/** Raw-text re-derivation of C5/C7's exclusion list. */
export function isExcluded(c: Pick<ErrCall, "tool_name" | "error" | "command">): boolean {
  const err = c.error;
  if (DENIAL_RE.test(err)) return true;
  // F32: a shell error without "Exit code N" never ran (a guard's own deny text, a denial).
  if ((c.tool_name === "Bash" || c.tool_name === "PowerShell") && !/^\s*Exit code -?\d+/i.test(err))
    return true;
  if ((c.tool_name === "Edit" || c.tool_name === "Write") && NOT_READ_RE.test(err)) return true;
  if (
    c.tool_name.startsWith("mcp__") &&
    /chrome|browser/i.test(c.tool_name) &&
    BROWSER_TIMEOUT_RE.test(err)
  )
    return true;
  if (c.tool_name === "Bash" && c.command) {
    const code = /^Exit code (\d+)/.exec(err)?.[1];
    if (BUILD_CMD_RE.test(c.command)) return true;
    if (/\btaskkill\b/i.test(c.command) && code === "128") return true;
    if (GIT_QUIET_RE.test(c.command) && code === "1") return true;
  }
  // A silent port probe exits 1 when the port is free (any shell tool).
  if (c.command && err.trim() === "Exit code 1" && /\bGet-NetTCPConnection\b/i.test(c.command))
    return true;
  return false;
}

/** Errored calls (raw error text present) in the window, with owner-turn and session facts. */
export function loadErrCalls(db: Database.Database, from: string, to: string): ErrCall[] {
  return db
    .prepare(
      `SELECT s.workspace_id AS workspace_id, e.session_id AS session_id, e.event_id AS event_id,
              e.ts AS ts, e.tool_name AS tool_name, m.owner_message_id AS owner,
              CASE WHEN t.message_id IS NOT NULL AND t.is_sidechain = 0 THEN 1 ELSE 0 END AS owner_main,
              CASE WHEN t.message_id IS NOT NULL AND t.provisional = 0 THEN 1 ELSE 0 END AS owner_settled,
              CASE WHEN s.state = 'RECONCILED' THEN 1 ELSE 0 END AS session_reconciled,
              json_extract(c.content_json, '$.error') AS error,
              json_extract(c.content_json, '$.command') AS command
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id
         JOIN tool_event_content c ON c.event_id = e.event_id
         LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
        WHERE e.ts >= ? AND e.ts < ?
          AND json_type(c.content_json, '$.error') = 'text'
          AND trim(json_extract(c.content_json, '$.error')) <> ''
        ORDER BY e.ts, e.event_id`,
    )
    .all(from, to) as ErrCall[];
}

function norm(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Longest run (same group, gap <= 10 min) sizes per group, one error per owning turn. */
function groupRuns(calls: ErrCall[], useGap: boolean): Map<string, number[]> {
  const groups = new Map<string, Map<string, number>>(); // key -> owner -> earliest ms
  for (const c of calls) {
    const text = norm(c.error);
    if (text === "") continue;
    const key = `${c.session_id}\u0000${c.tool_name}\u0000${text}`;
    const owner = c.owner ?? c.event_id;
    const g = groups.get(key) ?? new Map<string, number>();
    const ms = Date.parse(c.ts);
    const prev = g.get(owner);
    if (prev === undefined || ms < prev) g.set(owner, ms);
    groups.set(key, g);
  }
  const out = new Map<string, number[]>();
  for (const [key, g] of groups) {
    const times = [...g.values()].sort((a, b) => a - b);
    const runs: number[] = [];
    let n = 0;
    let last = Number.NEGATIVE_INFINITY;
    for (const t of times) {
      if (n > 0 && (!useGap || t - last <= C5_MAX_RETRY_GAP_MS)) n++;
      else {
        if (n > 0) runs.push(n);
        n = 1;
      }
      last = t;
    }
    if (n > 0) runs.push(n);
    out.set(key, runs);
  }
  return out;
}

const sessionOf = (key: string): string => key.split("\u0000")[0] ?? "";

export const probeC5: Probe = (db: Database.Database, now: Date): ProbeResult => {
  const to = now.toISOString();
  const from = new Date(now.getTime() - WEEK_MS).toISOString();
  const all = loadErrCalls(db, from, to);

  // Relaxed: every errored call, no exclusions/chain/state filter, no gap split; a repeat is >= 2.
  const relaxed = groupRuns(all, false);
  const candidateSessions = new Set<string>();
  for (const [key, runs] of relaxed)
    if (runs.some((n) => n >= 2)) candidateSessions.add(sessionOf(key));

  // Exact: reconciled session, main-chain settled owner turn, not excluded, gap-split runs.
  const exactCalls = all.filter(
    (c) => c.session_reconciled && c.owner_main && c.owner_settled && !isExcluded(c),
  );
  const exact = groupRuns(exactCalls, true);
  const loopSessions = new Set<string>();
  let best = 0;
  for (const [key, runs] of exact) {
    const m = Math.max(0, ...runs);
    if (m > best) best = m;
    if (m >= C5_MIN_IDENTICAL_ERRORS) loopSessions.add(sessionOf(key));
  }

  return {
    candidates: candidateSessions.size,
    qualifying: loopSessions.size,
    gates: [
      {
        name: "C5_MIN_IDENTICAL_ERRORS",
        value: best,
        threshold: C5_MIN_IDENTICAL_ERRORS,
        op: ">=",
        pass: best >= C5_MIN_IDENTICAL_ERRORS,
      },
    ],
    note: "Sessions with a run of >= 3 identical (tool, normalized error text) errors on distinct main-chain settled turns, gaps <= 10 min (qualifying); candidates = sessions with any repeated (>= 2) identical error before exclusions. Errored = stored raw error text; denial/benign exclusions re-derived from text (browser-batch case not modelled).",
  };
};
