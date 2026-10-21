import { type B4Event, parseB4Events } from "../../../../detector/cache-collapse.js";
import { b1FindingDescriptor } from "../../../../detector/detectors/b1_cache_read_collapse.js";
import { D8_AVOIDANCE_FRACTION } from "../../../../detector/savings.js";
import { numberMetric, stringMetric } from "../accessor.js";
import { cardPrompt as cachePrompt, sessionsLine } from "../prompt.js";
import type { CardAction, CardActions, FamilyHandler } from "../types.js";

export const CACHE_DETECTOR_IDS = ["B1", "B2", "B3", "B4", "D8"] as const;

type Rec = Parameters<FamilyHandler>[0];

/** The metric each detector's effect measurement watches (its descriptor `target_metric`). */
const TARGET_METRIC: Record<string, string> = {
  B1: "cache_read_tokens",
  B2: "cache_read_tokens",
  B3: "cache_creation_tokens",
  B4: "cache_creation_tokens",
  D8: "cache_read_to_creation_ratio",
};

function sessionScope(sessionIds: string[]): string {
  return sessionIds.length === 0
    ? "the listed sessions"
    : `${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"}`;
}

function metricText(value: number | null, suffix = ""): string | null {
  return value === null ? null : `${value.toLocaleString("en-US")}${suffix}`;
}

/** A break length: minutes up to two hours, then hours. */
function gapText(ms: number | null): string | null {
  if (ms === null) return null;
  return ms <= 7_200_000
    ? metricText(Math.round(ms / 60_000), " min")
    : `${(ms / 3_600_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} hours`;
}

/** Timestamp of the finding's current (second) anchor turn, if the evidence carries one. */
function anchorTime(rec: Rec): string | null {
  const anchors = rec.evidence?.anchors;
  if (!Array.isArray(anchors)) return null;
  const last = anchors[anchors.length - 1] as { timestamp?: unknown } | undefined;
  return typeof last?.timestamp === "string" ? last.timestamp : null;
}

function habit(detectorId: string, summary: string, prompt: string, detail: string[] = []) {
  const action: CardAction = {
    kind: "HABIT",
    summary,
    detail,
    copy_text: prompt,
    file_ref: null,
    target_metric: TARGET_METRIC[detectorId] as string,
  };
  return action;
}

function withId(action: CardAction, optionId: string) {
  return { ...action, option_id: optionId };
}

const CACHE_BASICS =
  "Claude Code caches the start of every request: system prompt, tools, CLAUDE.md, memory, then the conversation so far. A turn sent while that cache is still alive reads it at a fraction of the normal input price (the fraction depends on the model); a turn that misses it writes the whole context again at full cache-write price.";
const TRANSCRIPTS =
  "Each session's transcript is `~/.claude/projects/<project folder>/<session id>.jsonl`; find it by the session id. Assistant lines carry `message.usage` with `cache_read_input_tokens` and `cache_creation_input_tokens`.";

const usd = (u: number): string => `$${(u / 1e6).toFixed(2)}`;

/** The CLAUDE.md line B4 offers when its breaks follow ToolSearch (U9 diagnosis). */
export const LOAD_TOOLS_EARLY_LINE =
  "When a task will use tools that load on demand through ToolSearch (such as browser tools), load them all in one ToolSearch call as the first step of that task, before reading files.";

/** The MCP server a tool belongs to (`mcp__<server>__<tool>`), else null. */
function mcpServer(tool: string): string | null {
  return tool.startsWith("mcp__") ? (tool.slice(5).split("__")[0] ?? null) : null;
}

/** "claude-in-chrome (9 of 11)" for the servers first called on the break turns. */
function serverSummary(events: B4Event[]): string | null {
  const counts = new Map<string, number>();
  for (const event of events) {
    const server = mcpServer(event.first_tool);
    if (server !== null) counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([server, n]) => `${server} (${n} of ${events.length})`)
    .join(", ");
}

/** How many breaks had a non-MCP tool (Bash) first on the break turn: MCP loading is inferred there. */
function nonMcpFirst(events: B4Event[]): number {
  return events.filter((event) => mcpServer(event.first_tool) === null).length;
}

/** The inference caveat: the ToolSearch call is seen, an MCP server's tools loading is not. */
function inferredLine(events: B4Event[]): string | null {
  const n = nonMcpFirst(events);
  return n === 0
    ? null
    : `${n} of ${events.length} had ${[...new Set(events.filter((e) => mcpServer(e.first_tool) === null).map((e) => e.first_tool))].join(", ")} as the first tool on the break turn, so MCP loading is inferred there (from the ToolSearch call before it), not seen.`;
}

