import { numberMetric, stringMetric, withTargetMetric } from "../accessor.js";
import { TRANSCRIPTS, callFindings, cardPrompt } from "../prompt.js";
import {
  CALLING_SIDE,
  DESTRUCTIVE_COMMANDS,
  GUARD_FIX,
  GUARD_FIX_NOTE,
  GUARD_SHAPES,
  type GuardVersion,
  callCount,
  guardMessages,
  guardVersions,
  openFalsePositives,
  operationName,
  sessionTotal,
  shapeCounts,
  times,
} from "../trigger.js";
import type { CardActionOption, CardActions, FamilyHandler, GuardShape } from "../types.js";

export const PERMISSIONS_DETECTOR_IDS = ["C9", "D14", "H1"] as const;

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

function countText(value: number | null, fallback: string): string {
  return value === null ? fallback : value.toLocaleString("en-US");
}

type Rec = Parameters<FamilyHandler>[0];

/** U9 r5: the guard-fix prompt shows this many blocked calls as examples, not all of them. */
const MAX_C9_EXAMPLES = 3;

/**
 * U9 r8: H1's hook rule as a JavaScript function (Node hook, plain JS regex; no POSIX classes). It
 * splits the command into segments on `;`, `&`, `|` and newline, and checks every target of each
 * `rm` that has a recursive flag (short, grouped or `--recursive`). It is run as-is, with the real
 * engine, over a table in test/query/rec-actions-u9-r8-tool.test.ts: keep the two in step.
 * `\x60` is a backtick (written escaped so the snippet can sit in a template literal).
 */
export const H1_HOOK_FN = String.raw`function rmRfRisky(command) {
  const risky = (target) => {
    const t = target.replace(/^["']+|["']+$/g, "");
    if (/^\/(var\/)?tmp\/(?!\*$)[^$\x60]+$/.test(t) && !/(^|\/)\.\.(\/|$)/.test(t)) return false;
    return (
      t === "." ||
      /^[~$\x60%*\/\\]/.test(t) ||
      /^[A-Za-z]:/.test(t) ||
      /^\.[\/\\]\*$/.test(t) ||
      /[$\x60]/.test(t) ||
      /(^|[\/\\])\.\.([\/\\]|$)/.test(t)
    );
  };
  return command.split(/[;&|\n]+/).some((segment) => {
    const words = segment.replace(/^[\s({]+/, "").split(/\s+/).filter(Boolean);
    while (words.length > 0 && (/^\w+=/.test(words[0]) || words[0] === "sudo")) words.shift();
    if (words[0] !== "rm") return false;
    let recursive = false;
    let optionsEnded = false;
    const targets = [];
    for (const word of words.slice(1)) {
      if (!optionsEnded && word === "--") optionsEnded = true;
      else if (!optionsEnded && word.startsWith("--")) recursive = recursive || word === "--recursive";
      else if (!optionsEnded && word.startsWith("-")) recursive = recursive || /[rR]/.test(word);
      else targets.push(word);
    }
    return recursive && targets.some(risky);
  });
}`;

const RE_PLAN = "Each one costs a turn while Claude re-plans the call.";

/**
 * The findings every blocked-call prompt starts with: how many, where, and the calls read back.
 * The tools are named only for the calls read back, not for every call counted.
 */
function blockedFindings(
  rec: Parameters<FamilyHandler>[0],
  sessionIds: string[],
  label: string,
  searchHint: string,
): string[] {
  const count = numberMetric(rec, "DENIAL_COUNT");
  return callFindings(
    rec,
    sessionIds,
    [`- ${label}: ${count === null ? "several" : callCount(rec, count)}`],
    searchHint,
  );
}

/** A local server or port check: calls a start-and-wait script or skill would make instead. */
const PORT_POLL = /\b(?:127\.0\.0\.1|localhost)\b|-LocalPort\b|Get-NetTCPConnection|netstat\b/i;

/** The fix for one open false positive: a guard pattern change, or the calling-side shape. */
function c9ShapeFix(shape: GuardShape): string {
  const guardSide = GUARD_FIX[shape];
  return guardSide === undefined
    ? `use ${CALLING_SIDE[shape] ?? "a shape the guard allows"}`
    : `change the guard: ${guardSide}`;
}

/**
 * U9 r4: shapes that share one fix are named together, so the same pattern change is printed once
 * (the Bash and PowerShell `tmp` shapes have the same one).
 */
function c9FixGroups(
  open: Array<[GuardShape, number]>,
): Array<{ names: string[]; n: number; fix: string }> {
  const groups = new Map<string, { names: string[]; n: number; fix: string }>();
  for (const [shape, n] of open) {
    const fix = c9ShapeFix(shape);
    const group = groups.get(fix) ?? { names: [], n: 0, fix };
    group.names.push(GUARD_SHAPES[shape]);
    group.n += n;
    groups.set(fix, group);
  }
  return [...groups.values()];
}

/**
 * U9 r8: how many of the harmless blocks each kind of fix clears, so "N harmless" is not read as
 * "all N come off with one guard edit".
 */
