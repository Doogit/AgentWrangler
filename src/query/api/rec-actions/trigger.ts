import { parseB4Events } from "../../../detector/cache-collapse.js";
import { E2_SUBAGENT_BASE_TOKENS } from "../../../detector/detectors/e2_main_thread_mechanical_runs.js";
import {
  A1_RESULT_BYTES_THRESHOLD,
  CX_WASTED_TURN_AVOIDANCE_FRACTION,
  D1_AVOIDANCE_BASIS,
  D1_TRIM_TO_TARGET_FRACTION,
  D2_AVG_CONTEXT_THRESHOLD,
  D2_CALLS_PER_SPLIT,
  D2_TURN_COUNT_THRESHOLD,
  D4_AVOIDANCE_BASIS,
  D4_LOOKUP_TURN_SHARE,
  D4_MISMATCH_MAX_OUTPUT_TOKENS,
  D4_MISMATCH_MIN_CONTEXT_TOKENS,
  D4_REALIZABLE_AVOIDANCE_FRACTION,
  D7_AVOIDANCE_FRACTION,
  D8_AVOIDANCE_FRACTION,
  D8_EVENT_FLOOR_PCT,
  D8_LOW_READ_RATIO,
  E1_AVOIDANCE_BASIS,
  E1_AVOIDANCE_FRACTION,
  E2_AVOIDANCE_FRACTION,
} from "../../../detector/savings.js";
import { numberMetric, stringMetric } from "./accessor.js";
import type {
  CardActionRecommendation,
  CardToolCall,
  CardTrigger,
  CardTriggerFact,
  GuardShape,
} from "./types.js";
import { whyText } from "./why.js";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function validWindow(value: unknown): { from: string; to: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { from, to } = value as Record<string, unknown>;
  return typeof from === "string" && typeof to === "string" ? { from, to } : null;
}

const count = (value: number): string => value.toLocaleString("en-US");
const pct0 = (fraction: number): string => `${Math.round(fraction * 100)}%`;
/** The trigger lists at most this many of a finding's sessions. */
const MAX_LISTED_SESSIONS = 5;
// Review 5 folded minor: named by its card title (D7_RETRY_LOOP's lever), not a "loop card" nickname.
const D7_LOOP_CARD_TITLE = "Stop repeated attempts and re-plan after a bounded retry threshold.";
/** A break length: minutes up to two hours, then hours. */
const minutes = (ms: number): string =>
  ms <= 7_200_000
    ? `${count(Math.round(ms / 60_000))} min`
    : `${(ms / 3_600_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} hours`;

/** A token amount at a readable scale: 44.5M, 21K or 830 — never "0.0M". */
export function tokenAmount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return count(Math.round(value));
}

/** A byte size at a readable scale: 1.2 MB, 62 KB or 830 bytes. */
export function byteAmount(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1_024) return `${Math.round(value / 1_024)} KB`;
  return `${count(value)} bytes`;
}

/** A byte size in 1,024-based units, labelled as such: 9.4 MiB, 62 KiB or 830 bytes. */
export function byteAmountIEC(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MiB`;
  if (value >= 1_024) return `${Math.round(value / 1_024)} KiB`;
  return `${count(value)} bytes`;
}

type NotFoundCause = NonNullable<CardToolCall["cause"]>;

/** Each missing-path cause as a fact label and in a sentence; the order breaks count ties. */
export const NOT_FOUND_CAUSES: Record<NotFoundCause, { label: string; phrase: string }> = {
  GUESSED_PATH: { label: "Guessed or moved paths", phrase: "guessed or moved" },
  WRONG_WORKTREE: { label: "Paths in the wrong worktree", phrase: "in the wrong worktree" },
  WORKTREE_GONE: {
    label: "Paths in a worktree that no longer exists",
    phrase: "in a worktree that no longer exists",
  },
  OTHER_SCRATCHPAD: {
    label: "Files in another session's scratchpad",
    phrase: "in another session's scratchpad",
  },
  NOT_ON_BRANCH: { label: "Files on another branch", phrase: "on another branch" },
  WRONG_FOLDER: { label: "Right file name, wrong folder", phrase: "in the wrong folder" },
  PROBE: { label: "Deliberate probes (not mistakes)", phrase: "deliberate probes" },
};

/** A call's cause for the card: a deliberate probe is its own bucket, never a "guessed" path. */
export function c2Cause(call: CardToolCall): NotFoundCause | undefined {
  return call.cause === undefined ? undefined : c2IsProbe(call) ? "PROBE" : call.cause;
}

/** The cause a missing-path fix is written for: a gone worktree, then the wrong worktree, then the first. */
export function c2LeadCause(causes: readonly NotFoundCause[]): NotFoundCause {
  return (
    (["WORKTREE_GONE", "WRONG_WORKTREE"] as const).find((cause) => causes.includes(cause)) ??
    causes[0] ??
    "GUESSED_PATH"
  );
}

/** Missing-path lookups per cause, most first; empty when no call was read back. */
export function notFoundCauses(rec: CardActionRecommendation): Array<[NotFoundCause, number]> {
  const counts = new Map<NotFoundCause, number>();
  for (const call of rec.tool_calls ?? []) {
    const cause = c2Cause(call);
    if (cause !== undefined) counts.set(cause, (counts.get(cause) ?? 0) + call.calls);
  }
  const order = Object.keys(NOT_FOUND_CAUSES);
  return [...counts].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));
}

/** "11 guessed or moved, 1 in the wrong worktree". */
export function notFoundByCause(
  causes: Array<[NotFoundCause, number]>,
  total: number | null = null,
): string {
  const listed = causes.map(([cause, n]) => `${count(n)} ${NOT_FOUND_CAUSES[cause].phrase}`);
  // U9: the causes sum to the lookups; calls whose input is in no transcript are said so.
  const unread = total === null ? 0 : total - causes.reduce((sum, [, n]) => sum + n, 0);
  if (unread > 0)
    listed.push(`${count(unread)} not found in any transcript, so their cause is unknown`);
  return listed.join(", ");
}

/**
 * U9 r5: a search aimed at a folder whose own name says it is absent (`.audits-none`) is a probe
 * Claude made on purpose, not a wrong path. Only a name that says so counts; a guess does not.
 */
const C2_PROBE_NAME = /[-_.](?:none|nonexistent|missing|absent|nope)$/i;

/** The folder a search call aimed at (its target reads "pattern in folder"). */
export function c2Folder(call: CardToolCall | undefined): string {
  const target = call?.target ?? "";
  return target.slice(target.lastIndexOf(" in ") + 4);
}

function c2IsProbe(call: CardToolCall): boolean {
  if (call.kind !== "search" || !call.target.includes(" in ")) return false;
  const folder = c2Folder(call);
  return C2_PROBE_NAME.test(folder.slice(folder.lastIndexOf("/") + 1));
}

export function c2ProbeCalls(calls: readonly CardToolCall[]): CardToolCall[] {
  return calls.filter(c2IsProbe);
}

/**
 * U9 r7: the cause(s) behind most of the lookups read back, leaving out deliberate probes (they
 * are not mistakes) and the lookups that could not be read back (their cause is unknown). More than
 * one cause with the top count is a tie, said as a tie rather than crowning the first.
 */
export function notFoundLead(rec: CardActionRecommendation): {
  causes: NotFoundCause[];
  n: number;
  read: number;
  basis: string;
} | null {
  const calls = rec.tool_calls ?? [];
  const probes = new Set(c2ProbeCalls(calls));
  const counts = new Map<NotFoundCause, number>();
  let read = 0;
  let probed = 0;
  for (const call of calls) {
    if (call.cause === undefined) continue;
    if (probes.has(call)) {
      probed += call.calls;
      continue;
    }
    counts.set(call.cause, (counts.get(call.cause) ?? 0) + call.calls);
    read += call.calls;
  }
  const n = Math.max(0, ...counts.values());
  if (n === 0) return null;
  const order = Object.keys(NOT_FOUND_CAUSES);
  const causes = [...counts]
    .filter(([, k]) => k === n)
    .map(([cause]) => cause)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const basis = `${count(read)} lookups read back${probed > 0 ? `, not counting ${count(probed)} deliberate probe${probed === 1 ? "" : "s"}` : ""}`;
  return { causes, n, read, basis };
}

/** A missing-path card's lookups and sessions: the stored totals. */
export function notFoundTotals(rec: CardActionRecommendation): {
  lookups: number | null;
  sessions: number;
} {
  return {
    lookups: numberMetric(rec, "ERROR_COUNT"),
    sessions: numberMetric(rec, "SESSION_COUNT") ?? sessionTotal(rec),
  };
}

export function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${count(n)} times`;
}

/** A scratch or output file: read once for one task, so never the lasting change to lead with. */
export const SCRATCH_FILE = /\/(temp|tmp|scratchpad)\//i;

/** The call group a tool-result card fixes: the first that is not a scratch file, else the first. */
export function leadCall<T extends CardToolCall>(calls: readonly T[]): T | undefined {
  return calls.find((call) => !SCRATCH_FILE.test(call.target)) ?? calls[0];
}

/**
 * Oversized bytes per tool, counting only targets called at least twice (a one-off is not a habit
 * to change): "Read 9.1 MB and Bash 1.2 MB", or null when no target repeats.
 */
export function repeatedBytesByTool(calls: readonly CardToolCall[]): string | null {
  const byTool = new Map<string, number>();
  for (const call of calls) {
    if (call.calls >= 2) byTool.set(call.tool, (byTool.get(call.tool) ?? 0) + call.total_bytes);
  }
  const parts = [...byTool]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, bytes]) => `${tool} ${byteAmount(bytes)}`);
  if (parts.length === 0) return null;
  const last = parts.pop() as string;
  return parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
}

/**
 * A file sessions read to look something up (a doc or plan), not code they change. Only these get
 * the CLAUDE.md-pointer advice; edits happen in worktree copies, so a source file's reads cannot be
 * matched to its edits (review 3 B1).
 */
export function isLookupFile(call: CardToolCall): boolean {
  return call.kind === "file" && /\.(md|mdx|txt|rst)$/i.test(call.target);
}

/** A program source file (review 5 residual): not a look-up doc, and not data such as JSON. */
function isSourceFile(call: CardToolCall): boolean {
  return (
    call.kind === "file" &&
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|rb|php|c|cc|cpp|h|hpp|swift|kt|sh|ps1|css|scss|vue|svelte)$/i.test(
      call.target,
    )
  );
}

/** D6 reads the targets of this many of the largest results in its largest sessions (U9 r3). */
export const D6_TARGET_EVENTS = 400;

/** A card lists at most this many call groups. */
const MAX_LISTED_CALLS = 8;

/** The call groups a tool-result card lists: the lead first, the rest in their ranked order. */
export function listedCalls(calls: readonly CardToolCall[]): CardToolCall[] {
  const lead = leadCall(calls);
  return (lead === undefined ? [] : [lead, ...calls.filter((call) => call !== lead)]).slice(
    0,
    MAX_LISTED_CALLS,
  );
}

/** One oversized-call group in plain words: what ran, how often, and how big the results were. */
export function callLine(call: CardToolCall): string {
  return `\`${call.target}\`: ${callUsage(call)}`;
}

/**
 * Review 5 M19: a call group entirely inside subagents; `oversizedToolCalls` sets the field.
 */
function isSubagentCall(call: CardToolCall): boolean {
  return call.is_subagent === true;
}

/** How a call group ran: "read whole 15 times in 13 sessions, up to 56 KB each, 632 KB in total". */
export function callUsage(call: CardToolCall): string {
  const subagent = isSubagentCall(call) ? " (subagent)" : "";
  const where =
    call.session_count === 1 ? "in 1 session" : `in ${count(call.session_count)} sessions`;
  // A call read back from an evidence anchor: what it returned matters, not its size.
  if (call.result !== undefined) {
    const said = call.result === "" ? "" : `, returned "${call.result}"`;
    return `${call.tool}, ${times(call.calls)} ${where}${said}${subagent}`;
  }
  // No recorded size (0) is unknown, not empty: early ingests did not store it.
  const size =
    call.max_bytes <= 0
      ? ""
      : call.calls === 1
        ? `, ${byteAmount(call.max_bytes)}`
        : `, up to ${byteAmount(call.max_bytes)} each, ${byteAmount(call.total_bytes)} in total`;
  const how =
    call.kind === "file"
      ? call.tool === "Read"
        ? call.whole_file
          ? "read whole"
          : "read in parts"
        : call.tool === "Write"
          ? "written"
          : "edited"
      : call.kind === "command"
        ? `run (${call.tool})`
        : call.kind === "url"
          ? "fetched"
          : `called (${call.tool})`;
  return `${how} ${times(call.calls)} ${where}${size}${subagent}`;
}

function errorRate(errors: number | null, calls: number | null): string | null {
  if (errors === null || calls === null || calls <= 0) return null;
  return `${count(errors)} of ${count(calls)} calls (${percentOf(errors / calls)})`;
}

