/**
 * Reclaimable-CEU M(N) contract tests (DL U8 / SC3 / SC3b).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { reclaimableCeu } from "../../src/detector/savings.js";
import { PricingSnapshotStore, seedListPrices } from "../../src/ingest/pricing.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const NOW = "2026-06-01T00:00:00.000Z";

let db: Db;
let pricing: PricingSnapshotStore;

beforeEach(() => {
  db = migratedMemDb();
  seedListPrices(db, NOW);
  pricing = new PricingSnapshotStore(db, NOW);
});

afterEach(() => db.close());

describe("PricingSnapshotStore.reclaimableCeuWeights", () => {
  it("derives per-model weights from the selected snapshot, including both write TTLs", () => {
    const midGen = pricing.reclaimableCeuWeights("claude-sonnet-4-6");
    const newest = pricing.reclaimableCeuWeights("claude-fable-5-1");

    expect(midGen).toMatchObject({
      tier: "sonnet-4",
      wRead: 0.1,
      wWrite5m: 1.25,
      wWrite1h: 2,
      provenance: "OFFICIAL",
    });
    expect(newest).toMatchObject({
      tier: "fable-5-1",
      wRead: 0.025,
      wWrite5m: 1.25,
      wWrite1h: 2,
      provenance: "OFFICIAL",
    });
  });

  it("uses the newest model's 0.025 read weight instead of the generic 0.1 weight", () => {
    const midGen = reclaimableCeu(1_470, 70, pricing.reclaimableCeuWeights("claude-sonnet-4-6"));
    const newest = reclaimableCeu(1_470, 70, pricing.reclaimableCeuWeights("claude-fable-5-1"));

    expect(newest.expected?.ceu).toBeLessThan(midGen.expected?.ceu ?? Number.POSITIVE_INFINITY);
    expect(newest.expected?.ceu).toBeCloseTo(4_410);
    expect(midGen.expected?.ceu).toBeCloseTo(12_127.5);
  });
});

describe("reclaimableCeu", () => {
  it("SC3: reproduces the 1,470-token, N=70 worked example", () => {
    const result = reclaimableCeu(1_470, 70, pricing.reclaimableCeuWeights("claude-sonnet-4-6"));

    expect(result.expected?.ceu).toBeCloseTo(12_127.5); // 1470 × (1.25 + 0.1 × 70)
    expect(result.floor.ceu).toBeCloseTo(1_984.5); // 1470 × (1.25 + 0.1)
    expect(result.band).toEqual({ floorCeu: 1_984.5, expectedCeu: 12_127.5 });
    expect(result.deprioritized).toBe(false);
  });

  it("uses the 1-hour write weight when the session reports that TTL", () => {
    const result = reclaimableCeu(1_470, 70, pricing.reclaimableCeuWeights("claude-sonnet-4-6"), {
      writeTtl: "1h",
    });

    expect(result.floor.ceu).toBe(3_087); // 1470 × (2 + 0.1)
    expect(result.expected?.ceu).toBe(13_230); // 1470 × (2 + 0.1 × 70)
    expect(result.formula.inputs.write_ttl_minutes).toBe(60);
  });

  it("SC3b: attaches OFFICIAL, MEASURED, and UNVERIFIED provenance to the band", () => {
    const verified = reclaimableCeu(1_470, 70, pricing.reclaimableCeuWeights("claude-sonnet-4-6"));
    const unverifiedN = reclaimableCeu(
      1_470,
      null,
      pricing.reclaimableCeuWeights("claude-sonnet-4-6"),
      { nVerified: false },
    );

    expect(verified.floor.provenance).toEqual({
      weights: "OFFICIAL",
      reclaimableTokens: "MEASURED",
      downstreamTurns: "MEASURED",
    });
    expect(verified.expected?.provenance).toEqual(verified.floor.provenance);
    expect(unverifiedN.floor.provenance.downstreamTurns).toBe("UNVERIFIED");
  });

  it("deprioritizes spans below twelve downstream turns", () => {
    const result = reclaimableCeu(1_470, 11, pricing.reclaimableCeuWeights("claude-sonnet-4-6"));

    expect(result.deprioritized).toBe(true);
    expect(result.expected?.ceu).toBeCloseTo(3_454.5);
  });

  it("emits only the floor when N is unverified", () => {
    const result = reclaimableCeu(1_470, null, pricing.reclaimableCeuWeights("claude-sonnet-4-6"), {
      nVerified: false,
    });

    expect(result.expected).toBeNull();
    expect(result.band).toEqual({ floorCeu: 1_984.5, expectedCeu: null });
    expect(result.deprioritized).toBe(true);
    expect(result.formula.kind).toBe("CEU_FLOOR_ONLY");
    expect(result.formula.inputs).toMatchObject({
      reclaimable_tokens: 1_470,
      conservative_floor_reads: 1,
      conservative_floor_ceu: 1_984.5,
    });
    expect(result.formula.inputs).not.toHaveProperty("downstream_turns");
    expect(result.formula.inputs).not.toHaveProperty("expected_ceu");
    const inputs = result.formula.inputs;
    if (
      inputs.reclaimable_tokens === undefined ||
      inputs.w_write === undefined ||
      inputs.w_read === undefined ||
      inputs.conservative_floor_reads === undefined ||
      inputs.conservative_floor_ceu === undefined
    ) {
      throw new Error("floor-only formula omitted a required input");
    }
    expect(
      inputs.reclaimable_tokens *
        (inputs.w_write + inputs.w_read * inputs.conservative_floor_reads),
    ).toBeCloseTo(inputs.conservative_floor_ceu);
  });

  it("uses the conservative default tier and UNVERIFIED provenance for an unknown model", () => {
    const weights = pricing.reclaimableCeuWeights(null);
    const result = reclaimableCeu(1_470, 70, weights);

    expect(weights).toMatchObject({ tier: "fable-5-1", wRead: 0.025, provenance: "UNVERIFIED" });
    expect(result.expected?.provenance.weights).toBe("UNVERIFIED");
  });
});
