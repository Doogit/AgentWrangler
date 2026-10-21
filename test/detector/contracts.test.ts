import { describe, expect, it } from "vitest";
import {
  type ConstantDecl,
  DETECTOR_CONTRACTS,
  hasAssumed,
  rangeFor,
} from "../../src/detector/contracts.js";
import { DETECTORS } from "../../src/detector/registry.js";

describe("detector quantity contracts", () => {
  it("covers exactly the evaluated registry", () => {
    const runtimeIds = DETECTORS.map((detector) => detector.id).sort();
    expect(Object.keys(DETECTOR_CONTRACTS).sort()).toEqual(runtimeIds);
  });

  it("declares a bounded W0 quantity and valid constants for each detector", () => {
    for (const id of DETECTORS.map((detector) => detector.id)) {
      const contract = DETECTOR_CONTRACTS[id];
      if (!contract) throw new Error(`Missing contract: ${id}`);
      expect(contract.quantity.trim()).not.toBe("");
      expect(contract.source.ref.trim()).not.toBe("");
      expect(contract.window).toBe("W0");
      for (const constant of contract.constants) {
        expect(constant.name.trim()).not.toBe("");
        expect(Number.isFinite(constant.value)).toBe(true);
        if (constant.status === "ASSUMED") {
          expect(constant.min).toBeLessThanOrEqual(constant.value);
          expect(constant.value).toBeLessThanOrEqual(constant.max);
        } else {
          expect(constant.citation.trim()).not.toBe("");
        }
      }
      expect(hasAssumed(id)).toBe(
        contract.constants.some((constant) => constant.status === "ASSUMED"),
      );
    }
  });

  it("records D1's distinct source propagation rules", () => {
    expect(DETECTOR_CONTRACTS.D1?.subagentScope).toEqual({
      memory: "MAIN_AND_FORK",
      claudeMd: "MAIN_AND_NONEXPLORE_SUBAGENTS",
    });
  });

  it("recomputes a priced value at the assumed multiplier bounds", () => {
    // D4's first assumed fraction is 0.5: 330 / 0.5 × [0.33, 0.7] = [218, 462].
    expect(rangeFor("D4", 330)).toEqual([218, 462]);
    // Review 3 B5: D2's fraction is measured; its split cadence and summary size do not scale
    // the saving linearly, so they give no range.
    expect(rangeFor("D2", 330)).toEqual([330, 330]);
    // C5 stays unpriced (C6 and C11 gained a wasted-turn range in RR U13).
    expect(rangeFor("C5", 330)).toEqual([330, 330]);
    expect(rangeFor("C6", 330)).toEqual([218, 462]);
  });

  it("rejects unknown ids", () => {
    expect(() => rangeFor("UNKNOWN", 330)).toThrow();
    expect(() => hasAssumed("UNKNOWN")).toThrow();
  });
});

// @ts-expect-error ASSUMED constants require both numeric bounds.
const invalidAssumption: ConstantDecl = { name: "fraction", value: 0.5, status: "ASSUMED" };
void invalidAssumption;