function c9SplitLine(open: Array<[GuardShape, number]>): string {
  const sum = (keep: (shape: GuardShape) => boolean) =>
    open.filter(([shape]) => keep(shape)).reduce((total, [, n]) => total + n, 0);
  const guardSide = sum((shape) => GUARD_FIX[shape] !== undefined);
  const callSide = sum((shape) => GUARD_FIX[shape] === undefined);
  const tmp = sum((shape) => shape === "SCRATCH_TMP" || shape === "PS_SCRATCH_TMP");
  const parts = [
    `${countText(guardSide, "")} of these need a change to the guard's patterns${
      tmp > 0
        ? `, ${countText(tmp, "")} of them blocks on the job scratch folder (\`jobs/<id>/tmp/\` or \`$CLAUDE_JOB_DIR/tmp/\`), the only \`tmp\` folder the fix lets through`
        : ""
    }`,
    callSide > 0
      ? `${countText(callSide, "")} are cleared by running the command another way, with the guard unchanged`
      : "none needs only a different command",
  ];
  return `${parts.join("; ")}.`;
}

/**
 * U9 r4: why the lists on a guard card add up. The blocks by guard message cover the calls read
 * back; the card's total counts every block. A finding keeps at most 20 session ids.
 */
function c9Reconcile(rec: Rec, versions: GuardVersion[]): string[] {
  const denials = numberMetric(rec, "DENIAL_COUNT");
  const placed = versions.reduce((sum, version) => sum + version.blocks, 0);
  const lines: string[] = [];
  if (denials !== null && denials > placed) {
    lines.push(
      `- ${countText(denials - placed, "")} of the ${countText(denials, "")} blocks were not read back from a transcript, so they are in no guard message above (${countText(placed, "")} are).`,
    );
  }
  const total = sessionTotal(rec);
  if (total > 20) {
    lines.push(
      `- The ${countText(total, "")} sessions are all counted; AgentWrangler keeps at most 20 session ids per finding, so the rest are counted but not named.`,
    );
  }
  return lines;
}

/**
 * U7: the guard card when some false positives are the guard's own pattern being too wide. The fix
 * artifact is the pattern change (a snippet to review and apply by hand, never applied here).
 */
function c9GuardFixPrompt(
  rec: Rec,
  sessionIds: string[],
  versions: GuardVersion[],
  open: Array<[GuardShape, number]>,
  widened: Array<[GuardShape, number]>,
) {
  // U9 r5: a few examples, not every call; the patterns and counts below carry the evidence.
  const harmless = (rec.tool_calls ?? []).filter((call) =>
    open.some(([shape]) => shape === call.guard_shape),
  );
  const examples = harmless.slice(0, MAX_C9_EXAMPLES);
  const omitted = harmless.length - examples.length;
  // The first words of the current guard's message, to search the user's hook files for.
  const needle = (
    (versions[0]?.message ?? "PreToolUse").split(/[:(]/)[0]?.trim() || "PreToolUse"
  ).replace(/"/g, "");
  return cardPrompt({
    title: "Narrow the PreToolUse guard patterns that block harmless calls",
    intro: `found harmless tool calls my own PreToolUse hook blocked because a guard pattern is wider than its rule. ${RE_PLAN} Propose the narrower pattern; I will apply it.`,
    context: [
      "A PreToolUse hook is a command listed under `hooks.PreToolUse` in `~/.claude/settings.json` or the project's `.claude/settings.json`. When it exits with code 2 (or prints a `deny` decision), Claude Code blocks the call and shows Claude the hook's message.",
      `AgentWrangler does not know which script the guard is, so check: read the commands under \`hooks.PreToolUse\` in those two files, and search the script files they name for the first words of a guard message below (for example \`grep -rn "${needle}" ~/.claude .claude\`). A guard may be one script per tool (Bash, PowerShell, TaskCreate) or one script for all.`,
      "AgentWrangler sorted each block by the shape of the blocked command. A block of a shape the guard exists to stop (a `cd … &&` prefix, an in-place edit, a heredoc written to a file or feeding a command, a bare `/tmp` path, a destructive git command) is correct and needs no change. The false positives below were calls the guard's rule was never meant to stop; its pattern matched them by accident. Every fix below must keep blocking everything the guard blocks today except those calls.",
      TRANSCRIPTS,
    ],
    findings: [
      ...blockedFindings(
        // U9 r6: the examples are fewer calls, so their sessions are fewer too; carry the whole
        // finding's session count so this line and the "all counted" line below agree.
        { ...rec, tool_calls: examples, facts: { ...rec.facts, session_count: sessionTotal(rec) } },
        sessionIds,
        "Blocked calls",
        "search the transcripts above for tool results that start with `PreToolUse:` and contain `hook error`.",
      ),
      ...(omitted > 0
        ? [
            `- Showing ${examples.length} of ${harmless.length} harmless blocked call groups read back; the rest are in the same shapes (counts below).`,
          ]
        : []),
      "",
      "Blocks by guard message, the current one first:",
      ...versions.map(
        (version) =>
          `- ${version.current ? "Current" : "Earlier"} ${version.tool} guard ("${version.message}"): ${countText(version.blocks, "")} blocks; ${shapeCounts(version.shapes, () => true)}`,
      ),
      ...c9Reconcile(rec, versions),
      "",
      "False positives the current guard still makes, and the fix:",
      ...c9FixGroups(open).map(
        (group) => `- ${group.names.join(" and ")}: ${countText(group.n, "")}; ${group.fix}`,
      ),
      ...(widened.some(([shape]) => shape === "SCRATCH_TMP" || shape === "PS_SCRATCH_TMP")
        ? ["", GUARD_FIX_NOTE]
        : []),
    ],
    fix: "Find each guard rule behind a message above in the hook script or inline command, and narrow its pattern as listed. The patterns are suggestions: check them against the guard's own regex dialect (POSIX classes, PowerShell `-match`, JavaScript) before applying.",
    steps: [
      "Read `hooks.PreToolUse` in `~/.claude/settings.json` and `.claude/settings.json`; open each guard script or inline command and find the rule behind each message above.",
      "For each false positive above, write the narrower pattern in that guard's own syntax, and one example call that should now pass.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the agreed edits to the guard.",
      `Verify: run the guard with each false-positive example as its JSON input (\`{"tool_name":"Bash","tool_input":{"command":"…"}}\`; \`PowerShell\` for the PowerShell guard): it must pass. Then run every one of these, which the guard blocks today, and confirm each is still blocked: \`node -e "1"\`, \`node -e"1"\`, \`node -e '1'\`, \`/tmp/x\`, \`/var/tmp/x\`, \`/c/tmp/x\`, \`cat <<EOF > f\`, \`git commit -F - <<'EOF'\`, \`bash -c "cat <<EOF > f"\`, \`cp a /home/me/proj/x/tmp/b\`, \`cp a /tmp/jobs/ab12/tmp/b\`. A pattern that lets one of them through is wider than the fix allows: narrow it again. Then confirm these pass: \`ls $CLAUDE_JOB_DIR/tmp/x\`, \`ls ~/.claude/jobs/ab12/tmp/x\`.`,
    ],
    notes: [
      "Never delete the guard or turn hooks off to make the blocks go away.",
      "AgentWrangler's later-session check counts calls in these shapes whether or not they are blocked, so it will not show a narrower pattern as an improvement. Judge this fix by these blocks no longer appearing.",
    ],
  });
}

