/**
 * Actionability quality-flag gate (engine.upsertFired).
 *
 * The gate stamps evidence.actionability_ok — true when a rec names a concrete,
 * structurally-checkable action (a non-empty file_ref, or a step with a typed
 * action kind), false for directional free-text advice. It is a quality signal
 * ONLY: it must never change persisted `state`.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import { runDetectors } from "../../src/detector/index.js";
import { recommendationTemplate } from "../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-08T00:00:00.000Z");

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => db.close());

function recRow(detectorId: string): Record<string, unknown> {
  const r = db
    .prepare("SELECT * FROM recommendations WHERE detector_id = ? ORDER BY rec_id")
    .get(detectorId) as Record<string, unknown> | undefined;
  if (r === undefined) throw new Error(`expected a ${detectorId} rec but found none`);
  return r;
}

function seedD1Oversize(): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, '__global__', '2026-01-01T00:00:00.000Z')`,
  ).run(GLOBAL_WORKSPACE_ID);
  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "probe-actionability-claude-md",
    GLOBAL_WORKSPACE_ID,
    "2026-01-07T00:00:00.000Z",
    "CLAUDE_MD",
    "/home/.claude/CLAUDE.md",
    "abc123",
    5000,
    "chars4-v1",
  );
}

function seedD5Warning(): void {
  db.prepare("UPDATE user_config SET value = '3000000000' WHERE key = 'limit_tokens'").run();
  // U7: the stored-limit forecast reads a 7-day burn, so drop the seeded week of turns.
  db.prepare("DELETE FROM turns").run();
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
       state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('sess-burn', 'ws-alpha', '/fake/burn.jsonl', ?, ?, 'RECONCILED', 1, 0, '[]')`,
  ).run("2026-01-07T12:00:00.000Z", "2026-01-07T12:00:00.000Z");
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
       input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
       cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
       provisional, parser_version)
     VALUES ('msg-burn', 'sess-burn', 'ws-alpha', ?, 'claude-sonnet', 0, 1000000000, 0, 0, 0, 0, 0,
       NULL, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run("2026-01-07T12:00:00.000Z");
}

describe("actionability template metadata", () => {
  it("keeps D1 actionability in the trusted registry", () => {
    seedD1Oversize();
    runDetectors(db, { now: NOW });
    const r = recRow("D1");
    const evidence = JSON.parse(r.evidence_json as string).facts;
    expect(recommendationTemplate("D1_CONTEXT_ALWAYS_LOADED").actionable).toBe(true);
    expect(evidence).not.toHaveProperty("file_ref");
    expect(evidence).not.toHaveProperty("actionability_ok");
  });

  it("keeps D5 actionability in the trusted registry", () => {
    seedD5Warning();
    runDetectors(db, { now: NOW });
    const r = recRow("D5");
    const evidence = JSON.parse(r.evidence_json as string).facts;
    expect(recommendationTemplate("D5_LIMIT_BURN_WARNING").actionable).toBe(true);
    expect(evidence).not.toHaveProperty("file_ref");
    expect(evidence).not.toHaveProperty("actionability_ok");
  });

  it("does not change persisted state and emits only registered facts", () => {
    seedD1Oversize();
    runDetectors(db, { now: NOW });
    const rows = db.prepare("SELECT * FROM recommendations").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const evidence = JSON.parse(r.evidence_json as string).facts;
      expect(evidence).not.toHaveProperty("actionability_ok");
    }
    expect(recRow("D1").state).toBe("PROPOSED");
  });
});
