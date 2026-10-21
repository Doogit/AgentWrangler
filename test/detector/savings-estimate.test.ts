import { describe, expect, it } from "vitest";
import { DETECTORS } from "../../src/detector/registry.js";
import {
  CARRY_TURN_CAP,
  ESTIMATE_BUILDERS,
  ESTIMATOR_BYTES_PER_TOKEN,
  type Estimate,
  type EstimateInputs,
  carryTurns,
} from "../../src/detector/savings.js";

function expectEstimate(
  estimate: Estimate,
  expected: Pick<Estimate, "basis" | "rank_value_u_per_wk" | "summable">,
): void {
  expect(estimate).toMatchObject(expected);
  expect(estimate.label.length).toBeGreaterThan(0);
}

describe("usage-based estimate builders", () => {
  const cases: Array<{
    id: string;
    inputs: EstimateInputs;
    expected: Pick<Estimate, "basis" | "rank_value_u_per_wk" | "summable">;
  }> = [
    {
      id: "A1",
      inputs: {
        resultBytes: 295_600,
        carryTurns: 2,
        writePriceUsdPerMtok: 4,
        cacheReadPriceUsdPerMtok: 0.5,
      },
      // U7: 100,000 tok × 0.5 × (4 write + 0.5 read × (2 − 1)); the write turn is not also a read.
      expected: { basis: "E", rank_value_u_per_wk: 225_000, summable: true },
    },
    {
      id: "A2",
      inputs: { avoidableBytes: 270_000, writePriceUsdPerMtok: 4 },
      expected: { basis: "P", rank_value_u_per_wk: 200_000, summable: true },
    },
    {
      id: "B1",
      inputs: { avoidableCreationTokens: 100_000, writePriceUsdPerMtok: 3.75 },
      expected: { basis: "P", rank_value_u_per_wk: 187_500, summable: true },
    },
    {
      id: "B2",
      inputs: {
        previousCacheReadTokens: 100_000,
        writePriceUsdPerMtok: 6.25,
        cacheReadPriceUsdPerMtok: 0.5,
      },
      expected: { basis: "O", rank_value_u_per_wk: 287_500, summable: false },
    },
    {
      id: "B3",
      inputs: { avoidableCreationTokens: 100_000, writePriceUsdPerMtok: 3.75 },
      expected: { basis: "P", rank_value_u_per_wk: 187_500, summable: true },
    },
    {
      id: "B4",
      inputs: { avoidableCreationTokens: 80_000, writePriceUsdPerMtok: 3.75 },
      expected: { basis: "O", rank_value_u_per_wk: 150_000, summable: false },
    },
    {
      id: "C1",
      inputs: { costEquivU: 100_000 },
      expected: { basis: "P", rank_value_u_per_wk: 50_000, summable: true },
    },
    {
      id: "C2",
      inputs: { costEquivU: 100_000 },
      expected: { basis: "E", rank_value_u_per_wk: 50_000, summable: true },
    },
    {
      id: "C3",
      inputs: { costEquivU: 100_000 },
      expected: { basis: "P", rank_value_u_per_wk: 50_000, summable: true },
    },
    {
      id: "C4",
      inputs: { costEquivU: 100_000 },
      expected: { basis: "P", rank_value_u_per_wk: 50_000, summable: true },
    },
    {
      id: "C5",
      inputs: { conservativeFloorCeu: 48_000, inputPriceUsdPerMtok: 5 },
      expected: { basis: "O", rank_value_u_per_wk: 240_000, summable: false },
    },
    { id: "C6", inputs: {}, expected: { basis: "X", rank_value_u_per_wk: null, summable: false } },
    {
      id: "C7",
      inputs: { costEquivU: 100_000 },
      expected: { basis: "P", rank_value_u_per_wk: 50_000, summable: true },
    },
    {
      id: "C9",
      inputs: { costEquivU: 100_000 },
      expected: { basis: "E", rank_value_u_per_wk: 50_000, summable: true },
    },
    { id: "C11", inputs: {}, expected: { basis: "X", rank_value_u_per_wk: null, summable: false } },
    {
      id: "D1",
      inputs: { deltaContextTokens: 10_000, turnsPerWeek: 10, cacheReadPriceUsdPerMtok: 0.5 },
      expected: { basis: "P", rank_value_u_per_wk: 25_000, summable: true },
    },
    {
      id: "D2",
      inputs: { cacheReadSpendUPerWeek: 300_000 },
      expected: { basis: "P", rank_value_u_per_wk: 99_000, summable: true },
    },
    {
      id: "D4",
      inputs: {
        totalInputTokens: 100,
        totalOutputTokens: 10,
        totalCacheReadTokens: 1_000,
        totalCacheWrite5mTokens: 50,
        totalCacheWrite1hTokens: 5,
        opusInputPriceUsdPerMtok: 5,
        opusOutputPriceUsdPerMtok: 25,
        opusCacheReadPriceUsdPerMtok: 0.5,
        opusCacheWrite5mPriceUsdPerMtok: 6.25,
        opusCacheWrite1hPriceUsdPerMtok: 10,
        sonnetInputPriceUsdPerMtok: 3,
        sonnetOutputPriceUsdPerMtok: 15,
        sonnetCacheReadPriceUsdPerMtok: 0.3,
        sonnetCacheWrite5mPriceUsdPerMtok: 3.75,
        sonnetCacheWrite1hPriceUsdPerMtok: 6,
      },
      expected: { basis: "E", rank_value_u_per_wk: 323, summable: true },
    },
    { id: "D5", inputs: {}, expected: { basis: "X", rank_value_u_per_wk: null, summable: false } },
    {
      id: "D6",
      inputs: { carryExposureTokens: 100_000, cacheReadPriceUsdPerMtok: 0.5 },
      expected: { basis: "P", rank_value_u_per_wk: 25_000, summable: true },
    },
    {
      id: "D7",
      inputs: { repeatExcessTokens: 100_000, cacheReadPriceUsdPerMtok: 0.5 },
      expected: { basis: "P", rank_value_u_per_wk: 25_000, summable: false },
    },
    {
      id: "D8",
      inputs: { totalChurnCreationTokens: 100_000, writePriceUsdPerMtok: 3.75 },
      // 100,000 × 0.64 (D8_AVOIDANCE_FRACTION, operator 2026-09-28) × 3.75 = 240,000.
      expected: { basis: "P", rank_value_u_per_wk: 240_000, summable: true },
    },
    {
      id: "D9",
      inputs: { idleSidechainCapTokens: 100_000, cacheReadPriceUsdPerMtok: 0.5 },
      expected: { basis: "E", rank_value_u_per_wk: 50_000, summable: false },
    },
    {
      id: "D10",
      inputs: { deltaContextTokens: 10_000, turnsPerWeek: 10, cacheReadPriceUsdPerMtok: 0.5 },
      expected: { basis: "P", rank_value_u_per_wk: 25_000, summable: true },
    },
    {
      id: "D11",
      inputs: { costEquivU: 270_000, excessErrors: 13.2, higherErrorCount: 27 },
      expected: { basis: "E", rank_value_u_per_wk: 66_000, summable: true },
    },
    {
      id: "D12",
      inputs: { sidechainResultBytes: 270_000 },
      expected: { basis: "E", rank_value_u_per_wk: 222_000, summable: false },
    },
    {
      id: "D14",
      inputs: { costEquivU: 100_000, operationClass: "human-deny" },
      expected: { basis: "O", rank_value_u_per_wk: 50_000, summable: false },
    },
    {
      id: "G11",
      inputs: { excessTokens: 100_000, cacheReadPriceUsdPerMtok: 0.5 },
      expected: { basis: "P", rank_value_u_per_wk: 25_000, summable: false },
    },
    {
      id: "H1",
      inputs: { costEquivU: 100_000, operationClass: "rm-rf" },
      expected: { basis: "R", rank_value_u_per_wk: 5_000, summable: false },
    },
  ];

  it.each(cases)("calculates $id from numeric usage inputs", ({ id, inputs, expected }) => {
    const builder = ESTIMATE_BUILDERS[id];
    if (builder === undefined) throw new Error(`missing builder for ${id}`);
    expectEstimate(builder(inputs), expected);
  });

  it("covers every registered detector", () => {
    expect(
      DETECTORS.map((detector) => detector.id).every((id) => ESTIMATE_BUILDERS[id] !== undefined),
    ).toBe(true);
  });

  it("caps carry at 75 and stops before session end, compaction, or context collapse", () => {
    expect(CARRY_TURN_CAP).toBe(75);
    expect(
      carryTurns(
        "s1",
        Array.from({ length: 80 }, () => ({ sessionId: "s1" })),
      ),
    ).toBe(75);
    expect(carryTurns("s1", [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s1" }])).toBe(
      1,
    );
    expect(
      carryTurns("s1", [
        { sessionId: "s1" },
        { sessionId: "s1", compacted: true },
        { sessionId: "s1" },
      ]),
    ).toBe(1);
    expect(
      carryTurns("s1", [{ sessionId: "s1" }, { sessionId: "s1", contextCollapsed: true }]),
    ).toBe(1);
    expectEstimate(
      ESTIMATE_BUILDERS.A1?.({
        resultBytes: 295_600,
        originSessionId: "s1",
        laterTurns: [{ sessionId: "s1" }, { sessionId: "s1", compacted: true }],
        writePriceUsdPerMtok: 4,
        cacheReadPriceUsdPerMtok: 0.5,
      }) as Estimate,
      // One carried turn: the write only (U7).
      { basis: "E", rank_value_u_per_wk: 200_000, summable: true },
    );
    // No later turn: the result is never sent again, so it costs nothing.
    expectEstimate(
      ESTIMATE_BUILDERS.A1?.({
        resultBytes: 295_600,
        carryTurns: 0,
        writePriceUsdPerMtok: 4,
        cacheReadPriceUsdPerMtok: 0.5,
      }) as Estimate,
      { basis: "E", rank_value_u_per_wk: 0, summable: true },
    );
  });

  it("uses the 2.7 byte default for D7 cross-session rereads", () => {
    const estimate = ESTIMATE_BUILDERS.D7?.({
      xread: true,
      totalRedundantResultBytes: 270_000,
      totalRedundantReadCount: 10,
      redundantPathCount: 1,
      cacheReadPriceUsdPerMtok: 0.5,
    });
    expect(ESTIMATOR_BYTES_PER_TOKEN).toBe(2.7);
    expectEstimate(estimate as Estimate, {
      basis: "E",
      rank_value_u_per_wk: 45_000,
      summable: true,
    });
  });

  it("uses the H1 upper-bound probabilities for rm-rf and git-reset-hard", () => {
    expectEstimate(
      ESTIMATE_BUILDERS.H1?.({ costEquivU: 100_000, operationClass: "rm-rf" }) as Estimate,
      { basis: "R", rank_value_u_per_wk: 5_000, summable: false },
    );
    expectEstimate(
      ESTIMATE_BUILDERS.H1?.({ costEquivU: 100_000, operationClass: "git-reset-hard" }) as Estimate,
      { basis: "R", rank_value_u_per_wk: 25_000, summable: false },
    );
  });
});
