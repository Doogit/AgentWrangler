import { numberMetric, stringMetric, withTargetMetric } from "../accessor.js";
import { TRANSCRIPTS, callFindings, callLines, cardPrompt, sessionsLine } from "../prompt.js";
import {
  LOOP_KINDS_OVERLAP,
  NOT_FOUND_CAUSES,
  SAME_ERROR_RUN,
  byteAmount,
  c2Cause,
  c2Folder,
  c2LeadCause,
  c2ProbeCalls,
  commandFamily,
  guardMessage,
  isLookupFile,
  listedSessions,
  loopKinds,
  loopTurnShare,
  missingCommand,
  notFoundByCause,
  notFoundCauses,
  notFoundLead,
  notFoundTotals,
  oneToolCalls,
  outlierTools,
  percentOf,
  sessionTotal,
  shellFailureRows,
  times,
  toolFamily,
} from "../trigger.js";
import type { CardAction, CardActions, CardToolCall, FamilyHandler } from "../types.js";

export const ERROR_DETECTOR_IDS = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "D7", "D11"] as const;

/** U9 r3: the C11 card that owns the Read ranges rule (see `cardTitle`). */
export const C11_READ_CARD_TITLE = "Read a smaller part of a large file, or Grep for it.";

// Review 5 M16: named by its card title, not a nickname (A1_TOOL_RESULT_BLOAT's lever).
const A1_CARD_TITLE = "Shrink the large tool result that costs the most in re-sends";

function count(value: number | null, fallback: string): string {
  return value === null ? fallback : value.toLocaleString("en-US");
}

function sessionName(sessionIds: string[]): string {
  return sessionIds[0] ?? "the affected session";
}

function withId(action: CardAction, option_id: string) {
  return { ...action, option_id };
}

function investigate(option_id: string, summary: string, detail: string[]): CardActions {
  return {
    primary: withId(
      {
        kind: "INVESTIGATE",
        summary,
        detail,
        copy_text:
          "# Loop Recovery\n\nOpen the affected session and establish ground truth before retrying. Re-read the current target, identify why the prior attempt failed, state the smallest correct change, then make one targeted change and verify it. Do not repeat an unchanged failed call.",
        file_ref: null,
      },
      option_id,
    ),
    alternatives: [],
  };
}

type Rec = Parameters<FamilyHandler>[0];

/** One INVESTIGATE option carrying a full Copy prompt. */
function prompted(option_id: string, summary: string, detail: string[], prompt: string) {
  return {
    primary: withId(
      { kind: "INVESTIGATE", summary, detail, copy_text: prompt, file_ref: null },
      option_id,
    ),
    alternatives: [],
  } satisfies CardActions;
}

const ERROR_RESULTS =
  'A failed call\'s tool result carries `"is_error":true`; search for it next to the tool name.';

/** Review 5 U8 (M20): keep whole transcripts out of the main conversation. */
const FRESH_SESSION_SCAN =
  "Run this in a fresh session. Scan transcripts with a script (the `message.usage`, `tool_use` and `is_error` fields) or one subagent per session, and bring back only the table; do not read whole transcripts into this conversation.";

/** A failed call's cause, from what it returned (review 5 M8); null when none matches. */
const NULL_READ =
  "a null element or document read (the page may not have been ready, or the selector matched nothing; the error does not say which)";
const SEARCH_TIMEOUT = "a search over too much to finish (Grep's ripgrep timed out)";

/** The one change a cause calls for, when the error text names it outright (U9). */
const C1_CAUSE_FIXES: Record<string, string> = {
  [NULL_READ]:
    "The cause is unknown. The errors are null reads of different things and do not show whether the page was not ready or a selector matched nothing, so no fix is proven. First open each failed input in its transcript and find which it was; if you cannot tell, change nothing. Only if the page was not ready, try this as an unverified trial, not a fix. Ready CLAUDE.md line: \"Before a `javascript_tool` call that queries the page, check `document.readyState === 'complete'` and null-guard each query (for example `document.querySelector(...)?.textContent`).\"",
  [SEARCH_TIMEOUT]:
    "Claude Code's own error says to search a more specific path or pattern. Add one CLAUDE.md line: give Grep the narrowest folder that can hold the answer, and do not Grep a whole `~/.claude/projects` folder. Check the line against the timed-out calls in the transcripts before adding it.",
};

const C1_RESULT_CAUSES: Array<[RegExp, string]> = [
  [/TypeError: Cannot read properties of (?:null|undefined)/i, NULL_READ],
  [/Ripgrep search timed out/i, SEARCH_TIMEOUT],
  [/timed out|frozen|unresponsive/i, "a frozen tab or CDP timeout"],
  [/prompt is too long/i, "a page too big for `find`"],
  [/invalid (?:param|arg)|takes only|unknown (?:param|arg)/i, "a wrong parameter"],
  [/is not recognized|command not found/i, "a missing tool"],
  [/hook error|blocked by/i, "a guard block"],
  [/no such file|cannot find|does not exist|ENOENT/i, "a missing file"],
  [/syntax error|unexpected token|could not parse|parse ?error/i, "shell syntax"],
];

/** The causes each kind of tool usually fails for, when no result names them. */
const C1_FAMILY_CAUSES: Record<string, string[]> = {
  "browser control": [
    "a frozen tab or CDP timeout",
    "a page too big for `find`",
    "a wrong parameter",
  ],
  "shell commands": [
    "shell syntax",
    "a missing tool",
    "the wrong directory",
    "a missing file",
    "a guard block",
  ],
};

/**
 * The causes a C1 prompt groups failures by: those seen in the calls read back, most first, then
 * the usual ones for the outlier tools' kinds (review 5 M8: not a shell list for browser tools).
 */
function c1Causes(rec: Rec): string[] {
  const seen = new Map<string, number>();
  for (const call of rec.tool_calls ?? []) {
    const cause = C1_RESULT_CAUSES.find(([pattern]) => pattern.test(call.result ?? ""))?.[1];
    if (cause !== undefined) seen.set(cause, (seen.get(cause) ?? 0) + call.calls);
  }
  const byFamily = outlierTools(rec).flatMap((tool) => C1_FAMILY_CAUSES[toolFamily(tool)] ?? []);
  const named = [...seen].sort((a, b) => b[1] - a[1]).map(([cause]) => cause);
  // U9: when most calls read back name their cause, the usual causes for the kind of tool are
  // guesses with no evidence behind them, so they are left out.
  const top = c1TopCause(rec);
  const mostlyNamed = top !== null && top.calls * 2 >= top.of;
  const causes = [...new Set([...named, ...(mostlyNamed ? [] : byFamily)])];
  return causes.length === 0 ? ["a wrong parameter", "a missing file", "a missing tool"] : causes;
}

/** The commonest cause the calls read back name, with how many calls show it; null when none does. */
function c1TopCause(rec: Rec): { cause: string; calls: number; of: number } | null {
  const seen = new Map<string, number>();
  let of = 0;
  for (const call of rec.tool_calls ?? []) {
    of += call.calls;
    const cause = C1_RESULT_CAUSES.find(([pattern]) => pattern.test(call.result ?? ""))?.[1];
    if (cause !== undefined) seen.set(cause, (seen.get(cause) ?? 0) + call.calls);
  }
  const top = [...seen].sort((a, b) => b[1] - a[1])[0];
  return top === undefined ? null : { cause: top[0], calls: top[1], of };
}

/** A failure count below this is too few to call a pattern. */
const C1_SMALL_SAMPLE = 10;

