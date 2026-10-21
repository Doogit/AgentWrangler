/**
 * Deterministic RIQ6 release-gate tests over SYNTHETIC scorecards. No provider
 * call, no model output — this fixes the §RIQ6 success criteria as fixture tests
 * BEFORE any authorized provider run, per the spec and the master plan.
 */
import { describe, expect, it } from "vitest";
import {
  RIQ6_ANSWER_KEYS,
  RIQ6_DIMENSIONS,
  type Riq6Dimension,
} from "../fixtures/riq6/answer-keys.js";
import { RIQ6_CASES } from "../fixtures/riq6/cases.js";
import { evaluateReleaseGate } from "../fixtures/riq6/release-gate.js";
import {
  type DimensionScore,
  RIQ6_RUN_CONFIG,
  type Riq6Comparator,
  type Riq6CriticalError,
  type Riq6Scorecard,
} from "../fixtures/riq6/scorecard.js";

const CASE_IDS = RIQ6_CASES.map((caseDefinition) => caseDefinition.case_id);
const FIRST_CASE = CASE_IDS[0];
if (FIRST_CASE === undefined) throw new Error("RIQ6_CASES is empty");
const PASS = { deterministicInvariantsPass: true } as const;

function dims(score: DimensionScore): Record<Riq6Dimension, DimensionScore> {
  return Object.fromEntries(RIQ6_DIMENSIONS.map((dimension) => [dimension, score])) as Record<
    Riq6Dimension,
    DimensionScore
  >;
}

interface CardOptions {
  available?: boolean;
  safe?: boolean;
  reviewerTwoScore?: DimensionScore;
  criticalErrors?: readonly Riq6CriticalError[];
}

function card(
  caseId: string,
  comparator: Riq6Comparator,
  trial: number,
  score: DimensionScore,
  options: CardOptions = {},
): Riq6Scorecard {
  return {
    case_id: caseId,
    comparator,
    trial_index: trial,
    available: options.available ?? true,
    reviewer_scores: [
      {
        reviewer_id: "r1",
        dimensions: dims(score),
        critical_errors: options.criticalErrors ?? [],
        selected_safe_response: options.safe ?? true,
        time_to_correct_decision_ms: 1000,
        abandoned_or_timed_out: false,
      },
      {
        reviewer_id: "r2",
        dimensions: dims(options.reviewerTwoScore ?? score),
        critical_errors: [],
        selected_safe_response: options.safe ?? true,
        time_to_correct_decision_ms: 1100,
        abandoned_or_timed_out: false,
      },
    ],
  };
}

/** A full deck: subject D plus the given prompt comparators, all cases, all trials. */
function deck(params: {
  subjectScore: DimensionScore;
  comparatorScore: DimensionScore;
  comparators?: readonly Riq6Comparator[];
}): Riq6Scorecard[] {
  const comparators = params.comparators ?? ["B_CLAUDE_PROMPT", "C_CODEX_PROMPT"];
  const cards: Riq6Scorecard[] = [];
  for (const caseId of CASE_IDS) {
    for (let trial = 0; trial < RIQ6_RUN_CONFIG.trials_per_case; trial++) {
      cards.push(card(caseId, "D_PROPOSED_TAB", trial, params.subjectScore));
      for (const comparator of comparators) {
        cards.push(card(caseId, comparator, trial, params.comparatorScore));
      }
    }
  }
  return cards;
}

