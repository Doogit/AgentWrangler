import type { SessionDiagnosticAnchor } from "../../query/api/diagnostics";
import type { SessionSummary } from "../../query/api/overview";
import { buildRecommendationInvestigationPrompt } from "../../query/api/rec-prompt";
import type { RecommendationCard } from "../../query/api/recommendations";
import type { SessionSpendPercentile } from "../../query/api/self-percentiles";
import type { SessionDrivers } from "../../query/api/session-drivers";
import type { SessionStory } from "../../query/api/session-story";
import { prettyModel } from "../sessions/SessionStory";
import { topSpendPercent } from "../sessions/SpendPercentileChip";

export type PromptArtifactFlavor = "TURNKEY" | "GUIDED";

export interface PromptArtifact {
  text: string;
  flavor: PromptArtifactFlavor;
}

function evNum(rec: RecommendationCard, key: string): number | null {
  const value = rec.evidence[key];
  return typeof value === "number" ? value : null;
}

function evStr(rec: RecommendationCard, key: string): string | null {
  const value = rec.evidence[key];
  return typeof value === "string" ? value : null;
}

function fmtNum(value: number): string {
  return value.toLocaleString("en-US");
}

function measuredLine(label: string, value: number | null, unit = ""): string | null {
  return value === null ? null : `${label}: ${fmtNum(value)}${unit}`;
}

function joinLines(lines: Array<string | null>): string {
  return lines.filter((line): line is string => line !== null).join("\n");
}

/**
 * Caption for the Copy button explaining the prompt's target.
 * Rendered beneath the Copy button in RecCard.
 */
export function scopePromptCaption(rec: RecommendationCard): string {
  return rec.scope_workspace_id === null
    ? "targets ~/.claude — applies everywhere"
    : "prompt targets this repo's CLAUDE.md";
}

export function buildPromptArtifact(rec: RecommendationCard): PromptArtifact | null {
  const artifact = buildRecommendationInvestigationPrompt(rec);
  return { text: artifact.text, flavor: artifact.flavor };
}

const HYGIENE_FLAG_TEXT: Record<string, string> = {
  LONG_FULL_CONTEXT: "Long session near context limit",
  NO_BASH_EVENTS: "No shell activity",
};

function usdText(u: number): string {
  return `$${(u / 1_000_000).toFixed(2)}`;
}