/** U9 r4: what a small, partly read-back sample can and cannot show. */
function c1Caveats(rec: Rec, sessionIds: string[]): string[] {
  const errors = numberMetric(rec, "TOOL_ERROR_COUNT");
  const calls = rec.tool_calls ?? [];
  const readBack = calls.reduce((sum, call) => sum + call.calls, 0);
  const lines: string[] = [];
  if (errors !== null && errors < C1_SMALL_SAMPLE) {
    lines.push(
      `- Small sample: ${count(errors, "")} failed call${errors === 1 ? "" : "s"}. That is a lead, not a settled pattern; confirm it in the transcripts before changing a rule.`,
      // U9 r6: scanning transcripts costs tokens too; for a handful of failures that can exceed what they cost.
      "- Cost check: scanning transcripts for this few failures can cost more in tokens than the failures did. A cheaper first step is to open the failed call in each listed session yourself and read its error; scan more widely only if the same error shows up in more than one session.",
    );
  }
  if (errors !== null && errors > readBack) {
    const open = sessionIds.filter((id) => !calls.some((call) => call.session_ids.includes(id)));
    lines.push(
      `- ${count(errors - readBack, "")} of the ${count(errors, "")} failed calls could not be read back, so they are not listed${open.length === 0 ? "" : ` (no call read back for: ${open.join(", ")})`}; open that transcript for its error.`,
    );
  }
  // U9 r6: the stored count of this tool's ERROR results that were left out, so 4 counted against
  // more errors in the database is explained (older findings lack it).
  const excluded = numberMetric(rec, "EXCLUDED_ERROR_COUNT");
  lines.push(
    excluded !== null && excluded > 0 && errors !== null
      ? `- ${count(excluded, "")} more ERROR result${excluded === 1 ? "" : "s"} from this tool in the week (${count(errors + excluded, "")} in all) ${excluded === 1 ? "was" : "were"} not counted as failures (for example browser timeouts, hook blocks, rejected calls, refused Artifact publishes or expected exits). Calls made by subagents are left out too.`
      : "- Not counted as failures, so this tool's other ERROR results in the week are left out: browser timeouts, hook blocks, rejected calls, refused Artifact publishes, and calls made by subagents.",
  );
  if (calls.some((call) => call.target.includes("document.open("))) {
    lines.push(
      "- One failed input began with `document.open();`. Whether that caused its null read is unverified; no rule against it is proposed.",
    );
  }
  return lines;
}

function c1Prompt(rec: Rec, sessionIds: string[], measured: string): string {
  const causes = c1Causes(rec);
  const tools = outlierTools(rec);
  const top = c1TopCause(rec);
  // The cause is named by the errors themselves when most calls read back share it.
  const known = top !== null && top.calls * 2 >= top.of ? C1_CAUSE_FIXES[top.cause] : undefined;
  const failedCount = numberMetric(rec, "TOOL_ERROR_COUNT");
  const small = failedCount !== null && failedCount < C1_SMALL_SAMPLE;
  return cardPrompt({
    // U9 r9: a few failures are not "so many".
    title: small
      ? `Check ${count(failedCount, "")} failed ${tools.length === 1 ? `\`${tools[0]?.split("__").pop()}\` ` : "tool "}calls`
      : "Find why so many tool calls are failing",
    intro:
      "found tool calls failing more often than usual. Check whether any cause repeats, and fix only the causes that do, once.",
    context: [
      `A failed call returns an error and Claude spends a turn working around it. For these tools the likely causes are: ${causes.join(", ")}.`,
      TRANSCRIPTS,
      ERROR_RESULTS,
      // A scan costs more than a handful of failures did (see the Cost check): not advised then.
      ...(small ? [] : [FRESH_SESSION_SCAN]),
    ],
    findings: callFindings(
      rec,
      sessionIds,
      [
        `- Failed calls: ${measured}`,
        ...(tools.length === 0 ? [] : [`- Tools (exact names): ${tools.join(", ")}`]),
        ...(top === null || known === undefined
          ? []
          : [
              `- Cause the errors name: ${top.cause}, in ${top.calls} of the ${top.of} calls read back`,
            ]),
        ...c1Caveats(rec, sessionIds),
      ],
      'search the transcripts above for tool results with `"is_error":true`.',
    ),
    fix:
      known ??
      "Fix each cause that repeats where it starts: one CLAUDE.md line for a habit, an install or PATH fix for a missing tool, a smaller page or a fresh tab for a browser timeout, or a fix to a broken script. Leave one-off failures alone.",
    steps: small
      ? // U9 r7: a handful of failures is worth four steps, not seven: read the errors, then decide.
        [
          'For each session above, open its transcript, find the failed calls of the tools above (`"is_error":true` next to the tool name) and read each error and the input that caused it.',
          "Say whether the same error shows up in more than one session. If it does not, stop here and change nothing.",
          "If it does, propose the smallest fix (one CLAUDE.md line, an install or PATH step, or a script change). Ask me to confirm the plan before changing any file, then make the edit.",
          "Verify: re-read what you changed and re-run one read-only example call (a screenshot, reading the page or a file, a search); never re-run a click, form input, submitting navigation or a script that changes a page or file, but describe it instead.",
        ]
      : [
          "For each session above, scan its transcript with the script or subagent from the Context and list the failed calls: the tool, the command or input, and the first line of the error.",
          `Group them by cause (${causes.join(", ")}, other) and count each group.`,
          "Check whether any cause repeats. For each one that does, find what led Claude there: an instruction, a script, or a habit.",
          "Propose the smallest fix for each repeating cause: one CLAUDE.md line, an install or PATH step, or a script change.",
          "Ask me to confirm the plan before changing any file.",
          "After I confirm, make the agreed edits.",
          "Verify: re-run one read-only example call from each fixed group (a screenshot, reading the page or a file, a search); never re-run a click, form input, submitting navigation or a script that changes a page or file, but describe it instead. Re-read every file you changed.",
        ],
    notes: [
      "If the fix is an MCP server change, make MCP changes at the start of a session: a change to the tool list rewrites the cache.",
      "AgentWrangler compares these tools' error rate per call in later sessions with before, across all projects, so work in another project can move it too. Using a tool much less leaves too few calls to measure; it does not count as a fix. Some browser timeouts are flaky and no fix removes them. Fewer is the goal.",
    ],
  });
}

type NotFoundCause = NonNullable<CardToolCall["cause"]>;

/** The one change a missing-path card proposes, for the cause behind most of its lookups. */
const C2_FIXES: Record<NotFoundCause, { summary: string; fix: string; verify: string }> = {
  GUESSED_PATH: {
    summary: "fix the stale reference, or add a Glob-first line if Claude guessed",
    fix: "Fix the source of the wrong paths. If one came from a plan, handoff, memory note or CLAUDE.md, correct the path there. If Claude guessed, add one CLAUDE.md line telling it to locate an unfamiliar file with Glob before reading it.",
    verify:
      "Verify: re-read the file you changed and use Glob to confirm the path it now names exists.",
  },
  WRONG_WORKTREE: {
    summary:
      "add a CLAUDE.md line to Glob a named path first and build paths from the current worktree",
    fix: "Add this to CLAUDE.md:\n\n```markdown\nBefore reading a path you did not build from the current checkout (one from a plan, a handoff or a memory note), Glob for its file name. In a worktree, build paths from `git rev-parse --show-toplevel`; from the root checkout, a file that a worktree made lives under `.worktrees/<slug>/`, so check there.\n```\n\nIf a plan or handoff names main-checkout paths for worktree work, say so in that file too.",
    verify:
      "Verify: re-read CLAUDE.md, quote the line you added, and check no other rule contradicts it.",
  },
  WORKTREE_GONE: {
    summary:
      "stop handoffs and plans naming a worktree path, and keep those files at a path that outlives the worktree",
    fix: "The paths name a worktree folder (`.worktrees/<slug>/…`) that is no longer on disk. Check each file first: `git check-ignore -v <path>` says whether git ignores it (an ignored or untracked file is on no branch and goes when its worktree is removed), and `git log --all -- <path>` says whether it was ever committed. Then add one line where handoffs and plans are written (CLAUDE.md or the handoff skill):\n\n```markdown\nWrite a handoff or plan to the main checkout's path (or commit it) and name that path in the file; never name a `.worktrees/<slug>/` path, because the worktree is removed after merge.\n```\n\nIf the file still exists elsewhere (Glob its name), correct the reference that named the worktree path.",
    verify:
      "Verify: re-read the file you changed, quote the line, and Glob the file name of each path above to say where it is now.",
  },
  PROBE: {
    summary: "leave the deliberate probes alone",
    fix: "These lookups were deliberate probes; no fix is needed.",
    verify: "Verify: nothing to change.",
  },
  NOT_ON_BRANCH: {
    summary: "add a CLAUDE.md line to check the branch before reading a named file",
    fix: "Add one CLAUDE.md line: before reading a file named in a plan, handoff or earlier message, check it is on the current branch (`git ls-files <path>`); if it lives on another branch, read it with `git show <branch>:<path>` or work in that branch's worktree.",
    verify:
      "Verify: re-read CLAUDE.md, quote the line you added, and check no other rule contradicts it.",
  },
  WRONG_FOLDER: {
    summary: "add a short repo map to CLAUDE.md",
    fix: "Add a short repo map to CLAUDE.md: one line per main source folder saying what lives there (for example `src/detector/detectors/`: one file per detector), so Claude builds a path from the map instead of guessing the folder. Keep it to the folders the wrong paths above missed and their neighbours.",
    verify:
      "Verify: re-read CLAUDE.md, check every folder the map names exists (Glob), and quote the map.",
  },
  OTHER_SCRATCHPAD: {
    summary: "add a handoff rule to never point at a scratchpad file",
    fix: "Add one rule where handoffs and plans are written (the handoff skill, or CLAUDE.md): never point a handoff or plan at a scratchpad file; copy what the next session needs into the repo or into the handoff itself. A scratchpad is temporary and belongs to one session.",
    verify:
      "Verify: re-read the file you changed, quote the rule, and check that no current handoff or plan still names a scratchpad path.",
  },
};