/** The cause the stored data supports, or "unknown" with the evidence to look for. */
function causeLine(
  afterToolSearch: number | null,
  events: number | null,
  firstMcpLoad: number | null = null,
  sessionToolSearchCalls: number | null = null,
  inferred: string | null = null,
): string {
  if (afterToolSearch !== null && events !== null && afterToolSearch > 0) {
    const first =
      firstMcpLoad !== null && firstMcpLoad > 0
        ? ` ${firstMcpLoad === afterToolSearch ? "All of them" : `${firstMcpLoad} of them`} came before the session had called any MCP tool, so the call was loading an MCP server's tools for the first time.`
        : "";
    const others =
      sessionToolSearchCalls !== null && sessionToolSearchCalls > afterToolSearch
        ? ` In these sessions ${sessionToolSearchCalls - afterToolSearch} other ToolSearch call(s) did not break the cache, so a ToolSearch call alone does not break it.`
        : "";
    return `Measured pattern: ${afterToolSearch} of ${events} breaks came on the turn right after a ToolSearch call, which loads tool definitions on demand.${first}${inferred === null ? "" : ` ${inferred}`}${others} On those turns the cache still matched the start of the prompt and everything after it was written again. This is a pattern, not a proven cause: the stored data does not show which tools each call loaded.${afterToolSearch < events ? " The others have no recorded cause." : ""}`;
  }
  return "Cause not known from the recorded data: no ToolSearch call came right before these breaks. Read the lines just before each one for an edit to CLAUDE.md or memory, an MCP server connecting, or a settings change.";
}

/** B4: one table row per break, most tokens first. */
function eventRows(events: B4Event[]): string[] {
  return [
    "",
    "| session | time (UTC) | cache read: previous → break (session's first turn) | written again | paid over a cache read | after ToolSearch | first tool on the turn |",
    "|---|---|---|---|---|---|---|",
    ...events.map(
      (e) =>
        `| ${e.session_id} | ${e.ts} | ${e.previous_read.toLocaleString("en-US")} → ${e.read.toLocaleString("en-US")} (${e.first_read.toLocaleString("en-US")}) | ${e.written.toLocaleString("en-US")} | ${usd(e.rewrite_cost_u)} | ${e.after_tool_search ? "yes" : "no"} | ${e.first_tool} |`,
    ),
  ];
}

/** B1 and B4: the cache dropped while still warm because the prompt prefix changed. */
function prefixChangePrompt(
  findings: string[],
  firstTime: string | null,
  cause: string,
  toolSearch: boolean,
  fix: string,
): string {
  return cachePrompt({
    title: toolSearch
      ? "Load on-demand tools before the conversation grows"
      : "Find what broke the prompt cache mid-session",
    intro:
      "found turns where the prompt cache was dropped while it was still warm, so Claude Code wrote the conversation again at the cache-write price.",
    context: [
      CACHE_BASICS,
      `These turns came within the cache lifetime, so an idle break is not the cause. ${cause}`,
      TRANSCRIPTS,
    ],
    findings,
    fix,
    steps: toolSearch
      ? [
          `Check the cause on the largest break${firstTime ? ` (${firstTime} UTC)` : ""}: in that session's transcript, confirm the line before it is a ToolSearch result, and say which tools it loaded and whether any tool from the same MCP server had been loaded earlier in the session. Report tool names and \`message.usage\` numbers only.`,
          "Check two more rows of the table the same way. If one did not follow a ToolSearch call, say what came right before it instead.",
          `Propose where this line goes (the project CLAUDE.md or ~/.claude/CLAUDE.md), and name any existing instruction that loads these tools late, for example only at a final check: "${LOAD_TOOLS_EARLY_LINE}"`,
          "Ask me to confirm before changing any file.",
          "After I confirm, add the line and reword any instruction you named.",
          "Verify: re-read the file and quote the final line.",
        ]
      : [
          `For each session above, find the break turn and read the lines just before it.${firstTime ? ` Start with the turn at ${firstTime} (UTC).` : ""} Name the cause: a CLAUDE.md or memory edit, an MCP server connecting or disconnecting, a settings change, or other. Quote the tool call that shows it.`,
          "Write a table: session, time, cause, tokens written again (`cache_creation_input_tokens` on that turn).",
          "Propose the smallest fix for each cause you found.",
          "Ask me to confirm the plan before changing any file.",
          "After I confirm, make the agreed edits in one batch.",
          "Verify: re-read every file you changed.",
        ],
    notes: [
      "AgentWrangler re-measures these breaks in later sessions. Fewer mid-session breaks is the goal.",
    ],
  });
}