function plural(n: number, word: string): string {
  return `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function durationText(first: string | null, last: string | null): string {
  if (first === null || last === null) return "N/A";
  const elapsed = Date.parse(last) - Date.parse(first);
  if (!Number.isFinite(elapsed)) return "N/A";
  const minutes = Math.round(Math.max(0, elapsed) / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface SessionPromptInput {
  session: SessionSummary;
  /** GET /story; null when it failed, so the prompt falls back to the drivers and session fields. */
  story?: SessionStory | null;
  drivers?: SessionDrivers | null;
  percentile?: SessionSpendPercentile | null;
  anchors?: SessionDiagnosticAnchor[];
  recommendations?: RecommendationCard[];
  /**
   * Turns with no price (their cost is missing from every $ figure); null when not loaded,
   * "unknown" when the price coverage failed to load.
   */
  unpricedTurns?: number | "unknown" | null;
}

/**
 * The session page's "Investigate this session" prompt: enough context for another agent to find
 * the transcript and investigate its cost, ways to spend less, friction and errors. Built from
 * what the page already loaded; transcript content stays local (ADR-112).
 */
export function buildSessionPrompt(input: SessionPromptInput): string {
  const { session } = input;
  const story = input.story ?? null;
  const drivers = input.drivers?.drivers ?? [];
  const pct = input.percentile?.percentile ?? null;
  const total = story?.total_cost_u ?? 0;

  const friction = [
    [session.tool_error_count, "tool error"],
    [session.api_error_count, "API error"],
    [session.test_fail_count, "test failure"],
    [session.compaction_count, "compaction"],
    [session.interrupt_count, "interrupt"],
    [session.long_gap_count, "long gap"],
  ]
    .filter((pair): pair is [number, string] => typeof pair[0] === "number" && pair[0] > 0)
    .map(([n, word]) => plural(n, word));

  const groupedCount = story?.error_groups.reduce((s, g) => s + g.count, 0) ?? 0;
  const storyLines: string[] =
    story === null
      ? [
          ...((input.drivers?.tool_error_breakdown?.length ?? 0) === 0
            ? []
            : [
                "TOOL ERRORS (labels only; error text unavailable):",
                ...(input.drivers?.tool_error_breakdown ?? []).map(
                  (e) =>
                    `- ${e.tool_name} | ${e.tool_error_class}${e.bash_command_family === null ? "" : ` | ${e.bash_command_family}`} × ${fmtNum(e.count)}`,
                ),
              ]),
        ]
      : [
          ...(story.error_groups.length === 0
            ? []
            : [
                `WHAT WENT WRONG (tool errors grouped by error text${groupedCount < session.tool_error_count ? `; top ${story.error_groups.length} groups cover ${fmtNum(groupedCount)} of ${fmtNum(session.tool_error_count)} errors` : ""}):`,
                ...story.error_groups.map(
                  (g) =>
                    `- ${g.tool}${g.command === null ? "" : ` \`${g.command}\``}${g.other_commands > 0 ? ` (+${plural(g.other_commands, "other command")})` : ""} × ${fmtNum(g.count)}: ${oneLine(g.sample_error.split("\n").find((l) => l.trim() !== "" && !/^Exit code \d+$/.test(l.trim())) ?? g.signature, 200)}`,
                ),
              ]),
          ...(story.errors_without_text > 0
            ? [`(${plural(story.errors_without_text, "older tool error")} have no stored text.)`]
            : []),
        ];
  const transcriptGone = story !== null && !story.transcript_available;

  return joinLines([
    `Investigate Claude Code session ${session.session_id}.`,
    `SESSION: ${session.session_id}`,
    `TRANSCRIPT: ${session.file_path}`,
    `WORKSPACE: ${session.repo_path ?? session.workspace_id}`,
    `WHEN: ${session.first_turn_at ?? "N/A"} to ${session.last_turn_at ?? "N/A"} (${durationText(session.first_turn_at, session.last_turn_at)})`,
    `SIZE: ${plural(session.turn_count, "turn")} · estimated cost ${usdText(session.cost_equiv_u)}${
      pct === null || input.percentile == null
        ? ""
        : ` · top ${topSpendPercent(pct)}% of ${fmtNum(input.percentile.n)} sessions in this workspace (${input.percentile.window_days} days)`
    }`,
    input.unpricedTurns === "unknown"
      ? "PRICING: unknown (price coverage failed to load); the $ figures may leave out unpriced turns."
      : (input.unpricedTurns ?? 0) > 0
        ? `PRICING: ${plural(input.unpricedTurns ?? 0, "turn")} ${input.unpricedTurns === 1 ? "has no price; its" : "have no price; their"} cost is not in the $ figures.`
        : null,
    story?.first_prompt == null ? null : `FIRST PROMPT: "${oneLine(story.first_prompt, 400)}"`,
    ...(story?.headline == null
      ? []
      : [
          `WHERE THE MONEY WENT: ${story.headline.text}`,
          story.headline.detail,
          story.headline.savings_u === null
            ? null
            : `Estimated saving: about ${usdText(story.headline.savings_u)}`,
        ]),
    ...(story === null || story.spend.length === 0 || total <= 0
      ? []
      : [
          "SPEND BY CHAIN AND MODEL:",
          ...story.spend.map(
            (s) =>
              `- ${s.chain === "main" ? "Main" : "Subagents"} · ${prettyModel(s.model)} · ${plural(s.turns, "turn")} · ${usdText(s.cost_u)} (${Math.round((s.cost_u / total) * 100)}%)`,
          ),
        ]),
    ...(drivers.length === 0
      ? []
      : [
          "COST DRIVERS:",
          ...drivers.map((d) => {
            const measured = Object.entries(d.measured)
              .map(([key, value]) => `${key}=${typeof value === "number" ? fmtNum(value) : value}`)
              .join(", ");
            return `- ${d.label} | share: ${d.share === null ? "N/A" : `${Math.round(d.share * 1000) / 10}%`}${measured ? ` | measured: ${measured}` : ""}${d.session_cost_u === undefined ? "" : ` | ${usdText(d.session_cost_u)} in this session`}`;
          }),
        ]),
    ...storyLines,
    `FRICTION: ${friction.length === 0 ? "none observed" : friction.join(" · ")}`,
    `HYGIENE FLAGS: ${
      session.hygiene_flags.length === 0
        ? "none"
        : session.hygiene_flags.map((f) => HYGIENE_FLAG_TEXT[f] ?? f).join(", ")
    }`,
    story === null
      ? "FILES EDITED: unknown (session story unavailable)"
      : transcriptGone
        ? "FILES EDITED: unknown (transcript no longer on disk; first prompt and edits can't be read)"
        : `FILES EDITED: ${
            story.files_touched.length === 0
              ? "none observed"
              : `${story.files_touched.length >= 15 ? "top 15 by edits: " : ""}${story.files_touched.map((f) => `${f.path} (${plural(f.edits, "edit")})`).join(", ")}`
          }`,
    story === null
      ? null
      : `COMMITS: ${
          story.commits.length === 0
            ? "none observed"
            : story.commits.map((c) => `${c.sha.slice(0, 7)} (${c.ts})`).join(", ")
        }`,
    ...((input.anchors?.length ?? 0) === 0
      ? []
      : [
          "DIAGNOSTIC ANCHORS:",
          ...(input.anchors ?? []).map(
            (a) =>
              `- ${a.category} | ${a.label}${a.turn_index === undefined ? "" : ` | turn ${a.turn_index + 1}`}`,
          ),
        ]),
    ...((input.recommendations?.length ?? 0) === 0
      ? []
      : [
          "RELATED RECOMMENDATIONS:",
          ...(input.recommendations ?? []).map(
            (rec) =>
              `- ${rec.detector_id} | ${rec.title ?? rec.lever} | #/recommendations?focus=${encodeURIComponent(rec.rec_id)}`,
          ),
        ]),
    "TASK: Investigate this session. 1) Explain where its cost came from, starting with the biggest item above. 2) Find concrete ways to spend less on work like this (model choice, subagent routing, context size, cache churn, repeated calls). 3) For each error group and friction signal, find the cause and say how to avoid it next time. 4) List anything else worth looking into. Read the transcript to check every claim before acting on it.",
    "CONSTRAINTS: Read the transcript before proposing changes. Cost figures are estimates at public API list prices, not a bill. Do not delete instructions or context the work needs. Propose changes to settings, CLAUDE.md, hooks or agent definitions; do not apply them without approval.",
    "ACCEPTANCE: A short report: the top cost causes with $ figures, each error group's cause and fix, and a ranked list of changes with the expected saving or friction removed. Each claim cites a turn or line in the transcript.",
  ]);
}