/** Lookups the card counts but could not read back (their input is in no transcript it read). */
function c2Unread(rec: Rec): number {
  const { lookups } = notFoundTotals(rec);
  const read = notFoundCauses(rec).reduce((sum, [, n]) => sum + n, 0);
  return lookups === null ? 0 : Math.max(0, lookups - read);
}

function c2Probes(rec: Rec): CardToolCall[] {
  return c2ProbeCalls(rec.tool_calls ?? []);
}

/** The cause the fix is written for: the lead, or for a tie with the worktree cause, that one. */
function c2FixCause(rec: Rec): NotFoundCause {
  const top = notFoundLead(rec);
  return top === null ? "GUESSED_PATH" : c2LeadCause(top.causes);
}

/** U9 r8: a probe is counted in its own bucket, not under a cause, so the causes add up to the total. */
function c2ProbeBucket(rec: Rec): string {
  return c2Probes(rec).length === 0
    ? ""
    : `; it is counted on its own, as "${NOT_FOUND_CAUSES.PROBE.phrase}", not as a guessed path`;
}

function c2Probed(rec: Rec): number {
  return c2Probes(rec).reduce((sum, call) => sum + call.calls, 0);
}

function c2Prompt(rec: Rec, sessionIds: string[], measured: string): string {
  const causes = notFoundCauses(rec);
  const lead = C2_FIXES[c2FixCause(rec)];
  const calls = rec.tool_calls ?? [];
  const probed = c2Probed(rec);
  return cardPrompt({
    title: "Find where Claude got paths that do not exist",
    intro:
      "found tool calls that failed because the path did not exist. Each wrong path costs a failed call and a retry. Find where the paths came from. Fix only a cause the calls below show; where a lookup's cause is unknown, say so instead of guessing one.",
    context: [
      "Wrong paths have a few causes: a guess (a file that was renamed or moved, or a name Claude assumed), the right file name in the wrong folder, a file that exists only on another branch, a path in a different worktree than the one Claude was working in, or a file in another session's scratchpad, which is temporary and belongs to that session.",
      TRANSCRIPTS,
    ],
    findings: [
      `- Missing-path lookups: ${measured}`,
      ...(causes.length === 0
        ? []
        : [`- By cause: ${notFoundByCause(causes, notFoundTotals(rec).lookups)}`]),
      ...(probed === 0
        ? []
        : [
            `- Deliberate probes, not Claude mistakes: ${count(probed, "")} of these lookups searched a folder whose name says it is absent (\`${c2Folder(c2Probes(rec)[0])}\`)${c2ProbeBucket(rec)}. Leave them out when you look for a cause.`,
          ]),
      "- The count includes lookups made inside subagents; the dollar figure prices the main conversation's turns only, so subagent lookups are counted but not priced.",
      sessionsLine(sessionIds, sessionTotal(rec)),
      ...(calls.length === 0
        ? [
            "- No calls could be read back; search the transcripts above for tool results that say `File does not exist` or `Path does not exist`.",
          ]
        : [
            "",
            // U9 r4: every call read back is listed; the ones that could not be read back are counted.
            `Calls read back from the transcripts, by cause (tool, how often, what Claude Code returned)${c2Unread(rec) > 0 ? `; ${c2Unread(rec)} of the ${notFoundTotals(rec).lookups} lookups could not be read back, so they are not listed (only the main conversation's calls are read back, so subagent lookups are among them; search the transcripts, subagents' included, for the two messages above)` : ""}:`,
            ...causes.flatMap(([cause]) => [
              `${NOT_FOUND_CAUSES[cause].label}:`,
              ...callLines(calls.filter((call) => c2Cause(call) === cause)),
            ]),
          ]),
    ],
    fix: lead.fix,
    steps: [
      "For each call above, open the session's transcript and find the failed call and its error.",
      "Find where the path came from: search the transcript before the call for the path text (a file Claude read, a message of mine, a plan, handoff or memory note). If it appears nowhere, Claude guessed it.",
      "Find the right path now with Glob on the file name. Say whether the file was renamed, moved, deleted or never existed.",
      "Propose the smallest fix for the commonest cause, as described above. It covers that cause only; list the other causes and the lookups whose cause is unknown separately, without proposing a fix for them.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the edit.",
      lead.verify,
    ],
    notes: [
      "A path that was right when written and later moved needs the reference fixed, not a new rule.",
    ],
  });
}

/** U9 r8: the C3 prompt: every file and session behind the card, and the checks that find the cause. */
function c3Prompt(
  rec: Rec,
  sessionIds: string[],
  calls: string,
  across: string,
  split: string | null,
): string {
  const files = (rec.tool_calls ?? []).map((call) => {
    const sub = call.subagent_calls ?? 0;
    return `- ${call.tool} \`${call.target}\`: ${times(call.calls)}${sub > 0 ? `, ${count(sub, "")} of them in subagents` : ""}`;
  });
  return cardPrompt({
    title: "Find why Edit and Write ran before the file was read",
    intro: `found ${calls} rejected because the file had not been read first${across}${split === null ? "" : `: ${split}`}. Find out, file by file, whether the Read was missing from the dispatch prompt or from the main thread's own steps.`,
    context: [
      "Edit and Write refuse a file that was not read earlier in the same conversation. A subagent starts with no reads, so its dispatch prompt must name the files and tell it to read them.",
      "The rule to add to CLAUDE.md is on the card; this prompt is the evidence behind it.",
      TRANSCRIPTS,
    ],
    findings: [
      `- Rejected calls: ${calls}${across}`,
      ...(split === null ? [] : [`- Threads: ${split}`]),
      sessionsLine(sessionIds, sessionTotal(rec)),
      ...(files.length === 0
        ? [
            "- No files could be read back; search the transcripts for `File has not been read yet`.",
          ]
        : ["", "Files (tool, how often):", ...files]),
    ],
    fix: "If the missing Read is in a dispatch prompt, add the file names and the read-first sentence to the dispatch template or skill preamble that wrote it. If it is the main thread's own, the CLAUDE.md rule on the card is the fix. If a file was a Write to a file that already existed, use a new file name or Read it first.",
    steps: [
      "For each file above, open a listed session's transcript and find the rejected call.",
      "Say whether it ran in the main thread or a subagent, and whether any Read of that file came before it in that conversation.",
      "For a subagent call, open the dispatch prompt that started it: does it name the file and say to read it first? Say which dispatch template or skill wrote it.",
      "Propose the smallest change per cause. Do not add a rule for a cause the transcripts do not show.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the edit.",
      "Verify: re-read each file you changed and quote the line you added.",
    ],
    notes: [
      "Subagent transcripts are in the session's `subagents/` folder; a file's subagent count above tells you which to open.",
    ],
  });
}

