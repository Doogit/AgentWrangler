import { describe, expect, it } from "vitest";

import { G2_KAPPA_GATE, cohenKappa } from "../../../src/evidence/g2/kappa.js";

describe("cohenKappa", () => {
  it("calculates raw and chance-corrected agreement", () => {
    const result = cohenKappa(
      ["CONFIRMED", "CONFIRMED", "REJECTED", "REJECTED", "CONFIRMED"],
      ["CONFIRMED", "REJECTED", "REJECTED", "REJECTED", "CONFIRMED"],
    );

    expect(result.rawAgreement).toBeCloseTo(0.8, 5);
    expect(result.kappa).toBeCloseTo(0.61538, 4);
  });

  it("returns one for perfect mixed-label agreement", () => {
    const labels = ["CONFIRMED", "REJECTED", "CONFIRMED"] as const;
    const result = cohenKappa(labels, labels);

    expect(result.rawAgreement).toBe(1);
    expect(result.kappa).toBe(1);
  });

  it("rejects mismatched or empty inputs", () => {
    expect(() => cohenKappa(["CONFIRMED"], [])).toThrow();
    expect(() => cohenKappa([], [])).toThrow();
  });

  it("exposes the G2 kappa gate", () => {
    expect(G2_KAPPA_GATE).toBe(0.6);
  });
});
