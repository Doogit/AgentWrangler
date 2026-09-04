import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateHookConfig } from "../../src/query/api/hook-config.js";
import { getIdleSessions } from "../../src/query/api/idle-sessions.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
let db: Database.Database;

function insertTurn(sessionId: string, sidechain: number, ts: Date, inputTokens = 100): void {
  db.prepare(
    `INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
       cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, pricing_snapshot_id,
       cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, 'ws-alpha', ?, 'claude-sonnet', ?, ?, 0, 0, 0, 0, 0, NULL, NULL, 'LIST_EQUIV', 0, 'test')`,
  ).run(
    `idle-${sessionId}-${ts.getTime()}-${sidechain}`,
    sessionId,
    ts.toISOString(),
    sidechain,
    inputTokens,
  );
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

describe("getIdleSessions", () => {
  it("returns an idle sidechain-dominant session and excludes a fresh session", () => {
    insertTurn("sess-a1", 1, new Date(NOW.getTime() - 1_800_000), 100);
    insertTurn("sess-a1", 1, new Date(NOW.getTime() - 1_900_000), 100);
    insertTurn("sess-a1", 0, new Date(NOW.getTime() - 2_000_000), 50);
    insertTurn("sess-a2", 1, new Date(NOW.getTime() - 60_000));

    expect(getIdleSessions().data).toEqual([
      expect.objectContaining({
        session_id: "sess-a1",
        workspace_id: "ws-alpha",
        last_activity_ts: new Date(NOW.getTime() - 1_800_000).toISOString(),
        idle_seconds: 1800,
        cap_weighted_tokens: 250,
        sidechain: true,
      }),
    ]);
  });

  it("fails open to an empty list when no sessions have turns", () => {
    expect(getIdleSessions().data).toEqual([]);
  });

  it("applies the persisted idle cutoff", () => {
    insertTurn("sess-a3", 1, new Date(NOW.getTime() - 600_000));
    expect(getIdleSessions().data).toEqual([]);
    updateHookConfig({ d9_idle_seconds: 600 });
    expect(getIdleSessions().data).toEqual([
      expect.objectContaining({ session_id: "sess-a3", idle_seconds: 600 }),
    ]);
  });
});