/**
 * The guard card once its blocks are classified by shape and guard version (review 2 C9g2/C9g3):
 * it acts only on the false positives the current guard can still make.
 */
function c9FalsePositivePrompt(
  rec: Rec,
  sessionIds: string[],
  versions: GuardVersion[],
  open: Array<[GuardShape, number]>,
) {
  const widened = open.filter(([shape]) => GUARD_FIX[shape] !== undefined);
  if (widened.length > 0) return c9GuardFixPrompt(rec, sessionIds, versions, open, widened);
  return cardPrompt({
    title: "Run harmless blocked calls in a shape your PreToolUse guard allows",
    intro: `found harmless tool calls my own PreToolUse hook blocked. ${RE_PLAN} Keep the guard as it is; change how those calls are made.`,
    context: [
      "A PreToolUse hook is a command listed under `hooks.PreToolUse` in `~/.claude/settings.json` or the project's `.claude/settings.json`. When it exits with code 2 (or prints a `deny` decision), Claude Code blocks the call and shows Claude the hook's message.",
      "AgentWrangler sorted each block by the shape of the blocked command. A block of a shape the guard exists to stop (a `cd … &&` prefix, an in-place edit, a heredoc written to a file, a `/tmp` path, a destructive git command) is correct and needs no change. The false positives below were harmless calls in a shape the guard also stops. Loosening the guard for them is fragile (telling a read-only `python -c` from one that writes means parsing the script) and easy to get around, so the fix is on the calling side.",
      TRANSCRIPTS,
    ],
    findings: [
      // Only the false positives are read back here: they are what the prompt asks to fix.
      ...blockedFindings(
        {
          ...rec,
          tool_calls: (rec.tool_calls ?? []).filter((call) =>
            open.some(([shape]) => shape === call.guard_shape),
          ),
        },
        sessionIds,
        "Blocked calls",
        "search the transcripts above for tool results that start with `PreToolUse:` and contain `hook error`.",
      ),
      "",
      "Blocks by guard message, the current one first:",
      ...versions.map(
        (version) =>
          `- ${version.current ? "Current" : "Earlier"} ("${version.message}"): ${countText(version.blocks, "")} blocks; ${shapeCounts(version.shapes, () => true)}`,
      ),
      ...c9Reconcile(rec, versions),
      "",
      "False positives the current guard still makes, and the shape to use instead:",
      ...open.map(
        ([shape, n]) =>
          `- ${GUARD_SHAPES[shape]}: ${countText(n, "")}; use ${CALLING_SIDE[shape] ?? "a shape the guard allows"}`,
      ),
    ],
    fix: "Keep the guard as it is. For each false positive, make Claude use the allowed shape the first time. Check the CLAUDE.md files and the guard's message first: a rule may already name the allowed shape. Add one short CLAUDE.md line only where none does.",
    steps: [
      "Read the CLAUDE.md files that load in these sessions (the project's and `~/.claude/CLAUDE.md`) and the guard's message; note any rule that already names the allowed shape.",
      "For each false positive above, take one example call from the transcripts and write it in the allowed shape.",
      "Propose the smallest change per shape: nothing when a rule already names it, else one CLAUDE.md line.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the agreed edits. Do not change the guard.",
      `Verify: run the guard script (from \`hooks.PreToolUse\`) with each rewritten example as its JSON input (\`{"tool_name":"Bash","tool_input":{"command":"…"}}\`); it must pass. Re-read every file you changed.`,
    ],
    notes: [
      "Never delete the guard or turn hooks off to make the blocks go away.",
      "AgentWrangler counts calls in these harmless shapes in later sessions, blocked or not, so loosening the guard does not count as a fix. Fewer is the goal.",
    ],
  });
}