export interface GeneratedSnippet {
  language: "jsonc" | "sh" | "md";
  caption: string;
  text: string;
  /**
   * When true, this snippet IS the §6 action surface for its lane, so RecCard
   * hides the investigation copy-prompt (which withholds identifiers by design,
   * violating §6 R1). Only the Phase 2.5 friction/destructive/cache generators
   * set this; D4/D10 snippets leave it unset and still coexist with the prompt.
   */
  supersedesInvestigationPrompt?: boolean;
}

/**
 * Closed count read from a V2 finding envelope's `metrics` map
 * (`rec.evidence.metrics.<CODE>.value`). Returns null unless the value is a finite
 * number — the generator only ever reads closed enum/count fields, never free text,
 * so the rendered artifact is SEC-101-safe by construction (Phase 2.5 contract).
 */
function evMetricCount(rec: RecommendationCard, code: string): number | null {
  const metrics = rec.evidence.metrics;
  if (typeof metrics !== "object" || metrics === null) return null;
  const entry = (metrics as Record<string, unknown>)[code];
  if (typeof entry !== "object" || entry === null) return null;
  const value = (entry as { value?: unknown }).value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Phase 2.5 (§6): paste-able friction rule blocks. Each golden-set friction
 * detector maps to ONE closed spec — a concrete action (R3), the actual rule text
 * to paste (R4), a rollback (R5), and a named before/after metric baked into the
 * caption from the measured count + window (R6). The generator reads only the
 * closed count metric and the window timestamps, so no raw content can reach the
 * artifact. Subagents extend the map with one row per detector; C3 is the reference.
 */
interface FrictionRuleSpec {
  metricCode: string;
  /** Imperative action — mirrors the detector's rewritten presentation.lever (R3). */
  action: string;
  /** Named after-target for adoption measurement (R6). */
  afterTarget: string;
  /** The paste-able rule text (R4). */
  ruleText: string;
  language: GeneratedSnippet["language"];
}

const FRICTION_RULE_SPECS: Record<string, FrictionRuleSpec> = {
  C2: {
    metricCode: "ERROR_COUNT",
    action: "Run Glob or Grep to confirm a path exists before retrying a failed content lookup.",
    afterTarget: "0 not-found content lookups in the next 7 days",
    ruleText: joinLines([
      "## Finding files",
      "- Before retrying a Read/Grep/Glob that returned not-found, confirm the path first with Glob or Grep.",
      "- Do not re-issue the same failing lookup unchanged.",
    ]),
    language: "md",
  },
  C3: {
    metricCode: "ERROR_COUNT",
    action: "Read a file's current contents before issuing an Edit to it.",
    afterTarget: "0 edit-before-read errors in the next 7 days",
    ruleText: joinLines([
      "## Editing files",
      "- Always Read a file's current contents in this session before issuing an Edit to it.",
      "- If an Edit fails because the file was not read, Read it first, then retry.",
    ]),
    language: "md",
  },
  C4: {
    metricCode: "RECOVERY_LOOP_COUNT",
    action:
      "After a failed Edit, re-read the file and shrink the hunk instead of retrying the same edit.",
    afterTarget: "0 failed-edit recovery loops in the next 7 days",
    ruleText: joinLines([
      "## Recovering from a failed Edit",
      "- When an Edit fails, Read the current file, then retry with a smaller, exact hunk.",
      "- Do not repeat the same edit after it has already failed.",
    ]),
    language: "md",
  },
  C5: {
    metricCode: "ERROR_LOOP_COUNT",
    action: "After 3 identical tool errors, stop and read the root cause instead of retrying.",
    afterTarget: "0 same-error loops in the next 7 days",
    ruleText: joinLines([
      "## Stop error loops",
      "- After 3 identical tool errors in a row, stop retrying.",
      "- Read the error and the anchored cause before making the next attempt.",
    ]),
    language: "md",
  },
  C7: {
    metricCode: "BASH_FAILURE_COUNT",
    action:
      "Fix the environment or add the failing command family to permissions.allow before retrying — don't repeat a failing Bash command.",
    afterTarget: "0 repeated Bash command failures in the next 7 days",
    ruleText: joinLines([
      "## Repeated Bash failures",
      "- When the same Bash command family fails repeatedly, stop and fix the cause (missing tool, wrong cwd, or a permission prompt) before retrying.",
      "- If the failures are permission prompts, add that command to permissions.allow in .claude/settings.json instead of re-running it.",
    ]),
    language: "md",
  },
  C9: {
    metricCode: "DENIAL_COUNT",
    action: "Review recurring blocked tool requests before repeating the same command shape.",
    afterTarget: "0 repeated blocked tool requests in the next 7 days",
    ruleText: joinLines([
      "## Blocked tool requests",
      "- When a tool request is blocked, review the permission or policy cause before retrying it.",
      "- Do not repeat the same blocked command shape unchanged.",
    ]),
    language: "md",
  },
  C11: {
    metricCode: "ERROR_COUNT",
    action:
      "Narrow oversized MCP calls (a filter, a smaller page, or the tool's own limit option) so responses stay under the output cap.",
    afterTarget: "0 MCP output-cap errors in the next 7 days",
    ruleText: joinLines([
      "## MCP output cap",
      "- When an MCP tool response exceeds the output cap, re-issue it narrower: a filter, a smaller page, or the tool's own limit option if it has one.",
      "- Do not retry the same unbounded MCP call.",
    ]),
    language: "md",
  },
};

/** Closed enum value read from a V2 finding envelope's `metrics` map. */
function evMetricEnum(rec: RecommendationCard, code: string): string | null {
  const metrics = rec.evidence.metrics;
  if (typeof metrics !== "object" || metrics === null) return null;
  const entry = (metrics as Record<string, unknown>)[code];
  if (typeof entry !== "object" || entry === null) return null;
  const value = (entry as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

/**
 * Phase 2.5 (§6): H1 destructive-operation guard. Maps the closed
 * DESTRUCTIVE_OPERATION class to an installable, Windows-safe settings.json
 * `permissions.ask` diff (a shell-shaped command pattern), or a CLAUDE.md rule for
 * SQL classes that do not route through Bash. Reads only the closed enum + count —
 * never a raw command — so the artifact is SEC-101-safe. Declarative, so no POSIX
 * hook script (the arm's `/dev/stdin` examples don't port to Windows).
 */
const DESTRUCTIVE_GUARD_PATTERNS: Record<string, { pattern: string; label: string } | "sql"> = {
  RM_RF: { pattern: "Bash(rm -rf:*)", label: "recursive file deletion (rm -rf)" },
  GIT_RESET_HARD: { pattern: "Bash(git reset --hard:*)", label: "hard git reset" },
  GIT_CLEAN: { pattern: "Bash(git clean:*)", label: "git clean" },
  SQL_DROP: "sql",
  TRUNCATE: "sql",
};

/**
 * Phase 2.5 (§6): cache-lane behavioral artifact (B1/B2/B4). These lanes have no
 * config/hook fix — the §6 artifact is "a prompt that embeds the evidence": the
 * measured collapse + a specific working-habit action + a named before/after. No
 * file is mutated, so the rollback line says so honestly. Reads only closed
 * TOKENS/DURATION metrics — SEC-101-safe.
 */
function fmtHours(ms: number): string {
  return `${(ms / 3_600_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}h`;
}

export function generateCacheBehaviorSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  const noRollback =
    "Rollback: none needed — this is a working-habit change, not a file edit to undo.";
  if (rec.detector_id === "B1") {
    const prev = evMetricCount(rec, "PREVIOUS_CACHE_READ_TOKENS");
    const curr = evMetricCount(rec, "CURRENT_CACHE_READ_TOKENS");
    if (prev === null || curr === null) return null;
    return {
      language: "md",
      supersedesInvestigationPrompt: true,
      caption: `Batch CLAUDE.md/prefix edits at a session boundary, or start a fresh session to re-cache. Before: ${fmtNum(prev)} cache-read tokens the prior turn. After (collapsed): ${fmtNum(curr)}. Target after adoption: cache-read stays above the collapse threshold next comparable turn. ${noRollback}`,
      text: joinLines([
        "TASK: Restore cache reuse in this workspace using only the measured evidence below.",
        `MEASURED: cache-read collapsed from ${fmtNum(prev)} to ${fmtNum(curr)} tokens in one turn — the cached prefix was invalidated.`,
        "ACTION: Batch edits to always-loaded context (CLAUDE.md/memory) before the session, or start a fresh session to re-cache after a collapse.",
        "ACCEPTANCE: The next comparable turn's cache-read tokens stay above the collapse threshold.",
      ]),
    };
  }
  if (rec.detector_id === "B2") {
    const gap = evMetricCount(rec, "GAP_DURATION_MS");
    const ttl = evMetricCount(rec, "CONSERVATIVE_TTL_DURATION_MS");
    if (gap === null || ttl === null) return null;
    return {
      language: "md",
      supersedesInvestigationPrompt: true,
      caption: `Resume within the cache TTL, or start fresh after a long break instead of resuming cold. Before: a ${fmtHours(gap)} idle gap against a ~${fmtHours(ttl)} conservative TTL dropped the cache. Target after adoption: no cold resume across a gap longer than the TTL. ${noRollback}`,
      text: joinLines([
        "TASK: Avoid the cold-resume cache miss using only the measured evidence below.",
        `MEASURED: a ${fmtHours(gap)} idle gap exceeded the ~${fmtHours(ttl)} conservative cache TTL, so resuming re-read the whole prefix cold.`,
        "ACTION: Resume within the TTL when you can; after a longer break, start a fresh session rather than resuming cold.",
        "ACCEPTANCE: No cold resume across a gap longer than the TTL in the next comparable session.",
      ]),
    };
  }
  if (rec.detector_id === "B4") {
    const prev = evMetricCount(rec, "PREVIOUS_CACHE_CREATION_TOKENS");
    const curr = evMetricCount(rec, "CURRENT_CACHE_CREATION_TOKENS");
    if (prev === null || curr === null) return null;
    return {
      language: "md",
      supersedesInvestigationPrompt: true,
      caption: `Batch CLAUDE.md/prefix edits before the session so the cached prefix isn't invalidated mid-run. Before: ${fmtNum(prev)} cache-creation tokens; the mid-session edit spiked it to ${fmtNum(curr)}. Target after adoption: no mid-session cache-creation spike next comparable session. ${noRollback}`,
      text: joinLines([
        "TASK: Prevent the mid-session prefix break using only the measured evidence below.",
        `MEASURED: a mid-session edit to the cached prefix spiked cache-creation from ${fmtNum(prev)} to ${fmtNum(curr)} tokens.`,
        "ACTION: Batch edits to always-loaded context (CLAUDE.md/memory) before the session starts, not mid-run.",
        "ACCEPTANCE: No mid-session cache-creation spike in the next comparable session.",
      ]),
    };
  }
  return null;
}

export function generateDestructiveGuardSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  if (rec.detector_id !== "H1") return null;
  const opClass = evMetricEnum(rec, "DESTRUCTIVE_OPERATION");
  const count = evMetricCount(rec, "OPERATION_COUNT");
  if (opClass === null || count === null) return null;
  const guard = DESTRUCTIVE_GUARD_PATTERNS[opClass];
  if (guard === undefined) return null;
  const target =
    rec.scope_workspace_id === null ? "~/.claude/settings.json" : ".claude/settings.json";

  if (guard === "sql") {
    return {
      language: "md",
      supersedesInvestigationPrompt: true,
      caption: `Require confirmation before a destructive ${opClass} runs. Observed: ${fmtNum(count)} occurrence(s) in the last 7 days. Target after adoption: every ${opClass} is confirmed first. Rollback: delete the added rule block from ${target === "~/.claude/settings.json" ? "~/.claude/CLAUDE.md" : "CLAUDE.md"}.`,
      text: joinLines([
        `<!-- CLAUDE.md — AgentWrangler destructive-op guard (${opClass}) -->`,
        "## Destructive database operations",
        `- Stop and ask for explicit confirmation before running any ${opClass === "SQL_DROP" ? "SQL DROP" : "TRUNCATE"} statement.`,
      ]),
    };
  }

  return {
    language: "jsonc",
    supersedesInvestigationPrompt: true,
    caption: `Add a confirmation guard for ${guard.label} so it is never run unattended. Observed: ${fmtNum(count)} occurrence(s) in the last 7 days. Target after adoption: every such command is confirmed first. Rollback: remove only the added ${JSON.stringify(guard.pattern)} entry from permissions.ask in ${target}; preserve every other rule.`,
    text: joinLines([
      `// ${target} — require confirmation before ${guard.label}.`,
      "// Merge permissions.ask with the existing file; existing deny/allow rules still apply.",
      JSON.stringify({ permissions: { ask: [guard.pattern] } }, null, 2),
    ]),
  };
}

/**
 * Build the friction rule-block artifact for a golden-set friction detector.
 * Returns null when the detector has no spec or the measured count is unavailable.
 */
export function generateFrictionRuleSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  const spec = FRICTION_RULE_SPECS[rec.detector_id];
  if (spec === undefined) return null;
  const count = evMetricCount(rec, spec.metricCode);
  if (count === null) return null;
  const target = rec.scope_workspace_id === null ? "~/.claude/CLAUDE.md" : "CLAUDE.md";
  return {
    language: spec.language,
    supersedesInvestigationPrompt: true,
    caption: `${spec.action} Measured: ${fmtNum(count)} occurrence(s) in the last 7 days. Target after adoption: ${spec.afterTarget}. Rollback: delete the added rule block from ${target}.`,
    text: joinLines([`<!-- ${target} — AgentWrangler suggested rule -->`, spec.ruleText]),
  };
}