/** The measured facts behind a finding, from the detector's stored evidence. */
function detectorFacts(rec: CardActionRecommendation): CardTriggerFact[] {
  const facts: Array<CardTriggerFact | null> = [];
  if (rec.detector_id === "D1") {
    const source = numberMetric(rec, "source_tokens");
    const target = numberMetric(rec, "source_target");
    const turns = numberMetric(rec, "turns_per_week");
    const workspaces = numberMetric(rec, "workspace_multiplier");
    const topWorkspaceTurns = numberMetric(rec, "top_workspace_turns");
    const delta = numberMetric(rec, "delta_context_tokens");
    facts.push(
      source === null || target === null
        ? null
        : { label: "File size", value: `${count(source)} tokens (target ${count(target)})` },
      turns === null ? null : { label: "Loaded on", value: `${count(turns)} turns per week` },
      workspaces === null
        ? null
        : {
            label: "Workspaces",
            value:
              topWorkspaceTurns !== null && turns !== null && workspaces > 1
                ? `${count(workspaces)} (${count(topWorkspaceTurns)} of ${count(turns)} turns in one)`
                : count(workspaces),
          },
      delta === null || turns === null
        ? null
        : {
            label: "Extra tokens per week",
            value: `about ${tokenAmount(delta * turns)}`,
          },
    );
  } else if (rec.detector_id === "A1") {
    const events = numberMetric(rec, "EVENT_COUNT");
    const largest = numberMetric(rec, "MAX_RESULT_BYTES");
    const total = numberMetric(rec, "RESULT_BYTES_TOTAL");
    const byTool = repeatedBytesByTool(rec.tool_calls ?? []);
    // Review 6 R6-03 (legacy rows): the rank then priced the lead target only. Since U7 the rank
    // covers every large result and the metric is no longer emitted, so this fact stays hidden.
    const allCarry = numberMetric(rec, "ALL_RESULTS_CARRY_U_PER_WK");
    facts.push(
      total === null
        ? null
        : {
            label: "Total size",
            value: `${byteAmount(total)}${events === null ? "" : ` in ${count(events)} result${events === 1 ? "" : "s"} over 25 KB`}`,
          },
      largest === null ? null : { label: "Largest result", value: byteAmount(largest) },
      byTool === null ? null : { label: "By tool, targets repeated 2+ times", value: byTool },
      allCarry === null || rec.savings_u_per_wk === undefined || allCarry <= rec.savings_u_per_wk
        ? null
        : { label: "All large results", value: `${dollars(allCarry)}/wk` },
    );
  } else if (rec.detector_id === "D11") {
    for (const tool of [
      stringMetric(rec, "higher_error_tool"),
      stringMetric(rec, "preferred_tool"),
    ]) {
      if (tool === null) continue;
      const key = tool.toLowerCase();
      const rate = errorRate(
        numberMetric(rec, `${key}_error_count`),
        numberMetric(rec, `${key}_call_count`),
      );
      const ratio = numberMetric(rec, `${key}_error_ratio`);
      const value = rate ?? (ratio === null ? null : percentOf(ratio));
      // Review 5: only shell-caused failures count, so the label says so (not C1's all-failure rate).
      facts.push(value === null ? null : { label: `Shell-caused failures in ${tool}`, value });
    }
  } else if (rec.detector_id === "B1" || rec.detector_id === "B2") {
    const prev = numberMetric(rec, "PREVIOUS_CACHE_READ_TOKENS");
    const curr = numberMetric(rec, "CURRENT_CACHE_READ_TOKENS");
    const gap = numberMetric(rec, "GAP_DURATION_MS");
    facts.push(
      prev === null || curr === null
        ? null
        : {
            label:
              rec.detector_id === "B2"
                ? numberMetric(rec, "RESUME_COUNT") === null
                  ? "Cache reads, summed over resumes"
                  : `Cache reads, summed over ${count(numberMetric(rec, "RESUME_COUNT") ?? 0)} resumes`
                : (numberMetric(rec, "COLLAPSE_EVENT_COUNT") ?? 1) > 1
                  ? `Cache reads, summed over ${count(numberMetric(rec, "COLLAPSE_EVENT_COUNT") ?? 0)} breaks`
                  : "Cache reads",
            value: `${tokenAmount(prev)} → ${tokenAmount(curr)}`,
          },
      rec.detector_id === "B2" && gap !== null
        ? { label: "Longest break", value: minutes(gap) }
        : null,
    );
  } else if (rec.detector_id === "B3" || rec.detector_id === "B4") {
    const creation = numberMetric(rec, "CURRENT_CACHE_CREATION_TOKENS");
    const base = numberMetric(rec, "BASE_PREFIX_TOKENS");
    // U9: B4 is one finding per workspace; older per-event rows lack these.
    const events = numberMetric(rec, "EVENT_COUNT");
    const rewrite = numberMetric(rec, "REWRITE_COST_U");
    const search = numberMetric(rec, "TOOLSEARCH_EVENT_COUNT");
    facts.push(
      events === null ? null : { label: "Breaks", value: count(events) },
      creation === null ? null : { label: "Tokens written again", value: tokenAmount(creation) },
      rewrite === null ? null : { label: "Paid over cache reads", value: dollars(rewrite) },
      search === null || events === null
        ? null
        : { label: "Right after a ToolSearch call", value: `${count(search)} of ${count(events)}` },
      base === null ? null : { label: "Fresh-session start", value: tokenAmount(base) },
    );
  } else if (rec.detector_id === "D8") {
    const events = numberMetric(rec, "churn_event_count");
    const creation = numberMetric(rec, "total_churn_creation_tokens");
    const net = numberMetric(rec, "net_churn_creation_tokens");
    const longest = numberMetric(rec, "longest_gap_min");
    // Review 5 U4: one number per fact; the session count stays in what's wrong only.
    facts.push(
      longest === null
        ? null
        : { label: "Longest break before a resume", value: minutes(longest * 60_000) },
      events === null ? null : { label: "Resumes after cache expiry", value: count(events) },
      creation === null ? null : { label: "Written again", value: tokenAmount(creation) },
      net === null ? null : { label: "Net of a fresh start", value: tokenAmount(net) },
    );
  } else {
    facts.push(...moreFacts(rec));
  }
  return facts.filter((fact): fact is CardTriggerFact => fact !== null);
}

/** A fact from one stored number, or null when the detector did not record it. */
function fact(
  label: string,
  value: number | null,
  format: (value: number) => string = count,
): CardTriggerFact | null {
  return value === null ? null : { label, value: format(value) };
}

/** Facts for the context, errors, permissions and routing cards (R3.1). */
function moreFacts(rec: CardActionRecommendation): Array<CardTriggerFact | null> {
  const n = (key: string) => numberMetric(rec, key);
  const tokens = (value: number) => `${tokenAmount(value)} tokens`;
  switch (rec.detector_id) {
    case "D2": {
      // Review 5 M1: raw re-reads (and their spend), never a cap weight; older rows omit it.
      const spend = n("cache_read_spend_u_per_wk");
      return [
        fact(
          `Sessions over ${D2_TURN_COUNT_THRESHOLD} calls and ${tokenAmount(D2_AVG_CONTEXT_THRESHOLD)} context`,
          n("qualifying_session_count"),
        ),
        fact("Model calls in those sessions", n("qualifying_turn_count")),
        fact("Average context per model call", n("raw_context_average_tokens_per_turn"), tokens),
        fact(
          "Cache re-reads a week",
          n("cache_read_tokens_per_week"),
          (reads) => `${tokens(reads)}${spend === null ? "" : ` (${dollars(spend)})`}`,
        ),
      ];
    }
    case "D4":
      return [
        fact("Opus subagents doing only lookups", n("lookup_subagent_count"), (value) => {
          const all = n("opus_subagent_count");
          return all === null ? count(value) : `${count(value)} of ${count(all)}`;
        }),
        fact("Their turns", n("mismatch_turns_per_week"), (value) => `${count(value)} a week`),
        fact(
          "All Opus subagent turns",
          n("total_opus_turns_per_week"),
          (value) => `${count(value)} a week`,
        ),
        fact("Average output", n("avg_output_tokens"), (value) => tokens(Math.round(value))),
      ];
    case "D6":
      return [
        fact("Sessions", n("session_count")),
        fact("Tool results", n("tool_result_bytes"), byteAmountIEC),
        // U7: the share is the results' carry cost over those sessions' spend.
        // U9 r4: what re-sending cost, not what a fix would save.
        fact(
          "Re-send cost as a share of those sessions' spend (modeled, not a saving)",
          n("bloat_share"),
          percentOf,
        ),
        // U9: the tool behind most of the bytes.
        fact("From Read", n("read_result_bytes"), (value) => {
          const total = n("tool_result_bytes");
          return `${byteAmountIEC(value)}${total === null || total <= 0 ? "" : ` (${percentOf(value / total)})`}`;
        }),
      ];
    case "D7": {
      if (n("redundant_path_count") !== null) {
        const calls = rec.tool_calls ?? [];
        const lookup = calls.find(isLookupFile);
        const mostSessions = n("max_path_session_count");
        return [
          fact("Files read again in later sessions", n("redundant_path_count")),
          fact("Reads, one per session", n("total_redundant_read_count")),
          fact("Size of those results", n("total_redundant_result_bytes"), byteAmount),
          // Review 5 M14: names the file, not just its session count (review 3 B1: one per session).
          lookup !== undefined
            ? {
                label: "Most-read look-up file",
                value: `\`${lookup.target}\` (${count(lookup.session_count)} sessions)`,
              }
            : calls.length === 0 && mostSessions !== null
              ? { label: "Most-read file", value: `${count(mostSessions)} sessions` }
              : null,
        ];
      }
      return [
        fact("Turns repeating calls", n("loop_flagged_turn_count")),
        fact("Repeated reads", n("redundant_read_event_count")),
        fact("Repeats of the same error", n("error_loop_event_count")),
        fact("Identical calls", n("identical_call_event_count")),
      ];
    }
    case "D10":
      return [
        fact("Tool definitions and descriptions", n("catalog_tokens"), tokens),
        // U7: rows from u7-1 carry removable_tokens (unused items); older rows a fixed target.
        n("removable_tokens") === null
          ? fact("Target", n("catalog_target_tokens"), tokens)
          : fact("In items unused this week", n("removable_tokens"), tokens),
        fact("MCP servers marked alwaysLoad", n("always_load_count")),
      ];
    case "D12":
      return [
        fact("Subagent results returned", n("sidechain_result_bytes"), byteAmount),
        fact("Sessions", n("sidechain_session_count")),
        fact("Subagent turns", n("sidechain_turn_count")),
      ];
    case "D14":
      return [
        fact(
          stringMetric(rec, "INTERRUPT_KIND") === "PURE_INTERRUPT"
            ? "Interrupts"
            : "Calls stopped while running",
          n("INTERRUPT_COUNT"),
        ),
      ];
    case "C1": {
      const errors = n("TOOL_ERROR_COUNT");
      const total = n("TOOL_CALL_COUNT");
      // Review 5 M9: counts and the tools' family on the face; the exact ids are in the prompt.
      const tools = outlierTools(rec);
      const family = mostlyFamily(tools);
      return [
        errors === null || total === null || total <= 0
          ? null
          : {
              label: "Failed calls",
              value:
                tools.length > 1
                  ? `${count(errors)} of ${count(total)} (${percentOf(errors / total)}) across ${count(tools.length)} tools${family === null ? "" : `, mostly ${family}`}`
                  : `${oneToolCalls(rec, errors, total)} (${percentOf(errors / total)})`,
            },
        fact("Rate across all tool calls", n("CORPUS_ERROR_RATE"), percentOf),
        fact("Expected at the all-tool rate", expectedFailures(rec), expectedText),
      ];
    }
    case "C2": {
      const { lookups, sessions } = notFoundTotals(rec);
      return [
        fact(
          "Missing-path lookups",
          lookups,
          (value) => `${count(value)} in ${count(sessions)} session${sessions === 1 ? "" : "s"}`,
        ),
        ...notFoundCauses(rec).map(([cause, calls]) => ({
          label: NOT_FOUND_CAUSES[cause].label,
          value: count(calls),
        })),
      ];
    }
    case "C7":
      return [
        fact(
          "Failed commands",
          n("BASH_FAILURE_COUNT"),
          (value) => `${count(value)} ${commandFamily(stringMetric(rec, "BASH_COMMAND_FAMILY"))}`,
        ),
      ];
    case "C9": {
      const denialClass = stringMetric(rec, "DENIAL_CLASS");
      if (denialClass === "HOOK_BLOCK") {
        // Review 5 M7: split once the blocks have a guard version; older rows keep the one fact.
        const split = c9BlockSplit(guardVersions(rec.tool_calls ?? []), n("DENIAL_COUNT"));
        if (split !== null) {
          return [
            fact("Calls your guard blocked", split.total),
            fact("Harmless blocks to fix", split.fp),
            fact("Blocked as intended", split.a),
          ];
        }
        return [fact("Calls your guard blocked", n("DENIAL_COUNT"))];
      }
      const label =
        denialClass === "USER_REJECTED" ? "Calls you rejected" : "Calls a deny rule blocked";
      return [fact(label, n("DENIAL_COUNT"))];
    }
    case "H1": {
      const runs = n("OPERATION_COUNT");
      const rated = riskyRuns(rec);
      return [
        { label: "Command", value: operationName(stringMetric(rec, "DESTRUCTIVE_OPERATION")) },
        fact("Runs", runs),
        // U7: subagent runs beside the main-chain count; they do not make the card fire.
        ...((n("SIDECHAIN_OPERATION_COUNT") ?? 0) > 0
          ? [fact("Subagent runs (not counted above)", n("SIDECHAIN_OPERATION_COUNT"))]
          : []),
        ...(rated === null
          ? []
          : [
              {
                label: "Risky runs",
                value: `${count(rated.risky)} of ${count(rated.readBack)}${runs !== null && rated.readBack < runs ? " read back" : ""}`,
              },
            ]),
      ];
    }
    case "A2":
      return [
        fact("Results over 10 KB", n("EVENT_COUNT")),
        fact("Largest result", n("MAX_RESULT_BYTES"), byteAmount),
        fact("Total size", n("RESULT_BYTES_TOTAL"), byteAmount),
      ];
    case "E1": {
      const long = n("SESSIONS_OVER_P75");
      const editing = n("EDITING_SESSIONS");
      return [
        long === null || editing === null
          ? null
          : { label: "Sessions with a long start", value: `${count(long)} of ${count(editing)}` },
        fact("Typical turns before the first edit", n("PRE_EDIT_P50")),
        fact("Extra turns in the long starts", n("EXCESS_TURNS")),
        fact("Cost of those turns", n("EXCESS_COST_U"), dollars),
      ];
    }
    case "E2":
      return [
        fact("Routine runs on the main model", n("RUNS")),
        fact("Turns in them", n("RUN_TURNS")),
        fact("Sessions with runs", n("RUN_SESSIONS")),
        fact("Cost of those turns", n("RUN_COST_U"), dollars),
        fact("Same turns handed to a Sonnet subagent", n("SUBAGENT_COST_U"), dollars),
      ];
    default:
      return [];
  }
}

/** U9: the measured cause of B1/B4 breaks, or "not known" when no ToolSearch preceded them. */
function prefixBreakCause(rec: CardActionRecommendation, eventsKey: string, searchKey: string) {
  const events = numberMetric(rec, eventsKey);
  const search = numberMetric(rec, searchKey);
  if (events === null || search === null) return "";
  if (search === 0)
    return " The recorded data does not show the cause: no ToolSearch call came right before them.";
  const firstLoad = numberMetric(rec, "FIRST_MCP_LOAD_COUNT");
  const calls = numberMetric(rec, "SESSION_TOOLSEARCH_CALLS");
  const others = calls !== null && calls > search ? calls - search : 0;
  return ` Measured pattern: ${count(search)} of ${count(events)} came on the turn right after a ToolSearch call${firstLoad !== null && firstLoad > 0 ? `, ${firstLoad === search ? "all of them" : `${count(firstLoad)} of them`} before the session had called any MCP tool` : ""}${others > 0 ? `; ${count(others)} other ToolSearch call${others === 1 ? "" : "s"} in those sessions did not break the cache` : ""}. That is a pattern, not a proven cause. Trying the tools loaded once at the start of the task, while the conversation is small, would make any such rewrite small.`;
}

