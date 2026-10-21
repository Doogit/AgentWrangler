import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WAVE1_RECONCILIATION } from "../../src/detector/wave1-reconciliation.js";

const EXPECTED_RULE_IDS = [
  "A1",
  "A5",
  "A6",
  "A7",
  "A10",
  "B1",
  "B2",
  "B3",
  "B4",
  "C1",
  "C5",
  "D1",
  "E1",
  "F1",
  "TMD-D11",
  "TMD-D12",
] as const;

describe("U11 Wave-1 detector reconciliation", () => {
  it("contains every required rule exactly once", () => {
    const actual = WAVE1_RECONCILIATION.map((row) => row.ruleId);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual).toEqual(EXPECTED_RULE_IDS);
  });

  it("does not claim a library-to-runtime exact match", () => {
    const libraryRows = WAVE1_RECONCILIATION.filter((row) => !row.ruleId.startsWith("TMD-"));
    expect(libraryRows.every((row) => row.disposition !== "verify-only")).toBe(true);
  });

  it("limits verify-only to the separately specified TMD detectors with behavioral tests", () => {
    const verifyOnly = WAVE1_RECONCILIATION.filter((row) => row.disposition === "verify-only");
    expect(
      verifyOnly.map((row) => [row.ruleId, row.existingRuntimeId, row.behavioralTest]),
    ).toEqual([
      ["TMD-D11", "D11", "test/detector/d11-tool-error-rate.test.ts"],
      ["TMD-D12", "D12", "test/detector/d12-subagent-overspawn.test.ts"],
    ]);
    for (const row of verifyOnly) {
      expect(row.behavioralTest).not.toBeNull();
      expect(existsSync(resolve(row.behavioralTest ?? "missing"))).toBe(true);
    }
  });

  it("freezes the reviewed overlap mappings and build-only rules", () => {
    const disposition = Object.fromEntries(
      WAVE1_RECONCILIATION.map((row) => [row.ruleId, [row.disposition, row.existingRuntimeId]]),
    );
    expect(disposition).toMatchObject({
      A1: ["extend", "D6"],
      A5: ["extend", "D9"],
      A6: ["extend", "D2"],
      A7: ["extend", "D4"],
      A10: ["extend", "D10"],
      B1: ["build", null],
      B2: ["extend", "D8"],
      B3: ["build", null],
      B4: ["build", null],
      C1: ["extend", "D11"],
      C5: ["extend", "D7"],
      D1: ["build", null],
      E1: ["extend", "D7"],
      F1: ["build", null],
    });
  });

  it("requires U12 precision recertification for every disposition", () => {
    expect(WAVE1_RECONCILIATION.every((row) => row.precisionRecertificationRequired)).toBe(true);
  });
});
