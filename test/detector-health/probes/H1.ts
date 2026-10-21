/**
 * DH2 probe for H1 DESTRUCTIVE_OPERATION_REPORT_V2 (contract card H1).
 * One finding per (workspace, destructive class) when a main-thread Bash command of one of five
 * classes ran in the window. Sidechain runs never fire. A run is dropped only when every Bash call
 * at the same session and timestamp shows it never ran.
 *
 * The ingest classifier column (destructive_op) is NOT read. The class is re-derived from the raw
 * stored command text with the regexes below; "never ran" is re-derived from the stored raw error
 * text (user rejected / hook or guard blocked / permission denied). Approximations: a command is
 * matched anywhere in its text (including inside quotes); "rm -rf" = rm with both recursive and
 * force flags; sql-drop = DROP TABLE/DATABASE/SCHEMA/INDEX/VIEW; truncate = `truncate` word.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeResult } from "./types.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type DestructiveClass = "rm-rf" | "git-reset-hard" | "git-clean" | "sql-drop" | "truncate";

const NEVER_RAN_RE =
  /doesn't want to proceed|user (rejected|declined|denied)|was rejected|blocked by (a |the )?hook|hook .*(blocked|denied|rejected)|operation blocked|permission (to use .*)?(has been )?denied|denied by|deny rule/i;

function rmRf(cmd: string): boolean {
  for (const m of cmd.matchAll(/\brm\b((?:\s+-{1,2}[A-Za-z-]+)+)/g)) {
    const flags = m[1] ?? "";
    const short = [...flags.matchAll(/\s-([A-Za-z]+)/g)].map((x) => x[1]).join("");
    const recursive = /[rR]/.test(short) || /--recursive/.test(flags);
    const force = /f/.test(short) || /--force/.test(flags);
    if (recursive && force) return true;
  }
  return false;
}

// `git` plus any global options (`-C <path>`, `-c k=v`, `--no-pager`) before the subcommand.
const GIT = String.raw`\bgit(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--[\w-]+(?:=\S+)?)*\s+`;
const GIT_RESET_HARD = new RegExp(`${GIT}reset\\b[^\\n;&|]*--hard\\b`);
const GIT_CLEAN = new RegExp(`${GIT}clean\\b`);

/** Destructive classes found in a raw command line. */
export function classify(cmd: string): DestructiveClass[] {
  const out: DestructiveClass[] = [];
  if (rmRf(cmd)) out.push("rm-rf");
  if (GIT_RESET_HARD.test(cmd)) out.push("git-reset-hard");
  if (GIT_CLEAN.test(cmd)) out.push("git-clean");
  if (/\bdrop\s+(table|database|schema|index|view)\b/i.test(cmd)) out.push("sql-drop");
  if (/\btruncate\b/i.test(cmd)) out.push("truncate");
  return out;
}

interface Row {
  event_id: string;
  session_id: string;
  workspace_id: string;
  ts: string;
  command: string | null;
  error: string | null;
  main: number;
}

export const probeH1: Probe = (db: Database.Database, now: Date): ProbeResult => {
  const to = now.toISOString();
  const from = new Date(now.getTime() - WEEK_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT e.event_id AS event_id, e.session_id AS session_id, s.workspace_id AS workspace_id, e.ts AS ts,
              json_extract(c.content_json, '$.command') AS command,
              json_extract(c.content_json, '$.error') AS error,
              CASE WHEN t.message_id IS NOT NULL AND t.is_sidechain = 0 THEN 1 ELSE 0 END AS main
         FROM tool_events e
         JOIN sessions s ON s.session_id = e.session_id
         LEFT JOIN tool_event_content c ON c.event_id = e.event_id
         LEFT JOIN tool_event_metadata m ON m.event_id = e.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
        WHERE e.tool_name = 'Bash' AND e.ts >= ? AND e.ts < ?`,
    )
    .all(from, to) as Row[];

  // Never-ran test: every Bash call at the same (session, ts) shows an error that says it never ran.
  const bySlot = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.session_id}\u0000${r.ts}`;
    bySlot.set(k, [...(bySlot.get(k) ?? []), r]);
  }
  const neverRan = (r: Row): boolean => {
    const slot = bySlot.get(`${r.session_id}\u0000${r.ts}`) ?? [];
    return slot.length > 0 && slot.every((x) => x.error !== null && NEVER_RAN_RE.test(x.error));
  };

  const candidateGroups = new Set<string>(); // any destructive command, any chain, ran or not
  const firingGroups = new Set<string>(); // main-thread, ran
  for (const r of rows) {
    if (r.command === null) continue;
    for (const cls of classify(r.command)) {
      const key = `${r.workspace_id}\u0000${cls}`;
      candidateGroups.add(key);
      if (r.main && !neverRan(r)) firingGroups.add(key);
    }
  }

  return {
    candidates: candidateGroups.size,
    qualifying: firingGroups.size,
    gates: [
      {
        name: "minimum operations",
        value: firingGroups.size,
        threshold: 1,
        op: ">=",
        pass: firingGroups.size >= 1,
      },
    ],
    note: "(workspace, destructive class) groups with a main-thread Bash command that ran; candidates also count sidechain and never-ran commands. Class re-derived from raw command text (rm -rf, git reset --hard, git clean, SQL drop, truncate); never-ran from raw error text.",
  };
};