function c9GuardPrompt(rec: Parameters<FamilyHandler>[0], sessionIds: string[]) {
  const messages = guardMessages(rec.tool_calls ?? []);
  return cardPrompt({
    title: "Stop the tool calls your PreToolUse guard keeps blocking",
    intro: `found tool calls blocked by your own PreToolUse hook. ${RE_PLAN} Find out why Claude keeps making them, then change the call shape. Never weaken or remove a guard rule.`,
    context: [
      "A PreToolUse hook is a command listed under `hooks.PreToolUse` in `~/.claude/settings.json` or the project's `.claude/settings.json`. When it exits with code 2 (or prints a `deny` decision), Claude Code blocks the call and shows Claude the hook's message.",
      "A block is correct when Claude used a shape the guard exists to stop: the fix is an instruction that makes Claude use the allowed shape the first time. A block is a false positive when the call was harmless: the fix is the same, running it in a shape the guard allows, so the guard stays strict.",
      TRANSCRIPTS,
    ],
    findings: [
      ...blockedFindings(
        rec,
        sessionIds,
        "Blocked calls",
        "search the transcripts above for tool results that start with `PreToolUse:` and contain `hook error`.",
      ),
      ...(messages.length === 0
        ? []
        : [
            "",
            "Guard messages (first line):",
            ...messages.map(([message, n]) => `- "${message}": ${times(n)}`),
          ]),
    ],
    fix: "For each guard message, decide whether the block was correct. If it was, check CLAUDE.md first: a rule may already name the allowed shape (a guard message that cites a rule, such as `CLAUDE.md rules 1-3`, points at it). If one does, add nothing; the guard is doing its job, and at most its message can quote the allowed shape so the retry is right first time. Add one short CLAUDE.md line only when no rule covers the shape. If the block was a false positive, have Claude run that call in a shape the guard allows (for example a script file in the scratchpad instead of `python -c`). Keep the guard as it is.",
    steps: [
      "For each session above, open its transcript and find the tool results that start with `PreToolUse:` and contain `hook error`. Read the full message and the tool call it answers.",
      "Group the blocks by guard message. For each group write: the message, how many blocks, one example call, and what Claude did next.",
      "Find the guard: read `hooks.PreToolUse` in `~/.claude/settings.json` and `.claude/settings.json`, open the script it runs, and find the rule behind each message.",
      "For each group, say whether the block was correct or a false positive, and propose the smallest fix: nothing when a CLAUDE.md rule already covers the shape, else one CLAUDE.md line naming the shape to use.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the agreed edits. Do not change the guard.",
      "Verify: for each group, run the guard script with the example call as its JSON input: it must still be blocked, and the same call in the allowed shape must pass. Re-read every file you changed.",
    ],
    notes: [
      "Never delete the guard or turn hooks off to make the blocks go away.",
      "AgentWrangler counts calls in the shapes this guard blocked in later sessions, blocked or not, so loosening the guard does not count as a fix. Fewer is the goal.",
    ],
  });
}

