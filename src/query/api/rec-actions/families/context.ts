import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { A1_RESULT_BYTES_THRESHOLD } from "../../../../detector/savings.js";
import { numberMetric, stringMetric } from "../accessor.js";
import { TRANSCRIPTS, cardPrompt, existingUserRule, sessionsLine } from "../prompt.js";
import {
  D6_TARGET_EVENTS,
  SCRATCH_FILE,
  byteAmount,
  byteAmountIEC,
  callLine,
  callUsage,
  d2SessionLines,
  leadCall,
  listedCalls,
  repeatedBytesByTool,
  sessionTotal,
  times,
  tokenAmount,
} from "../trigger.js";
import type { CardActionOption, CardActions, CardToolCall, FamilyHandler } from "../types.js";

export const CONTEXT_DETECTOR_IDS = ["D1", "A1", "A2", "D6", "D10", "D2"] as const;

/** U9: D6's proposed CLAUDE.md line. */
export const D6_READ_RULE =
  "Before reading a file over about 300 lines, Grep for what you need and Read only that range with offset and limit; pipe command output through grep, head or tail.";

function numberFrom(rec: Parameters<FamilyHandler>[0], ...keys: string[]): number | null {
  for (const key of keys) {
    const value = numberMetric(rec, key);
    if (value !== null) return value;
  }
  return null;
}

function labelNumber(value: number | null, fallback: string): string {
  return value === null ? fallback : value.toLocaleString("en-US");
}

/**
 * A path under the home folder as `~/…` with forward slashes: shorter, no username, and it
 * resolves on any machine and shell. Other paths are returned unchanged.
 */