export function generateD7LoopRetrySnippet(rec: RecommendationCard): GeneratedSnippet | null {
  if (rec.detector_id !== "D7") return null;
  const loopFlaggedEventCount = evNum(rec, "loop_flagged_event_count");
  if (loopFlaggedEventCount === null || !Number.isFinite(loopFlaggedEventCount)) return null;
  const repeatExcessEventCount = evNum(rec, "repeat_excess_event_count");
  const repeatExcessLine =
    repeatExcessEventCount === null || !Number.isFinite(repeatExcessEventCount)
      ? null
      : `MEASURED: ${fmtNum(repeatExcessEventCount)} repeat-excess event(s) were avoidable.`;

  return {
    language: "md",
    supersedesInvestigationPrompt: true,
    caption: `Interrupt repeated attempts and restate the goal, constraints, and latest failure before changing approach. Measured: ${fmtNum(loopFlaggedEventCount)} loop-flagged event(s) in the last 7 days. Target after adoption: 0 loop-flagged events in the next 7 days. Rollback: none needed — revert by ignoring the suggestion.`,
    text: joinLines([
      "TASK: Interrupt retry loops using only the measured evidence below.",
      `MEASURED: ${fmtNum(loopFlaggedEventCount)} loop-flagged event(s) in the last 7 days.`,
      repeatExcessLine,
      "ACTION: After a repeated attempt or failure, stop, restate the goal and latest failure, then take one smaller independently verifiable step.",
      "ACCEPTANCE: 0 loop-flagged events in the next 7 days.",
    ]),
  };
}