/** Review 5 U4 (R KF 3): a cold /compact is no cheap summary. */
const COLD_COMPACT =
  "After a long break, /compact reprocesses the whole history as uncached input.";

/** Review 5 U4 (M4): D8's three-way habit. */
const D8_HABIT =
  "Before a break longer than the cache lifetime: if the next task is new, run /clear; if it continues, write a handoff, then /clear; use /compact only as a fallback while the cache is still warm. Back after the cache expired and starting something new? Run /clear before your first message: only the base prompt is written, not the old conversation. Only a continuing task needs the handoff before the break";

/** Review 5 U8 (M20): keep whole transcripts out of the main conversation (D8 and B2). */
const FRESH_SESSION_SCAN =
  "Run this in a fresh session. Scan transcripts with a script (the `message.usage`, `tool_use` and `is_error` fields) or one subagent per session, and bring back only the table; do not read whole transcripts into this conversation.";

/**
 * B2 and D8: the session resumed after the cache had expired. Both carry D8's three-way habit
 * (review 5 M4); B2 used to advise /compact before a break, which contradicted it.
 */
function idleExpiryPrompt(
  findings: string[],
  lifetime: string,
  fixExtra = "",
  contextExtra: string[] = [],
): string {
  return cachePrompt({
    title: "Cut full-context rewrites after idle breaks",
    intro: `found sessions resumed after a break longer than the prompt cache lifetime (${lifetime}). The cache had expired, so the first turn after each break wrote the whole conversation again at full cache-write price.`,
    context: [
      CACHE_BASICS,
      `The larger the conversation at the break, the more a resume costs. /clear (or a new session) before the break means only the base prompt is written after it. If the next work is a new task, just /clear. If it continues the same task, first write a short handoff (goal, decisions, files, next step) to a file, then /clear, and start from the handoff. /compact is a fallback only while the cache is still warm. ${COLD_COMPACT}`,
      TRANSCRIPTS,
      FRESH_SESSION_SCAN,
      ...contextExtra,
    ],
    findings,
    fix: `${D8_HABIT}.${fixExtra}`,
    steps: [
      `For each session above, scan its transcript and find assistant turns that come longer than the cache lifetime (${lifetime}) after the previous assistant turn and have \`cache_creation_input_tokens\` of 50,000 or more with few cache reads.`,
      "For each one, read the user message after the break and decide: did it continue the same task, or start a new one?",
      "Write a table: session, break length, tokens written again, same or new task.",
      "Recommend a habit per case: a new task → /clear or a new session; the same task → a handoff, then /clear, before the break. Estimate how many tokens each habit would have saved, using the base prompt size (the first turn of a fresh session) plus the handoff's size.",
      "Ask me to confirm which habit I will adopt.",
      fixExtra === ""
        ? "After I confirm, summarize the habit in one or two lines I can keep. No files need to change."
        : "After I confirm, summarize the habit in one or two lines I can keep. No file needs to change: the break message above is something I type, not a CLAUDE.md rule.",
      "Verify: check the table covers every session above; say which sessions had no qualifying break, if any.",
    ],
    notes: [
      "A /clear that forces me to re-explain the task is not a win; keep context I still need.",
      "AgentWrangler re-measures the tokens written again after breaks in later sessions.",
    ],
  });
}

