import os from "node:os";
import { D4_LOOKUP_TURN_SHARE } from "../../../../detector/savings.js";
import { numberMetric, withTargetMetric } from "../accessor.js";
import { TRANSCRIPTS, cardPrompt, existingUserRule, sessionsLine } from "../prompt.js";
import { byteAmount, sessionTotal } from "../trigger.js";
import type { CardActionOption, CardActions, FamilyHandler } from "../types.js";
import { existingReadRule } from "./context.js";

export const ROUTING_DETECTOR_IDS = ["D4", "D9", "D12", "G11", "C11", "E2"] as const;

function count(value: number | null, fallback: string): string {
  return value === null ? fallback : value.toLocaleString("en-US");
}

function percent(value: number | null, fallback: string): string {
  return value === null ? fallback : `${Math.round(value * 100)}%`;
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

type Rec = Parameters<FamilyHandler>[0];

/**
 * U9 r5: a model-routing rule the user already has in ~/.claude/CLAUDE.md (a line naming sonnet or
 * haiku for agents), so the card says the dispatches broke it instead of shipping the same line.
 */
export function existingModelRule(home = os.homedir()): { file: string; line: string } | null {
  return existingUserRule(
    (row) => /\b(sonnet|haiku)\b/i.test(row) && /\b(sub)?agents?\b|\bdispatch/i.test(row),
    home,
  );
}

function d4Prompt(
  sessionIds: string[],
  total: number,
  measured: string[],
  types: string[],
  agentIds: string[],
  moreAgents: boolean,
  rule: { file: string; line: string } | null = existingModelRule(),
): string {
  const workflow = types.includes("workflow-subagent");
  const builtin = types.includes("general-purpose");
  const lines = [
    "Start with the lookup subagents listed under Findings: open each one's first prompt and check it only reads or searches. An output of a few dozen tokens per turn is also what an agent that only makes tool calls looks like, so short output alone does not prove a lookup.",
    'For each one that is a lookup, pass `model: "sonnet"` (`"haiku"` for plain search) on its Agent call. By type:',
    "- Custom agent definition: put `model: sonnet` in its frontmatter (`model: haiku` for plain search).",
    ...(builtin
      ? [
          `- general-purpose: it has no definition file, so the model has to be set on each Agent call.${rule === null ? " Ready CLAUDE.md line (only if step 5 finds no rule saying the same): `When dispatching an Agent call that only reads or searches, pass model: sonnet (haiku for pure grep); keep Opus for agents that write code or verify.`" : ""}`,
        ]
      : []),
    ...(workflow
      ? [
          "- workflow-subagent: these ran from Workflow scripts, not from a definition file. Check whether each agent() call in the scripts behind them passes a model; if one leaves it unset, it may use the session's model (not verified here).",
        ]
      : []),
    ...(rule === null
      ? []
      : [
          `Your ${rule.file} already has a model rule: "${rule.line}". ${agentIds.length === 0 ? "These agents" : `These agents (${agentIds.slice(0, 3).join(", ")}${moreAgents ? " and the rest" : ""})`} still ran on Opus. The data does not show why: either those dispatches did not pass a model, or an agent() call in a Workflow script left it unset. Check each one; do not add a second rule.`,
        ]),
    "Leave agents that write code, verify or reason through hard problems on Opus: short output after a big read does not prove an agent is only looking things up.",
  ];
  return cardPrompt({
    title: "Pin lookup subagents to Sonnet or Haiku",
    intro:
      "found many Opus turns that read a large context but wrote little: lookup work a cheaper model does as well. Find the subagents doing that work on Opus and pin them to Sonnet or Haiku.",
    context: [
      "A subagent uses the session's model unless its agent definition has a `model:` line in its frontmatter, or the Agent call passes a `model`. Custom agent definitions live in `.claude/agents/*.md` (project) and `~/.claude/agents/*.md` (user).",
      "Switching the main session's model mid-task rebuilds its whole cache, so leave the main session alone. Subagents start fresh, so their model can change for free.",
      TRANSCRIPTS,
      "Each assistant line records its model in `message.model` and its output size in `message.usage.output_tokens`.",
    ],
    findings: [...measured, sessionsLine(sessionIds, total)],
    fix: lines.join("\n"),
    steps: [
      "For each session above, list the subagent transcripts in its `subagents` folder. For each, read `message.model` on the assistant lines and keep the ones on Opus.",
      "Match each Opus subagent to the Agent call in the parent transcript that started it, and note its `subagent_type`, its `description`, and its typical `output_tokens`.",
      "Write a table: subagent type, runs on Opus, typical output tokens, and whether its work is a lookup (search, read, summarize) or real work (writing code, design, hard reasoning).",
      "For each lookup type, open its definition (`.claude/agents/<type>.md`, then `~/.claude/agents/<type>.md`) and read its `model:` line; no line means it inherits Opus. Note built-in types that have no file.",
      "Read `~/.claude/CLAUDE.md` and the project CLAUDE.md for a rule that dispatches pass a model. If one exists, these agents ran on Opus despite it: find out why for each dispatch and do not add a second rule.",
      "Propose the edits: a `model:` line per lookup definition, and at most one CLAUDE.md line for built-in types.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the edits.",
      "Verify: re-read each changed definition and quote its `model:` line, and quote the CLAUDE.md line if you added one.",
    ],
    notes: [
      "Skip this if the Sonnet weekly limit, not Opus, is the one you run into.",
      "A cheaper subagent that then needs retries or follow-up turns is not a saving. AgentWrangler re-measures the Opus share in later weeks.",
    ],
  });
}

function d4Actions(rec: Rec, sessionIds: string[]): CardActions {
  const turns = numberMetric(rec, "mismatch_turns_per_week");
  const fraction = percent(numberMetric(rec, "mismatch_fraction"), "a large share");
  const lookup = numberMetric(rec, "lookup_subagent_count");
  const agents = numberMetric(rec, "opus_subagent_count");
  const output = numberMetric(rec, "avg_output_tokens");
  const rawTypes = rec.evidence?.top_agent_types ?? rec.facts?.top_agent_types;
  const types = Array.isArray(rawTypes)
    ? rawTypes.filter((type): type is string => typeof type === "string")
    : [];
  const rawAgents = rec.evidence?.top_agents ?? rec.facts?.top_agents;
  const agentRows = (Array.isArray(rawAgents) ? rawAgents : [])
    .filter((label): label is string => typeof label === "string")
    .map((label) => label.split("|"))
    .filter((parts) => parts.length === 5 || parts.length === 6);
  const measured = [
    `- Opus subagents that look like lookups (at least ${percent(D4_LOOKUP_TURN_SHARE, "")} of their turns read 50K+ tokens and wrote under 500): ${count(lookup, "not recorded")}${agents === null ? "" : ` of ${count(agents, "")}`}`,
    ...(types.length === 0
      ? []
      : [`- Most common subagent types among them, by turns: ${types.join(", ")}`]),
    ...(agentRows.length === 0
      ? []
      : [
          `- The ${count(agentRows.length, "")}${lookup !== null && lookup > agentRows.length ? ` costliest of the ${count(lookup, "")}` : ""} lookup subagents, costliest first at Opus prices (agent id, session, type, turns, average output tokens${agentRows.some((row) => row.length === 6) ? ", cost this week" : ""}):`,
          ...agentRows.map(
            ([agent, session, type, n, out, cost]) =>
              `  - ${agent} in ${session}: ${type}, ${count(Number(n), "")} turns, ${count(Number(out), "")} tokens${cost === undefined ? "" : `, $${(Number(cost) / 1e6).toFixed(2)}`}`,
          ),
        ]),
    `- Their turns a week: ${count(turns, "not recorded")} (${fraction} of Opus subagent turns)`,
    ...(output === null
      ? []
      : [`- Average output on those turns: ${count(Math.round(output), "")} tokens`]),
  ];
  const firstAgents = agentRows.slice(0, 3).map(([agent, , type]) => `${agent} (${type})`);
  return {
    primary: option(
      "d4-pin-lookup-subagents",
      "HABIT",
      `Pass model: sonnet on Agent calls that only read or search${firstAgents.length === 0 ? "" : `; check ${firstAgents.join(", ")} first`}: ${lookup === null ? "the" : count(lookup, "")} Opus subagents that looked like lookup work ran ${count(turns, "many")} turns a week (${fraction} of Opus subagent turns).`,
      [
        "Leave the main session on Opus: switching mid-task rebuilds its cache.",
        "Skip this when the Sonnet weekly cap is the binding constraint.",
      ],
      d4Prompt(
        sessionIds,
        sessionTotal(rec),
        measured,
        types,
        agentRows.map(([agent]) => agent ?? ""),
        lookup !== null && lookup > agentRows.length,
      ),
      null,
    ),
    alternatives: [],
  };
}

function d9Actions(rec: Parameters<FamilyHandler>[0]): CardActions {
  const forkCount = count(numberMetric(rec, "fork_count"), "the detected");
  const forks = `${forkCount} detected fork${forkCount === "1" ? "" : "s"}`;
  return {
    primary: option(
      "d9-deny-agent-fork",
      "CONFIG",
      `Deny Agent(fork) after ${forks}.`,
      [
        "Requires Claude Code v2.1.271+.",
        "Dispatch fresh subagents with only the relevant brief instead of inheriting the parent history.",
      ],
      '{\n  "permissions": {\n    "deny": ["Agent(fork)"]\n  }\n}',
      ".claude/settings.json",
    ),
    alternatives: [
      option(
        "d9-non-fork-agent",
        "CONFIG",
        `Use a non-fork custom agent for the ${forks}.`,
        [
          "Give self-contained work a focused agent definition and an explicit delegation brief.",
          "Set omitClaudeMd: true in the agent definition so it skips the parent CLAUDE.md; requires Claude Code v2.1.271+.",
        ],
        "Create a focused custom agent definition for self-contained work with omitClaudeMd: true in its frontmatter. Give it the needed task brief instead of spawning Agent(fork).",
        ".claude/agents/focused-worker.md",
      ),
      option(
        "d9-explicit-subagent-type",
        "HABIT",
        `Pass an explicit subagent_type for the ${forks}.`,
        ["Fork mode is used when the subagent type is omitted."],
        "When delegating, always pass an explicit subagent_type for self-contained work instead of relying on an omitted type.",
        null,
      ),
    ],
  };
}

function d12Prompt(sessionIds: string[], total: number, measured: string[]): string {
  return cardPrompt({
    title: "Make subagents return short summaries",
    intro:
      "found subagent results filling the main conversation. Each result stays in the main context and is re-sent on every later turn. Find the largest returns and ask those subagents for a short summary with file paths instead.",
    context: [
      "When an Agent call finishes, its whole final message comes back to the main conversation as the tool result. The brief (the Agent call's `prompt`) or the agent definition decides what that message holds.",
      TRANSCRIPTS,
    ],
    findings: [...measured, sessionsLine(sessionIds, total)],
    fix: "Add a return contract where the large returns come from: in the agent definition, or in one CLAUDE.md line for dispatch briefs. For example: return at most 15 lines with the findings, file paths and line numbers; never paste file contents unless asked.",
    steps: [
      'For each session above, open its transcript, find the Agent calls (`"name":"Agent"`) and their tool results, and measure each result\'s length.',
      "List the ten largest: session, `subagent_type`, `description`, result size, and what the result holds (a summary, file contents, a full log).",
      "For each large one, say what the main conversation actually used from it.",
      "Propose the return contract and where it goes: the agent definition (`.claude/agents/<type>.md` or `~/.claude/agents/<type>.md`), or one CLAUDE.md line for dispatch briefs.",
      "Ask me to confirm the plan before changing any file.",
      "After I confirm, make the edits.",
      "Verify: re-read each changed file and quote the return contract you added.",
    ],
    notes: [
      "A summary so short that the main session re-reads the files itself is not a saving.",
      "AgentWrangler re-measures subagent result size in later sessions.",
    ],
  });
}

function d12Actions(rec: Rec, sessionIds: string[]): CardActions {
  const bytes = numberMetric(rec, "sidechain_result_bytes");
  const agentSessions = numberMetric(rec, "sidechain_session_count");
  const turns = numberMetric(rec, "sidechain_turn_count");
  const size = bytes === null ? "large results" : byteAmount(bytes);
  const measured = [
    `- Subagent results returned to the main conversation: ${size}`,
    ...(agentSessions === null ? [] : [`- Sessions with subagents: ${count(agentSessions, "")}`]),
    ...(turns === null
      ? []
      : [`- Main-conversation turns that dispatched them: ${count(turns, "")}`]),
  ];
  return {
    primary: option(
      "d12-compact-return-agent",
      "INVESTIGATE",
      `Make the subagents with the largest returns reply with a short summary and file paths (${size} returned${agentSessions === null ? "" : ` in ${count(agentSessions, "")} sessions`}).`,
      ["Keep enough in the summary that the main session doesn't re-read the files."],
      d12Prompt(sessionIds, sessionTotal(rec), measured),
      null,
    ),
    alternatives: [],
  };
}

function g11Prompt(
  sessionIds: string[],
  total: number,
  measured: string[],
  tokens: string,
  baseline: string,
): string {
  return cardPrompt({
    title: "Find where a failed work item's tokens went",
    intro: `linked a work item (a PR) that ended as a failure to the sessions that worked on it. Those sessions used ${tokens} tokens, at or above the ${baseline}-token 90th percentile of this workspace's comparison set. Find what the spend bought before you try the same approach again.`,
    context: [
      "AgentWrangler linked these sessions to the work item; a linked session may also hold work that is not part of it.",
      "The token count adds input, output, cache reads and cache writes over the linked sessions' turns; cache reads make up most of it in long sessions.",
      TRANSCRIPTS,
    ],
    findings: [...measured, sessionsLine(sessionIds, total)],
    fix: "No config change is implied yet. The aim is to name the one or two things that drove the spend (for example repeated failing test runs, re-reading the same large files, or a long session that kept growing) and to change that habit or the plan before the next attempt.",
    steps: [
      "For each session above, open its transcript and list the turns with the largest token use: turn, tool called, and what it returned.",
      "Group them: repeated attempts at the same failing command, large file or log reads, subagent runs, or plain long conversation.",
      "Say which group the spend sits in, and whether the work it paid for ended up in the failed PR.",
      "Say what you would do differently on a retry: a smaller scope, a fresh session earlier, or fixing the failing check first.",
      "Ask me to confirm the plan before changing any file.",
    ],
    notes: [
      "This card shows spend next to a failed outcome. It does not show that the spend caused the failure.",
      "A work item can fail for reasons unrelated to cost, such as a changed requirement; if so, say that instead.",
    ],
  });
}

function g11Actions(rec: Parameters<FamilyHandler>[0], sessionIds: string[]): CardActions {
  const tokens = count(numberMetric(rec, "INPUT_CACHE_TOKENS"), "high");
  const baseline = count(
    numberMetric(rec, "WORKSPACE_P90_INPUT_CACHE_TOKENS"),
    "the workspace P90",
  );
  const compared = numberMetric(rec, "COMPARISON_WORK_ITEM_COUNT");
  const measured = [
    `- Tokens used by the failed work item's linked sessions: ${tokens}`,
    `- 90th percentile of the comparison set: ${baseline}${compared === null ? "" : ` (${count(compared, "")} comparison entries)`}`,
  ];
  return {
    primary: option(
      "g11-investigate-failed-work-item",
      "INVESTIGATE",
      `Find where the ${tokens}-token failed work item's spend went (workspace P90 is ${baseline}) before retrying the same approach.`,
      [
        "Spend sits next to a failed outcome; this does not show the spend caused the failure.",
        `Linked sessions: ${sessionIds.length === 0 ? "not recorded" : sessionIds.length}.`,
      ],
      g11Prompt(sessionIds, sessionTotal(rec), measured, tokens, baseline),
      null,
    ),
    alternatives: [],
  };
}

function c11Actions(rec: Parameters<FamilyHandler>[0]): CardActions {
  const errors = count(numberMetric(rec, "ERROR_COUNT"), "the observed");
  const readErrors = numberMetric(rec, "READ_ERROR_COUNT");
  // Only Read over-cap errors (no MCP ones): the MCP cap setting does not apply.
  if (readErrors !== null && readErrors > 0 && !((numberMetric(rec, "ERROR_COUNT") ?? 0) > 0)) {
    const files = (rec.tool_calls ?? []).filter((call) => call.tool === "Read");
    const named = files.map((call) => `\`${call.target}\``).slice(0, 3);
    // The tool's own message names the size and the cap ("(28561 tokens) exceeds ... (25000)").
    const sizes = files
      .map((call) => {
        const result = String((call as { result?: unknown }).result ?? "");
        const size = /\(([\d,]+) tokens\)/.exec(result)?.[1];
        const cap = /maximum allowed tokens \(([\d,]+)\)/i.exec(result)?.[1];
        return size && cap ? `${call.target}: ${size} tokens against a cap of ${cap}` : null;
      })
      .filter((line): line is string => line !== null)
      .slice(0, 2);
    const seen = files.length === 0 ? "" : ` (${named.join(", ")})`;
    // U9 r6: the Read's own input says whether it was a whole-file Read. One that already passed
    // offset or limit hit the cap anyway (long lines), so "read it in ranges" would repeat it.
    const ranged = files.length > 0 && files.every((call) => !call.whole_file);
    const reads = readErrors === 1 ? "a Read" : `${count(readErrors, "the observed")} Reads`;
    // U9 r8: a Read-range rule the user already has (project or user CLAUDE.md) is quoted, and the
    // card asks to tighten it instead of shipping the same rule again.
    const existing = files[0] === undefined ? null : existingReadRule(files[0].target);
    // U9 r9: no fixed line count — the failing Read's own limit is not recorded, and a fixed 200
    // can be larger than a limit that already failed (the live case used limit 80).
    const concrete = `For a file over ${existing?.kb ?? 40} KB, Grep for the part you need, or Read it with offset and limit. If a ranged Read still exceeds the output cap, retry with half that limit, halving again until it fits; never retry the same Read.`;
    const existingText =
      existing === null
        ? null
        : `${existing.file} already says: "${existing.line}". ${
            ranged
              ? "The failing Read did pass offset or limit, so it followed that rule; the rule sets no size for each range, so the range itself was still over the cap."
              : "The failing Read was a whole-file Read, so it did not follow that rule."
          } Replace that line with the one below; do not add a second rule.`;
    const hit = ranged
      ? `${reads} that already passed offset or limit still hit the output cap`
      : `${readErrors === 1 ? "a whole-file Read hit" : `${count(readErrors, "the observed")} whole-file Reads hit`} the output cap`;
    return {
      primary: option(
        "c11-read-in-ranges",
        "HABIT",
        ranged
          ? `Read a smaller range, or Grep for the part you need: ${hit}${seen}.`
          : `Read large files in ranges: ${hit}${seen}.`,
        [
          ...sizes,
          ranged
            ? "The Read already used offset or limit, so a range was not enough: its lines are long. Retry with half the limit it used, or Grep for the part you need."
            : "The error message itself suggests offset and limit; check its wording for the cap in effect.",
          "Searching for the part you need is often cheaper than reading the whole file.",
          // U9 r4: the scope of the count.
          "This counts the main conversation's Reads only; a subagent's Read that hit the same cap is not counted here.",
          ...(readErrors === 1
            ? [
                "One Read, in one session: a lead, not a pattern yet. This is a Read of a file, not an MCP tool response, so the MCP output-cap setting does not apply.",
              ]
            : []),
          // U9 r7: one detector card per session and week means the same habit can show up as
          // several cards; this line is the rule for all of them.
          "Each session that hit the Read cap gets its own card of this kind; the line below is the one rule for all of them, so add it once.",
          ...(existingText === null ? [] : [existingText]),
        ],
        // U9 r9: copy_text is only the CLAUDE.md lines to paste; the evidence and the note about
        // an existing rule are in the card body above.
        ["## Large files", "", concrete].join("\n"),
        null,
      ),
      alternatives: [],
    };
  }
  return {
    primary: option(
      "c11-raise-mcp-output-cap",
      "CONFIG",
      `Raise MAX_MCP_OUTPUT_TOKENS after ${errors} MCP output-cap errors.`,
      [
        "Check the cap in effect in the error message; don't assume the default.",
        "Raising the cap trades output-cap errors for more inline context bloat.",
      ],
      '{\n  "env": {\n    "MAX_MCP_OUTPUT_TOKENS": "<a value above the cap in your error message>"\n  }\n}',
      ".claude/settings.json",
    ),
    alternatives: [
      option(
        "c11-use-mcp-pagination",
        "HABIT",
        `Use server-side pagination after ${errors} MCP output-cap errors.`,
        [
          "Check whether the tool offers paging, filtering or a result limit, and use it so responses stay bounded.",
        ],
        "For this MCP call, check what paging, filtering or limit options the tool offers and use them instead of returning the full result.",
        null,
      ),
    ],
  };
}

/** U10: runs of shell, read and search turns the main session did on Opus or Fable. */
function e2Actions(
  rec: Rec,
  sessionIds: string[],
  rule: { file: string; line: string } | null = existingModelRule(),
): CardActions {
  const runs = count(numberMetric(rec, "RUNS"), "Several");
  const turns = count(numberMetric(rec, "RUN_TURNS"), "many");
  const types = (rec.tool_calls ?? [])
    .slice(0, 3)
    .map((call) => `${call.target} (${count(call.calls, "")} calls)`);
  const block = [
    "## Routine steps go to a Sonnet subagent",
    "When the next three or more steps only run git, npm, test or build commands, or read and search files, and need no edit or decision, send them as one Agent call with model: sonnet. Ask it to return a short summary: pass or fail, the lines that matter, file paths.",
    "Keep the main session on its model: switching it with /model mid-task rewrites the whole cache. A subagent starts its own cache, so it does not.",
  ].join("\n");
  return {
    primary: option(
      "e2-route-routine-runs",
      "EDIT",
      `Send runs of routine steps to a Sonnet subagent: ${runs} runs of ${turns} shell, read and search turns ran on the main model${types.length === 0 ? "" : `, mostly ${types.join(", ")}`}.`,
      [
        `${sessionIds.length === 0 ? "The sessions" : `The ${count(sessionIds.length, "")} sessions listed`} are the ones where the runs cost most; open one and check that the run was routine before adding the rule.`,
        "Do not switch the main session's model mid-task: that rewrites its whole cache. A subagent starts its own cache.",
        ...(rule === null
          ? []
          : [
              `${rule.file} already has a rule for delegating to subagents: "${rule.line}". It covers work the main session hands off; these runs were never handed off, they ran in the main session. The block below says when to hand them off; it does not repeat that rule.`,
            ]),
        "The saving assumes half of these runs are handed off; that is an assumption, not a measurement.",
      ],
      block,
      "CLAUDE.md",
    ),
    alternatives: [],
  };
}

export const routingHandler: FamilyHandler = (rec, ctx) => {
  switch (rec.detector_id) {
    case "D4":
      return withTargetMetric(d4Actions(rec, ctx.trigger.session_ids), "model_mix_opus_fraction");
    case "D9":
      return withTargetMetric(d9Actions(rec), "fork_subagent_count");
    case "D12":
      return withTargetMetric(d12Actions(rec, ctx.trigger.session_ids), "sidechain_result_bytes");
    case "G11":
      return withTargetMetric(
        g11Actions(rec, ctx.trigger.session_ids),
        "input_cache_tokens_per_work_item",
      );
    case "C11":
      return withTargetMetric(c11Actions(rec), "mcp_output_cap_error_count");
    case "E2":
      return withTargetMetric(
        e2Actions(rec, ctx.trigger.session_ids),
        "main_thread_mechanical_run_cost",
      );
    default:
      return null;
  }
};
