import { numberMetric, withTargetMetric } from "../accessor.js";
import type { CardActionOption, CardActions, FamilyHandler } from "../types.js";

/** U8: E1, long orientation before the first edit. */
export const ORIENTATION_DETECTOR_IDS = ["E1"] as const;

function count(value: number | null, fallback: string): string {
  return value === null ? fallback : value.toLocaleString("en-US");
}

function option(
  option_id: string,
  kind: CardActionOption["kind"],
  summary: string,
  detail: string[],
  copy_text: string,
  file_ref: string | null,
): CardActionOption {
  return { option_id, kind, summary, detail, copy_text, file_ref };
}

function e1Actions(rec: Parameters<FamilyHandler>[0]): CardActions {
  const long = count(numberMetric(rec, "SESSIONS_OVER_P75"), "Several");
  const p50 = numberMetric(rec, "PRE_EDIT_P50");
  const p75 = numberMetric(rec, "PRE_EDIT_P75");
  // The repo files the long starts read most before editing, as an example of the block's shape.
  // Files outside the repo (absolute or home paths) would not resolve for the next session.
  const files = (rec.tool_calls ?? [])
    .filter((call) => call.tool === "Read" && !/^([A-Za-z]:|[/\\~])/.test(call.target))
    .slice(0, 3);
  const block = [
    '## Start every handoff with a "Start here" block',
    "Before the first edit, a session should already know where to start. Each handoff or task prompt opens with:",
    "- Files: the 2-4 files the task edits or must read, each with line ranges (`path:120-180`), not the whole file.",
    "- Next command: the first command to run (for example `npx vitest run test/foo.test.ts`).",
    "- Gate: the check that proves the change works (for example `npm run verify:app`).",
    "Open other files only when the edit needs them.",
    ...(files.length === 0
      ? []
      : [
          "",
          "Example from this project's recent long starts (replace with the task's own files):",
          ...files.map(
            (call) =>
              `- \`${call.target}\`: read before the first edit in ${call.session_count} of ${long.toLowerCase()} long starts`,
          ),
        ]),
  ].join("\n");
  return {
    primary: option(
      "e1-start-here-block",
      "EDIT",
      `Open each task with a "Start here" block: ${long} sessions made ${p75 === null ? "more model calls than usual" : `more than ${count(p75, "")} model calls`} before their first edit${p50 === null ? "" : ` (${count(p50, "")} is typical here)`}.`,
      [
        "Paste the rule into CLAUDE.md once; paste the example files into a handoff only if the next task needs them.",
        files.length === 0
          ? "No pre-edit reads of repo files could be read back from the transcripts, so the rule has no example."
          : "The example files are the repo files those sessions read most before editing.",
        "The saving assumes half of the extra calls are avoidable; that is an assumption, not a measurement.",
      ],
      block,
      "CLAUDE.md",
    ),
    alternatives: [],
  };
}

export const orientationHandler: FamilyHandler = (rec) =>
  rec.detector_id === "E1" ? withTargetMetric(e1Actions(rec), "pre_edit_excess_turns") : null;
