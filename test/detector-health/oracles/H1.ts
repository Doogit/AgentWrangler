/**
 * H1 DESTRUCTIVE_OPERATION_REPORT_V2 count oracle, from the dh-contracts.md H1 card only.
 * Count = main-thread destructive-class commands per (workspace, class) in [now-7d, now) that actually ran.
 * A command is dropped only when every Bash call in the same session at the same timestamp never ran
 * (HUMAN_DENY interrupt, or stored error text showing a hook/guard block or a permission denial / user rejection);
 * no matching Bash row keeps it. Sidechain runs never fire; they are only reported beside a firing group.
 */

import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const NEVER_RAN =
  /hook error|hook blocked|blocked by (a )?hook|permission to use|permission denied|was denied|user (rejected|doesn't want|denied)|doesn't want to proceed/i;

interface Ev {
  session_id: string;
  event_ts: string;
  destructive_op: string;
  is_sidechain: number;
  workspace_id: string;
  file_path: string;
}

/** Raw reconciliation: the transcript has an assistant Bash tool_use at the timestamp with the class's shape. */
function reconcile(rows: Ev[]): { sampled: number; matched: number } {
  const re: Record<string, RegExp> = {
    "rm-rf": /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r|--recursive)/,
    "git-reset-hard": /git\s+reset\b[^|;&]*--hard/,
    "git-clean": /git\s+clean\b/,
    "sql-drop": /\bdrop\s+(table|database|schema|index|view)/i,
    truncate: /\btruncate\b/i,
  };
  const cache = new Map<string, string[] | null>();
  let sampled = 0;
  let matched = 0;
  for (const r of rows) {
    if (!cache.has(r.file_path)) {
      try {
        cache.set(r.file_path, fs.readFileSync(r.file_path, "utf8").split("\n"));
      } catch {
        cache.set(r.file_path, null);
      }
    }
    const lines = cache.get(r.file_path);
    if (!lines) continue;
    const line = lines.find((l) => l.includes(`"timestamp":"${r.event_ts}"`));
    if (!line) continue;
    sampled++;
    try {
      const o = JSON.parse(line) as {
        message?: {
          content?: Array<{ type?: string; name?: string; input?: { command?: string } }>;
        };
      };
      const hit = o.message?.content?.some(
        (b) =>
          b.type === "tool_use" &&
          (b.name === "Bash" || b.name === "PowerShell") &&
          re[r.destructive_op]?.test(b.input?.command ?? ""),
      );
      if (hit) matched++;
    } catch {
      /* not matched */
    }
  }
  return { sampled, matched };
}

export const oracleH1: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT m.session_id, m.event_ts, m.destructive_op, m.is_sidechain, s.workspace_id, s.file_path
       FROM ingest_metric_events m JOIN sessions s ON s.session_id = m.session_id
       WHERE m.destructive_op IS NOT NULL AND m.event_ts >= ? AND m.event_ts < ?
       ORDER BY m.event_ts`,
    )
    .all(from, to) as Ev[];

  const bash = db.prepare(
    `SELECT t.interrupt_kind, c.content_json
     FROM tool_events t LEFT JOIN tool_event_content c ON c.event_id = t.event_id
     WHERE t.session_id = ? AND t.ts = ? AND t.tool_name = 'Bash'`,
  );
  const neverRan = (r: Ev): boolean => {
    const calls = bash.all(r.session_id, r.event_ts) as Array<{
      interrupt_kind: string | null;
      content_json: string | null;
    }>;
    if (calls.length === 0) return false;
    return calls.every((c) => {
      if (c.interrupt_kind === "HUMAN_DENY") return true;
      if (!c.content_json) return false;
      try {
        const err = (JSON.parse(c.content_json) as { error?: string }).error ?? "";
        return NEVER_RAN.test(err);
      } catch {
        return false;
      }
    });
  };

  const groups = new Map<string, { ws: string; cls: string; main: number; side: number }>();
  const ran: Ev[] = [];
  for (const r of rows) {
    if (r.is_sidechain === 0 && neverRan(r)) continue;
    if (r.is_sidechain === 0) ran.push(r);
    const key = `${r.workspace_id}|${r.destructive_op}`;
    const g = groups.get(key) ?? { ws: r.workspace_id, cls: r.destructive_op, main: 0, side: 0 };
    if (r.is_sidechain === 0) g.main++;
    else g.side++;
    groups.set(key, g);
  }
  const findings: OracleFinding[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.ws.localeCompare(b.ws))) {
    if (g.main < 1) continue;
    findings.push({
      scope: { workspace_id: g.ws, key: `H1|${g.ws}|${g.cls}` },
      quantities: [
        { name: "operations", unit: "events", value: g.main },
        { name: "sidechain_operations", unit: "events", value: g.side },
      ],
      measured_u: null,
      assumptions: [],
      modeled_u: null,
      count: g.main,
    });
  }
  const rec = reconcile(ran);
  return {
    findings,
    turns_checked: [],
    note: `${ran.length} ran main-thread destructive ops in ${findings.length} groups (${rows.length} classified rows, ${rows.filter((r) => r.is_sidechain === 0).length - ran.length} never-ran drops); raw reconcile ${rec.matched}/${rec.sampled} of ${ran.length}`,
  };
};