function b1Actions(rec: Rec, triggerSessionIds: string[]): CardActions {
  // U9 r4: B1 owns the fix. Its EVENTS list has every collapse, costliest first, so all the
  // sessions are named in that order (the trigger list is capped at five).
  const eventsText = stringMetric(rec, "EVENTS");
  const breaks = eventsText === null ? [] : parseB4Events(eventsText);
  const sessionIds =
    breaks.length > 0 ? [...new Set(breaks.map((e) => e.session_id))] : triggerSessionIds;
  const ratio = numberMetric(rec, "CURRENT_TO_PREVIOUS_RATIO");
  const prev = metricText(numberMetric(rec, "PREVIOUS_CACHE_READ_TOKENS"));
  const curr = metricText(numberMetric(rec, "CURRENT_CACHE_READ_TOKENS"));
  const ratioText =
    ratio === null ? "a collapse" : `${Math.round(ratio * 100)}% of the previous turn`;
  const scope = sessionScope(sessionIds);
  const time = breaks[0]?.ts ?? anchorTime(rec);
  // Where the break landed: the prefix that still read from cache, per collapse.
  const events = numberMetric(rec, "COLLAPSE_EVENT_COUNT");
  const currTokens = numberMetric(rec, "CURRENT_CACHE_READ_TOKENS");
  const landed =
    events !== null && events > 0 && currTokens !== null
      ? metricText(Math.round(currTokens / events))
      : null;
  const rapid = numberMetric(rec, "RAPID_COLLAPSE_COUNT");
  const toolSearch = numberMetric(rec, "TOOLSEARCH_COLLAPSE_COUNT");
  const rewrite = numberMetric(rec, "REWRITE_COST_U");
  const creation = numberMetric(rec, "CURRENT_CACHE_CREATION_TOKENS");
  const findings = [
    sessionsLine(sessionIds),
    ...(time ? [`- ${breaks.length > 0 ? "Costliest" : "Largest"} collapse: ${time} (UTC)`] : []),
    ...(landed
      ? [`- On average the cache still matched the first ${landed} tokens of the prompt`]
      : []),
    ...(prev && curr
      ? [
          events !== null && events > 1 && currTokens !== null
            ? `- Per collapse turn, cache reads fell from about ${metricText(Math.round((numberMetric(rec, "PREVIOUS_CACHE_READ_TOKENS") ?? 0) / events))} to about ${metricText(Math.round(currTokens / events))} tokens on average (${ratioText}; ${prev} → ${curr} summed over ${events} turns, not one drop)`
            : `- Cache reads fell from ${prev} to ${curr} tokens across the collapse turns (${ratioText})`,
        ]
      : []),
    ...(rewrite !== null && creation !== null && rec.savings_u_per_wk !== undefined
      ? [
          `- Saving, an estimate: ${metricText(creation)} tokens written again cost ${usd(rewrite)} more than reading them from cache (each turn's own cache-write minus cache-read price). That is the most the fix could save. The card assumes half of it is avoidable, which gives ${usd(rec.savings_u_per_wk)} a week: an assumption, not a measurement, since loading tools early makes each rewrite smaller but does not stop the break`,
        ]
      : []),
    ...(breaks.length > 0 ? eventRows(breaks) : []),
  ];
  // U9: the rapid collapses are also B4's events, listed one by one there; B1 carries its own fix.
  const pointer =
    rapid !== null && rapid > 0
      ? `${rapid} of these collapses are also listed one by one on the "${b4CardTitle(null)}" card.`
      : "";
  const viaToolSearch = toolSearch !== null && toolSearch > 0;
  const inferred = inferredLine(breaks);
  const investigate = prefixChangePrompt(
    findings,
    time,
    causeLine(
      toolSearch,
      events,
      numberMetric(rec, "FIRST_MCP_LOAD_COUNT"),
      numberMetric(rec, "SESSION_TOOLSEARCH_CALLS"),
      inferred,
    ),
    viaToolSearch,
    viaToolSearch
      ? `Try loading the tools a task needs at its start, while the conversation is small: ${LOAD_TOOLS_EARLY_LINE} If collapses continue after that, the cause is something else.`
      : "Find what changed the prompt right before each collapse, then move that kind of change to a task boundary.",
  );
  if (!viaToolSearch) {
    return {
      primary: withId(
        habit(
          "B1",
          `Find what changed the prompt when cache reads fell to ${ratioText} in ${scope}, and move it out of the middle of the work.`,
          investigate,
          pointer === "" ? [] : [pointer],
        ),
        "attribute-cache-read-collapse",
      ),
      alternatives: [],
    };
  }
  // U9 r4: the primary copy_text is the CLAUDE.md line itself, ready to paste.
  const count = events ?? toolSearch;
  // U9 r8: the paste carries this user's evidence, not only the generic line.
  const servers = serverSummary(breaks);
  const evidence =
    breaks.length > 0 && rewrite !== null && creation !== null
      ? `Why this line: in the last week ${breaks.length} session${breaks.length === 1 ? "" : "s"} (${sessionIds.join(", ")}) had the prompt cache dropped while it was still warm, and Claude Code wrote ${metricText(creation)} tokens again (${usd(rewrite)} more than cache reads would have cost). ${toolSearch} of ${count} breaks came on the turn right after a ToolSearch call${servers === null ? "" : `, and the first tool called on the break turn belonged to ${servers}`}. That is a pattern, not a proven cause; the line only makes each rewrite smaller by loading the tools while the conversation is small.\n\n`
      : "";
  return {
    primary: withId(
      habit(
        "B1",
        `Load the on-demand tools a task needs in one ToolSearch call at its start: ${toolSearch} of ${count} cache collapses came right after a ToolSearch call (a measured pattern, not a proven cause).`,
        `${evidence}Add this line to ~/.claude/CLAUDE.md (or the project's CLAUDE.md):\n\n${LOAD_TOOLS_EARLY_LINE}\n\nBefore adding it, search those files for an existing instruction that loads browser or other on-demand tools late (for example only at a final check) and reword that one to match, so the two do not conflict.`,
        [
          "Add it to the project CLAUDE.md or ~/.claude/CLAUDE.md. It makes the rewrite small (tools load while the conversation is small); it does not stop the break.",
          ...(inferred === null ? [] : [inferred]),
          ...(pointer === "" ? [] : [pointer]),
          "If breaks continue after a week with the line in place, the cause is something else.",
        ],
      ),
      "add-load-tools-early-line",
    ),
    alternatives: [
      withId(
        habit(
          "B1",
          "Have Claude check the cause on the costliest break before you add the line.",
          investigate,
        ),
        "attribute-cache-read-collapse",
      ),
    ],
  };
}

