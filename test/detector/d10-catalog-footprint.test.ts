/**
 * test/detector/d10-catalog-footprint.test.ts - D10 CATALOG_FOOTPRINT (U7).
 *
 * D10 reads per-item catalog rows and lists plugins/skills with no recorded use in the
 * window, largest first. Audit evidence (U7): the old fixed 40k target was unreachable for
 * a ~4.9k catalog, and savings were nulled under deferred Tool Search even though skill
 * descriptions are always resident. Fixtures are synthetic (SEC-101).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_WORKSPACE_ID,
  type ToolSearchState,
  encodeToolSearchState,
} from "../../src/detector/context-probe.js";
import { D10_MIN_CONTEXT_SHARE } from "../../src/detector/detectors/d10_catalog_footprint.js";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2026-01-08T00:00:00.000Z");
const FROM = "2026-01-01T00:00:00.000Z";

let db: Database.Database;
let meanContext: number;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, ?)`,
  ).run(GLOBAL_WORKSPACE_ID, "__global__", "2026-01-01T00:00:00.000Z");
  meanContext = (
    db
      .prepare(
        "SELECT AVG(context_tokens) AS m FROM turns WHERE ts >= ? AND ts < ? AND provisional = 0",
      )
      .get(FROM, NOW.toISOString()) as { m: number }
  ).m;
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
    catalog_item_count: 5,
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

function insItem(
  kind: "skill" | "plugin" | "mcp_server",
  name: string,
  tokens: number | null,
  plugin: string | null = null,
  usageKey: string | null = kind === "plugin" ? null : name,
): void {
  db.prepare(
    `INSERT INTO catalog_items
       (item_id, kind, name, plugin, usage_key, tokens, bytes, size_basis, source, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synthetic', '2026-01-07T00:00:00.000Z')`,
  ).run(
    `${kind}|${name}`,
    kind,
    name,
    plugin,
    usageKey,
    tokens,
    tokens === null ? null : tokens * 4,
    tokens === null ? "unmeasured" : "chars4-v1",
  );
}

let eventSeq = 0;
function useTool(toolName: string, ts: string, skillName: string | null = null): void {
  const eventId = `d10-ev-${eventSeq++}`;
  db.prepare(
    "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES (?, 'sess-a1', ?, ?)",
  ).run(eventId, ts, toolName);
  if (skillName !== null) {
    db.prepare("INSERT INTO tool_event_skills (event_id, skill_name) VALUES (?, ?)").run(
      eventId,
      skillName,
    );
  }
}

/** The audit-shaped catalog: ~4.9k tokens, well under the old 40k target. */
function seedRealShapedCatalog(bigPluginTokens: number): void {
  insItem("plugin", "big@market", bigPluginTokens, "big@market");
  insItem("skill", "big:draw", bigPluginTokens - 10, "big@market");
  insItem("plugin", "busy@market", 800, "busy@market");
  insItem("skill", "busy:go", 790, "busy@market");
  insItem("skill", "solo", 120);
  insItem("skill", "daily", 200);
  insItem("mcp_server", "srv", null, null, "mcp__srv__");
  useTool("Skill", "2026-01-05T00:00:00.000Z", "busy:go");
  useTool("Skill", "2026-01-06T00:00:00.000Z", "daily");
  useTool("Skill", "2025-12-20T00:00:00.000Z", "solo"); // before the window
}

function d10Status() {
  return runDetectors(db, { now: NOW }).find((s) => s.detector_id === "D10");
}

function d10Rec(): Record<string, unknown> {
  const rec = db.prepare("SELECT * FROM recommendations WHERE detector_id='D10'").get() as
    | Record<string, unknown>
    | undefined;
  if (rec === undefined) throw new Error("expected D10 recommendation");
  return rec;
}

function d10Facts(): Record<string, unknown> {
  return JSON.parse(d10Rec().evidence_json as string).facts as Record<string, unknown>;
}