/**
 * C5's step 3: the likely cause, read from the looping error's own text (the finding keeps no
 * class label), or the general list when the text matches none.
 */
function c5CauseStep(errorText: string | null): string {
  const text = errorText ?? "";
  if (/has not been read yet|not been read/i.test(text)) {
    return '3. The error says the file was not read first. That failure is covered on the card "Read a file\'s current contents before issuing an Edit or Write to it."; the fix is there. Here, check only whether Claude read the file in this session before the Write or Edit.';
  }
  if (/modified since read|has been (?:unexpectedly )?modified/i.test(text)) {
    return "3. The error says the file changed after Claude read it. Check what changed it in between (a formatter, a hook, another agent) and re-read it before editing.";
  }
  if (/found \d+ matches|multiple matches/i.test(text)) {
    return "3. The error says the text to replace matches more than once. The fix is more surrounding text so the match is unique, or a replace-all if every match should change.";
  }
  return "3. Identify the root cause (for example a missing file, wrong working directory, missing tool, permission prompt or bad syntax) and check whether it still applies in the current repo.";
}

/**
 * C4's cause, read from the commonest failed Edit's first error line (the finding keeps no class
 * label); null when the text matches none, so the card falls back to the general advice.
 */
function c4Cause(errorText: string | null): { name: string; fix: string } | null {
  const text = errorText ?? "";
  if (/not been read/i.test(text)) {
    return {
      name: "the file was not read first",
      fix: 'The error says the file was not read first. That failure is covered on the card "Read a file\'s current contents before issuing an Edit or Write to it."; fix it there. A subagent has to read the file itself.',
    };
  }
  if (/modified since read|has been (?:unexpectedly )?modified/i.test(text)) {
    return {
      name: "the file changed after it was read",
      fix: "The error says the file changed after Claude read it. Check what changed it in between (a formatter, a hook, another agent) and re-read it before editing.",
    };
  }
  if (/found \d+ matches|multiple matches/i.test(text)) {
    return {
      name: "the text to replace matched more than once",
      fix: "The error says the text to replace matches more than once. Include more surrounding text so the match is unique, or replace all matches if every one should change.",
    };
  }
  if (/string to replace not found|did not match|not found in file/i.test(text)) {
    return {
      name: "the text to replace was not found",
      fix: "The error says the text to replace is not in the file. Re-read the file and copy the exact current text, including whitespace, instead of retrying from memory.",
    };
  }
  return null;
}

/** An error's text without the harness's `<tool_use_error>` wrapper; null when nothing is left. */
function cleanError(text: string | null): string | null {
  const clean = (text ?? "").replace(/<\/?tool_use_error>/gi, "").trim();
  return clean === "" ? null : clean;
}

/** The commonest failure in a C7 cluster, as " (commonest: exit 1, 'first error line')"; empty on older findings. */
function c7Cause(rec: Rec): string {
  const exit = stringMetric(rec, "FAILURE_EXIT_CODE");
  const line = stringMetric(rec, "FAILURE_FIRST_LINE");
  const head = stringMetric(rec, "FAILURE_COMMAND_HEAD");
  if (exit === null && line === null) return "";
  const said = line === null || line === "" ? "" : `, first error line "${line}"`;
  const ran = head === null ? "" : ` of \`${head}\``;
  return ` (commonest: exit ${exit ?? "?"}${ran}${said})`;
}

function c7Prompt(rec: Rec, sessionIds: string[], measured: string): string {
  return cardPrompt({
    title: "Find why the same kind of command keeps failing",
    intro:
      "found shell commands of one kind that failed again and again. Each failure costs a turn while Claude retries. Find the shared cause and fix it once.",
    context: [
      "Repeated failures of one kind usually share a cause: a tool that is not installed or not on PATH, the wrong working directory, a missing environment value, or a command written for a different shell.",
      TRANSCRIPTS,
      ERROR_RESULTS,
    ],
    findings: callFindings(
      rec,
      sessionIds,
      [`- Failed commands: ${measured}`],
      'search the transcripts above for Bash tool results with `"is_error":true`.',
    ),
    fix: 'Fix the shared cause where it starts. A missing tool: install it or add it to PATH. A directory or shell habit: one CLAUDE.md line. A missing non-secret value: an `env` entry in `.claude/settings.json`, such as `{ "env": { "NAME": "value" } }`. Export secrets in the shell before launch; never write them to settings.',
    steps: [
      "For each session above, open its transcript and list the failed Bash calls: the command, the working directory, and the first line of the error.",
      "Group them by cause and count each group. Say which group covers most failures.",
      "For the top group, check whether the cause still applies: look for a missing tool with `command -v` or `Get-Command`, or check the directory or value. Do not re-run a command that changes anything.",
      "Propose the smallest fix for the top group, and for the second if it is large.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the agreed edits.",
      "Verify: re-run one example command from each fixed group, or explain why it cannot run here. Re-read every file you changed.",
    ],
    notes: ["AgentWrangler re-measures failed commands in later sessions."],
  });
}

function d7RereadPrompt(
  sessionIds: string[],
  total: number,
  measured: string[],
  spread: string,
): string {
  return cardPrompt({
    title: "Stop re-reading the same files session after session",
    intro: `found files that later sessions read again and again. Each re-read rebuilds context an earlier session already had. Find the files read in many of them (${spread}) and point Claude at the part it needs.`,
    context: [
      "Reading a file puts its whole content into context until /clear, compaction or Claude Code's tool-result clearing drops it. A file that many sessions read (a plan, a status table, a large reference) costs that read in each one.",
      "Some re-reads are needed: code being edited must be read fresh. The ones worth fixing are reference files read for the same facts each time.",
      TRANSCRIPTS,
      FRESH_SESSION_SCAN,
    ],
    findings: [...measured, sessionsLine(sessionIds, total)],
    fix: "For the few reference files read in many sessions, add a one-line pointer in CLAUDE.md or the handoff: the file and the section to read for each kind of task. Put the pointer, not the content: a copy in CLAUDE.md loads on every turn and goes stale. A pointer is a plain path, not an `@path` import: an import loads the whole file into every session. If a file is large because it covers several topics, split it so sessions read only the part they need. Leave files that are read because they are being edited.",
    steps: [
      'For each session above, scan its transcript with that script and list the Read calls (`"name":"Read"`) with their `file_path`.',
      "Count, per file, how many of these sessions read it. Keep the top 10.",
      "For each top file, say why the sessions read it: to edit it, or to look something up. Note what they looked up.",
      "For the look-up files, propose the smallest fix: a one-line pointer to the section, or a split.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the agreed edits.",
      "Verify: re-read every file you changed and check each pointer names a section that exists.",
    ],
    notes: [],
  });
}

/**
 * U9 r7: the fix starts from this user's most repeated call and its error, with a ready rule for
 * it, instead of a generic example rule.
 */
function d7LoopFix(example: CardToolCall | undefined): string {
  if (example === undefined) {
    return "Find the two or three most common loop triggers and add one short CLAUDE.md rule for each, such as: after the same error twice, stop, re-read the target, and change the approach or ask me.";
  }
  const error = example.result === undefined ? null : guardMessage(example.result);
  const call = `${example.tool} on \`${example.target}\``;
  const rule =
    error === null
      ? `When ${example.tool} is about to run again with the same input it just used, stop: say what you expect to change, or change the input.`
      : `When ${example.tool} returns "${error}" twice, stop retrying: read the error, fix its cause, then try once more or ask me.`;
  return `Start with the most repeated call above: ${call}, ${times(example.calls)} in one session${error === null ? "" : `, returning "${error}"`}. Find what set it off, and add a rule like this one to CLAUDE.md (adjust it to the cause you find):\n\n${rule}\n\nThen check whether the other loops share that trigger; add a rule for another trigger only if it repeats too.`;
}

