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
    // Defaults: window 200k, soft 60% = 120k, hard 80% = 160k.
    insertTurn(120_000);
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "soft",
      window: 200_000,
      soft_at: 120_000,
      hard_at: 160_000,
      recommended_action: "compact",
      reason: "soft",
    });

    insertTurn(160_000, new Date(NOW.getTime() + 1));
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "hard",
      recommended_action: "clear",
      reason: "hard",
    });
  });

  it("stays ok just below the soft threshold", () => {
    insertTurn(119_999);
    expect(getContextBudget("sess-a1").data).toMatchObject({ stage: "ok", reason: "ok" });
  });

  it("does not warn a large-window session that has already exceeded 200k (regression)", () => {
    // A session whose context has passed 200k is provably a >200k-window model, so the
    // window floors up to 1M: 300k is only 30% and must stay ok, not hard at the old 160k.
    insertTurn(300_000);
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "ok",
      window: 1_000_000,
      soft_at: 600_000,
      hard_at: 800_000,
    });
  });

  it("respects a user-declared 1M window below 200k of usage (regression)", () => {
    updateHookConfig({ context_window: 1_000_000 });
    insertTurn(100_000);
    expect(getContextBudget("sess-a1").data).toMatchObject({
      stage: "ok",
      window: 1_000_000,
      soft_at: 600_000,
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
