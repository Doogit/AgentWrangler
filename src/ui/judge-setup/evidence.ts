/**
 * Plain-English "what we saw" line for a check, keyed by check_id (the API does not expose the
 * signal). Returns null when there is no clean phrasing, so the row omits the line instead of
 * showing raw numbers.
 */

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const num = (v: number): string => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const plural = (n: number, one: string, many: string): string =>
  `${num(n)} ${Math.round(n) === 1 ? one : many}`;

/** "12% of 40 sessions" style: share of a counted unit. */
function share(unit: string, unitPlural: string) {
  return (v: number, sample: number): string =>
    `${pct(v)} of ${sample.toLocaleString()} ${sample === 1 ? unit : unitPlural}`;
}

/** "Found / Not found in your settings" for a presence check (value >= 1 means found). */
const found = (v: number): string =>
  v >= 1 ? "Found in your settings" : "Not found in your settings";

/** Count of things found; zero reads as none found. */
const counted = (one: string, many: string) => (v: number) =>
  v < 1 ? `No ${many} found` : `${plural(v, one, many)} found`;

type Formatter = (value: number, sample: number, files: readonly string[]) => string;

const FORMATTERS: Record<string, Formatter> = {
  degraded_context: (v) => `${pct(v)} of turns ran in a nearly full context window`,
  explore_before_edit: share("editing session", "editing sessions"),
  autonomy_depth: (v) => `${num(v)} steps per prompt`,
  edit_survival: (v, sample) =>
    `${pct(v)} of committed lines still in the code after 14 days (${plural(sample, "session", "sessions")})`,
  compaction_rate_long: share("long session", "long sessions"),
  long_session_share: share("session", "sessions"),
  subagent_use: share("session", "sessions"),
  opus_share: share("main-thread turn", "main-thread turns"),
  mid_session_model_switch: share("session", "sessions"),
  verify_test_loop: share("editing session", "editing sessions"),
  cache_read_health: (v) => `${pct(v)} of input tokens read from cache`,
  interrupt_rate: (v) => `${num(v * 100)} interrupts per 100 turns`,
  denial_rate: (v) => `${num(v * 100)} denials per 100 turns`,
  claude_md_coverage: (v) => `${pct(v)} of your projects have a CLAUDE.md`,
  claude_md_lean: (v) => `Longest CLAUDE.md is ${plural(v, "line", "lines")}`,
  memory_lean: (v) => `Longest memory file is ${plural(v, "line", "lines")}`,
  custom_agents_defined: counted("agent", "agents"),
  model_mix: (v) => `${plural(v, "model family", "model families")} in use`,
  no_allow_all_bash: (v, _sample, files) =>
    v < 1
      ? "No allow-all Bash rule found"
      : `${plural(v, "allow-all Bash rule", "allow-all Bash rules")} found${
          files.length > 0 ? ` in ${files.join(", ")}` : ""
        }`,
  safe_default_mode: (v) =>
    v < 1 ? "No bypass-permissions default found" : "Bypass-permissions default found",
  secrets_deny_rule: found,
  hooks_guard_tools: counted("PreToolUse hook", "PreToolUse hooks"),
  verification_hook: counted("verification hook", "verification hooks"),
  skills_defined: counted("skill", "skills"),
  memory_enabled: found,
  mcp_footprint: counted("MCP server", "MCP servers"),
  hooks_configured: counted("hook", "hooks"),
};

/** `files`: settings files that hold an allow-all Bash rule (only that check names them). */
export function evidenceText(
  checkId: string,
  value: number | null,
  sample: number,
  files: readonly string[] = [],
): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return FORMATTERS[checkId]?.(value, sample, files) ?? null;
}