function d7LoopPrompt(
  sessionIds: string[],
  total: number,
  measured: string[],
  example?: CardToolCall,
): string {
  return cardPrompt({
    title: "Break the retry loops that repeat the same call",
    intro:
      "found turns spent repeating the same call or the same error. Each repeat re-sends the whole context. Find the loops, what set them off, and the instruction that would have stopped them.",
    context: [
      `A loop is the same tool call made again with the same input, or the same error returned again after a retry. ${SAME_ERROR_RUN} Past the second try, a repeat rarely succeeds.`,
      TRANSCRIPTS,
      FRESH_SESSION_SCAN,
    ],
    findings: [...measured, sessionsLine(sessionIds, total)],
    fix: d7LoopFix(example),
    steps: [
      "For each session above, scan its transcript with that script and find runs where the same tool is called with the same input two or more times in a row, or where the same error comes back after a retry.",
      "For each run, write: session, tool, input (short), error, number of repeats, and what finally broke the loop.",
      "Classify each run as same-error or repeated-read before proposing a fix: same-error when the same error came back; repeated-read when a file was read again with no edit between. For a repeated read, check whether a compaction came between the two reads (the transcript marks it).",
      "Group the runs by trigger (a stale view of a file before an edit, a command that cannot work here, a guard block, a flaky test, other) and count them.",
      "Propose one short CLAUDE.md rule for each of the top two or three triggers.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, add the rules.",
      "Verify: re-read CLAUDE.md, quote the lines you added, and check none contradicts an existing rule.",
    ],
    notes: ["AgentWrangler re-measures the share of turns spent in loops in later sessions."],
  });
}

function d11Actions(rec: Rec, sessionIds: string[]): CardActions {
  const preferred = stringMetric(rec, "preferred_tool") ?? "the lower-error shell";
  const higher = stringMetric(rec, "higher_error_tool") ?? "the higher-error shell";
  const rate = (tool: string) => {
    const ratio = numberMetric(rec, `${tool.toLowerCase()}_error_ratio`);
    return ratio === null ? "an elevated rate" : percentOf(ratio);
  };
  const calls = (tool: string) => {
    const errors = numberMetric(rec, `${tool.toLowerCase()}_error_count`);
    const total = numberMetric(rec, `${tool.toLowerCase()}_call_count`);
    return errors === null || total === null
      ? rate(tool)
      : `${count(errors, "")} of ${count(total, "")} calls (${rate(tool)})`;
  };
  const rule = `Prefer ${preferred} for repository and file operations; use ${higher} only for platform-specific needs.`;
  // Review 5 minor: the extra failures a week at the other shell's rate, not "far more often".
  const errors = numberMetric(rec, `${higher.toLowerCase()}_error_count`);
  const total = numberMetric(rec, `${higher.toLowerCase()}_call_count`);
  const usual = numberMetric(rec, `${preferred.toLowerCase()}_error_ratio`);
  const extra =
    errors === null || total === null || usual === null ? null : Math.round(errors - total * usual);
  const often =
    extra === null || extra <= 0
      ? `fail far more often than ${preferred} calls in my sessions`
      : `fail more often than ${preferred} calls in my sessions: about ${count(extra, "")} more failures a week than my usual rate (the ${preferred} rate)`;
  // Review 5 M11: the top shell-caused failures are Unix commands piped in PowerShell.
  const pipes = higher === "PowerShell" && preferred === "Bash";
  const block = pipes
    ? `Do not pipe to \`grep\`, \`head\` or \`tail\` in PowerShell; run those commands in Bash.\n${rule}`
    : rule;
  const summary = pipes
    ? `Stop piping \`grep\`, \`head\` and \`tail\` in PowerShell: use Bash for them (PowerShell errors were ${rate(higher)} versus ${rate(preferred)}).`
    : `Route repository and file operations to ${preferred}; ${higher} errors were ${rate(higher)} versus ${rate(preferred)}.`;
  const rows = shellFailureRows(rec.tool_calls ?? []).slice(0, 5);
  return {
    primary: withId(
      {
        kind: "EDIT",
        summary,
        detail: [
          "Keep the higher-error shell for platform-specific needs; this rule does not grant permissions.",
          "Rollback: remove the Shell Routing block added by this action.",
        ],
        copy_text: cardPrompt({
          title: `Route repository and file work to ${preferred}`,
          intro: `found that ${higher} calls ${often}. Each failed call costs a turn while Claude retries. Add a short shell-routing rule to CLAUDE.md.`,
          context: [
            `Claude Code can run shell commands through ${preferred} or ${higher}. Commands written for one shell often fail in the other (quoting, paths, pipes, built-ins).`,
            TRANSCRIPTS,
            ERROR_RESULTS,
          ],
          findings: [
            `- ${higher} errors: ${calls(higher)}`,
            `- ${preferred} errors: ${calls(preferred)}`,
            "- Counted over every shell call in this workspace that ran, including subagents; calls blocked before they ran, expected exits (taskkill of a finished process, a free-port probe) and failing test, lint, typecheck or build runs (a fault in the code, not the shell) are left out",
            // Review 5 M12: a row is named by the command the shell did not have, if any.
            ...rows.map((row) =>
              missingCommand(row.result ?? "") !== undefined
                ? `- \`${row.target}\` in ${higher}: ${count(row.calls, "")}`
                : `- ${higher} failure: \`${row.target}\` ${times(row.calls)}`,
            ),
            sessionsLine(sessionIds, sessionTotal(rec)),
          ],
          fix: `Add this block to CLAUDE.md:\n\n\`\`\`markdown\n## Shell Routing\n\n${block}\n\`\`\``,
          steps: [
            "Read CLAUDE.md and note any rule about shells that this block would contradict.",
            `For a few sessions above, list the failed ${higher} calls and check that most are repository or file work ${preferred} handles, not tasks only ${higher} can do.`,
            `Propose the block, naming the ${higher}-only tasks you found so the rule keeps them.`,
            "Ask me to confirm the text before changing CLAUDE.md.",
            "After I confirm, add the block.",
            "Verify: re-read CLAUDE.md, quote the block, and check no other rule contradicts it.",
          ],
          notes: ["AgentWrangler re-measures the error rate per shell in later sessions."],
        }),
        file_ref: "CLAUDE.md",
      },
      "d11-route-repository-shell",
    ),
    // Removing Bash would leave Claude Code without a shell on most systems, so only PowerShell is offered.
    alternatives:
      higher === "PowerShell"
        ? [
            ...(rec.guard_exists === true ? [d11GuardOption(rec, sessionIds, calls)] : []),
            withId(
              {
                kind: "CONFIG",
                summary: `Remove the PowerShell tool so every shell call goes through ${preferred}.`,
                detail: [
                  "A deny rule on the tool name removes the tool from Claude Code entirely.",
                  "It goes in your own `.claude/settings.local.json`, not the committed settings; apply it at the start of a session, because removing a tool rewrites the cache.",
                  "Rollback: remove the added PowerShell entry from permissions.deny in `.claude/settings.local.json`.",
                ],
                copy_text: cardPrompt({
                  title: "Remove the PowerShell tool",
                  intro: `found that PowerShell calls ${often}. Remove the PowerShell tool so Claude uses ${preferred} for everything.`,
                  context: [
                    'A deny rule that names a tool without a pattern (`"PowerShell"`) removes that tool: Claude no longer sees it.',
                    "Removing a tool changes the tool list at the start of every prompt, so the whole cache is written again; do it at the start of a session.",
                    TRANSCRIPTS,
                  ],
                  findings: [
                    `- PowerShell errors: ${calls("PowerShell")}`,
                    `- ${preferred} errors: ${calls(preferred)}`,
                    sessionsLine(sessionIds, sessionTotal(rec)),
                  ],
                  fix: 'Merge this deny entry into the project\'s `.claude/settings.local.json` (your own settings, not committed), keeping every other rule:\n\n```json\n{\n  "permissions": {\n    "deny": ["PowerShell"]\n  }\n}\n```',
                  steps: [
                    "For a few sessions above, list the PowerShell calls that worked and check none of them needs PowerShell (Windows-only cmdlets, registry, services).",
                    "Read `permissions` in `.claude/settings.local.json` and `.claude/settings.json` and note any rule that mentions PowerShell.",
                    "Ask me to confirm before changing the file.",
                    "After I confirm, merge the entry into `.claude/settings.local.json`, then apply at the start of a session: removing a tool rewrites the cache.",
                    "Verify: re-read the file, check it is still valid JSON with every other rule unchanged, and quote what you added.",
                  ],
                  notes: ["AgentWrangler re-measures the error rate per shell in later sessions."],
                }),
                file_ref: ".claude/settings.local.json",
              },
              "d11-deny-powershell",
            ),
          ]
        : [],
  };
}

