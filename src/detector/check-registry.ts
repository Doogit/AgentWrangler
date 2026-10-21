/**
 * src/detector/check-registry.ts — "Judge my setup" check registry (JMS U3).
 *
 * DATA, not a code path (same contract as practice-registry.ts): a typed list of checks, each
 * carrying its category, severity, eligibility (a named condition plus explicit minimum-data
 * thresholds), scoring thresholds, citation (URL + date + version tag) and staleness age. The
 * engine in setup-grade.ts binds each `signal` id to a read-only reading and computes results on
 * request; nothing here is stored.
 *
 * Behavior checks use only verified-buildable signals: denial / interrupt labels
 * (ingest_metric_events.classifier_label), ExitPlanMode tool_events (plan-mode proxy), sidechain
 * (subagent) turns, model mix, cache + compaction aggregates, is_test_command verification loops
 * and /clear tool_events (forward-only: NO_DATA until enough sessions follow first capture).
 * Approvals are NOT recorded anywhere, so no check is framed on approval counts.
 *
 * Config checks consume the U2 scan shape (src/scanner/env-scan.ts).
 *
 * Citation dates: costs-doc dates are reused from practice-registry (fetched 2026-09-02); other
 * code.claude.com/docs pages carry the rubric authoring date and must be re-verified when
 * version_date goes stale (a stale check grades NO_DATA, never PASS).
 *
 * SEC-101: every field is static public metadata; no transcript content.
 */

import type { PracticeEntry } from "./practice-registry.js";

export type CheckCategory =
  | "context_hygiene"
  | "delegation"
  | "model_selection"
  | "permissions_security"
  | "verification_practice"
  | "config_quality"
  | "cost_efficiency";

export type Severity = "critical" | "important" | "minor";
export type CheckResult = "PASS" | "PARTIAL" | "FAIL" | "NO_DATA";

/** Ascending. Names are presentational and may be renamed without touching the engine. */
export const TIER_NAMES = ["Drifter", "Practitioner", "Operator", "Conductor", "God-tier"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** Named condition a check's sample is drawn from. The engine binds each to a count. */
export type EligibilityCondition =
  | "config_scan"
  | "sessions"
  | "delegation_eligible_sessions"
  | "long_sessions"
  | "edit_sessions"
  | "edit_sessions_oriented"
  | "turns"
  | "user_turns"
  | "priced_input_tokens"
  | "churn_sessions";

export interface Eligibility {
  condition: EligibilityCondition;
  /** What one sample unit is (documentation, surfaced in data-needed messages). */
  sample_unit: string;
  /** Fewer eligible samples than this → NO_DATA (a check never scores off a handful of events). */
  min_sample: number;
  /** Observed span (days of turn history in the window) required before behavior is judged. */
  min_window_days: number;
  /** Phrase completing "needs observed …" in gate / data-needed messages. */
  needs: string;
}

export interface Scoring {
  direction: "higher" | "lower";
  /** PASS at or beyond this value (>= when higher, <= when lower). */
  pass: number;
  /** PARTIAL at or beyond this value; otherwise FAIL. */
  partial: number;
}

export interface CheckEntry extends Omit<PracticeEntry, "practice_id" | "status"> {
  check_id: string;
  category: CheckCategory;
  severity: Severity;
  eligibility: Eligibility;
  scoring: Scoring;
  /** Rubric/harness version this check was last verified against. */
  version_tag: string;
  /** ISO date of that verification; older than `stale_after_days` → NO_DATA. */
  version_date: string;
  stale_after_days: number;
  /** Security disqualifier: a FAIL caps the final tier. */
  cap?: { tier: TierName; reason: string };
  /** Step-by-step fix shown under "What to do", so the user need not read the cited doc. */
  how_to?: readonly string[];
}

/** Fewer prompts without allow-all Bash or bypassPermissions (permission-modes + permissions docs, 2026-10-13). */
const FEWER_PROMPTS_HOW_TO: readonly string[] = [
  'Use auto mode instead: in ~/.claude/settings.json remove the allow-all rule ("Bash", "Bash(*)" or "*") and set "permissions": { "defaultMode": "auto" }. A reviewer model approves routine commands for you and stops risky ones, so parallel sessions keep running. It is the built-in default from Claude Code v2.1.283, and it only takes effect from your user settings, not a project\'s .claude/settings.json.',
  'Pre-approve the commands you run all the time with narrow rules, for example "Bash(npm test)" or "Bash(npm run *)". Picking "Yes, and don\'t ask again" on a prompt writes the same kind of rule. A rule must match every part of a chained command (&&, |, ;).',
  'Keep guardrails for what must never happen: deny rules such as "Read(./.env)" and PreToolUse hooks that block dangerous command shapes.',
  "On macOS, Linux or WSL2 you can also turn on the Bash sandbox with /sandbox: sandboxed commands run without prompts inside the file and network limits you set. It does not run on native Windows.",
];

export interface GateDef {
  gate_id: string;
  /** The defining check. Anything but PASS (including NO_DATA / stale) leaves the gate unsatisfied. */
  check_id: string;
  /** Tier whose entry this gate guards: unsatisfied → tier held at the tier below. */
  boundary: TierName;
  /** Message for the unsatisfied-by-FAIL case. */
  unmet: string;
}

export interface CategoryDef {
  label: string;
  weight: number;
}

/** Minimum scored checks before a category is trusted (below → insufficient-data). */
export const MIN_CATEGORY_CHECKS = 2;
/** Scored categories must cover at least this share of total weight to award any tier. */
export const MIN_COVERAGE = 0.5;
/** Severity weights for category scoring. */
export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 3, important: 2, minor: 1 };
/** Overall-score floors for tiers 1..4 (Drifter is everything below the first). */
export const TIER_FLOORS: readonly number[] = [0, 40, 60, 75, 90];

