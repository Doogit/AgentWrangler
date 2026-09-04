/**
 * test/ingest/pricing.test.ts — pricing-arithmetic + snapshot-selection tests.
 *
 * Prices are documented and asserted exactly (μUSD). $/MTok = μUSD/token, so a
 * turn's cost is a direct token×price sum. The 5m vs 1h cache-write rates are
 * distinct, proving the split is priced correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { PricingSnapshotStore, seedListPrices } from "../../src/ingest/pricing.js";
import { migratedMemDb } from "./dbutil.js";

let db: Db;
const NOW = "2026-06-01T00:00:00.000Z";

beforeEach(() => {
  db = migratedMemDb();
});
afterEach(() => db.close());

const zero = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheWriteOther: 0,
};

describe("seedListPrices", () => {
  it("seeds one snapshot per tier and is idempotent", () => {
    // 6 tiers: opus, sonnet-5, sonnet-4, haiku, fable-5, fable-5-1 (BM0).
    expect(seedListPrices(db, NOW)).toBe(6);
    expect(seedListPrices(db, NOW)).toBe(0); // re-seed inserts nothing
    const n = (db.prepare("SELECT COUNT(*) AS n FROM pricing_snapshots").get() as { n: number }).n;
    expect(n).toBe(6);
  });
});

describe("PricingSnapshotStore.price", () => {
  beforeEach(() => seedListPrices(db, NOW));

  it("prices a sonnet-4 turn exactly (input+output)", () => {
    const store = new PricingSnapshotStore(db, NOW);
    // 1000×3 + 200×15 = 3000 + 3000 = 6000
    const p = store.price("claude-sonnet-4-6", { ...zero, inputTokens: 1000, outputTokens: 200 });
    expect(p.costU).toBe(6000);
    expect(p.claim).toBe("LIST_EQUIV");
    expect(p.snapshotId).toBe("list-sonnet-4-v2");
  });

  it("prices a sonnet-5 turn at the $2/$10 generation rate (distinct from sonnet-4)", () => {
    const store = new PricingSnapshotStore(db, NOW);
    // 1000×2 + 200×10 = 2000 + 2000 = 4000
    const p = store.price("claude-sonnet-5", { ...zero, inputTokens: 1000, outputTokens: 200 });
    expect(p.costU).toBe(4000);
    expect(p.snapshotId).toBe("list-sonnet-5-v2");
  });

  it("BM0: prices a fable-5 turn to non-NULL cost (was NULL before the fix)", () => {
    const store = new PricingSnapshotStore(db, NOW);
    // 1000×10 + 200×50 = 10000 + 10000 = 20000
    const p = store.price("claude-fable-5", { ...zero, inputTokens: 1000, outputTokens: 200 });
    expect(p.costU).toBe(20000);
    expect(p.claim).toBe("LIST_EQUIV");
    expect(p.snapshotId).toBe("list-fable-5-v2");
  });

  it("BM0: fable-5-1 cache read is priced at 0.025× (0.25/MTok), not 0.1×", () => {
    const store = new PricingSnapshotStore(db, NOW);
    // fable-5-1 cache read = 0.25 μUSD/token; 1000 tokens = 250.
    const p51 = store.price("claude-fable-5-1", { ...zero, cacheReadTokens: 1000 });
    expect(p51.costU).toBe(250);
    expect(p51.snapshotId).toBe("list-fable-5-1-v2");
    // The 5 (non-.1) family keeps the 0.1× rate: 1.0 μUSD/token → 1000.
    const p5 = store.price("claude-fable-5", { ...zero, cacheReadTokens: 1000 });
    expect(p5.costU).toBe(1000);
    expect(p51.costU).not.toBe(p5.costU);
  });

  it("BM0: Mythos shares Fable pricing (mythos-5-1 → 0.025× read, mythos-5 → 0.1×)", () => {
    const store = new PricingSnapshotStore(db, NOW);
    const m51 = store.price("claude-mythos-5-1", { ...zero, cacheReadTokens: 1000 });
    const m5 = store.price("claude-mythos-5", { ...zero, cacheReadTokens: 1000 });
    expect(m51.costU).toBe(250); // fable-5-1 tier: 0.25/MTok
    expect(m51.snapshotId).toBe("list-fable-5-1-v2");
    expect(m5.costU).toBe(1000); // fable-5 tier: 1.0/MTok
    expect(m5.snapshotId).toBe("list-fable-5-v2");
  });

  it("prices an opus turn at the corrected $5/$25 rate (5 and 4.8 share one tier)", () => {
    const store = new PricingSnapshotStore(db, NOW);
    // 1000×5 + 200×25 = 5000 + 5000 = 10000
    const p5 = store.price("claude-opus-5", { ...zero, inputTokens: 1000, outputTokens: 200 });
    const p48 = store.price("claude-opus-4-8", { ...zero, inputTokens: 1000, outputTokens: 200 });
    expect(p5.costU).toBe(10000);
    expect(p48.costU).toBe(10000);
    expect(p5.snapshotId).toBe("list-opus-v2");
    expect(p48.snapshotId).toBe("list-opus-v2");
  });

  it("prices the 5m and 1h cache-write splits at distinct rates", () => {
    const store = new PricingSnapshotStore(db, NOW);
    // sonnet cw5m=3.75, cw1h=6. 1000 tokens each: 3750 vs 6000 — distinct.
    const only5m = store.price("claude-sonnet-4-6", { ...zero, cacheWrite5m: 1000 });
    const only1h = store.price("claude-sonnet-4-6", { ...zero, cacheWrite1h: 1000 });
    expect(only5m.costU).toBe(3750);
    expect(only1h.costU).toBe(6000);
    expect(only5m.costU).not.toBe(only1h.costU);
  });

  it("prices cache_write_other at the 5m rate", () => {
    const store = new PricingSnapshotStore(db, NOW);
    const p = store.price("claude-sonnet-4-6", { ...zero, cacheWriteOther: 1000 });
    expect(p.costU).toBe(3750);
  });

  it("returns null cost for an unknown model tier (tokens still counted upstream)", () => {
    const store = new PricingSnapshotStore(db, NOW);
    const p = store.price("some-unknown-model", { ...zero, inputTokens: 1000 });
    expect(p.costU).toBeNull();
    expect(p.snapshotId).toBeNull();
  });

  it("marks a stale-only snapshot LIST_EQUIV_STALE but still prices it", () => {
    // A fresh DB whose only snapshot is already stale relative to NOW.
    const stale = migratedMemDb();
    stale
      .prepare(
        `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
         VALUES ('old-haiku','haiku','[1,5,0.1,1.25,2]','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`,
      )
      .run();
    const store = new PricingSnapshotStore(stale, NOW);
    const p = store.price("claude-haiku-4", { ...zero, inputTokens: 1000, outputTokens: 100 });
    expect(p.costU).toBe(1500); // 1000×1 + 100×5
    expect(p.claim).toBe("LIST_EQUIV_STALE");
    stale.close();
  });
});
