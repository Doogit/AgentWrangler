/**
 * test/detector/d10-catalog-footprint.test.ts - D10 CATALOG_FOOTPRINT.
 *
 * D10 is config-aware but intentionally estimate-only: the probe does not
 * observe which deferred definitions entered a particular turn.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_WORKSPACE_ID,
  type ToolSearchState,
  encodeToolSearchState,
} from "../../src/detector/context-probe.js";
import { D10_CATALOG_FOOTPRINT_TARGET_TOKENS } from "../../src/detector/detectors/d10_catalog_footprint.js";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-08T00:00:00.000Z");

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, ?)`,
  ).run(GLOBAL_WORKSPACE_ID, "__global__", "2026-01-01T00:00:00.000Z");
});

afterEach(() => db.close());

function insInventory(component: string, fileRef: string, tokens: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `probe-d10-${component}-${tokens}`,
    GLOBAL_WORKSPACE_ID,
    "2026-01-07T00:00:00.000Z",
    component,
    fileRef,
    "abc123",
    tokens,
    component === "SETTINGS_SYSTEM" ? "settings-state-hash" : "chars4-v1",
  );
}

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
    "probe-d10-settings",
    GLOBAL_WORKSPACE_ID,
    "2026-01-07T00:00:00.000Z",
    "SETTINGS_SYSTEM",
    "/home/.claude/settings.json",
    "settings-state-hash",
    0,
    encodeToolSearchState(state),
  );
}

function d10Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id='D10' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

function d10Evidence(): Record<string, unknown> {
  const rec = d10Recs()[0];
  if (rec === undefined) throw new Error("expected D10 recommendation");
  return JSON.parse(rec.evidence_json as string) as Record<string, unknown>;
}

describe("D10 - CATALOG_FOOTPRINT", () => {
  it("stays NOT_EVALUATED when only catalog inventory is available", () => {
    insInventory(
      "MCP_SCHEMAS",
      "/home/.claude/plugins/skill-catalog",
      D10_CATALOG_FOOTPRINT_TARGET_TOKENS + 15_000,
    );

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D10")?.status).toBe("NOT_EVALUATED");
    expect(statuses.find((s) => s.detector_id === "D10")?.note).toContain(
      "config state is not measured",
    );
    expect(d10Recs()).toHaveLength(0);
  });

  it("emits a deferred-state estimate with no economic savings claim", () => {
    insInventory(
      "MCP_SCHEMAS",
      "/home/.claude/plugins/skill-catalog",
      D10_CATALOG_FOOTPRINT_TARGET_TOKENS + 15_000,
    );
    insState();

    const statuses = runDetectors(db, { now: NOW });
    const d10 = statuses.find((s) => s.detector_id === "D10");
    expect(d10?.status).toBe("ACTIVE");
    expect(d10?.note).toContain("defers MCP tool definitions");
    expect(d10?.note).not.toContain("alwaysLoad keeps");

    const rec = d10Recs()[0];
    expect(rec?.modeled_savings_u_per_wk).toBeNull();
    const evidence = d10Evidence();
    expect(evidence.tool_search_mode).toBe("deferred");
    expect(evidence.effective_catalog_state).toBe("deferred");
    expect(evidence.estimate).toBe(true);
    expect(evidence.priority).toBe("down-ranked");
    expect(evidence.loaded_tool_telemetry).toBe("unavailable");
  });

  it("emits a distinct alwaysLoad note and evidence for the same catalog", () => {
    insInventory(
      "MCP_SCHEMAS",
      "/home/.claude/plugins/skill-catalog",
      D10_CATALOG_FOOTPRINT_TARGET_TOKENS + 15_000,
    );
    insState({
      effective_catalog_state: "alwaysLoad",
      always_load_flags: [{ server_id_hash: "a".repeat(16), always_load: true }],
      always_load_count: 1,
    });

    const statuses = runDetectors(db, { now: NOW });
    const d10 = statuses.find((s) => s.detector_id === "D10");
    expect(d10?.status).toBe("ACTIVE");
    expect(d10?.note).toContain("alwaysLoad keeps 1 MCP server(s) upfront");
    expect(d10?.note).not.toContain("defers MCP tool definitions");

    const evidence = d10Evidence();
    expect(evidence.effective_catalog_state).toBe("alwaysLoad");
    expect(evidence.always_load_count).toBe(1);
    expect(evidence.catalog_item_count).toBe(2);
    expect(evidence.catalog_hash).toBe("c".repeat(40));
  });

  it.each([
    ["threshold", "threshold", "threshold loading"],
    ["disabled", "upfront", "load upfront"],
  ] as const)("records %s config as an estimate", (mode, effective, note) => {
    insInventory(
      "MCP_SCHEMAS",
      "/home/.claude/plugins/skill-catalog",
      D10_CATALOG_FOOTPRINT_TARGET_TOKENS + 1,
    );
    insState({
      tool_search_mode: mode,
      effective_catalog_state: effective,
      configured_value: mode === "threshold" ? "auto:5" : "false",
    });

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D10")?.note).toContain(note);
    expect(d10Recs()[0]?.modeled_savings_u_per_wk).toBeNull();
  });

  it("does not fire when the catalog is at the threshold boundary", () => {
    insInventory(
      "MCP_SCHEMAS",
      "/home/.claude/plugins/skill-catalog",
      D10_CATALOG_FOOTPRINT_TARGET_TOKENS,
    );
    insState();

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D10")?.status).toBe("INACTIVE");
    expect(statuses.find((s) => s.detector_id === "D10")?.note).toContain("is within");
    expect(d10Recs()).toHaveLength(0);
  });

  it("two passes over the same frozen DB remain deterministic", () => {
    insInventory(
      "MCP_SCHEMAS",
      "/home/.claude/plugins/skill-catalog",
      D10_CATALOG_FOOTPRINT_TARGET_TOKENS + 15_000,
    );
    insState();

    runDetectors(db, { now: NOW });
    const first = d10Recs();
    runDetectors(db, { now: NOW });
    expect(d10Recs()).toEqual(first);
  });
});
