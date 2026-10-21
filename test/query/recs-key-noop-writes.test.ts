import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerFingerprint } from "../../src/query/api/ledger-aggregate.js";
import { recommendationsStateKey } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;
const WINDOW = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" };

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function upsertInventory(probedAt: string, tokens: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES ('probe-rb1e', 'ws-alpha', ?, 'CLAUDE_MD', 'CLAUDE.md', 'h1', ?, 'v1')`,
  ).run(probedAt, tokens);
}

function upsertCatalog(probedAt: string, tokens: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO catalog_items
       (item_id, kind, name, plugin, usage_key, tokens, bytes, size_basis, source, probed_at)
     VALUES ('skill:rb1e', 'skill', 'rb1e', NULL, NULL, ?, 10, 'chars4-v1', 'x', ?)`,
  ).run(tokens, probedAt);
}

function setConfig(key: string, value: string, at: string): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, at);
}

describe("recommendationsStateKey ignores no-op rewrites", () => {
  it("context_inventory probed_at rewrite keeps the key; a token change moves it", () => {
    upsertInventory("2026-01-03T10:00:00Z", 100);
    const k0 = recommendationsStateKey();
    upsertInventory("2026-01-03T10:10:00Z", 100);
    expect(recommendationsStateKey()).toBe(k0);
    upsertInventory("2026-01-03T10:20:00Z", 101);
    expect(recommendationsStateKey()).not.toBe(k0);
  });

  it("per_model_snapshot rewrite keeps the key; another user_config key moves it", () => {
    setConfig("per_model_snapshot", '{"captured_at":"a"}', "2026-01-03T10:00:00Z");
    const k0 = recommendationsStateKey();
    setConfig("per_model_snapshot", '{"captured_at":"b"}', "2026-01-03T10:01:00Z");
    expect(recommendationsStateKey()).toBe(k0);
    setConfig("cap_read_coeff", "0.2", "2026-01-03T10:02:00Z");
    expect(recommendationsStateKey()).not.toBe(k0);
  });

  it("detector_status_live evaluated_at rewrite keeps the key; a status change moves it", () => {
    const put = (status: string, at: string): void => {
      db.prepare(
        `INSERT OR REPLACE INTO detector_status_live
           (detector_id, ordinal, name, status, note, evaluated_at) VALUES ('D1', 1, 'n', ?, NULL, ?)`,
      ).run(status, at);
    };
    put("OK", "2026-01-03T10:00:00Z");
    const k0 = recommendationsStateKey();
    put("OK", "2026-01-03T10:05:00Z");
    expect(recommendationsStateKey()).toBe(k0);
    put("FAILED", "2026-01-03T10:06:00Z");
    expect(recommendationsStateKey()).not.toBe(k0);
  });
});

describe("ledgerFingerprint ignores probe rewrites", () => {
  it("catalog_items probed_at rewrite keeps the fingerprint; a token change moves it", () => {
    upsertCatalog("2026-01-03T10:00:00Z", 50);
    const f0 = ledgerFingerprint(db, WINDOW);
    upsertCatalog("2026-01-03T10:10:00Z", 50);
    expect(ledgerFingerprint(db, WINDOW)).toBe(f0);
    upsertCatalog("2026-01-03T10:20:00Z", 51);
    expect(ledgerFingerprint(db, WINDOW)).not.toBe(f0);
  });
});

describe("ledgerFingerprint sees in-place enrichment of in-window rows", () => {
  const ALL = { from: "0000-01-01T00:00:00.000Z", to: "9999-01-01T00:00:00.000Z" };

  // tool_events / ingest_metric_events enrichment is deliberately not tracked (perf budget).
  it("turns.agent_id filled in place moves the fingerprint", () => {
    db.prepare("UPDATE turns SET agent_id = NULL").run();
    const f0 = ledgerFingerprint(db, ALL);
    db.prepare(
      "UPDATE turns SET agent_id = 'a-rb1' WHERE rowid = (SELECT MIN(rowid) FROM turns)",
    ).run();
    expect(ledgerFingerprint(db, ALL)).not.toBe(f0);
  });
});
