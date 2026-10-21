/**
 * Deterministic economic oracle for the shared parity seed.
 *
 * The seed uses the structural assistant-event/usage shape emitted by Claude's
 * JSONL history. It deliberately contains no message content, tool payload, or
 * other transcript data. Prices are USD/MTok, numerically µUSD/token.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(HERE, "golden-economic.json");
const MICRO_USD_PER_USD = 1_000_000;

const PRICE_PER_MTOK = {
  opus: { input: 5, output: 25, cacheCreation: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
};

/** @type {Array<{type: string, message: {role: string, model: string, usage: Record<string, number>}}>} */
const SHARED_SEED_EVENTS = [
  ...Array.from({ length: 10 }, () => ({
    type: "assistant",
    message: {
      role: "assistant",
      model: "opus",
      usage: {
        input_tokens: 160_000,
        output_tokens: 400,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 150_000,
      },
    },
  })),
  ...Array.from({ length: 20 }, () => ({
    type: "assistant",
    message: {
      role: "assistant",
      model: "sonnet",
      usage: {
        input_tokens: 100_000,
        output_tokens: 1_000,
        cache_creation_input_tokens: 100_000,
        cache_read_input_tokens: 700_000,
      },
    },
  })),
];

const SEED = {
  alwaysLoadedTrimTokens: 40_000,
  d2ReductionFraction: 0.33,
  toolResultBytes: 2_000_000,
  calibratedBytesPerToken: 8,
  toolResultCarryTurns: 5,
  d6AvoidanceFraction: 0.5,
  d8AvoidanceFraction: 0.7,
};

function assertRawUsage(event) {
  if (
    event?.type !== "assistant" ||
    event.message?.role !== "assistant" ||
    typeof event.message?.model !== "string" ||
    !Object.hasOwn(PRICE_PER_MTOK, event.message.model)
  ) {
    throw new TypeError("shared seed must contain priced assistant usage events");
  }
  for (const field of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]) {
    if (!Number.isFinite(event.message.usage?.[field]) || event.message.usage[field] < 0) {
      throw new TypeError("shared seed usage must be finite non-negative numbers");
    }
  }
}

function sumUsage(events) {
  return events.reduce(
    (total, event) => {
      assertRawUsage(event);
      const { usage } = event.message;
      const price = PRICE_PER_MTOK[event.message.model];
      total.weeklySpendU +=
        usage.input_tokens * price.input +
        usage.output_tokens * price.output +
        usage.cache_creation_input_tokens * price.cacheCreation +
        usage.cache_read_input_tokens * price.cacheRead;
      total.cacheReadSpendU += usage.cache_read_input_tokens * price.cacheRead;
      total.cacheReadTokens += usage.cache_read_input_tokens;
      total.cacheCreationTokens += usage.cache_creation_input_tokens;
      total.assistantEventCount += 1;
      return total;
    },
    {
      weeklySpendU: 0,
      cacheReadSpendU: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      assistantEventCount: 0,
    },
  );
}

function roundU(value) {
  return Math.round(value);
}

function entry(detectorId, savingsU, weeklySpendU, eventCount) {
  return {
    detector_id: detectorId,
    event_count: eventCount,
    savings_u_per_wk: savingsU,
    usd_per_wk: Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
    weekly_spend_u: weeklySpendU,
    pct_of_weekly_spend: Number(((savingsU / weeklySpendU) * 100).toFixed(4)),
  };
}

function assertNumericOnly(value) {
  // null is a permitted, content-free "no $ owner here" marker: MED-1 (B2) and
  // MED-3 (C5) emit null savings by owner-assignment (2026-09-22 overlap ruling).
  if (value === null) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("golden economic values must be finite");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNumericOnly(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, item] of Object.entries(value)) {
      if (k === "detector_id") continue; // may be a string id for lettered detectors
      if (k === "bound" && item === "corpus") continue; // C1's closed structural bound label
      assertNumericOnly(item);
    }
    return;
  }
  throw new TypeError("golden economic artifact permits numeric values only");
}

