import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  CHECKS,
  GATES,
  MIN_CATEGORY_CHECKS,
  SEVERITY_WEIGHT,
  TIER_FLOORS,
  TIER_NAMES,
} from "../../src/detector/check-registry.js";
import { signalIds } from "../../src/detector/setup-grade.js";

describe("check registry shape", () => {
  it("has a modest honest inventory across the 7 categories", () => {
    expect(CHECKS.length).toBeGreaterThanOrEqual(20);
    expect(CHECKS.length).toBeLessThanOrEqual(35);
    expect(Object.keys(CATEGORIES)).toHaveLength(7);
    for (const key of Object.keys(CATEGORIES)) {
      const n = CHECKS.filter((c) => c.category === key).length;
      expect(n, key).toBeGreaterThanOrEqual(MIN_CATEGORY_CHECKS);
    }
  });

  it("weights context hygiene highest", () => {
    const max = Math.max(...Object.values(CATEGORIES).map((c) => c.weight));
    expect(CATEGORIES.context_hygiene.weight).toBe(max);
  });

  it("has unique ids and a bound signal for every entry", () => {
    const ids = CHECKS.map((c) => c.check_id);
    expect(new Set(ids).size).toBe(ids.length);
    const signals = new Set(signalIds());
    for (const c of CHECKS) expect(signals.has(c.signal), c.check_id).toBe(true);
  });

  it("cites every entry with a URL, date and version tag", () => {
    for (const c of CHECKS) {
      expect(c.source_url, c.check_id).toMatch(/^https:\/\//);
      expect(c.source_date, c.check_id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.version_tag, c.check_id).not.toBe("");
      expect(Number.isNaN(Date.parse(c.version_date)), c.check_id).toBe(false);
      expect(c.stale_after_days, c.check_id).toBeGreaterThan(0);
      expect(c.severity in SEVERITY_WEIGHT, c.check_id).toBe(true);
    }
  });

  it("declares explicit minimum-data thresholds and sane scoring bands", () => {
    for (const c of CHECKS) {
      expect(c.eligibility.min_sample, c.check_id).toBeGreaterThan(0);
      expect(c.eligibility.min_window_days, c.check_id).toBeGreaterThanOrEqual(0);
      expect(c.eligibility.needs, c.check_id).not.toBe("");
      const { direction, pass, partial } = c.scoring;
      if (direction === "higher") expect(pass, c.check_id).toBeGreaterThanOrEqual(partial);
      else expect(pass, c.check_id).toBeLessThanOrEqual(partial);
    }
    // Behavior checks always need a window; config checks never do.
    for (const c of CHECKS) {
      if (c.eligibility.condition === "config_scan") expect(c.eligibility.min_window_days).toBe(0);
      else expect(c.eligibility.min_window_days).toBeGreaterThan(0);
    }
  });

  it("replaces the plan-mode and /clear habit checks with outcome checks (JMS U12)", () => {
    const ids = CHECKS.map((c) => c.check_id);
    expect(ids).not.toContain("plan_mode_use");
    expect(ids).not.toContain("clear_usage");
    expect(GATES.map((g) => g.gate_id)).toEqual(["G-verify", "G-explore", "G-context"]);
    const auto = CHECKS.find((c) => c.check_id === "autonomy_depth");
    expect(auto?.category).toBe("cost_efficiency");
    expect(GATES.some((g) => g.check_id === "autonomy_depth")).toBe(false);
  });

  it("references real checks from gates and uses valid tier names", () => {
    const ids = new Set(CHECKS.map((c) => c.check_id));
    for (const g of GATES) {
      expect(ids.has(g.check_id), g.gate_id).toBe(true);
      expect(TIER_NAMES.includes(g.boundary), g.gate_id).toBe(true);
      expect(TIER_NAMES.indexOf(g.boundary), g.gate_id).toBeGreaterThan(0);
    }
    for (const c of CHECKS) {
      if (c.cap) expect(TIER_NAMES.includes(c.cap.tier), c.check_id).toBe(true);
    }
    expect(TIER_FLOORS).toHaveLength(TIER_NAMES.length);
  });

  it("registers the three security disqualifiers with the specified caps", () => {
    const cap = (id: string) => CHECKS.find((c) => c.check_id === id)?.cap?.tier;
    expect(cap("no_allow_all_bash")).toBe("Practitioner");
    expect(cap("safe_default_mode")).toBe("Practitioner");
    expect(cap("secrets_deny_rule")).toBe("Operator");
  });

  it("never frames a check on approval counts", () => {
    for (const c of CHECKS) {
      expect(`${c.signal} ${c.threshold.rationale}`.toLowerCase(), c.check_id).not.toMatch(
        /approval count|approvals? per|approved/,
      );
    }
  });
});
