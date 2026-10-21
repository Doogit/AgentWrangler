/**
 * src/query/api/diagnostics-causes.ts — the Diagnostics root-cause registry (P4 U2).
 *
 * Encodes the approved root-cause mapping (docs/brainstorms/2026-09-26-diagnostics-triage-requirements.md,
 * "Root-cause mapping (approved)", R19, approved by the operator 2026-09-26) as data. One cause bundles
 * every V1 template / V2 rule that shares a root cause; each is keyed by (detector_id, id) because D14
 * emits rule_id "D2", which collides with the D2 detector's own id.
 *
 * No fallback bucket: `causeForKey` throws for an unknown key. Callers catch-and-skip at runtime rather
 * than bucket an unmapped key into a generic cause.
 */

export type CauseSection = "spend" | "reliability" | "risk";

/** The count unit for one key: what number the chip shows next to the pattern label. */
export type CountUnit = "events" | "failing turns" | "repeated calls" | "findings" | "sessions";

export interface CauseKey {
  readonly detector_id: string;
  /** The V2 rule_id or V1 template_id this key maps. */
  readonly id: string;
  /** Plain-English label for the pattern chip. */
  readonly pattern_label: string;
  readonly count_unit: CountUnit;
}

export interface Cause {
  readonly cause_id: string;
  readonly section: CauseSection;
  readonly name: string;
  readonly explanation: string;
  readonly fix_label: string;
  readonly keys: readonly CauseKey[];
}