/**
 * Review 5 M11: in a workspace with a PreToolUse guard, one more matcher stops the pipes where
 * they start. The guard may match only Bash today, so the PowerShell matcher is the change.
 */
function d11GuardOption(
  rec: Rec,
  sessionIds: string[],
  calls: (tool: string) => string,
): CardAction & { option_id: string } {
  return withId(
    {
      kind: "INVESTIGATE",
      summary:
        "Add a `PowerShell` matcher to your existing guard that blocks `| grep`, `| head` and `| tail` (the guard may match only `Bash` today).",
      detail: [
        "Your guard already blocks other risky shell shapes here, so the rule belongs with them.",
        "The guard's message names the PowerShell command to use instead, or says to run the command in Bash.",
      ],
      copy_text: cardPrompt({
        title: "Block Unix pipes in PowerShell with my PreToolUse guard",
        intro:
          "found PowerShell calls failing because they pipe into `grep`, `head` or `tail`, which PowerShell does not have. My PreToolUse guard already blocks other shell shapes in this project, so extend it to PowerShell.",
        context: [
          'The guard is the script behind `hooks.PreToolUse` in `~/.claude/settings.json` or `.claude/settings.json`. Its matcher says which tools it sees; it receives each call as JSON on stdin (`{"tool_name":"PowerShell","tool_input":{"command":"…"}}`), and exiting with code 2 blocks the call and shows Claude the message it wrote to stderr.',
          TRANSCRIPTS,
        ],
        findings: [
          `- PowerShell errors: ${calls("PowerShell")}`,
          ...shellFailureRows(rec.tool_calls ?? [])
            .slice(0, 5)
            .filter((row) => missingCommand(row.result ?? "") !== undefined)
            .map((row) => `- \`${row.target}\` in PowerShell: ${count(row.calls, "")}`),
          sessionsLine(sessionIds, sessionTotal(rec)),
        ],
        fix: "Add `PowerShell` to the guard's matcher (for example `Bash|PowerShell`) and one rule in the script: block a PowerShell command that pipes into `grep`, `head` or `tail`, with a message that names `Select-String`, `Select-Object -First` and `Select-Object -Last`, or says to run the command in Bash. Keep every other rule and leave Bash calls as they are.",
        steps: [
          "Find the guard: read `hooks.PreToolUse` in `~/.claude/settings.json` and `.claude/settings.json`, note its matcher, and open the script it runs.",
          "Check the script reads `tool_name` so a Bash-only rule does not start matching PowerShell commands.",
          "Propose the matcher change and the rule, written in the guard's own style.",
          "Ask me to confirm the plan before changing any file.",
          "After I confirm, make the edits.",
          'Verify: run the guard script with `{"tool_name":"PowerShell","tool_input":{"command":"git log | head -5"}}` and with `git log -5` as its JSON input. The first must be blocked and the second must pass. Re-read every file you changed.',
        ],
        notes: [
          "Never delete the guard or turn hooks off.",
          "AgentWrangler re-measures the error rate per shell in later sessions.",
        ],
      }),
      file_ref: null,
    },
    "d11-add-to-guard",
  );
}

const errorsActions: Record<
  string,
  (
    rec: Parameters<FamilyHandler>[0],
    sessionIds: string[],
    window: { from: string; to: string } | null,
  ) => CardActions