/** Context hygiene carries the highest weight (spec). */
export const CATEGORIES: Record<CheckCategory, CategoryDef> = {
  context_hygiene: { label: "Context hygiene", weight: 3 },
  permissions_security: { label: "Permissions & security", weight: 2 },
  verification_practice: { label: "Verification practice", weight: 2 },
  // U11: 1.5 -> 1.0. At 1.5 a setup with no subagents capped at 88.5 and could never reach God-tier.
  delegation: { label: "Delegation", weight: 1 },
  model_selection: { label: "Model selection", weight: 1.5 },
  config_quality: { label: "Config quality", weight: 1.5 },
  cost_efficiency: { label: "Cost efficiency", weight: 1.5 },
};

const COSTS = "https://code.claude.com/docs/en/costs";
const BEST = "https://code.claude.com/docs/en/best-practices";
const CACHE_BLOG =
  "https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything";
const DOCS = "https://code.claude.com/docs/en";
const V = "cc-docs-2026-09";
/** Checks re-weighted by the JMS U11 calibration pass (flags rubric_changed in the UI). */
const V_CAL = "jms-cal-2026-10";
/** Habit gates replaced by outcome gates + autonomy depth (JMS U12). */
const V_U12 = "jms-u12-2026-10";
/** Test runs counted from PowerShell, chained commands and verify scripts (judge guidance). */
const V_TESTS = "jms-tests-2026-10";
/** Edit survival from session_churn (AMF-CHECKS a, spec-agent-metrics-followons D-4). */
const V_AMF = "jms-amf-2026-10";
const V_DATE = "2026-09-02";
const STALE = 365;

/** Eligibility shorthands. */
const CONFIG = (needs: string): Eligibility => ({
  condition: "config_scan",
  sample_unit: "scan",
  min_sample: 1,
  min_window_days: 0,
  needs,
});