function c9RejectedPrompt(rec: Parameters<FamilyHandler>[0], sessionIds: string[]) {
  const polls = (rec.tool_calls ?? [])
    .filter((call) => PORT_POLL.test(call.target))
    .reduce((sum, call) => sum + call.calls, 0);
  const pollHint =
    polls >= 2
      ? [
          `- ${polls} of the calls read back poll a local server or port. A script or skill that starts the server and waits until it is ready (a dashboard or dev-server skill) would replace those calls.`,
        ]
      : [];
  return cardPrompt({
    title: "Find out why Claude keeps asking for things I reject",
    intro:
      "found tool calls I rejected at the permission prompt. Find what Claude keeps proposing and add an instruction so it stops.",
    context: [
      "When I answer No to a permission prompt, or dismiss a question, Claude Code tells Claude the tool use was rejected and waits for my next message.",
      TRANSCRIPTS,
    ],
    findings: [
      ...blockedFindings(
        rec,
        sessionIds,
        "Rejected calls",
        "search the transcripts above for tool results that say the tool use was rejected.",
      ),
      ...pollHint,
    ],
    fix: "Find what the rejected calls have in common and add one CLAUDE.md instruction that stops Claude proposing it, or point Claude at the script or skill that already does the job. A one-off rejection needs no fix.",
    steps: [
      "For each session above, open its transcript and find the tool results that say the tool use was rejected. Read the call and my next message.",
      "Write a table: session, tool, what Claude proposed, what I said next.",
      "Group the rejections by reason: wrong direction, asked too early, a question I did not need, a command I would rather run myself, a job an existing script or skill already does, or other.",
      "Propose the smallest fix per group: one CLAUDE.md line, a pointer to the existing script or skill, or nothing for a one-off.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the agreed edits.",
      "Verify: re-read every file you changed and quote the lines you added.",
    ],
    notes: [
      "AgentWrangler counts rejections per session in later sessions and compares them with before. Approving more prompts also lowers the count. Fewer is the goal.",
    ],
  });
}

function c9DenyRulePrompt(rec: Parameters<FamilyHandler>[0], sessionIds: string[]) {
  return cardPrompt({
    title: "Stop the tool calls a permission deny rule keeps blocking",
    intro: `found tool calls blocked by a permission deny rule. ${RE_PLAN} Find out why Claude keeps making them, then fix the instruction or the rule.`,
    context: [
      "Deny rules live under `permissions.deny` in `~/.claude/settings.json` and the project's `.claude/settings.json`. A matching call is refused outright and Claude re-plans.",
      TRANSCRIPTS,
    ],
    findings: blockedFindings(
      rec,
      sessionIds,
      "Denied calls",
      "search the transcripts above for tool results where Claude Code refused a call because of a permission rule.",
    ),
    fix: "For each denied call, decide whether the rule was right. If it was, add one CLAUDE.md instruction so Claude avoids the command. If the rule is broader than it needs to be, narrow it to a scoped pattern such as `Bash(<command>:*)`; never a bare `Bash` entry.",
    steps: [
      "For each session above, open its transcript and find the tool results where a call was refused by a permission rule. Read the call.",
      "Read `permissions.deny` in both settings files and match each denied call to its rule.",
      "Write a table: rule, how many denials, one example call, right or too broad.",
      "Propose the smallest fix per rule: one CLAUDE.md line, or a narrower pattern.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the agreed edits.",
      "Verify: re-read every file you changed; for each changed rule, list the example calls it still blocks and the ones it now allows.",
    ],
    notes: [
      "AgentWrangler counts denials per session in later sessions and compares them with before. Narrowing a rule also lowers the count. Fewer is the goal.",
    ],
  });
}

function c9Actions(rec: Parameters<FamilyHandler>[0], sessionIds: string[]): CardActions {
  const count = numberMetric(rec, "DENIAL_COUNT");
  const calls = count === null ? "repeated calls" : callCount(rec, count);
  const denialClass = stringMetric(rec, "DENIAL_CLASS");
  if (denialClass === "HOOK_BLOCK") {
    const versions = guardVersions(rec.tool_calls ?? []);
    const open = openFalsePositives(versions);
    if (open.length > 0) {
      const wrong = open.reduce((sum, [, n]) => sum + n, 0);
      // U7: a pattern that is wider than its rule gets the narrower pattern as the fix artifact.
      if (open.some(([shape]) => GUARD_FIX[shape] !== undefined)) {
        return {
          primary: option(
            "c9-review-blocking-guard",
            // A Claude prompt that proposes the narrower pattern: it names the hook, so as an EDIT
            // the guardrails rejected it and the card had no action at all (U9).
            "INVESTIGATE",
            // U9 r7: the summary names the groups; each group's fix is its own detail line (the
            // old one-sentence mash repeated "change the guard:" and cut off mid-clause).
            `Stop ${countText(wrong, "")} harmless ${wrong === 1 ? "call" : "calls"} being blocked: ${c9FixGroups(
              open,
            )
              .map((group) => `${group.names.join(" and ")} (${countText(group.n, "")})`)
              .join(
                "; ",
              )}. Each fix keeps blocking every shape the guard blocks today; the details give the pattern.`,
            [
              c9SplitLine(open),
              ...c9FixGroups(open).map((group) => `${group.names.join(" and ")}: ${group.fix}.`),
              "The other blocks were shapes the guard exists to stop: it is working there. A heredoc that feeds a command (such as `git commit -F - <<'EOF'`) is one of them, because your rule forbids heredocs.",
              "The patterns were tested here against the shapes listed, not against your guard script; open the script, keep what it already handles, and check them against its regex dialect before applying.",
            ],
            c9FalsePositivePrompt(rec, sessionIds, versions, open),
            null,
          ),
          alternatives: [],
        };
      }
      // Review 3 B4 (operator 2026-09-26): the call changes shape; the guard stays strict.
      return {
        primary: option(
          "c9-review-blocking-guard",
          "INVESTIGATE",
          `Run the ${countText(wrong, "")} harmless blocked ${wrong === 1 ? "call" : "calls"} in a shape your guard allows, and keep the guard as it is: ${open.map(([shape]) => CALLING_SIDE[shape] ?? GUARD_SHAPES[shape]).join("; ")}.`,
          [
            "The other blocks were shapes the guard exists to stop: it is working there.",
            "Loosening the guard for these is fragile and easy to get around; change the calls instead.",
          ],
          c9FalsePositivePrompt(rec, sessionIds, versions, open),
          null,
        ),
        alternatives: [],
      };
    }
    // A local PreToolUse guard caused these denials; an ask rule cannot change that.
    return {
      primary: option(
        "c9-review-blocking-guard",
        "INVESTIGATE",
        `Find why Claude keeps making calls your PreToolUse guard blocks (${calls}), then change the call shape; never weaken or remove a guard rule.`,
        [
          "A permission rule would not change these blocks; your own guard made them.",
          "Keep the guard; where a block was harmless, change the call's shape instead.",
        ],
        c9GuardPrompt(rec, sessionIds),
        null,
      ),
      alternatives: [],
    };
  }
  const rejected = denialClass === "USER_REJECTED";
  return {
    primary: option(
      "c9-review-denials-scoped-rule",
      "INVESTIGATE",
      rejected
        ? `Find what Claude keeps proposing that you reject (${calls}), and add an instruction so it stops.`
        : `Find why Claude keeps making calls a deny rule blocks (${calls}), then fix the instruction or the rule.`,
      rejected
        ? ["A one-off rejection needs no fix."]
        : ["Scope any rule you narrow to one command, such as `Bash(<command>:*)`."],
      rejected ? c9RejectedPrompt(rec, sessionIds) : c9DenyRulePrompt(rec, sessionIds),
      null,
    ),
    alternatives: [],
  };
}

