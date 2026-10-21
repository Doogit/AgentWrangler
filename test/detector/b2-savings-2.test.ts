/**
 * test/detector/b2-savings-2.test.ts — B2 savings models sub-set 2: G11 / D7 / D10.
 *
 * Seeds the spec's fixed inputs, runs detectors, and asserts modeled_savings_u_per_wk
 * is within ±5% of each oracle entry in scripts/parity/golden-economic.json.
 *
 * Oracle is the independent source of truth — never hardcode expected values here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_WORKSPACE_ID, encodeToolSearchState } from "../../src/detector/context-probe.js";
import { d7Detector } from "../../src/detector/detectors/d7_loop_retry_waste.js";
import { d10Detector } from "../../src/detector/detectors/d10_catalog_footprint.js";
import { g11Detector } from "../../src/detector/detectors/g11_high_spend_failure.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ── Oracle ────────────────────────────────────────────────────────────────────

interface OracleEntry {
  detector_id: string | number;
  savings_u_per_wk: number;
  usd_per_wk: number;
}

const ORACLE = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../scripts/parity/golden-economic.json"), "utf8"),
) as Record<string, OracleEntry>;

function assertWithinOracle(actual: number | null, key: string): void {
  const entry = ORACLE[key];
  if (entry === undefined) throw new Error(`oracle key "${key}" not found`);
  if (actual === null) throw new Error(`expected non-null savings for ${key}`);
  const oracle = entry.savings_u_per_wk;
  const delta = Math.abs(actual - oracle) / oracle;
  expect(delta).toBeLessThanOrEqual(0.05);
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};

// sonnet-4 pricing: [input=3, output=15, cacheRead=0.3, cw5m=3.75, cw1h=6]
const SONNET4_PRICES = "[3,15,0.3,3.75,6]";

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-b2s2-sonnet', 'sonnet-4', ?, '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run(SONNET4_PRICES);
});

afterEach(() => db.close());

/** Insert workspace (idempotent). */
function insWorkspace(workspaceId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(workspaceId, workspaceId);
}

/** Insert a RECONCILED session. */
function insSession(workspaceId: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2027-01-03T10:00:00.000Z', '2027-01-03T12:00:00.000Z',
             'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fixture/${sessionId}.jsonl`);
}