export function displayPath(filePath: string, home = os.homedir()): string {
  const rel = path.relative(home, filePath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return filePath;
  return `~/${rel.split(path.sep).join("/")}`;
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

/** Markdown sections by `#`–`###` heading, each sized as its share of `totalTokens`, largest first. */
function largestSections(
  fileRef: string | null,
  totalTokens: number | null,
): Array<{ name: string; tokens: number }> {
  if (fileRef === null || totalTokens === null) return [];
  let text: string;
  try {
    text = readFileSync(fileRef, "utf8");
  } catch {
    return [];
  }
  const sections: Array<{ name: string; chars: number }> = [];
  let current = { name: "Intro", chars: 0 };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading?.[1]) {
      if (current.chars > 0) sections.push(current);
      current = { name: heading[1].trim(), chars: 0 };
    }
    current.chars += line.length + 1;
  }
  if (current.chars > 0) sections.push(current);
  const totalChars = sections.reduce((sum, section) => sum + section.chars, 0);
  // One section is the whole file again, so it tells the reader nothing.
  if (totalChars === 0 || sections.length < 2) return [];
  return sections
    .map((section) => ({
      name: section.name,
      tokens: Math.round((section.chars / totalChars) * totalTokens),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
}

/** A measured file's own character count, or `null` when it cannot be read back. */
function fileCharCount(fileRef: string | null): number | null {
  if (fileRef === null) return null;
  try {
    return readFileSync(fileRef, "utf8").length;
  } catch {
    return null;
  }
}

/** The longest non-blank lines of a memory index with their size, so the card names real entries. */
function longestIndexLines(fileRef: string | null): Array<{ text: string; tokens: number }> {
  if (fileRef === null) return [];
  let text: string;
  try {
    text = readFileSync(fileRef, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => ({
      text: line.length > 80 ? `${line.slice(0, 79)}…` : line,
      tokens: Math.ceil((line.length + 1) / 4),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
}

const MEMORY_SWEEP_SKILL = path.join(".claude", "skills", "memory-sweep", "SKILL.md");

interface D1PromptFacts {
  lineList?: string[];
  sweepSkill?: boolean;
  file: string;
  isMemory: boolean;
  isGlobal: boolean;
  measured: boolean;
  quantity: string;
  source: string;
  target: string;
  turnsPerWeek: string;
  workspaces: string;
  extraPerWeek: string | null;
  window: string | null;
  sectionList: string;
  charTarget: number | null;
}

function whatTheFileIs(facts: D1PromptFacts): string {
  if (facts.isMemory) {
    return "This is Claude Code's auto-memory index for one workspace. Claude Code loads it at the start of every session in that workspace; the topic files it links to are read only when needed, so detail belongs in them. Keep the existing format of the index lines and topic files.";
  }
  return facts.isGlobal
    ? "This is the user-level Claude Code instruction file. Claude Code loads it at the start of every session in every workspace, so every token in it is re-sent on every turn everywhere."
    : "This is the project CLAUDE.md for one repo. Claude Code loads it at the start of every session opened in that repo, so every token in it is re-sent on every turn there.";
}

/**
 * A self-contained Claude Code prompt: the pasted session cannot see AgentWrangler, so it carries
 * the context and findings, then investigate → plan → confirm → apply → verify for one chosen fix.
 */
function d1Prompt(facts: D1PromptFacts, fix: string, planStep: string): string {
  const { file, target, quantity } = facts;
  // R6-09: a measured card's target is in tokens, but a chars/4 estimate drifts from this file's
  // own characters-per-token ratio, so step 2 can pass while the card still fires. Measured, give
  // the target in characters at this file's own ratio; unmeasured, chars/4 is the card's own basis.
  const charTargetLabel =
    facts.measured && facts.charTarget !== null ? facts.charTarget.toLocaleString("en-US") : null;
  const measureStep =
    charTargetLabel === null
      ? "2. Measure its size: characters divided by 4 gives estimated tokens. Say whether it matches the finding above."
      : `2. Measure its size in characters. Say whether it matches the finding above: target about ${charTargetLabel} characters, this file's own characters-per-token ratio applied to the ${target} target.`;
  const verifyStep =
    charTargetLabel === null
      ? `7. Verify: re-read ${file}, report its new characters/4 estimate against the ${target} target, and check that every link or pointer you added resolves to a real file.`
      : `7. Verify: re-read ${file}, report its new size in characters against the ${charTargetLabel}-character target, and check that every link or pointer you added resolves to a real file.`;
  return [
    `# Trim always-loaded context in ${file}`,
    "",
    "AgentWrangler (a local Claude Code spend monitor) found that this file loads into every turn and is over its size target. Investigate it and apply the fix below.",
    "",
    "## Context",
    `- ${whatTheFileIs(facts)}`,
    `- Size is ${facts.measured ? "measured from the file's content" : "a characters/4 estimate"}${facts.window ? `, observed ${facts.window}` : ""}.`,
    `- The ${target}-token target is AgentWrangler's suggested default size for ${facts.isMemory ? "a memory index" : "a CLAUDE.md"}, not a Claude Code limit or a measured optimum. ${facts.isMemory ? "The turn count includes the main conversation and forked subagents only." : "The turn count includes every main-conversation turn and every subagent turn except Explore and Plan agents, which are assumed not to load this file; the other subagents are assumed to load it, which was not checked per agent."}`,
    file.startsWith("~/")
      ? "- Paths below start at your home folder (~), so you can run this from any folder."
      : "- Paths below are absolute, so you can run this from any folder.",
    "",
    "## Findings",
    `- File: ${file}`,
    `- Size: ${facts.source} ${quantity}; target ${target} or less`,
    `- Loaded on about ${facts.turnsPerWeek} turns per week; workspaces: ${facts.workspaces}`,
    ...(facts.extraPerWeek
      ? [`- The excess over target costs ${facts.extraPerWeek} tokens per week`]
      : []),
    ...(facts.sectionList ? [`- Largest sections: ${facts.sectionList}`] : []),
    ...(facts.lineList && facts.lineList.length > 0
      ? ["- Longest index lines (about 4 characters per token):", ...facts.lineList]
      : []),
    "",
    "## Fix",
    fix,
    ...(facts.sweepSkill
      ? [
          "",
          "You already have a `/memory-sweep` skill (~/.claude/skills/memory-sweep) that prunes resolved and duplicate memories and shrinks this index to one-line entries. Run it first; use the steps below for whatever it leaves over the target.",
        ]
      : []),
    "",
    "## Steps",
    `1. Read ${file} in full.${facts.isMemory ? " Also read the topic files it links to." : ""}`,
    measureStep,
    `3. ${planStep}`,
    `4. Write the plan as a table: section or entry, action, destination, estimated tokens saved. Show the new estimated total; it must reach ${target} or less. If the target can't be reached without dropping rules still in force, stop and report the lowest safe size.`,
    "5. Ask me to confirm the plan before changing any file.",
    "6. After I confirm, make all edits in one batch. Moved content must stay reachable through a one-line link or pointer. A pointer is a plain path, not an `@path` import: an import still loads the file into every session. Do not drop a rule that is still in force.",
    verifyStep,
    "8. In a new session, run /context and check that the moved content no longer appears under Memory files.",
    "",
    "## Notes",
    "- Editing this file invalidates the cached prompt prefix once (one full-price cache write). Do it at a task boundary and run /clear afterwards, not in the middle of other work.",
    "- A trim that forces rules to be re-explained later is not a win: keep anything used on most turns.",
  ].join("\n");
}

const count = (value: number): string => value.toLocaleString("en-US");

/** How to get the same answer with a smaller result, when no call could be read back. */
const NARROWER_CALLS =
  "Ask each call for only what the task needs: Grep for line numbers, then Read with offset and limit; pipe command output through grep, head or tail; search with files_with_matches first; give WebFetch a specific question; and use a tool's own filter and limit arguments.";

const SKILL_FILE = /(^|\/)\.claude\/(skills|plugins)\//;
/** Code the user owns and can split; docs and data are read for their content instead. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|kt|swift|c|cpp|h)$/i;
const DIFF_COMMAND = /\b(git (diff|show|log)|gh pr diff)\b/;

/** The change for one call group, as a short imperative naming its target. */
function callChange(call: CardToolCall): string {
  const name =
    call.kind === "file"
      ? `\`${call.target.split("/").pop()}\``
      : `\`${call.target.length > 60 ? `${call.target.slice(0, 59)}…` : call.target}\``;
  if (call.kind === "file" && call.tool === "Read") {
    if (!call.whole_file) return `Read smaller ranges of ${name}`;
    if (SKILL_FILE.test(call.target)) return `Stop reading all of ${name} on every run`;
    if (SCRATCH_FILE.test(call.target)) return `Read a summary of ${name}, not the whole file`;
    if (SOURCE_FILE.test(call.target) && call.session_count > 1)
      return `Split ${name} into smaller modules`;
    if (call.calls > 1 && call.session_count === 1)
      return `Read ${name} once, then only the section you need`;
    return `Read only the section you need from ${name}`;
  }
  if (call.kind === "file") return `Shrink ${name}`;
  if (call.kind === "command")
    return DIFF_COMMAND.test(call.target)
      ? `Run ${name} with --stat first`
      : `Filter the output of ${name}`;
  if (call.kind === "url" && call.tool === "Artifact")
    return `Read only the part you need from the saved copy of ${name}`;
  if (call.kind === "url") return `Ask WebFetch a specific question about ${name}`;
  if (call.kind === "search") return `Narrow the search ${name}`;
  return `Limit the results of ${name}`;
}

/** How to get what one group of oversized calls was after, with a smaller result. */
function callFix(call: CardToolCall): string {
  const each = byteAmount(call.max_bytes);
  if (call.kind === "file" && call.tool === "Read") {
    if (!call.whole_file) {
      return `It was already read in parts, but the parts were still up to ${each}. Grep for the lines you need first, then Read a smaller range (a limit of a few hundred lines).`;
    }
    if (SKILL_FILE.test(call.target)) {
      return `This file (${each}) belongs to a skill or plugin, and each run reads it whole. If it came from a plugin or someone else's package, a local edit is lost on the next update: read it once per session and pass the part a subagent needs in its brief, or ask the author to split it. If you wrote the skill, split it into smaller files it links to, so each run reads only the part it needs.`;
    }
    if (SCRATCH_FILE.test(call.target)) {
      return `This is a scratch or output file (${each}). Have whoever writes it also write a short summary and read that, or Grep it for what you need instead of reading it whole.`;
    }
    if (SOURCE_FILE.test(call.target) && call.session_count > 1) {
      return `Split it into smaller modules: it is read whole in ${count(call.session_count)} different sessions, so each session loads code it does not work on. Until then, Grep for the part you need, then Read with offset and limit.`;
    }
    if (call.session_count > 1) {
      return `It is read whole in ${count(call.session_count)} different sessions. Grep for the section you need, then Read with offset and limit. If it is this large because it covers several topics, split it into smaller files.`;
    }
    if (call.calls > 1) {
      return `It is read whole ${times(call.calls)} in one session. Read it once, then re-read only the section you need (Grep for it, then Read with offset and limit).`;
    }
    return `Grep for the lines you need, then Read with offset and limit instead of loading all ${each}.`;
  }
  if (call.kind === "file") {
    return `Each ${call.tool} returned ${each}, so the file itself is that large. Check why and shrink it (for example remove stale entries), or change it with a short script whose output you limit.`;
  }
  if (call.kind === "command") {
    return DIFF_COMMAND.test(call.target)
      ? "Run it with --stat or --name-only first, then look at one file at a time."
      : "Filter the output before it returns: pipe it through head, tail or grep (Select-Object -First in PowerShell), or write it to a file and read only the part you need.";
  }
  // Review 4 A1: a claude.ai artifact link is read with the Artifact tool, never WebFetch.
  if (call.kind === "url" && call.tool === "Artifact") {
    return "The Artifact tool's read saves the page to a local file and names it. Grep that file for what you need, then Read with offset and limit, instead of reading the whole page again.";
  }
  if (call.kind === "url") {
    const ask = "Ask WebFetch a specific question so it returns the answer, not the whole page.";
    return call.calls > 1
      ? `It was fetched ${times(call.calls)}. Save the facts you need to a short notes file and read that next time. ${ask}`
      : ask;
  }
  if (call.kind === "search") {
    return "Search in two steps: files_with_matches or count with a narrow path or glob first, then read only the matching lines. Set head_limit on broad searches.";
  }
  return "Use the tool's own filter, limit or page-size arguments, and ask only for the fields you need.";
}

/**
 * U9 r4: a Read-range rule the user already has, in a CLAUDE.md above the file or in the user-level
 * one, so the card can say the reads happened despite it instead of proposing the same line.
 */
export function existingReadRule(
  target: string,
  home = os.homedir(),
): { file: string; line: string; kb: number | null } | null {
  const abs = target.startsWith("~/") ? path.join(home, target.slice(2)) : target;
  const candidates: string[] = [];
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    candidates.push(path.join(dir, "CLAUDE.md"));
    if (dir === home || path.dirname(dir) === dir) break;
  }
  candidates.push(path.join(home, ".claude", "CLAUDE.md"));
  for (const candidate of candidates) {
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    const line = text
      .split(/\r?\n/)
      .find((row) => /\bRead\b/.test(row) && /\b(offset|limit)\b/i.test(row));
    if (line === undefined) continue;
    const kb = /(\d+)\s*KB/i.exec(line)?.[1];
    return {
      file: displayPath(candidate, home),
      line: line
        .replace(/^[\s\-*]+/, "")
        .trim()
        .slice(0, 200),
      kb: kb === undefined ? null : Number(kb),
    };
  }
  return null;
}

/**
 * U9 r8: a listed call the user can act on. A bare command name ("grep") says nothing about what
 * to change, and AgentWrangler's own research folder is not the user's work.
 */
function isActionableCall(call: CardToolCall): boolean {
  if (call.kind === "command" && /^[a-z][\w-]*$/i.test(call.target.trim())) return false;
  return !call.target.includes(".agentwrangler/research");
}

/**
 * U9 r8: A1's primary. The dollars cover every large result; the general Read cap is the change
 * that reaches most of them, so it leads and the one-file fix is the alternative.
 */
function readCapPrompt(facts: {
  events: number;
  total: number | null;
  reads: number;
  readBytes: number;
  window: { from: string; to: string } | null;
  calls: CardToolCall[];
  sessionIds: string[];
  sessionTotal: number;
}): string {
  const readGroups = listedCalls(facts.calls).filter(
    (call) => call.kind === "file" && call.tool === "Read" && isActionableCall(call),
  );
  const lead = readGroups[0];
  const existing = lead === undefined ? null : existingReadRule(lead.target);
  const rule =
    "Cap every Read at 300 lines when the file is over 25 KB: Grep for the heading or symbol first, then Read with offset and limit. Put the same cap in the prompt of any subagent that reads files.";
  const share =
    facts.total === null || facts.total <= 0
      ? ""
      : ` (${Math.round((facts.readBytes / facts.total) * 100)}% of the bytes)`;
  const between = facts.window
    ? ` between ${facts.window.from.slice(0, 10)} and ${facts.window.to.slice(0, 10)}`
    : "";
  return cardPrompt({
    title: "Cap the size of every Read",
    intro: `found ${count(facts.events)} successful tool calls${between} that each returned more than 25 KB${facts.total === null ? "" : ` (${byteAmount(facts.total)} in total)`}. ${count(facts.reads)} of them are Read results${share}: the part a Read-size rule reaches. The other ${count(facts.events - facts.reads)} (shell output, searches, fetched pages) need a different fix.`,
    context: [
      "A tool result stays in the conversation and is re-sent on every later turn until /clear, compaction or Claude Code's tool-result clearing drops it, so one large result is paid for many times.",
      "Paths start at your home folder (~), so you can run this from any folder.",
      TRANSCRIPTS,
    ],
    findings: [
      sessionsLine(
        facts.sessionIds,
        facts.sessionTotal,
        "Sessions with any result over 25 KB, not only the files below",
      ),
      ...(readGroups.length > 0
        ? [
            "- The Read groups behind the largest costs (file, how often, and how large each result was):",
            ...readGroups.map((call) => `  - ${callLine(call)}`),
          ]
        : []),
    ],
    fix:
      existing === null
        ? `Ready CLAUDE.md line (project CLAUDE.md, or ~/.claude/CLAUDE.md for every project): \`${rule}\` The 300 lines is a starting value, not a measured threshold; step 1 gives you the measure.`
        : `${existing.file} already says: "${existing.line}". ${
            existing.kb !== null && existing.kb > 25
              ? `Its ${existing.kb} KB threshold is above the 25 KB these results crossed, and it sets no size for each range. `
              : ""
          }Do not add a second rule; replace it with this stricter one, which also reaches subagents: \`${rule}\` The 300 lines is a starting value, not a measured threshold; step 1 gives you the measure.`,
    steps: [
      "For the files in the Read groups above, measure bytes per line (file size divided by line count, without printing the file). 300 lines is only the right cap if it comes out near 25 KB for these files; pick the line count that keeps one range under 25 KB.",
      "Check the CLAUDE.md files that load for these projects, and any skill or agent brief that reads these files, for a Read-range rule already in force.",
      "Write the plan: the exact rule text, the file it goes in, and which skill or subagent briefs also need it.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the edits.",
      "Verify: show the final text of every rule you added and the file it is in.",
    ],
    notes: [
      "Do not paste large file contents into this conversation; measure and summarise.",
      "AgentWrangler re-measures the number of Read results over 25 KB in later weeks. Fewer is the goal.",
    ],
  });
}

interface ToolResultPromptFacts {
  events: number | null;
  total: number | null;
  window: { from: string; to: string } | null;
  calls: CardToolCall[];
  sessionIds: string[];
  sessionTotal: number;
}

/**
 * A self-contained Claude Code prompt for a tool-result card: the one call group to fix (the
 * lead), the others as "also seen", then investigate → plan → confirm → apply → verify.
 */
function toolResultPrompt(facts: ToolResultPromptFacts): string {
  const { calls } = facts;
  const byTool = repeatedBytesByTool(calls);
  const [lead, ...others] = listedCalls(calls);
  const between = facts.window
    ? ` between ${facts.window.from.slice(0, 10)} and ${facts.window.to.slice(0, 10)}`
    : "";
  const number = facts.events === null ? "Several" : count(facts.events);
  const covered = [lead, ...others].reduce((sum, call) => sum + (call?.calls ?? 0), 0);
  const rest =
    facts.events !== null && facts.events > covered
      ? [
          `- These cover ${count(covered)} of the ${count(facts.events)} calls; the rest are smaller or could not be read back from the transcripts.`,
        ]
      : [];
  const isFile = lead?.kind === "file";
  const existingRule =
    isFile && lead !== undefined && lead.tool === "Read" ? existingReadRule(lead.target) : null;
  // U9 r5: the card's dollars cover every large result; say how much of the avoidable bytes
  // (those above the 25 KB line) this fix covers.
  const aboveLine =
    facts.total === null || facts.events === null
      ? 0
      : facts.total - facts.events * A1_RESULT_BYTES_THRESHOLD;
  const leadAbove =
    lead === undefined ? 0 : Math.max(0, lead.total_bytes - lead.calls * A1_RESULT_BYTES_THRESHOLD);
  const scopeLine =
    lead !== undefined && aboveLine > 0
      ? [
          `- Scope: the dollars on the card cover all ${count(facts.events ?? 0)} large results. This group holds ${byteAmount(leadAbove)} of the ${byteAmount(aboveLine)} above the 25 KB line (${Math.round((leadAbove / aboveLine) * 100)}%).${lead.tool === "Read" ? " The Read rule in step 3 also narrows the other Read groups below, not shell output or searches." : ""}`,
        ]
      : [];
  const found =
    lead !== undefined
      ? [
          "## Findings",
          sessionsLine(
            facts.sessionIds,
            facts.sessionTotal,
            "Sessions with any result over 25 KB, not only the calls below",
          ),
          ...(byTool === null
            ? []
            : [`- By tool, counting targets repeated at least twice: ${byTool}`]),
          `- ${callLine(lead)}`,
          ...scopeLine,
          // The sessions above are the card's first few; these are the ones that ran this group.
          ...(lead.session_ids.length > 0
            ? [
                `- Sessions that ran the call group above${lead.session_count > lead.session_ids.length ? ` (${lead.session_ids.length} of ${count(lead.session_count)} listed)` : ""}: ${lead.session_ids.join(", ")}`,
              ]
            : []),
          ...(others.filter(isActionableCall).length > 0
            ? [
                "",
                "Also seen (not part of this fix):",
                ...others.filter(isActionableCall).map((call) => `- ${callLine(call)}`),
              ]
            : []),
          ...rest,
          "",
          "## Fix",
          `\`${lead.target}\`: ${callFix(lead)}`,
        ]
      : [
          "## Findings",
          `- AgentWrangler could not read these calls back from the session transcripts. Sessions: ${facts.sessionIds.join(", ") || "unknown"}. Transcripts are at ~/.claude/projects/<workspace folder>/<session id>.jsonl; the \`tool_use\` block whose id matches a large \`tool_result\` holds the call's input.`,
          "",
          "## Fix",
          NARROWER_CALLS,
        ];
  const target = lead === undefined ? "the calls above" : `\`${lead.target}\``;
  return [
    `# ${lead === undefined ? "Cut large tool results out of context" : callChange(lead)}`,
    "",
    `AgentWrangler (a local Claude Code spend monitor) found ${number} successful tool calls${between} that each returned more than 25 KB${facts.total === null ? "" : ` (${byteAmount(facts.total)} in total)`}. Nothing failed: the calls worked, but each loaded more than the task needed.${lead === undefined ? "" : " This prompt fixes the one that costs the most in re-sends, in the main conversation or inside a subagent; the others are listed for reference only."}`,
    "",
    "## Context",
    "- A tool result stays in the conversation and is re-sent on every later turn until /clear, compaction or Claude Code's tool-result clearing drops it, so one large result is paid for many times.",
    "- Paths start at your home folder (~), so you can run this from any folder.",
    "",
    ...found,
    "",
    "## Steps",
    isFile
      ? `1. Check the size and structure of ${target} (line count and headings) without printing it, and find what reads it (a skill, a script or a habit).`
      : `1. Say what ${target} was for, and what part of its result the task actually needed.`,
    "2. Turn the fix into a concrete change: the files to split and their new names, a rule that makes future calls narrower, or no file change for a one-off.",
    isFile && lead !== undefined && lead.tool === "Read"
      ? existingRule !== null
        ? `3. ${existingRule.file} already has this rule: "${existingRule.line}". ${
            lead.whole_file
              ? `These reads read the whole file${existingRule.kb !== null && lead.max_bytes <= existingRule.kb * 1024 ? `, and each result is under the rule's ${existingRule.kb} KB threshold, so it does not catch them` : ", which the rule already says not to do"}.`
              : `The lead group was already read with offset and limit, so it followed the rule; the rule does not cap how large each range is${existingRule.kb !== null && existingRule.kb > 25 ? ` (its ${existingRule.kb} KB threshold is above the 25 KB these results crossed)` : ""}.`
          }${lead.is_subagent ? " The lead group ran inside a subagent, so check whether its brief carried the rule." : ""} Do not add the rule again; replace it with the stricter one below, which also reaches subagents. Ready rule: \`Cap every Read at 300 lines when the file is over 25 KB: Grep for the heading or symbol first, then Read with offset and limit. Put the same cap in the prompt of any subagent that reads files.\` The 300 lines is a starting value, not a measured threshold; adjust it.`
        : `3. If the pattern repeats across sessions, put the rule in the file that causes it (the skill that reads the file) or as one line in the project CLAUDE.md, which loads on every turn. I found no Read-range rule in the CLAUDE.md files above ${lead.target.split("/").pop()}; check yours too. Ready rule: \`When reading ${lead.target.split("/").pop()} or any file over 25 KB, Grep for the heading or symbol first, then Read with offset and limit of at most 300 lines. Read the whole file only when the task is to edit or review all of it.\` The 300 lines is a starting value, not a measured threshold; adjust it.`
      : "3. If the pattern repeats across sessions, put the rule in the file that causes it (the skill that reads the file) or as one line in the project CLAUDE.md, which loads on every turn.",
    "4. Write the plan: the change, the file changed, and the expected result size.",
    "5. Ask me to confirm the plan before changing any file.",
    "6. After I confirm, make the edits.",
    isFile
      ? `7. Verify: re-check the size of ${target} and of any file you split it into, and show the final text of every rule you added.`
      : "7. Verify: show the final text of every rule you added, and the size of the narrower call's result if you ran it.",
    "",
    "## Notes",
    "- Do not paste large file contents or command output into this conversation; measure and summarise.",
    ...(isFile
      ? [
          `- AgentWrangler compares the bytes later sessions in this project pull from ${target} with before, per session. It counts this file only. Doing less work on the file, or renaming it, also lowers the number, and it counts bytes, not how often they are re-sent. Fewer is the goal.`,
        ]
      : []),
  ].join("\n");
}

/**
 * U9 r8: what to change for one D6 target. A range read is already a range (more offset and limit
 * is not the lever), `sed` is itself a line-range read, and `cat` prints a whole file.
 */
function d6TargetAsk(call: CardToolCall): string {
  const name = call.kind === "file" ? `\`${call.target.split("/").pop()}\`` : `\`${call.target}\``;
  const each = byteAmount(call.max_bytes);
  if (call.kind === "file" && call.tool === "Read") {
    if (!call.whole_file) {
      return call.calls > 1
        ? `${name}: already read in parts, so offset and limit are not the lever. It was read ${times(call.calls)} (up to ${each} each): read it once and keep a short note of what you need, or Grep for the lines instead of re-reading.`
        : `${name}: already read in parts (up to ${each}); use a smaller range.`;
    }
    if (SCRATCH_FILE.test(call.target) || call.target.includes(".agentwrangler/")) {
      return `${name}: read whole ${times(call.calls)} (up to ${each} each). Read a short summary of it, or Grep it for the part you need.`;
    }
    return `${name}: read whole ${times(call.calls)} (up to ${each} each). Grep for the part you need, then Read with offset and limit.`;
  }
  if (call.kind === "command") {
    if (/^sed\b/.test(call.target)) {
      return `${name}: already a line-range read, so ranging is not the lever. Its output was up to ${each}: take a narrower range, or filter it through grep.`;
    }
    if (/^(cat|type|more|less)\b/.test(call.target)) {
      return `${name}: prints a whole file (up to ${each}). Use Read with a range, or Grep, instead.`;
    }
    return `${name}: output up to ${each} per run. Filter it through grep, head or tail, or have the script print less.`;
  }
  return `${name}: ${callFix(call)}`;
}

const TASK_BOUNDARY = "a commit, a branch change, or a switch to unrelated files";

/** Review 5 U8 (M20): keep whole transcripts out of the main conversation. */
const FRESH_SESSION_SCAN =
  "Run this in a fresh session. Scan transcripts with a script (the `message.usage`, `tool_use` and `is_error` fields) or one subagent per session, and bring back only the table; do not read whole transcripts into this conversation.";

/** Review 5 U4 (M2): a CLAUDE.md rule can prompt the handoff, but only the user runs /clear. */
const D2_FIX =
  "At each finished task, write a short handoff (goal, decisions, files, next step), run /rename, then /clear, and start the next task from the handoff. A one-line CLAUDE.md rule can make Claude offer the handoff when a task ends; you still type /clear. Ready rule for ~/.claude/CLAUDE.md (check first that it has none saying the same): `When a task finishes, offer a handoff of at most 2K tokens and remind me to /clear.` Keep it to that one line: CLAUDE.md loads on every model call, so if the file is already over its size target, swap out a line you no longer need rather than growing it.";

/**
 * U9 r8: a /clear-at-task-boundaries rule the user already has in ~/.claude/CLAUDE.md, with the
 * handover section heading if there is one, so D2 asks to tighten it instead of shipping it again.
 */
export function existingClearRule(
  home = os.homedir(),
): { file: string; line: string; handover: string | null } | null {
  const rule = existingUserRule(
    (row) => /\/clear\b/.test(row) && /task boundar|between tasks/i.test(row),
    home,
    /\/clear\b/,
  );
  if (rule === null) return null;
  const heading = existingUserRule((row) => /^#+\s.*hand(over|off)/i.test(row), home);
  return { ...rule, handover: heading === null ? null : heading.line.replace(/^#+\s*/, "") };
}

/** The calls where each session's context first passed 180K, from D2's per-session lines. */
function d2PassCalls(rec: Parameters<FamilyHandler>[0]): number[] {
  return d2SessionLines(rec)
    .map((line) => /first passed 180K on call (\d+)/.exec(line)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
}

/** The D2 fix when the user already has the rule: say it did not fire early enough, tighten or enforce it. */
function d2ExistingRuleFix(
  rule: NonNullable<ReturnType<typeof existingClearRule>>,
  passed: number[],
): string {
  const calls =
    passed.length === 0
      ? ""
      : ` These sessions passed 180K tokens of context at call${passed.length === 1 ? "" : "s"} ${passed.join(", ")} anyway.`;
  return `Your ${rule.file} already says: "${rule.line}"${rule.handover === null ? "" : ` and has a "${rule.handover}" section`}.${calls} So the rule exists but these sessions did not follow it, or it did not fire early enough: do not add a second rule. Tighten it with a number (for example offer a handoff and /clear once context passes a size you choose, such as 150K), or add something that tells you when context passes that size, so the rule is enforced and not only written down. You still type /clear yourself. CLAUDE.md loads on every model call, so swap words rather than growing the file.`;
}

/** This card counts re-reads while you keep working; idle breaks belong to the cache-expiry card. */
const D2_NOT_BREAKS =
  "This card is about history re-read while you keep working in one session. A break longer than the cache lifetime is a separate card (cache expiry), which counts the rewrite after the break; do not count those model calls twice.";

/** Handoff skills the user already has (any ~/.claude/skills folder named *handoff*). */
function existingHandoffSkills(): string[] {
  try {
    return readdirSync(path.join(os.homedir(), ".claude", "skills"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /handoff/i.test(entry.name) &&
          existsSync(path.join(os.homedir(), ".claude", "skills", entry.name, "SKILL.md")),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** User-level, so the skill serves every project and validates on a global rec (review 5 M3). */
const HANDOFF_SKILL_FILE = "~/.claude/skills/handoff/SKILL.md";

/** Review 5 U4 (M3, OC1): the /handoff skill, offered as an EDIT alternative to the habit. */
function handoffSkillPrompt(rec: Parameters<FamilyHandler>[0], existing: string[]): string {
  const have = existing[0];
  return cardPrompt({
    title: have ? `Use your /${have} skill at each task boundary` : "Add a /handoff skill",
    intro: have
      ? `found long sessions that kept one growing conversation across many model calls. You already have a /${have} skill (~/.claude/skills/${have}/SKILL.md). Check that it writes a short handoff at the end of a task, and extend it if not, instead of creating a second one.`
      : "found long sessions that kept one growing conversation across many model calls. Add a /handoff skill that writes a short handoff at the end of a task, so the next task can start after /clear without re-explaining.",
    context: [
      "Every model call re-reads the whole conversation so far from the prompt cache, so a session costs more per call the longer it runs. /clear resets it; a handoff file carries over what the next task needs.",
      "A skill is a SKILL.md file under `~/.claude/skills/<name>/` (every project) or `.claude/skills/<name>/` (one project). Frontmatter `disable-model-invocation: true` means it runs only when you type its name, never on its own.",
      `A task boundary is ${TASK_BOUNDARY}.`,
    ],
    findings: [
      `- Sessions over 150 model calls with more than 180K tokens of context per call on average: ${labelNumber(numberFrom(rec, "qualifying_session_count"), "not recorded")}`,
    ],
    fix: have
      ? `Read ~/.claude/skills/${have}/SKILL.md. If it already writes HANDOFF-<branch>.md (or similar) of about 2K tokens or less and ends by reminding me to /clear, change nothing and tell me the one line to type. If not, edit that skill so it does: four short sections (goal, decisions, files, next step), one file per branch, never overwriting another branch's.`
      : `Create \`${HANDOFF_SKILL_FILE}\` with frontmatter \`name: handoff\`, a one-line description and \`disable-model-invocation: true\`. Its body tells Claude to write HANDOFF-<branch>.md at the repo root (the current git branch, with / replaced by -) with four short sections (goal, decisions, files, next step), under about 2K tokens, replacing only this branch's file and never overwrite another branch's, since parallel sessions on other branches keep their own. Then it reminds me to run /rename and /clear and to start the next session with \`@HANDOFF-<branch>.md\` followed by the task.`,
    steps: [
      have
        ? `Read the existing skill${existing.length > 1 ? "s" : ""} (${existing.join(", ")}) and any project .claude/skills handoff skill.`
        : `Check whether \`${HANDOFF_SKILL_FILE}\` or another handoff skill already exists (also under the project's .claude/skills).`,
      "Write the plan: the file path, the full SKILL.md text, and whether HANDOFF-*.md should be git-ignored.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, create the file.",
      `Verify: run it once (type /${have ?? "handoff"}), then report the handoff file's name and size (characters divided by 4 gives estimated tokens); it must be under about 2K tokens.`,
    ],
    notes: [
      "I still type /clear myself; the skill only writes the handoff.",
      "Do not paste transcript contents into the handoff; summarise.",
    ],
  });
}

/** The long-session prompt: find each session's task boundaries, then make splitting there a rule. */
function longSessionPrompt(
  rec: Parameters<FamilyHandler>[0],
  sessionIds: string[],
  window: { from: string; to: string } | null,
): string {
  const tokens = (key: string) => {
    const value = numberFrom(rec, key);
    return value === null ? "not recorded" : `${tokenAmount(value)} tokens`;
  };
  const between = window
    ? ` between ${window.from.slice(0, 10)} and ${window.to.slice(0, 10)}`
    : "";
  // Review 5 U4: say how many of the qualifying sessions are listed.
  const qualifying = numberFrom(rec, "qualifying_session_count");
  const gitCommands = numberFrom(rec, "git_command_count");
  const commitShas = numberFrom(rec, "commit_boundary_count");
  const clearRule = existingClearRule();
  const sessions =
    qualifying !== null && sessionIds.length > 0 && qualifying > sessionIds.length
      ? sessionsLine(sessionIds, null, `Sessions (${sessionIds.length} of ${qualifying} listed)`)
      : sessionsLine(sessionIds, sessionTotal(rec));
  return cardPrompt({
    title: "Start a fresh session at each task boundary",
    intro: `found long sessions${between} that kept one growing conversation across many model calls. Find where each one could have been split, and make splitting there a habit.`,
    context: [
      "A model call is one model response, including each tool step. Every model call re-reads the whole conversation so far from the prompt cache, so a session costs more per call the longer it runs.",
      `A task boundary is ${TASK_BOUNDARY}.`,
      "/clear (or a new session) resets the context to the always-loaded files. /compact keeps the session but replaces the history with a summary.",
      "A saving followed by rework is not a win: split where a task is finished, not mid-task.",
      D2_NOT_BREAKS,
      TRANSCRIPTS,
      FRESH_SESSION_SCAN,
    ],
    findings: [
      `- Sessions over 150 model calls with more than 180K tokens of context per call on average: ${labelNumber(qualifying, "not recorded")}`,
      `- Model calls in those sessions: ${labelNumber(numberFrom(rec, "qualifying_turn_count"), "not recorded")}`,
      `- Average context per model call: ${tokens("raw_context_average_tokens_per_turn")}`,
      `- Cache reads in those sessions a week: ${tokens("cache_read_tokens_per_week")}`,
      ...(d2SessionLines(rec).length > 0
        ? [
            "- Measured per session, most model calls first (calls, average and peak context, and the call where context first passed 180K); use these to find where to look in each transcript:",
            ...d2SessionLines(rec).map((line) => `  - ${line}`),
          ]
        : []),
      ...(gitCommands !== null && gitCommands > 0 && commitShas === 0
        ? [
            `- Task boundaries were not measured: ${count(gitCommands)} git commands ran in these sessions but no commit SHA could be read from them. The card's split count is an even spacing, not boundaries found.`,
          ]
        : []),
      sessions,
    ],
    fix: clearRule === null ? D2_FIX : d2ExistingRuleFix(clearRule, d2PassCalls(rec)),
    steps: [
      "For each session above, read its transcript without printing it and list the tasks it covered, with the model call where each began and the context size there (the `usage` fields on assistant lines: input, cache read and cache creation tokens).",
      "Mark the boundaries where a finished task gave way to a new one: the points where /clear would have been safe.",
      clearRule === null
        ? "Check whether a CLAUDE.md in these projects (or ~/.claude/CLAUDE.md) already has a rule about offering a handoff or clearing between tasks."
        : `Check the project CLAUDE.md files too. ${clearRule.file} already has the rule quoted in the Fix, so for each session say whether the rule applied and was skipped, or never fired because the context grew mid-task.`,
      "Write the plan: the boundaries you found per session, and the exact rule text and the file it goes in (or why an existing rule is enough).",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the edit.",
      "Verify: show the final text of the rule and the file it is in.",
    ],
    notes: ["Do not paste transcript contents into this conversation; summarise."],
  });
}

/**
 * Splits a D10 disable-list into items nothing names and items the user's own ~/.claude/CLAUDE.md
 * names (a rule there depends on them, so disabling one breaks the rule). A plugin is matched on
 * the part of its key before "@". MCP servers are never matched.
 */
function d10NamedInClaudeMd(list: string[]): { free: string[]; referenced: string[] } {
  let text = "";
  try {
    text = readFileSync(path.join(os.homedir(), ".claude", "CLAUDE.md"), "utf8");
  } catch {
    return { free: list, referenced: [] };
  }
  const free: string[] = [];
  const referenced: string[] = [];
  for (const item of list) {
    const match = /^(plugin|skill) (\S+) /.exec(item);
    const name = match?.[2]?.split("@")[0];
    const pattern = name
      ? new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`)
      : null;
    (pattern?.test(text) ? referenced : free).push(item);
  }
  return { free, referenced };
}

const contextActions: Record<
  string,
  (rec: Parameters<FamilyHandler>[0], ctx: Parameters<FamilyHandler>[1]) => CardActions
> = {
  D1: (rec, ctx) => {
    const fileRef = stringMetric(rec, "source_file_ref");
    const sourceName = fileRef ? displayPath(fileRef) : "the context source file";
    const besideSource = (...parts: string[]) =>
      displayPath(path.join(path.dirname(fileRef ?? "."), ...parts));
    const quantity =
      stringMetric(rec, "attribution_method") === "MEASURED_CONTENT"
        ? "tokens"
        : "estimated tokens";
    const sourceTokens = numberFrom(rec, "source_tokens");
    const source = labelNumber(sourceTokens, "current");
    const targetTokens = numberFrom(rec, "source_target");
    const target = labelNumber(targetTokens, "target");
    const sections = largestSections(fileRef, sourceTokens);
    const sectionList = sections
      .map((section) => `${section.name} (~${section.tokens.toLocaleString("en-US")} tokens)`)
      .join(", ");
    const isMemory = stringMetric(rec, "component") === "MEMORY";
    const isGlobal = stringMetric(rec, "scope") === "global";
    const window = ctx.trigger.window;
    const measured = quantity === "tokens";
    const fileChars = measured ? fileCharCount(fileRef) : null;
    const charTarget =
      measured &&
      fileChars !== null &&
      sourceTokens !== null &&
      sourceTokens > 0 &&
      targetTokens !== null
        ? Math.round((targetTokens / sourceTokens) * fileChars)
        : null;
    // U9 r8: nearly all turns in one workspace (it loads the global file and its own repo file).
    const topWorkspaceTurns = numberFrom(rec, "top_workspace_turns");
    const allTurns = numberFrom(rec, "turns_per_week");
    const oneWorkspaceTurns =
      topWorkspaceTurns !== null && allTurns !== null && allTurns > 0
        ? topWorkspaceTurns / allTurns >= 0.9
        : false;
    const indexLines = isMemory ? longestIndexLines(fileRef) : [];
    const sweepSkill = isMemory && existsSync(path.join(os.homedir(), MEMORY_SWEEP_SKILL));
    const prompt = (fix: string, planStep: string) =>
      d1Prompt(
        {
          lineList: indexLines.map((line) => `  - "${line.text}" (~${line.tokens} tokens)`),
          sweepSkill,
          file: sourceName,
          isMemory,
          isGlobal,
          measured,
          charTarget,
          window: window ? `${window.from.slice(0, 10)} to ${window.to.slice(0, 10)}` : null,
          extraPerWeek:
            ctx.trigger.facts.find((fact) => fact.label === "Extra tokens per week")?.value ?? null,
          quantity,
          source,
          target,
          turnsPerWeek: labelNumber(numberFrom(rec, "turns_per_week"), "many"),
          workspaces:
            ctx.trigger.facts.find((fact) => fact.label === "Workspaces")?.value ??
            labelNumber(numberFrom(rec, "workspace_multiplier"), "1"),
          sectionList,
        },
        fix,
        planStep,
      );
    const edit = (option_id: string, summary: string, detail: string, planStep: string) => ({
      ...option(option_id, "EDIT", summary, [detail], prompt(summary, planStep), fileRef),
      target_metric: "avg_context_per_turn",
    });
    const alternatives = isMemory
      ? [
          edit(
            "d1-memory-topic-files",
            `Move memory detail into linked topic files, keeping one-line entries in ${sourceName}.`,
            "Each index entry keeps a title and one-line summary; the detail loads only when needed.",
            `For each entry longer than one line, plan to move the detail into its own topic file next to ${sourceName} and leave a one-line entry that links to it: - [Title](file.md) — one-line summary.`,
          ),
          edit(
            "d1-memory-prune",
            `Archive resolved or superseded memories out of ${sourceName}.`,
            "Move entries for finished work, fixed bugs and replaced decisions to memory/archive/, so they stop loading but can be restored.",
            "Mark each memory as current, resolved (the work finished or the bug is fixed), superseded (a later decision replaced it) or duplicate. Plan to move the resolved, superseded and duplicate ones, with their topic files, into a memory/archive/ folder next to the index, and remove their index lines. Never move an entry marked pending, open or TODO. If unsure, keep it and say why.",
          ),
        ]
      : [
          edit(
            "d1-sections-to-skills",
            `Move situational sections of ${sourceName} into skills loaded on demand.`,
            "A skill's body loads only when its task comes up; its name and description (roughly 100 tokens each in this catalog) still load every turn, so move whole sections into one skill rather than many small ones.",
            `Find sections that only apply to specific tasks (for example publishing, PR writing or reviews). Plan to move each into a skill at ${isGlobal ? "~/.claude/skills/<name>/SKILL.md" : besideSource(".claude", "skills", "<name>", "SKILL.md")}, leaving at most a one-line pointer. A skill is a SKILL.md file whose frontmatter has a name and a description saying when to use it; Claude Code loads only the description up front and reads the body when a task matches, so the body stops costing tokens on every turn.`,
          ),
          // U9 r8: moving repo rules into a repo CLAUDE.md saves nothing when nearly every turn is in
          // that one workspace, which loads both files. Drop the option then.
          ...(isGlobal
            ? oneWorkspaceTurns
              ? []
              : [
                  edit(
                    "d1-repo-rules-to-repo",
                    `Move repo-specific rules out of the global ${sourceName} into each repo's CLAUDE.md.`,
                    "The global file loads in every workspace; repo rules only need to load in their repo.",
                    "Find rules that only apply to one repo. Plan to move each into that repo's CLAUDE.md (at the repo root; create it if missing), keeping only rules that apply in every workspace. To find the repos, list the folders under ~/.claude/projects: each is a workspace Claude Code has run in, named after its path with separators replaced by dashes.",
                  ),
                ]
            : [
                edit(
                  "d1-reference-to-docs",
                  `Move reference material in ${sourceName} into linked docs.`,
                  "Keep rules in the file; tables, runbooks and background load only when read.",
                  `Find reference material (tables, runbooks, background). Plan to move each into a doc under ${besideSource("docs")} and replace it with a one-line link; Claude reads a linked doc only when a task needs it.`,
                ),
              ]),
        ];
    return {
      primary: {
        ...option(
          "d1-trim-prefix",
          "EDIT",
          `Trim ${sourceName} from ${source} ${quantity} to ${target} or less.`,
          [
            ...(sections.length > 0 ? [`Largest sections: ${sectionList}`] : []),
            ...(indexLines.length > 0
              ? [
                  `Longest index lines: ${indexLines.map((line) => `"${line.text}" (~${line.tokens} tokens)`).join("; ")}`,
                ]
              : []),
            ...(sweepSkill
              ? ["You have a /memory-sweep skill for this: run it first, then trim what is left."]
              : []),
            `Edit ${sourceName}; this invalidates the cached prefix and causes one full-price cache write.`,
            "Batch prefix edits to a /clear boundary.",
            "A saving followed by rework is not a win.",
          ],
          prompt(
            `Trim ${sourceName} from ${source} ${quantity} to ${target} or less, keeping only current rules and links.`,
            `Sort each section into keep (needed on most turns), shorten (keep the rule, cut examples and repetition) or delete (stale or duplicated). Keep rules that a guard message, skill or other file points to; shorten them instead.${sectionList ? " Start with the largest sections." : ""}`,
          ),
          fileRef,
        ),
        target_metric: "avg_context_per_turn",
      },
      alternatives,
    };
  },
  A1: (rec, ctx) => {
    const events = numberFrom(rec, "EVENT_COUNT");
    const largest = numberFrom(rec, "MAX_RESULT_BYTES");
    const total = numberFrom(rec, "RESULT_BYTES_TOTAL");
    const calls = rec.tool_calls ?? [];
    const results =
      events === null ? "results" : `${count(events)} result${events === 1 ? "" : "s"}`;
    const prompt = toolResultPrompt({
      events,
      total,
      window: ctx.trigger.window,
      calls,
      sessionIds: ctx.trigger.session_ids,
      sessionTotal: sessionTotal(rec),
    });
    const lead = leadCall(calls);
    const others = listedCalls(calls).length - 1;
    const perFile = {
      ...option(
        "a1-bound-large-results",
        "HABIT",
        lead === undefined
          ? `Cut large tool results: ${results} over 25 KB${largest === null ? "" : `, the largest ${byteAmount(largest)}`}.`
          : `${callChange(lead)}: ${callUsage(lead)}.`,
        lead === undefined
          ? [NARROWER_CALLS]
          : [
              callFix(lead),
              ...(others > 0
                ? [
                    `${count(others)} other large call ${others === 1 ? "group is" : "groups are"} listed as "also seen"; this change does not cover them.`,
                  ]
                : []),
            ],
        prompt,
        null,
      ),
      target_metric: "tool_result_bytes",
    };
    // U9 r8: with the Read share recorded, the general Read cap leads (it reaches the Read results
    // the headline is mostly made of) and the one-file fix is the alternative.
    const reads = numberFrom(rec, "READ_EVENT_COUNT");
    const readBytes = numberFrom(rec, "READ_RESULT_BYTES");
    if (events === null || reads === null || readBytes === null || lead === undefined) {
      return { primary: perFile, alternatives: [] };
    }
    return {
      primary: {
        ...option(
          "a1-cap-read-size",
          "HABIT",
          `Cap every Read at about 300 lines for files over 25 KB: ${count(reads)} of the ${count(events)} large results are Reads${total === null || total <= 0 ? "" : ` (${Math.round((readBytes / total) * 100)}% of the bytes)`}.`,
          [
            "This rule reaches the Read results only, not shell output, searches or fetched pages.",
            `The one-file fix for \`${lead.target.split("/").pop()}\` is the alternative below; it covers a small part of the bytes.`,
          ],
          readCapPrompt({
            events,
            total,
            reads,
            readBytes,
            window: ctx.trigger.window,
            calls,
            sessionIds: ctx.trigger.session_ids,
            sessionTotal: sessionTotal(rec),
          }),
          null,
        ),
        target_metric: "tool_result_bytes",
      },
      alternatives: [
        {
          ...perFile,
          option_id: "a1-bound-lead-call",
        },
      ],
    };
  },
  A2: (rec, ctx) => {
    const events = numberFrom(rec, "EVENT_COUNT");
    const largest = numberFrom(rec, "MAX_RESULT_BYTES");
    const total = numberFrom(rec, "RESULT_BYTES_TOTAL");
    const size = (value: number | null) => (value === null ? "not recorded" : byteAmount(value));
    return {
      primary: {
        ...option(
          "a2-compact-subagent-contract",
          "HABIT",
          `Have background tasks write their detail to a file and return a short summary: ${events === null ? "several" : count(events)} results over 10 KB${largest === null ? "" : `, the largest ${byteAmount(largest)}`}.`,
          [
            "For a background agent, put the rule in the brief or agent definition that starts it, or as one line in CLAUDE.md.",
            "For a background shell command, send its output to a log file and read only the lines needed.",
          ],
          cardPrompt({
            title: "Make background tasks return short results",
            intro:
              "found background-task results (TaskOutput) over 10 KB coming back into the main conversation. Find the tasks behind the largest ones: have an agent write its detail to a file and return a short summary, and have a shell command write its output to a log file.",
            context: [
              "TaskOutput returns a background task's output into the main conversation: an agent's final message, or a background shell command's output. It stays there and is re-sent on every later turn until /clear or compaction.",
              "For an agent, the brief that starts it (the Agent call's `prompt`) or its agent definition decides what that message holds. For a shell command, the command decides what it prints.",
              TRANSCRIPTS,
            ],
            findings: [
              `- TaskOutput results over 10 KB: ${events === null ? "not recorded" : count(events)}`,
              `- Largest: ${size(largest)}; total: ${size(total)}`,
              sessionsLine(ctx.trigger.session_ids, sessionTotal(rec)),
            ],
            fix: "Have each agent write its full result to a file and return a short summary (what it found, what it changed, and the file paths), a few hundred words at most. Put that in the brief or agent definition that starts it, or as one line in the project CLAUDE.md if the pattern repeats. For a background shell command, redirect its output to a log file and read only the tail or the matching lines.",
            steps: [
              "In each session above, find the TaskOutput `tool_result` blocks over 10 KB (measure, do not print them) and the call that started each background task (an Agent call or a background shell command).",
              "Say which agent types, briefs or commands produced them, and what part of each result the main conversation used afterwards.",
              "Write the plan: the rule text, the file it goes in (the brief template, `.claude/agents/<name>.md` or CLAUDE.md), and the expected result size.",
              "Ask me to confirm the plan before changing any file.",
              "After I confirm, make the edits.",
              "Verify: show the final text of every rule you added and the file it is in.",
            ],
            notes: ["Do not paste agent results into this conversation; measure and summarise."],
          }),
          null,
        ),
        target_metric: "task_output_result_bytes",
      },
      alternatives: [],
    };
  },
  D6: (rec, ctx) => {
    const bytes = numberFrom(rec, "tool_result_bytes");
    const sessions = numberFrom(rec, "session_count");
    const share = numberFrom(rec, "bloat_share");
    const percent = share === null ? null : `${Math.round(share * 100)}%`;
    // U9: the largest sessions with their bytes, and the Read tool's share.
    const top = (Array.isArray(rec.facts?.top_sessions) ? rec.facts.top_sessions : [])
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.split("|"))
      .filter((parts) => parts.length === 3);
    const readBytes = numberFrom(rec, "read_result_bytes");
    const readCalls = numberFrom(rec, "read_call_count");
    const readLine =
      readBytes === null || bytes === null || bytes <= 0
        ? null
        : `- Read returned ${byteAmountIEC(readBytes)} of the ${byteAmountIEC(bytes)} (${Math.round((readBytes / bytes) * 100)}%)${readCalls === null ? "" : ` in ${count(readCalls)} calls`}`;
    const topLines =
      top.length === 0
        ? [sessionsLine(ctx.trigger.session_ids, sessionTotal(rec))]
        : [
            `- Largest sessions by tool-result size (${count(top.length)} of ${sessions === null ? "these" : count(sessions)}):`,
            ...top.map(
              ([id, size, turns]) =>
                `  - ${id}: ${byteAmountIEC(Number(size))} in ${count(Number(turns))} turns (includes subagent turns)`,
            ),
          ];
    const readShare = readBytes !== null && bytes !== null && bytes > 0 ? readBytes / bytes : null;
    const readFirst = readShare !== null && readShare >= 0.25;
    // U9 r3: every tool's share, so the source after Read (Bash) is named, and the targets behind it.
    const tools = (Array.isArray(rec.facts?.top_tools) ? rec.facts.top_tools : [])
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.split("|"))
      .filter((parts) => parts.length === 3);
    const toolLine =
      tools.length === 0
        ? []
        : [
            `- By tool: ${tools.map(([tool, size, n]) => `${tool} ${byteAmountIEC(Number(size))} in ${count(Number(n))} calls`).join(", ")}`,
          ];
    const targets = rec.tool_calls ?? [];
    const firstFile = targets.find((call) => call.kind === "file");
    const existingRule = existingReadRule(firstFile?.target ?? "~/x");
    // U9 r8: the size threshold comes from the whole-file Reads listed (the smallest one), not a
    // fixed 300 lines that such reads may not reach.
    const wholeReadKb = targets
      .filter((call) => call.kind === "file" && call.tool === "Read" && call.whole_file)
      .map((call) => Math.floor(call.max_bytes / 1024))
      .filter((kb) => kb >= 4);
    const minWholeKb = wholeReadKb.length === 0 ? null : Math.min(...wholeReadKb);
    const readRule =
      minWholeKb === null
        ? D6_READ_RULE
        : `Before reading a file over about ${minWholeKb} KB, Grep for what you need and Read only that range with offset and limit; pipe command output through grep, head or tail.`;
    const readRuleNote =
      minWholeKb === null
        ? " (the 300-line threshold is a suggested starting point, not measured on your data)"
        : ` (${minWholeKb} KB is the smallest whole-file Read listed above; a rule set at 300 lines may not catch Reads that size. The threshold is a starting point, adjust it.)`;
    const targetLines =
      targets.length === 0
        ? []
        : [
            "",
            `Files and commands behind the largest results in the largest sessions above (the ${count(D6_TARGET_EVENTS)} largest results, from the transcripts):`,
            ...targets.map((call) => `- ${callLine(call)}`),
          ];
    return {
      primary: {
        ...option(
          "d6-use-range-reads",
          "HABIT",
          `Narrow the calls behind the largest tool results: ${bytes === null ? "large results" : `${byteAmountIEC(bytes)} of results`} across ${sessions === null ? "several" : count(sessions)} sessions.`,
          [
            "Read files in ranges, filter command output, and search for matching files before reading them.",
          ],
          cardPrompt({
            title: "Cut large tool results out of these sessions",
            intro:
              "found sessions where many mid-size tool results (up to 25 KB each) were re-sent on every later turn, a large share of their spend. Find the calls behind the largest results and make them return only what the task needs.",
            context: [
              "A tool result stays in the conversation and is re-sent on every later turn until /clear or compaction drops it, so one large result is paid for many times.",
              TRANSCRIPTS,
            ],
            findings: [
              `- Sessions: ${sessions === null ? "not recorded" : count(sessions)}; turns: ${labelNumber(numberFrom(rec, "turn_count"), "not recorded")} (assistant turns in this week's window, including subagent turns, not prompts you typed; a later re-count can be a few percent higher as more turns are read)`,
              `- Tool results of up to 25 KB each in those sessions: ${bytes === null ? "not recorded" : byteAmountIEC(bytes)} (sizes are 1,024-based)${percent === null ? "" : `; re-sending them cost about ${percent} of their spend, a modeled estimate of what re-sending cost, not of what a fix would save`}`,
              ...(readLine === null ? [] : [readLine]),
              ...toolLine,
              ...topLines,
              ...targetLines,
            ],
            fix: `${
              existingRule === null
                ? `Ready CLAUDE.md line (add it to the project CLAUDE.md): \`${readRule}\`${readRuleNote}`
                : `${existingRule.file} already has a Read-range rule: "${existingRule.line}". ${
                    existingRule.kb !== null && existingRule.kb >= 25
                      ? `The rule applies to files over ${existingRule.kb} KB, but these results are each at most 25 KB, so reads of smaller files pass it even when they add up; lower the threshold instead of adding a second rule.`
                      : "Tighten it instead of adding a second one."
                  } Ready replacement line: \`${readRule}\`${readRuleNote}`
            } ${
              targets.length > 0
                ? `Then change each call by what it is:\n${targets.map((call) => `- ${d6TargetAsk(call)}`).join("\n")}\nIf one skill or script causes the largest repeat, put the rule there too.`
                : "Then change the calls that return the most: Read with offset and limit after a Grep for line numbers, pipe command output through a filter (grep, head, tail) or write it to a file, and use Grep with files_with_matches before reading. If one skill or script causes the largest repeat, put the rule there too."
            }`,
            steps: [
              readFirst
                ? `Start with Read (${Math.round((readShare ?? 0) * 100)}% of these bytes): in the largest sessions above, rank the Read calls by result size (measure, do not print them) and note which had no offset or limit and which file each read.`
                : "In the largest sessions above, list the largest `tool_result` blocks by size (measure, do not print them), with the tool and the input of the `tool_use` that produced each.",
              "Group them by what was called (the same file, command or search) and say which group repeats most.",
              "Write the plan for that group: the narrower call, and the rule text and the file it goes in.",
              "Ask me to confirm the plan before changing any file.",
              "After I confirm, make the edits.",
              "Verify: show the final text of every rule you added, and the size of the narrower call's result if you ran it.",
            ],
            notes: ["Do not paste large file contents or command output into this conversation."],
          }),
          null,
        ),
        target_metric: "tool_result_byte_share",
      },
      alternatives: [],
    };
  },
  D10: (rec) => {
    const tokens = numberFrom(rec, "catalog_tokens");
    const target = numberFrom(rec, "catalog_target_tokens");
    const alwaysLoad = numberFrom(rec, "always_load_count");
    // U7: per-item disable-list (unused in the window, largest first); absent on older rows.
    const rawList = rec.facts?.disable_list;
    const disableList = Array.isArray(rawList)
      ? rawList.filter((item): item is string => typeof item === "string")
      : [];
    const removable = numberFrom(rec, "removable_tokens");
    const untracked = numberFrom(rec, "skill_use_untracked_count");
    // Skill calls recorded before names were tracked may be uses of a listed item, so "no
    // recorded use" is only claimed when none are untracked.
    const unseen =
      untracked !== null && untracked > 0
        ? "not seen in tracked skill calls this week"
        : "no recorded use this week";
    const named = d10NamedInClaudeMd(disableList);
    const pluginKeys = named.free
      .map((item) => /^plugin (\S+) /.exec(item)?.[1])
      .filter((key): key is string => key !== undefined);
    const settingsSnippet =
      pluginKeys.length > 0
        ? JSON.stringify({ enabledPlugins: Object.fromEntries(pluginKeys.map((k) => [k, false])) })
        : null;
    // The stored facts carry the alwaysLoad count but not whether Tool Search is on.
    const change =
      disableList.length > 0
        ? {
            id: "d10-disable-unused-items",
            summary: `Disable ${count(named.free.length)} catalog item(s) ${unseen}${named.referenced.length > 0 ? ` (${count(named.referenced.length)} more ${named.referenced.length === 1 ? "is" : "are"} named in your CLAUDE.md, so check ${named.referenced.length === 1 ? "it" : "them"} first)` : ""}`,
            fix: 'For a plugin, check that `~/.claude/settings.json` has its key under `"enabledPlugins"` and set it to `false` (or disable it with /plugin). For a standalone skill, move its folder out of `~/.claude/skills`. Confirm each item is really unused before removing it.',
          }
        : alwaysLoad !== null && alwaysLoad > 0
          ? {
              id: "d10-essential-always-load",
              summary: `Remove alwaysLoad from the MCP servers that do not need to be ready on every turn (${count(alwaysLoad)} have it)`,
              fix: "alwaysLoad keeps a server's tool definitions in context on every turn. Remove it from every server whose tools are not used in most sessions; Tool Search loads those when a task needs them.",
            }
          : {
              id: "d10-disable-unused-mcp",
              summary: "Disable the MCP servers, plugins and skills you do not use",
              fix: 'Disable each MCP server, plugin or skill that no recent session used: for a project MCP server, list it in `"disabledMcpjsonServers"` in `.claude/settings.json`; for a plugin, disable it with /plugin.',
            };
    return {
      primary: {
        ...option(
          change.id,
          "INVESTIGATE",
          `${change.summary}: the catalog is about ${tokens === null ? "large" : tokenAmount(tokens)} tokens.`,
          [
            "Keep anything used in most sessions; a removed tool that is needed later costs rework.",
          ],
          cardPrompt({
            title: "Shrink the MCP, plugin and skill catalog",
            intro:
              "estimated that the MCP servers, plugins and skills enabled on this machine add a large catalog of tool definitions and descriptions to the context. Find what is unused and apply the fix below.",
            context: [
              "Tool definitions and skill descriptions load into the start of the prompt. What loads upfront is re-sent on every turn; with Tool Search, MCP tool definitions load only when a task needs them.",
              "The size is an estimate from the configured catalog, not measured per turn.",
              "Settings live in `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json`; MCP servers in `~/.claude.json` and `.mcp.json`.",
            ],
            findings: [
              ...(disableList.length > 0
                ? [
                    `- Skills and plugins: about ${tokens === null ? "not recorded" : tokenAmount(tokens)} tokens loaded every turn; about ${removable === null ? "not recorded" : tokenAmount(removable)} tokens are in items ${unseen}`,
                    "- Disable-list (largest first; plugin sizes include their skills):",
                    ...named.free.map((item) => `  - ${item}`),
                    ...(named.referenced.length > 0
                      ? [
                          "- Named in ~/.claude/CLAUDE.md (a rule there depends on them; keep unless that rule is also dropped):",
                          ...named.referenced.map((item) => `  - ${item}`),
                        ]
                      : []),
                    "- MCP server tool definitions are not sized: they come from the running server.",
                    ...(untracked !== null && untracked > 0
                      ? [
                          `- ${count(untracked)} Skill call(s) this week were recorded before skill names were tracked, so a listed skill may have been used. Check the transcripts for the skill's name before disabling it.`,
                        ]
                      : []),
                    ...(settingsSnippet === null
                      ? []
                      : [
                          `- Ready settings change for the plugins above (merge into the existing "enabledPlugins" object in ~/.claude/settings.json, then confirm with /plugin): ${settingsSnippet}`,
                        ]),
                  ]
                : [
                    // U7 rows (removable set) store the 5%-of-mean-context gate here, not a target.
                    `- Catalog: about ${tokens === null ? "not recorded" : tokenAmount(tokens)} tokens (${removable !== null ? "5% of mean context per turn" : "target"} ${target === null ? "not recorded" : tokenAmount(target)})`,
                  ]),
              `- Catalog items: ${labelNumber(numberFrom(rec, "catalog_item_count"), "not recorded")}; servers with alwaysLoad: ${alwaysLoad === null ? "not recorded" : count(alwaysLoad)}`,
            ],
            fix: change.fix,
            steps: [
              "List the enabled MCP servers, plugins and skills, with where each is configured, without printing their definitions.",
              "Say which were used in recent sessions (search the transcripts for their tool names) and which were not.",
              "Write the plan: each setting to change, the file it is in, and the exact new value.",
              "Ask me to confirm the plan before changing any file.",
              "After I confirm, make the edits.",
              "Verify: show the final value of every setting you changed, and run /mcp to confirm the servers you kept still connect.",
            ],
            notes: ["Do not remove anything I use in most sessions."],
          }),
          null,
        ),
        target_metric: "catalog_context_tokens",
      },
      alternatives: [],
    };
  },
  D2: (rec, ctx) => {
    const sessions = labelNumber(numberFrom(rec, "qualifying_session_count"), "Several");
    const average = numberFrom(rec, "raw_context_average_tokens_per_turn");
    const context = average === null ? "a large" : tokenAmount(average);
    const handoffSkills = existingHandoffSkills();
    const haveHandoff = handoffSkills[0];
    const clearRule = existingClearRule();
    return {
      primary: {
        ...option(
          "d2-split-at-boundaries",
          "HABIT",
          `Start a fresh session at each task boundary: ${sessions} long sessions averaged ${context} tokens of context per model call.`,
          [
            ...(clearRule === null
              ? []
              : [
                  `Your ${clearRule.file} already has a /clear rule ("${clearRule.line}"): these sessions grew past it, so tighten or enforce it instead of adding another.`,
                ]),
            `A task boundary is ${TASK_BOUNDARY}.`,
            "Before /clear, write a short handoff (goal, decisions, files, next step), run /rename, and start the new session from it.",
            "/compact keeps one session going but still carries a summary of everything before it.",
            D2_NOT_BREAKS,
          ],
          longSessionPrompt(rec, ctx.trigger.session_ids, ctx.trigger.window),
          null,
        ),
        target_metric: "avg_context_per_turn",
      },
      alternatives: [
        {
          ...option(
            "d2-handoff-skill",
            "EDIT",
            haveHandoff
              ? `Make your /${haveHandoff} skill the handoff step before you run /clear.`
              : "Add a /handoff skill that writes a short handoff before you run /clear.",
            haveHandoff
              ? [
                  `You already have ~/.claude/skills/${haveHandoff}/SKILL.md; the prompt checks it writes a handoff of about 2K tokens or less and extends it if not.`,
                  "Verify: run it once; the handoff stays under about 2K tokens.",
                ]
              : [
                  `Writes \`${HANDOFF_SKILL_FILE}\` with \`disable-model-invocation: true\`, so it runs only when you type /handoff.`,
                  "Writes one HANDOFF-<branch>.md per branch; start the next session with `@HANDOFF-<branch>.md`.",
                  "Verify: run it once; the handoff stays under about 2K tokens.",
                ],
            handoffSkillPrompt(rec, handoffSkills),
            haveHandoff ? `~/.claude/skills/${haveHandoff}/SKILL.md` : HANDOFF_SKILL_FILE,
          ),
          target_metric: "avg_context_per_turn",
        },
      ],
    };
  },
};

export const contextHandler: FamilyHandler = (rec, ctx) =>
  contextActions[rec.detector_id]?.(rec, ctx) ?? null;