const SCOPE_RULE =
  "Touch only files the task requires. Before editing a path the task does not name, ask me to confirm it is in scope.";

function d14Prompt(rec: Rec, sessionIds: string[], stops: string, interrupted: boolean): string {
  return cardPrompt({
    title: interrupted
      ? "Find why I keep interrupting Claude"
      : "Find why Claude's tool calls keep getting stopped mid-run",
    intro: `found ${interrupted ? "interrupts" : "tool calls stopped while running (cancelled, or the session ended)"} that I did not follow with a correction. Each stop throws away the work in progress. Find what Claude was doing when I stopped it and add the guard rail that would have caught it earlier.`,
    context: [
      interrupted
        ? "An interrupt (Esc) shows in the transcript as a user line saying the request was interrupted by the user."
        : "A stopped tool call shows in the transcript as a tool result saying the call was interrupted or cancelled. If the session ended mid-call, check whether I closed it on purpose.",
      "Two habits catch a wrong direction early: plan mode, where Claude shows a plan before it edits, and a scope rule in CLAUDE.md that keeps Claude inside the files the task names.",
      TRANSCRIPTS,
    ],
    findings: callFindings(
      rec,
      sessionIds,
      [`- ${interrupted ? "Interrupts" : "Cancelled tool calls"}: ${stops}`],
      `search the transcripts above for ${interrupted ? "user lines that say the request was interrupted" : "tool results that say the call was interrupted or cancelled"}.`,
    ),
    fix: interrupted
      ? `If Claude was starting edits I had not agreed to, make plan mode the default by merging this into \`.claude/settings.json\`, keeping every other setting:\n\n\`\`\`json\n{\n  "permissions": {\n    "defaultMode": "plan"\n  }\n}\n\`\`\`\n\nIf it was editing files outside the task, add this line to CLAUDE.md instead: ${SCOPE_RULE}`
      : `If Claude was running or editing something outside the task, add this line to CLAUDE.md: ${SCOPE_RULE} If the call was simply slow, or I closed the session on purpose, no fix is needed.`,
    steps: [
      "For each session above, open its transcript and find each stop. Read the turns before it: what Claude was doing, and which files or commands it was touching.",
      "Say for each stop why I most likely stopped it: wrong direction, wrong files, too slow, or I changed my mind.",
      "Propose the smallest fix that would have caught the common case, from the Fix section. Name no fix if the stops were one-offs.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the edit.",
      "Verify: re-read the file you changed, check `.claude/settings.json` is still valid JSON if you edited it, and quote what you added.",
    ],
    notes: ["AgentWrangler counts stops without a follow-up in later sessions."],
  });
}

function d14Actions(rec: Rec, sessionIds: string[]): CardActions {
  const interrupted = stringMetric(rec, "INTERRUPT_KIND") === "PURE_INTERRUPT";
  const count = numberMetric(rec, "INTERRUPT_COUNT");
  const stops = countText(count, "repeated");
  const plural = count === 1 ? "" : "s";
  return {
    primary: option(
      interrupted ? "d14-plan-before-edits" : "d14-limit-task-scope",
      "INVESTIGATE",
      interrupted
        ? `Find what Claude was doing when you interrupted it (${stops} time${plural}), then add plan mode or a scope rule so it asks first.`
        : `Find what Claude was running when it was stopped (${stops} call${plural}), then add a scope rule if it had left the task.`,
      ["No fix is needed when a stop was a one-off change of mind."],
      d14Prompt(rec, sessionIds, stops, interrupted),
      null,
    ),
    alternatives: [],
  };
}