/**
 * RI10 (R3): opaque trailer-writer artifact. A `prepare-commit-msg` git hook that
 * appends `Agent-Session-Id: <uuid>` to every commit, where the uuid is generated
 * once per repo and stored locally in `.git/`. RI1's linker matches this trailer
 * against local session ids, so adoption is self-serve.
 *
 * PRIVACY (spec Key Decision): it NEVER emits or derives from the `claude.ai`
 * session URL — the URL leak is the documented privacy complaint. The opaque
 * per-repo uuid is the linkage id.
 */
export function generateTrailerWriterSnippet(): GeneratedSnippet {
  return {
    language: "sh",
    caption:
      "Install: save as .git/hooks/prepare-commit-msg and `chmod +x` it. Uninstall: delete that file. Appends an opaque Agent-Session-Id trailer (stored in .git/, never the session URL) so AgentWrangler links your future commits to their PRs.",
    text: joinLines([
      "#!/bin/sh",
      "# AgentWrangler: append an opaque per-repo session-id trailer for local spend→PR linkage.",
      "# The id is stored only in .git/ — never the assistant session URL.",
      'id_file="$(git rev-parse --git-dir)/agentwrangler-session-id"',
      'if [ ! -f "$id_file" ]; then',
      "  (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid) | tr 'A-Z' 'a-z' > \"$id_file\"",
      "fi",
      'sid="$(cat "$id_file")"',
      "if ! grep -qi '^Agent-Session-Id:' \"$1\"; then",
      '  printf \'\\nAgent-Session-Id: %s\\n\' "$sid" >> "$1"',
      "fi",
    ]),
  };
}