/** Cache cards: why the cache was lost, and what the fix changes. */
function cacheProblem(rec: CardActionRecommendation): string | null {
  const prev = numberMetric(rec, "PREVIOUS_CACHE_READ_TOKENS");
  const curr = numberMetric(rec, "CURRENT_CACHE_READ_TOKENS");
  const creation = numberMetric(rec, "CURRENT_CACHE_CREATION_TOKENS");
  const gap = numberMetric(rec, "GAP_DURATION_MS");
  switch (rec.detector_id) {
    case "B1":
      if (prev === null || curr === null) return null;
      {
        const events = numberMetric(rec, "COLLAPSE_EVENT_COUNT");
        const rewrite = numberMetric(rec, "REWRITE_COST_U");
        // U9 r4: ten breaks are not one drop; the sums are over the breaks.
        if (events !== null && events > 1 && creation !== null)
          return `${count(events)} mid-session cache breaks: on turns sent while the cache was still alive, Claude Code wrote the conversation again (${tokenAmount(creation)} tokens${rewrite === null ? "" : `, ${dollars(rewrite)} more than reading them from cache`}). Summed over the ${count(events)} breaks, cache reads fell from ${tokenAmount(prev)} to ${tokenAmount(curr)} tokens; that is not one drop.${prefixBreakCause(rec, "COLLAPSE_EVENT_COUNT", "TOOLSEARCH_COLLAPSE_COUNT")}`;
      }
      return `Cache reads fell from ${tokenAmount(prev)} to ${tokenAmount(curr)} tokens on turns sent while the cache was still alive, so Claude Code wrote the conversation again.${prefixBreakCause(rec, "COLLAPSE_EVENT_COUNT", "TOOLSEARCH_COLLAPSE_COUNT")}`;
    case "B4": {
      if (creation === null) return null;
      const events = numberMetric(rec, "EVENT_COUNT") ?? 1;
      const rewrite = numberMetric(rec, "REWRITE_COST_U");
      return `${count(events)} mid-session cache break${events === 1 ? "" : "s"} made Claude Code write ${tokenAmount(creation)} tokens of context again${rewrite === null ? "" : `, ${dollars(rewrite)} more than reading them from cache`}.${prefixBreakCause(rec, "EVENT_COUNT", "TOOLSEARCH_EVENT_COUNT")}`;
    }
    case "B2": {
      if (gap === null || prev === null || curr === null) return null;
      const sessions = sessionTotal(rec);
      const where = sessions > 1 ? ` in ${count(sessions)} sessions` : "";
      // F26: the lifetime is the thread's own (5 minutes on a 5m-tier thread), not always an hour.
      const ttl = numberMetric(rec, "CONSERVATIVE_TTL_DURATION_MS");
      const resumes = numberMetric(rec, "RESUME_COUNT");
      const lead =
        resumes === null
          ? "Work resumed after breaks past the cache lifetime"
          : `${count(resumes)} resume${resumes === 1 ? "" : "s"} came after a break past the cache lifetime`;
      return `${lead}${where}; the longest break was ${minutes(gap)}${ttl === null ? "" : ` (cache lifetime ${minutes(ttl)})`}. Cache reads on the resumed turns fell from ${tokenAmount(prev)} to ${tokenAmount(curr)} tokens, summed over those resumes, so the whole context was written again. Before a long break, /clear if the next task is new, or write a handoff and then /clear if it continues.`;
    }
    case "B3": {
      const base = numberMetric(rec, "BASE_PREFIX_TOKENS");
      if (gap === null || creation === null) return null;
      return `A new session started ${minutes(gap)} after the previous one and wrote ${tokenAmount(creation)} tokens${base === null ? "" : ` (a fresh start here is about ${tokenAmount(base)})`}, about the size of the context the previous session ended with. Reopening the previous session would have read its warm cache instead.`;
    }
    case "D8": {
      const events = numberMetric(rec, "churn_event_count");
      const total = numberMetric(rec, "total_churn_creation_tokens");
      const sessions = numberMetric(rec, "session_count");
      if (events === null || total === null) return null;
      const listed = sessions === null ? null : listedOf(rec, sessions);
      const longest = numberMetric(rec, "longest_gap_min");
      const example =
        longest === null ? "" : ` The longest break before one was ${minutes(longest * 60_000)}.`;
      const base = numberMetric(rec, "base_prefix_tokens");
      const net = numberMetric(rec, "net_churn_creation_tokens");
      // Only D8's own main-thread resumes; B2's summed one-hour breaks are another set (review 3 B6).
      const netting =
        base === null || net === null
          ? ""
          : ` Only part of that is avoidable: ${tokenAmount(total)} written again − ${tokenAmount(total - net)} a fresh start would write anyway (the ${tokenAmount(base)} base prompt, for each of the ${count(events)} resumes) = ${tokenAmount(net)} net.`;
      // The rule the detector applies: the break outlasted the cache lifetime of that thread's own
      // write tier, reads were under 20% of the write, and the write cost at least 0.1% of the
      // workspace's week of spend (a fixed 50K-token floor applies only when spend is unknown).
      const hour = numberMetric(rec, "gap_60_240_min_count");
      const long = numberMetric(rec, "gap_240_plus_min_count");
      const shortGaps =
        (numberMetric(rec, "gap_5_15_min_count") ?? 0) +
        (numberMetric(rec, "gap_15_60_min_count") ?? 0);
      const breaks =
        hour === null || long === null
          ? ""
          : ` Breaks: ${count(hour)} of 1 to 4 hours, ${count(long)} of 4 hours or more${shortGaps > 0 ? `, ${count(shortGaps)} of under an hour (a 5-minute cache)` : ""}.`;
      return `${count(events)} main-conversation turns${sessions === null ? "" : ` in ${count(sessions)} sessions${listed === null ? "" : ` (${listed} listed)`}`} came after the prompt cache had expired, read under ${pct0(D8_LOW_READ_RATIO)} of what they wrote, and each write cost at least ${D8_EVENT_FLOOR_PCT}% of this workspace's 7-day spend (${tokenAmount(total)} tokens written again in total).${netting}${breaks}${example}`;
    }
    default:
      return null;
  }
}

const dollars = (u: number): string => `$${(u / 1e6).toFixed(2)}`;

/** D2's saving net of what the suggested splits write again (P3.1-T9 S6), or "" on older rows. */
function splitNetting(rec: CardActionRecommendation): string {
  const gross = numberMetric(rec, "gross_savings_u_per_wk");
  const rebuild = numberMetric(rec, "rebuild_u_per_wk");
  const splits = numberMetric(rec, "suggested_split_count");
  const base = numberMetric(rec, "base_prefix_tokens");
  const summary = numberMetric(rec, "summary_tokens");
  if (gross === null || rebuild === null || splits === null || base === null || summary === null) {
    return "";
  }
  const net = dollars(Math.max(0, gross - rebuild));
  const rebuilt = `${dollars(rebuild)} is what ${count(splits)} splits × (${tokenAmount(base)} base + ${tokenAmount(summary)} summary) write again at these sessions' cache-write price; one split for every ${D2_CALLS_PER_SPLIT} model calls after the first, in each session, and a ${tokenAmount(summary)} summary are assumptions.`;
  // Review 3 B5: the derivation is on the card, the fraction measured from context growth.
  const spend = numberMetric(rec, "cache_read_spend_u_per_wk");
  const fraction = numberMetric(rec, "reduction_fraction");
  if (spend === null || fraction === null)
    return ` Estimated saving: ${dollars(gross)} − ${dollars(rebuild)} = ${net} a week, where ${rebuilt}`;
  const share = `${(fraction * 100).toFixed(1)}%`;
  return ` Estimated saving: ${dollars(spend)} of re-reads × ${share} that splits avoid = ${dollars(gross)}, − ${dollars(rebuild)} to rebuild = ${net} a week. The ${share} is modelled on these sessions: after a split, each later call re-reads the ${tokenAmount(base)} base and ${tokenAmount(summary)} summary plus what it added since, not the whole history. ${rebuilt}`;
}

/**
 * U9 r3: what D2 measured about task boundaries. It looks for commits in the sessions (tool events
 * with a commit sha); branch changes and file switches are not measured.
 */
/**
 * U9 r6: what D2 measured per session (it measures no task boundaries): model calls, average and
 * peak context, and the call on which context first passed the qualifying threshold.
 */
export function d2SessionLines(rec: CardActionRecommendation): string[] {
  const raw = rec.evidence?.session_stats ?? rec.facts?.session_stats;
  if (!Array.isArray(raw)) return [];
  const lines: string[] = [];
  for (const label of raw) {
    if (typeof label !== "string") continue;
    const [id, calls, avg, peak, first] = label.split("|");
    const [nCalls, nAvg, nPeak, nFirst] = [calls, avg, peak, first].map(Number);
    if (!id || [nCalls, nAvg, nPeak, nFirst].some((n) => n === undefined || !Number.isFinite(n)))
      continue;
    lines.push(
      `${id}: ${count(nCalls as number)} model calls, ${tokenAmount(nAvg as number)} average context, ${tokenAmount(nPeak as number)} peak${nFirst === 0 ? "" : `; context first passed ${tokenAmount(D2_AVG_CONTEXT_THRESHOLD)} on call ${count(nFirst as number)}`}`,
    );
  }
  return lines;
}

function d2Boundaries(rec: CardActionRecommendation): string {
  const sessionLines = d2SessionLines(rec);
  const measured =
    sessionLines.length === 0
      ? ""
      : ` Measured per session (most calls first): ${sessionLines.join("; ")}.`;
  const commits = numberMetric(rec, "commit_boundary_count");
  if (commits === null) return measured;
  return `${measured}${d2BoundaryText(rec, commits)}`;
}

function d2BoundaryText(rec: CardActionRecommendation, commits: number): string {
  const anchored = numberMetric(rec, "commit_anchored_splits") ?? 0;
  const git = numberMetric(rec, "git_command_count");
  // U9 r4: no harvested sha is not "no commits": git commands may have run without exposing one.
  const none =
    git !== null && git > 0
      ? `No commit SHAs could be read from these sessions (${count(git)} git command${git === 1 ? "" : "s"} ran, so commits may have happened)`
      : "No commits were recorded in these sessions";
  return commits === 0
    ? ` ${none}, so the estimate spaces its splits evenly (one per ${D2_CALLS_PER_SPLIT} model calls), which is an assumption and not task boundaries found in your sessions; branch changes and file switches are not measured.`
    : ` ${count(commits)} commit${commits === 1 ? "" : "s"} were recorded in these sessions, and ${count(anchored)} of the estimate's splits sit on one; the rest are spaced evenly (one per ${D2_CALLS_PER_SPLIT} model calls). Branch changes and file switches are not measured.`;
}

/** Context cards other than D1: what is filling the context, and what the fix changes. */
function contextProblem(rec: CardActionRecommendation): string | null {
  if (rec.detector_id === "A1") {
    const events = numberMetric(rec, "EVENT_COUNT");
    const largest = numberMetric(rec, "MAX_RESULT_BYTES");
    const total = numberMetric(rec, "RESULT_BYTES_TOTAL");
    if (events === null || largest === null || total === null) return null;
    const calls = events === 1 ? "call" : "calls";
    const byTool = repeatedBytesByTool(rec.tool_calls ?? []);
    const split =
      byTool === null ? "" : `. By tool, counting targets repeated at least twice: ${byTool}`;
    const lead = leadCall(rec.tool_calls ?? []);
    const biggest = [...(rec.tool_calls ?? [])]
      .filter((call) => !SCRATCH_FILE.test(call.target))
      .sort((a, b) => b.total_bytes - a.total_bytes)[0];
    // The lead is ranked by what its re-sends cost, so it need not be the largest group by bytes.
    const main =
      lead === undefined
        ? ""
        : `. The one to fix first is ${callLine(lead)}${biggest !== undefined && biggest !== lead && biggest.total_bytes > lead.total_bytes ? `. It comes first because the card ranks groups by what re-sending them costs, not by size; the largest group by total size is ${callLine(biggest)}` : ""}`;
    // U9 r5: the dollars cover every large result, so say how they are worked out and how much of
    // the avoidable bytes (those above the 25 KB line) the lead group holds.
    const above = total - events * A1_RESULT_BYTES_THRESHOLD;
    const leadAbove =
      lead === undefined
        ? 0
        : Math.max(0, lead.total_bytes - lead.calls * A1_RESULT_BYTES_THRESHOLD);
    const worked = ` The saving is worked out per result: bytes above 25 KB ÷ 2.7 bytes per token × 50% assumed avoidable × the price of one cache write plus a cache read on each later turn the result stays in context (at most 75). It covers all ${count(events)} results${lead !== undefined && above > 0 ? `; the group to fix first holds ${byteAmount(leadAbove)} of the ${byteAmount(above)} above the 25 KB line (${percentOf(leadAbove / above)})` : ""}.`;
    // U7: A1 prices each result along its own chain; a subagent's read is re-sent on that
    // subagent's later turns, not the main conversation's.
    return `${count(events)} successful tool ${calls} returned more than 25 KB each, ${byteAmount(total)} in total (largest ${byteAmount(largest)})${split}${main}. Each result stays in context and is re-sent on every later turn until /clear, compaction or Claude Code's tool-result clearing drops it. A read inside a subagent is re-sent on that subagent's later turns until it finishes. Asking for only the part you need keeps that cost out.${worked}`;
  }
  if (rec.detector_id === "D2") {
    const sessions = numberMetric(rec, "qualifying_session_count");
    const turns = numberMetric(rec, "qualifying_turn_count");
    const average = numberMetric(rec, "raw_context_average_tokens_per_turn");
    // Review 5 M1: raw re-reads, no cap weight (Anthropic has not published one; see Why).
    const reads = numberMetric(rec, "cache_read_tokens_per_week");
    if (sessions === null || turns === null || average === null) return null;
    return `${count(sessions)} sessions ran more than ${D2_TURN_COUNT_THRESHOLD} model calls each with more than ${tokenAmount(D2_AVG_CONTEXT_THRESHOLD)} tokens of context per call on average (${count(turns)} model calls in total, counting each tool step; ${tokenAmount(average)} average).${reads === null ? "" : ` These sessions re-read ${tokenAmount(reads)} cached tokens a week.`} Starting a fresh session at each task boundary (a commit, a branch change, or a switch to unrelated files), with a short handoff carried over, resets that.${d2Boundaries(rec)}${splitNetting(rec)}`;
  }
  if (rec.detector_id === "A2") {
    const events = numberMetric(rec, "EVENT_COUNT");
    const largest = numberMetric(rec, "MAX_RESULT_BYTES");
    const total = numberMetric(rec, "RESULT_BYTES_TOTAL");
    if (events === null || largest === null || total === null) return null;
    // U7: TaskOutput returns a background agent's result or a background shell command's output.
    return `${count(events)} background-task ${events === 1 ? "result" : "results"} (TaskOutput) came back into the main conversation at more than 10 KB each (largest ${byteAmount(largest)}, ${byteAmount(total)} in total). Each stays in context and is re-sent on every later turn. Having an agent write its detail to a file and return a short summary, or sending a background command's output to a log file and reading only the lines you need, keeps that out.`;
  }
  if (rec.detector_id === "D6") {
    const sessions = numberMetric(rec, "session_count");
    const bytes = numberMetric(rec, "tool_result_bytes");
    const share = numberMetric(rec, "bloat_share");
    if (sessions === null || bytes === null) return null;
    const read = numberMetric(rec, "read_result_bytes");
    const readPart =
      read === null || bytes <= 0
        ? ""
        : ` Read returned ${byteAmountIEC(read)} of it (${percentOf(read / bytes)}).`;
    // U9 r3: the other sources, so the share that is not Read is named (Bash is usually second).
    const others = stringArray(rec.facts?.top_tools ?? rec.evidence?.top_tools)
      .map((label) => label.split("|"))
      .filter((parts) => parts.length === 3 && parts[0] !== "Read")
      .slice(0, 2)
      .map(
        ([tool, size, n]) => `${tool} ${byteAmountIEC(Number(size))} in ${count(Number(n))} calls`,
      );
    const otherPart =
      others.length === 0 ? "" : ` The rest came mostly from ${others.join(" and ")}.`;
    // U9 r4: the share is what re-sending cost in total; only part of it is avoidable, so it is not a saving.
    return `In ${count(sessions)} sessions, tool results of up to 25 KB each added up to ${byteAmountIEC(bytes)}${share === null ? "" : `; re-sending them cost about ${Math.round(share * 100)}% of those sessions' spend (modeled). That is what re-sending cost, not what a fix would save`}.${readPart}${otherPart} Each result stays in context and is re-sent on every later turn. Reading only the lines you need and filtering command output keeps that down. This covers ${count(sessions)} sessions, so it is a habit across your work more than a finding about a few sessions; the largest are listed on the card.`;
  }
  if (rec.detector_id === "D10") {
    const tokens = numberMetric(rec, "catalog_tokens");
    const removable = numberMetric(rec, "removable_tokens");
    const target = removable === null ? numberMetric(rec, "catalog_target_tokens") : null;
    if (tokens === null) return null;
    const alwaysLoad = numberMetric(rec, "always_load_count");
    const loads =
      alwaysLoad !== null && alwaysLoad > 0
        ? ` ${count(alwaysLoad)} MCP ${alwaysLoad === 1 ? "server is" : "servers are"} marked alwaysLoad, so their tool definitions are re-sent on every turn.`
        : "";
    const untracked = numberMetric(rec, "skill_use_untracked_count");
    const unseen =
      untracked !== null && untracked > 0
        ? `not seen in tracked skill calls this week (${count(untracked)} older Skill calls have no skill name, so some may have been used)`
        : "with no recorded use this week";
    return `The plugins and skills enabled here add about ${tokenAmount(tokens)} tokens of names and descriptions (MCP tool definitions are not sized)${target === null ? "" : ` (target ${tokenAmount(target)})`}${removable === null ? "" : `; about ${tokenAmount(removable)} of them are in plugins and skills ${unseen}`}.${loads} Disabling what you do not use shrinks the start of every prompt.`;
  }
  return null;
}