/** An rm -rf card in a workspace that already has a PreToolUse guard: the rule goes into the guard. */
export function h1GuardFirst(rec: Rec): boolean {
  return (
    rec.detector_id === "H1" &&
    rec.guard_exists === true &&
    stringMetric(rec, "DESTRUCTIVE_OPERATION") === "RM_RF"
  );
}

function h1GuardOption(rec: Rec, sessionIds: string[], runs: string): CardActionOption {
  const count = numberMetric(rec, "OPERATION_COUNT");
  return option(
    "h1-add-to-guard",
    "INVESTIGATE",
    `Add a rule to your PreToolUse guard that blocks \`rm -rf\` on a risky path (ran ${runs}).`,
    [
      "AgentWrangler saw your PreToolUse hook block calls in this workspace, so the rule belongs in that hook.",
      "A relative path inside the project, such as a build folder, or a /tmp folder still runs.",
    ],
    cardPrompt({
      title: "Block risky `rm -rf` paths in my PreToolUse hook",
      intro:
        "found Claude running `rm -rf` in my sessions. It cannot be undone: a wrong path or variable loses work for good. AgentWrangler also saw my PreToolUse hook block other calls in this project, so add one rule to that hook rather than a separate permission rule.",
      context: [
        "The hook is the script behind `hooks.PreToolUse` in `~/.claude/settings.json` or `.claude/settings.json`. It receives each tool call as JSON on stdin, and exiting with code 2 blocks the call and shows Claude the message it wrote to stderr.",
        "In plain words, safe is a relative path inside the project, a session scratchpad or a Temp folder; risky is a path from a variable, another absolute path, the home folder (`~`, `$HOME`), a parent path (`..`), the current folder (`.`) or a glob (`*`). Match `rm` as its own command, not inside a quoted string or a grep pattern.",
        "A text rule cannot see where a variable points or what the working directory is, so the snippet below treats every variable and absolute path as risky, except a target under `/tmp/` or `/var/tmp/`: the run above is blocked too, and a scratch cleanup costs one approval.",
        TRANSCRIPTS,
      ],
      findings: callFindings(
        rec,
        sessionIds,
        [`- Runs: ${count === null ? "several" : countText(count, "")}`],
        "search the transcripts above for commands that contain `rm -rf`.",
      ),
      fix: `Add this JavaScript function to the hook (a Node script, such as a \`.mjs\` file; it is plain JS, not a POSIX or \`grep -E\` pattern), and in the Bash branch exit with code 2 and a message on stderr when \`rmRfRisky(tool_input.command)\` is true:\n\n\`\`\`js\n${H1_HOOK_FN}\n\`\`\`\n\nHow it decides: it splits the command on \`;\`, \`&\`, \`|\` and newlines and checks each part on its own, so a harmless \`/tmp\` delete does not excuse a risky one after it. In a part that starts with \`rm\` (a leading \`sudo\` or \`VAR=…\` is skipped) and has a recursive flag (\`-r\`, \`-R\`, \`-rf\`, \`-fr\`, \`-r -f\`, \`--recursive\`), every target is checked, not just the first. A target is risky if it is a variable, \`~\`, a glob, \`.\`, \`..\`, an absolute or drive path (including \`C:\\…\`), or contains a backtick; only a target under \`/tmp/\` or \`/var/tmp/\` is allowed. The message should name the allowed alternative: delete a relative path inside the project, or ask me first.\n\nNot covered: \`bash -c "rm -rf …"\`, \`xargs rm -rf\`, \`eval\`, and PowerShell (\`Remove-Item -Recurse\`). A glob such as \`rm -rf *.log\` is blocked too (conservative). It was run as written, with Node, against the table in Verify below; it was not run against your hook. Keep every other rule in the hook.`,
      steps: [
        "Find the hook: read `hooks.PreToolUse` in `~/.claude/settings.json` and `.claude/settings.json`, and open the script it runs. If none exists, say so and stop: do not create one here.",
        "For each run above, read the full command and say whether its target was safe or risky, and whether it was scratch space I meant to clear.",
        "Propose the rule from the Fix section, written in the hook's own style.",
        "Ask me to confirm the plan before changing any file.",
        "After I confirm, make the edit.",
        `Verify: run the hook with each command below as its JSON input. Blocked: \`rm -rf "$DIR"\`, \`rm -fr ~/x\`, \`rm -rf ../x\`, \`rm -rf *\`, \`rm -r -f /home/me/x\`, \`rm -f -r $HOME/x\`, \`rm -rf .\`, \`rm -rf ./*\`, \`rm -rf /tmp/a; rm -rf ~/y\`, \`rm -rf /tmp/a && rm -rf /home/me\`, \`rm --recursive --force /x\`, \`rm -rf dist /x\`, \`rm -rf dist ~/x\`, \`sudo rm -rf /x\`, \`rm -rf /tmp\`, and the run in Findings if its target is a variable or absolute path. Allowed: \`rm -rf dist\`, \`rm -rf ./dist\`, \`rm -rf .next .cache\`, \`rm -rf /tmp/build\`, \`rm -rf /tmp/a; rm -rf dist\`, \`rm -r build\`, \`git rm -rf src/old\`, \`grep "rm -rf" notes.md\`. Re-read the file you changed.`,
      ],
      notes: [
        "Never delete the guard or turn hooks off.",
        "AgentWrangler counts these runs in later sessions; none is the goal.",
      ],
    }),
    null,
  );
}