export function generateSettingsDisableBlock(rec: RecommendationCard): GeneratedSnippet | null {
  const catalogTokens = evNum(rec, "catalog_tokens");

  if (rec.detector_id !== "D10" || catalogTokens === null || !Number.isFinite(catalogTokens)) {
    return null;
  }

  const catalogTargetTokens = evNum(rec, "catalog_target_tokens");
  const deltaTokens = evNum(rec, "delta_context_tokens");
  // U7 rows carry removable_tokens; their catalog_target_tokens is the 5%-of-mean-context gate, not a target.
  const removableTokens = evNum(rec, "removable_tokens");
  const toolSearchMode = evStr(rec, "tool_search_mode") ?? "unknown";
  const configuredValue = evStr(rec, "configured_value") ?? "unset";
  const alwaysLoadCount = evNum(rec, "always_load_count");
  const jsonBody = toolSearchMode === "deferred" ? "{}" : '{\n  "enableToolSearch": true\n}';

  return {
    language: "jsonc",
    caption: "Suggested settings.json (lazy-load MCP tools)",
    text: joinLines([
      "// ~/.claude/settings.json — reduce always-loaded MCP tool catalog",
      removableTokens !== null && Number.isFinite(removableTokens)
        ? `// Measured catalog: ${fmtNum(catalogTokens)} tokens, ${fmtNum(removableTokens)} in items with no recorded use this week${
            catalogTargetTokens === null || !Number.isFinite(catalogTargetTokens)
              ? ""
              : ` (5% of mean context per turn: ${fmtNum(catalogTargetTokens)})`
          }`
        : `// Measured catalog: ${fmtNum(catalogTokens)} tokens, ${
            deltaTokens === null || !Number.isFinite(deltaTokens)
              ? "unavailable"
              : fmtNum(deltaTokens)
          } over the ${
            catalogTargetTokens === null || !Number.isFinite(catalogTargetTokens)
              ? "unavailable"
              : fmtNum(catalogTargetTokens)
          } target`,
      `// Current tool-search mode: ${toolSearchMode} (configured: ${configuredValue})`,
      jsonBody,
      alwaysLoadCount !== null && Number.isFinite(alwaysLoadCount) && alwaysLoadCount > 0
        ? `// ${fmtNum(alwaysLoadCount)} MCP server(s) currently set alwaysLoad:true — review each and set alwaysLoad:false for rarely-used ones.`
        : null,
    ]),
  };
}