function entryB4(detectorId, savingsU, avoidableBytes) {
  return {
    detector_id: detectorId,
    avoidable_bytes: avoidableBytes,
    savings_u_per_wk: savingsU,
    usd_per_wk: Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

const totals = sumUsage(SHARED_SEED_EVENTS);
// Cache-read reductions (D1 context trim, D6 tool-result carry) span every
// assistant turn, so they must be priced at the seed's own blended cache-read
// rate -- not a single model's -- else the mixed opus/sonnet seed is mispriced.
const blendedCacheReadPrice =
  totals.cacheReadTokens > 0 ? totals.cacheReadSpendU / totals.cacheReadTokens : 0;
// D1/D10 avoidance fraction (2026-09-22 overlap ruling): the always-loaded /
// catalog delta is discounted by 0.5 for parity with the B/C5/D6/D7 peers (some
// always-loaded context is genuinely needed and won't be trimmed).
const D1_D10_AVOIDANCE = 0.5;
const d1SavingsU = roundU(
  SEED.alwaysLoadedTrimTokens *
    D1_D10_AVOIDANCE *
    totals.assistantEventCount *
    blendedCacheReadPrice,
);
const d2SavingsU = roundU(totals.cacheReadSpendU * SEED.d2ReductionFraction);
const carryExposureTokens =
  (SEED.toolResultBytes / SEED.calibratedBytesPerToken) * SEED.toolResultCarryTurns;
const d6SavingsU = roundU(carryExposureTokens * SEED.d6AvoidanceFraction * blendedCacheReadPrice);
const d8SavingsU = roundU(
  totals.cacheCreationTokens * SEED.d8AvoidanceFraction * PRICE_PER_MTOK.sonnet.cacheCreation,
);

// B4 oracle -- bytes->token calibration savings for A1 / A2 / D12
// Fixed inputs from spec: bytes_per_token=8, avoidance_fraction=0.5, blended_write_price=3.75 USD/MTok
const B4 = {
  bytesPerToken: 8,
  avoidanceFraction: 0.5,
  blendedWritePrice: 3.75, // USD/MTok == µUSD/token
};

// A1: 4 events x max(0, 102400 - 25600) = 4 x 76800 = 307200 avoidable_bytes
const a1AvoidableBytes = 4 * Math.max(0, 102400 - 25600);
const a1SavingsU = roundU(
  (a1AvoidableBytes / B4.bytesPerToken) * B4.avoidanceFraction * B4.blendedWritePrice,
);

// A2: 3 events x max(0, 51200 - 10240) = 3 x 40960 = 122880 avoidable_bytes
const a2AvoidableBytes = 3 * Math.max(0, 51200 - 10240);
const a2SavingsU = roundU(
  (a2AvoidableBytes / B4.bytesPerToken) * B4.avoidanceFraction * B4.blendedWritePrice,
);

// D12 (U7): the subagent final turn is carried by the parent like any result: one write plus
// (carry - 1) reads. Inputs: 3 Agent calls, each returning 262144 tokens (2097152 B at 8 B/token),
// the parent has 3 later turns, cache-write 3.75 and cache-read 0.3 USD/MTok.
//   carry price = 3.75 + 0.3 x (3 - 1) = 4.35 USD/MTok
//   savings     = 786432 tokens x 0.5 x 4.35 = 1710489.6 -> 1710490 u
const d12AvoidableBytes = 6291456; // 786432 tokens x 8 B/token
const d12CarryTurns = 3;
const d12CacheReadPrice = 0.3; // USD/MTok
const d12SavingsU = roundU(
  (d12AvoidableBytes / B4.bytesPerToken) *
    B4.avoidanceFraction *
    (B4.blendedWritePrice + d12CacheReadPrice * (d12CarryTurns - 1)),
);

// B2-wave oracle -- cache family (B1/B2/B3/B4) token-savings + C5 error-loop savings
// B1/B2/B3/B4 share avoidance_fraction=0.5 and blended_write_price=3.75 with the B4 bytes wave.

function entryB2Cache(detectorId, savingsU, avoidableCreationTokens) {
  return {
    detector_id: detectorId,
    avoidable_creation_tokens: avoidableCreationTokens,
    savings_u_per_wk: savingsU,
    usd_per_wk: savingsU === null ? null : Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

function entryC5(detectorId, savingsU, displayedCeu, loopExcessErrorCount) {
  return {
    detector_id: detectorId,
    displayed_ceu: displayedCeu,
    loop_excess_error_count: loopExcessErrorCount,
    savings_u_per_wk: savingsU,
    usd_per_wk: savingsU === null ? null : Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

// B1 (P3.2, 2026-09-25): an in-TTL collapse (gap <= the thread's TTL) priced on the
// tokens re-created on the collapse turn, not prior - current reads (which is not what
// gets re-billed). Collapse turn writes cache_write_5m = 150000.
// U7 (2026-10-06): priced at the turn's own write tier minus its read price (3.75 - 0.3),
// the same net the claim ledger uses; was the full write price.
const b1AvoidableCreationTokens = 150000;
const CACHE_NET_WRITE_PRICE = PRICE_PER_MTOK.sonnet.cacheCreation - PRICE_PER_MTOK.sonnet.cacheRead;
const b1SavingsU = roundU(b1AvoidableCreationTokens * B4.avoidanceFraction * CACHE_NET_WRITE_PRICE);

// B2: same collapse pair (TTL-gap variant, > 60 min gap), avoidable = 200000 - 2000.
// MED-1 (2026-09-22 overlap ruling): B2's qualifying pairs are a strict subset of
// B1's, priced by the identical write-price formula — so B1 OWNS the collapse $ and
// B2 emits null savings (a conservative >1h-gap classification label). The avoidable
// token count stays as evidence; the $/wk is null so the headroom SUM counts these
// tokens once (via B1).
const b2AvoidableCreationTokens = 200000 - 2000;

// B3: resume cache miss, currentCreation = cache_write_5m = 100000, minus the unavoidable
// base prefix any fresh session loads (P3.2, 2026-09-25): the workspace's median
// first-turn context. Seed: 3 fresh sessions at 30000 + the prior (100000) and resume
// (102000) sessions → median 30000. U7: priced net of the read price, like B1.
const b3AvoidableCreationTokens = 100000 - 30000;
const b3SavingsU = roundU(b3AvoidableCreationTokens * B4.avoidanceFraction * CACHE_NET_WRITE_PRICE);

// B4 (token-grain): mid-session prefix break, avoidable = currentCreation - priorCreation = 120000 - 40000.
// Folded into B1 (P3.2, 2026-09-25): every B4 event is an in-TTL B1 collapse on the same
// turn, so B1 owns the $ and B4 emits null savings (basis O), as B2 does under MED-1.
const b4AvoidableCreationTokens = 120000 - 40000;

// C5: same-error-loop, floor path (expectedCeu = null for all excess errors in seed)
// Per excess error (input-token-equivalents):
//   callAndResultTokens = 34000 bytes / 3.4 bytes_per_token = 10000
//   floorCeu = 10000 x (wWrite5m + wRead)  where wWrite5m=3.75/3, wRead=0.3/3
//   outputCeu = 500 x (15/3)
// 3 excess errors -> displayedCeu = 3 x (floorCeu_per_error + outputCeu_per_error)
// savings_u = round(displayedCeu x blended_input_price)   blended_input_price=3.0 USD/MTok
const C5_EXCESS_ERRORS = 3;
const C5_CALL_RESULT_TOKENS = 34000 / 3.4; // = 10000 tokens
const C5_OUTPUT_TOKENS = 500;
const c5InputPrice = PRICE_PER_MTOK.sonnet.input; // 3.0 USD/MTok
const c5FloorCeuPerError =
  C5_CALL_RESULT_TOKENS *
    (PRICE_PER_MTOK.sonnet.cacheCreation / c5InputPrice +
      PRICE_PER_MTOK.sonnet.cacheRead / c5InputPrice) +
  C5_OUTPUT_TOKENS * (PRICE_PER_MTOK.sonnet.output / c5InputPrice);
// MED-3 (2026-09-22 overlap ruling): D7 is the single owner of loop economics
// (cap-weighted read basis). C5 clusters the SAME identical-error loops on an input
// basis, so pricing it double-counted the loop turns in the headroom SUM. C5 emits
// null savings and stays a friction/advisory finding; the displayed CEU band remains
// as loop-severity evidence, not a $ claim.
const c5DisplayedCeu = C5_EXCESS_ERRORS * c5FloorCeuPerError;

// B2 sub-set 2 oracle — G11 / D7 / D7_XREAD / D10
// All priced at blended cache-READ rate = PRICE_PER_MTOK.sonnet.cacheRead = 0.3 (fixed spec input).
const B2_2_CACHE_READ_PRICE = PRICE_PER_MTOK.sonnet.cacheRead; // 0.3 USD/MTok == µUSD/token
const B2_2_AVOIDANCE = 0.5;

function entryG11(detectorId, savingsU, excessTokens, avoidanceFraction, blendedCacheReadPrice) {
  return {
    detector_id: detectorId,
    excess_tokens: excessTokens,
    avoidance_fraction: avoidanceFraction,
    blended_cache_read_price: blendedCacheReadPrice,
    savings_u_per_wk: savingsU,
    usd_per_wk: Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

function entryD7(detectorId, savingsU, repeatExcessCostU, avoidanceFraction) {
  return {
    detector_id: detectorId,
    repeat_excess_cost_u: repeatExcessCostU,
    avoidance_fraction: avoidanceFraction,
    savings_u_per_wk: savingsU,
    usd_per_wk: Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

function entryD7Xread(
  detectorId,
  savingsU,
  totalRedundantResultBytes,
  totalRedundantReadCount,
  redundantPathCount,
  bytesPerToken,
  avoidableTokens,
  carryPriceUsdPerMtok,
) {
  return {
    detector_id: detectorId,
    total_redundant_result_bytes: totalRedundantResultBytes,
    total_redundant_read_count: totalRedundantReadCount,
    redundant_path_count: redundantPathCount,
    bytes_per_token: bytesPerToken,
    avoidable_tokens: avoidableTokens,
    carry_price_usd_per_mtok: carryPriceUsdPerMtok,
    savings_u_per_wk: savingsU,
    usd_per_wk: Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

function entryD10(
  detectorId,
  savingsU,
  deltaContextTokens,
  globalTurnsPerWeek,
  blendedCacheReadPrice,
) {
  return {
    detector_id: detectorId,
    delta_context_tokens: deltaContextTokens,
    global_turns_per_week: globalTurnsPerWeek,
    blended_cache_read_price: blendedCacheReadPrice,
    savings_u_per_wk: savingsU,
    usd_per_wk: Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

// G11: excess_tokens = 300000 - 100000 = 200000; avoidance=0.5; read price=0.3
const g11ExcessTokens = 300000 - 100000;
const g11SavingsU = roundU(g11ExcessTokens * B2_2_AVOIDANCE * B2_2_CACHE_READ_PRICE);

// D7 (loop rollup), V2 (review 5 B1): Σ the repeat-excess turns' stored cost_equiv_u × 0.5.
// The b2-savings-2 fixture has one repeat-excess turn, an Opus turn priced by class at ingest:
//   cache reads   100,000 × $0.50/M  = 50,000 µUSD
//   5m writes       2,000 × $6.25/M  = 12,500 µUSD
//   input              10 × $5/M     =     50 µUSD
//   output            500 × $25/M    = 12,500 µUSD
//   stored cost_equiv_u                = 75,050 µUSD → saving 75,050 × 0.5 = 37,525 µUSD.
// (V1, cap-weighted tokens × read price, is no longer exported, so its row is gone.)
const d7RepeatExcessCostU =
  100_000 * PRICE_PER_MTOK.opus.cacheRead +
  2_000 * PRICE_PER_MTOK.opus.cacheCreation +
  10 * PRICE_PER_MTOK.opus.input +
  500 * PRICE_PER_MTOK.opus.output;
const d7SavingsU = roundU(d7RepeatExcessCostU * B2_2_AVOIDANCE);

// D7_XREAD (U7): one path read 10 times (6 + 4) in 2 sessions, bytes_per_token=4.
// 20,000 bytes a read: reads over A1's 25 KB threshold are A1's, not D7's (P3.1 review 1, R2.7).
// Cross-session only (P3.1-T9): each session's first read of the path is one read; the origin
// session's read is not redundant, so exactly 1 re-read (20,000 B) is priced. It is carried
// by its owner chain: 3 later turns, so one cache write then (3 - 1) reads, cw5m 3.75 and
// read 0.3 USD/MTok, x the 0.5 avoidance fraction.
//   tokens      = 20000 / 4                 = 5000
//   carry price = 3.75 + 0.3 x (3 - 1)      = 4.35 USD/MTok
//   savings     = 5000 x 4.35 x 0.5         = 10875 u
const d7xTotalRedundantResultBytes = 20000;
const d7xTotalRedundantReadCount = 1;
const d7xRedundantPathCount = 1;
const d7xBytesPerToken = 4;
const d7xCarryTurns = 3;
const d7xRereadUnits = d7xTotalRedundantResultBytes / d7xBytesPerToken;
const d7xCarryPrice =
  PRICE_PER_MTOK.sonnet.cacheCreation + B2_2_CACHE_READ_PRICE * (d7xCarryTurns - 1);
const d7xSavingsU = roundU(d7xRereadUnits * d7xCarryPrice * B2_2_AVOIDANCE);

// D10 (global): delta=140000-40000=100000; global_turns_per_week=10; read price=0.3; no avoidance
// D10 mirrors D1: ×0.5 avoidance (2026-09-22). The detector additionally NULLs the
// $/wk under deferred/threshold Tool-Search (catalog not resident per turn); this
// oracle entry is the resident-state (upfront/alwaysLoad) value the b2-savings-2
// D10 test seeds. The deferred→null gating is asserted directly in that suite.
const d10DeltaContextTokens = 140000 - 40000;
const d10GlobalTurnsPerWeek = 10;
const d10SavingsU = roundU(
  d10DeltaContextTokens * D1_D10_AVOIDANCE * d10GlobalTurnsPerWeek * B2_2_CACHE_READ_PRICE,
);

// B3 wasted-turn attribution — fixed spec scenario (test/detector/b3-attribution.test.ts).
// Each claimed turn is priced at cost_equiv_u = 100000 µUSD; avoidance = 0.5.
// savings_u_per_wk = round( claimed_turn_count × turn_cost_u × avoidance ). No price
// term — cost_equiv_u is already µUSD. Claimed counts are the turn-grain dedup outcome
// (C5/D7 loop turns excluded first; priority C7 > C3 > C4 > C1):
//   C3 = 1 edit-before-read; C1 = 1 WebFetch solo error (its 3 loop turns excluded,
//   its Bash overlap taken by C7).
// MED-2 (2026-09-22 overlap ruling): turn-claim now excludes exactly D7's
// repeat-excess loop turns (`analyzeD7LoopEvents`, friction on). A tight run of ≥3
// same-tool ERRORs within 120s is a D7 loop, so D7 owns all-but-first: the 3-error
// Bash-git cluster (C7) and the 5-error Edit recovery loop (C4) each leave only their
// FIRST failure claimable → C7 = 1, C4 = 1. C3's lone error and C1's solo are not
// loops, so they are unchanged.
const B3_TURN_COST_U = 100_000;
const B3_AVOIDANCE = 0.5;
function b3Entry(claimedTurnCount) {
  const savingsU = roundU(claimedTurnCount * B3_TURN_COST_U * B3_AVOIDANCE);
  return {
    claimed_turn_count: claimedTurnCount,
    savings_u_per_wk: savingsU,
    usd_per_wk: Number((savingsU / MICRO_USD_PER_USD).toFixed(2)),
  };
}

const golden = {
  1: entry(1, d1SavingsU, totals.weeklySpendU, totals.assistantEventCount),
  2: entry(2, d2SavingsU, totals.weeklySpendU, totals.assistantEventCount),
  6: entry(6, d6SavingsU, totals.weeklySpendU, totals.assistantEventCount),
  8: entry(8, d8SavingsU, totals.weeklySpendU, totals.assistantEventCount),
  A1: entryB4("A1", a1SavingsU, a1AvoidableBytes),
  A2: entryB4("A2", a2SavingsU, a2AvoidableBytes),
  D12: entryB4("D12", d12SavingsU, d12AvoidableBytes),
  B1: entryB2Cache("B1", b1SavingsU, b1AvoidableCreationTokens),
  B2: entryB2Cache("B2", null, b2AvoidableCreationTokens),
  B3: entryB2Cache("B3", b3SavingsU, b3AvoidableCreationTokens),
  B4: entryB2Cache("B4", null, b4AvoidableCreationTokens),
  C5: entryC5("C5", null, c5DisplayedCeu, C5_EXCESS_ERRORS),
  G11: entryG11("G11", g11SavingsU, g11ExcessTokens, B2_2_AVOIDANCE, B2_2_CACHE_READ_PRICE),
  D7: entryD7("D7", d7SavingsU, d7RepeatExcessCostU, B2_2_AVOIDANCE),
  D7_XREAD: entryD7Xread(
    "D7_XREAD",
    d7xSavingsU,
    d7xTotalRedundantResultBytes,
    d7xTotalRedundantReadCount,
    d7xRedundantPathCount,
    d7xBytesPerToken,
    d7xRereadUnits,
    d7xCarryPrice,
  ),
  D10: entryD10(
    "D10",
    d10SavingsU,
    d10DeltaContextTokens,
    d10GlobalTurnsPerWeek,
    B2_2_CACHE_READ_PRICE,
  ),
  b3_attribution: {
    C7: b3Entry(1),
    C3: b3Entry(1),
    C4: b3Entry(1),
    C1: { ...b3Entry(1), bound: "corpus" },
  },
};

assertNumericOnly(golden);
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(golden, null, 2)}\n`);
