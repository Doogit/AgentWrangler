import type { RegisteredHandler } from "./types.js";

const commonSessionEligibility =
  "RECONCILED sessions in frozen scope with last_turn_at in half-open window; non-provisional evidence only";

export const EFFECT_HANDLERS: readonly RegisteredHandler[] = [
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
    aliases: ["cache_read_to_creation_ratio"],
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
] as const;

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