/**
 * RI8 (R12): early-autocompact override for context-heavy detectors (D2/D8).
 * The threshold is a community-derived heuristic (60–75% band), NOT an Anthropic
 * figure — the caption and comments carry the unverified label so it never reads
 * as a measured recommendation.
 */
export function generateAutocompactSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  if (rec.detector_id !== "D2" && rec.detector_id !== "D8") return null;
  return {
    language: "jsonc",
    caption:
      "Suggested settings.json env — earlier autocompact (community suggestion to summarize context at 60–75% full; not verified by Anthropic). Rollback: delete the CLAUDE_AUTOCOMPACT_PCT_OVERRIDE env entry to restore the default.",
    text: joinLines([
      "// ~/.claude/settings.json — trigger autocompact earlier to cap context growth.",
      "// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=75 is a community suggestion (60–75% full), not verified by Anthropic.",
      '{\n  "env": {\n    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "75"\n  }\n}',
    ]),
  };
}

/**
 * RI8 (R12): route read-only subagents to Haiku, offered alongside the D4 model
 * default. Set in agent frontmatter or at dispatch — no measured quantity, so it
 * is presented as a paste-able artifact only.
 */
export function generateSubagentRoutingSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  if (rec.detector_id !== "D4") return null;
  return {
    language: "jsonc",
    caption: "Suggested subagent routing — default read-only subagents to Haiku",
    text: joinLines([
      "// Route read-only subagents (search, grep, lookup) to Haiku; keep Sonnet/Opus for edits + reasoning.",
      "// Set in .claude/agents/<name>.md frontmatter, or pass model: 'haiku' at dispatch.",
      "---\nmodel: haiku\n---",
    ]),
  };
}