describe("D10 - CATALOG_FOOTPRINT", () => {
  it("stays NOT_EVALUATED until the probe has written per-item rows", () => {
    insState();
    expect(d10Status()?.status).toBe("NOT_EVALUATED");
    expect(d10Status()?.note).toContain("no per-item catalog rows");
  });

  it("fires on a ~4.9k catalog (old 40k target unreachable) and prices skills under deferred Tool Search", () => {
    const big = Math.max(3_000, Math.ceil(meanContext * D10_MIN_CONTEXT_SHARE) + 1);
    seedRealShapedCatalog(big);
    insState(); // deferred

    const status = d10Status();
    expect(status?.status).toBe("ACTIVE");
    expect(status?.note).toContain("defers MCP tool definitions");

    const facts = d10Facts();
    // Unused in the window, largest first; used items (busy plugin, daily) are excluded,
    // and an MCP server is not listed while Tool Search defers its schemas.
    expect(facts.disable_list).toEqual([
      `plugin big@market (~${big} tokens; no recorded use)`,
      "skill solo (~120 tokens; last used 2025-12-20)",
    ]);
    expect(facts.removable_tokens).toBe(big + 120);
    expect(facts.catalog_tokens).toBe(big + 800 + 120 + 200);
    expect(facts.unmeasured_mcp_server_count).toBe(1);
    expect(facts.skill_use_untracked_count).toBe(0);
    // Skill descriptions are always resident: savings are priced even under deferred.
    expect(d10Rec().modeled_savings_u_per_wk).toBeGreaterThan(0);
  });

  it("does not say 'no recorded use' while Skill calls with no skill name are in the window", () => {
    const big = Math.max(3_000, Math.ceil(meanContext * D10_MIN_CONTEXT_SHARE) + 1);
    seedRealShapedCatalog(big);
    useTool("Skill", "2026-01-05T12:00:00.000Z"); // ingested before skill names were tracked
    insState();

    d10Status();
    const facts = d10Facts();
    expect(facts.skill_use_untracked_count).toBe(1);
    expect(facts.disable_list).toEqual([
      `plugin big@market (~${big} tokens; not seen in tracked skill calls)`,
      "skill solo (~120 tokens; last used 2025-12-20)",
    ]);
  });

  it("lists an unused MCP server only when its schemas load upfront, without a size", () => {
    const big = Math.max(3_000, Math.ceil(meanContext * D10_MIN_CONTEXT_SHARE) + 1);
    seedRealShapedCatalog(big);
    insState({ tool_search_mode: "disabled", effective_catalog_state: "upfront" });

    expect(d10Status()?.status).toBe("ACTIVE");
    const facts = d10Facts();
    expect(facts.disable_list).toContain("mcp_server srv (size not measured; no recorded use)");
    expect(facts.removable_tokens).toBe(big + 120);
  });

  it("an MCP server used in the window is not listed", () => {
    const big = Math.max(3_000, Math.ceil(meanContext * D10_MIN_CONTEXT_SHARE) + 1);
    seedRealShapedCatalog(big);
    useTool("mcp__srv__query", "2026-01-04T00:00:00.000Z");
    insState({ tool_search_mode: "disabled", effective_catalog_state: "upfront" });

    d10Status();
    expect((d10Facts().disable_list as string[]).some((l) => l.includes("srv"))).toBe(false);
  });

  it("stays INACTIVE when unused items are below both gates", () => {
    insItem("skill", "tiny", 1);
    insState();

    const status = d10Status();
    expect(status?.status).toBe("INACTIVE");
    expect(status?.note).toContain("below gate");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id='D10'").get(),
    ).toEqual({ n: 0 });
  });

  it("counts Skill calls ingested before skill names were tracked", () => {
    const big = Math.max(3_000, Math.ceil(meanContext * D10_MIN_CONTEXT_SHARE) + 1);
    seedRealShapedCatalog(big);
    useTool("Skill", "2026-01-03T00:00:00.000Z", null);
    insState();

    d10Status();
    expect(d10Facts().skill_use_untracked_count).toBe(1);
  });

  it("two passes over the same frozen DB remain deterministic", () => {
    seedRealShapedCatalog(Math.max(3_000, Math.ceil(meanContext * D10_MIN_CONTEXT_SHARE) + 1));
    insState();

    runDetectors(db, { now: NOW });
    const first = db.prepare("SELECT * FROM recommendations WHERE detector_id='D10'").all();
    runDetectors(db, { now: NOW });
    expect(db.prepare("SELECT * FROM recommendations WHERE detector_id='D10'").all()).toEqual(
      first,
    );
  });
});
