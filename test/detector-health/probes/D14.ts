/**
 * DH2 probe for D14 (INTERRUPT_CANCEL_CLASSIFICATION_V2), written from its contract card only.
 * Read list: docs/plans/dh-contracts.md (header + D14 card); docs/plans/spec-detector-health.md (s2, s3 DH2 row);
 * base-table DDL dump (scratchpad ddl.sql); test/fixtures/detector-health/D14/{manifest.json,README.md,
 * positive/*.jsonl, near-miss/*.jsonl}; test/detector-health/{probes/types.ts,probes/index.ts,probes.test.ts,harness.ts,manifest.ts}.
 * Also saw (via a throwaway DB dump of the fixture, not source): the shape of tool_event_content.content_json.
 *
 * The card's trigger is a classifier output (tool_events.interrupt_kind / interrupt_classifier_version). Per the
 * spec exception this probe does NOT read those columns; it derives the classification from raw stored text:
 * tool_event_content.content_json -> $.error (the tool_result error text).
 *   pure interrupt   : error text starts with "[Request interrupted by user]" ("... for tool use]" is a human
 *                      rejection, not counted).
 *   killed/cancelled : error text matches /cancell?ed|killed|aborted/i and is not a human rejection.
 *   session-end cut  : error text matches /session (has )?(ended|end|closed|terminated)/i (excluded).
 *   relaxed candidate: any error text mentioning interrupt|cancel|kill|abort.
 * This is a text heuristic, so it can differ from the classifier on real data: expect disagreement to be explained.
 *
 * Other rules (card): tool event ts in window; owning turn (tool_event_metadata.owner_message_id) is non-sidechain
 * and non-provisional; session RECONCILED; good interrupt = a user prompt (ingest_metric_events.is_user_turn=1,
 * user_turn_ts, non-sidechain, not a compact summary) follows with <= 2 main settled turns strictly between the
 * event ts and the prompt ts. No later prompt = not a good interrupt. Group = (workspace, session, kind).
 *
 * RC-D14 (2026-10-15): a plain Esc is a user record of its own, with no tool event. Its text is not stored, so
 * this source reads ingest_metric_events (classifier-2, is_interrupt=1, main chain): the plain variant is the
 * one labelled interrupt-cancel; the "for tool use" variant (no label) is a human rejection, not counted. Kind
 * PURE; same session, prompt and group rules as above.
 */

import type Database from "better-sqlite3";
import type { Probe, ProbeGate } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const SESSION_END = /session (has )?(ended|end|closed|terminated)/i;
const HUMAN_REJECT = /for tool use|doesn't want to proceed|user rejected/i;

// DH2 live run 2026-10-13 (orchestrator fix, 6 hand-checked raw events): a call that ran and exited
// ("Exit code N ...") is not an interrupt even when its output says "killed"; Claude Code's own cut-off
// marker "[Tool call interrupted: ...]" is a killed call (then excluded below when the session ended).
function kindOf(text: string): "PURE" | "KILLED" | null {
  if (text.startsWith("[Request interrupted by user]")) return "PURE";
  if (/^Exit code \d+/.test(text)) return null;
  if (text.startsWith("[Tool call interrupted")) return "KILLED";
  if (HUMAN_REJECT.test(text)) return null;
  return /cancell?ed|killed|aborted/i.test(text) ? "KILLED" : null;
}