function storedSessionIds(rec: CardActionRecommendation): string[] {
  return rec.evidence?.session_ids === undefined
    ? stringArray(rec.facts?.session_ids)
    : stringArray(rec.evidence.session_ids);
}

/** How many sessions the finding covers; the trigger lists some of them. */
export function sessionTotal(rec: CardActionRecommendation): number {
  const ids = new Set([...storedSessionIds(rec), ...listedSessions(rec)]).size;
  // A stored session_count covers sessions past the capped list (review 2 D7b3).
  return Math.max(ids, numberMetric(rec, "session_count") ?? 0);
}

/**
 * The sessions a card and its prompt list (review 3 B8): each shown call group's first session,
 * then the finding's sessions by contribution (`session_rank`, else as stored), up to five unless
 * the call groups alone need more.
 */
export function listedSessions(rec: CardActionRecommendation): string[] {
  // U9 r4: B1/B4 name every session behind their per-break list, costliest first (no cap of five).
  if (rec.detector_id === "B1" || rec.detector_id === "B4") {
    const text = stringMetric(rec, "EVENTS");
    const ranked = text === null ? [] : [...new Set(parseB4Events(text).map((e) => e.session_id))];
    if (ranked.length > 0) return ranked;
  }
  // U9 r7: D8 names up to eight sessions, those with the biggest resumes first (not five).
  if (rec.detector_id === "D8") {
    const raw = rec.facts?.top_resumes ?? rec.evidence?.top_resumes;
    const top = (Array.isArray(raw) ? raw : [])
      .map((item) => (typeof item === "string" ? item.split("|")[0] : undefined))
      .filter((id): id is string => !!id);
    if (top.length > 0) return [...new Set([...top, ...storedSessionIds(rec)])].slice(0, 8);
  }
  const ids = new Set<string>();
  for (const call of shownCalls(rec) ?? []) {
    const first = call.session_ids[0];
    if (first !== undefined) ids.add(first);
  }
  for (const id of [...(rec.session_rank ?? []), ...storedSessionIds(rec)]) {
    if (ids.size >= MAX_LISTED_SESSIONS) break;
    ids.add(id);
  }
  return [...ids];
}

/** How many sessions the card lists when that is fewer than the finding's own total, else null. */
function listedOf(rec: CardActionRecommendation, total: number): number | null {
  const listed = listedSessions(rec).length;
  return listed > 0 && total > listed ? listed : null;
}

/** The command a shell said it does not have ("head"), from a failed call's result. */
export function missingCommand(result: string): string | undefined {
  return (
    /The term '([^']+)' is not recognized/.exec(result)?.[1] ??
    /: ([^\s:]+): command not found/.exec(result)?.[1]
  );
}

/**
 * A shell card's failure rows by the command the shell did not have (review 5 M12): "| head" when
 * the call piped into it, else its name, with the calls of every row it covers merged; a failure
 * of another kind keeps its command. Most calls first.
 */
export function shellFailureRows(calls: readonly CardToolCall[]): CardToolCall[] {
  const rows = new Map<string, CardToolCall>();
  for (const call of calls) {
    const missing = missingCommand(call.result ?? "");
    const piped =
      missing !== undefined &&
      new RegExp(`\\|\\s*${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(call.target);
    const label = missing === undefined ? call.target : piped ? `| ${missing}` : missing;
    const row = rows.get(label);
    if (row === undefined) {
      rows.set(label, { ...call, target: label });
      continue;
    }
    const ids = [...new Set([...row.session_ids, ...call.session_ids])];
    rows.set(label, {
      ...row,
      calls: row.calls + call.calls,
      session_ids: ids.slice(0, 3),
      // A lower bound: the rows' sessions may overlap.
      session_count: Math.max(row.session_count, call.session_count, ids.length),
      total_bytes: row.total_bytes + call.total_bytes,
      max_bytes: Math.max(row.max_bytes, call.max_bytes),
    });
  }
  return [...rows.values()].sort((a, b) => b.calls - a.calls);
}

/** Why a shell call failed, from its first error line: "`head` is not a PowerShell command". */
function shellCause(result: string, shell: string): string {
  const missing = missingCommand(result);
  if (missing !== undefined) return `\`${missing}\` is not a ${shell} command`;
  if (/is not a valid statement separator/.test(result)) return "`&&` is not supported";
  if (/unexpected EOF while looking for matching|missing the terminator/i.test(result))
    return "an unmatched quote";
  return "a command it could not parse";
}

/** The distinct tools behind a card's calls, most calls first: "Bash" or "Agent and Bash". */
export function toolNames(calls: readonly CardToolCall[]): string | null {
  const byTool = new Map<string, number>();
  for (const call of calls) byTool.set(call.tool, (byTool.get(call.tool) ?? 0) + call.calls);
  const names = [...byTool].sort((a, b) => b[1] - a[1]).map(([tool]) => tool);
  if (names.length === 0) return null;
  const last = names.pop() as string;
  return names.length === 0 ? last : `${names.join(", ")} and ${last}`;
}

/** The first sentence of a returned message, without a trailing colon or period. */
export function firstSentence(text: string): string {
  return (text.split(/(?<=\.) /)[0] ?? "").replace(/[:.]$/, "");
}

/** A guard's message without its "PreToolUse:<Tool> hook error:" prefix, first sentence only. */
export function guardMessage(result: string): string {
  return firstSentence(result.replace(/^PreToolUse:\S+ hook error:\s*/i, ""));
}

/** The commands a failing-command cluster ran: "git commands", or "Bash commands". */
export function commandFamily(value: string | null): string {
  const family: Record<string, string> = {
    BASH_GIT: "git",
    BASH_NPM: "npm",
    BASH_PYTHON: "Python",
    BASH_TEST: "test",
    BASH_BUILD: "build",
  };
  return `${family[value ?? ""] ?? "Bash"} commands`;
}

/** The shell commands behind a destructive-operation class; other classes are database statements. */
export const DESTRUCTIVE_COMMANDS: Record<string, string> = {
  RM_RF: "rm -rf",
  GIT_RESET_HARD: "git reset --hard",
  GIT_CLEAN: "git clean",
};

/** An rm -rf card's runs read back, and how many were risky; null when none was rated. */
function riskyRuns(rec: CardActionRecommendation): { risky: number; readBack: number } | null {
  const rated = (rec.tool_calls ?? []).filter((call) => call.risk !== undefined);
  if (rated.length === 0) return null;
  const sum = (calls: CardToolCall[]) => calls.reduce((total, call) => total + call.calls, 0);
  return { risky: sum(rated.filter((call) => call.risk === "RISKY")), readBack: sum(rated) };
}

/**
 * Count floors (operator, review 2): a card needs this much before it is worth showing. The de-minimis
 * floor is 0.2% of the scope's 7-day spend (`deMinimisFloorU`, minor items).
 */
export const FLOORS = {
  /** Blocked or rejected calls in one C9 group. */
  c9Denials: 5,
  /** Guard false positives the current rules still make, per week (operator 2026-09-26, review 4). */
  c9FalsePositivesPerWeek: 3,
};

/** The card's window in weeks; one week when it has none. */
function windowWeeks(rec: CardActionRecommendation): number {
  if (!rec.window) return 1;
  const days = (Date.parse(rec.window.to) - Date.parse(rec.window.from)) / 86_400_000;
  return Number.isFinite(days) && days > 0 ? days / 7 : 1;
}

/**
 * A card below its floor, so not shown (operator, review 2): fewer than five C9 denials; and, once
 * every event was read back, an rm -rf card whose every run deleted a relative path inside the
 * project (H1a), or a guard card with fewer than three false positives a week left to fix (C9g2,
 * review 4). C2's floor is a % of spend, applied by the detector (U7).
 */
export function belowFloor(rec: CardActionRecommendation): boolean {
  if (rec.detector_id === "C9" && (numberMetric(rec, "DENIAL_COUNT") ?? 0) < FLOORS.c9Denials) {
    return true;
  }
  const calls = rec.tool_calls ?? [];
  const readBack = calls.reduce((sum, call) => sum + call.calls, 0);
  if (rec.detector_id === "H1") {
    const runs = numberMetric(rec, "OPERATION_COUNT");
    // A call read back with no recursive `rm` in it only mentions one (a grep pattern), so it is
    // not a run (review 4 prep).
    const rated = calls.filter((call) => call.risk !== undefined);
    const mentions = readBack - rated.reduce((sum, call) => sum + call.calls, 0);
    return (
      runs !== null &&
      rated.length > 0 &&
      readBack >= runs &&
      rated.every((call) => call.risk === "LOW") &&
      runs - mentions > 0
    );
  }
  if (rec.detector_id === "C9" && stringMetric(rec, "DENIAL_CLASS") === "HOOK_BLOCK") {
    const blocks = numberMetric(rec, "DENIAL_COUNT");
    return (
      blocks !== null &&
      calls.length > 0 &&
      readBack >= blocks &&
      calls.every((call) => call.guard_shape !== undefined) &&
      openFalsePositives(guardVersions(calls)).reduce((sum, [, n]) => sum + n, 0) /
        windowWeeks(rec) <
        FLOORS.c9FalsePositivesPerWeek
    );
  }
  return false;
}

/** "1 of the 4 runs", or "1 of the 3 runs read back" when not every run was. */
function ofRuns(rated: { risky: number; readBack: number }, runs: number): string {
  return `${count(rated.risky)} of the ${count(rated.readBack)} runs${rated.readBack < runs ? " read back" : ""}`;
}

/** A destructive-operation class as the user knows it: "rm -rf", or "drop table". */
export function operationName(value: string | null): string {
  return (
    DESTRUCTIVE_COMMANDS[value ?? ""] ??
    (value ?? "destructive operation").toLowerCase().replaceAll("_", " ")
  );
}

/** A share as a percent with one decimal: every card and prompt rounds the same way. */
export const percentOf = (ratio: number): string =>
  `${(ratio * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

/**
 * "80 of 782 PowerShell calls": the tool-error card counts one tool's calls, named from the calls
 * read back (its name is not stored with the finding).
 */
export function oneToolCalls(rec: CardActionRecommendation, errors: number, total: number): string {
  // The detector names its outlier tools; older rows fall back to the tools read back.
  const outliers = outlierTools(rec);
  if (outliers.length > 1) {
    const listed = outliers.slice(0, 3).map(toolLabel).join(", ");
    const more = outliers.length > 3 ? ` and ${count(outliers.length - 3)} more` : "";
    return `${count(errors)} of ${count(total)} calls to ${count(outliers.length)} tools (${listed}${more})`;
  }
  const tool = outliers[0] ?? toolNames(rec.tool_calls ?? []);
  const calls =
    tool === null || tool.includes(" and ") ? "calls to one tool" : `${toolLabel(tool)} calls`;
  return `${count(errors)} of ${count(total)} ${calls}`;
}

/** The tool-error card's outlier tools as the detector stored them, most errors first. */
export function outlierTools(rec: CardActionRecommendation): string[] {
  return stringMetric(rec, "OUTLIER_TOOLS")?.split(", ") ?? [];
}

const BROWSER_SERVER = /chrome|browser|playwright|puppeteer/i;

/**
 * A tool's name for the card face (review 5 M9): an MCP id such as `mcp__claude-in-chrome__find`
 * reads "browser find"; the exact id stays in the Copy prompt.
 */
export function toolLabel(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp === null) return tool;
  const [, server = "", name = ""] = mcp;
  return `${BROWSER_SERVER.test(server) ? "browser" : server} ${name}`;
}

/** The kind of work a tool does: "browser control", "shell commands", "file tools". */
export function toolFamily(tool: string): string {
  const server = /^mcp__(.+?)__/.exec(tool)?.[1];
  if (server !== undefined)
    return BROWSER_SERVER.test(server) ? "browser control" : `${server} tools`;
  if (/^browser\b/i.test(tool)) return "browser control";
  if (tool === "Bash" || tool === "PowerShell") return "shell commands";
  if (["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep"].includes(tool))
    return "file tools";
  return tool;
}

/** The family more than half of the tools share, or null when none does. */
function mostlyFamily(tools: readonly string[]): string | null {
  const byFamily = new Map<string, number>();
  for (const tool of tools) {
    const family = toolFamily(tool);
    byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
  }
  const [top] = [...byFamily].sort((a, b) => b[1] - a[1]);
  return top !== undefined && top[1] * 2 > tools.length ? top[0] : null;
}

/** Failures the all-tool rate predicts for the outlier tools' calls; null without that rate. */
function expectedFailures(rec: CardActionRecommendation): number | null {
  const corpus = numberMetric(rec, "CORPUS_ERROR_RATE");
  const total = numberMetric(rec, "TOOL_CALL_COUNT");
  return corpus === null || total === null ? null : corpus * total;
}

/** U9 r8: one figure everywhere: one decimal below 1 ("about 0.1"), else whole ("7"). */
function expectedText(value: number): string {
  return value < 1 ? `about ${value.toFixed(1)}` : count(Math.round(value));
}

/** The five kinds of repeat the retry-loop finding counts; one turn can show several. */
const LOOP_KINDS = [
  ["identical_call_event_count", "identical calls"],
  ["test_fail_event_count", "failing test runs"],
  ["redundant_read_event_count", "repeated reads"],
  ["three_gram_loop_event_count", "repeated call sequences"],
  ["error_loop_event_count", "repeats of the same error"],
] as const;

/** "48 identical calls, 12 failing test runs, …" for the kinds that were recorded. */
/** U9 r7: the loop card has no spend-ledger producer, so its headline shows no $ (never $0.00). */
const D7_LOOP_OFF_LEDGER =
  "This estimate is not on the spend ledger: it is not netted against other cards, so the card headline does not show a figure.";

/**
 * U9 r7: the loop turns' share of the turns in the loop sessions, with that basis named (the
 * detector counts only the sessions that looped, never the whole window).
 */
export function loopTurnShare(rec: CardActionRecommendation): string {
  const turns = numberMetric(rec, "loop_flagged_turn_count");
  const total = numberMetric(rec, "total_turn_count");
  const sessions = numberMetric(rec, "session_count");
  if (turns === null || total === null || total <= 0) return "";
  const where = sessions === 1 ? "this session" : `these ${count(sessions ?? 0)} sessions`;
  return ` (${percentOf(turns / total)} of the ${count(total)} turns in ${where})`;
}

export function loopKinds(rec: CardActionRecommendation): string[] {
  return LOOP_KINDS.flatMap(([key, label]) => {
    const value = numberMetric(rec, key);
    return value === null || value === 0 ? [] : [`${count(value)} ${label}`];
  });
}

export const LOOP_KINDS_OVERLAP = "a turn can show several kinds, so these overlap";

/** How the same-error kind counts a run (the detector breaks a run on any other call). */
export const SAME_ERROR_RUN =
  "Repeats of the same error count only back to back: any other call in between ends the run.";

/** A call read back from a card's anchors, with the first sentence it returned. */
function example(call: CardToolCall | undefined): string {
  if (call === undefined) return "";
  const said = call.result ? ` (returned "${guardMessage(call.result)}")` : "";
  return `, for example \`${call.target}\`${said}`;
}

/**
 * "26 calls in 20 sessions (Bash in the 5 read back)", or "2 Agent calls in 2 sessions" when
 * every call was read back.
 */
export function callCount(rec: CardActionRecommendation, total: number): string {
  const calls = rec.tool_calls ?? [];
  const readBack = calls.reduce((sum, call) => sum + call.calls, 0);
  const tools = toolNames(calls);
  const sessions = sessionTotal(rec);
  const where = sessions > 1 ? ` in ${count(sessions)} sessions` : "";
  const noun = `call${total === 1 ? "" : "s"}`;
  if (tools === null) return `${count(total)} tool ${noun}${where}`;
  if (readBack >= total) return `${count(total)} ${tools} ${noun}${where}`;
  return `${count(total)} ${noun}${where} (${tools} in the ${count(readBack)} read back)`;
}

/** The guard messages behind a card's calls, most calls first. */
export function guardMessages(calls: readonly CardToolCall[]): Array<[string, number]> {
  const byMessage = new Map<string, number>();
  for (const call of calls) {
    if (!call.result) continue;
    const message = guardMessage(call.result);
    byMessage.set(message, (byMessage.get(message) ?? 0) + call.calls);
  }
  return [...byMessage].sort((a, b) => b[1] - a[1]);
}

/** Guard-blocked shapes in plain words; the last four are false positives (review 2 C9g2). */
export const GUARD_SHAPES: Record<GuardShape, string> = {
  CD_PREFIX: "`cd … &&` prefix",
  IN_PLACE_EDIT: "in-place edit",
  HEREDOC_FILE: "heredoc written to a file",
  TMP_WRITE: "`/tmp` path",
  DESTRUCTIVE_GIT: "destructive git command",
  OTHER: "unclassified",
  QUOTED_PATTERN: "`python -c` matched inside a quoted argument",
  PYTHON_READ: "`python -c` that only reads",
  // U9 r7: a block the guard exists to make (your rule forbids heredocs), not a false positive.
  HEREDOC_STDIN: "heredoc feeding a command's input, such as `git commit -F - <<'EOF'`",
  GIT_STASH_READ: "read-only `git stash list` or `show`",
  SCRATCH_TMP: "the job scratch folder (`jobs/<id>/tmp/` or `$CLAUDE_JOB_DIR/tmp/`)",
  QUOTED_HEREDOC: "`<<` inside a quoted pattern",
  PS_NODE_FLAG: "`node -ErrorAction` (a PowerShell parameter) matched as `node -e`",
  PS_SCRATCH_TMP: "a PowerShell call using the job scratch folder",
  WORKTREE_REMOVE: "worktree removal",
  MISSING_MODEL: "a subagent dispatch that omitted `model` (the guard's own rule)",
};

/**
 * U9 r7: the `node -e` pattern for the guard. It keeps blocking `-e` followed by anything that is
 * not a letter (a space, a quote, a digit, a bracket, the end), so `node -e"1"` and `node -e'1'`
 * stay blocked, and passes only `-e` followed by a letter (`node -ErrorAction`).
 */
export const NODE_FLAG_ERE = "node[[:space:]]+-e([^[:alpha:]]|$)";
export const NODE_FLAG_JS = /node\s+-e([^A-Za-z]|$)/i;

/**
 * U9 r7: the `/tmp` fix keeps the guard's own `/tmp/` rule untouched and runs it after deleting the
 * one folder that is known to be scratch: `tmp` directly under `…/jobs/<id>/` or `$CLAUDE_JOB_DIR`.
 * Any other `/tmp/` (`/var/tmp/x`, `/c/tmp/x`, `./tmp/x`, `/jobs/../tmp/x`) is still blocked, so the
 * guard blocks nothing less than before except that folder. A one-pattern fix cannot do this: a
 * shell `grep -E` has no look-behind.
 */
export const JOB_SCRATCH_TMP =
  /(jobs[/\\][A-Za-z0-9_-]+|\$\{?CLAUDE_JOB_DIR\}?|\$env:CLAUDE_JOB_DIR)[/\\]tmp[/\\]/;
// U9 r8: the scrub is anchored (`myjobs/x/tmp/` is not a job folder) and also reads the PowerShell
// backslash form (`…\jobs\<id>\tmp\`, `$env:CLAUDE_JOB_DIR\tmp\`).
export const TMP_SCRUB_JS = new RegExp(`(?<![A-Za-z0-9_-])${JOB_SCRATCH_TMP.source}`, "gi");
export const TMP_SCRUB_SED = String.raw`sed -E 's#(^|[^A-Za-z0-9_-])(jobs[/\\][A-Za-z0-9_-]+|\$CLAUDE_JOB_DIR|\$[{]CLAUDE_JOB_DIR[}]|\$env:CLAUDE_JOB_DIR)[/\\]tmp[/\\]#\1\2/_/#g'`;
const TMP_RULE_FIX = `first open your guard: it may already cut out part of the job folder (for example \`.claude/jobs/<id>/tmp/\`), so add only what is missing (often \`$CLAUDE_JOB_DIR/tmp/\`, which is a variable name until the shell expands it). To cut out the whole job scratch folder, keep your \`/tmp/\` rule as it is and run it on the command after the folder is cut out: in a JavaScript guard, \`command.replace(${TMP_SCRUB_JS}, "$1/_/")\` then test \`/\\/tmp\\//\`; in a shell guard, pipe the command through \`${TMP_SCRUB_SED}\` before your \`grep\`. Only \`jobs/<id>/tmp/\` and \`$CLAUDE_JOB_DIR/tmp/\` pass (also with backslashes, as PowerShell writes a path; a guard that tests only \`/tmp\` never sees a backslash path, so this matters only if yours tests \`\\tmp\\\` too). Only blocks on those two paths are counted as this shape, so a \`tmp\` folder anywhere else is not in the count and stays blocked on purpose, as do \`/tmp/x\`, \`/var/tmp/x\`, \`/c/tmp/x\`, \`./tmp/x\` and \`/jobs/../tmp/x\`. A command that names both a job folder and a bare \`/tmp/\` stays blocked, and so does one that reassigns \`CLAUDE_JOB_DIR\` in the same command. A project's own \`jobs/<id>/tmp/\` folder would also pass. These patterns were tested here against the shapes listed (JavaScript, and real \`sed -E\` and \`grep\`), not against your guard script: run the Verify step on it`;

/**
 * U7: the false positives that are the guard's own regex being too wide. The fix is a pattern
 * change in the user's guard, shown on the card as a snippet to review and apply (never applied
 * by AgentWrangler). Patterns are generic and unverified against the user's guard syntax.
 */
export const GUARD_FIX: Partial<Record<GuardShape, string>> = {
  PS_NODE_FLAG: `let \`-e\` pass only when a letter follows it: replace \`node[[:space:]]+-e\` with \`${NODE_FLAG_ERE}\` (PowerShell \`-match\` or JavaScript: \`node\\s+-e([^a-z]|$)\`, case-insensitive). \`node -ErrorAction\` passes; \`node -e "1"\`, \`node -e"1"\`, \`node -e'1'\`, \`node -e1\` and a bare \`node -e\` are still blocked`,
  SCRATCH_TMP: `exempt only the job scratch folder from the \`/tmp\` rule: ${TMP_RULE_FIX}`,
  PS_SCRATCH_TMP: `exempt only the job scratch folder from the \`/tmp\` rule: ${TMP_RULE_FIX}`,
};

/** The unexpanded-variable variant of SCRATCH_TMP, named once on the card (a fix to check, not a fact). */
export const GUARD_FIX_NOTE =
  "If a call reaches the guard with an unexpanded `$CLAUDE_JOB_DIR/tmp` (the variable is not set where the guard's tmp scrub runs), expand it before the scrub or add `$CLAUDE_JOB_DIR/tmp/` to the scrub's allowed prefixes.";

/**
 * The shape to use instead of each false positive: the guard stays strict and the call changes
 * (operator 2026-09-26, review 3 B4; telling reads from writes in a `python -c` is fragile).
 */
export const CALLING_SIDE: Partial<Record<GuardShape, string>> = {
  // Review 5 residual: a calling-side change, not a guard change (the guard stays strict).
  QUOTED_PATTERN:
    "a search whose pattern contains `python -c` as a Grep tool call instead of a Bash `grep`",
  PYTHON_READ:
    "a read-only `python -c` as a script file in the scratchpad (or `sqlite3 -readonly`, or the daemon API)",
  // U9 r7: a quote-blanking guard pattern would let `bash -c "cat <<EOF > f"` through, so the
  // guard stays strict and the search is written without a literal `<<` (checked with real grep).
  QUOTED_HEREDOC:
    "a conflict-marker search written without a literal `<<`: `grep -nE '^(<{7}|={7}|>{7})' <file>` (or the Grep tool)",
  GIT_STASH_READ: "a read-only `git stash list` as `git reflog show refs/stash`",
};

/** The words a guard message uses for the rule behind each false positive. */
const RULE_WORDS: Partial<Record<GuardShape, RegExp>> = {
  QUOTED_PATTERN: /python/i,
  PYTHON_READ: /python/i,
  GIT_STASH_READ: /stash/i,
  SCRATCH_TMP: /tmp/i,
  QUOTED_HEREDOC: /heredoc|<</i,
  PS_NODE_FLAG: /node/i,
  PS_SCRATCH_TMP: /tmp/i,
};

/**
 * A guard's rule id: the tool and the first three words of its message. Two live guards on one tool
 * (two PowerShell guards) have different ids; a reworded message of one guard keeps its id.
 */
export function guardRuleId(tool: string, message: string): string {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 3);
  return `${tool}\0${words.join(" ")}`;
}

