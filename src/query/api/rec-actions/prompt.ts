import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { callLine, sessionTotal } from "./trigger.js";
import type { CardActionRecommendation, CardToolCall } from "./types.js";

export const TRANSCRIPTS =
  "Each session's transcript is `~/.claude/projects/<project folder>/<session id>.jsonl`; find it by the session id. Subagent transcripts are in `~/.claude/projects/<project folder>/<session id>/subagents/`.";

/**
 * U9 r8: the first line of the user's ~/.claude/CLAUDE.md that `test` accepts, cleaned for quoting
 * (no list marker, bold or backticks; cut at a word boundary), or null. Cards use it to say a rule
 * already exists and was not followed, instead of shipping the same rule again.
 */
export function existingUserRule(
  test: (row: string) => boolean,
  home = os.homedir(),
  focus?: RegExp,
): { file: string; line: string } | null {
  let text: string;
  try {
    text = readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/).find(test);
  if (line === undefined) return null;
  const clean = line
    .replace(/^[\s\-*]+/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
  // Cut at a word boundary with an ellipsis so the quote never ends mid-word or leaves a backtick open.
  // `focus` centres a long line on the phrase the card is about, so the quote shows that phrase.
  const at = focus === undefined ? -1 : clean.search(focus);
  const cut =
    clean.length <= 220
      ? clean
      : at > 120
        ? `... ${clean
            .slice(at - 100, at + 120)
            .replace(/^\S*\s+/, "")
            .replace(/\s+\S*$/, "")} ...`
        : `${clean.slice(0, 220).replace(/\s+\S*$/, "")} ...`;
  return { file: "~/.claude/CLAUDE.md", line: cut };
}

/**
 * A self-contained Claude Code prompt: the pasted session cannot see AgentWrangler, so it
 * carries the context and findings, then investigate → plan → confirm → apply → verify.
 */
export function cardPrompt(parts: {
  title: string;
  intro: string;
  context: string[];
  findings: string[];
  fix: string;
  steps: string[];
  notes: string[];
}): string {
  return [
    `# ${parts.title}`,
    "",
    `AgentWrangler (a local Claude Code spend monitor) ${parts.intro}`,
    "",
    "## Context",
    ...parts.context.map((line) => `- ${line}`),
    "",
    "## Findings",
    ...parts.findings,
    "",
    "## Fix",
    parts.fix,
    "",
    "## Steps",
    ...parts.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(parts.notes.length === 0
      ? []
      : ["", "## Notes", ...parts.notes.map((line) => `- ${line}`)]),
  ].join("\n");
}

/** The sessions behind a card, as a findings line. */
export function sessionsLine(
  sessionIds: string[],
  total: number | null = null,
  label = "Sessions",
): string {
  if (sessionIds.length === 0)
    return `- ${label}: not recorded; use the most recent sessions in this project`;
  const more =
    total !== null && total > sessionIds.length
      ? ` (${total} in total; ${sessionIds.length} listed)`
      : "";
  return `- ${label}${more}: ${sessionIds.join(", ")}`;
}

/** The calls read back from the transcripts, one findings line each. */
export function callLines(calls: readonly CardToolCall[] | undefined): string[] {
  return (calls ?? []).map((call) => `- ${callLine(call)}`);
}

/** Findings: the measured lines, the sessions, then the calls read back (or how to find them). */
export function callFindings(
  rec: CardActionRecommendation,
  sessionIds: string[],
  measured: string[],
  searchHint: string,
): string[] {
  const calls = rec.tool_calls ?? [];
  return [
    ...measured,
    sessionsLine(sessionIds, sessionTotal(rec)),
    ...(calls.length === 0
      ? [`- No calls could be read back; ${searchHint}`]
      : [
          "",
          "Calls read back from the transcripts (tool, how often, what Claude Code returned):",
          ...callLines(calls),
        ]),
  ];
}
