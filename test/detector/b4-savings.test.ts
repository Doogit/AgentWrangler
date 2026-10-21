/**
 * test/detector/b4-savings.test.ts — B4 bytes→token savings for A1, A2, D12.
 *
 * Seeds the spec's fixed inputs, runs detectors, and asserts modeled_savings_u_per_wk
 * is within ±5% of each oracle entry in scripts/parity/golden-economic.json.
 *
 * Oracle is the independent source of truth — never hardcode the expected values here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSet } from "../../src/detector/calibration.js";
import { a1Detector } from "../../src/detector/detectors/a1_tool_result_bloat.js";
import { a2Detector } from "../../src/detector/detectors/a2_task_output_bloat.js";
import { d12Detector } from "../../src/detector/detectors/d12_subagent_overspawn.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ── Oracle ────────────────────────────────────────────────────────────────────

interface OracleEntry {
  detector_id: string | number;
  savings_u_per_wk: number;
  usd_per_wk: number;
  avoidable_bytes?: number;
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
const TS = "2027-01-02T00:00:00.000Z";

// Spec: bytes_per_token = 8 (calibrated), blended write price = 3.75 USD/MTok
// (sonnet-4 LIST_PRICES[3] = 3.75; all tokens in 5m bucket)
const BPT = 8;

// Pricing snapshot for sonnet-4: [input, output, cacheRead, cw5m, cw1h]
const SONNET4_PRICES = "[3,15,0.3,3.75,6]";

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seq = 0;
  // Insert a pricing snapshot for sonnet-4 tier (if not already present).
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-b4-sonnet', 'sonnet-4', ?, '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run(SONNET4_PRICES);
});

afterEach(() => db.close());

/** Set calibrated bytes_per_token in user_config. */
function setCalibrated(ratio = BPT): void {
  configSet(db, "bytes_per_token", String(ratio));
  configSet(db, "bytes_per_token_measured_at", "2027-01-01T00:00:00.000Z");
  configSet(
    db,
    "bytes_per_token_provenance",
    `calibrated 2027-01-01 via count_tokens · model claude-sonnet-4-6 · N=150 · median ${ratio.toFixed(4)}`,
  );
}

/** Insert a workspace + session. */
function insWorkspaceSession(workspaceId: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(workspaceId, workspaceId);
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fixture/${sessionId}.jsonl`, TS, TS);
}

/**
 * Insert a non-sidechain turn with pricing tokens.
 * cache_write_5m drives the blended write price = 3.75 USD/MTok.
 */
function insTurn(
  workspaceId: string,
  sessionId: string,
  opts: {
    inputTokens?: number;
    cacheWrite5m?: number;
    toolResultBytes?: number;
    isSidechain?: boolean;
    agentId?: string;
    outputTokens?: number;
    costU?: number;
    /** Turn ts; default TS. Use a later ts to order turns within a session so D6's
     *  carry-exposure (carry_turns = laterTurns - firstOwnerIndex - 1) is positive. */
    ts?: string;
  } = {},
): string {
  const messageId = `msg-b4-${seq++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', ?, ?,
             ?, ?, 0, ?, 0, 0, ?,
             'snap-b4-sonnet', ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    workspaceId,
    opts.ts ?? TS,
    opts.isSidechain ? 1 : 0,
    opts.agentId ?? null,
    opts.inputTokens ?? 0,
    opts.outputTokens ?? 0,
    opts.cacheWrite5m ?? 0,
    opts.toolResultBytes ?? 0,
    opts.costU ?? 0,
  );
  return messageId;
}

