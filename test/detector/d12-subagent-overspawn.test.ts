import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSet } from "../../src/detector/calibration.js";
import { d12Detector } from "../../src/detector/detectors/d12_subagent_overspawn.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};
const TS = "2027-01-02T00:00:00.000Z";
/** Parent turns after the Agent call, +1 s each: the first writes the stub, the rest read it. */
const LATER_TS = (n: number): string => `2027-01-02T00:00:0${n}.000Z`;
// sonnet-4 snapshot: [input, output, cacheRead, cw5m, cw1h]
const WRITE_PRICE = 3.75;
const READ_PRICE = 0.3;

let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    `INSERT OR IGNORE INTO pricing_snapshots
       (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES ('snap-d12', 'sonnet-4', '[3,15,0.3,3.75,6]', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z')`,
  ).run();
});

afterEach(() => db.close());

function addSession(workspaceId: string, sessionId: string): void {
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

function addTurn(
  workspaceId: string,
  sessionId: string,
  opts: {
    ts?: string;
    sidechain?: boolean;
    agentId?: string | undefined;
    output?: number;
    costU?: number;
  } = {},
): string {
  addSession(workspaceId, sessionId);
  const id = `msg-d12-${sequence++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
        cache_write_1h, cache_write_other, tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', ?, ?,
             0, ?, 0, 0, 0, 0, 0, 'snap-d12', ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(
    id,
    sessionId,
    workspaceId,
    opts.ts ?? TS,
    opts.sidechain ? 1 : 0,
    opts.agentId ?? null,
    opts.output ?? 0,
    opts.costU ?? 0,
  );
  return id;
}

/** A parent Agent call (1.1 KB stub back to the parent) linked to a subagent via subagent_meta. */
function addAgentCall(
  workspaceId: string,
  sessionId: string,
  opts: {
    finalOutputTokens: number;
    laterParentTurns?: number;
    parentCostU?: number;
    link?: boolean;
    sidechainParent?: boolean;
    stubBytes?: number;
  },
): void {
  const owner = addTurn(workspaceId, sessionId, {
    sidechain: opts.sidechainParent === true,
    agentId: opts.sidechainParent === true ? `agent-parent-${sequence}` : undefined,
    costU: opts.parentCostU ?? 0,
  });
  for (let i = 1; i <= (opts.laterParentTurns ?? 3); i++) {
    addTurn(workspaceId, sessionId, { ts: LATER_TS(i), costU: opts.parentCostU ?? 0 });
  }
  const eventId = `toolu-d12-${sequence++}`;
  const agentId = `agent-d12-${sequence++}`;
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes)
     VALUES (?, ?, ?, 'Agent', ?)`,
  ).run(eventId, sessionId, TS, opts.stubBytes ?? 1_100);
  db.prepare(
    `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, 0, 0)`,
  ).run(eventId, owner);
  if (opts.link !== false) {
    db.prepare(
      `INSERT INTO subagent_meta (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
       VALUES (?, ?, 'general-purpose', ?, 1, 10)`,
    ).run(agentId, sessionId, eventId);
  }
  // An earlier, larger subagent turn must not be picked: only the LAST turn is the return.
  addTurn(workspaceId, sessionId, {
    sidechain: true,
    agentId,
    ts: "2027-01-02T00:00:00.100Z",
    output: 9_000,
  });
  addTurn(workspaceId, sessionId, {
    sidechain: true,
    agentId,
    ts: "2027-01-02T00:00:00.200Z",
    output: opts.finalOutputTokens,
  });
}

function fireFor(workspaceId: string) {
  const outcome = d12Detector.evaluate(db, CTX);
  const fired = outcome.fired.find((f) => f.scopeKey === `D12|${workspaceId}`);
  return { outcome, fired };
}

function threeSessions(workspaceId: string, opts: Parameters<typeof addAgentCall>[2]): string[] {
  const sessions = [1, 2, 3].map((n) => `session-${workspaceId}-${n}`);
  for (const s of sessions) addAgentCall(workspaceId, s, opts);
  return sessions;
}

