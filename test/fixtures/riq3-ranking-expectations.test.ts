/**
 * Contract-only freeze test for the RIQ3 ranking fixtures: no ranker, no
 * comparator run, no DB, no operator data. Validates that the frozen cases and
 * hand-derived expected orderings are internally consistent with
 * docs/plans/spec-ranking-policy-1.md before any ranker code exists.
 */
import { describe, expect, it } from "vitest";
import { COMPOSER_VERSION } from "../../src/query/api/opportunity-composer-types.js";
import {
  RIQ3_CASES,
  RIQ3_COVERAGE_TAGS,
  RIQ3_EXCLUSION_REASONS,
  RIQ3_WARNING_CODES,
  RIQ3_WHY_REASONS,
  type Riq3Case,
  deriveDecisionIdentity,
} from "./riq3/cases.js";
import { RIQ3_EXPECTED_ORDERS } from "./riq3/expected-orders.js";

function opportunityIdentities(caseDefinition: Riq3Case): Set<string> {
  const identities = new Set<string>();
  for (const entry of caseDefinition.composition.families) {
    if (entry.outcome === "OPPORTUNITY") {
      identities.add(deriveDecisionIdentity(entry.family, entry.evidence_ids));
    }
  }
  return identities;
}

describe("RIQ3 frozen ranking expectations", () => {
  it("has complete frozen coverage", () => {
    // Exact count is frozen-fixture semantics: adding a case is a deliberate
    // registry change, not a drive-by.
    expect(RIQ3_CASES).toHaveLength(18);
    const ids = RIQ3_CASES.map((caseDefinition) => caseDefinition.case_id);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = new Set(RIQ3_CASES.flatMap((caseDefinition) => caseDefinition.coverage_tags));
    for (const tag of RIQ3_COVERAGE_TAGS) expect(tags).toContain(tag);
    // Every case has an expected ordering and vice versa.
    for (const id of ids) expect(RIQ3_EXPECTED_ORDERS[id]).toBeDefined();
    expect(Object.keys(RIQ3_EXPECTED_ORDERS).sort()).toEqual([...ids].sort());
  });

  it("imports versions instead of hardcoding them", () => {
    for (const caseDefinition of RIQ3_CASES) {
      expect(caseDefinition.composition.composer_version).toBe(COMPOSER_VERSION);
    }
  });

  it("keeps every referenced identity resolvable against its own case", () => {
    for (const caseDefinition of RIQ3_CASES) {
      const identities = opportunityIdentities(caseDefinition);
      const families = new Set(caseDefinition.composition.families.map((entry) => entry.family));
      const expected = RIQ3_EXPECTED_ORDERS[caseDefinition.case_id];
      expect(expected).toBeDefined();
      if (expected === undefined) continue;
      for (const decision of expected.next_decisions) {
        expect(identities).toContain(decision.decision_identity);
        expect(decision.decision_identity.startsWith(`${decision.family}:`)).toBe(true);
      }
      for (const exclusion of expected.excluded) {
        // Subject is a decision identity (contains ':') or a family id.
        if (exclusion.subject.includes(":")) {
          expect(identities).toContain(exclusion.subject);
        } else {
          expect(families).toContain(exclusion.subject);
        }
        expect(RIQ3_EXCLUSION_REASONS).toContain(exclusion.reason);
      }
      for (const cooldown of caseDefinition.options.cooldowns) {
        expect(identities).toContain(cooldown.decision_identity);
        expect(Number.isNaN(Date.parse(cooldown.until_iso))).toBe(false);
      }
      for (const conflict of caseDefinition.options.active_conflicts) {
        expect(identities).toContain(conflict);
      }
      expect(Number.isNaN(Date.parse(caseDefinition.options.as_of_iso))).toBe(false);
    }
  });

  it("uses only the closed reason and warning vocabularies", () => {
    for (const expected of Object.values(RIQ3_EXPECTED_ORDERS)) {
      for (const decision of expected.next_decisions) {
        for (const reason of decision.must_include_reasons) {
          expect(RIQ3_WHY_REASONS).toContain(reason);
        }
      }
      for (const code of expected.warning_codes) {
        expect(RIQ3_WARNING_CODES).toContain(code);
      }
    }
  });

  it("keeps expected slot budgets consistent with eligibility", () => {
    for (const caseDefinition of RIQ3_CASES) {
      const expected = RIQ3_EXPECTED_ORDERS[caseDefinition.case_id];
      if (expected === undefined) continue;
      expect(expected.next_decisions.length).toBeLessThanOrEqual(3);
      const opportunities = opportunityIdentities(caseDefinition).size;
      const excludedOpportunities = expected.excluded.filter((exclusion) =>
        exclusion.subject.includes(":"),
      ).length;
      const linked = expected.next_decisions.reduce(
        (count, decision) => count + (decision.linked_observation_families?.length ?? 0),
        0,
      );
      const eligible = opportunities - excludedOpportunities - linked;
      expect(expected.next_decisions.length).toBe(Math.min(3, eligible));
      expect(expected.overflow_count).toBe(Math.max(0, eligible - 3));
    }
  });

  it("keeps warnings tied to actual missing evidence or expiry", () => {
    for (const caseDefinition of RIQ3_CASES) {
      const expected = RIQ3_EXPECTED_ORDERS[caseDefinition.case_id];
      if (expected === undefined) continue;
      const hasInsufficient = caseDefinition.composition.families.some(
        (entry) => entry.outcome === "INSUFFICIENT_EVIDENCE",
      );
      const isExpired = caseDefinition.options.freshness.status === "EXPIRED";
      expect(expected.warning_codes.includes("MISSING_EVIDENCE")).toBe(hasInsufficient);
      expect(expected.warning_codes.includes("PACKET_EXPIRED")).toBe(isExpired);
      if (isExpired) expect(expected.next_decisions).toHaveLength(0);
    }
  });

  it("keeps usage decompositions arithmetically exact", () => {
    for (const caseDefinition of RIQ3_CASES) {
      for (const entry of caseDefinition.composition.families) {
        if (entry.outcome !== "OPPORTUNITY" || entry.detail.kind !== "USAGE_CHANGE") continue;
        const d = entry.detail.decomposition;
        expect(d.volume_term + d.intensity_term + d.UNATTRIBUTED_RESIDUAL).toBe(d.observed_delta_u);
        expect(d.n_cur * d.mean_cur_u - d.n_prior * d.mean_prior_u).toBe(d.observed_delta_u);
      }
    }
  });

  it("keeps tool and cache details internally consistent", () => {
    for (const caseDefinition of RIQ3_CASES) {
      for (const entry of caseDefinition.composition.families) {
        if (entry.outcome !== "OPPORTUNITY") continue;
        if (entry.detail.kind === "TOOL_CONCENTRATION") {
          for (const candidate of entry.detail.candidates) {
            expect(candidate.result_bytes_total).toBeLessThanOrEqual(
              entry.detail.total_result_bytes,
            );
            expect(candidate.byte_share).toBeCloseTo(
              candidate.result_bytes_total / entry.detail.total_result_bytes,
              10,
            );
          }
        }
        if (entry.detail.kind === "CACHE_BEHAVIOR") {
          const denominator = entry.detail.cache_read_tokens + entry.detail.input_tokens;
          if (denominator === 0) {
            expect(entry.detail.cache_hit_ratio).toBeNull();
          } else {
            expect(entry.detail.cache_hit_ratio).toBeCloseTo(
              entry.detail.cache_read_tokens / denominator,
              10,
            );
          }
        }
      }
    }
  });

  it("contains no estimate/score fields and no raw path-like strings (SEC-101)", () => {
    const serialized = JSON.stringify({ RIQ3_CASES, RIQ3_EXPECTED_ORDERS });
    for (const forbidden of ["savings", "roi_", "composite_score", "estimated_"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    // No filesystem-path-shaped strings: fixture strings are synthetic ids/labels.
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("home/");
  });

  // Deliberate fixture discipline: a future case exercising a genuine class 6
  // tiebreak or §9 re-surface must extend this guard in the same change —
  // conditional reasons never spread to new cases silently.
  it("keeps conditional reasons scoped to their cases", () => {
    for (const [caseId, expected] of Object.entries(RIQ3_EXPECTED_ORDERS)) {
      for (const decision of expected.next_decisions) {
        if (decision.must_include_reasons.includes("RESURFACED_MATERIAL_CHANGE")) {
          expect(caseId).toBe("resurface-material-change");
        }
        if (decision.must_include_reasons.includes("TIEBREAK_STABLE_IDENTITY")) {
          expect(caseId).toBe("tie-stable-identity");
        }
      }
    }
  });
});