export function generateModelDefaultSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  const totalOpusTurns = evNum(rec, "total_opus_turns_per_week");

  if (rec.detector_id !== "D4" || totalOpusTurns === null || !Number.isFinite(totalOpusTurns)) {
    return null;
  }

  const mismatchTurns = evNum(rec, "mismatch_turns_per_week");
  const mismatchFraction = evNum(rec, "mismatch_fraction");
  const advisoryNote = evStr(rec, "advisory_note");
  const advisoryLine =
    advisoryNote === null
      ? "// Advisory: only helps if your all-models/Opus/5h cap is binding — check /usage first."
      : `// ${advisoryNote}`;
  const diagnosticSavings = evNum(rec, "diagnostic_savings_u_per_wk_if_all_models_cap_binds");

  return {
    language: "jsonc",
    caption: "Suggested .claude/settings.json (model default)",
    text: joinLines([
      "// <repo root>/.claude/settings.json — default this workspace to Sonnet",
      advisoryLine,
      `// Measured: ${mismatchTurns === null || !Number.isFinite(mismatchTurns) ? 0 : fmtNum(mismatchTurns)} of ${fmtNum(totalOpusTurns)} Opus turns are high-context low-output (${Math.round(
        (mismatchFraction === null || !Number.isFinite(mismatchFraction) ? 0 : mismatchFraction) *
          100,
      )}%).`,
      diagnosticSavings !== null && Number.isFinite(diagnosticSavings)
        ? `// Diagnostic ceiling, only if that cap binds: ~$${(diagnosticSavings / 1_000_000).toFixed(2)}/wk`
        : null,
      '{\n  "model": "sonnet"\n}',
    ]),
  };
}