describe("D12 SUBAGENT_OVERSPAWN", () => {
  // Hand-computed (not read back from the code). Per Agent call: the subagent's last turn is
  // 5,000 output tokens; the parent has 3 later turns, so one stub-turn write plus 2 reads:
  //   carry price = 3.75 + 0.3 x (3 - 1)            = 4.35 $/MTok
  //   one call    = 5,000 tokens x 0.5 x 4.35        = 10,875 u
  //   3 sessions                                      = 32,625 u
  // Uncalibrated bytes/token = 2.7, so bytes per call = 5,000 x 2.7 = 13,500 (> 10 KiB).
  it("prices the subagent's last turn as a carried result and keeps session ids", () => {
    const sessions = threeSessions("ws-d12-fired", {
      finalOutputTokens: 5_000,
      parentCostU: 100_000,
    });
    const { outcome, fired } = fireFor("ws-d12-fired");
    expect(outcome.status).toBe("ACTIVE");
    if (fired === undefined || fired.payload.template_id !== "D12_SUBAGENT_OVERSPAWN") {
      throw new Error("expected D12 to fire");
    }
    expect(fired.payload.facts.sidechain_result_bytes).toBe(3 * 13_500);
    expect(fired.payload.facts.sidechain_turn_count).toBe(3);
    expect(fired.payload.facts.sidechain_session_count).toBe(3);
    expect(fired.payload.facts.session_ids).toEqual(sessions);
    expect(Object.keys(fired.payload.facts).sort()).toEqual([
      "session_ids",
      "sidechain_result_bytes",
      "sidechain_session_count",
      "sidechain_turn_count",
      "workspace_id",
    ]);
    expect(fired.modeled_savings_u_per_wk).toBeNull(); // uncalibrated
    expect(fired.modeled_formula_json?.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 32_625,
      summable: false,
    });
    // Sanity on the hand formula's inputs.
    expect(Math.round(3 * 5_000 * 0.5 * (WRITE_PRICE + READ_PRICE * 2))).toBe(32_625);
  });

  it("models savings, at the same $ per token, once bytes/token is calibrated", () => {
    configSet(db, "bytes_per_token", "8");
    configSet(db, "bytes_per_token_measured_at", "2027-01-01T00:00:00.000Z");
    configSet(db, "bytes_per_token_provenance", "calibrated 2027-01-01 via count_tokens · N=150");
    threeSessions("ws-d12-cal", { finalOutputTokens: 5_000, parentCostU: 100_000 });
    const { fired } = fireFor("ws-d12-cal");
    if (fired === undefined || fired.payload.template_id !== "D12_SUBAGENT_OVERSPAWN") {
      throw new Error("expected D12 to fire");
    }
    // Bytes scale with the ratio (5,000 x 8 x 3), tokens and $ do not.
    expect(fired.payload.facts.sidechain_result_bytes).toBe(3 * 40_000);
    expect(fired.modeled_savings_u_per_wk).toBe(32_625);
  });

  it("sizes the return from the subagent, not from the 1.1 KB parent stub", () => {
    // Stub says 500 KB, the subagent's last turn is 1,000 tokens (2.7 KB): compact, not counted.
    threeSessions("ws-d12-compact", {
      finalOutputTokens: 1_000,
      stubBytes: 500_000,
      parentCostU: 100_000,
    });
    const { outcome } = fireFor("ws-d12-compact");
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toEqual([]);
  });

  it("does not fire when the priced savings are under 0.25% of the workspace's spend", () => {
    // Same 32,625 u, but 12 parent turns x 10,000,000 u = 120,000,000 u spend: 0.027%.
    threeSessions("ws-d12-big-spend", { finalOutputTokens: 5_000, parentCostU: 10_000_000 });
    const { outcome } = fireFor("ws-d12-big-spend");
    expect(outcome.status).toBe("INACTIVE");
  });

  it("needs three sessions", () => {
    for (const s of ["session-two-1", "session-two-2"]) {
      addAgentCall("ws-d12-two", s, { finalOutputTokens: 5_000, parentCostU: 100_000 });
    }
    expect(fireFor("ws-d12-two").outcome.status).toBe("INACTIVE");
  });

  it("prices nothing for an Agent call with no later parent turn", () => {
    threeSessions("ws-d12-nocarry", {
      finalOutputTokens: 5_000,
      laterParentTurns: 0,
      parentCostU: 100_000,
    });
    expect(fireFor("ws-d12-nocarry").outcome.status).toBe("INACTIVE");
  });

  it("ignores Agent calls with no subagent_meta link", () => {
    threeSessions("ws-d12-unlinked", {
      finalOutputTokens: 5_000,
      link: false,
      parentCostU: 100_000,
    });
    expect(fireFor("ws-d12-unlinked").outcome.status).toBe("INACTIVE");
  });

  it("excludes Agent events issued by sidechain turns", () => {
    threeSessions("ws-d12-sidechain-agent", {
      finalOutputTokens: 5_000,
      sidechainParent: true,
      parentCostU: 100_000,
    });
    expect(fireFor("ws-d12-sidechain-agent").outcome.status).toBe("INACTIVE");
  });
});