export const CHECKS: readonly CheckEntry[] = [
  // ── context_hygiene ─────────────────────────────────────────────────────────
  {
    check_id: "degraded_context",
    category: "context_hygiene",
    severity: "important",
    statement:
      "Keep context out of the degraded zone — stale context bills on every message and quality drops as the window fills.",
    source_url: `${COSTS}#manage-context-proactively`,
    source_date: "2026-09-02",
    threshold: {
      value: 0.05,
      rationale:
        "Share of main-thread turns at 70% of the model's context window or 400k tokens, whichever is lower (140k on 200k windows, 400k on 1M); PASS <= 0.05, PARTIAL <= 0.15. /clear is one way to stay out of it, not a requirement: /compact, short sessions and subagents all count.",
    },
    signal: "degraded_context_turn_share",
    artifact_link: null,
    eligibility: {
      condition: "turns",
      sample_unit: "main-thread turn",
      min_sample: 100,
      min_window_days: 7,
      needs: "100+ main-thread turns",
    },
    scoring: { direction: "lower", pass: 0.05, partial: 0.15 },
    version_tag: V_U12,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "compaction_rate_long",
    category: "context_hygiene",
    severity: "important",
    statement:
      "Prefer a fresh /clear to repeated compaction — compaction loses detail and re-bills the cache.",
    source_url: `${COSTS}#manage-context-proactively`,
    source_date: "2026-09-02",
    threshold: {
      value: 0.25,
      rationale: "Share of long sessions (60+ turns) that compacted; PASS <= 0.25, PARTIAL <= 0.5.",
    },
    signal: "compaction_share_long",
    artifact_link: null,
    eligibility: {
      condition: "long_sessions",
      sample_unit: "session of 60+ turns",
      min_sample: 5,
      min_window_days: 7,
      needs: "5+ long sessions (60+ turns)",
    },
    scoring: { direction: "lower", pass: 0.25, partial: 0.5 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "long_session_share",
    category: "context_hygiene",
    severity: "important",
    statement: "Keep sessions focused — long sessions carry stale context on every turn.",
    source_url: `${COSTS}#why-usage-climbs-in-a-long-session`,
    source_date: "2026-09-02",
    threshold: {
      value: 0.1,
      rationale: "Share of sessions with 150+ turns; PASS <= 0.1, PARTIAL <= 0.25.",
    },
    signal: "runaway_session_share",
    artifact_link: null,
    eligibility: {
      condition: "sessions",
      sample_unit: "session",
      min_sample: 10,
      min_window_days: 7,
      needs: "10+ sessions",
    },
    scoring: { direction: "lower", pass: 0.1, partial: 0.25 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "claude_md_lean",
    category: "context_hygiene",
    severity: "important",
    statement:
      "Keep CLAUDE.md lean — the docs recommend under 200 lines; it loads into context every session.",
    source_url: `${COSTS}#move-instructions-from-claude-md-to-skills`,
    source_date: "2026-09-02",
    threshold: {
      value: 200,
      rationale:
        "Longest scanned CLAUDE.md in lines; PASS <= 200 (official ceiling), PARTIAL <= 400.",
    },
    signal: "claude_md_max_lines",
    artifact_link: null,
    eligibility: CONFIG("a readable CLAUDE.md"),
    scoring: { direction: "lower", pass: 200, partial: 400 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "memory_lean",
    category: "context_hygiene",
    severity: "minor",
    statement:
      "Keep auto-memory indexes short — only the first 200 lines of MEMORY.md load each session.",
    source_url: `${DOCS}/memory#auto-memory`,
    source_date: "2026-10-12",
    threshold: {
      value: 200,
      rationale: "Longest scanned memory content in lines; PASS <= 200, PARTIAL <= 400.",
    },
    signal: "memory_max_lines",
    artifact_link: null,
    eligibility: CONFIG("a readable auto-memory directory"),
    scoring: { direction: "lower", pass: 200, partial: 400 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },

  // ── delegation ──────────────────────────────────────────────────────────────
  {
    check_id: "subagent_use",
    category: "delegation",
    severity: "important",
    statement:
      "Offload to subagents — they return short summaries while consuming context in their own window.",
    source_url: "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
    source_date: "2025-09-29",
    threshold: {
      value: 0.3,
      rationale:
        "Share of delegation-eligible sessions (20+ turns) that used a subagent; PASS >= 0.3, PARTIAL >= 0.1.",
    },
    signal: "subagent_session_share",
    artifact_link: null,
    eligibility: {
      condition: "delegation_eligible_sessions",
      sample_unit: "session of 20+ turns",
      min_sample: 5,
      min_window_days: 7,
      needs: "5+ delegation-eligible sessions (20+ turns)",
    },
    scoring: { direction: "higher", pass: 0.3, partial: 0.1 },
    version_tag: V_CAL,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "custom_agents_defined",
    category: "delegation",
    severity: "minor",
    statement: "Define reusable subagents for recurring delegated work.",
    source_url: `${DOCS}/sub-agents#quickstart-create-your-first-subagent`,
    source_date: "2026-10-12",
    threshold: {
      value: 1,
      rationale: "PASS with at least one agent definition; judged only where delegation applies.",
    },
    signal: "agent_count",
    artifact_link: null,
    eligibility: {
      condition: "delegation_eligible_sessions",
      sample_unit: "session of 20+ turns",
      min_sample: 5,
      min_window_days: 7,
      needs: "5+ delegation-eligible sessions (20+ turns)",
    },
    scoring: { direction: "higher", pass: 1, partial: 1 },
    version_tag: V_CAL,
    version_date: V_DATE,
    stale_after_days: STALE,
  },

  // ── model_selection ─────────────────────────────────────────────────────────
  {
    check_id: "opus_share",
    category: "model_selection",
    severity: "important",
    statement:
      "Right-size the model — Opus costs ~5x more than Sonnet per token; reserve it for complex tasks.",
    source_url: `${COSTS}#choose-the-right-model`,
    source_date: "2026-09-02",
    threshold: {
      value: 0.5,
      rationale: "Opus share of main-thread turns; PASS <= 0.5, PARTIAL <= 0.8.",
    },
    signal: "opus_turn_share",
    artifact_link: null,
    eligibility: {
      condition: "turns",
      sample_unit: "main-thread turn",
      min_sample: 100,
      min_window_days: 7,
      needs: "100+ main-thread turns",
    },
    scoring: { direction: "lower", pass: 0.5, partial: 0.8 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "mid_session_model_switch",
    category: "model_selection",
    severity: "important",
    statement: "Don't switch models mid-session — switching forces a cache rebuild.",
    source_url: CACHE_BLOG,
    source_date: "2026-04-30",
    threshold: {
      value: 0.1,
      rationale:
        "Share of non-trivial sessions (5+ turns) using more than one model; PASS <= 0.1, PARTIAL <= 0.2.",
    },
    signal: "model_switch_share",
    artifact_link: null,
    eligibility: {
      condition: "sessions",
      sample_unit: "session",
      min_sample: 10,
      min_window_days: 7,
      needs: "10+ sessions",
    },
    scoring: { direction: "lower", pass: 0.1, partial: 0.2 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "model_mix",
    category: "model_selection",
    severity: "minor",
    statement:
      "Match the model to the task — more than one model family in use shows deliberate selection.",
    source_url: `${DOCS}/model-config#setting-your-model`,
    source_date: "2026-10-12",
    threshold: {
      value: 2,
      rationale: "Distinct model families in main-thread turns; PASS >= 2, PARTIAL >= 1.",
    },
    signal: "model_family_count",
    artifact_link: null,
    eligibility: {
      condition: "sessions",
      sample_unit: "session",
      min_sample: 20,
      min_window_days: 7,
      needs: "20+ sessions",
    },
    scoring: { direction: "higher", pass: 2, partial: 1 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },

  // ── permissions_security ────────────────────────────────────────────────────
  {
    check_id: "no_allow_all_bash",
    category: "permissions_security",
    severity: "critical",
    statement: "Never allow every Bash command — scope allow rules to specific commands.",
    source_url: `${DOCS}/permission-modes#eliminate-prompts-with-auto-mode`,
    source_date: "2026-10-12",
    threshold: {
      value: 0,
      rationale: "PASS when no scanned settings carry an allow-all Bash rule.",
    },
    signal: "allow_all_bash_count",
    artifact_link: null,
    eligibility: CONFIG("readable settings.json permissions"),
    scoring: { direction: "lower", pass: 0, partial: 0 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
    cap: {
      tier: "Practitioner",
      reason: "An allow-all Bash rule is set — every shell command runs unprompted.",
    },
    how_to: FEWER_PROMPTS_HOW_TO,
  },
  {
    check_id: "safe_default_mode",
    category: "permissions_security",
    severity: "critical",
    statement: "Don't default to bypassPermissions — it disables all permission prompts.",
    how_to: FEWER_PROMPTS_HOW_TO,
    source_url: `${DOCS}/permission-modes#skip-all-checks-with-bypasspermissions-mode`,
    source_date: "2026-10-12",
    threshold: {
      value: 0,
      rationale: "PASS when no scanned settings set defaultMode to bypassPermissions.",
    },
    signal: "bypass_mode_count",
    artifact_link: null,
    eligibility: CONFIG("readable settings.json permissions"),
    scoring: { direction: "lower", pass: 0, partial: 0 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
    cap: {
      tier: "Practitioner",
      reason: "defaultMode is bypassPermissions — permission prompts are disabled.",
    },
  },
  {
    check_id: "secrets_deny_rule",
    category: "permissions_security",
    severity: "critical",
    statement:
      "Deny reads of secrets (.env, keys, credentials) so they never enter the context window.",
    source_url: `${DOCS}/permissions#read-and-edit`,
    source_date: "2026-10-12",
    threshold: {
      value: 1,
      rationale: "PASS when a deny rule covers .env, secrets, credentials or key files.",
    },
    signal: "secrets_deny_present",
    artifact_link: null,
    eligibility: CONFIG("readable settings.json permissions"),
    scoring: { direction: "higher", pass: 1, partial: 1 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
    cap: {
      tier: "Operator",
      reason: "No deny rule protects secrets files (.env, keys, credentials).",
    },
  },
  {
    check_id: "hooks_guard_tools",
    category: "permissions_security",
    // U11: important -> minor. Deny/allow rules already enforce; hooks are an advanced option.
    severity: "minor",
    statement: "Use PreToolUse hooks to enforce rules that must hold with zero exceptions.",
    source_url: `${DOCS}/hooks#pretooluse`,
    source_date: "2026-10-12",
    threshold: {
      value: 1,
      rationale: "PASS with at least one PreToolUse hook command configured.",
    },
    signal: "pretooluse_hook_count",
    artifact_link: null,
    eligibility: CONFIG("readable settings.json hooks"),
    scoring: { direction: "higher", pass: 1, partial: 1 },
    version_tag: V_CAL,
    version_date: V_DATE,
    stale_after_days: STALE,
  },

  // ── verification_practice ───────────────────────────────────────────────────
  {
    check_id: "verify_test_loop",
    category: "verification_practice",
    severity: "critical",
    statement:
      "Give Claude a way to verify its work — tests are the single highest-leverage practice.",
    source_url: `${BEST}#give-claude-a-way-to-verify-its-work`,
    source_date: "2026-10-12",
    threshold: {
      value: 0.5,
      rationale:
        "Share of sessions that edited files and also ran a test command (Bash or PowerShell, any segment of a chained command, test or verify scripts); PASS >= 0.5, PARTIAL >= 0.25.",
    },
    signal: "edit_sessions_with_tests_share",
    artifact_link: null,
    eligibility: {
      condition: "edit_sessions",
      sample_unit: "session that edited files",
      min_sample: 5,
      min_window_days: 7,
      needs: "5+ sessions that edited files, with test-command results",
    },
    scoring: { direction: "higher", pass: 0.5, partial: 0.25 },
    version_tag: V_TESTS,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "explore_before_edit",
    category: "verification_practice",
    severity: "important",
    statement: "Explore before you edit — read the code first, then change it.",
    source_url: `${BEST}#explore-first-then-plan-then-code`,
    source_date: "2026-10-12",
    threshold: {
      value: 0.8,
      rationale:
        "Share of edit sessions with 3+ read/search calls, or any subagent or ExitPlanMode call, before the first edit, and no edit rejected for not reading first; PASS >= 0.8, PARTIAL >= 0.6. Plan mode is one satisfying path, not a requirement.",
    },
    signal: "explore_before_edit_share",
    artifact_link: null,
    eligibility: {
      condition: "edit_sessions_oriented",
      sample_unit: "edit session",
      min_sample: 10,
      min_window_days: 7,
      needs: "10+ sessions that edited files",
    },
    scoring: { direction: "higher", pass: 0.8, partial: 0.6 },
    version_tag: V_U12,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "edit_survival",
    category: "verification_practice",
    severity: "minor",
    statement:
      "Make changes that stick — verified work stays in the code instead of being rewritten days later.",
    source_url: `${BEST}#give-claude-a-way-to-verify-its-work`,
    source_date: "2026-10-12",
    threshold: {
      value: 0.8,
      rationale:
        "Share of lines committed from Claude sessions that are still in the code 14 days after the commit (git blame at the 14-day mark), weighted by lines; PASS >= 0.8, PARTIAL >= 0.65. Only commits at least 14 days old count.",
    },
    signal: "edit_survival_share",
    artifact_link: null,
    eligibility: {
      condition: "churn_sessions",
      sample_unit: "session with committed lines measured 14 days on",
      min_sample: 20,
      min_window_days: 14,
      needs: "20+ sessions whose commits are at least 14 days old",
    },
    scoring: { direction: "higher", pass: 0.8, partial: 0.65 },
    version_tag: V_AMF,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "verification_hook",
    category: "verification_practice",
    severity: "minor",
    statement: "Automate verification with PostToolUse or Stop hooks.",
    source_url: `${DOCS}/hooks#run-tests-after-file-changes`,
    source_date: "2026-10-12",
    threshold: {
      value: 1,
      rationale: "PASS with a PostToolUse, Stop or SubagentStop hook command configured.",
    },
    signal: "verification_hook_count",
    artifact_link: null,
    eligibility: CONFIG("readable settings.json hooks"),
    scoring: { direction: "higher", pass: 1, partial: 1 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },

  // ── config_quality ──────────────────────────────────────────────────────────
  {
    check_id: "claude_md_coverage",
    category: "config_quality",
    severity: "important",
    statement:
      "Give each project a CLAUDE.md — persistent context beats re-explaining every session.",
    source_url: `${BEST}#write-an-effective-claude-md`,
    source_date: "2026-10-12",
    threshold: {
      value: 0.7,
      rationale: "Share of scanned projects with a CLAUDE.md; PASS >= 0.7, PARTIAL >= 0.4.",
    },
    signal: "project_claude_md_share",
    artifact_link: null,
    eligibility: CONFIG("a scanned project checkout"),
    scoring: { direction: "higher", pass: 0.7, partial: 0.4 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "skills_defined",
    category: "config_quality",
    severity: "minor",
    statement: "Package repeatable workflows as skills.",
    source_url: `${DOCS}/skills#create-your-first-skill`,
    source_date: "2026-10-12",
    threshold: { value: 1, rationale: "PASS with at least one skill defined." },
    signal: "skill_count",
    artifact_link: null,
    eligibility: CONFIG("a readable skills directory scan"),
    scoring: { direction: "higher", pass: 1, partial: 1 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "memory_enabled",
    category: "config_quality",
    severity: "minor",
    statement: "Let Claude keep project memory so learnings persist across sessions.",
    source_url: `${DOCS}/memory#enable-or-disable-auto-memory`,
    source_date: "2026-10-12",
    threshold: { value: 1, rationale: "PASS when any scanned memory directory has content." },
    signal: "memory_present",
    artifact_link: null,
    eligibility: CONFIG("a readable auto-memory directory"),
    scoring: { direction: "higher", pass: 1, partial: 1 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "mcp_footprint",
    category: "config_quality",
    severity: "important",
    statement: "Keep MCP servers few — each loads tool schemas into context.",
    source_url: `${COSTS}#reduce-mcp-server-overhead`,
    source_date: "2026-09-02",
    threshold: {
      value: 5,
      rationale:
        "MCP servers configured at user level plus enabled plugins' servers; PASS <= 5, PARTIAL <= 10.",
    },
    signal: "mcp_server_count",
    artifact_link: null,
    eligibility: CONFIG("a readable MCP config"),
    scoring: { direction: "lower", pass: 5, partial: 10 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "hooks_configured",
    category: "config_quality",
    severity: "minor",
    statement: "Use hooks to make behavior deterministic rather than hoping Claude remembers.",
    source_url: `${DOCS}/hooks-guide#set-up-your-first-hook`,
    source_date: "2026-10-12",
    threshold: { value: 1, rationale: "PASS with any hook command configured." },
    signal: "hook_command_count",
    artifact_link: null,
    eligibility: CONFIG("readable settings.json hooks"),
    scoring: { direction: "higher", pass: 1, partial: 1 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },

  // ── cost_efficiency ─────────────────────────────────────────────────────────
  {
    check_id: "cache_read_health",
    category: "cost_efficiency",
    severity: "important",
    statement:
      "Watch cache-read health — a few points of cache-miss rate dramatically affect cost and latency.",
    source_url: CACHE_BLOG,
    source_date: "2026-04-30",
    threshold: {
      value: 0.85,
      rationale: "Cache-read share of priced input tokens; PASS >= 0.85, PARTIAL >= 0.7.",
    },
    signal: "cache_read_ratio",
    artifact_link: null,
    eligibility: {
      condition: "priced_input_tokens",
      sample_unit: "priced input token",
      min_sample: 200_000,
      min_window_days: 7,
      needs: "200k+ priced input tokens",
    },
    scoring: { direction: "higher", pass: 0.85, partial: 0.7 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "interrupt_rate",
    category: "cost_efficiency",
    severity: "minor",
    statement: "Frequent interrupts waste partial turns — steer with clearer up-front prompts.",
    source_url: `${BEST}#course-correct-early-and-often`,
    source_date: "2026-10-12",
    threshold: {
      value: 0.05,
      rationale: "Interrupt-cancel events per user turn; PASS <= 0.05, PARTIAL <= 0.15.",
    },
    signal: "interrupt_per_user_turn",
    artifact_link: null,
    eligibility: {
      condition: "user_turns",
      sample_unit: "user turn",
      min_sample: 200,
      min_window_days: 7,
      needs: "200+ user turns",
    },
    scoring: { direction: "lower", pass: 0.05, partial: 0.15 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "autonomy_depth",
    category: "cost_efficiency",
    severity: "minor",
    statement:
      "Let Claude work in longer autonomous runs — experts get many steps per prompt, not a prompt per step.",
    source_url: "https://www.anthropic.com/research/claude-code-expertise",
    source_date: "2026-06-16",
    threshold: {
      value: 10,
      rationale:
        "Main-thread model steps (assistant responses, each usually one tool call) per user turn; PASS >= 10, PARTIAL >= 5 (Anthropic expertise study 2026-06-16: experts above 12 tool actions per prompt, novices about 5). Runaway guard: when interrupts per user turn exceed 0.15 the value is held just under PASS, so deep autonomy that you keep interrupting cannot pass.",
    },
    signal: "steps_per_user_turn",
    artifact_link: null,
    eligibility: {
      condition: "user_turns",
      sample_unit: "user turn",
      min_sample: 200,
      min_window_days: 7,
      needs: "200+ user turns",
    },
    scoring: { direction: "higher", pass: 10, partial: 5 },
    version_tag: V_U12,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
  {
    check_id: "denial_rate",
    category: "cost_efficiency",
    severity: "minor",
    statement:
      "Frequent denials (deny rules, hook blocks, rejected calls) burn turns — tune rules to the work.",
    source_url: `${DOCS}/permissions#permission-rule-syntax`,
    source_date: "2026-10-12",
    threshold: {
      value: 0.02,
      rationale:
        "deny-rule + hook-block + user-rejected events per user turn; PASS <= 0.02, PARTIAL <= 0.05. Approvals are not recorded.",
    },
    signal: "denial_per_user_turn",
    artifact_link: null,
    eligibility: {
      condition: "user_turns",
      sample_unit: "user turn",
      min_sample: 200,
      min_window_days: 7,
      needs: "200+ user turns",
    },
    scoring: { direction: "lower", pass: 0.02, partial: 0.05 },
    version_tag: V,
    version_date: V_DATE,
    stale_after_days: STALE,
  },
];

/** Named checks that hold tier boundaries until observed behavior satisfies them. */
export const GATES: readonly GateDef[] = [
  {
    gate_id: "G-verify",
    check_id: "verify_test_loop",
    boundary: "Conductor",
    unmet: "Edited sessions are not reliably followed by a test run",
  },
  {
    gate_id: "G-explore",
    check_id: "explore_before_edit",
    boundary: "God-tier",
    unmet: "Edits often start before the code has been explored",
  },
  {
    gate_id: "G-context",
    check_id: "degraded_context",
    boundary: "God-tier",
    unmet: "Too many turns run in a nearly full context window",
  },
];