export interface GuardVersion {
  /** The tool the guard checks: Bash and PowerShell have separate guards (review 4 C9). */
  tool: string;
  /** The guard rule this message belongs to (`guardRuleId`); versions are compared within a rule. */
  rule: string;
  message: string;
  /** The message of this guard's newest block: the guard as it is now. */
  current: boolean;
  blocks: number;
  /** Blocks per shape, most first. */
  shapes: Array<[GuardShape, number]>;
}

/**
 * Guard blocks grouped by guard (the tool it checks) and message, the current versions first
 * (review 2 C9g3). The calls come newest group first, so each tool's first message is its guard's
 * current one (review 4 C9). Empty unless classified.
 */
export function guardVersions(calls: readonly CardToolCall[]): GuardVersion[] {
  const current = new Map<string, string>();
  const byMessage = new Map<
    string,
    { tool: string; rule: string; message: string; shapes: Map<GuardShape, number> }
  >();
  for (const call of calls) {
    if (call.result === undefined) continue;
    const message = guardMessage(call.result);
    const rule = guardRuleId(call.tool, message);
    if (!current.has(rule)) current.set(rule, message);
    if (call.guard_shape === undefined) continue;
    const key = `${rule}\0${message}`;
    const version = byMessage.get(key) ?? { tool: call.tool, rule, message, shapes: new Map() };
    version.shapes.set(call.guard_shape, (version.shapes.get(call.guard_shape) ?? 0) + call.calls);
    byMessage.set(key, version);
  }
  return [...byMessage.values()]
    .map(({ tool, rule, message, shapes }) => ({
      tool,
      rule,
      message,
      current: current.get(rule) === message,
      blocks: [...shapes.values()].reduce((sum, n) => sum + n, 0),
      shapes: [...shapes].sort((a, b) => b[1] - a[1]),
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.blocks - a.blocks ||
        a.tool.localeCompare(b.tool),
    );
}

export const isFalsePositive = (shape: GuardShape): boolean => RULE_WORDS[shape] !== undefined;

/**
 * A guard card's calls in the order it shows them (review 5 M6): current-guard false positives,
 * then current-guard intended blocks, then blocks from an earlier guard version, then unclassified
 * (an OTHER shape under the current message, or a call with no guard message to place).
 */
function c9CallOrder(calls: readonly CardToolCall[]): CardToolCall[] {
  const versions = guardVersions(calls);
  const current = new Map(
    versions.map((version) => [`${version.rule}\0${version.message}`, version.current]),
  );
  const rank = (call: CardToolCall): number => {
    if (call.guard_shape === undefined || call.result === undefined) return 3;
    const message = guardMessage(call.result);
    if (current.get(`${guardRuleId(call.tool, message)}\0${message}`) !== true) return 2;
    if (isFalsePositive(call.guard_shape)) return 0;
    return call.guard_shape === "OTHER" ? 3 : 1;
  };
  return [...calls].sort((a, b) => rank(a) - rank(b));
}

/** The calls that match `lead` first, the rest after, each in their own order. */
function firstWhere(
  calls: readonly CardToolCall[],
  lead: (call: CardToolCall) => boolean,
): CardToolCall[] {
  return [...calls.filter(lead), ...calls.filter((call) => !lead(call))];
}

/**
 * False positives the guard can still make, per shape: every one under the current message, and
 * one under an older message only while the current message still names its rule.
 */
export function openFalsePositives(versions: readonly GuardVersion[]): Array<[GuardShape, number]> {
  const now = new Map(
    versions.filter((version) => version.current).map((version) => [version.rule, version.message]),
  );
  const open = new Map<GuardShape, number>();
  for (const version of versions) {
    for (const [shape, n] of version.shapes) {
      if (!isFalsePositive(shape)) continue;
      if (!version.current && !RULE_WORDS[shape]?.test(now.get(version.rule) ?? "")) continue;
      open.set(shape, (open.get(shape) ?? 0) + n);
    }
  }
  return [...open].sort((a, b) => b[1] - a[1]);
}

/**
 * The shapes a guard card's effect cycle counts (P3.A d): the open false positives when the card
 * shows them, else every classified shape the guard blocked. Never OTHER. Sorted, for a stable scope.
 */
export function c9WatchedShapes(calls: readonly CardToolCall[]): GuardShape[] {
  const versions = guardVersions(calls);
  const open = openFalsePositives(versions).map(([shape]) => shape);
  const shapes =
    open.length > 0 ? open : versions.flatMap((version) => version.shapes.map(([shape]) => shape));
  return [...new Set(shapes)].filter((shape) => shape !== "OTHER").sort();
}

/** "`cd … &&` prefix 11, in-place edit 4" for a version's shapes that match `keep`. */
export function shapeCounts(
  shapes: ReadonlyArray<[GuardShape, number]>,
  keep: (shape: GuardShape) => boolean,
): string {
  return shapes
    .filter(([shape]) => keep(shape))
    .map(([shape, n]) => `${GUARD_SHAPES[shape]} ${count(n)}`)
    .join(", ");
}

/**
 * A guard card's blocks split into current-guard false positives, current-guard intended blocks,
 * blocks from an earlier guard version, and unclassified (an OTHER shape under the current
 * message); null when no block has a guard version yet (older rows, review 5 M7).
 */
export function c9BlockSplit(
  versions: readonly GuardVersion[],
  denials: number | null = null,
): { fp: number; a: number; b: number; c: number; total: number } | null {
  if (versions.length === 0) return null;
  let fp = 0;
  let a = 0;
  let c = 0;
  for (const now of versions.filter((version) => version.current)) {
    for (const [shape, n] of now.shapes) {
      if (isFalsePositive(shape)) fp += n;
      else if (shape === "OTHER") c += n;
      else a += n;
    }
  }
  const b = versions
    .filter((version) => !version.current)
    .reduce((sum, version) => sum + version.blocks, 0);
  // F5 (2026-10-04): one count per card. Blocks the split cannot place (not read back, or a tool
  // without a guard shape) are unclassified, so the total is DENIAL_COUNT, as the summary says.
  if (denials !== null) c += Math.max(0, denials - (fp + a + b + c));
  return { fp, a, b, c, total: fp + a + b + c };
}

/**
 * The guard card's problem once its blocks are classified (review 5 M6/M7): the split stated once,
 * flat, with a zero part left out rather than named.
 */
function guardProblem(versions: readonly GuardVersion[], denials: number): string {
  const split = c9BlockSplit(versions, denials);
  if (split === null) return "";
  // U9 r3: the summary counts harmless blocks of earlier guard versions a rule still matches;
  // the problem names the same total.
  const open = openFalsePositives(versions).reduce((sum, [, n]) => sum + n, 0);
  const earlierOpen =
    open > split.fp
      ? ` (${count(open)} counting ${count(open - split.fp)} from earlier guard versions of a rule that still matches them)`
      : "";
  const parts = [
    split.fp > 0 ? `${count(split.fp)} harmless${earlierOpen}` : null,
    split.a > 0 ? `${count(split.a)} as intended` : null,
    split.b > 0 ? `${count(split.b)} from an earlier guard version` : null,
    split.c > 0 ? `${count(split.c)} unclassified` : null,
  ].filter((part): part is string => part !== null);
  return `Your guard blocked ${count(split.total)} call${split.total === 1 ? "" : "s"}${
    parts.length === 0 ? "" : `: ${parts.join(", ")}`
  }.`;
}

/** A long message cut between words, for quoting inside a sentence. */
function firstWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max - 1);
  return `${text.slice(0, cut > 0 ? cut : max - 1)}…`;
}

