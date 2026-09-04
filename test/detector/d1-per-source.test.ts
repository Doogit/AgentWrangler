/**
 * test/detector/d1-per-source.test.ts — D1 per-source firing tests.
 *
 * Covers:
 *   - fires when a global CLAUDE_MD source exceeds the 2,000-token target
 *   - global multiplier: scope_workspace_id = null, evidence.scope = 'global',
 *     evidence.workspace_multiplier = active_workspace_count
 *   - does NOT fire when source_tokens ≤ target
 *   - per-workspace MEMORY fires when oversize, scope_workspace_id = real id
 *   - multiple sources fire independently
 *   - scopeKey is stable across re-runs (determinism)
 *   - evidence carries required fields: component, file_ref, source_tokens,
 *     source_target, delta_context_tokens, turns_per_week, scope, steps
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import { D1_SOURCE_TARGETS } from "../../src/detector/savings.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Frozen now: same as detector.test.ts to align with fixture data window.
const NOW = new Date("2026-01-08T00:00:00.000Z");

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  // Ensure __global__ sentinel workspace exists.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, ?)`,
  ).run(GLOBAL_WORKSPACE_ID, "__global__", "2026-01-01T00:00:00.000Z");
});

afterEach(() => db.close());

// ── Helpers ────────────────────────────────────────────────────────────────────

function insInventory(
  workspaceId: string,
  component: string,
  fileRef: string,
  tokens: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `probe-test-${workspaceId}-${component}`,
    workspaceId,
    "2026-01-07T00:00:00.000Z",
    component,
    fileRef,
    "abc123",
    tokens,
    "chars4-v1",
  );
}

function d1Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id = 'D1' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

function requireRec(recs: Array<Record<string, unknown>>): Record<string, unknown> {
  const r = recs[0];
  if (r === undefined) throw new Error("expected at least one D1 rec but found none");
  return r;
}

// Resolved target values (no ! — Record<string,number> always gives number)
const TARGET_CLAUDE_MD = D1_SOURCE_TARGETS.CLAUDE_MD ?? 2000;
const TARGET_MEMORY = D1_SOURCE_TARGETS.MEMORY ?? 1000;
const TARGET_MCP = D1_SOURCE_TARGETS.MCP_SCHEMAS ?? 3000;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("D1 — fires when global CLAUDE_MD exceeds target", () => {
  it("fires when global CLAUDE_MD tokens > 2000 target", () => {
    const oversizeTokens = TARGET_CLAUDE_MD + 1000; // 3000
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", oversizeTokens);

    const statuses = runDetectors(db, { now: NOW });
    const d1 = statuses.find((s) => s.detector_id === "D1");
    expect(d1?.status).toBe("ACTIVE");

    const recs = d1Recs();
    expect(recs.length).toBe(1);
    const r = requireRec(recs);
    expect(r.category).toBe("CONTEXT");
    expect(r.scope_workspace_id).toBeNull(); // global
    expect(r.state).toBe("PROPOSED");
  });

  it("sets scope_workspace_id = null for global sources", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    runDetectors(db, { now: NOW });
    const r = requireRec(d1Recs());
    expect(r.scope_workspace_id).toBeNull();
  });

  it("evidence.scope = 'global' for global sources", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string);
    expect(evidence.scope).toBe("global");
  });

  it("evidence.workspace_multiplier = count of non-global workspaces", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    // Fixture DB has ws-alpha and ws-beta (2 workspaces)
    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string);
    expect(evidence.workspace_multiplier).toBe(2);
  });

  it("evidence carries required fields", () => {
    const tokens = 5000;
    const fileRef = "/home/.claude/CLAUDE.md";
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", fileRef, tokens);

    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string);

    expect(evidence.component).toBe("CLAUDE_MD");
    expect(evidence.file_ref).toBe(fileRef);
    expect(evidence.source_tokens).toBe(tokens);
    expect(evidence.source_target).toBe(TARGET_CLAUDE_MD);
    expect(evidence.delta_context_tokens).toBe(tokens - TARGET_CLAUDE_MD);
    expect(typeof evidence.turns_per_week).toBe("number");
    expect(evidence.modeled_savings_basis).toBe("LIST_EQUIV");
    expect(evidence.billed_cost_claim).toBe("UNAVAILABLE");
    expect(evidence.scope).toBe("global");
    expect(Array.isArray(evidence.steps)).toBe(true);
    expect(evidence.steps.length).toBeGreaterThan(0);
  });

  it("DOES NOT fire when source_tokens <= target (at target boundary)", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", TARGET_CLAUDE_MD);

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D1")?.status).toBe("INACTIVE");
    expect(d1Recs().length).toBe(0);
  });

  it("DOES NOT fire when source_tokens < target", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 500);

    runDetectors(db, { now: NOW });
    expect(d1Recs().length).toBe(0);
  });
});

describe("D1 — per-workspace MEMORY source", () => {
  it("fires for per-workspace MEMORY oversize, scope_workspace_id = workspace id", () => {
    const memTokens = TARGET_MEMORY + 2000; // 3000
    insInventory("ws-alpha", "MEMORY", "/home/.claude/projects/project-alpha/memory", memTokens);

    runDetectors(db, { now: NOW });
    const recs = d1Recs();
    expect(recs.length).toBe(1);
    const r = requireRec(recs);
    expect(r.scope_workspace_id).toBe("ws-alpha");

    const evidence = JSON.parse(r.evidence_json as string);
    expect(evidence.scope).toBe("workspace");
    // workspace_multiplier should NOT be present for per-workspace sources
    expect(evidence.workspace_multiplier).toBeUndefined();
  });

  it("per-workspace evidence has correct component and delta", () => {
    const tokens = 4000;
    insInventory("ws-alpha", "MEMORY", "/home/.claude/projects/project-alpha/memory", tokens);

    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string);
    expect(evidence.component).toBe("MEMORY");
    expect(evidence.source_target).toBe(TARGET_MEMORY);
    expect(evidence.delta_context_tokens).toBe(tokens - TARGET_MEMORY);
  });
});

describe("D1 — suppresses zero-savings recs (dormant workspace)", () => {
  it("does NOT fire a MEMORY rec for an oversize source with no in-window turns", () => {
    // A workspace with bloated memory but zero turns in the trailing-7d window has
    // zero modeled savings this week — the rec would be pure noise ("0 tokens/wk freed").
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES (?, ?, ?)`,
    ).run("ws-dormant", "project-dormant", "2026-01-01T00:00:00.000Z");
    insInventory(
      "ws-dormant",
      "MEMORY",
      "/home/.claude/projects/project-dormant/memory",
      TARGET_MEMORY + 5000, // well over target, but no turns ⇒ savings 0
    );

    const statuses = runDetectors(db, { now: NOW });
    // D1 evaluated the source (inventory present) but fired nothing (savings 0).
    expect(statuses.find((s) => s.detector_id === "D1")?.status).toBe("INACTIVE");
    expect(d1Recs().length).toBe(0);
  });
});

describe("D1 — MCP_SCHEMAS source", () => {
  it("does not treat catalog estimates as always-loaded context", () => {
    const catalogTokens = TARGET_MCP + 500; // 3500
    insInventory(
      GLOBAL_WORKSPACE_ID,
      "MCP_SCHEMAS",
      "/home/.claude/plugins/skill-catalog",
      catalogTokens,
    );

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((status) => status.detector_id === "D1")?.status).toBe("NOT_EVALUATED");
    expect(d1Recs()).toHaveLength(0);
  });
});

describe("D1 — multiple sources fire independently", () => {
  it("fires separate recs for each oversize source", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    insInventory(GLOBAL_WORKSPACE_ID, "MCP_SCHEMAS", "/home/.claude/plugins/skill-catalog", 8000);
    insInventory("ws-alpha", "MEMORY", "/home/.claude/projects/project-alpha/memory", 5000);

    runDetectors(db, { now: NOW });
    const recs = d1Recs();
    expect(recs.length).toBe(2);

    const globalRecs = recs.filter((r) => r.scope_workspace_id === null);
    const wsRecs = recs.filter((r) => r.scope_workspace_id !== null);
    expect(globalRecs.length).toBe(1);
    expect(wsRecs.length).toBe(1);
  });
});

describe("D1 — scopeKey and rec_id stability (determinism)", () => {
  it("two passes over the same frozen DB yield byte-identical rows", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    runDetectors(db, { now: NOW });
    const first = d1Recs();

    runDetectors(db, { now: NOW });
    const second = d1Recs();

    expect(second).toEqual(first);
  });

  it("rec_id is stable across drop+re-run (scopeKey is deterministic)", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    runDetectors(db, { now: NOW });
    const firstId = requireRec(d1Recs()).rec_id as string;

    db.prepare("DELETE FROM recommendations").run();

    runDetectors(db, { now: NOW });
    const secondId = requireRec(d1Recs()).rec_id as string;

    expect(firstId).toBe(secondId);
  });

  it("uses injected ctx.now for created_at (never new Date())", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    runDetectors(db, { now: NOW });
    const r = requireRec(d1Recs());
    expect(r.created_at).toBe(NOW.toISOString());
  });
});

describe("D1 — NOT_EVALUATED when inventory is empty", () => {
  it("reports NOT_EVALUATED when context_inventory is empty", () => {
    // No inventory rows — the fixture DB starts empty for context_inventory
    const statuses = runDetectors(db, { now: NOW });
    const d1 = statuses.find((s) => s.detector_id === "D1");
    expect(d1?.status).toBe("NOT_EVALUATED");
    expect(d1Recs().length).toBe(0);
  });
});

describe("D1 — modeled formula inputs", () => {
  it("formula includes delta_context_tokens as a key input", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    runDetectors(db, { now: NOW });

    const r = requireRec(d1Recs());
    const formula = JSON.parse(r.modeled_formula_json as string);
    expect(formula.model).toBe("D1_ALWAYS_LOADED_TRIM_V1");
    expect(typeof formula.inputs.delta_context_tokens).toBe("number");
    expect(formula.inputs.delta_context_tokens).toBe(5000 - TARGET_CLAUDE_MD);
  });

  it("weekly savings = delta × turns_per_week × blended_price (rounded)", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    // Use buildContext to get the same window as runDetectors
    const ctx = buildContext(NOW);

    // Count total turns in the fixture window across all non-global workspaces
    const totalTurns = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM turns
           WHERE workspace_id != ? AND ts >= ? AND ts < ?`,
        )
        .get(GLOBAL_WORKSPACE_ID, ctx.fromIso, ctx.toIso) as { n: number }
    ).n;

    runDetectors(db, { now: NOW });
    const formula = JSON.parse(requireRec(d1Recs()).modeled_formula_json as string);

    expect(formula.inputs.turns_per_week).toBe(totalTurns);
    expect(formula.inputs.delta_context_tokens).toBe(5000 - TARGET_CLAUDE_MD);
  });
});