/** Insert a tool_event with optional metadata linking it to an owner turn. */
function insToolEvent(
  sessionId: string,
  toolName: string,
  resultBytes: number,
  ownerMessageId: string | null = null,
): string {
  const eventId = `evt-b4-${seq++}`;
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventId, sessionId, TS, toolName, resultBytes);
  if (ownerMessageId !== null) {
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, ?, ?, 0)`,
    ).run(eventId, ownerMessageId, seq);
  }
  return eventId;
}

// ── A1 savings — spec §4 fixed inputs ────────────────────────────────────────
// ws-b4-a1: 4 Bash events × 102400 bytes; sessions NOT D6-claimed
// avoidable_bytes = 4 × (102400 − 25600) = 307200
// savings = 307200/8 × 0.5 × 3.75 = 72000 µUSD

describe("A1 — B4 modeled savings", () => {
  it("emits savings within ±5% of oracle when calibrated", () => {
    setCalibrated();
    const WORKSPACE = "ws-b4-a1";
    const RESULT_BYTES = 102400; // 100 KiB per event

    // 4 sessions; each has a non-D6-qualifying turn (inputTokens=200000, toolResultBytes=0)
    // and a Bash tool_event with 100 KiB result.
    for (let i = 0; i < 4; i++) {
      const session = `b4-a1-sess-${i}`;
      insWorkspaceSession(WORKSPACE, session);
      // Turn: large cap so D6 share = 0 (toolResultBytes=0) → D6 does not claim
      insTurn(WORKSPACE, session, { inputTokens: 200_000, cacheWrite5m: 1_000 });
      insToolEvent(session, "Bash", RESULT_BYTES);
    }

    const outcome = a1Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "A1");
  });

  it("emits null when bytes_per_token is uncalibrated", () => {
    // No configSet → uncalibrated
    const WORKSPACE = "ws-b4-a1-nocal";
    for (let i = 0; i < 2; i++) {
      const session = `b4-a1-nocal-${i}`;
      insWorkspaceSession(WORKSPACE, session);
      insTurn(WORKSPACE, session, { inputTokens: 100_000, cacheWrite5m: 1_000 });
      insToolEvent(session, "Bash", 102400);
    }
    const outcome = a1Detector.evaluate(db, CTX);
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    if (fired !== undefined) {
      expect(fired.modeled_savings_u_per_wk).toBeNull();
    }
    // If outcome is INACTIVE there are no fired entries — either way, no savings.
  });
});

// ── A2 savings — spec §4 fixed inputs ────────────────────────────────────────
// ws-b4-a2: 8 TaskOutput events × 25600 bytes (U7: results over 25,600 B are A1's, so the
// oracle's 122,880 avoidable bytes are spread over 8 A2-sized results instead of 3 × 50 KiB)
// avoidable_bytes = 8 × (25600 − 10240) = 122880
// savings = 122880/8 × 0.5 × 3.75 = 28800 µUSD

describe("A2 — B4 modeled savings", () => {
  it("emits savings within ±5% of oracle when calibrated", () => {
    setCalibrated();
    const WORKSPACE = "ws-b4-a2";
    const RESULT_BYTES = 25600; // A1's floor: the largest result A2 owns

    // 8 sessions; each has a main-chain non-D6-qualifying turn + TaskOutput event.
    for (let i = 0; i < 8; i++) {
      const session = `b4-a2-sess-${i}`;
      insWorkspaceSession(WORKSPACE, session);
      // Non-sidechain turn (A2 requires owned main-chain turns)
      const msgId = insTurn(WORKSPACE, session, {
        inputTokens: 200_000,
        cacheWrite5m: 1_000,
        isSidechain: false,
      });
      // TaskOutput event owned by the turn
      insToolEvent(session, "TaskOutput", RESULT_BYTES, msgId);
      // U7: a later main turn sends the result (its carry), and carries the workspace spend
      // the 0.1% card gate is measured against.
      db.prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain,
            input_tokens, output_tokens, cache_read_tokens,
            cache_write_5m, cache_write_1h, cache_write_other,
            pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
         VALUES (?, ?, ?, '2027-01-02T00:05:00.000Z', 'claude-sonnet-4-6', 0,
                 200000, 0, 0, 0, 0, 0, 'snap-b4-sonnet', 100000, 'LIST_EQUIV', 0, 'test-v1')`,
      ).run(`${msgId}-next`, session, WORKSPACE);
    }

    const outcome = a2Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "A2");
  });

  it("emits null when bytes_per_token is uncalibrated", () => {
    const WORKSPACE = "ws-b4-a2-nocal";
    const session = "b4-a2-nocal-0";
    insWorkspaceSession(WORKSPACE, session);
    const msgId = insTurn(WORKSPACE, session, {
      inputTokens: 100_000,
      cacheWrite5m: 1_000,
    });
    insToolEvent(session, "TaskOutput", 51200, msgId);

    const outcome = a2Detector.evaluate(db, CTX);
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    if (fired !== undefined) {
      expect(fired.modeled_savings_u_per_wk).toBeNull();
    }
  });
});

// ── D12 savings — U7 carry model ─────────────────────────────────────────────
// ws-b4-d12: 3 Agent calls, each returning a subagent final turn of 262144 tokens (2097152 B at
// bytes_per_token 8; 6291456 B in all). The parent has 3 later turns, so each result is one
// cache write (3.75) plus two cache reads (0.3): 3.75 + 0.3 × 2 = 4.35 USD/MTok.
// savings = 786432 × 0.5 × 4.35 = 1710489.6 µUSD (re-derived for U7 in golden-economic.mjs; the
// pre-U7 input was the parent stub bytes at the blended write price, 1474560).

/** One parent Agent call: owner turn, 3 later parent turns, linked subagent with a final turn. */
function seedD12Call(workspaceId: string, session: string, finalOutputTokens: number): void {
  insWorkspaceSession(workspaceId, session);
  const owner = insTurn(workspaceId, session, { costU: 1_000_000 });
  for (let i = 1; i <= 3; i++) {
    insTurn(workspaceId, session, { costU: 1_000_000, ts: `2027-01-02T00:00:0${i}.000Z` });
  }
  const eventId = insToolEvent(session, "Agent", 1_100, owner);
  const agentId = `agent-${session}`;
  db.prepare(
    `INSERT INTO subagent_meta (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
     VALUES (?, ?, 'general-purpose', ?, 1, 10)`,
  ).run(agentId, session, eventId);
  insTurn(workspaceId, session, {
    isSidechain: true,
    agentId,
    outputTokens: finalOutputTokens,
    ts: "2027-01-02T00:00:00.500Z",
  });
}

