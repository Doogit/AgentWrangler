import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContextBudget } from "../../src/query/api/context-budget.js";
import { updateHookConfig } from "../../src/query/api/hook-config.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
let db: Database.Database;

function insertTurn(contextTokens: number, ts = NOW, model = "claude-opus-4-8"): void {
  db.prepare(
    `INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
       cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id,
       cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, 'sess-a1', 'ws-alpha', ?, ?, 0, ?, 0, 0, 0, 0, 0, NULL, NULL, 'LIST_EQUIV', 0, 'test')`,
  ).run(`budget-${contextTokens}-${ts.getTime()}`, ts.toISOString(), model, contextTokens);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = createInMemoryFixtureDb();
  db.prepare("DELETE FROM turns").run();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
  vi.useRealTimers();
});

function insertAgentTurn(
  contextTokens: number,
  sidechain: boolean,
  agentId: string | null,
  ts: Date,
): void {
  db.prepare(
    `INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id, input_tokens,
       output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
       pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, 'sess-a1', 'ws-alpha', ?, 'claude-opus-4-8', ?, ?, ?, 0, 0, 0, 0, 0, NULL, NULL,
             'LIST_EQUIV', 0, 'test')`,
  ).run(
    `ag-${agentId ?? "null"}-${contextTokens}-${ts.getTime()}`,
    ts.toISOString(),
    sidechain ? 1 : 0,
    agentId,
    contextTokens,
  );
}

describe("getContextBudget per-agent scoping (U6)", () => {
  const at = (ms: number) => new Date(NOW.getTime() - 100_000 + ms);

  it("keeps a small subagent and a large parent separate, incl. NULL-agent_id sidechain turns", () => {
    insertAgentTurn(250_000, false, null, at(1)); // parent: >200k so window floors to 1M
    insertAgentTurn(120_000, true, null, at(2)); // sidechain, agent_id not yet backfilled
    insertAgentTurn(30_000, true, "a1b2c3", at(3)); // subagent, small
    insertAgentTurn(90_000, true, "zzz999", at(4)); // another subagent, newest, larger

    const sub = getContextBudget("sess-a1", "a1b2c3").data;
    expect(sub).toMatchObject({ context_tokens: 30_000, window: 200_000, stage: "ok" });

    // The subagent's tool-prefix form is normalised to the bare turns.agent_id.
    expect(getContextBudget("sess-a1", "agent-a1b2c3").data?.context_tokens).toBe(30_000);

    // Main: latest MAIN turn is 250k even though sidechain turns are newer; the NULL-agent_id
    // sidechain turn (120k) and subagent maxima never leak in.
    const main = getContextBudget("sess-a1").data;
    expect(main).toMatchObject({ context_tokens: 250_000, window: 1_000_000, stage: "soft" });
  });

  it("main window ignores a subagent's large max", () => {
    insertAgentTurn(30_000, false, null, at(1));
    insertAgentTurn(400_000, true, "big", at(2));
    expect(getContextBudget("sess-a1").data).toMatchObject({
      context_tokens: 30_000,
      window: 200_000,
      stage: "ok",
    });
    expect(getContextBudget("sess-a1", "big").data).toMatchObject({
      context_tokens: 400_000,
      window: 1_000_000,
    });
  });

  it("applies a 100k floor to subagents only", () => {
    insertAgentTurn(60_000, true, "mid", at(1)); // above the 40k soft line, below the floor
    expect(getContextBudget("sess-a1", "mid").data).toMatchObject({
      stage: "ok",
      context_tokens: 60_000,
      window: 200_000,
    });
    insertAgentTurn(110_000, true, "mid", at(2)); // normal threshold logic: 110k >= 60k hard
    expect(getContextBudget("sess-a1", "mid").data).toMatchObject({ stage: "hard" });
    // Main thread unchanged: 60k on main still hits hard.
    insertAgentTurn(60_000, false, null, at(3));
    expect(getContextBudget("sess-a1").data).toMatchObject({ stage: "hard" });
  });

  it("fails open for a subagent with no attributed turns", () => {
    insertAgentTurn(250_000, false, null, at(1));
    insertAgentTurn(250_000, true, null, at(2));
    expect(getContextBudget("sess-a1", "unknown").data).toMatchObject({
      stage: "ok",
      reason: "no_turns",
    });
  });
});

describe("getContextBudget", () => {
  it("fails open for an unknown session", () => {
    expect(getContextBudget("missing").data).toMatchObject({
      stage: "ok",
      reason: "unknown_session",
      session_id: "missing",
      ts: null,
    });
  });

  it("transitions through soft and hard as a percent of the standard window", () => {
    // Defaults: window 200k, soft 20% = 40k, hard 30% = 60k.
    insertTurn(40_000);
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "soft",
      window: 200_000,
      soft_at: 40_000,
      hard_at: 60_000,
      recommended_action: "compact",
      reason: "soft",
    });

    insertTurn(60_000, new Date(NOW.getTime() + 1));
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "hard",
      recommended_action: "clear",
      reason: "hard",
    });
  });

  it("stays ok just below the soft threshold", () => {
    insertTurn(39_999);
    expect(getContextBudget("sess-a1").data).toMatchObject({ stage: "ok", reason: "ok" });
  });

  it("measures a session that has already exceeded 200k against 1M (regression)", () => {
    // A session whose context has passed 200k is provably a >200k-window model, so the
    // window floors up to 1M: 250k is 25% (soft), not hard against the declared 200k.
    insertTurn(250_000);
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "soft",
      window: 1_000_000,
      soft_at: 200_000,
      hard_at: 300_000,
    });
  });

  it("respects a user-declared 1M window below 200k of usage (regression)", () => {
    updateHookConfig({ context_window: 1_000_000 });
    insertTurn(100_000);
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "ok",
      window: 1_000_000,
      soft_at: 200_000,
    });
  });

  it("never treats the window as smaller than the standard floor", () => {
    updateHookConfig({ context_window: 50_000 });
    insertTurn(10_000);
    expect(getContextBudget("sess-a1").data?.window).toBe(200_000);
  });

  it("fails open when the newest turn is stale", () => {
    insertTurn(500_000, new Date(NOW.getTime() - 301_000));
    expect(getContextBudget("sess-a1").data).toMatchObject({ stage: "ok", reason: "stale" });
  });

  it("applies persisted hook-config overrides", () => {
    updateHookConfig({ context_window: 1_000_000, soft_pct: 0.5, hard_pct: 0.75 });
    insertTurn(500_000);
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "soft",
      window: 1_000_000,
      soft_at: 500_000,
      hard_at: 750_000,
    });
  });
});
