/**
 * C9 DENIAL_FRICTION_V2 count oracle, from the dh-contracts.md C9 card only.
 * Count = denial events per (workspace, label) in [now-7d, now): main chain, not an interrupt, labelled
 * hook-block / deny-rule / user-rejected; user-rejected dropped when the session's latest HUMAN_DENY tool call at
 * or before it was AskUserQuestion. Scopes under the API floor (< 5 denials) are not visible cards, so they are
 * not emitted as findings (counted in the note). HOOK_BLOCK scopes are also not emitted when every block's tool call
 * is read back from the raw JSONL (tool_use matched by the errored result's tool_use_id) and fewer than 3 per week
 * match the card's open-false-positive shapes (the card's "current message" currency test is not modelled).
 */

import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Oracle, OracleFinding } from "./types.js";

const DAY_MS = 86_400_000;
const FLOOR = 5;
const FP_PER_WEEK = 3;

interface EventRow {
  event_ts: string;
  session_id: string;
  workspace_id: string;
  classifier_label: string;
  file_path: string;
}

/** Raw reconciliation: the transcript line at the event timestamp is a main-chain errored tool_result of the right kind. */
function reconcile(rows: EventRow[]): { sampled: number; matched: number } {
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
        type?: string;
        isSidechain?: boolean;
        message?: { content?: Array<{ type?: string; is_error?: boolean; content?: unknown }> };
      };
      const b = o.message?.content?.[0];
      const text = typeof b?.content === "string" ? b.content : "";
      const kindOk =
        r.classifier_label === "hook-block"
          ? /hook error/i.test(text)
          : r.classifier_label === "deny-rule"
            ? /^Permission to use/i.test(text)
            : r.classifier_label === "user-rejected"
              ? text.length > 0
              : false;
      if (
        o.type === "user" &&
        o.isSidechain !== true &&
        b?.type === "tool_result" &&
        b.is_error === true &&
        !/auto mode classifier/i.test(text) &&
        kindOk
      )
        matched++;
    } catch {
      /* unparsable line counts as not matched */
    }
  }
  return { sampled, matched };
}

/** Read the blocked tool call back from the raw transcript: tool_use whose id the errored tool_result answers. */
function readBackCommand(rows: EventRow[]): Array<{ tool: string; command: string } | null> {
  const files = new Map<string, string[] | null>();
  const calls = new Map<string, Map<string, { tool: string; command: string }>>();
  return rows.map((r) => {
    if (!files.has(r.file_path)) {
      try {
        files.set(r.file_path, fs.readFileSync(r.file_path, "utf8").split("\n"));
      } catch {
        files.set(r.file_path, null);
      }
    }
    const lines = files.get(r.file_path);
    if (!lines) return null;
    const line = lines.find((l) => l.includes(`"timestamp":"${r.event_ts}"`));
    if (!line) return null;
    let id: string | undefined;
    try {
      id = (JSON.parse(line) as { message?: { content?: Array<{ tool_use_id?: string }> } }).message
        ?.content?.[0]?.tool_use_id;
    } catch {
      return null;
    }
    if (!id) return null;
    let byId = calls.get(r.file_path);
    if (!byId) {
      byId = new Map();
      for (const l of lines) {
        if (!l.includes('"tool_use"')) continue;
        try {
          const o = JSON.parse(l) as {
            message?: {
              content?: Array<{
                type?: string;
                id?: string;
                name?: string;
                input?: { command?: unknown };
              }>;
            };
          };
          // A blocked call with no command (e.g. an Agent call) is still read back: the card
          // gives it shape OTHER, which never counts as an open false positive.
          for (const b of o.message?.content ?? [])
            if (b.type === "tool_use" && b.id)
              byId.set(b.id, {
                tool: b.name ?? "",
                command: typeof b.input?.command === "string" ? b.input.command : "",
              });
        } catch {
          /* skip */
        }
      }
      calls.set(r.file_path, byId);
    }
    return byId.get(id) ?? null;
  });
}

/** Strip quoted segments so shapes can be told apart "inside a quoted argument" vs. at the top level. */
const unquote = (s: string): string => s.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');

/**
 * True when the card names this block's shape as an open guard false positive. Intended shapes (cd prefix,
 * in-place edit, heredoc file/stdin, worktree remove, destructive git) are checked first and never count.
 * The "current message" currency test is not modelled (the card does not give the message text).
 */