/** Insert a non-provisional turn with sonnet-4 pricing. */
function insTurn(
  workspaceId: string,
  sessionId: string,
  ts: string,
  opts: {
    cacheReadTokens?: number;
    inputTokens?: number;
    costEquivU?: number;
  } = {},
): string {
  const messageId = `msg-b2s2-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0,
             ?, 0, ?, 0, 0, 0, 0, 'snap-b2s2-sonnet',
             ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    workspaceId,
    ts,
    opts.inputTokens ?? 0,
    opts.cacheReadTokens ?? 0,
    opts.costEquivU ?? 0,
  );
  return messageId;
}

// ── G11 savings — spec fixed inputs ──────────────────────────────────────────
// ws-b2-g11: 20 success items (input_cache_tokens=100000 each) → p90=100000
// 1 failure item (input_cache_tokens=300000 ≥ p90) → excess=200000
// blended read price = 0.3 (sonnet-4, cache_read_tokens on all turns)
// savings = 200000 × 0.5 × 0.3 = 30000 µUSD

describe("G11 — high-spend-failure modeled savings", () => {
  function seedG11(
    workspaceId: string,
    itemCount: number,
    opts: { cacheReadTokens?: number } = {},
  ): void {
    insWorkspace(workspaceId);

    // itemCount success work items, each with a unique session
    for (let i = 0; i < itemCount; i++) {
      const sessId = `sess-g11-ok-${workspaceId}-${i}`;
      const wiId = `g11:${workspaceId}#${i}`;
      insSession(workspaceId, sessId);
      insTurn(workspaceId, sessId, "2027-01-03T10:00:00.000Z", {
        cacheReadTokens: opts.cacheReadTokens ?? 100_000,
        inputTokens: 0,
      });
      db.prepare(
        `INSERT OR IGNORE INTO work_items
           (work_item_id, workspace_id, number, state, merged_at, synced_at)
         VALUES (?, ?, ?, 'MERGED', '2027-01-03T12:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
      ).run(wiId, workspaceId, i);
      db.prepare(
        `INSERT OR IGNORE INTO observed_outcomes
           (work_item_id, outcome, derived_at, methodology_version)
         VALUES (?, 'OBSERVED_SUCCESS', '2027-01-03T12:00:00.000Z', 'g11-v1')`,
      ).run(wiId);
      db.prepare(
        `INSERT OR IGNORE INTO session_work_links
           (session_id, work_item_id, confidence, method)
         VALUES (?, ?, 1.0, 'BRANCH')`,
      ).run(sessId, wiId);
    }

    // 1 failure work item
    const failSessId = `sess-g11-fail-${workspaceId}`;
    const failWiId = `g11:${workspaceId}#fail`;
    insSession(workspaceId, failSessId);
    insTurn(workspaceId, failSessId, "2027-01-03T11:00:00.000Z", {
      cacheReadTokens: opts.cacheReadTokens !== undefined ? opts.cacheReadTokens * 3 : 300_000,
      inputTokens: 0,
    });
    db.prepare(
      `INSERT OR IGNORE INTO work_items
         (work_item_id, workspace_id, number, state, merged_at, synced_at)
       VALUES (?, ?, 999, 'MERGED', '2027-01-03T12:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
    ).run(failWiId, workspaceId);
    db.prepare(
      `INSERT OR IGNORE INTO observed_outcomes
         (work_item_id, outcome, derived_at, methodology_version)
       VALUES (?, 'OBSERVED_FAILURE', '2027-01-03T12:00:00.000Z', 'g11-v1')`,
    ).run(failWiId);
    db.prepare(
      `INSERT OR IGNORE INTO session_work_links
         (session_id, work_item_id, confidence, method)
       VALUES (?, ?, 1.0, 'BRANCH')`,
    ).run(failSessId, failWiId);
  }

  it("emits savings within ±5% of oracle", () => {
    const WS = "ws-b2-g11";
    seedG11(WS, 20);

    const outcome = g11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WS);
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "G11");
  });

  it("emits null when no cache-read price (turns have no cache_read_tokens)", () => {
    const WS = "ws-b2-g11-noprice";
    // 20 success items with input_tokens only (cache_read_tokens=0 → price=0)
    insWorkspace(WS);
    for (let i = 0; i < 20; i++) {
      const sessId = `sess-g11-np-ok-${i}`;
      const wiId = `g11:${WS}#${i}`;
      insSession(WS, sessId);
      insTurn(WS, sessId, "2027-01-03T10:00:00.000Z", { inputTokens: 100_000 });
      db.prepare(
        `INSERT OR IGNORE INTO work_items
           (work_item_id, workspace_id, number, state, merged_at, synced_at)
         VALUES (?, ?, ?, 'MERGED', '2027-01-03T12:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
      ).run(wiId, WS, i);
      db.prepare(
        `INSERT OR IGNORE INTO observed_outcomes
           (work_item_id, outcome, derived_at, methodology_version)
         VALUES (?, 'OBSERVED_SUCCESS', '2027-01-03T12:00:00.000Z', 'g11-v1')`,
      ).run(wiId);
      db.prepare(
        `INSERT OR IGNORE INTO session_work_links
           (session_id, work_item_id, confidence, method)
         VALUES (?, ?, 1.0, 'BRANCH')`,
      ).run(sessId, wiId);
    }
    const failSessId = "sess-g11-np-fail";
    const failWiId = `g11:${WS}#fail`;
    insSession(WS, failSessId);
    insTurn(WS, failSessId, "2027-01-03T11:00:00.000Z", { inputTokens: 300_000 });
    db.prepare(
      `INSERT OR IGNORE INTO work_items
         (work_item_id, workspace_id, number, state, merged_at, synced_at)
       VALUES (?, ?, 999, 'MERGED', '2027-01-03T12:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
    ).run(failWiId, WS);
    db.prepare(
      `INSERT OR IGNORE INTO observed_outcomes
         (work_item_id, outcome, derived_at, methodology_version)
       VALUES (?, 'OBSERVED_FAILURE', '2027-01-03T12:00:00.000Z', 'g11-v1')`,
    ).run(failWiId);
    db.prepare(
      `INSERT OR IGNORE INTO session_work_links
         (session_id, work_item_id, confidence, method)
       VALUES (?, ?, 1.0, 'BRANCH')`,
    ).run(failSessId, failWiId);

    const outcome = g11Detector.evaluate(db, CTX);
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WS);
    if (fired !== undefined) {
      // cache_read_tokens=0 on all turns → blended read price = 0 → null
      expect(fired.modeled_savings_u_per_wk).toBeNull();
    }
  });

  it("emits no savings when G11 does not fire (fewer than 20 comparison items)", () => {
    const WS = "ws-b2-g11-nofire";
    // Only 19 success items → p90 returns null → no fire
    seedG11(WS, 19);
    // Remove the failure item from the 20-item seed (seedG11 still makes 19+1)
    // Actually seedG11(WS, 19) creates 19 success + 1 failure.
    // Comparison set = 19 success (candidate excluded) → percentile90(19 items) returns null.
    const outcome = g11Detector.evaluate(db, CTX);
    // May fire for other workspaces but not for ws-b2-g11-nofire
    const fired = outcome.fired.filter((f) => f.scope_workspace_id === WS);
    expect(fired.length).toBe(0);
  });
});

// ── D7 loop savings — spec fixed inputs (V2, review 5 B1) ────────────────────
// ws-b2-d7: 1 RECONCILED session, 3 identical tool calls in 2 turns: the first call in turn 1,
// the two repeats in turn 2, so turn 2 is the one repeat-excess turn (deduped by owner message).
// Turn 2 is an Opus turn: reads 100,000 @ $0.50/M, 5m writes 2,000 @ $6.25/M, input 10 @ $5/M,
// output 500 @ $25/M → 50,000 + 12,500 + 50 + 12,500 = 75,050 µUSD, stored as cost_equiv_u.
// V2: saving = round(Σ stored cost_equiv_u × 0.5) = 37,525 µUSD.
// V1 on the same turn: cap weight 2,000 + 0.1 × 100,000 + 10 + 500 = 12,510 × 0.5 × $0.50 read
// price = 3,127.5 µUSD — the two models differ.

describe("D7 loop — loop-retry-waste modeled savings", () => {
  function seedD7Loop(workspaceId: string): void {
    insWorkspace(workspaceId);
    db.prepare(
      `INSERT OR IGNORE INTO pricing_snapshots
         (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
       VALUES ('snap-b2s2-opus', 'opus', '[5,25,0.5,6.25,10]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
    ).run();
    const sessId = `sess-d7-loop-${workspaceId}`;
    insSession(workspaceId, sessId);
    const TS_BASE = new Date("2027-01-03T10:00:00.000Z").getTime();
    const turn = (i: number, costU: number): string => {
      const messageId = `msg-b2s2-${seq++}`;
      db.prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m, cache_write_1h, cache_write_other,
            tool_result_bytes, pricing_snapshot_id,
            cost_equiv_u, cost_claim, provisional, parser_version)
         VALUES (?, ?, ?, ?, 'claude-opus-4-7', 0,
                 10, 500, 100000, 2000, 0, 0, 0, 'snap-b2s2-opus',
                 ?, 'LIST_EQUIV', 0, 'test-v1')`,
      ).run(messageId, sessId, workspaceId, new Date(TS_BASE + i * 1000).toISOString(), costU);
      return messageId;
    };
    // Turn 1 (not a repeat) carries a large cost that must not be counted.
    const owners = [turn(0, 999_999)];
    owners.push(turn(1, 75_050));
    // F14: each call needs its own message to count; a zero-cost third turn keeps the oracle $.
    owners.push(turn(2, 0));
    for (let i = 0; i < 3; i++) {
      const ts = new Date(TS_BASE + i * 1000).toISOString();
      const eventId = `evt-d7-loop-${workspaceId}-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
            input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'ToolA', 1, NULL, 'same-hash-d7', NULL, NULL)`,
      ).run(eventId, sessId, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata
           (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, NULL, ?, ?, 0)`,
      ).run(eventId, owners[i], i);
    }
  }

  it("emits savings within ±5% of oracle", () => {
    const WS = "ws-b2-d7";
    seedD7Loop(WS);

    const outcome = d7Detector.evaluate(db, CTX);
    const fired = outcome.fired.find(
      (f) => f.scope_workspace_id === WS && f.payload.template_id === "D7_RETRY_LOOP",
    );
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "D7");
    // Basis P: pass-through of the stored figure (75,050 µUSD stored turn cost × 0.5 = 37,525).
    expect(fired?.modeled_savings_u_per_wk).toBe(37_525);
    expect(fired?.modeled_savings_u_per_wk).not.toBe(Math.round(12_510 * 0.5 * 0.5));
    expect(fired?.modeled_formula_json?.estimate).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 37_525,
      summable: false,
    });
    const facts = fired?.payload.facts as Record<string, unknown>;
    expect(facts.repeat_excess_turn_count).toBe(2);
    expect(facts.repeat_excess_cost_u).toBe(75_050);
  });

  it("emits null when no cache-read price (turns have no cache_read_tokens)", () => {
    const WS = "ws-b2-d7-noprice";
    insWorkspace(WS);
    const sessId = `sess-d7-np-${WS}`;
    insSession(WS, sessId);
    const TS_BASE = new Date("2027-01-03T10:00:00.000Z").getTime();
    for (let i = 0; i < 3; i++) {
      const ts = new Date(TS_BASE + i * 1000).toISOString();
      // cache_read_tokens=0 → blended read price = 0
      const msgId = insTurn(WS, sessId, ts, { cacheReadTokens: 0 });
      const eventId = `evt-d7-np-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
            input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'ToolA', 1, NULL, 'same-hash-np', NULL, NULL)`,
      ).run(eventId, sessId, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata
           (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, NULL, ?, ?, 0)`,
      ).run(eventId, msgId, i);
    }

    const outcome = d7Detector.evaluate(db, CTX);
    const fired = outcome.fired.find(
      (f) => f.scope_workspace_id === WS && f.payload.template_id === "D7_RETRY_LOOP",
    );
    if (fired !== undefined) {
      expect(fired.modeled_savings_u_per_wk).toBeNull();
    }
  });

  it("emits no savings when D7 does not fire (only 2 identical calls — below MIN_RUN=3)", () => {
    const WS = "ws-b2-d7-nofire";
    insWorkspace(WS);
    const sessId = `sess-d7-nf-${WS}`;
    insSession(WS, sessId);
    const TS_BASE = new Date("2027-01-03T10:00:00.000Z").getTime();
    // Only 2 identical calls → run length < MIN_RUN=3 → no flaggedEventIds
    for (let i = 0; i < 2; i++) {
      const ts = new Date(TS_BASE + i * 1000).toISOString();
      const msgId = insTurn(WS, sessId, ts, { cacheReadTokens: 100_000 });
      const eventId = `evt-d7-nf-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
            input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'ToolA', 1, NULL, 'same-hash-nf', NULL, NULL)`,
      ).run(eventId, sessId, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata
           (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, NULL, ?, ?, 0)`,
      ).run(eventId, msgId, i);
    }

    const outcome = d7Detector.evaluate(db, CTX);
    const fired = outcome.fired.filter(
      (f) => f.scope_workspace_id === WS && f.payload.template_id === "D7_RETRY_LOOP",
    );
    expect(fired.length).toBe(0);
  });
});

