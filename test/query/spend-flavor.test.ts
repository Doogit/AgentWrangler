/**
 * test/query/spend-flavor.test.ts — Spend-Viz-v2 backend reconciliation tests.
 *
 * T1  — Flavor total_weighted === SUM(flavors.weighted_tokens) [internal consistency]
 * T2  — Flavor total_raw reconciles with raw column sums
 * T3  — cache_efficiency_ratio agrees between FlavorDecomposition and getCacheEfficiency
 * T4  — cacheWriteByBucket cache_creation_tokens reconciles with capWeightedTokens
 * T5  — FlavorDecomposition cache_efficiency_ratio agrees with cacheWriteByBucket aggregate
 * T6  — Empty window: null ratio, zero totals, coeff_unverified=true, no crash
 * T7  — detectSpikes: empty / short series produces empty set
 * T8  — detectSpikes: high-outlier bucket is correctly flagged
 * T9  — classifyCacheEfficiency threshold mapping
 * T10 — FlavorRow pricing weights applied correctly to known input
 *
 * Fixture DB aggregates (from seed.ts, provisional=0, all 9 reconciled turns):
 *   input_tokens  = 1000+2000+1500+3000+500+750+750+5000+2500 = 17000
 *   output_tokens = 200+400+300+600+100+75+75+1000+500       = 3250
 *   cache_write_5m = 0+500+0+0+0+0+0+1000+0                 = 1500
 *   cache_write_1h = 0 (all)
 *   cache_write_other = 0 (all)
 *   cache_read_tokens = 0+1000+0+0+0+0+0+2000+0             = 3000
 *
 * Window used: 2025-01-01 → 2027-01-01 (covers all fixture turns)
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyCacheReuseBand,
  getCacheEfficiency,
  getFlavorDecomposition,
} from "../../src/query/api/spend-flavor.js";
import { detectSpikes } from "../../src/query/api/trends.js";
import { capWeightedTokens } from "../../src/query/cap-weighted.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { cacheWriteByBucket } from "../../src/query/trends.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Window that covers all 2026 fixture turns
const FROM = "2025-01-01T00:00:00.000Z";
const TO = "2027-01-01T00:00:00.000Z";
const WIN = { from: FROM, to: TO };

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

// ---------------------------------------------------------------------------
// T1 — Internal consistency: total_weighted equals SUM of flavor.weighted_tokens
// ---------------------------------------------------------------------------

describe("T1 — FlavorDecomposition internal weighted-total consistency", () => {
  it("SUM(flavors.weighted_tokens) === total_weighted_tokens", () => {
    const resp = getFlavorDecomposition(WIN);
    const fd = resp.data;
    expect(fd).not.toBeNull();
    if (fd === null) return;

    const sumWeighted = fd.flavors.reduce((s, f) => s + f.weighted_tokens, 0);
    // Allow ±1 due to floating point
    expect(Math.abs(sumWeighted - fd.total_weighted_tokens)).toBeLessThanOrEqual(1);
  });

  it("T1b — cap-proxy-weighted total reconciles with the shared cap meter", () => {
    const fd = getFlavorDecomposition(WIN).data;
    if (!fd) throw new Error("Expected non-null data");
    const capRows = capWeightedTokens(db, { fromIso: FROM, toIso: TO });
    const capTotal = capRows[0]?.cap_weighted_tokens ?? 0;
    const weightedTotal = fd.total_weighted_tokens;
    expect(fd.cap_weighted_tokens).toBe(capTotal);
    expect(weightedTotal).toBe(capTotal);
  });

  it("flavors are in canonical order: fresh_input → output → cw5m → cw1h → cache_read", () => {
    const resp = getFlavorDecomposition(WIN);
    if (!resp.data) throw new Error("Expected non-null data");
    const fd = resp.data;
    const keys = fd.flavors.map((f) => f.flavor);
    expect(keys).toEqual([
      "fresh_input",
      "output",
      "cache_write_5m",
      "cache_write_1h",
      "cache_write_other",
      "cache_read",
    ]);
  });
});

// ---------------------------------------------------------------------------
// T2 — Flavor raw total reconciles with column sums
// ---------------------------------------------------------------------------

describe("T2 — FlavorDecomposition total_raw_tokens reconciles with column sums", () => {
  it("total_raw_tokens = SUM(input + output + cw5m + cw1h + cwOther + cr) from DB", () => {
    const resp = getFlavorDecomposition(WIN);
    if (!resp.data) throw new Error("Expected non-null data");
    const fd = resp.data;

    // Compute from DB directly
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)                              AS i,
           COALESCE(SUM(output_tokens), 0)                             AS o,
           COALESCE(SUM(cache_write_5m), 0)                            AS cw5m,
           COALESCE(SUM(cache_write_1h), 0)                            AS cw1h,
           COALESCE(SUM(cache_write_other), 0)                         AS cwOther,
           COALESCE(SUM(cache_read_tokens), 0)                         AS cr
         FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0`,
      )
      .get(FROM, TO) as {
      i: number;
      o: number;
      cw5m: number;
      cw1h: number;
      cwOther: number;
      cr: number;
    };

    const expectedRaw = row.i + row.o + row.cw5m + row.cw1h + row.cwOther + row.cr;
    expect(fd.total_raw_tokens).toBe(expectedRaw);

    // Verify against known fixture values
    expect(row.i).toBe(17000);
    expect(row.o).toBe(3250);
    expect(row.cw5m).toBe(1500);
    expect(row.cw1h).toBe(0);
    expect(row.cwOther).toBe(0);
    expect(row.cr).toBe(3000);
    expect(fd.total_raw_tokens).toBe(17000 + 3250 + 1500 + 0 + 3000); // 24750
  });
});

// ---------------------------------------------------------------------------
// T3 — cache_efficiency_ratio agrees between FlavorDecomposition and getCacheEfficiency
// ---------------------------------------------------------------------------

describe("T3 — cache_efficiency_ratio consistency", () => {
  it("FlavorDecomposition.cache_efficiency_ratio === CacheEfficiency.ratio", () => {
    const fdResp = getFlavorDecomposition(WIN);
    const ceResp = getCacheEfficiency(WIN);

    if (!fdResp.data) throw new Error("Expected non-null fdResp.data");
    if (!ceResp.data) throw new Error("Expected non-null ceResp.data");
    const fd = fdResp.data;
    const ce = ceResp.data;

    if (fd.cache_efficiency_ratio === null && ce.ratio === null) return;

    expect(fd.cache_efficiency_ratio).not.toBeNull();
    expect(ce.ratio).not.toBeNull();
    const fdRatio = fd.cache_efficiency_ratio ?? 0;
    const ceRatio = ce.ratio ?? 0;
    // Allow ±0.001 for floating point
    expect(Math.abs(fdRatio - ceRatio)).toBeLessThan(0.001);
  });

  it("ratio is computed as cr / (cr + creation) — verified with fixture values", () => {
    // Fixture: cr=3000, cw5m=1500, cw1h=0, cwOther=0
    // ratio = 3000 / (3000 + 1500) = 3000/4500 = 0.6667
    const resp = getFlavorDecomposition(WIN);
    if (!resp.data) throw new Error("Expected non-null data");
    const fd = resp.data;
    expect(fd.cache_efficiency_ratio).not.toBeNull();
    const expected = 3000 / (3000 + 1500);
    const ratio = fd.cache_efficiency_ratio ?? 0;
    expect(Math.abs(ratio - expected)).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// T4 — cacheWriteByBucket cache_creation_tokens reconciles with capWeightedTokens
// ---------------------------------------------------------------------------

describe("T4 — cacheWriteByBucket reconciles with capWeightedTokens.cache_creation_tokens", () => {
  it("SUM(cacheWriteByBucket.cache_creation_tokens) === capWeightedTokens.cache_creation_tokens", () => {
    const buckets = cacheWriteByBucket(db, FROM, TO, "month");
    const capRows = capWeightedTokens(db, { fromIso: FROM, toIso: TO });

    const bucketSum = buckets.reduce((s, r) => s + r.cache_creation_tokens, 0);
    const capCreation = capRows[0]?.cache_creation_tokens ?? 0;

    expect(bucketSum).toBe(capCreation);
    // Verify with fixture: cw5m=1500, cw1h=0, cwOther=0 → 1500
    expect(bucketSum).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// T5 — FlavorDecomposition efficiency ratio agrees with cacheWriteByBucket aggregate
// ---------------------------------------------------------------------------

describe("T5 — cache_efficiency_ratio consistency with cacheWriteByBucket aggregate", () => {
  it("FlavorDecomposition ratio === ratio derived from SUM of cacheWriteByBucket rows", () => {
    const fdResp2 = getFlavorDecomposition(WIN);
    if (!fdResp2.data) throw new Error("Expected non-null data");
    const fd = fdResp2.data;
    const buckets = cacheWriteByBucket(db, FROM, TO, "month");

    const totalCr = buckets.reduce((s, r) => s + r.cache_read_tokens, 0);
    const totalCw = buckets.reduce((s, r) => s + r.cache_creation_tokens, 0);
    const expectedRatio = totalCr + totalCw > 0 ? totalCr / (totalCr + totalCw) : null;

    if (expectedRatio === null || fd.cache_efficiency_ratio === null) {
      expect(expectedRatio).toBe(fd.cache_efficiency_ratio);
      return;
    }
    expect(Math.abs(fd.cache_efficiency_ratio - expectedRatio)).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// T6 — Empty window returns safe zero state
// ---------------------------------------------------------------------------

describe("T6 — Empty window returns null ratio, zero totals, coeff_unverified=true", () => {
  it("no turns in window → zero totals, null efficiency_ratio, coeff_unverified=true", () => {
    const emptyWin = { from: "2030-01-01T00:00:00.000Z", to: "2030-12-31T00:00:00.000Z" };
    const resp = getFlavorDecomposition(emptyWin);
    if (!resp.data) throw new Error("Expected non-null data");
    const fd = resp.data;

    expect(fd.total_raw_tokens).toBe(0);
    expect(fd.total_weighted_tokens).toBe(0);
    expect(fd.cache_efficiency_ratio).toBeNull();
    expect(fd.cache_read_share).toBeNull();
    expect(fd.reuse_band).toBe("NO_DATA");
    expect(fd.cap_weighted_tokens).toBe(0);
    expect(fd.coeff_unverified).toBe(true);
    expect(fd.turns).toBe(0);
    for (const f of fd.flavors) {
      expect(f.raw_tokens).toBe(0);
      expect(f.weighted_tokens).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — detectSpikes: empty / short series produces empty set
// ---------------------------------------------------------------------------

describe("T7 — detectSpikes: sparse series produce empty set", () => {
  it("empty array returns empty set", () => {
    expect(detectSpikes([]).size).toBe(0);
  });

  it("single-row series returns empty set (< 3 buckets)", () => {
    expect(
      detectSpikes([
        {
          bucket: "2026-01-01",
          cache_creation_tokens: 1000,
          cache_read_tokens: 0,
          efficiency_ratio: 0,
          turns: 5,
        },
      ]).size,
    ).toBe(0);
  });

  it("two-row series returns empty set (< 3 buckets)", () => {
    expect(
      detectSpikes([
        {
          bucket: "2026-01-01",
          cache_creation_tokens: 1000,
          cache_read_tokens: 0,
          efficiency_ratio: 0,
          turns: 5,
        },
        {
          bucket: "2026-01-02",
          cache_creation_tokens: 2000,
          cache_read_tokens: 0,
          efficiency_ratio: 0,
          turns: 5,
        },
      ]).size,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T8 — detectSpikes: high-outlier bucket is correctly flagged
// ---------------------------------------------------------------------------

describe("T8 — detectSpikes flags exactly the high-outlier bucket", () => {
  it("7-bucket series where one bucket is ~5× the mean — only that bucket flagged", () => {
    const baseline = 200_000;
    const rows = [
      {
        bucket: "2026-01-01",
        cache_creation_tokens: baseline,
        cache_read_tokens: 0,
        efficiency_ratio: 0,
        turns: 10,
      },
      {
        bucket: "2026-01-02",
        cache_creation_tokens: baseline,
        cache_read_tokens: 0,
        efficiency_ratio: 0,
        turns: 10,
      },
      {
        bucket: "2026-01-03",
        cache_creation_tokens: baseline,
        cache_read_tokens: 0,
        efficiency_ratio: 0,
        turns: 10,
      },
      {
        bucket: "2026-01-04",
        cache_creation_tokens: baseline * 5,
        cache_read_tokens: 0,
        efficiency_ratio: 0,
        turns: 10,
      },
      {
        bucket: "2026-01-05",
        cache_creation_tokens: baseline,
        cache_read_tokens: 0,
        efficiency_ratio: 0,
        turns: 10,
      },
      {
        bucket: "2026-01-06",
        cache_creation_tokens: baseline,
        cache_read_tokens: 0,
        efficiency_ratio: 0,
        turns: 10,
      },
      {
        bucket: "2026-01-07",
        cache_creation_tokens: baseline,
        cache_read_tokens: 0,
        efficiency_ratio: 0,
        turns: 10,
      },
    ];

    const spikes = detectSpikes(rows);
    expect(spikes.size).toBe(1);
    expect(spikes.has("2026-01-04")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T9 — raw reuse-band threshold mapping
// ---------------------------------------------------------------------------

describe("T9 — classifyCacheReuseBand threshold mapping", () => {
  it("no turns → NO_DATA", () => expect(classifyCacheReuseBand(0, 0, 0)).toBe("NO_DATA"));
  it("zero creations with reads → NO_DENOMINATOR", () =>
    expect(classifyCacheReuseBand(100, 0, 1)).toBe("NO_DENOMINATOR"));
  it("ratio below 1 → WRITE_HEAVY", () =>
    expect(classifyCacheReuseBand(99, 100, 1)).toBe("WRITE_HEAVY"));
  it("ratio 1 → MIXED_REUSE", () =>
    expect(classifyCacheReuseBand(100, 100, 1)).toBe("MIXED_REUSE"));
  it("ratio below 4 → MIXED_REUSE", () =>
    expect(classifyCacheReuseBand(399, 100, 1)).toBe("MIXED_REUSE"));
  it("ratio 4 → REUSE_DOMINANT", () =>
    expect(classifyCacheReuseBand(400, 100, 1)).toBe("REUSE_DOMINANT"));
});

// ---------------------------------------------------------------------------
// T10 — FlavorRow pricing weights applied to known input
// ---------------------------------------------------------------------------

describe("T10 — FlavorRow weights applied correctly to known input", () => {
  it("input=100,output=50,cw5m=40,cw1h+other=30,cr=200 coeff=0.1 → total_weighted=280", () => {
    // Seed a temp window with known values
    const db2 = createInMemoryFixtureDb();
    setQueryDb(db2);

    db2
      .prepare(
        `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
         VALUES ('ws-t10', 'ws-t10', '2028-01-01T00:00:00.000Z')`,
      )
      .run();
    db2
      .prepare(
        `INSERT OR IGNORE INTO sessions
           (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
            state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES ('sess-t10', 'ws-t10', '/fake/t10.jsonl',
                 '2028-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z',
                 'RECONCILED', 0, 0, '[]')`,
      )
      .run();
    db2
      .prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m, cache_write_1h, cache_write_other,
            tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
            provisional, parser_version)
         VALUES ('msg-t10', 'sess-t10', 'ws-t10', '2028-01-01T00:00:00.000Z',
                 'claude-sonnet', 0,
                 100, 50, 200,
                 40, 20, 10,
                 NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
      )
      .run();

    const t10Win = { from: "2028-01-01T00:00:00.000Z", to: "2029-01-01T00:00:00.000Z" };
    const resp = getFlavorDecomposition(t10Win);
    if (!resp.data) throw new Error("Expected non-null data");
    const fd = resp.data;

    // Expected cap proxy: 100 + 50 + 40 + 20 + 10 + 200*0.1 = 240
    expect(fd.total_weighted_tokens).toBeCloseTo(240, 0);
    expect(fd.flavors.find((f) => f.flavor === "fresh_input")?.weighted_tokens).toBe(100);
    expect(fd.flavors.find((f) => f.flavor === "output")?.weighted_tokens).toBe(50);
    expect(fd.flavors.find((f) => f.flavor === "cache_write_5m")?.weighted_tokens).toBe(40);
    expect(fd.flavors.find((f) => f.flavor === "cache_write_1h")?.weighted_tokens).toBe(20);
    expect(fd.flavors.find((f) => f.flavor === "cache_write_other")?.weighted_tokens).toBe(10);
    expect(fd.flavors.find((f) => f.flavor === "cache_read")?.weighted_tokens).toBeCloseTo(20, 0); // 200*0.1
    expect(fd.cache_read_tokens).toBe(200);
    expect(fd.cache_creation_tokens).toBe(70);
    expect(fd.cache_read_share).toBeCloseTo(200 / 270);
    expect(fd.reuse_band).toBe("MIXED_REUSE");

    db2
      .prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m, cache_write_1h, cache_write_other,
            tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
            provisional, parser_version)
         VALUES ('msg-t10-read-only', 'sess-t10', 'ws-t10', '2029-01-01T00:00:00.000Z',
                 'claude-sonnet', 0,
                 0, 0, 200,
                 0, 0, 0,
                 NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
      )
      .run();

    const readOnly = getFlavorDecomposition({
      from: "2029-01-01T00:00:00.000Z",
      to: "2030-01-01T00:00:00.000Z",
    }).data;
    expect(readOnly?.cache_read_tokens).toBe(200);
    expect(readOnly?.cache_creation_tokens).toBe(0);
    expect(readOnly?.cache_read_share).toBe(1);
    expect(readOnly?.reuse_band).toBe("NO_DENOMINATOR");

    db2.close();
    setQueryDb(db); // restore main fixture db
  });
});