/** Errors, permissions and routing cards: what went wrong, from the stored metrics. */
function frictionProblem(rec: CardActionRecommendation): string | null {
  const calls = rec.tool_calls ?? [];
  const sessions = sessionTotal(rec);
  const where = sessions > 1 ? ` in ${count(sessions)} sessions` : "";
  switch (rec.detector_id) {
    case "C1": {
      const errors = numberMetric(rec, "TOOL_ERROR_COUNT");
      const total = numberMetric(rec, "TOOL_CALL_COUNT");
      const corpus = numberMetric(rec, "CORPUS_ERROR_RATE");
      const corpusCalls = numberMetric(rec, "CORPUS_CALL_COUNT");
      if (errors === null || total === null || total <= 0) return null;
      // Review 3 B7 / review 5: the failures the all-tool rate predicts, and why the listed tools'
      // rate is higher (they were picked for failing most), rather than the gap as a finding.
      // U9 r5: one decimal below 1, so 0.13 reads "about 0.1", not "about 0".
      const raw = corpus === null ? null : corpus * total;
      const expected = raw === null ? null : expectedText(raw);
      // U9 r8: the denominator's basis is the detector's own filter, checked against a database
      // query: main-conversation calls (no subagents) of finished sessions in the window, with a
      // recorded outcome, minus the shell the shell-error card owns in a workspace.
      const corpusErrors = numberMetric(rec, "CORPUS_ERROR_COUNT");
      const base =
        corpus === null || expected === null
          ? ""
          : ` At the ${percentOf(corpus)} rate across all${corpusCalls === null ? "" : ` ${count(corpusCalls)}`} tool calls counted (the week's main-conversation calls with a recorded outcome; subagent calls and the shell calls the shell-error card owns are left out), ${expected.startsWith("about") ? expected : `about ${expected}`} of these ${count(total)} calls would have failed.${corpusCalls === null || corpusErrors === null ? "" : ` Those ${count(corpusCalls)} calls are the ones in finished sessions in the week; ${count(corpusErrors)} of them failed.`}`;
      const readBack = calls.reduce((sum, call) => sum + call.calls, 0);
      const unreadable =
        readBack > 0 && readBack < errors
          ? ` ${count(readBack)} of the ${count(errors)} failed calls could be read back; ${count(errors - readBack)} could not, so ${errors - readBack === 1 ? "its error is" : "their errors are"} not shown.`
          : "";
      return `${oneToolCalls(rec, errors, total)} failed${where} (${percentOf(errors / total)}).${unreadable}${base} The tools listed are the ones that failed most, so their rate is higher than your overall rate. Not counted as failures: a hook block, a call you rejected, a browser timeout, an Artifact publish refused to protect a newer edit, and a path that does not exist (the missing-path card owns those).`;
    }
    case "C2": {
      const { lookups, sessions } = notFoundTotals(rec);
      if (lookups === null) return null;
      const causes = notFoundCauses(rec);
      const across = `${count(lookups)} lookup${lookups === 1 ? "" : "s"} of paths that did not exist across ${count(sessions)} session${sessions === 1 ? "" : "s"}`;
      // U9 r7: the lead is counted among the lookups read back, without deliberate probes; a tie
      // is said as a tie, and the 6 whose input was in no transcript are not credited to a cause.
      const top = notFoundLead(rec);
      const lead = top === null ? undefined : c2LeadCause(top.causes);
      const example = (
        calls.find((call) => call.cause === lead && repoFile(call)) ??
        calls.find((call) => call.cause === lead)
      )?.target;
      const eg = example === undefined ? "" : `, such as \`${example}\``;
      const leadN = top?.n ?? 0;
      const most =
        top !== null && leadN * 2 > top.read
          ? "Most"
          : `The commonest cause (${count(leadN)} of ${top?.basis ?? count(lookups)})`;
      const why =
        top !== null && top.causes.length > 1
          ? `The commonest causes tie (${top.causes.map((c) => NOT_FOUND_CAUSES[c].phrase).join(" and ")}, ${count(leadN)} each of ${top.basis}), so no one cause leads.${top.causes.includes("WRONG_WORKTREE") && top.causes.includes("GUESSED_PATH") ? " Glob for the file name before reading a path that was not built from the current checkout covers both." : ` The fix below covers ${NOT_FOUND_CAUSES[lead ?? "GUESSED_PATH"].phrase} only.`}`
          : lead === "WORKTREE_GONE"
            ? `${most} named a file inside a \`.worktrees/<slug>/\` folder that is no longer on disk${eg}. The file went with the worktree, or was never saved there; a handoff or plan that names a worktree path breaks once the worktree is removed. Check whether git tracks the file (\`git check-ignore -v <path>\`) and keep the file at a path that outlives the worktree.`
            : lead === "WRONG_WORKTREE"
              ? `${most} named a file in a different checkout of the repo than the one Claude was working in${eg}. The data does not show whether a plan or handoff supplied the path; the transcript before the call does. Glob for the file name before reading it.`
              : lead === "OTHER_SCRATCHPAD"
                ? `${most} pointed into another session's scratchpad${eg}, which is temporary and belongs to that session. A handoff or plan that copies what the next session needs into the repo avoids that.`
                : lead === "NOT_ON_BRANCH"
                  ? `${most} named a file that exists on another branch, not the one checked out where Claude looked${eg}. Checking the branch before reading a file named in a plan or handoff avoids that.`
                  : lead === "WRONG_FOLDER"
                    ? `${most} had the right file name in the wrong folder${eg}. A short map of the repo's folders in CLAUDE.md lets Claude build the path instead of guessing the folder.`
                    : lead === "GUESSED_PATH"
                      ? `${most} were guesses${eg}: a file that was renamed or moved, or a name Claude assumed. Locating an unfamiliar file with Glob before reading it avoids the failed call.`
                      : "Most wrong paths are guesses: a file that was renamed or moved, the wrong worktree, or a stale path in a plan, handoff or memory note.";
      return `${across}${causes.length === 0 ? "" : `: ${notFoundByCause(causes, lookups)}`}. Each costs a failed call and a retry. ${why}`;
    }
    case "C7": {
      const failures = numberMetric(rec, "BASH_FAILURE_COUNT");
      if (failures === null) return null;
      const commands = commandFamily(stringMetric(rec, "BASH_COMMAND_FAMILY"));
      return `${count(failures)} ${commands} failed${where}${example(leadCall(calls))}. Each failure costs a turn while Claude retries. Repeated failures usually share one cause: a missing tool, the wrong working directory, a missing environment value, or a command that does not work in this shell.`;
    }
    case "D7": {
      const paths = numberMetric(rec, "redundant_path_count");
      if (paths !== null) {
        const reads = numberMetric(rec, "total_redundant_read_count");
        const bytes = numberMetric(rec, "total_redundant_result_bytes");
        const all = rec.tool_calls ?? [];
        const lookup = all.find(isLookupFile);
        const source = all.filter(isSourceFile).length;
        const mostSessions = numberMetric(rec, "max_path_session_count");
        const total =
          reads === null
            ? ""
            : `: ${count(reads)} reads, counting one per session${bytes === null ? "" : ` (${byteAmount(bytes)} of results)`}; repeats inside a session are on the "${D7_LOOP_CARD_TITLE}" card`;
        // One count per session throughout (review 3 B1); code under edit never leads.
        const top =
          lookup !== undefined
            ? ` The most-read look-up file, \`${lookup.target}\`, was read in ${count(lookup.session_count)} sessions.`
            : all.length === 0 && mostSessions !== null
              ? ` The most-read file was read in ${count(mostSessions)} sessions.`
              : "";
        const code =
          source === 0
            ? ""
            : ` ${count(source)} of the files listed ${source === 1 ? "is" : "are"} source code, re-read because the code changes; leave those.`;
        const pointer =
          lookup !== undefined || all.length === 0
            ? " For a look-up file that later sessions keep re-reading, a one-line pointer in CLAUDE.md to the section they need saves reading all of it."
            : "";
        return `${count(paths)} files were read again in later sessions${total}.${top}${code} Each re-read rebuilds context an earlier session already had.${pointer}`;
      }
      const turns = numberMetric(rec, "loop_flagged_turn_count");
      if (turns === null) return null;
      const kinds = loopKinds(rec);
      const byKind =
        kinds.length === 0 ? "" : ` By kind: ${kinds.join(", ")} (${LOOP_KINDS_OVERLAP}).`;
      // U9 r7: when the example's calls read back as several targets, the count is the named
      // target's own, so the text and its list agree; one target stands for the whole repeat.
      const repeats = numberMetric(rec, "loop_example_call_count");
      const named = calls.length === 1 ? (repeats ?? calls[0]?.calls) : calls[0]?.calls;
      const loop =
        calls[0] === undefined || named === undefined
          ? ""
          : ` The most repeated was ${calls[0].tool} \`${calls[0].target}\`, ${times(named)} in one session${calls[0].result ? ` (it returned "${guardMessage(calls[0].result)}")` : ""}.${calls[0].tool === "Read" && calls[0].result ? " A read that failed and was retried counts as a repeated error, not a repeated read." : ""}`;
      return `${count(turns)} turns${loopTurnShare(rec)}${where} were spent repeating calls.${byKind} ${SAME_ERROR_RUN}${loop} For a repeated read, re-read only the part needed; for a repeated error, change the approach after the second failure.`;
    }
    case "D4": {
      const turns = numberMetric(rec, "mismatch_turns_per_week");
      const opus = numberMetric(rec, "total_opus_turns_per_week");
      const output = numberMetric(rec, "avg_output_tokens");
      const lookup = numberMetric(rec, "lookup_subagent_count");
      const agents = numberMetric(rec, "opus_subagent_count");
      if (turns === null || lookup === null) return null;
      const of = agents === null ? "" : ` of ${count(agents)}`;
      const share =
        opus === null || opus <= 0
          ? ""
          : `, ${percentOf(turns / opus)} of the ${count(opus)} Opus subagent turns`;
      const avg = output === null ? "" : `, ${count(Math.round(output))} on average`;
      const types = stringArray(rec.evidence?.top_agent_types ?? rec.facts?.top_agent_types);
      const named = types.length === 0 ? "" : ` Most common types: ${types.join(", ")}.`;
      // U9 r5: say what the counts cover, since a re-count later in the week is higher.
      const mainTurns = numberMetric(rec, "main_thread_turns");
      const counted = ` The counts are settled Opus turns at the last evaluation${mainTurns !== null && mainTurns > 0 ? `, including ${count(mainTurns)} main-thread turns from sessions with no edits` : ""}; agents still running add turns after it, so a count taken later is higher.`;
      // U9 r7: the price gap and the realized share, so the $ can be worked out from the card.
      const opusU = numberMetric(rec, "lookup_opus_cost_u");
      const sonnetU = numberMetric(rec, "lookup_sonnet_cost_u");
      const gap = opusU === null || sonnetU === null ? null : opusU - sonnetU;
      const priced =
        gap === null || gap <= 0
          ? ""
          : ` Those ${count(turns)} turns cost ${dollars(opusU ?? 0)} at Opus prices and would cost ${dollars(sonnetU ?? 0)} at Sonnet prices, a ${dollars(gap)} gap; the estimate assumes ${percentOf(D4_REALIZABLE_AVOIDANCE_FRACTION)} of that gap is realized (an assumption, not a measurement): ${dollars(gap)} × ${percentOf(D4_REALIZABLE_AVOIDANCE_FRACTION)} = ${dollars(gap * D4_REALIZABLE_AVOIDANCE_FRACTION)} a week. ${D4_AVOIDANCE_BASIS}`;
      return `${count(lookup)}${of} Opus subagents this week looked like lookup work: at least ${percentOf(D4_LOOKUP_TURN_SHARE)} of each one's turns read a large context (${tokenAmount(D4_MISMATCH_MIN_CONTEXT_TOKENS)}+ tokens) and wrote little (under ${count(D4_MISMATCH_MAX_OUTPUT_TOKENS)} tokens${avg}). That is ${count(turns)} turns${share}.${counted}${named} Short output after a big read is the only signal used, so a review or verification agent that answers briefly looks the same; check the types before pinning. Subagents use the session's model unless their definition or dispatch sets one. The saving prices those turns' tokens at Sonnet's rate instead of Opus's, from the pricing snapshot in use.${priced}`;
    }
    case "D12": {
      const bytes = numberMetric(rec, "sidechain_result_bytes");
      const turns = numberMetric(rec, "sidechain_turn_count");
      const agentSessions = numberMetric(rec, "sidechain_session_count");
      if (bytes === null) return null;
      const scope = [
        ...(agentSessions === null ? [] : [`${count(agentSessions)} sessions`]),
        ...(turns === null ? [] : [`${count(turns)} turns`]),
      ];
      return `Subagents returned ${byteAmount(bytes)} to the main conversation in results over 10 KB each${scope.length === 0 ? "" : ` (${scope.join(", ")})`}. Each result stays in the main context and is re-sent on every later turn. A subagent that returns a short summary with file paths, instead of full content, keeps that out.`;
    }
    case "H1": {
      const runs = numberMetric(rec, "OPERATION_COUNT");
      if (runs === null) return null;
      const kind = stringMetric(rec, "DESTRUCTIVE_OPERATION");
      const name = operationName(kind);
      const shell = DESTRUCTIVE_COMMANDS[kind ?? ""] !== undefined;
      const rated = riskyRuns(rec);
      const lead = calls.find((call) => call.risk === "RISKY") ?? leadCall(calls);
      const risk =
        rated === null
          ? ""
          : ` ${ofRuns(rated, runs)} deleted a path from a variable, an absolute path or a path outside the project; the rest deleted a relative path inside it.`;
      const resolved =
        lead?.risk === "RISKY" && lead.risky_paths !== undefined && lead.risky_paths.length > 0
          ? ` The risky run's target resolves to ${lead.risky_paths.map((p) => `\`${p}\``).join(", ")} (a variable the command sets itself is resolved first), outside the project. Check whether that was scratch space you meant to clear.`
          : "";
      return `Claude ran \`${name}\` ${times(runs)}${where}${example(lead)}.${risk}${resolved} It cannot be undone: a wrong path, variable or branch loses work for good. ${rec.guard_exists === true && kind === "RM_RF" ? "AgentWrangler saw your PreToolUse hook block calls in this workspace (see the guard-block card), so one more rule in it blocks this command on a risky path." : shell ? "An ask rule makes Claude Code stop and ask you before the command runs." : "A CLAUDE.md rule that makes Claude ask first puts you in the loop before it runs."}`;
    }
    case "D14": {
      const stops = numberMetric(rec, "INTERRUPT_COUNT");
      if (stops === null) return null;
      const what =
        stringMetric(rec, "INTERRUPT_KIND") === "PURE_INTERRUPT"
          ? `You interrupted Claude ${times(stops)}${where}`
          : `${count(stops)} tool call${stops === 1 ? "" : "s"} stopped while running (cancelled, or the session ended)${where}`;
      return `${what}${example(calls[0])}, and Claude was not redirected in the next two turns. Each stop throws away the work in progress. If Claude was heading the wrong way, having it show a plan or stay inside the files the task names catches that before work is lost.`;
    }
    case "D11": {
      const higher = stringMetric(rec, "higher_error_tool");
      const preferred = stringMetric(rec, "preferred_tool");
      if (higher === null || preferred === null) return null;
      const rate = (tool: string) =>
        errorRate(
          numberMetric(rec, `${tool.toLowerCase()}_error_count`),
          numberMetric(rec, `${tool.toLowerCase()}_call_count`),
        );
      const high = rate(higher);
      const low = rate(preferred);
      if (high === null || low === null) return null;
      // Review 3 B3: name each failure by its cause, not the command it sat in.
      const causes = new Map<string, number>();
      for (const call of rec.tool_calls ?? []) {
        const cause = shellCause(call.result ?? "", higher);
        causes.set(cause, (causes.get(cause) ?? 0) + call.calls);
      }
      const named = [...causes]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cause, n]) => `${cause} ${times(n)}`);
      const most = named.length === 0 ? "" : ` Most were: ${named.join(", ")}.`;
      const listed = listedOf(rec, sessions);
      const at = where === "" || listed === null ? where : `${where} (${count(listed)} listed)`;
      return `${higher} calls failed in the shell itself more often than ${preferred}${at}: ${high} against ${low}, counting every call that ran, including subagents (helper agents Claude starts for a sub-task). Only failures the shell caused count (a command it could not parse, or a command it does not have); a script, test or gate that fails would fail the same way in either shell.${most} Sending repository and file work to ${preferred}, and keeping ${higher} for tasks only it can do, cuts those failures.`;
    }
  }
  if (rec.detector_id === "C9") {
    const denials = numberMetric(rec, "DENIAL_COUNT");
    if (denials === null) return null;
    const blocked = callCount(rec, denials);
    switch (stringMetric(rec, "DENIAL_CLASS")) {
      case "HOOK_BLOCK": {
        const versions = guardVersions(calls);
        if (versions.length > 0) return guardProblem(versions, denials);
        const messages = guardMessages(calls);
        const said =
          messages.length === 0
            ? ""
            : `, ${messages.length === 1 ? "with" : "most often with"} "${messages[0]?.[0]}"`;
        return `Your PreToolUse guard blocked ${blocked}${said}. Either Claude keeps trying a shape the guard forbids, or the guard is stricter than it needs to be.`;
      }
      case "USER_REJECTED":
        return `You rejected ${blocked}. Each one was a call Claude proposed that you did not want. If Claude keeps proposing the same kind of thing, one standing instruction stops it.`;
      default:
        return `A permission deny rule blocked ${blocked}. Either Claude keeps trying a command the rule forbids, or the rule is broader than it needs to be.`;
    }
  }
  if (rec.detector_id === "E1") {
    const long = numberMetric(rec, "SESSIONS_OVER_P75");
    const editing = numberMetric(rec, "EDITING_SESSIONS");
    const p50 = numberMetric(rec, "PRE_EDIT_P50");
    const p75 = numberMetric(rec, "PRE_EDIT_P75");
    const excess = numberMetric(rec, "EXCESS_TURNS");
    if (long === null || editing === null || p50 === null || p75 === null || excess === null)
      return null;
    const read = calls.filter((call) => call.tool === "Read");
    const named =
      read.length === 0
        ? ""
        : ` The files they read most before editing: ${read
            .slice(0, 3)
            .map((call) => `\`${call.target}\` (${count(call.session_count)} sessions)`)
            .join(", ")}.`;
    return `In this project a session that edits usually makes ${count(p50)} model calls before its first edit; ${count(long)} of ${count(editing)} sessions made more than ${count(p75)}. Their calls past the ${count(p50)}th, ${count(excess)} in all, were spent reading around before any change.${named} A "Start here" block that names the files, the next command and the check lets a session start editing sooner. Long starts on a hard task can be needed; this compares sessions only with this project's own.`;
  }
  if (rec.detector_id === "E2") {
    const runs = numberMetric(rec, "RUNS");
    const turns = numberMetric(rec, "RUN_TURNS");
    const runSessions = numberMetric(rec, "RUN_SESSIONS");
    if (runs === null || turns === null || runSessions === null) return null;
    const kinds =
      calls.length === 0
        ? ""
        : ` In the costliest sessions they were mostly ${calls
            .slice(0, 4)
            .map((call) => `${call.target} (${count(call.calls)} calls)`)
            .join(", ")}.`;
    return `In ${count(runSessions)} sessions the main session ran ${count(runs)} stretches of three or more turns, ${count(turns)} turns in all, that only ran shell commands or read and searched files, with short replies, on Opus or Fable.${kinds} Work like that does not need the main model: one Sonnet subagent can run the stretch and hand back a short summary. Switching the main session's own model mid-task is not the fix, because it rewrites the whole cache; a subagent starts its own.`;
  }
  return null;
}

