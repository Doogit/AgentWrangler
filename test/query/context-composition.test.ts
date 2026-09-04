import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContextComposition } from "../../src/query/api/context-composition.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;
const NOW = new Date("2026-08-27T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('__global__', '__global__', ?)",
  ).run(NOW.toISOString());
});

afterEach(() => {
  resetQueryDb();
  db.close();
  vi.useRealTimers();
});

function inventory(workspaceId: string, component: string, tokens: number): void {
  db.prepare(
    `INSERT INTO context_inventory (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, 'hash', ?, 'test')`,
  ).run(
    `${workspaceId}-${component}-${tokens}`,
    workspaceId,
    NOW.toISOString(),
    component,
    `/${component}`,
    tokens,
  );
}

function turn(id: string, ts: Date, input: number, provisional: number, toolBytes = 0): void {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
      cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, tool_result_bytes, pricing_snapshot_id,
      cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, 'sess-a1', 'ws-alpha', ?, 'test', 0, ?, 0, 0, 0, 0, 0, ?, NULL, NULL, 'LIST_EQUIV', ?, 'test')`,
  ).run(id, ts.toISOString(), input, toolBytes, provisional);
}

describe("getContextComposition", () => {
  it("aggregates selected and global current CLAUDE_MD/MEMORY only", () => {
    inventory("ws-alpha", "CLAUDE_MD", 1_000);
    inventory("__global__", "MEMORY", 2_000);
    inventory("ws-alpha", "MCP_SCHEMAS", 90_000);
    inventory("ws-beta", "CLAUDE_MD", 80_000);
    turn("ctx-before", new Date(NOW.getTime() - 1_000), 5_000, 1, 999_999);

    const data = getContextComposition("ws-alpha").data;
    if (data === null) throw new Error("expected composition");
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toMatchObject({ key: "always_loaded", tokens: 3_000 });
    expect(data.rows[1]).toMatchObject({ key: "session_residual", tokens: 2_000 });
    const [alwaysLoaded, sessionResidual] = data.rows;
    expect(alwaysLoaded.share).not.toBeNull();
    expect(sessionResidual.share).not.toBeNull();
    expect((alwaysLoaded.share ?? 0) + (sessionResidual.share ?? 0)).toBeCloseTo(1);
  });

  it("uses the provisional-inclusive trailing seven-day [from, to) turn window", () => {
    turn("ctx-old", new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000 - 1), 9_000, 0);
    turn("ctx-from", new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000), 3_000, 0);
    turn("ctx-provisional", new Date(NOW.getTime() - 1), 6_000, 1);
    turn("ctx-at-now", NOW, 12_000, 0);

    const data = getContextComposition("ws-alpha").data;
    if (data === null) throw new Error("expected composition");
    expect(data.observed_turns).toBe(2);
    expect(data.observed_context_tokens).toBe(4_500);
    expect(data.rows[1].tokens).toBe(4_500);
  });

  it("clamps the residual at zero when current inventory exceeds observation", () => {
    inventory("ws-alpha", "MEMORY", 10_000);
    turn("ctx-small", new Date(NOW.getTime() - 1), 1_000, 0);
    const data = getContextComposition("ws-alpha").data;
    if (data === null) throw new Error("expected composition");
    expect(data.rows[1].tokens).toBe(0);
    expect(data.rows[0].share).toBe(1);
  });
});
