/**
 * DH2 probe for C9 DENIAL_FRICTION_V2, written from its contract card only.
 * Counts workspace x denial-kind groups with at least one main-chain denial in the window. Kinds
 * are derived from the stored tool error text (the app's label columns are not used):
 *   hook-block    "hook error" / "blocked by hook"
 *   deny-rule     "Permission to use ... has been denied"
 *   user-rejected "the user doesn't want to ..."
 * Interrupt text is not a denial. A user-rejected event on an AskUserQuestion call is excluded.
 * The session need not be reconciled. No minimum count beyond 1 (the API's floor is not applied).
 */

import type Database from "better-sqlite3";
import type { Probe } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EVENTS = 1;

type Kind = "HOOK_BLOCK" | "DENY_RULE" | "USER_REJECTED";

function kindOf(err: string): Kind | null {
  if (/request interrupted/i.test(err)) return null;
  // Auto-mode classifier denials are out of scope (operator 2026-10-14, F12).
  if (/auto mode classifier/i.test(err)) return null;
  if (/hook error|blocked by .*hook|hook blocked|hook.*(denied|blocked)/i.test(err)) {
    return "HOOK_BLOCK";
  }
  if (
    /permission to use .* has been denied|denied by .*(rule|permission)|permission.*denied/i.test(
      err,
    )
  ) {
    return "DENY_RULE";
  }
  if (/user doesn'?t want to|user rejected|user denied/i.test(err)) return "USER_REJECTED";
  return null;
}

interface CallRow {
  workspace_id: string;
  tool_name: string;
  is_sidechain: number | null;
  err: string | null;
}

export const probeC9: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const rows = db
    .prepare(
      `SELECT s.workspace_id AS workspace_id, te.tool_name AS tool_name,
              t.is_sidechain AS is_sidechain, json_extract(c.content_json, '$.error') AS err
         FROM tool_events te
         JOIN sessions s ON s.session_id = te.session_id
         JOIN tool_event_content c ON c.event_id = te.event_id
         LEFT JOIN tool_event_metadata m ON m.event_id = te.event_id
         LEFT JOIN turns t ON t.message_id = m.owner_message_id
        WHERE te.ts >= ? AND te.ts < ?`,
    )
    .all(from, to) as CallRow[];

  const all = new Map<string, number>();
  const kept = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.err !== "string") continue;
    const kind = kindOf(r.err);
    if (!kind) continue;
    const key = `${r.workspace_id}|${kind}`;
    all.set(key, (all.get(key) ?? 0) + 1);
    if (r.is_sidechain === 1) continue;
    if (kind === "USER_REJECTED" && r.tool_name === "AskUserQuestion") continue;
    kept.set(key, (kept.get(key) ?? 0) + 1);
  }

  const qualifying = [...kept.values()].filter((n) => n >= MIN_EVENTS).length;
  const bestCount = Math.max(0, ...kept.values());
  const events = [...kept.values()].reduce((a, b) => a + b, 0);

  return {
    candidates: all.size,
    qualifying,
    gates: [
      {
        name: "minimum denial events per workspace and label",
        value: bestCount,
        threshold: MIN_EVENTS,
        op: ">=",
        pass: bestCount >= MIN_EVENTS,
      },
    ],
    note: `${events} main-chain denial event(s) in ${qualifying} workspace x kind group(s); kind read from error text`,
  };
};