/** B4's card name: the per-break evidence list for B1's collapses (B1 owns the fix). */
const B4_CARD_NAME = "Mid-session cache breaks, one by one";

export function b4CardTitle(count: number | null): string {
  return count === null
    ? B4_CARD_NAME
    : `${B4_CARD_NAME}: ${count} ${count === 1 ? "break" : "breaks"}`;
}

function b4Actions(rec: Rec, sessionIds: string[]): CardActions {
  const eventsText = stringMetric(rec, "EVENTS");
  // Per-event rows from before U9 carry one break and no EVENTS text.
  const events = eventsText === null ? [] : parseB4Events(eventsText);
  const count = numberMetric(rec, "EVENT_COUNT") ?? (events.length || 1);
  const creation = numberMetric(rec, "CURRENT_CACHE_CREATION_TOKENS");
  const rewrite = numberMetric(rec, "REWRITE_COST_U");
  const toolSearch = numberMetric(rec, "TOOLSEARCH_EVENT_COUNT");
  const time = anchorTime(rec);
  const servers = serverSummary(events);
  const gaps = events.map((e) => e.gap_ms);
  const atFirst = events.filter(
    (e) => e.first_read > 0 && Math.abs(e.read - e.first_read) <= e.first_read * 0.01,
  ).length;
  const sessions = new Set(events.map((e) => e.session_id)).size || sessionIds.length;
  const hasToolSearch = toolSearch !== null && toolSearch > 0;
  const findings = [
    sessionsLine(sessionIds),
    `- ${count.toLocaleString("en-US")} break${count === 1 ? "" : "s"} in ${sessions} session${sessions === 1 ? "" : "s"}${creation === null ? "" : `: ${metricText(creation)} tokens written again`}${rewrite === null ? "" : `, ${usd(rewrite)} more than reading them from cache (tokens × each turn's cache-write minus cache-read price)`}`,
    ...(gaps.length > 0
      ? [
          `- Each came ${Math.round(Math.min(...gaps) / 1000)}–${Math.round(Math.max(...gaps) / 1000)} s after the previous turn, inside a run of tool calls`,
        ]
      : []),
    ...(toolSearch !== null ? [`- After a ToolSearch call: ${toolSearch} of ${count}`] : []),
    ...(servers === null
      ? []
      : [`- First tool called on the break turn, by MCP server: ${servers}`]),
    ...(events.length > 0
      ? [
          `- On ${atFirst} of ${events.length} the cache read fell to the same size as the session's first turn (its system prompt and base tools)`,
        ]
      : []),
    ...(events.length < count && events.length > 0
      ? [`- The ${events.length} largest are listed below`]
      : []),
    ...(events.length > 0 ? eventRows(events) : []),
  ];
  // U9 r4: B1 owns the fix and the weekly $. With the per-break list B4 is the evidence table
  // only: its copy_text is the table, not a second copy of B1's prompt.
  if (events.length > 0) {
    const lever = b1FindingDescriptor.presentation.lever;
    return {
      primary: withId(
        {
          kind: "HABIT",
          summary: `The ${count} breaks one by one: when, how much each rewrote and what ran first. The fix and the weekly $ are on the "${lever}" card.`,
          detail: [
            `Fix and weekly $ (${rewrite === null ? "not recorded" : usd(rewrite)} over cache reads, before the avoidable share) are counted once, on the "${lever}" card.`,
          ],
          copy_text: [
            `# ${b4CardTitle(count)}`,
            "",
            `AgentWrangler (a local Claude Code spend monitor) found ${count} turns where the prompt cache was dropped while still warm. The fix is on its "${lever}" card. Per break:`,
            "",
            ...findings,
            "",
            causeLine(
              toolSearch,
              count,
              numberMetric(rec, "FIRST_MCP_LOAD_COUNT"),
              numberMetric(rec, "SESSION_TOOLSEARCH_CALLS"),
              inferredLine(events),
            ),
            "",
            "## Ask",
            `For each of the ${count} breaks, open the session's transcript (${TRANSCRIPTS}) at the time in the table and report, one line per break: what the ToolSearch call before it asked for, which tools it loaded, and whether the cache read on the next turn came back. Then say whether the ToolSearch calls that did not break the cache asked for something different. Do not change any file and do not estimate a saving: the fix and the weekly $ live on the "${lever}" card.`,
          ].join("\n"),
          file_ref: null,
          target_metric: TARGET_METRIC.B4 as string,
        },
        "list-prefix-breaks",
      ),
      alternatives: [],
    };
  }
  const fix = hasToolSearch
    ? `Try loading the tools a task needs at its start, while the conversation is small, or do the browser work in a subagent or a fresh session. Trial CLAUDE.md line: "${LOAD_TOOLS_EARLY_LINE}" Re-measure after a week: if breaks continue, the cause is something else.`
    : "Find what changed the prompt right before each break, then move that kind of change to a task boundary.";
  const summary = hasToolSearch
    ? `Load on-demand tools once, at the start of a task: ${toolSearch} of ${count} cache breaks${rewrite === null ? "" : ` (${usd(rewrite)} over cache reads)`} came right after a ToolSearch call (a measured pattern, not a proven cause).`
    : `Find what changed the prompt before ${count} mid-session cache break${count === 1 ? "" : "s"}${creation === null ? "" : ` that wrote ${metricText(creation)} tokens again`} in ${sessionScope(sessionIds)}.`;
  return {
    primary: withId(
      habit(
        "B4",
        summary,
        prefixChangePrompt(
          findings,
          time,
          causeLine(
            toolSearch,
            count,
            numberMetric(rec, "FIRST_MCP_LOAD_COUNT"),
            numberMetric(rec, "SESSION_TOOLSEARCH_CALLS"),
          ),
          hasToolSearch,
          fix,
        ),
        [
          `The weekly $ for these breaks (${rewrite === null ? "not recorded" : usd(rewrite)} over cache reads) is counted once, on the Cache-read collapse card.`,
        ],
      ),
      "keep-prefix-stable",
    ),
    alternatives: [],
  };
}

function b2Actions(rec: Rec, sessionIds: string[]): CardActions {
  const gap = gapText(numberMetric(rec, "GAP_DURATION_MS"));
  const ttl = numberMetric(rec, "CONSERVATIVE_TTL_DURATION_MS");
  const prev = metricText(numberMetric(rec, "PREVIOUS_CACHE_READ_TOKENS"));
  const curr = metricText(numberMetric(rec, "CURRENT_CACHE_READ_TOKENS"));
  const findings = [
    sessionsLine(sessionIds),
    ...(gap ? [`- Longest break: ${gap}`] : []),
    ...(prev && curr
      ? [`- Cache reads fell from ${prev} to ${curr} tokens, summed over the resume turns`]
      : []),
  ];
  return {
    primary: withId(
      habit(
        "B2",
        `${D8_HABIT}${gap === null ? "" : ` (the longest here was ${gap})`}.`,
        idleExpiryPrompt(findings, ttl === null ? "one hour" : (gapText(ttl) ?? "one hour")),
      ),
      "resume-within-ttl",
    ),
    alternatives: [],
  };
}

function b3Actions(rec: Rec, sessionIds: string[]): CardActions {
  const gapMs = numberMetric(rec, "GAP_DURATION_MS");
  const gap = gapText(gapMs);
  const creation = metricText(numberMetric(rec, "CURRENT_CACHE_CREATION_TOKENS"));
  const base = metricText(numberMetric(rec, "BASE_PREFIX_TOKENS"));
  const scope = sessionScope(sessionIds);
  const evidence = gap === null ? scope : `${gap} resume gap in ${scope}`;
  const prompt = cachePrompt({
    title: "Continue the same work in the same session",
    intro:
      "found a new session that started while the previous session's cache was still warm and wrote about as much context as that session had ended with. That looks like the same work picked back up in a new session, rebuilding context the old session already had.",
    context: [
      CACHE_BASICS,
      "Claude Code can reopen an earlier session so its next turn reads the warm cache instead of rebuilding context. Check `claude --help` for the exact option (continue or resume).",
      TRANSCRIPTS,
    ],
    findings: [
      sessionsLine(sessionIds),
      ...(gap ? [`- Time between the two sessions: ${gap}`] : []),
      ...(creation ? [`- Tokens written on the new session's first turn: ${creation}`] : []),
      ...(base ? [`- A fresh session here usually starts at about ${base} tokens`] : []),
    ],
    fix: "When you pick the same work back up soon after, reopen the previous session instead of opening a new one (check `claude --help` for how).",
    steps: [
      "Open both transcripts. Confirm the second session continued the first one's work, and note how it was started (fresh prompt, pasted summary, or re-read files).",
      "Explain what the new session rebuilt that the old one already had (files re-read, context re-pasted), with token counts from `message.usage`.",
      "Say whether reopening the previous session would have kept that work, or whether a fresh start was right (for example, the old context was too large or off-topic).",
      "Ask me to confirm the habit before summarizing it.",
      "After I confirm, summarize it in one or two lines I can keep. No files need to change.",
      "Verify: state the tokens the new session wrote beyond the usual fresh start, from step 2.",
    ],
    notes: [
      "A fresh session is right when the old context is large and mostly irrelevant; this is about quick restarts on the same task.",
    ],
  });
  return {
    primary: withId(
      habit(
        "B3",
        `Reopen the previous session instead of starting a new one after the ${evidence}.`,
        prompt,
      ),
      "resume-within-cache-ttl",
    ),
    alternatives: [],
  };
}

function d8NoHarm(): string {
  return "Treat a saving followed by rework, retries, edit churn, or follow-up turns as not a win.";
}

/** The stored biggest resumes as table rows; empty on rows written before the list existed. */
function resumeTable(rec: Rec): string[] {
  const raw = rec.facts?.top_resumes ?? rec.evidence?.top_resumes;
  if (!Array.isArray(raw)) return [];
  const rows: string[] = [];
  for (const item of raw) {
    // "session_id|at|gap_min|written_tokens|net_tokens" (the payload only allows label strings).
    const [session, at, gapMin, written, net] = typeof item === "string" ? item.split("|") : [];
    if (!session || !at || !gapMin || !written || !net) continue;
    if ([gapMin, written, net].some((part) => !Number.isFinite(Number(part)))) continue;
    rows.push(
      `| ${session} | ${at.slice(0, 16).replace("T", " ")} | ${gapText(Number(gapMin) * 60_000)} | ${Number(written).toLocaleString("en-US")} | ${Number(net).toLocaleString("en-US")} |`,
    );
  }
  return rows;
}

function d8Actions(rec: Rec, sessionIds: string[]): CardActions {
  const regime = stringMetric(rec, "regime");
  const churnTokens = numberMetric(rec, "total_churn_creation_tokens");
  const churn = metricText(churnTokens);
  const events = metricText(numberMetric(rec, "churn_event_count"));
  const sessionCount = numberMetric(rec, "session_count");
  // The trigger lists some ids; the finding's own count is the true scope.
  const scope =
    sessionCount !== null && sessionCount > sessionIds.length
      ? `${sessionCount} sessions`
      : sessionScope(sessionIds);
  const evidence = churn === null ? scope : `${churn} churn creation tokens across ${scope}`;
  const longestMin = numberMetric(rec, "longest_gap_min");
  const gap = longestMin === null ? null : gapText(longestMin * 60_000);
  const hourBreaks = numberMetric(rec, "gap_60_240_min_count");
  const longBreaks = numberMetric(rec, "gap_240_plus_min_count");
  const shortBreaks =
    (numberMetric(rec, "gap_5_15_min_count") ?? 0) +
    (numberMetric(rec, "gap_15_60_min_count") ?? 0);
  const lifetimeWord = shortBreaks > 0 || regime === "5m" ? "5 minutes" : "1 hour";
  const net = numberMetric(rec, "net_churn_creation_tokens");
  const base = numberMetric(rec, "base_prefix_tokens");
  const saving = rec.savings_u_per_wk;
  const resumeRows = resumeTable(rec);
  // U9 r5: the cache tier these resume turns actually wrote to is the lifetime evidence.
  const write5m = numberMetric(rec, "churn_write_5m_tokens");
  const write1h = numberMetric(rec, "churn_write_1h_tokens");
  const tierText =
    write5m === null || write1h === null
      ? null
      : `${write1h.toLocaleString("en-US")} tokens to the 1-hour cache tier and ${write5m.toLocaleString("en-US")} to the 5-minute tier`;
  const findings = [
    sessionsLine(sessionIds, sessionCount),
    ...(events ? [`- Main-conversation resumes after an expired cache: ${events}`] : []),
    ...(hourBreaks !== null && longBreaks !== null
      ? [
          `- Break lengths: ${hourBreaks.toLocaleString("en-US")} of 1 to 4 hours, ${longBreaks.toLocaleString("en-US")} of 4 hours or more${shortBreaks > 0 ? `, ${shortBreaks.toLocaleString("en-US")} under an hour` : ""}`,
        ]
      : []),
    ...(gap === null ? [] : [`- Longest break before one of them: ${gap}`]),
    ...(churn ? [`- Tokens written again on those turns: ${churn}`] : []),
    ...(tierText === null
      ? []
      : [
          `- Cache tier of those writes (this is the lifetime your sessions had, read from the data, not from a plan rule): ${tierText}`,
        ]),
    ...(net !== null && base !== null
      ? [
          `- Net of a fresh start: ${net.toLocaleString("en-US")} tokens (a fresh start writes the ~${base.toLocaleString("en-US")}-token base prompt anyway, once per resume)`,
        ]
      : []),
    ...(net !== null && net > 0 && saving !== undefined && saving > 0
      ? [
          `- Saving basis: ${net.toLocaleString("en-US")} net tokens × ${Math.round(D8_AVOIDANCE_FRACTION * 100)}% assumed avoidable × $${(saving / (net * D8_AVOIDANCE_FRACTION)).toFixed(2)} per million (cache-write price less cache-read price, blended over the tiers these turns wrote to) = $${(saving / 1e6).toFixed(2)} a week. The ${Math.round(D8_AVOIDANCE_FRACTION * 100)}% is an assumption, not a measurement.`,
        ]
      : []),
    ...(resumeRows.length > 0
      ? [
          "",
          "Biggest resumes (most tokens written again first):",
          "| session | resumed at (UTC) | break | written again | net of fresh start |",
          "|---|---|---|---|---|",
          ...resumeRows,
        ]
      : []),
  ];
  const counted = [
    events === null ? `in ${scope}` : `${events} resumes after the cache expired, in ${scope}`,
    ...(gap === null ? [] : [`the longest break was ${gap}`]),
  ];
  const clear = withId(
    habit(
      "D8",
      `${D8_HABIT} (${counted.join("; ")}).`,
      idleExpiryPrompt(
        findings,
        regime === "5m"
          ? "5 minutes, measured from the cache writes in these sessions"
          : tierText === null
            ? "measured from the main conversation's own cache writes: one hour for turns that wrote to the 1-hour tier, 5 minutes for the 5-minute tier"
            : `measured from this workspace's own cache writes: these resume turns wrote ${tierText}`,
        `\nThis is a habit for you, not a rule for Claude: Claude cannot know a break is coming, so a CLAUDE.md line would never fire. Before you step away for more than ${lifetimeWord}, paste this line:\n\n\`If this task continues, write a handoff (goal, decisions, files, next step) now, to a file named HANDOFF- followed by the current git branch name and .md.\`\n\nThen run /clear yourself.`,
        [
          "The cache lifetime depends on the cache tier a call writes to (1 hour or 5 minutes). This card did not read it from a setting or assume it from your plan: it took each thread's lifetime from the cache tier that thread's own writes used.",
          "This card is only about breaks. Cost that builds up while you keep working in one long session is a separate card (long sessions); do not count the same turns twice.",
        ],
      ),
      [COLD_COMPACT, d8NoHarm()],
    ),
    "clear-at-task-boundary",
  );

  if (regime !== "5m") return { primary: clear, alternatives: [] };

  return {
    primary: {
      option_id: "enable-one-hour-prompt-caching",
      kind: "CONFIG",
      summary: `Enable 1h prompt caching for ${evidence}.`,
      detail: [d8NoHarm()],
      copy_text: '{\n  "env": {\n    "ENABLE_PROMPT_CACHING_1H": "1"\n  }\n}',
      file_ref: ".claude/settings.json",
      target_metric: TARGET_METRIC.D8 as string,
    },
    alternatives: [clear],
  };
}

export const cacheHandler: FamilyHandler = (rec, ctx) => {
  switch (rec.detector_id) {
    case "B1":
      return b1Actions(rec, ctx.trigger.session_ids);
    case "B2":
      return b2Actions(rec, ctx.trigger.session_ids);
    case "B3":
      return b3Actions(rec, ctx.trigger.session_ids);
    case "B4":
      return b4Actions(rec, ctx.trigger.session_ids);
    case "D8":
      return d8Actions(rec, ctx.trigger.session_ids);
    default:
      return null;
  }
};