export const CAUSES: readonly Cause[] = [
  // --- Avoidable spend ---
  {
    cause_id: "CONTEXT_TOO_LARGE",
    section: "spend",
    name: "Context grows too large before it is compacted",
    explanation: "Every turn re-reads the whole context, so long sessions get expensive late.",
    fix_label: "Fix: compact earlier",
    keys: [
      {
        detector_id: "D2",
        id: "D2_LONG_FULL_CONTEXT",
        pattern_label: "Long session, no compaction",
        count_unit: "sessions",
      },
    ],
  },
  {
    cause_id: "CACHE_REBUILT_MID_SESSION",
    section: "spend",
    name: "The cache is rebuilt mid-session",
    explanation:
      "The prompt cache expired or broke, so the context was written again at the write price.",
    fix_label: "Fix: keep the cache warm",
    keys: [
      {
        detector_id: "B1",
        id: "B1_CACHE_READ_COLLAPSE",
        pattern_label: "Cache read collapsed",
        count_unit: "sessions",
      },
      {
        detector_id: "B2",
        id: "B2_TTL_GAP_MISS",
        pattern_label: "Cache expired between turns",
        count_unit: "sessions",
      },
      {
        detector_id: "B3",
        id: "B3_RESUME_CACHE_MISS",
        pattern_label: "Resume missed the cache",
        count_unit: "sessions",
      },
      {
        detector_id: "B4",
        id: "B4_MID_SESSION_PREFIX_BREAK",
        pattern_label: "Prefix changed mid-session",
        count_unit: "sessions",
      },
      {
        detector_id: "D8",
        id: "D8_CACHE_WRITE_CHURN",
        pattern_label: "Cache rewritten repeatedly",
        count_unit: "sessions",
      },
    ],
  },
  {
    cause_id: "TOOL_RESULTS_TOO_LARGE",
    section: "spend",
    name: "Tool results are too large",
    explanation: "Big command, MCP or subagent outputs land in context and are re-read every turn.",
    fix_label: "Fix: trim large outputs",
    keys: [
      {
        detector_id: "A1",
        id: "A1_TOOL_RESULT_BLOAT",
        pattern_label: "Oversized tool result",
        count_unit: "sessions",
      },
      {
        detector_id: "A2",
        id: "A2_BACKGROUND_AGENT_TRANSCRIPT_BLOAT",
        pattern_label: "Oversized subagent transcript",
        count_unit: "sessions",
      },
      {
        detector_id: "D6",
        id: "D6_TOOL_RESULT_BLOAT",
        pattern_label: "Tool output dominates context",
        count_unit: "sessions",
      },
      {
        detector_id: "C11",
        id: "C11_MCP_OUTPUT_CAP",
        pattern_label: "MCP output hit the cap",
        count_unit: "sessions",
      },
    ],
  },
  {
    cause_id: "ALWAYS_LOADED_TOO_BIG",
    section: "spend",
    name: "Always-loaded context is too big",
    explanation: "CLAUDE.md, memory and tool catalogs load on every turn whether used or not.",
    fix_label: "Fix: trim always-loaded context",
    keys: [
      {
        detector_id: "D1",
        id: "D1_CONTEXT_ALWAYS_LOADED",
        pattern_label: "Always-loaded context too big",
        count_unit: "sessions",
      },
      {
        detector_id: "D10",
        id: "D10_CATALOG_FOOTPRINT",
        pattern_label: "Tool catalog too big",
        count_unit: "sessions",
      },
    ],
  },
  {
    cause_id: "MODEL_BIGGER_THAN_NEEDED",
    section: "spend",
    name: "A bigger model than the work needs",
    explanation:
      "Opus doing lookup or routine work that Sonnet could serve, in subagents or in the main session.",
    fix_label: "Fix: route to a smaller model",
    keys: [
      {
        detector_id: "D4",
        id: "D4_MODEL_MISMATCH",
        pattern_label: "Opus used for lookup work",
        count_unit: "sessions",
      },
      {
        detector_id: "E2",
        id: "E2_MAIN_THREAD_MECHANICAL_RUNS",
        pattern_label: "Routine runs on the main model",
        count_unit: "sessions",
      },
    ],
  },
  {
    cause_id: "LONG_ORIENTATION_BEFORE_EDIT",
    section: "spend",
    name: "Sessions read around before the first edit",
    explanation: "Some sessions make many more calls than usual before they change anything.",
    fix_label: "Fix: name where to start",
    keys: [
      {
        detector_id: "E1",
        id: "E1_ORIENTATION_BEFORE_FIRST_EDIT",
        pattern_label: "Long start before the first edit",
        count_unit: "sessions",
      },
    ],
  },
  {
    cause_id: "SUBAGENTS_COST_MORE_THAN_RETURN",
    section: "spend",
    name: "Subagents cost more than they return",
    explanation: "Too many or forked subagents each re-read a large context.",
    fix_label: "Fix: scope subagent returns",
    keys: [
      {
        detector_id: "D12",
        id: "D12_SUBAGENT_OVERSPAWN",
        pattern_label: "Subagent returns too large",
        count_unit: "sessions",
      },
      {
        detector_id: "D9",
        id: "D9_BACKGROUND_SESSION",
        pattern_label: "Too many forked subagents",
        count_unit: "sessions",
      },
    ],
  },
  {
    cause_id: "SAME_FILES_REREAD_ACROSS_SESSIONS",
    section: "spend",
    name: "The same files are read again across sessions",
    explanation: "Work re-reads content that an earlier session already loaded.",
    fix_label: "Fix: stop re-reading the same files",
    keys: [
      {
        detector_id: "D7",
        id: "D7_CROSS_SESSION_REREAD",
        pattern_label: "Same files re-read across sessions",
        count_unit: "sessions",
      },
    ],
  },

  // --- Reliability ---
  {
    cause_id: "BLOCKED_BY_PERMISSIONS",
    section: "reliability",
    name: "Tool calls blocked by permissions",
    explanation: "A hook, a deny rule or you stopped a call, so the agent had to re-plan.",
    fix_label: "Fix: update allow-list",
    keys: [
      {
        detector_id: "C9",
        id: "C9_DENIAL_FRICTION",
        pattern_label: "Blocked by permissions",
        count_unit: "events",
      },
    ],
  },
  {
    cause_id: "INTERRUPTED_OR_CANCELLED",
    section: "reliability",
    name: "You interrupted or cancelled the agent",
    explanation: "Tool calls were stopped part-way, often after the agent went off track.",
    fix_label: "Fix: avoid interrupting mid-task",
    keys: [
      {
        detector_id: "D14",
        id: "D2",
        pattern_label: "Interrupted mid-task",
        count_unit: "failing turns",
      },
    ],
  },
  {
    cause_id: "SHELL_FAILS_IN_BURSTS",
    section: "reliability",
    name: "Shell commands fail in bursts",
    explanation: "The same kind of command fails 3+ times in a row (wrong shell, missing tool).",
    fix_label: "Fix: pin the shell",
    keys: [
      {
        detector_id: "C7",
        id: "C7_BASH_FAILURE_CLUSTER",
        pattern_label: "Shell command failure burst",
        count_unit: "failing turns",
      },
    ],
  },
  {
    cause_id: "TOOLS_FAIL_MORE_THAN_USUAL",
    section: "reliability",
    name: "Tools fail more often than usual",
    explanation: "One tool's error rate is an outlier, or a failure landed in an expensive turn.",
    fix_label: "Fix: route around the failing tool",
    keys: [
      {
        detector_id: "C1",
        id: "C1_TOOL_ERROR_RATE",
        pattern_label: "Tool error rate outlier",
        count_unit: "failing turns",
      },
      {
        detector_id: "D11",
        id: "D11_TOOL_ERROR_RATE",
        pattern_label: "Shell error rate outlier",
        count_unit: "failing turns",
      },
      {
        detector_id: "G11",
        id: "G11_HIGH_SPEND_OBSERVED_FAILURE",
        pattern_label: "Failure in an expensive turn",
        count_unit: "findings",
      },
    ],
  },
  {
    cause_id: "AGENT_REPEATS_SAME_ERROR",
    section: "reliability",
    name: "The agent repeats the same error",
    explanation: "It retries a failing step without changing approach.",
    fix_label: "Fix: bound retries",
    keys: [
      {
        detector_id: "C5",
        id: "C5_SAME_ERROR_LOOP",
        pattern_label: "Repeats the same error",
        count_unit: "repeated calls",
      },
      {
        detector_id: "D7",
        id: "D7_RETRY_LOOP",
        pattern_label: "Retries without changing approach",
        count_unit: "repeated calls",
      },
    ],
  },
  {
    cause_id: "EDITS_FAIL_OR_UNDONE",
    section: "reliability",
    name: "Edits fail or get undone",
    explanation:
      "Edits before reading, failed edit recoveries, or flip-flopping on the same lines.",
    fix_label: "Fix: read before editing",
    keys: [
      {
        detector_id: "C3",
        id: "C3_EDIT_BEFORE_READ",
        pattern_label: "Edited before reading",
        count_unit: "failing turns",
      },
      {
        detector_id: "C4",
        id: "C4_FAILED_EDIT_RECOVERY_LOOP",
        pattern_label: "Failed edit recovery loop",
        count_unit: "failing turns",
      },
      {
        detector_id: "C6",
        id: "C6_EDIT_FLIP_FLOP",
        pattern_label: "Flip-flopped on the same lines",
        count_unit: "findings",
      },
    ],
  },
  {
    cause_id: "SEARCHES_FOR_MISSING_CONTENT",
    section: "reliability",
    name: "The agent looks for things that aren't there",
    explanation: "Searches and reads for files or content that don't exist.",
    fix_label: "Fix: verify paths before searching",
    keys: [
      {
        detector_id: "C2",
        id: "C2_CONTENT_NOT_FOUND",
        pattern_label: "Searched for content that doesn't exist",
        count_unit: "failing turns",
      },
    ],
  },
  {
    cause_id: "DESTRUCTIVE_COMMANDS_RAN",
    section: "risk",
    name: "Destructive commands ran",
    explanation: "Deletes, force-pushes or resets. A risk to review, not a cost.",
    fix_label: "Fix: review destructive commands",
    keys: [
      {
        detector_id: "H1",
        id: "H1_DESTRUCTIVE_OPERATION_REPORT",
        pattern_label: "Destructive command ran",
        count_unit: "events",
      },
    ],
  },
] as const;

/**
 * Keys excluded from the registry on purpose, with the reason. AE5's test treats these as
 * intentional gaps, not missing mappings.
 */
export const EXCLUDED_KEYS: readonly { detector_id: string; id: string; reason: string }[] = [
  {
    detector_id: "D5",
    id: "D5_LIMIT_BURN_DEGRADED",
    reason: "A warning about future usage, not a cause of past spend.",
  },
  {
    detector_id: "D5",
    id: "D5_LIMIT_BURN_WARNING",
    reason: "A warning about future usage, not a cause of past spend.",
  },
];

/**
 * Returns the cause for a (detector_id, id) key. Throws for an unknown key — callers catch and
 * skip that key at runtime rather than bucket it into a fallback cause.
 */
export function causeForKey(detectorId: string, id: string): Cause {
  for (const cause of CAUSES) {
    for (const key of cause.keys) {
      if (key.detector_id === detectorId && key.id === id) return cause;
    }
  }
  throw new Error(`diagnostics-causes: no cause registered for key (${detectorId}, ${id})`);
}
