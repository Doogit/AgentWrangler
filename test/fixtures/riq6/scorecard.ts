/**
 * RIQ6 scorecard schema + frozen run config. Deterministic acceptance machinery
 * only — this file holds NO provider output, model call, or operator telemetry.
 * Scoring stays human (spec §RIQ6: model grading may assist but cannot be sole
 * judge); this schema records the reviewer scores the release gate aggregates.
 */
import type { Riq6Dimension } from "./answer-keys.js";

/** The four outputs the protocol scores (spec §RIQ6). D is the subject under test. */
export const RIQ6_COMPARATORS = [
  "A_SHIPPED_TAB",
  "B_CLAUDE_PROMPT",
  "C_CODEX_PROMPT",
  "D_PROPOSED_TAB",
] as const;
export type Riq6Comparator = (typeof RIQ6_COMPARATORS)[number];

/** The proposed tab is the subject; the same-evidence PROMPT bars it must meet. */
export const RIQ6_SUBJECT: Riq6Comparator = "D_PROPOSED_TAB";
export const RIQ6_PROMPT_COMPARATORS: readonly Riq6Comparator[] = [
  "B_CLAUDE_PROMPT",
  "C_CODEX_PROMPT",
];

/** Critical errors that STOP the run the moment one is observed (spec §RIQ6). */
export const RIQ6_CRITICAL_ERRORS = [
  "PRIVACY_LEAK",
  "INVENTED_NUMERIC_CLAIM",
  "UNSAFE_ACTION",
] as const;
export type Riq6CriticalError = (typeof RIQ6_CRITICAL_ERRORS)[number];

export type DimensionScore = 0 | 1 | 2;

/**
 * Frozen run parameters. Set BEFORE trials, never adjusted after seeing results
 * (spec §RIQ6: "Freeze this rubric before trials, not after seeing results").
 */
export interface Riq6RunConfig {
  protocol_version: string;
  /** Frozen evidence timestamp; matches the fixture `evidenceAsOf` (cases.ts TO). */
  evidence_as_of: string;
  /** Independent model trials per case, run only when separately authorized. */
  trials_per_case: number;
  /** Per-task timeout frozen before trials; a timeout is reported separately, never a fast success. */
  task_timeout_ms: number;
  /** Minimum inter-reviewer agreement (Cohen's kappa) before any score counts. */
  kappa_floor: number;
  /** Subject case-median must meet each available prompt comparator on >= this share of cases. */
  case_median_floor_ratio: number;
  /**
   * Model id per comparator; null until the authorized run fills it. A/D are
   * deterministic tool outputs ("tool"), not model calls.
   */
  models: Readonly<Record<Riq6Comparator, string | null>>;
  /** Provider auth: the API key, NEVER the shared subscription pool (see g2 memory). */
  auth: "api-key";
}

export const RIQ6_RUN_CONFIG: Riq6RunConfig = Object.freeze({
  protocol_version: "riq6-protocol-1",
  evidence_as_of: "2026-04-15T00:00:00.000Z",
  trials_per_case: 3,
  task_timeout_ms: 15 * 60_000,
  kappa_floor: 0.6,
  case_median_floor_ratio: 0.8,
  models: {
    A_SHIPPED_TAB: "tool",
    B_CLAUDE_PROMPT: null,
    C_CODEX_PROMPT: null,
    D_PROPOSED_TAB: "tool",
  },
  auth: "api-key",
});

/** One reviewer's blinded scoring of one comparator output for one trial. */
export interface Riq6ReviewerScore {
  reviewer_id: string;
  dimensions: Readonly<Record<Riq6Dimension, DimensionScore>>;
  critical_errors: readonly Riq6CriticalError[];
  /** For no-action (adverse/no-change) cases: did the output pick a defensible safe response? */
  selected_safe_response: boolean;
  /** ms from evidence shown to a submitted action+rationale passing the key; null if abandoned/timeout. */
  time_to_correct_decision_ms: number | null;
  abandoned_or_timed_out: boolean;
}

/**
 * One comparator's output for one case/trial, as scored by >= 2 independent
 * reviewers with an optional third-reviewer adjudication on disagreement.
 */
export interface Riq6Scorecard {
  case_id: string;
  comparator: Riq6Comparator;
  trial_index: number;
  /** false = the comparator produced no output; never scored as a win. */
  available: boolean;
  reviewer_scores: readonly Riq6ReviewerScore[];
  /** Third-reviewer verdict, recorded when the two reviewers disagree. */
  adjudication?: Riq6ReviewerScore;
  /** Analysis resource overhead, recorded separately (not part of the score). */
  analysis_overhead_u?: number;
}
