/**
 * OV-12 U5 (D6) — per-family weight fit. Synthetic readings are built from known multipliers and
 * a known cap, so the fit must recover them (spec Phase 2 DoD: known weights → recovered).
 */
import { describe, expect, it } from "vitest";
import { type FitSample, fitWeights } from "../../../src/query/limits/weight-fit.js";

const CAP_U = 1.2e9; // $1,200 in µUSD
const TRUE = { Opus: 0.95, Sonnet: 1, Fable: 0.72, Haiku: 1.1 } as const;

/** used% Anthropic would report if family f's list-price spend counts TRUE[f]× against CAP_U. */
function sample(week: string, spend: Partial<Record<keyof typeof TRUE, number>>): FitSample {
  const counted = Object.entries(spend).reduce(
    (s, [f, u]) => s + TRUE[f as keyof typeof TRUE] * (u as number),
    0,
  );
  return { week, usedPct: (counted / CAP_U) * 100, spendByFamilyU: spend };
}

const M = 1e6;
const VARIED: FitSample[] = [
  sample("w1", { Opus: 300 * M, Sonnet: 80 * M, Fable: 250 * M, Haiku: 40 * M }),
  sample("w1", { Opus: 420 * M, Sonnet: 120 * M, Fable: 330 * M, Haiku: 60 * M }),
  sample("w2", { Opus: 700 * M, Sonnet: 150 * M, Fable: 30 * M, Haiku: 20 * M }),
  sample("w2", { Opus: 900 * M, Sonnet: 160 * M, Fable: 40 * M, Haiku: 25 * M }),
  sample("w3", { Opus: 200 * M, Sonnet: 400 * M, Fable: 100 * M, Haiku: 90 * M }),
  sample("w3", { Opus: 260 * M, Sonnet: 520 * M, Fable: 110 * M, Haiku: 120 * M }),
  sample("w4", { Opus: 100 * M, Sonnet: 90 * M, Fable: 600 * M, Haiku: 10 * M }),
];

const fam = (fit: ReturnType<typeof fitWeights>, f: string) =>
  fit.families.find((x) => x.family === f);

describe("fitWeights", () => {
  it("recovers known multipliers from synthetic readings", () => {
    const fit = fitWeights(VARIED);
    expect(fit).toMatchObject({ readings: 7, weeks: 4, variedMix: true, ready: true });
    expect(fam(fit, "Opus")?.multiplier).toBeCloseTo(0.95, 6);
    expect(fam(fit, "Fable")?.multiplier).toBeCloseTo(0.72, 6);
    expect(fam(fit, "Haiku")?.multiplier).toBeCloseTo(1.1, 6);
    expect(fam(fit, "Sonnet")).toMatchObject({ multiplier: 1, status: "reference" });
    expect(fit.spreadFittedPct).toBeCloseTo(0, 6);
    expect(fit.spreadListPct).toBeGreaterThan(3);
  });

  it("list-price weights are input price ÷ Sonnet 5 input, as a version range", () => {
    const fit = fitWeights(VARIED);
    expect(fam(fit, "Opus")?.listWeight).toEqual([2, 2.5]);
    expect(fam(fit, "Sonnet")?.listWeight).toEqual([1, 1.5]);
    expect(fam(fit, "Fable")?.listWeight).toEqual([5, 5]);
    // F24: Haiku 5.5 ($0.10 input) joins Haiku 4.5 ($1): 0.05..0.5 (long-prompt $0.50 lies inside).
    expect(fam(fit, "Haiku")?.listWeight).toEqual([0.05, 0.5]);
  });

  it("gate: under 6 readings or 3 weeks → not ready, no multipliers", () => {
    const fit = fitWeights(VARIED.slice(0, 4));
    expect(fit).toMatchObject({ readings: 4, weeks: 2, ready: false });
    expect(fit.families.every((f) => f.status === "reference" || f.multiplier === null)).toBe(true);
    expect(fit.spreadFittedPct).toBeNull();
  });

  it("gate: the same model mix in every reading → not varied, not ready", () => {
    const same = [1, 2, 3, 4, 5, 6].map((k) =>
      sample(`w${k}`, { Opus: 300 * M * k, Sonnet: 100 * M * k, Fable: 100 * M * k }),
    );
    expect(fitWeights(same)).toMatchObject({
      readings: 6,
      weeks: 6,
      variedMix: false,
      ready: false,
    });
  });

  it("a family under 5% of spend is not fitted; the rest still recover", () => {
    const noHaiku = VARIED.map((s) => {
      const { Haiku: _h, ...rest } = s.spendByFamilyU;
      return sample(s.week, { ...rest, Haiku: 1 * M });
    });
    const fit = fitWeights(noHaiku);
    expect(fam(fit, "Haiku")).toMatchObject({ status: "too-little-use", multiplier: null });
    expect(fam(fit, "Opus")?.multiplier).toBeCloseTo(0.95, 3);
    expect(fam(fit, "Fable")?.multiplier).toBeCloseTo(0.72, 3);
  });

  it("two families always in the same ratio can't be told apart → not ready, no multipliers", () => {
    const locked = [1, 2, 3, 4, 5, 6].map((k) =>
      sample(`w${k}`, {
        Opus: 213.7 * M * k * 1.01 ** k,
        Fable: (213.7 / 3.7) * M * k * 1.01 ** k,
        Sonnet: (50 + 120 * (k % 3)) * M,
      }),
    );
    const fit = fitWeights(locked);
    expect(fit.variedMix).toBe(true);
    expect(fit).toMatchObject({ ready: false, spreadFittedPct: null });
    expect(fam(fit, "Opus")?.multiplier).toBeNull();
    expect(fam(fit, "Fable")?.multiplier).toBeNull();
  });

  it("no readings → empty, not ready", () => {
    expect(fitWeights([])).toMatchObject({
      readings: 0,
      weeks: 0,
      ready: false,
      spreadListPct: null,
    });
  });
});