// ── D7-XREAD savings — spec fixed inputs ─────────────────────────────────────
// ws-b2-d7x: 1 path read 10 times across 2 sessions (6+4), result_bytes=20000 each
// (at or under A1's 25 KB threshold, so D7 owns them: review 1 R2.7)
// bytes_per_token=4 (calibrated via user_config)
// Cross-session only (P3.1-T9): one read per session; session A's is the origin, so one
// redundant re-read (session B's first, 20000 bytes = 5000 tokens at bpt 4).
// U7 carry model: the re-read's owner turn has 3 later turns in B; the first writes it
// (cw5m 3.75), the other 2 read it (0.3): 3.75 + 0.3 × 2 = 4.35 USD/MTok.
// savings = 5000 × 4.35 × 0.5 avoidance = 10875 µUSD (oracle D7_XREAD).
// Gate: 21750 µUSD carry cost vs 5 priced turns × 100000 = 500000 spend = 4.35% ≥ 0.1%.
const XREAD_TURN_COST_U = 100_000;

describe("D7-XREAD — cross-session reread modeled savings", () => {
  function setCalibrated(): void {
    db.prepare(
      `INSERT OR REPLACE INTO user_config (key, value, updated_at)
       VALUES ('bytes_per_token', '4', '2027-01-01T00:00:00.000Z')`,
    ).run();
    // provenance: just set the measured_at so it parses as calibrated
    db.prepare(
      `INSERT OR REPLACE INTO user_config (key, value, updated_at)
       VALUES ('bytes_per_token_measured_at', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
    ).run();
  }

  function seedXread(workspaceId: string, owned = true): void {
    insWorkspace(workspaceId);
    const FILE_PATH_HASH = `fph-d7x-${workspaceId}`;

    // Session A: 6 reads
    const sessA = `sess-d7x-a-${workspaceId}`;
    insSession(workspaceId, sessA);
    // Owner turn of session A's reads (a priced turn: counts toward workspace spend).
    const turnA = insTurn(workspaceId, sessA, "2027-01-03T10:00:00.000Z", {
      cacheReadTokens: 10_000,
      costEquivU: XREAD_TURN_COST_U,
    });
    const ownerA = owned ? turnA : null;
    for (let i = 0; i < 6; i++) {
      const ts = new Date(new Date("2027-01-03T10:00:00.000Z").getTime() + i * 1000).toISOString();
      const eventId = `evt-d7x-a-${workspaceId}-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
            input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'Read', 100, 20000, NULL, NULL, NULL)`,
      ).run(eventId, sessA, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata
           (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, ?, ?, ?, 0)`,
      ).run(eventId, FILE_PATH_HASH, ownerA, i);
    }

    // Session B: 4 reads, owned by one turn that 3 later turns carry (the redundant re-read)
    const sessB = `sess-d7x-b-${workspaceId}`;
    insSession(workspaceId, sessB);
    const turnB = insTurn(workspaceId, sessB, "2027-01-04T10:00:00.000Z", {
      cacheReadTokens: 10_000,
      costEquivU: XREAD_TURN_COST_U,
    });
    const ownerB = owned ? turnB : null;
    for (const minute of [1, 2, 3]) {
      insTurn(workspaceId, sessB, `2027-01-04T10:0${minute}:00.000Z`, {
        cacheReadTokens: 10_000,
        costEquivU: XREAD_TURN_COST_U,
      });
    }
    for (let i = 0; i < 4; i++) {
      const ts = new Date(new Date("2027-01-04T10:00:00.000Z").getTime() + i * 1000).toISOString();
      const eventId = `evt-d7x-b-${workspaceId}-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
            input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'Read', 100, 20000, NULL, NULL, NULL)`,
      ).run(eventId, sessB, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata
           (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, ?, ?, ?, 0)`,
      ).run(eventId, FILE_PATH_HASH, ownerB, i);
    }
  }

  it("emits savings within ±5% of oracle", () => {
    const WS = "ws-b2-d7x";
    setCalibrated();
    seedXread(WS);

    const outcome = d7Detector.evaluate(db, CTX);
    const fired = outcome.fired.find(
      (f) => f.scope_workspace_id === WS && f.payload.template_id === "D7_CROSS_SESSION_REREAD",
    );
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "D7_XREAD");
    // Basis E, calibrated bpt 4, carry price 4.35 $/MTok (sonnet-4 owner turn, 3 later turns):
    // 20,000 bytes / 4 * 4.35 * 0.5 = 10,875 µUSD/wk.
    expect(fired?.modeled_formula_json?.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 10_875,
      summable: true,
    });
  });

  // U7 (7550270f): an uncalibrated bytes/token no longer blanks the $; it falls back to 2.7.
  it("prices at the 2.7 bytes/token fallback when bytes_per_token is uncalibrated", () => {
    const WS = "ws-b2-d7x-uncal";
    // No setCalibrated() → resolveBytesPerToken returns calibrated=false
    seedXread(WS);

    const outcome = d7Detector.evaluate(db, CTX);
    const fired = outcome.fired.find(
      (f) => f.scope_workspace_id === WS && f.payload.template_id === "D7_CROSS_SESSION_REREAD",
    );
    // 20,000 / 2.7 tokens * 4.35 * 0.5 = 16,111.1 -> 16,111 µUSD/wk.
    expect(fired?.modeled_savings_u_per_wk).toBe(16_111);
  });

  // U7: the price is the owner turn's own, so an unowned re-read has no price, not a blended one.
  it("emits null when the re-read has no owner turn to price", () => {
    const WS = "ws-b2-d7x-noprice";
    setCalibrated();
    seedXread(WS, false); // owned=false → owner_message_id NULL → carry unknown

    const outcome = d7Detector.evaluate(db, CTX);
    const fired = outcome.fired.find(
      (f) => f.scope_workspace_id === WS && f.payload.template_id === "D7_CROSS_SESSION_REREAD",
    );
    expect(fired).toBeDefined();
    expect(fired?.modeled_savings_u_per_wk).toBeNull();
  });

  it("emits no savings when D7-XREAD does not fire (fewer than 10 reads total)", () => {
    const WS = "ws-b2-d7x-nofire";
    setCalibrated();
    insWorkspace(WS);
    const FILE_PATH_HASH = `fph-d7x-nf-${WS}`;

    // Only 9 reads total → below MIN_CROSS_SESSION_READS=10 → no fire
    const sessA = `sess-d7x-nf-a-${WS}`;
    insSession(WS, sessA);
    insTurn(WS, sessA, "2027-01-03T10:00:00.000Z", { cacheReadTokens: 10_000 });
    for (let i = 0; i < 5; i++) {
      const ts = new Date(new Date("2027-01-03T10:00:00.000Z").getTime() + i * 1000).toISOString();
      const eventId = `evt-d7x-nf-a-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'Read', 100, 20000, NULL, NULL, NULL)`,
      ).run(eventId, sessA, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, ?, NULL, ?, 0)`,
      ).run(eventId, FILE_PATH_HASH, i);
    }
    const sessB = `sess-d7x-nf-b-${WS}`;
    insSession(WS, sessB);
    insTurn(WS, sessB, "2027-01-04T10:00:00.000Z", { cacheReadTokens: 10_000 });
    for (let i = 0; i < 4; i++) {
      const ts = new Date(new Date("2027-01-04T10:00:00.000Z").getTime() + i * 1000).toISOString();
      const eventId = `evt-d7x-nf-b-${seq++}`;
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha)
         VALUES (?, ?, ?, 'Read', 100, 20000, NULL, NULL, NULL)`,
      ).run(eventId, sessB, ts);
      db.prepare(
        `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
         VALUES (?, ?, NULL, ?, 0)`,
      ).run(eventId, FILE_PATH_HASH, i);
    }
    // Total = 5+4 = 9 < MIN_CROSS_SESSION_READS=10 → no fire for WS

    const outcome = d7Detector.evaluate(db, CTX);
    const fired = outcome.fired.filter(
      (f) => f.scope_workspace_id === WS && f.payload.template_id === "D7_CROSS_SESSION_REREAD",
    );
    expect(fired.length).toBe(0);
  });
});

// ── D10 savings — spec fixed inputs ──────────────────────────────────────────
// U7: removable (unused-item) tokens = 100000 of a 140000 catalog → delta = 100000
// global_turns_per_week = 10 (inserted explicitly in 2027 window)
// blended global read price = 0.3 (sonnet-4 cache_read_tokens)
// avoidance_fraction = 0.5 (2026-09-22 ruling), catalog resident (upfront)
// savings = 100000 × 0.5 × 10 × 0.3 = 150000 µUSD

describe("D10 — catalog-footprint modeled savings", () => {
  // Default to an upfront catalog state; the deferred case is asserted separately below
  // (U7: skill descriptions stay resident under deferred Tool Search, so it is priced too).
  function seedD10Base(catalogState: "upfront" | "deferred" = "upfront"): void {
    // GLOBAL_WORKSPACE_ID workspace (required for context_inventory FK)
    insWorkspace(GLOBAL_WORKSPACE_ID);

    // SETTINGS_SYSTEM row so stateRow() is non-null
    const state = encodeToolSearchState({
      tool_search_mode: catalogState,
      effective_catalog_state: catalogState,
      configured_value: "true",
      always_load_flags: [],
      always_load_count: 0,
      always_load_flags_truncated: false,
      catalog_item_count: 5,
      catalog_item_count_truncated: false,
      catalog_hash: "a".repeat(40),
    });
    db.prepare(
      `INSERT OR REPLACE INTO context_inventory
         (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
       VALUES ('probe-d10s2-settings', ?, '2027-01-07T00:00:00.000Z', 'SETTINGS_SYSTEM',
               '/settings.json', 'settings-hash', 0, ?)`,
    ).run(GLOBAL_WORKSPACE_ID, state);

    // U7: per-item catalog rows. Two unused items summing to 100000 removable tokens,
    // plus one used skill (not removable) — catalog total 140000.
    insCatalogSkill("unused-a", 60_000);
    insCatalogSkill("unused-b", 40_000);
    insCatalogSkill("used-c", 40_000);
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES ('d10s2-use', 'sess-a1', '2027-01-04T00:00:00.000Z', 'Skill')",
    ).run();
    db.prepare(
      "INSERT INTO tool_event_skills (event_id, skill_name) VALUES ('d10s2-use', 'used-c')",
    ).run();
  }

  function insCatalogSkill(name: string, tokens: number): void {
    db.prepare(
      `INSERT INTO catalog_items
         (item_id, kind, name, plugin, usage_key, tokens, bytes, size_basis, source, probed_at)
       VALUES (?, 'skill', ?, NULL, ?, ?, ?, 'chars4-v1', 'synthetic', '2027-01-07T00:00:00.000Z')`,
    ).run(`skill|${name}`, name, name, tokens, tokens * 4);
  }

  function insGlobalTurns(count: number, cacheReadTokens = 10_000, inputTokens = 0): void {
    // Use ws-alpha (exists in fixture DB) for turns
    const TS_BASE = new Date("2027-01-03T10:00:00.000Z").getTime();
    for (let i = 0; i < count; i++) {
      const msgId = `msg-d10s2-${seq++}`;
      const ts = new Date(TS_BASE + i * 60_000).toISOString();
      db.prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m, cache_write_1h, cache_write_other,
            tool_result_bytes, pricing_snapshot_id,
            cost_equiv_u, cost_claim, provisional, parser_version)
         VALUES (?, 'sess-a1', 'ws-alpha', ?, 'claude-sonnet-4-6', 0,
                 ?, 0, ?, 0, 0, 0, 0, 'snap-b2s2-sonnet',
                 0, 'LIST_EQUIV', 0, 'test-v1')`,
      ).run(msgId, ts, inputTokens, cacheReadTokens);
    }
  }

  it("emits savings within ±5% of oracle", () => {
    seedD10Base();
    insGlobalTurns(10); // exactly 10 in-window turns → global_turns_per_week = 10

    const outcome = d10Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    assertWithinOracle(outcome.fired[0]?.modeled_savings_u_per_wk ?? null, "D10");
  });

  it("emits null when no cache-read price (turns have no cache_read_tokens)", () => {
    seedD10Base();
    // cache_read_tokens=0 → global read price = 0; input tokens keep a mean context so
    // the context-share gate still fires.
    insGlobalTurns(10, 0, 10_000);

    const outcome = d10Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBeNull();
  });

  it("emits no savings when D10 does not fire (removable tokens below both gates)", () => {
    insWorkspace(GLOBAL_WORKSPACE_ID);

    const state = encodeToolSearchState({
      tool_search_mode: "deferred",
      effective_catalog_state: "deferred",
      configured_value: "true",
      always_load_flags: [],
      always_load_count: 0,
      always_load_flags_truncated: false,
      catalog_item_count: 1,
      catalog_item_count_truncated: false,
      catalog_hash: "b".repeat(40),
    });
    db.prepare(
      `INSERT OR REPLACE INTO context_inventory
         (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
       VALUES ('probe-d10s2-nf-settings', ?, '2027-01-07T00:00:00.000Z', 'SETTINGS_SYSTEM',
               '/settings.json', 'settings-hash', 0, ?)`,
    ).run(GLOBAL_WORKSPACE_ID, state);
    // 100 unused tokens vs a 10000-token mean context (1% < 5%); turns carry no spend,
    // so the %-of-spend gate cannot pass either → INACTIVE.
    insCatalogSkill("small", 100);
    insGlobalTurns(10);

    const outcome = d10Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired.length).toBe(0);
  });

  it("prices skill descriptions under deferred Tool-Search — they are always resident (U7)", () => {
    // U7 reversal of the 2026-09-22 MED ruling for skills: Tool Search defers MCP tool
    // schemas only; skill names and descriptions load every turn. The same oracle holds.
    // (MCP schemas are never sized, so they never add savings in any state.)
    seedD10Base("deferred");
    insGlobalTurns(10);

    const outcome = d10Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    assertWithinOracle(outcome.fired[0]?.modeled_savings_u_per_wk ?? null, "D10");
  });
});
