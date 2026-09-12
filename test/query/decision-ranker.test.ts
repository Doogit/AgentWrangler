/**
 * RIQ3 decision ranker — fixture-driven tests.
 * Consumes the 18 frozen cases and expected orderings from test/fixtures/riq3/.
 * Never modifies fixtures or the spec doc.
 */
import { describe, expect, it } from "vitest";
import {
  RANKING_POLICY_VERSION,
  type RankedDecision,
} from "../../src/query/api/decision-ranker-types.js";
import { rankDecisions } from "../../src/query/api/decision-ranker.js";
import { RIQ3_CASES } from "../fixtures/riq3/cases.js";
import { type ExpectedDecision, RIQ3_EXPECTED_ORDERS } from "../fixtures/riq3/expected-orders.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortedExcluded(exclusions: { subject: string; reason: string }[]) {
  return [...exclusions].sort((a, b) =>
    a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.reason.localeCompare(b.reason),
  );
}

function assertDecision(actual: RankedDecision, expected: ExpectedDecision, caseId: string) {
  expect(actual.decision_identity, `${caseId}: decision_identity`).toBe(expected.decision_identity);
  expect(actual.family, `${caseId}: family`).toBe(expected.family);
  for (const reason of expected.must_include_reasons) {
    expect(actual.why_ranked, `${caseId}: why_ranked must include ${reason}`).toContain(reason);
  }
  if (expected.linked_observation_families !== undefined) {
    const actualFamilies = [...actual.linked_observations.map((l) => l.family)].sort();
    const expectedFamilies = [...expected.linked_observation_families].sort();
    expect(actualFamilies, `${caseId}: linked_observation_families`).toEqual(expectedFamilies);
  }
}

// ---------------------------------------------------------------------------
// Per-case assertions
// ---------------------------------------------------------------------------

describe("decision-ranker", () => {
  for (const riq3Case of RIQ3_CASES) {
    const expected = RIQ3_EXPECTED_ORDERS[riq3Case.case_id];
    if (!expected) continue;

    it(riq3Case.case_id, () => {
      const result = rankDecisions(riq3Case.composition, riq3Case.options);

      // Policy version + packet identity echo
      expect(result.ranking_policy_version).toBe(RANKING_POLICY_VERSION);
      expect(result.packet_identity_hash).toBe(riq3Case.composition.packet_identity_hash);
      expect(result.goal).toBe(riq3Case.options.goal);

      // Exact next_decisions order
      expect(result.next_decisions).toHaveLength(expected.next_decisions.length);
      for (let i = 0; i < expected.next_decisions.length; i++) {
        assertDecision(
          result.next_decisions[i] as RankedDecision,
          expected.next_decisions[i] as ExpectedDecision,
          riq3Case.case_id,
        );
      }

      // Overflow count
      expect(result.overflow_count, `${riq3Case.case_id}: overflow_count`).toBe(
        expected.overflow_count,
      );

      // Warning codes — exact set of unique codes
      const actualCodes = [...new Set(result.warnings.map((w) => w.code))].sort();
      const expectedCodes = [...new Set(expected.warning_codes)].sort();
      expect(actualCodes, `${riq3Case.case_id}: warning_codes`).toEqual(expectedCodes);

      // Excluded — exact set, order-insensitive
      const actualExcl = sortedExcluded(result.excluded);
      const expectedExcl = sortedExcluded(
        expected.excluded.map((e) => ({ subject: e.subject, reason: e.reason })),
      );
      expect(actualExcl, `${riq3Case.case_id}: excluded`).toEqual(expectedExcl);
    });
  }

  // ---------------------------------------------------------------------------
  // Determinism check
  // ---------------------------------------------------------------------------

  it("is deterministic — two runs produce deep-equal output", () => {
    for (const riq3Case of RIQ3_CASES) {
      const r1 = rankDecisions(riq3Case.composition, riq3Case.options);
      const r2 = rankDecisions(riq3Case.composition, riq3Case.options);
      expect(r1, `determinism failed for ${riq3Case.case_id}`).toEqual(r2);
    }
  });

  // ---------------------------------------------------------------------------
  // Zero-mutation check — input composition must not be mutated
  // ---------------------------------------------------------------------------

  it("does not mutate the input composition", () => {
    for (const riq3Case of RIQ3_CASES) {
      const snapshot = JSON.stringify(riq3Case.composition);
      rankDecisions(riq3Case.composition, riq3Case.options);
      expect(JSON.stringify(riq3Case.composition), `mutation in ${riq3Case.case_id}`).toBe(
        snapshot,
      );
    }
  });
});