/**
 * An estimated-size D1 card shows only a range (the UI's "range only · no point estimate"), so its
 * text gives the same range, not a point (review 6 R6-33).
 */
function d1Range(rec: CardActionRecommendation): string | null {
  const range = rec.savings_range_u_per_wk;
  if (rec.detector_id !== "D1" || range === undefined) return null;
  if (stringMetric(rec, "attribution_method") === "MEASURED_CONTENT") return null;
  return `${dollars(range[0])}–${dollars(range[1])}`;
}

/**
 * How a card's weekly saving is worked out, from the stored figure and the model's own constants
 * (review 3: a savings figure shows its derivation). D2 derives its own in `splitNetting`.
 */
function savingsDerivation(rec: CardActionRecommendation): string {
  const saving = rec.savings_u_per_wk;
  if (saving === undefined || saving <= 0) return "";
  const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
  const perMillion = (tokens: number, fraction: number) =>
    `$${(saving / (tokens * fraction)).toFixed(2)} per million tokens`;
  if (rec.detector_id === "D1") {
    const delta = numberMetric(rec, "delta_context_tokens");
    const turns = numberMetric(rec, "turns_per_week");
    if (delta === null || turns === null) return "";
    const tokens = delta * turns;
    if (tokens <= 0) return "";
    // Review 6 R6-05: name the avoidance fraction and its $ price; older rows lack the metric, so
    // the fixed constant (the only value ever passed) is the fallback.
    const fraction = numberMetric(rec, "reduction_fraction") ?? D1_TRIM_TO_TARGET_FRACTION;
    const range = d1Range(rec);
    return ` Estimated saving: ${tokenAmount(tokens)} tokens a week above the target × ${pct(fraction)} assumed avoidable × ${perMillion(tokens, fraction)} (cache-read price) = ${dollars(saving)} a week. ${D1_AVOIDANCE_BASIS}${range === null ? "" : ` The size is estimated, so the card gives a range: ${range} a week.`}`;
  }
  if (rec.detector_id === "D8") {
    const net = numberMetric(rec, "net_churn_creation_tokens");
    if (net === null || net <= 0) return "";
    return ` Estimated saving: ${tokenAmount(net)} net × ${pct(D8_AVOIDANCE_FRACTION)} assumed avoidable × ${perMillion(net, D8_AVOIDANCE_FRACTION)} (cache-write price less the cache-read price) = ${dollars(saving)} a week.`;
  }
  if (rec.detector_id === "C1") {
    // Review 5 M10: name the turns counted; older findings lack the count.
    const turns = numberMetric(rec, "CLAIMED_TURN_COUNT");
    // The card headline is the ledger's recovery-turn cost (an upper bound); this figure is the
    // detector's own estimate, so state the basis of each instead of back-solving a cost.
    // U9: the two figures price different turns, so neither bounds the other.
    const headline =
      'The card headline prices a different, smaller set of turns (only the main conversation\'s turn after each failure, as an upper bound) and shows "under $0.01" when that rounds to nothing.';
    if (turns === null)
      return ` Estimated saving: ${pct(CX_WASTED_TURN_AVOIDANCE_FRACTION)} of the cost of the turns that made these failing calls is assumed avoidable = ${dollars(saving)} a week. ${headline}`;
    return ` Estimated saving: ${pct(CX_WASTED_TURN_AVOIDANCE_FRACTION)} of the cost of the ${count(turns)} turn${turns === 1 ? "" : "s"} that made these failing calls is assumed avoidable = ${dollars(saving)} a week. ${headline}`;
  }
  if (rec.detector_id === "D4") {
    // U9 r3: the 50% was hidden; it is an assumption, which is why the card has no modeled headline.
    return ` Estimated saving: those turns priced at Opus versus Sonnet list prices = ${dollars(saving / D4_REALIZABLE_AVOIDANCE_FRACTION)} a week × ${pct(D4_REALIZABLE_AVOIDANCE_FRACTION)} assumed realizable = ${dollars(saving)} a week. The ${pct(D4_REALIZABLE_AVOIDANCE_FRACTION)} is an assumption, not a measurement.`;
  }
  if (rec.detector_id === "E1") {
    const cost = numberMetric(rec, "EXCESS_COST_U");
    if (cost === null) return "";
    // U8: the reads in those turns are also results D6/A1 price on later turns; E1 claims only the
    // turns' own cost, so its figure stays out of the page total.
    return ` Estimated saving: those extra calls cost ${dollars(cost)} themselves × ${pct(E1_AVOIDANCE_FRACTION)} assumed avoidable = ${dollars(saving)} a week. The ${pct(E1_AVOIDANCE_FRACTION)} is an assumption, not a measurement. ${E1_AVOIDANCE_BASIS} This counts only the calls' own cost, not the later re-sending of what they read (the large-result cards price that), so it is not added to the page total.`;
  }
  if (rec.detector_id === "E2") {
    const cost = numberMetric(rec, "RUN_COST_U");
    const subagent = numberMetric(rec, "SUBAGENT_COST_U");
    if (cost === null || subagent === null) return "";
    // Review: which share of the gap is price and which is context depends on the models, so the
    // text names both levers without ranking them.
    return ` Estimated saving: those turns cost ${dollars(cost)}; handing them to a Sonnet subagent would cost about ${dollars(subagent)} (Sonnet prices from a fresh ${tokenAmount(E2_SUBAGENT_BASE_TOKENS)}-token context instead of the main session's, one cache write to start it, and one main-model turn to hand the run off). The ${dollars(cost - subagent)} gap × ${pct(E2_AVOIDANCE_FRACTION)} assumed handed off = ${dollars(saving)} a week. The ${pct(E2_AVOIDANCE_FRACTION)} is an assumption, not a measurement. Some of these turns are also counted by the long-start card, so it is not added to the page total.`;
  }
  if (rec.detector_id === "C2") {
    // U9 r4: one $ figure. The headline sentence that follows carries it; this says how it is
    // worked out. The standalone estimate (main + subagents, 50% assumed) stays in the details.
    return " How the cost is worked out: the full price of the main conversation's turn after each failed lookup (Claude reading the error and trying again), at that turn's model price: an upper bound, since part of that turn may be useful work. The lookup count above includes subagents' lookups; their turns are counted but not priced here.";
  }
  if (rec.detector_id === "D7") {
    const cost = numberMetric(rec, "repeat_excess_cost_u");
    if (cost !== null) {
      // Review 5 B1: the repeat turns' stored cost, split for display. Each part and the total
      // round to cents on their own; when the rounded parts miss the total, it reads "≈".
      const read = numberMetric(rec, "repeat_excess_read_u") ?? 0;
      const write = numberMetric(rec, "repeat_excess_write_u") ?? 0;
      const io = numberMetric(rec, "repeat_excess_io_u") ?? 0;
      const turns = numberMetric(rec, "repeat_excess_turn_count");
      const cents = (u: number) => Math.round(Number((u / 1e6).toFixed(2)) * 100);
      const eq = cents(read) + cents(write) + cents(io) === cents(cost) ? "=" : "≈";
      // Review 6 R6-25 (interim): the $ prices the turn that made the call, not any retry after it.
      return ` Estimated saving: the ${turns === null ? "" : `${count(turns)} `}repeat turns cost ${dollars(read)} in cache reads + ${dollars(write)} in cache writes + ${dollars(io)} in input and output ${eq} ${dollars(cost)}, each at its model's price; ${dollars(cost)} × ${pct(D7_AVOIDANCE_FRACTION)} assumed avoidable = ${dollars(saving)} a week. Priced at the turn that made the call. ${D7_LOOP_OFF_LEDGER}`;
    }
    // Older rows (before B1): the V1 sentence.
    const tokens = numberMetric(rec, "repeat_excess_turn_cap_weighted_tokens");
    if (tokens === null || tokens <= 0) return "";
    return ` Estimated saving: ${tokenAmount(tokens)} tokens re-sent by the repeats × ${pct(D7_AVOIDANCE_FRACTION)} assumed avoidable × ${perMillion(tokens, D7_AVOIDANCE_FRACTION)} (cache-read price) = ${dollars(saving)} a week.`;
  }
  return "";
}