function isOpenFalsePositive(tool: string, cmd: string): boolean {
  const top = unquote(cmd);
  const cdPrefix = /^\s*cd\s[^;&|]*(&&|;)/.test(cmd);
  const inPlace = /\bsed\s+(-[a-z]*i|--in-place)|\bperl\s+-[a-z]*pi|\bperl\s+-0pi/.test(top);
  const heredocTop = /<<-?\s*['"]?\w+/.test(top) || /\$\(\s*cat\s*<</.test(cmd);
  const worktreeRemove =
    /\bgit\b.*\bworktree\s+remove\b|\bRemove-Item\b.*-Recurse|\brm\s+-[a-z]*r[a-z]*f?\b|\brmdir\b/i.test(
      top,
    );
  const destructiveGit =
    /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|restore\b|push\s+--force)/.test(top);
  if (cdPrefix || inPlace || heredocTop || worktreeRemove || destructiveGit) return false;
  const pyTop = /\bpython[\d.]*\s+-c\b/.test(top);
  const pyAny = /\bpython[\d.]*\s+-c\b/.test(cmd);
  if (pyAny && !pyTop) return true; // QUOTED_PATTERN
  if (pyTop && !/\.write\(|open\([^)]*['"][wax]|os\.remove|shutil|unlink|rename\(/.test(cmd))
    return true; // PYTHON_READ
  if (/<</.test(cmd) && !/<</.test(top)) return true; // QUOTED_HEREDOC
  if (
    /\bgit\s+stash\s+(list|show)\b/.test(top) &&
    !/\bgit\s+stash\s+(push|pop|apply|drop|save|clear)\b/.test(top)
  )
    return true; // GIT_STASH_READ
  if (
    /(jobs[\\/][\w-]+|CLAUDE_JOB_DIR|scratchpad)[\w${}\\/.-]*[\\/]tmp[\\/]/i.test(cmd) &&
    !/(^|[\s"'=>])\/tmp\//.test(cmd)
  )
    return true; // SCRATCH_TMP / PS_SCRATCH_TMP
  if (tool === "PowerShell" && /\bnode\s+-e[A-Za-z]+/i.test(top) && !/\bnode\s+-e\b/.test(top))
    return true; // PS_NODE_FLAG
  return false;
}

export const oracleC9: Oracle = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT m.event_ts, m.session_id, s.workspace_id, m.classifier_label, s.file_path
       FROM ingest_metric_events m JOIN sessions s ON s.session_id = m.session_id
       WHERE m.event_ts >= ? AND m.event_ts < ? AND m.is_sidechain = 0 AND m.is_interrupt = 0
         AND m.classifier_label IN ('hook-block','deny-rule','user-rejected')
       ORDER BY m.event_ts`,
    )
    .all(from, to) as EventRow[];

  const lastDeny = db.prepare(
    `SELECT tool_name FROM tool_events
     WHERE session_id = ? AND interrupt_kind = 'HUMAN_DENY' AND ts <= ?
     ORDER BY ts DESC LIMIT 1`,
  );
  const kept = rows.filter((r) => {
    if (r.classifier_label !== "user-rejected") return true;
    const d = lastDeny.get(r.session_id, r.event_ts) as { tool_name: string } | undefined;
    return d?.tool_name !== "AskUserQuestion";
  });

  const groups = new Map<string, { ws: string; label: string; n: number; rows: EventRow[] }>();
  for (const r of kept) {
    const key = `${r.workspace_id}|${r.classifier_label}`;
    const g = groups.get(key) ?? { ws: r.workspace_id, label: r.classifier_label, n: 0, rows: [] };
    g.n++;
    g.rows.push(r);
    groups.set(key, g);
  }
  const findings: OracleFinding[] = [];
  let belowFloor = 0;
  let fpFloor = 0;
  for (const g of [...groups.values()].sort((a, b) => a.ws.localeCompare(b.ws))) {
    if (g.n < FLOOR) {
      belowFloor++;
      continue;
    }
    if (g.label === "hook-block") {
      // Card: below_floor when every block was read back with a guard shape and < 3/week are open false positives.
      const calls = readBackCommand(g.rows);
      const allRead = calls.every((c) => c !== null);
      if (allRead) {
        const fp = calls.filter((c) => c && isOpenFalsePositive(c.tool, c.command)).length;
        if (fp < FP_PER_WEEK /* window is exactly 1 week */) {
          fpFloor++;
          continue;
        }
      }
    }
    findings.push({
      scope: { workspace_id: g.ws, key: `C9|${g.ws}|${g.label}` },
      quantities: [{ name: "denial_events", unit: "events", value: g.n }],
      measured_u: null,
      assumptions: [],
      modeled_u: null,
      count: g.n,
    });
  }
  const rec = reconcile(kept);
  return {
    findings,
    turns_checked: [],
    note: `${kept.length} denial events in ${groups.size} groups (${findings.length} visible >= ${FLOOR}, ${belowFloor} below the 5-denial floor, ${fpFloor} HOOK_BLOCK below_floor on guard false positives; ${rows.length - kept.length} AskUserQuestion exclusions); raw reconcile ${rec.matched}/${rec.sampled} of ${kept.length}`,
  };
};