function h1Actions(rec: Rec, sessionIds: string[]): CardActions {
  const operationClass = stringMetric(rec, "DESTRUCTIVE_OPERATION");
  const operation = operationName(operationClass);
  const count = numberMetric(rec, "OPERATION_COUNT");
  const runs = count === null ? "more than once" : times(count);
  const command = DESTRUCTIVE_COMMANDS[operationClass ?? ""];
  // Claude Code checks each part of a chained command on its own, but a rule matches the flags as
  // written, so reordered flags need their own rule.
  const variants =
    operationClass === "RM_RF"
      ? " Claude Code checks each part of a chained command (`a && b`) against the rules on its own, so a chain is covered. A rule matches the flags as written, though: `Bash(rm -rf:*)` does not match `rm -fr` or `rm -r -f`. To be asked before every rm, use `Bash(rm *)` instead."
      : "";
  const fix =
    command === undefined
      ? `Add this line to CLAUDE.md: Stop and ask me to confirm before running any ${operation} statement, and name the table or database it touches.`
      : `Merge this ask entry into the project's \`.claude/settings.json\`, keeping every other rule:\n\n\`\`\`json\n{\n  "permissions": {\n    "ask": ["Bash(${command}:*)"]\n  }\n}\n\`\`\`\n\nAsk, not deny: some runs may be needed cleanup, and you can approve those at the prompt.${variants}`;
  const ask = option(
    command === undefined
      ? "h1-confirm-destructive-database-operation"
      : "h1-ask-destructive-operation",
    command === undefined ? "EDIT" : "CONFIG",
    command === undefined
      ? `Make Claude ask before running \`${operation}\` statements (ran ${runs}).`
      : `Make Claude Code ask you before \`${command}\` runs (ran ${runs}).`,
    ["Merge with the existing rules; keep every other rule as it is."],
    cardPrompt({
      title: `Stop Claude running \`${operation}\` without asking`,
      intro: `found Claude running \`${operation}\` in my sessions. It cannot be undone: a wrong path, variable or branch loses work for good. Check each run, then put a rule in place so Claude has to ask first.`,
      context: [
        command === undefined
          ? "Database statements do not go through a Claude Code permission rule, so a CLAUDE.md instruction is the guard."
          : "Ask rules live under `permissions.ask` in `.claude/settings.json` (project) and `~/.claude/settings.json` (user). A matching Bash command stops at a permission prompt until I approve it. A rule matches the start of each part of a chained command.",
        TRANSCRIPTS,
      ],
      findings: callFindings(
        rec,
        sessionIds,
        [`- Runs: ${count === null ? "several" : countText(count, "")}`],
        `search the transcripts above for commands that contain \`${operation}\`.`,
      ),
      fix,
      steps: [
        "For each run above, open the session's transcript and read the full command and what Claude was trying to do.",
        "For each run, say whether the target was safe (a build or temp folder inside the project) or risky (a path from a variable, outside the project, or a whole checkout or branch).",
        "Read `permissions` in both settings files and note any existing ask or deny rule, or any allow rule that would let the command through.",
        "Propose the change from the Fix section, merged with the existing rules.",
        "Ask me to confirm the plan before changing any file.",
        "After I confirm, make the edits.",
        "Verify: re-read each file you changed, check the settings file is still valid JSON with every other rule unchanged, and quote what you added.",
      ],
      notes: ["AgentWrangler counts these runs in later sessions; none is the goal."],
    }),
    command === undefined ? "CLAUDE.md" : ".claude/settings.json",
  );
  // Card review F6: no ask-rule alternative beside the guard; `Bash(rm -rf:*)` would prompt on
  // every scratch cleanup.
  return h1GuardFirst(rec)
    ? { primary: h1GuardOption(rec, sessionIds, runs), alternatives: [] }
    : { primary: ask, alternatives: [] };
}

export const permissionsHandler: FamilyHandler = (rec, ctx) => {
  switch (rec.detector_id) {
    case "C9":
      return withTargetMetric(c9Actions(rec, ctx.trigger.session_ids), "denial_friction_count");
    case "D14":
      return withTargetMetric(d14Actions(rec, ctx.trigger.session_ids), "interrupt_cancel_count");
    case "H1":
      return withTargetMetric(
        h1Actions(rec, ctx.trigger.session_ids),
        "destructive_operation_count",
      );
    default:
      return null;
  }
};
