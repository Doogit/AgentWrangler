/**
 * test/detector/d10-claim-producer.test.ts — d10ClaimProducer ledger claims (P3.L L2, U7).
 *
 * The producer claims exactly when the detector fires (per-item disable-list over the
 * % gate), on cacheRead at the assumed fraction, capped at the removable tokens per turn.
 * U7 change: skill descriptions are always resident, so deferred Tool Search no longer
 * suppresses claims (it did before because the catalog was treated as MCP schemas).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger, conservationReport } from "../../src/detector/claim-ledger.js";
import {
  GLOBAL_WORKSPACE_ID,
  type ToolSearchState,
  encodeToolSearchState,
} from "../../src/detector/context-probe.js";
import {
  D10_MIN_CONTEXT_SHARE,
  d10ClaimProducer,
} from "../../src/detector/detectors/d10_catalog_footprint.js";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import { recId } from "../../src/detector/rec-id.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-08T00:00:00.000Z");

let db: Database.Database;
let bigTokens: number;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, ?)`,
  ).run(GLOBAL_WORKSPACE_ID, "__global__", "2026-01-01T00:00:00.000Z");
  const mean = (
    db
      .prepare(
        "SELECT AVG(context_tokens) AS m FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0",
      )
      .get("2026-01-01T00:00:00.000Z", NOW.toISOString()) as { m: number }
  ).m;
  bigTokens = Math.max(3_000, Math.ceil(mean * D10_MIN_CONTEXT_SHARE) + 1);
});

afterEach(() => db.close());

function insState(overrides: Partial<ToolSearchState> = {}): void {
  const state: ToolSearchState = {
    tool_search_mode: "deferred",
    effective_catalog_state: "deferred",
    configured_value: "true",
    always_load_flags: [],
    always_load_count: 0,
    always_load_flags_truncated: false,
    catalog_item_count: 2,
    catalog_item_count_truncated: false,
    catalog_hash: "c".repeat(40),
    ...overrides,
  };
  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "probe-d10c-settings",
    GLOBAL_WORKSPACE_ID,
    "2026-01-07T00:00:00.000Z",
    "SETTINGS_SYSTEM",
    "/home/.claude/settings.json",
    "settings-state-hash",
    0,
    encodeToolSearchState(state),
  );
}

function insSkill(name: string, tokens: number): void {
  db.prepare(
    `INSERT INTO catalog_items
       (item_id, kind, name, plugin, usage_key, tokens, bytes, size_basis, source, probed_at)
     VALUES (?, 'skill', ?, NULL, ?, ?, ?, 'chars4-v1', 'synthetic', '2026-01-07T00:00:00.000Z')`,
  ).run(`skill|${name}`, name, name, tokens, tokens * 4);
}

describe("d10ClaimProducer", () => {
  it("yields nothing when unused items are below the gate", () => {
    insSkill("tiny", 1);
    insState();

    const ledger = buildClaimLedger(db, buildContext(NOW), [d10ClaimProducer]);
    expect(ledger.claims).toHaveLength(0);
  });

  it("claims under deferred Tool Search, capped at the removable tokens", () => {
    insSkill("unused", bigTokens);
    insState({ effective_catalog_state: "deferred" });

    const ledger = buildClaimLedger(db, buildContext(NOW), [d10ClaimProducer]);
    expect(ledger.claims.length).toBeGreaterThan(0);
    const expectedRecId = recId("D10", null, "D10|global|MCP_SCHEMAS");
    for (const claim of ledger.claims) {
      expect(claim.detectorId).toBe("D10");
      expect(claim.component).toBe("cacheRead");
      expect(claim.slice).toBe("prefix:mcp_schemas");
      expect(claim.fraction).toBe(0.5);
      expect(claim.assumed).toBe(true);
      expect(claim.recId).toBe(expectedRecId);
      expect(claim.raw_tokens).toBeLessThanOrEqual(bigTokens);
    }
    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("attributes the same deterministic recId the D10 detector itself creates", () => {
    insSkill("unused", bigTokens);
    insState({ effective_catalog_state: "upfront" });

    runDetectors(db, { now: NOW });
    const rec = db.prepare("SELECT rec_id FROM recommendations WHERE detector_id = 'D10'").get() as
      | { rec_id: string }
      | undefined;
    expect(rec).toBeDefined();

    const ledger = buildClaimLedger(db, buildContext(NOW), [d10ClaimProducer]);
    expect(ledger.claims.length).toBeGreaterThan(0);
    for (const claim of ledger.claims) expect(claim.recId).toBe(rec?.rec_id);
  });
});