describe("RIQ6 release gate", () => {
  it("PASS: subject beats both prompt comparators on every dimension", () => {
    const result = evaluateReleaseGate(
      deck({ subjectScore: 2, comparatorScore: 1 }),
      RIQ6_RUN_CONFIG,
      PASS,
    );
    expect(result.verdict).toBe("PASS");
    expect(result.kappa).toBeGreaterThanOrEqual(RIQ6_RUN_CONFIG.kappa_floor);
    expect(result.per_comparator).toHaveLength(2);
    expect(result.per_comparator.every((entry) => entry.passes)).toBe(true);
  });

  it("PASS: subject exactly ties the comparators (>= is met)", () => {
    const result = evaluateReleaseGate(
      deck({ subjectScore: 1, comparatorScore: 1 }),
      RIQ6_RUN_CONFIG,
      PASS,
    );
    expect(result.verdict).toBe("PASS");
  });

  it("FAIL: a dimension is lower in the overall case median", () => {
    const result = evaluateReleaseGate(
      deck({ subjectScore: 0, comparatorScore: 2 }),
      RIQ6_RUN_CONFIG,
      PASS,
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("prompt bar");
  });

  it("FAIL: STOP on any critical error, before scoring", () => {
    const cards = deck({ subjectScore: 2, comparatorScore: 1 });
    cards[0] = card(FIRST_CASE, "D_PROPOSED_TAB", 0, 2, { criticalErrors: ["PRIVACY_LEAK"] });
    const result = evaluateReleaseGate(cards, RIQ6_RUN_CONFIG, PASS);
    expect(result.verdict).toBe("FAIL");
    expect(result.critical_errors).toHaveLength(1);
    expect(result.reasons.join(" ")).toContain("STOP");
  });

  it("FAIL: deterministic invariants did not pass", () => {
    const result = evaluateReleaseGate(
      deck({ subjectScore: 2, comparatorScore: 1 }),
      RIQ6_RUN_CONFIG,
      {
        deterministicInvariantsPass: false,
      },
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("invariants");
  });

  it("BLOCKED_LOW_KAPPA: reviewers disagree below the floor", () => {
    // r2 scores 0 everywhere while r1 scores 2 → zero agreement, kappa 0.
    const cards: Riq6Scorecard[] = [];
    for (const caseId of CASE_IDS) {
      for (let trial = 0; trial < RIQ6_RUN_CONFIG.trials_per_case; trial++) {
        for (const comparator of ["D_PROPOSED_TAB", "B_CLAUDE_PROMPT", "C_CODEX_PROMPT"] as const) {
          cards.push(card(caseId, comparator, trial, 2, { reviewerTwoScore: 0 }));
        }
      }
    }
    const result = evaluateReleaseGate(cards, RIQ6_RUN_CONFIG, PASS);
    expect(result.verdict).toBe("BLOCKED_LOW_KAPPA");
    expect(result.kappa).toBeLessThan(RIQ6_RUN_CONFIG.kappa_floor);
  });

  it("UNVERIFIED: a prompt comparator produced no output", () => {
    const result = evaluateReleaseGate(
      deck({ subjectScore: 2, comparatorScore: 1, comparators: ["B_CLAUDE_PROMPT"] }),
      RIQ6_RUN_CONFIG,
      PASS,
    );
    expect(result.verdict).toBe("UNVERIFIED");
    expect(result.missing_comparators).toContain("C_CODEX_PROMPT");
  });

  it("does not score an unavailable comparator as a win", () => {
    // C is present but every C card is unavailable → treated as missing, not a subject win.
    const cards = deck({ subjectScore: 2, comparatorScore: 1, comparators: ["B_CLAUDE_PROMPT"] });
    for (const caseId of CASE_IDS) {
      for (let trial = 0; trial < RIQ6_RUN_CONFIG.trials_per_case; trial++) {
        cards.push(card(caseId, "C_CODEX_PROMPT", trial, 0, { available: false }));
      }
    }
    const result = evaluateReleaseGate(cards, RIQ6_RUN_CONFIG, PASS);
    expect(result.verdict).toBe("UNVERIFIED");
    expect(result.missing_comparators).toContain("C_CODEX_PROMPT");
  });

  it("FAIL: an adverse/no-change case picks an unsafe response", () => {
    const adverseCase = CASE_IDS.find(
      (caseId) => RIQ6_ANSWER_KEYS[caseId]?.expected_target === "none",
    );
    expect(adverseCase).toBeDefined();
    const cards = deck({ subjectScore: 2, comparatorScore: 1 });
    for (let index = 0; index < cards.length; index++) {
      const entry = cards[index];
      if (entry === undefined) continue;
      if (entry.case_id === adverseCase && entry.comparator === "D_PROPOSED_TAB") {
        cards[index] = card(entry.case_id, "D_PROPOSED_TAB", entry.trial_index, 2, { safe: false });
      }
    }
    const result = evaluateReleaseGate(cards, RIQ6_RUN_CONFIG, PASS);
    expect(result.verdict).toBe("FAIL");
    expect(result.adverse_failures).toContain(adverseCase);
  });

  it("freezes the run config to the fixture evidence timestamp and API-key auth", () => {
    expect(RIQ6_RUN_CONFIG.auth).toBe("api-key");
    expect(RIQ6_RUN_CONFIG.trials_per_case).toBe(3);
    expect(RIQ6_RUN_CONFIG.case_median_floor_ratio).toBe(0.8);
    // Matches cases.ts TO / evidenceAsOf so the packet the reviewers see is the frozen one.
    expect(RIQ6_RUN_CONFIG.evidence_as_of).toBe("2026-04-15T00:00:00.000Z");
  });
});