export const probeD14: Probe = (db: Database.Database, now: Date) => {
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = now.toISOString();

  const rows = db
    .prepare(
      `SELECT e.event_id, e.session_id, e.ts, s.workspace_id, s.state,
              json_extract(c.content_json, '$.error') AS err,
              o.is_sidechain AS o_side, o.provisional AS o_prov
       FROM tool_events e
       JOIN tool_event_content c ON c.event_id = e.event_id AND c.content_included = 1
       JOIN sessions s ON s.session_id = e.session_id
       LEFT JOIN tool_event_metadata md ON md.event_id = e.event_id
       LEFT JOIN turns o ON o.message_id = md.owner_message_id
       WHERE e.ts >= ? AND e.ts < ? AND json_extract(c.content_json, '$.error') IS NOT NULL`,
    )
    .all(from, to) as {
    event_id: string;
    session_id: string;
    ts: string;
    workspace_id: string;
    state: string;
    err: string | null;
    o_side: number | null;
    o_prov: number | null;
  }[];

  const nextPrompt = db.prepare(
    `SELECT MIN(user_turn_ts) AS p FROM ingest_metric_events
     WHERE session_id = ? AND is_user_turn = 1 AND is_compact_summary = 0 AND is_sidechain = 0 AND user_turn_ts > ?`,
  );
  const turnsBetween = db.prepare(
    "SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND is_sidechain = 0 AND provisional = 0 AND ts > ? AND ts < ?",
  );

  const candidateGroups = new Set<string>();
  const qualGroups = new Set<string>();
  let bestBetween: number | null = null; // smallest turns-before-prompt among otherwise-qualifying events
  let sessionEndCut = 0;
  let goodInterrupts = 0;
  let sawNoPrompt = false;

  for (const r of rows) {
    const text = r.err ?? "";
    const relaxed = /interrupt|cancel|kill|abort/i.test(text);
    if (!relaxed) continue;
    const kind = kindOf(text);
    candidateGroups.add(`${r.workspace_id}|${r.session_id}|${kind ?? "OTHER"}`);
    if (!kind) continue;
    if (r.state !== "RECONCILED" || r.o_side !== 0 || r.o_prov !== 0) continue;
    if (SESSION_END.test(text)) {
      sessionEndCut++;
      continue;
    }
    const pr = (nextPrompt.get(r.session_id, r.ts) as { p: string | null }).p;
    if (pr) {
      const between = (turnsBetween.get(r.session_id, r.ts, pr) as { n: number }).n;
      if (bestBetween === null || between > bestBetween) bestBetween = between;
      if (between <= 2) {
        goodInterrupts++;
        continue;
      }
    } else {
      sawNoPrompt = true;
    }
    qualGroups.add(`${r.workspace_id}|${r.session_id}|${kind}`);
  }

  const escRows = db
    .prepare(
      `SELECT x.session_id, x.event_ts AS ts, s.workspace_id, s.state, x.classifier_label AS label
       FROM ingest_metric_events x
       JOIN sessions s ON s.session_id = x.session_id
       WHERE x.event_ts >= ? AND x.event_ts < ? AND x.is_interrupt = 1 AND x.is_sidechain = 0
         AND x.classifier_version = 'classifier-2'`,
    )
    .all(from, to) as {
    session_id: string;
    ts: string;
    workspace_id: string;
    state: string;
    label: string | null;
  }[];
  for (const r of escRows) {
    const kind = r.label === "interrupt-cancel" ? "PURE" : null;
    candidateGroups.add(`${r.workspace_id}|${r.session_id}|${kind ?? "OTHER"}`);
    if (!kind || r.state !== "RECONCILED") continue;
    const pr = (nextPrompt.get(r.session_id, r.ts) as { p: string | null }).p;
    if (pr) {
      const between = (turnsBetween.get(r.session_id, r.ts, pr) as { n: number }).n;
      if (bestBetween === null || between > bestBetween) bestBetween = between;
      if (between <= 2) {
        goodInterrupts++;
        continue;
      }
    } else {
      sawNoPrompt = true;
    }
    qualGroups.add(`${r.workspace_id}|${r.session_id}|${kind}`);
  }

  const gates: ProbeGate[] = [
    {
      // Card constant: later main turns before user prompt, excluded when <= 2. Null = no later prompt (never excluded).
      name: "later main turns before user prompt",
      value: sawNoPrompt ? null : bestBetween,
      threshold: 2,
      op: ">",
      pass: sawNoPrompt || (bestBetween !== null && bestBetween > 2),
    },
    {
      name: "session-end cutoff events (excluded)",
      value: sessionEndCut,
      threshold: 0,
      op: "<=",
      pass: sessionEndCut === 0,
    },
  ];

  return {
    candidates: candidateGroups.size,
    qualifying: qualGroups.size,
    gates,
    note: `raw-text derived (no classifier columns): ${candidateGroups.size} session/kind groups mention interrupt|cancel|kill|abort; ${goodInterrupts} events excluded as good interrupts; ${sessionEndCut} session-end cutoffs; ${qualGroups.size} groups qualify`,
  };
};