> = {
  C1: (rec, sessionIds) => {
    const errors = numberMetric(rec, "TOOL_ERROR_COUNT");
    const total = numberMetric(rec, "TOOL_CALL_COUNT");
    const ratio = numberMetric(rec, "TOOL_ERROR_RATE");
    // Review 3 B7: no "N times your usual rate"; the tools were picked for a high rate.
    const rate = ratio === null ? "" : percentOf(ratio);
    const calls =
      errors === null || total === null ? "tool calls" : oneToolCalls(rec, errors, total);
    const measured = rate === "" ? calls : `${calls} (${rate})`;
    const small = errors !== null && errors < C1_SMALL_SAMPLE;
    return prompted(
      "c1-investigate-tool-error-rate",
      small
        ? `Read the error of each failed call in the listed sessions (${measured} failed) before anything else, and change a rule only if the same error repeats.`
        : `Find why ${measured} failed, and check whether any cause repeats; fix the ones that do.`,
      [
        small
          ? "Few failures: the Copy prompt asks for four steps, not a transcript scan, because a scan can cost more than the failures did."
          : "The Copy prompt groups the failures by cause and fixes only the causes that repeat.",
      ],
      c1Prompt(rec, sessionIds, measured),
    );
  },
  C2: (rec, sessionIds) => {
    const { lookups, sessions } = notFoundTotals(rec);
    const measured = `${count(lookups, "several")} across ${count(sessions, "")} session${sessions === 1 ? "" : "s"}`;
    const causes = notFoundCauses(rec);
    const lead = C2_FIXES[c2FixCause(rec)];
    // U9 r6: the fix covers the commonest cause only; say how much of the total that is.
    // U9 r7: counted among the lookups read back, without deliberate probes; a tie is a tie.
    const top = notFoundLead(rec);
    const scope =
      top === null
        ? `, and ${lead.summary}`
        : top.causes.length > 1
          ? // U9 r9: the fix covers one of the tied causes; name which one.
            `; the commonest causes tie (${top.causes.map((c) => NOT_FOUND_CAUSES[c].phrase).join(" and ")}, ${count(top.n, "")} each of ${top.basis}). The fix covers ${NOT_FOUND_CAUSES[c2FixCause(rec)].phrase} only: ${lead.summary}`
          : `; the commonest cause is ${NOT_FOUND_CAUSES[top.causes[0] ?? "GUESSED_PATH"].phrase} (${count(top.n, "")} of ${top.basis}), so ${lead.summary} (that cause only)`;
    return prompted(
      "c2-add-glob-first-policy",
      `Find where ${count(lookups, "several")} missing-path lookups across ${count(sessions, "")} session${sessions === 1 ? "" : "s"} came from${scope}.`,
      [
        causes.length === 0
          ? "Fix the stale reference if there is one; add a Glob-first line only if Claude guessed."
          : `By cause: ${notFoundByCause(causes, lookups)}.`,
        ...(c2Probed(rec) === 0
          ? []
          : [
              `${count(c2Probed(rec), "")} of them searched a folder whose name says it is absent (\`${c2Folder(c2Probes(rec)[0])}\`): likely deliberate probes rather than Claude mistakes (judged from the folder name only)${c2ProbeBucket(rec)}.`,
            ]),
        "The count includes lookups made inside subagents; the dollar figure prices the main conversation only, so subagent lookups are counted but not priced.",
      ],
      c2Prompt(rec, sessionIds, measured),
    );
  },
  C3: (rec, sessionIds) => {
    const total = numberMetric(rec, "ERROR_COUNT");
    const subagents = numberMetric(rec, "SUBAGENT_ERROR_COUNT");
    const sessions = numberMetric(rec, "SESSION_COUNT");
    const writes = numberMetric(rec, "WRITE_ERROR_COUNT");
    const calls =
      total === null
        ? "edits and writes"
        : `${count(total, "")} edit or write call${total === 1 ? "" : "s"}`;
    // U9 r3: the card lists some of the sessions; say how many when that is fewer than the total.
    const listed = listedSessions(rec).length;
    const across =
      sessions === null
        ? ""
        : ` across ${count(sessions, "")} session${sessions === 1 ? "" : "s"}${listed > 0 && listed < sessions ? ` (${listed} listed)` : ""}`;
    // The thread split per tool, from the stored counts (U9: "10 of them Write" was all threads).
    const subWrites = numberMetric(rec, "SUBAGENT_WRITE_ERROR_COUNT");
    const thread = (n: number, w: number) => `${n - w} Edit, ${w} Write`;
    const split =
      total === null || subagents === null
        ? null
        : subWrites !== null && writes !== null
          ? `${count(subagents, "")} in subagents (${thread(subagents, subWrites)}); ${count(total - subagents, "")} in the main thread (${thread(total - subagents, writes - subWrites)})`
          : `${count(subagents, "")} in subagents; ${count(total - subagents, "")} in the main thread${writes === null ? "" : `; ${count(writes, "")} of all ${count(total, "")} were Write calls`}`;
    const files = (rec.tool_calls ?? []).slice(0, 4).map((call) => {
      const sub = call.subagent_calls ?? 0;
      return `${call.tool} \`${call.target}\` ${times(call.calls)}${sub > 0 ? ` (${count(sub, "")} in subagents)` : ""}`;
    });
    const overwrites = (rec.tool_calls ?? []).some((call) => call.tool === "Write");
    return {
      primary: withId(
        {
          kind: "EDIT",
          summary: `${calls} ${total === 1 ? "was" : "were"} rejected because the file had not been read first${across}${split === null ? "" : `: ${split}`}. Add the rule below to CLAUDE.md so dispatch prompts name the files to read.`,
          detail: [
            ...(files.length === 0 ? [] : [`Files hit most: ${files.join("; ")}.`]),
            "A subagent starts with no reads of its own, so a dispatch that says only 'edit X' fails on X. If your dispatch template already says to read first, the dispatches in the sessions listed did not carry it.",
            // U9 r8: the headline prices the main thread; the rule covers both threads, so say both.
            subagents !== null && total !== null && subagents < total
              ? `The rule covers both threads: the main thread reads a file first, and every dispatch names its files. The dollar figure prices the ${count(total - subagents, "")} main-thread failure${total - subagents === 1 ? "" : "s"} only (the main turn after each); the ${count(subagents, "")} in subagents are counted, not priced.`
              : "If your dispatches come from a template or skill preamble, put the same sentence there as well as in CLAUDE.md.",
            ...(overwrites
              ? [
                  "A Write to a file that already exists fails the same way: use a new file name each time, or Read the file first.",
                ]
              : []),
          ],
          // U9 r7: the paste is the rule only. CLAUDE.md loads on every turn, so the evidence (counts,
          // files, sessions) stays on the card above, in the summary and detail lines.
          copy_text: [
            "## Read before Edit or Write",
            "",
            'Edit and Write fail on a file that has not been read in the same conversation: Read a file before you Edit or Write it. A subagent starts with no reads, so every dispatch prompt that tells it to change a file must name the exact paths and say: "Read each file before you Edit or Write it." To replace a file\'s whole content, Read it first or write to a new file name.',
          ].join("\n"),
          file_ref: "CLAUDE.md",
        },
        "c3-add-read-before-edit-policy",
      ),
      // U9 r8: this card's files and sessions go in a prompt, so the CLAUDE.md rule stays minimal.
      alternatives: [
        withId(
          {
            kind: "INVESTIGATE",
            summary: `Have Claude check why these ${calls} skipped the Read, file by file, before you rely on the rule.`,
            detail: [
              "The prompt lists every file, how many failures ran in subagents, and the sessions.",
            ],
            copy_text: c3Prompt(rec, sessionIds, calls, across, split),
            file_ref: null,
          },
          "c3-check-skipped-reads",
        ),
      ],
    };
  },
  C4: (rec, sessionIds) => {
    const failed = count(numberMetric(rec, "FAILED_EDIT_COUNT"), "repeated");
    const fileCount = numberMetric(rec, "AFFECTED_FILE_COUNT");
    const onFiles =
      fileCount === null
        ? "on one file or more"
        : `across ${count(fileCount, "")} file${fileCount === 1 ? "" : "s"}`;
    const errorText = cleanError(stringMetric(rec, "TOP_FAILURE_ERROR_TEXT"));
    const cause = c4Cause(errorText);
    // The files the newest failed edits hit (the finding keeps five anchors).
    const hit = (rec.tool_calls ?? []).map(
      (call) => `\`${call.target}\` ${times(call.calls)} among the five newest failures`,
    );
    const actions = investigate(
      "c4-recover-failed-edits",
      `Open session ${sessionName(sessionIds)}: investigate ${failed} failed edits ${onFiles}, in runs of 3 or more in a row${cause === null ? "" : ` (commonest: ${cause.name})`}, before another retry.`,
      [
        ...(errorText === null ? [] : [`Error: ${errorText}`]),
        ...(hit.length === 0 ? [] : [`Files: ${hit.join("; ")}`]),
        cause?.fix ??
          "Re-read the target, identify the stale or failed hunk, then apply one smaller verified edit.",
      ],
    );
    if (cause !== null) {
      actions.primary.copy_text = [
        "# Failed Edit Recovery: stop retrying a failing Edit",
        "",
        `AgentWrangler (a local Claude Code spend monitor) found ${failed} failed Edit calls ${onFiles}, in runs of 3 or more in a row. The commonest error: ${cause.name}.`,
        "",
        "## Findings",
        `- Session: ${sessionName(sessionIds)}`,
        `- Failed edits: ${failed} ${onFiles}`,
        `- Error (first line): ${errorText}`,
        ...hit.map((line) => `- File: ${line}`),
        "",
        "## Steps",
        "1. Open the transcript and find the failed Edit calls on the same file.",
        `2. ${cause.fix}`,
        "3. Propose the smallest change that would have avoided the failure, and ask me to confirm before changing any file.",
        "",
        "Do not repeat an unchanged failed Edit.",
      ].join("\n");
    }
    return actions;
  },
  C5: (rec, sessionIds, window) => {
    const repeated = count(numberMetric(rec, "REPEATED_ERROR_COUNT"), "repeated");
    const tool = stringMetric(rec, "TOP_LOOP_TOOL") || null;
    const errorText = cleanError(stringMetric(rec, "TOP_LOOP_ERROR_TEXT"));
    const targets = (rec.tool_calls ?? []).map(
      (call) =>
        `${call.tool} \`${call.target}\` ${times(call.calls)} among the loop's newest errors`,
    );
    const session = sessionName(sessionIds);
    const toolLabel = tool ?? "tool";
    const actions = investigate(
      "c5-break-same-error-loop",
      `Open session ${session}: investigate ${repeated} repeated ${toolLabel} errors before retrying.`,
      [
        ...(errorText === null ? [] : [`Error: ${errorText.split("\n")[0]}`]),
        "Stop the unchanged attempt and re-establish ground truth before choosing a new approach.",
      ],
    );
    actions.primary.copy_text = [
      "# Loop Recovery: break a repeated tool-error loop",
      "",
      `AgentWrangler (a local Claude Code spend monitor) found a Claude Code session that hit the same ${toolLabel} error ${repeated} times instead of fixing the cause. Investigate it and propose a fix.`,
      "",
      "## Context",
      "- Claude Code saves each session as a JSONL transcript at ~/.claude/projects/<workspace folder>/<session id>.jsonl. Search that folder for the session id below.",
      ...(window ? [`- Observed ${window.from.slice(0, 10)} to ${window.to.slice(0, 10)}.`] : []),
      "",
      "## Findings",
      `- Session: ${session}`,
      ...(tool === null ? [] : [`- Tool: ${tool}`]),
      `- Repeated errors: ${repeated}`,
      ...targets.map((line) => `- Call: ${line}`),
      ...(errorText === null
        ? []
        : ["- Error (first occurrence):", ...errorText.split("\n").map((line) => `> ${line}`)]),
      "",
      "## Steps",
      `1. Open the transcript and find the repeated ${toolLabel} calls that returned this error.`,
      "2. For each retry, note what changed from the previous attempt; say so if nothing changed.",
      c5CauseStep(errorText),
      "4. Propose (a) the fix for this error and (b) one short CLAUDE.md rule that would have stopped the loop after the second identical error. Show the exact text.",
      "5. Ask me to confirm before changing any file. Then apply it and verify the failing command now succeeds, or explain why it cannot be run here.",
      "",
      "Do not repeat an unchanged failed call.",
    ].join("\n");
    return actions;
  },
  C6: (rec, sessionIds) => {
    const flips = count(numberMetric(rec, "FLIP_FLOP_COUNT"), "repeated");
    return investigate(
      "c6-resolve-edit-flip-flop",
      `Open session ${sessionName(sessionIds)}: resolve ${flips} edit flip-flops before changing the file again.`,
      ["Use the original task intent to choose one correct version, then apply only that version."],
    );
  },
  C7: (rec, sessionIds) => {
    const commands = commandFamily(stringMetric(rec, "BASH_COMMAND_FAMILY"));
    const failures = count(numberMetric(rec, "BASH_FAILURE_COUNT"), "repeated");
    const cause = c7Cause(rec);
    const measured = `${failures} ${commands}${cause}`;
    return prompted(
      "c7-add-environment-requirement",
      `Find the shared cause behind ${measured} that failed, and fix it once.`,
      [
        "Never change permissions as an environment fix; export secrets in the shell, not settings.",
      ],
      c7Prompt(rec, sessionIds, measured),
    );
  },
  D7: (rec, sessionIds) => {
    const total = sessionTotal(rec);
    // D7_CROSS_SESSION_REREAD (H8 / lib F4) emits redundant_path_count instead of retry facts.
    const redundantPaths = numberMetric(rec, "redundant_path_count");
    if (redundantPaths !== null) {
      const reads = numberMetric(rec, "total_redundant_read_count");
      const bytes = numberMetric(rec, "total_redundant_result_bytes");
      // Look-up files lead; source code is re-read because it changes (review 3 B1).
      const all = rec.tool_calls ?? [];
      const files = [...all.filter(isLookupFile), ...all.filter((call) => !isLookupFile(call))];
      const top = all.find(isLookupFile);
      const topSessions = top?.session_count ?? numberMetric(rec, "max_path_session_count");
      const spread =
        topSessions === null
          ? "the share of sessions is not recorded"
          : `the most-read file: ${count(topSessions, "")}${total > topSessions ? ` of ${count(total, "")}` : ""} sessions`;
      const measured = [
        `- Files read again in later sessions: ${count(redundantPaths, "")}`,
        ...(reads === null
          ? []
          : [
              `- Reads, counting one per session: ${count(reads, "")}${bytes === null ? "" : ` (${byteAmount(bytes)} of results)`}`,
            ]),
        ...(top === undefined
          ? []
          : [
              `- Most-read look-up file: \`${top.target}\`, read in ${count(top.session_count, "")} sessions`,
            ]),
        ...(files.length === 0
          ? []
          : [
              "",
              // Review 5 residual M16: rows can be whole reads; only results over 25 KB are on A1.
              `Files read most, read back from the transcripts (whole or in parts, as each row says; results over 25 KB are on the "${A1_CARD_TITLE}" card):`,
              ...callLines(files),
            ]),
      ];
      return prompted(
        "d7-investigate-cross-session-reads",
        top === undefined
          ? `Find the look-up files that later sessions read again (${count(redundantPaths, "")} files re-read ${reads === null ? "repeatedly" : times(reads)}; ${spread}) and point Claude at the part it needs.`
          : top.whole_file === false
            ? `Name the section of \`${top.target}\` each task needs (a heading or line range) in the pointer that sends Claude to it (${count(top.calls, "")} reads in ${count(top.session_count, "")} sessions).`
            : `Point Claude at the part of \`${top.target}\` it needs, instead of the whole file (read in ${count(top.session_count, "")} sessions).`,
        ["Leave files that are re-read because they are being edited."],
        d7RereadPrompt(sessionIds, total, measured, spread),
      );
    }
    const turns = numberMetric(rec, "loop_flagged_turn_count");
    const kinds = loopKinds(rec);
    const example = rec.tool_calls?.[0];
    const repeats = numberMetric(rec, "loop_example_call_count");
    const measured = [
      ...(turns === null
        ? []
        : [`- Turns spent repeating calls: ${count(turns, "")}${loopTurnShare(rec)}`]),
      ...(kinds.length === 0 ? [] : [`- By kind (${LOOP_KINDS_OVERLAP}): ${kinds.join(", ")}`]),
      // U9 r7: when the example reads back as several targets, the call line states its own count,
      // so no second figure here can disagree with it.
      ...(example === undefined
        ? []
        : [
            `- Most repeated call${repeats === null || (rec.tool_calls?.length ?? 0) > 1 ? "" : ` (${times(repeats)} in one session)`}:`,
            ...callLines([example]),
          ]),
    ];
    // U9: three back-to-back Reads that hit the output cap get the one line that stops them.
    if (example?.tool === "Read" && /exceeds maximum allowed/i.test(example.result ?? "")) {
      // U9 r3: one owner. The ranges rule is on the C11 card; this card owns only the retry.
      // U9 r4: the detector counts back-to-back Reads that failed with the same error, not an
      // unchanged call (the Read's offset and limit may differ), and the pasted text names the
      // session and times itself.
      const failed = times(repeats ?? example.calls);
      const line =
        'When a Read fails with "File content (N tokens) exceeds maximum allowed tokens (25000)", do not retry it. Grep for the lines you need, then Read with offset and limit so the result stays under the 25,000-token cap.';
      const session = example.session_ids[0];
      const seen = [
        `${failed} in a row with the same error`,
        ...(session === undefined ? [] : [`session ${session}`]),
        ...(example.at === undefined || example.at.length === 0
          ? []
          : [`at ${example.at.join(", ")} (UTC)`]),
      ].join(", ");
      return prompted(
        "d7-read-in-ranges-after-cap-error",
        `Stop retrying the Read of \`${example.target}\` after the output-cap error (${failed} in a row with the same error); the ranges rule is on the card "${C11_READ_CARD_TITLE}".`,
        [
          `This is the Read output-cap error, repeated ${failed} in a row. The Read's own parameters may have changed between tries: the card counts the repeated error, not an identical call.`,
          "Add the line below to CLAUDE.md.",
        ],
        `## Large files\n\n${line}\n\nWhere this came from (AgentWrangler, not part of the rule): Read of \`${example.target}\`, ${seen}.`,
      );
    }
    // Review 5 M18: the two cases get separate advice; tool-result clearing is named only in Why.
    return prompted(
      "d7-investigate-retry-loop",
      "When the same error comes back twice, stop and change approach; when a file is read again with no edit between, check whether a compaction came between the two reads (the transcript marks it), then read only the part needed.",
      [
        "Same error twice: stop, read the error, and change the input or approach before retrying.",
        "File read again with no edit between: check the transcript for a compaction between the two reads, then read only the part needed.",
      ],
      d7LoopPrompt(
        sessionIds,
        total,
        measured,
        example === undefined
          ? undefined
          : {
              ...example,
              calls:
                (rec.tool_calls?.length ?? 0) === 1 ? (repeats ?? example.calls) : example.calls,
            },
      ),
    );
  },
  D11: d11Actions,
};

/** The metric each detector's contract watches (its descriptor or template `target_metric`). */
const TARGET_METRIC: Record<string, string> = {
  C1: "tool_error_rate",
  C2: "content_not_found_count",
  C3: "edit_before_read_count",
  C4: "failed_edit_recovery_loop_count",
  C5: "same_error_loop_count",
  C6: "edit_flip_flop_count",
  C7: "bash_failure_cluster_count",
  D11: "shell_error_rate",
};

function targetMetric(rec: Parameters<FamilyHandler>[0]): string | undefined {
  if (rec.detector_id !== "D7") return TARGET_METRIC[rec.detector_id];
  return numberMetric(rec, "redundant_path_count") !== null
    ? "cross_session_redundant_reads"
    : "loop_flagged_turn_share";
}

export const errorsHandler: FamilyHandler = (rec, ctx) => {
  const actions = errorsActions[rec.detector_id]?.(
    rec,
    ctx.trigger.session_ids,
    ctx.trigger.window,
  );
  const metric = targetMetric(rec);
  if (actions === undefined || metric === undefined) return null;
  return withTargetMetric(actions, metric);
};
