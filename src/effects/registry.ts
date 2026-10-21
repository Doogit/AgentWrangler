import type { RegisteredHandler } from "./types.js";

const commonSessionEligibility =
  "RECONCILED sessions in frozen scope with last_turn_at in half-open window; non-provisional evidence only";

/** Append-only implementation archive used to execute persisted cycles. */
export const FROZEN_EFFECT_METHODS: readonly RegisteredHandler[] = [
  {
    detectorId: "D1",
    aliases: ["avg_context_per_turn", "SOURCE_CONTEXT_TOKENS", "context_source_tokens"],
    target: {
      metricId: "d1-source-tokens",
      methodVersion: "d1-source-tokens-v2",
      unit: "tokens",
      sampleUnit: "source observation",
      aggregation: "point value",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -5,
      worseningThreshold: 5,
      eligibleDefinition: "latest distinct opaque-source observation after application",
      excludedDefinition: "unchanged or unresolved source observations",
      denominatorDefinition: "nonzero baseline token point",
      boundaryRule: "baseline <= applied_at; after > applied_at and <= observation_to",
      minimumSessions: null,
    },
    guardrails: [
      { guardrailId: "d2-context-exposure", methodVersion: "d2-floor-context-v2", unit: "tokens" },
      { guardrailId: "reported-repair-usefulness", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    detectorId: "D2",
    aliases: ["avg_context_per_turn", "CACHE_READ_TOKENS_PER_WK", "floor_context_tokens"],
    target: {
      metricId: "d2-floor-context",
      methodVersion: "d2-floor-context-v2",
      unit: "tokens",
      sampleUnit: "session",
      aggregation: "mean of per-session minima",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -15,
      worseningThreshold: 15,
      eligibleDefinition: commonSessionEligibility,
      excludedDefinition: "LIVE, provisional, or out-of-window sessions",
      denominatorDefinition: "distinct eligible sessions",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      { guardrailId: "reported-lost-progress", methodVersion: "esf3-pending", unit: "reports" },
      { guardrailId: "operational-friction", methodVersion: "esf3-pending", unit: "reports" },
      {
        guardrailId: "api-error-rate",
        methodVersion: "unavailable-request-exposure",
        unit: "percent",
      },
    ],
  },
  {
    detectorId: "D2",
    aliases: ["floor_context_tokens_scoped"],
    target: {
      metricId: "d2-floor-context-scoped",
      methodVersion: "d2-floor-context-scoped-v1",
      unit: "tokens",
      sampleUnit: "session",
      aggregation: "mean of per-session minima for sessions selected by scoped tool events",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -15,
      worseningThreshold: 15,
      eligibleDefinition:
        "RECONCILED sessions ending in the half-open window with valid exact-scope event ownership; non-provisional turns only",
      excludedDefinition:
        "LIVE, provisional, malformed, ambiguous-owner, out-of-window, or out-of-scope evidence",
      denominatorDefinition: "distinct eligible scoped sessions",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      {
        guardrailId: "completed-tool-error-rate",
        methodVersion: "completed-tool-error-rate-v1",
        unit: "ratio",
        minimumSessions: 10,
        directional: true,
      },
      {
        guardrailId: "strict-test-recovery-sequences",
        methodVersion: "strict-test-recovery-sequences-v1",
        unit: "count",
        minimumSessions: 10,
        directional: false,
      },
      {
        guardrailId: "interruption-burden",
        methodVersion: "unsupported-v1",
        unit: "interruptions",
        minimumSessions: 10,
        directional: false,
      },
    ],
  },
  {
    detectorId: "D4",
    aliases: ["model_mix_opus_fraction", "ROUTING_ADHERENCE_SCORE", "premium_share"],
    target: {
      metricId: "d4-premium-share",
      methodVersion: "d4-premium-share-v2",
      unit: "percentage_points",
      sampleUnit: "eligible turn",
      aggregation: "100 * (1 - ratio of premium turns to eligible turns)",
      deltaSemantics: "PERCENTAGE_POINTS",
      improvementThreshold: 10,
      worseningThreshold: -10,
      eligibleDefinition: `${commonSessionEligibility}; turn ts in window; non-sidechain`,
      excludedDefinition: "LIVE, provisional, sidechain, synthetic, or out-of-window turns",
      denominatorDefinition: "eligible turns; distinct contributing sessions recorded separately",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      {
        guardrailId: "reported-useful-completion-repair",
        methodVersion: "esf3-pending",
        unit: "outcome",
      },
      {
        guardrailId: "independent-first-review",
        methodVersion: "g2-fra-pending",
        unit: "acceptance",
      },
    ],
  },
  {
    detectorId: "D7",
    aliases: ["loop_flagged_turn_share"],
    target: {
      metricId: "d7-loop-flagged-turn-share",
      methodVersion: "d7-loop-flagged-turn-share-v1",
      unit: "ratio",
      sampleUnit: "session",
      aggregation: "unweighted mean of per-session distinct flagged owner-turn share",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -15,
      worseningThreshold: 15,
      eligibleDefinition:
        "RECONCILED sessions ending in the half-open window with valid exact-scope event ownership; quiet eligible sessions contribute zero",
      excludedDefinition:
        "LIVE, provisional, malformed, ambiguous-owner, out-of-window, or out-of-scope evidence",
      denominatorDefinition:
        "distinct eligible sessions; exposure is distinct eligible owner turns",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      {
        guardrailId: "completed-tool-error-rate",
        methodVersion: "completed-tool-error-rate-v1",
        unit: "ratio",
        minimumSessions: 10,
        directional: true,
      },
      {
        guardrailId: "strict-test-recovery-sequences",
        methodVersion: "strict-test-recovery-sequences-v1",
        unit: "count",
        minimumSessions: 10,
        directional: false,
      },
      {
        guardrailId: "interruption-burden",
        methodVersion: "unsupported-v1",
        unit: "interruptions",
        minimumSessions: 10,
        directional: false,
      },
    ],
  },
  {
    detectorId: "D8",
    // Retired from new cycles by P3.2-F3: its alias moved to d8-idle-rewrite-tokens.
    aliases: [],
    target: {
      metricId: "d8-cache-ratio",
      methodVersion: "d8-cache-ratio-v2",
      unit: "ratio",
      sampleUnit: "eligible turn",
      aggregation: "sum cache reads / sum cache creation",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: 15,
      worseningThreshold: -15,
      eligibleDefinition: `${commonSessionEligibility}; turn ts in window; non-sidechain`,
      excludedDefinition: "LIVE, provisional, sidechain, synthetic, or out-of-window turns",
      denominatorDefinition: "sum 5m + 1h + other creation tokens",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      {
        guardrailId: "interruption-burden",
        methodVersion: "unsupported-v1",
        unit: "interruptions",
      },
      { guardrailId: "completion-repair", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    // P3.2-F3: measures what D8 prices (idle re-write creation), not the read/creation ratio.
    detectorId: "D8",
    // The D8 descriptor's target_metric; kept so cards and tracking resolve to this method.
    aliases: ["cache_read_to_creation_ratio"],
    target: {
      metricId: "d8-idle-rewrite-tokens",
      methodVersion: "d8-idle-rewrite-tokens-v1",
      unit: "tokens",
      sampleUnit: "eligible turn",
      aggregation:
        "sum creation of turns meeting the D8 condition (cacheThreadSteps: gap > thread TTL, creation >= 50k, reads < 0.2 x creation) / eligible turns",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -15,
      worseningThreshold: 15,
      eligibleDefinition: `${commonSessionEligibility}; turn ts in window; non-sidechain; same-session history before the window sets each turn's predecessor`,
      excludedDefinition: "LIVE, provisional, sidechain, synthetic, or out-of-window turns",
      denominatorDefinition: "eligible turns",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      {
        guardrailId: "interruption-burden",
        methodVersion: "unsupported-v1",
        unit: "interruptions",
      },
      { guardrailId: "completion-repair", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    detectorId: "B2",
    // The B2 descriptor's target_metric. B1 shares it but has no handler: lookups are per detector.
    aliases: ["cache_read_tokens"],
    target: {
      metricId: "b2-cold-resume-tokens",
      methodVersion: "b2-cold-resume-tokens-v1",
      unit: "tokens",
      sampleUnit: "eligible turn",
      aggregation:
        "sum previous-turn cache reads over B2 pairs (gap > 1h, previous reads > 20k, current reads < 10%) / eligible turns",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -15,
      worseningThreshold: 15,
      eligibleDefinition: `${commonSessionEligibility}; turn ts in window; non-sidechain; same-session history before the window sets each turn's predecessor`,
      excludedDefinition: "LIVE, provisional, sidechain, synthetic, or out-of-window turns",
      denominatorDefinition: "eligible turns",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      { guardrailId: "completion-repair", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    detectorId: "D11",
    aliases: ["shell_error_rate"],
    target: {
      metricId: "d11-shell-error-rate",
      methodVersion: "d11-shell-error-rate-v1",
      unit: "ratio",
      sampleUnit: "shell call",
      aggregation: "error shell calls / all shell calls",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -20,
      worseningThreshold: 20,
      eligibleDefinition: `${commonSessionEligibility}; main-thread non-provisional owners and events in window`,
      excludedDefinition:
        "LIVE, sidechain, provisional, missing or ambiguous owner, out-of-window evidence",
      denominatorDefinition: "eligible Bash and PowerShell calls",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      { guardrailId: "reported-repair-usefulness", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    detectorId: "C5",
    aliases: ["same_error_loop_count"],
    target: {
      metricId: "c5-same-error-loop-count",
      methodVersion: "c5-same-error-loop-count-v1",
      unit: "loops per 100 sessions",
      sampleUnit: "session",
      aggregation:
        "100 * identical-error clusters of at least 3 / eligible sessions; cluster by session, tool, normalized retained error text (legacy class fallback), classifier tool-error-1",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -20,
      worseningThreshold: 20,
      eligibleDefinition: `${commonSessionEligibility}; main-thread non-provisional owners and events in window`,
      excludedDefinition:
        "LIVE, sidechain, provisional, missing or ambiguous owner, out-of-window evidence",
      denominatorDefinition: "distinct eligible sessions, including quiet sessions",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      { guardrailId: "reported-repair-usefulness", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    // P3.A (d), operator OK 2026-09-28. The guard stays strict, so a guard card counts calls in the
    // watched shapes whether blocked or not: loosening the guard cannot read as a fix.
    detectorId: "C9",
    aliases: ["denial_friction_count"],
    target: {
      metricId: "c9-denial-friction",
      methodVersion: "c9-denial-friction-v1",
      unit: "calls per 100 sessions",
      sampleUnit: "session",
      aggregation:
        "100 * counted calls / eligible sessions. HOOK_BLOCK: Bash and PowerShell calls whose command has a guard shape in the frozen scope.guardShapes, blocked or not (OTHER never counts). DENY_RULE / USER_REJECTED: non-interrupt main-thread denial events of the scope's kind",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -20,
      worseningThreshold: 20,
      eligibleDefinition: `${commonSessionEligibility}; main-thread non-provisional owners and events in window`,
      excludedDefinition:
        "LIVE, sidechain, provisional, missing or ambiguous owner, out-of-window evidence; shell calls whose command cannot be read",
      denominatorDefinition: "distinct eligible sessions, including quiet sessions",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
    },
    guardrails: [
      { guardrailId: "reported-repair-usefulness", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    // P3.A (d), operator OK 2026-09-28. A flat rate over the card's outlier tools, frozen at
    // tracking, in every workspace like the card. Dropping a tool reads as too few calls, not a fix.
    detectorId: "C1",
    aliases: ["tool_error_rate"],
    target: {
      metricId: "c1-tool-error-rate",
      methodVersion: "c1-tool-error-rate-v1",
      unit: "errors per 100 calls",
      sampleUnit: "tool call",
      aggregation:
        "100 * failed calls / calls of the tools in the frozen scope.tools. Failed = ERROR or TEST_FAIL and not a benign failure (C1's own rule)",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -20,
      worseningThreshold: 20,
      eligibleDefinition: `${commonSessionEligibility}; main-thread non-provisional owners and events in window; all workspaces`,
      excludedDefinition:
        "LIVE, sidechain, provisional, missing or ambiguous owner, out-of-window evidence",
      denominatorDefinition: "eligible calls of the frozen tools",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
      minimumCalls: 50,
    },
    guardrails: [
      { guardrailId: "reported-repair-usefulness", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
  {
    // P3.A (d), operator OK 2026-09-28. Bytes from the card's lead file, pinned at tracking, per
    // session: smaller reads, a summary, a split file or no reads at all all lower it.
    detectorId: "A1",
    aliases: ["tool_result_bytes"],
    target: {
      metricId: "a1-file-result-bytes",
      methodVersion: "a1-file-result-bytes-v1",
      unit: "result bytes per session",
      sampleUnit: "session",
      aggregation:
        "Sum of result_bytes of calls (any tool, any size) whose file matches the frozen scope.files / eligible sessions",
      deltaSemantics: "RELATIVE_PERCENT",
      improvementThreshold: -20,
      worseningThreshold: 20,
      eligibleDefinition: `${commonSessionEligibility}; main-thread non-provisional owners and events in window; card workspace`,
      excludedDefinition:
        "LIVE, sidechain, provisional, missing or ambiguous owner, out-of-window evidence, result size not recorded",
      denominatorDefinition: "eligible main-thread sessions in the workspace",
      boundaryRule: "[from,to)",
      minimumSessions: 10,
      minimumBaselineCalls: 20,
    },
    guardrails: [
      { guardrailId: "reported-repair-usefulness", methodVersion: "esf3-pending", unit: "outcome" },
    ],
  },
] as const;

/** Active selection view. Entries may retire without deleting their frozen implementation. */
export const EFFECT_HANDLERS: readonly RegisteredHandler[] = FROZEN_EFFECT_METHODS;

export function findHandler(
  detectorId: string,
  targetMetric: string,
  methodVersion?: string,
): RegisteredHandler | null {
  const handler = EFFECT_HANDLERS.find(
    (candidate) =>
      candidate.detectorId === detectorId &&
      (candidate.target.metricId === targetMetric || candidate.aliases.includes(targetMetric)) &&
      (methodVersion === undefined || methodVersion === candidate.target.methodVersion),
  );
  return handler ?? null;
}

/**
 * Resolves an already-frozen implementation. This archive is deliberately
 * independent from active recommendation selection: removing an active
 * selector must not change an in-flight cycle's measurement semantics.
 */
export function findFrozenHandler(
  detectorId: string,
  metricId: string,
  methodVersion: string,
  target: unknown,
  guardrails: unknown,
): RegisteredHandler | null {
  const handler = FROZEN_EFFECT_METHODS.find(
    (candidate) =>
      candidate.detectorId === detectorId &&
      candidate.target.metricId === metricId &&
      candidate.target.methodVersion === methodVersion &&
      JSON.stringify(candidate.target) === JSON.stringify(target) &&
      JSON.stringify(candidate.guardrails) === JSON.stringify(guardrails),
  );
  return handler ?? null;
}

export function directionFor(
  handler: RegisteredHandler,
  before: number | null,
  after: number | null,
): {
  delta: number | null;
  direction: "IMPROVED" | "UNCHANGED" | "WORSENED" | "INSUFFICIENT_DATA";
} {
  if (before === null || after === null) return { delta: null, direction: "INSUFFICIENT_DATA" };
  const target = handler.target;
  if (target.deltaSemantics === "RELATIVE_PERCENT") {
    if (before === 0) return { delta: null, direction: "INSUFFICIENT_DATA" };
    const delta = ((after - before) / before) * 100;
    const improve = target.improvementThreshold;
    const worsen = target.worseningThreshold;
    if (improve < worsen) {
      return {
        delta,
        direction: delta < improve ? "IMPROVED" : delta > worsen ? "WORSENED" : "UNCHANGED",
      };
    }
    return {
      delta,
      direction: delta > improve ? "IMPROVED" : delta < worsen ? "WORSENED" : "UNCHANGED",
    };
  }
  const delta = after - before;
  return {
    delta,
    direction:
      delta > target.improvementThreshold
        ? "IMPROVED"
        : delta < target.worseningThreshold
          ? "WORSENED"
          : "UNCHANGED",
  };
}