describe("D12 — B4 modeled savings", () => {
  it("emits savings within ±5% of oracle when calibrated", () => {
    setCalibrated();
    const WORKSPACE = "ws-b4-d12";
    for (let i = 0; i < 3; i++) seedD12Call(WORKSPACE, `b4-d12-sess-${i}`, 262_144);

    const outcome = d12Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    expect(fired).toBeDefined();
    assertWithinOracle(fired?.modeled_savings_u_per_wk ?? null, "D12");
  });

  it("emits null when bytes_per_token is uncalibrated", () => {
    const WORKSPACE = "ws-b4-d12-nocal";
    for (let i = 0; i < 3; i++) seedD12Call(WORKSPACE, `b4-d12-nocal-${i}`, 262_144);
    const outcome = d12Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    // Without calibration, savings must remain null.
    expect(fired).toBeDefined();
    expect(fired?.modeled_savings_u_per_wk).toBeNull();
  });
});

// ── A1 ↔ D6 — disjoint by size since U7 (was a session-level dedup) ───────────
// D6 prices only results ≤ 25,600 B, so A1 keeps every result above that, in any session.

describe("A1↔D6 dedup", () => {
  it("keeps every large result in A1 even where D6-style bloat exists (U7: disjoint sets)", () => {
    setCalibrated();
    const WORKSPACE = "ws-b4-dd";
    const RESULT_BYTES = 102400; // 100 KiB per event (> 25 KiB threshold)

    // 3 sessions that D6 actually PRICES (2026-09-22 narrowing: D6 claims only
    // sessions with a recurring-tool carry winner yielding positive carry exposure).
    // Each has: inputTokens=100000, toolResultBytes=307200 (300 KB > 200 KB floor)
    // → D6 share = (307200/8) / 100000 = 0.384 >= 0.30 ✓, PLUS a recurring Bash tool
    // (2 events) whose result carries past its owner turn (a later turn exists) →
    // carry_exposure_tokens_directional > 0.
    for (let i = 0; i < 3; i++) {
      const session = `b4-dd-sess-${i}`;
      insWorkspaceSession(WORKSPACE, session);
      const owner = insTurn(WORKSPACE, session, {
        inputTokens: 100_000,
        cacheWrite5m: 1_000,
        toolResultBytes: 307_200, // causes D6 to claim this session
      });
      // A later turn so D6's carry_turns (laterTurns − firstOwnerIndex − 1) > 0.
      insTurn(WORKSPACE, session, { ts: "2027-01-02T01:00:00.000Z" });
      // Recurring Bash tool_events (>=2, with owner metadata) → D6 carry winner.
      insToolEvent(session, "Bash", RESULT_BYTES, owner);
      insToolEvent(session, "Bash", RESULT_BYTES, owner);
    }

    // U7: no dedup. D6 owns only results ≤ 25,600 B, so A1 keeps all 6 of these 100 KiB results:
    // 6 × (102400 − 25600) / 8 × 0.5 × 3.75 = 108000 µUSD.
    const outcome = a1Detector.evaluate(db, CTX);
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    expect(fired?.modeled_savings_u_per_wk).toBe(108_000);
  });

  it("A1 savings no longer drop for sessions the old D6 claimed (U7: disjoint sets)", () => {
    setCalibrated();
    const WORKSPACE = "ws-b4-dd2";

    // 3 sessions D6 actually PRICES (large toolResultBytes share + recurring-tool
    // carry winner — see the narrowing note in the sibling test).
    for (let i = 0; i < 3; i++) {
      const session = `b4-dd2-d6-${i}`;
      insWorkspaceSession(WORKSPACE, session);
      const owner = insTurn(WORKSPACE, session, {
        inputTokens: 100_000,
        cacheWrite5m: 500,
        toolResultBytes: 307_200,
      });
      insTurn(WORKSPACE, session, { ts: "2027-01-02T01:00:00.000Z" });
      insToolEvent(session, "Bash", 102400, owner);
      insToolEvent(session, "Bash", 102400, owner);
    }

    // 2 sessions D6 does NOT claim (tiny toolResultBytes → share < 30%)
    for (let i = 0; i < 2; i++) {
      const session = `b4-dd2-nodep-${i}`;
      insWorkspaceSession(WORKSPACE, session);
      insTurn(WORKSPACE, session, {
        inputTokens: 200_000,
        cacheWrite5m: 500,
        toolResultBytes: 0,
      });
      insToolEvent(session, "Bash", 102400);
    }

    // Run WITHOUT dedup baseline: only the 2 non-D6 sessions contribute avoidable bytes
    const outcome = a1Detector.evaluate(db, CTX);
    const fired = outcome.fired.find((f) => f.scope_workspace_id === WORKSPACE);
    expect(fired).toBeDefined();

    // U7: no dedup (D6 owns only results ≤ 25,600 B), so all 8 events count:
    // 8 × (102400 − 25600) / 8 × 0.5 × 3.75 = 144000 µUSD.
    expect(fired?.modeled_savings_u_per_wk).toBe(144_000);
  });
});