/** The cause → effect statement the card shows before its recommended action. */
function problemStatement(rec: CardActionRecommendation): string | null {
  const problem = baseProblem(rec);
  return problem === null ? null : `${problem}${savingsDerivation(rec)}`;
}

/**
 * The problem in one short line for the top of "What's wrong" (operator 2026-09-26): what happens
 * and why it costs, then the card's weekly saving. Detectors without their own line use the first
 * sentence of the full problem.
 */
function problemSummary(
  rec: CardActionRecommendation,
  problem: string,
  headline: CardHeadline,
): string {
  const saving = rec.savings_u_per_wk;
  const range = d1Range(rec);
  const worth =
    headline.allocated_u_per_wk !== undefined
      ? headlineClause(headline, rec.savings_range_u_per_wk)
      : saving === undefined || dollars(saving) === "$0.00" || saving < 0
        ? ""
        : ` Fixing it saves about ${range ?? dollars(saving)} a week.`;
  // U9 r4: D4's $ holds only if the flagged agents are really lookups, and it assumes half is realizable.
  // U9 r7: A1's $ covers every large result; its Read rule reaches only the Read results.
  const results = numberMetric(rec, "EVENT_COUNT");
  const rewrite = numberMetric(rec, "REWRITE_COST_U");
  const stated =
    rec.detector_id === "D4"
      ? worth.replace(
          /^ Fixing it saves about (.+) a week\.$/,
          " If all of these are really lookups, the estimate is about $1 a week (it assumes only part of the price gap is realized).",
        )
      : rec.detector_id === "A1" && results !== null
        ? worth.replace(
            /^ Fixing it saves about (.+) a week\.$/,
            ` Shrinking all ${count(results)} would save about $1 a week; the Read rule on this card reaches only the Read results among them${readShare(rec)}, not shell output, searches or fetched pages.`,
          )
        : rec.detector_id === "B1" && rewrite !== null
          ? // U9 r7: B1's $ is an assumed half of the rewrite cost; the fix shrinks breaks, not stops them.
            worth.replace(
              /^ Fixing it saves about (.+) a week\.$/,
              (_all: string, amount: string) =>
                ` The card assumes loading tools early avoids half of the ${dollars(rewrite)}, about ${amount} a week; that is an assumption, since it makes each rewrite smaller but does not stop the break.`,
            )
          : worth;
  return `${summaryLine(rec) ?? `${firstSentence(problem)}.`}${stated}`;
}

/** U9 r8: " (71 of 82, 88% of the bytes)" for A1's Read results, or "" on rows without the metrics. */
function readShare(rec: CardActionRecommendation): string {
  const reads = numberMetric(rec, "READ_EVENT_COUNT");
  const readBytes = numberMetric(rec, "READ_RESULT_BYTES");
  const events = numberMetric(rec, "EVENT_COUNT");
  const total = numberMetric(rec, "RESULT_BYTES_TOTAL");
  if (reads === null || readBytes === null || events === null || total === null || total <= 0)
    return "";
  return ` (${count(reads)} of ${count(events)}, ${Math.round((readBytes / total) * 100)}% of the bytes)`;
}

/** The headline $ the card shows (P3.L-F): allocated for spend cards, reliability for null-allocated ones. */
export interface CardHeadline {
  allocated_u_per_wk?: number | null;
  reliability_u_per_wk?: number | null;
}

/**
 * The TL;DR $ clause and the sentence that carries the same $ in the problem. A net headline above
 * the fix's own range shows the range only on the card (F1), so the text quotes that range too
 * (re-review N4, operator 2026-10-05).
 */
function headlineParts(
  headline: CardHeadline,
  range?: [number, number],
): {
  clause: string;
  amount: string;
  reconcile: (amount: string) => string;
  always?: boolean;
} | null {
  const { allocated_u_per_wk: alloc, reliability_u_per_wk: rel } = headline;
  if (typeof alloc === "number" && range !== undefined && alloc > range[1]) {
    // U9 r7: a range that rounds to "$0.00–$0.00" reads as under a cent, as the headline does.
    const amount =
      dollars(range[1]) === "$0.00" ? "under $0.01" : `${dollars(range[0])}–${dollars(range[1])}`;
    return {
      amount,
      clause: ` Fixing it saves about ${amount} a week.`,
      reconcile: (a) => ` This fix is modeled to save ${a} a week.`,
    };
  }
  if (typeof alloc === "number") {
    const amount = dollars(alloc);
    if (alloc < 0) return null;
    // U9 r7: a headline that rounds to nothing still has to match the text, which may quote this
    // card's own (standalone) figure: say the share the headline shows.
    if (amount === "$0.00") {
      return {
        amount: alloc > 0 ? "under $0.01" : "$0.00",
        clause: "",
        reconcile: (a) =>
          ` The card headline shows only this card's share of the spend ledger, after the spend other cards already count: ${a} a week.`,
        always: true,
      };
    }
    return {
      amount,
      clause: ` Fixing it saves about ${amount} a week.`,
      reconcile: (a) => ` After overlap with other cards, this card's share is ${a} a week.`,
    };
  }
  if (alloc === null && typeof rel === "number") {
    const amount = dollars(rel);
    if (rel < 0) return null;
    // U9 r6: the card headline reads "under $0.01" for a positive figure that rounds to nothing;
    // the text says the same instead of staying silent (or reading $0.00).
    if (amount === "$0.00") {
      if (rel === 0) return null;
      return {
        amount: "under $0.01",
        clause: " The failures cost under $0.01 a week.",
        reconcile: (a) => ` The turns after these failures cost ${a} a week.`,
      };
    }
    return {
      amount,
      clause: ` The failures cost up to ${amount} a week.`,
      reconcile: (a) => ` The turns after these failures cost up to ${a} a week.`,
    };
  }
  return null;
}

function headlineClause(headline: CardHeadline, range?: [number, number]): string {
  return headlineParts(headline, range)?.clause ?? "";
}

function withHeadlineSentence(
  problem: string | null,
  headline: CardHeadline,
  range?: [number, number],
): string | null {
  if (problem === null) return null;
  const parts = headlineParts(headline, range);
  // The "under $0.01" figure can also appear in a card's own note on how the headline is priced;
  // that note is not the headline sentence, so only a real figure suppresses it.
  if (
    parts === null ||
    (!parts.always && parts.amount !== "under $0.01" && problem.includes(parts.amount)) ||
    // A $0.00 share needs saying only next to a figure in the text it would contradict.
    (parts.always && !/\$(?!0\.00\b)\d/.test(problem))
  )
    return problem;
  return `${problem}${parts.reconcile(parts.amount)}`;
}

function summaryLine(rec: CardActionRecommendation): string | null {
  const n = (id: string) => numberMetric(rec, id);
  switch (rec.detector_id) {
    case "A1": {
      const events = n("EVENT_COUNT");
      const total = n("RESULT_BYTES_TOTAL");
      if (events === null || total === null) return null;
      return `${count(events)} large tool results (${byteAmount(total)} in total) stay in context and are re-sent on every later turn until /clear, compaction or Claude Code's tool-result clearing drops them.`;
    }
    case "A2": {
      const events = n("EVENT_COUNT");
      if (events === null) return null;
      return `${count(events)} background-task ${events === 1 ? "result" : "results"} over 10 KB came back into the main conversation, where ${events === 1 ? "it is" : "they are"} re-sent on every later turn.`;
    }
    case "C7": {
      const failures = n("BASH_FAILURE_COUNT");
      if (failures === null) return null;
      return `${count(failures)} ${commandFamily(stringMetric(rec, "BASH_COMMAND_FAMILY"))} failed, each costing a retry turn.`;
    }
    case "H1": {
      const runs = n("OPERATION_COUNT");
      if (runs === null) return null;
      return `Claude ran \`${operationName(stringMetric(rec, "DESTRUCTIVE_OPERATION"))}\` ${times(runs)}, and it cannot be undone.`;
    }
    case "D2": {
      const sessions = n("qualifying_session_count");
      if (sessions === null) return null;
      return `${count(sessions)} long sessions re-read their whole growing history on every model call.`;
    }
    case "D8": {
      const events = n("churn_event_count");
      if (events === null) return null;
      return `${count(events)} turns resumed after the prompt cache expired, so the whole context was written again.`;
    }
    case "C1": {
      const errors = n("TOOL_ERROR_COUNT");
      const total = n("TOOL_CALL_COUNT");
      if (errors === null || total === null || total <= 0) return null;
      return `${count(errors)} calls to a few tools failed (${percentOf(errors / total)}), each costing a retry turn.`;
    }
    case "D7": {
      const paths = n("redundant_path_count");
      if (paths !== null)
        return `${count(paths)} files were read again in later sessions, rebuilding context an earlier session already had.`;
      const turns = n("loop_flagged_turn_count");
      if (turns === null) return null;
      return `${count(turns)} turns went to repeating the same calls.`;
    }
    case "D11": {
      const higher = stringMetric(rec, "higher_error_tool");
      const preferred = stringMetric(rec, "preferred_tool");
      if (higher === null || preferred === null) return null;
      const rate = (tool: string) => {
        const errors = n(`${tool.toLowerCase()}_error_count`);
        const calls = n(`${tool.toLowerCase()}_call_count`);
        return errors === null || calls === null || calls <= 0 ? null : percentOf(errors / calls);
      };
      const high = rate(higher);
      const low = rate(preferred);
      if (high === null || low === null) return null;
      return `${higher} calls fail in the shell itself ${high} of the time, against ${low} for ${preferred}.`;
    }
    case "C9": {
      const denials = n("DENIAL_COUNT");
      if (denials === null || stringMetric(rec, "DENIAL_CLASS") !== "HOOK_BLOCK") return null;
      const versions = guardVersions(rec.tool_calls ?? []);
      if (versions.length === 0) return null;
      // The problem's total: DENIAL_COUNT, the unplaced blocks counted as unclassified.
      const blocked = c9BlockSplit(versions, denials)?.total;
      if (blocked === undefined) return null;
      const open = openFalsePositives(versions).reduce((sum, [, k]) => sum + k, 0);
      // U9: the facts list the harmless blocks under the current guard message; the open count
      // adds earlier-version ones the current rule still makes, so say how the two differ.
      const now = c9BlockSplit(versions, denials)?.fp ?? open;
      const split =
        open > now
          ? ` (${count(now)} under the current guard message, ${count(open - now)} more from earlier versions of a rule that still matches them)`
          : "";
      // Review 5 residual: only numbers the flat problem carries (no session count).
      return `Your PreToolUse guard blocked ${count(blocked)} call${blocked === 1 ? "" : "s"}; ${open === 0 ? "none of them is left to fix" : `${count(open)} ${open === 1 ? "was a harmless call" : "were harmless calls"}${split} it should not have stopped`}.`;
    }
    default:
      return null;
  }
}

function baseProblem(rec: CardActionRecommendation): string | null {
  if (rec.detector_id !== "D1")
    return contextProblem(rec) ?? cacheProblem(rec) ?? frictionProblem(rec);
  const source = numberMetric(rec, "source_tokens");
  const target = numberMetric(rec, "source_target");
  const delta = numberMetric(rec, "delta_context_tokens");
  const turns = numberMetric(rec, "turns_per_week");
  if (source === null || target === null || delta === null || turns === null) return null;
  const fileRef = stringMetric(rec, "source_file_ref");
  const file = fileRef ? fileRef.split(/[\\/]/).pop() : null;
  const unit =
    stringMetric(rec, "attribution_method") === "MEASURED_CONTENT" ? "tokens" : "estimated tokens";
  const turnBasis =
    stringMetric(rec, "component") === "MEMORY"
      ? "main-conversation turns and forked-subagent turns"
      : "main-conversation turns plus subagent turns other than Explore and Plan, which are assumed not to load it (the other subagents are assumed to, not checked per agent)";
  return (
    `${file ?? "This file"} is ${count(source)} ${unit}, ${count(delta)} over its ${count(target)}-token target (AgentWrangler's suggested default for this kind of file, not a Claude Code limit). ` +
    `Claude Code loads it on every turn (about ${count(turns)} a week, counting ${turnBasis}), so the excess costs about ` +
    `${tokenAmount(delta * turns)} tokens a week. Trimming it to the target avoids part of that cost.`
  );
}

function triggerFacts(rec: CardActionRecommendation): CardTriggerFact[] {
  return (rec.trigger_facts ?? detectorFacts(rec)).slice(0, 4);
}

/**
 * Builds linksafe trigger data. Deliberately never reads anchors: their session IDs are
 * privacy hashes rather than session routes.
 */
export function buildTrigger(
  rec: CardActionRecommendation,
  headline: CardHeadline = {},
): CardTrigger {
  const problem = withHeadlineSentence(problemStatement(rec), headline, rec.savings_range_u_per_wk);
  const calls = shownCalls(rec);
  const why = whyText(rec);
  return {
    session_ids: listedSessions(rec),
    window:
      validWindow(rec.evidence?.window) ??
      validWindow(rec.window) ??
      validWindow(rec.facts?.window),
    facts: triggerFacts(rec),
    ...(problem === null ? {} : { problem, summary: problemSummary(rec, problem, headline) }),
    ...(why === undefined ? {} : { why }),
    ...(calls === undefined ? {} : { calls }),
  };
}

/** The call groups a card shows, in the order it shows them; undefined when none were read back. */
function shownCalls(rec: CardActionRecommendation): CardToolCall[] | undefined {
  if (rec.tool_calls === undefined) return undefined;
  if (rec.detector_id === "A1") return listedCalls(rec.tool_calls);
  if (rec.detector_id === "C2") return byCause(rec);
  if (rec.detector_id === "D11") return shellFailureRows(rec.tool_calls).slice(0, MAX_LISTED_CALLS);
  if (rec.detector_id === "D7" && numberMetric(rec, "redundant_path_count") !== null)
    return [
      ...rec.tool_calls.filter(isLookupFile),
      ...rec.tool_calls.filter((call) => !isLookupFile(call)),
    ];
  if (rec.detector_id === "H1")
    return firstWhere(rec.tool_calls, (call) => call.risk === "RISKY").slice(0, MAX_LISTED_CALLS);
  if (rec.detector_id === "C9") return c9CallOrder(rec.tool_calls).slice(0, MAX_LISTED_CALLS);
  return rec.tool_calls;
}

/** A file path outside scratch folders: the plainest example of a missing-path lookup. */
function repoFile(call: CardToolCall): boolean {
  return call.kind === "file" && !SCRATCH_FILE.test(call.target);
}

/**
 * The groups a missing-path card lists: one per cause first, then the rest, lead cause first and
 * repo file paths before scratch files and search patterns within a cause.
 */
function byCause(rec: CardActionRecommendation): CardToolCall[] {
  const order = notFoundCauses(rec).map(([cause]) => cause);
  const rank = (call: CardToolCall) => {
    const cause = c2Cause(call);
    return cause === undefined ? -1 : order.indexOf(cause);
  };
  const ranked = [...(rec.tool_calls ?? [])].sort(
    (a, b) => rank(a) - rank(b) || Number(repoFile(b)) - Number(repoFile(a)),
  );
  const firsts = order.flatMap((cause) => ranked.find((call) => c2Cause(call) === cause) ?? []);
  return [...firsts, ...ranked.filter((call) => !firsts.includes(call))].slice(0, MAX_LISTED_CALLS);
}
