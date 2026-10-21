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
import {
  buildClaimLedger,
  conservationReport,
  ledgerTotals,
} from "../../src/detector/claim-ledger.js";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import {
  D1_FRACTION_RANGE,
  D1_MEMORY_BASIS_SINCE,
  d1ClaimProducer,
  d1Detector,
} from "../../src/detector/detectors/d1_ctx_always_loaded.js";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import { recId } from "../../src/detector/rec-id.js";
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

describe("D1 component turn scope", () => {
  it("counts main and fork for memory, and main plus non-Explore/Plan subagents for CLAUDE.md", () => {
    // Move the shared fixture outside W0 so this cohort has exact arithmetic.
    db.prepare("UPDATE turns SET ts = '2025-01-01T00:00:00.000Z'").run();
    const insertSession = db.prepare(`INSERT INTO sessions
      (session_id, workspace_id, file_path, state) VALUES (?, 'ws-alpha', ?, 'RECONCILED')`);
    const insertTurn = db.prepare(`INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
       cache_read_tokens, pricing_snapshot_id, parser_version)
      VALUES (?, ?, 'ws-alpha', '2026-01-07T00:00:00.000Z', 'claude-opus', ?, ?,
        5000, 'snap-sonnet', 'test-v1')`);
    for (const [kind, count, sidechain] of [
      ["main", 10, 0],
      ["general-purpose", 10, 1],
      ["fork", 2, 1],
      ["Explore", 1, 1],
      ["Plan", 1, 1],
    ] as const) {
      const sessionId = `d1-${kind}`;
      insertSession.run(sessionId, `/${sessionId}.jsonl`);
      if (sidechain)
        db.prepare(`INSERT INTO subagent_meta
        (agent_id, session_id, agent_type) VALUES (?, ?, ?)`).run(sessionId, sessionId, kind);
      for (let i = 0; i < count; i++)
        insertTurn.run(`${sessionId}-${i}`, sessionId, sidechain, sidechain ? sessionId : null);
    }
    insInventory(GLOBAL_WORKSPACE_ID, "MEMORY", "/home/.claude/MEMORY.md", 3000);
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    const outcome = d1Detector.evaluate(db, buildContext(NOW));
    const turnsByComponent = Object.fromEntries(
      outcome.fired.map((item) => {
        const facts = (item.payload as { facts: { component: string; turns_per_week: number } })
          .facts;
        return [facts.component, facts.turns_per_week];
      }),
    );
    expect(turnsByComponent).toEqual({ MEMORY: 12, CLAUDE_MD: 22 });
    // If the cohort contains Explore instead of fork, CLAUDE.md has 20 eligible turns.
    db.prepare("UPDATE subagent_meta SET agent_type = 'Explore' WHERE agent_type = 'fork'").run();
    const withoutFork = d1Detector.evaluate(db, buildContext(NOW));
    const claude = withoutFork.fired.find(
      (item) => (item.payload as { facts: { component: string } }).facts.component === "CLAUDE_MD",
    );
    expect((claude?.payload as { facts: { turns_per_week: number } }).facts.turns_per_week).toBe(
      20,
    );
    db.prepare(
      "UPDATE subagent_meta SET agent_type = NULL WHERE agent_type = 'general-purpose'",
    ).run();
    const unknownType = d1Detector.evaluate(db, buildContext(NOW));
    const unknownClaude = unknownType.fired.find(
      (item) => (item.payload as { facts: { component: string } }).facts.component === "CLAUDE_MD",
    );
    expect(
      (unknownClaude?.payload as { facts: { turns_per_week: number } }).facts.turns_per_week,
    ).toBe(20);
    runDetectors(db, { now: NOW });
    const ledger = buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]);
    expect(ledger.claims.filter((claim) => claim.sessionId === "d1-general-purpose")).toHaveLength(
      10,
    );
    expect(ledger.claims.some((claim) => claim.sessionId === "d1-Explore")).toBe(false);
    expect(ledger.claims.some((claim) => claim.sessionId === "d1-Plan")).toBe(false);
    expect(conservationReport(ledger).doubleOwned).toEqual([]);
    db.prepare("UPDATE context_inventory SET tokens = 10000").run();
    runDetectors(db, { now: NOW });
    const capped = buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]);
    expect(conservationReport(capped)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("records measured content only for the settled Claude version/model pair", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "MEMORY", "/home/.claude/MEMORY.md", 3000);
    const heuristic = d1Detector.evaluate(db, buildContext(NOW)).fired[0];
    expect(
      (heuristic?.payload as { facts: { attribution_method: string } }).facts.attribution_method,
    ).toBe("CHARS4_ESTIMATE");
    expect(
      (heuristic?.modeled_formula_json as { estimate: { label: string } }).estimate.label,
    ).toContain("unmeasured token uncertainty");
    db.prepare(`UPDATE context_inventory SET attribution_version =
      'measured-pair-v1:2.1.280/claude-opus-5-5'`).run();
    const measured = d1Detector.evaluate(db, buildContext(NOW)).fired[0];
    expect(
      (measured?.payload as { facts: { attribution_method: string } }).facts.attribution_method,
    ).toBe("MEASURED_CONTENT");
  });

  it("an item that fails the share-of-context gate yields no card and no claim", () => {
    db.prepare("UPDATE turns SET cache_read_tokens = 20000 WHERE provisional = 0").run();
    insInventory(GLOBAL_WORKSPACE_ID, "MEMORY", "/home/.claude/MEMORY.md", 3000);
    const claimsFor = () =>
      buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]).claims.filter(
        (claim) => claim.detectorId === "D1",
      );
    expect(d1Detector.evaluate(db, buildContext(NOW)).fired).toHaveLength(1);
    expect(claimsFor().length).toBeGreaterThan(0);
    // The source is now well under 2% of the mean context per turn.
    db.prepare("UPDATE turns SET input_tokens = 1000000").run();
    expect(d1Detector.evaluate(db, buildContext(NOW)).fired).toHaveLength(0);
    expect(claimsFor()).toHaveLength(0);
  });

  it("attributes two source slices to their own D1 recommendations", () => {
    db.prepare("UPDATE turns SET cache_read_tokens = 20000 WHERE provisional = 0").run();
    insInventory(GLOBAL_WORKSPACE_ID, "MEMORY", "/home/.claude/MEMORY.md", 3000);
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    runDetectors(db, { now: NOW });
    const recs = d1Recs();
    expect(recs).toHaveLength(2);
    const byProbe = new Map(
      recs.map((rec) => [
        `prefix:${JSON.parse(rec.evidence_json as string).facts.probe_id as string}`,
        rec.rec_id as string,
      ]),
    );
    const ledger = buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]);
    for (const claim of ledger.claims.filter((claim) => claim.detectorId === "D1"))
      expect(claim.recId).toBe(byProbe.get(claim.slice));
    const totals = ledgerTotals(
      ledger,
      recs.map((rec) => ({
        rec_id: rec.rec_id as string,
        detector_id: "D1",
        scope_workspace_id: rec.scope_workspace_id as string | null,
      })),
    );
    expect([...totals.byRec.keys()].sort()).toEqual([...byProbe.values()].sort());
    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });
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
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string).facts;
    expect(evidence.scope).toBe("global");
  });

  it("evidence.workspace_multiplier = count of non-global workspaces", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    // Fixture DB has ws-alpha and ws-beta (2 workspaces)
    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string).facts;
    expect(evidence.workspace_multiplier).toBe(2);
  });

  it("U9 r7: top_workspace_turns is the busiest workspace's turn count, so a probe workspace shows", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string).facts;
    const perWorkspace = (
      db
        .prepare("SELECT COUNT(*) AS n FROM turns WHERE provisional = 0 GROUP BY workspace_id")
        .all() as { n: number }[]
    ).map((r) => r.n);
    expect(evidence.top_workspace_turns).toBe(Math.max(...perWorkspace));
    expect(evidence.top_workspace_turns).toBeLessThan(evidence.turns_per_week + 1);
    expect(evidence.top_workspace_turns).toBeGreaterThan(0);
  });

  it("U7: workspace_multiplier ignores registered workspaces that ran no turns this week", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    for (const id of ["ws-idle-1", "ws-idle-2", "ws-idle-3"]) {
      db.prepare(
        `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
         VALUES (?, ?, '2026-01-01T00:00:00.000Z')`,
      ).run(id, id);
    }
    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string).facts;
    // Five workspaces are registered; only the two with turns count (the card used to say 5).
    expect(evidence.workspace_multiplier).toBe(2);
  });

  it("U7: does not fire when the saving is under 0.2% of the scope's 7-day spend", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    db.prepare(
      "UPDATE turns SET cost_equiv_u = 1000000000000 WHERE rowid = (SELECT MIN(rowid) FROM turns)",
    ).run();
    runDetectors(db, { now: NOW });
    expect(d1Recs()).toHaveLength(0);
  });

  it("evidence carries required fields", () => {
    const tokens = 5000;
    const fileRef = "/home/.claude/CLAUDE.md";
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", fileRef, tokens);

    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string).facts;

    expect(evidence.component).toBe("CLAUDE_MD");
    expect(evidence).not.toHaveProperty("file_ref");
    expect(evidence.source_tokens).toBe(tokens);
    expect(evidence.source_target).toBe(TARGET_CLAUDE_MD);
    expect(evidence.delta_context_tokens).toBe(tokens - TARGET_CLAUDE_MD);
    expect(typeof evidence.turns_per_week).toBe("number");
    expect(evidence.scope).toBe("global");
    expect(evidence.workspace_multiplier).toBe(2);
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

    const evidence = JSON.parse(r.evidence_json as string).facts;
    expect(evidence.scope).toBe("workspace");
    expect(evidence.workspace_multiplier).toBe(1);
  });

  it("per-workspace evidence has correct component and delta", () => {
    const tokens = 4000;
    insInventory("ws-alpha", "MEMORY", "/home/.claude/projects/project-alpha/memory", tokens);

    runDetectors(db, { now: NOW });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string).facts;
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
    expect(formula.formula_id).toBe("D1_ALWAYS_LOADED_TRIM_V1");
    expect(typeof formula.inputs.delta_context_tokens).toBe("number");
    expect(formula.inputs.delta_context_tokens).toBe(5000 - TARGET_CLAUDE_MD);
  });

  it("weekly savings = delta × turns_per_week × blended_price (rounded)", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);

    // Use buildContext to get the same window as runDetectors
    const ctx = buildContext(NOW);

    // Count priced turns in the fixture window; LIVE provisional turns have no settled bill.
    const totalTurns = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM turns
           WHERE workspace_id != ? AND ts >= ? AND ts < ? AND provisional = 0`,
        )
        .get(GLOBAL_WORKSPACE_ID, ctx.fromIso, ctx.toIso) as { n: number }
    ).n;

    runDetectors(db, { now: NOW });
    const formula = JSON.parse(requireRec(d1Recs()).modeled_formula_json as string);

    expect(formula.inputs.turns_per_week).toBe(totalTurns);
    expect(formula.inputs.delta_context_tokens).toBe(5000 - TARGET_CLAUDE_MD);
    // Basis P (oracle rule): rank value is the stored modeled figure, pass-through.
    const savedU = requireRec(d1Recs()).modeled_savings_u_per_wk as number;
    expect(savedU).toBeGreaterThan(0);
    expect(formula.estimate).toMatchObject({ basis: "P", rank_value_u_per_wk: savedU });
    const evidence = JSON.parse(requireRec(d1Recs()).evidence_json as string).facts as Record<
      string,
      unknown
    >;
    expect(evidence.session_ids).toEqual(["sess-a1", "sess-a2", "sess-a3", "sess-b1"]);
    for (const sessionId of evidence.session_ids as string[]) {
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(sessionId),
      ).toEqual({ n: 1 });
    }
  });
});

// ── d1ClaimProducer: deterministic recId + as-of inventory pricing (P3.L L2) ────────────────

function insHistory(
  workspaceId: string,
  component: string,
  fileRef: string,
  tokens: number,
  attributionVersion: string,
  observedAt: string,
): void {
  db.prepare(
    `INSERT INTO context_inventory_history
       (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, component, fileRef, `hash-${tokens}`, tokens, attributionVersion, observedAt);
}

function insSession(sessionId: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, ?, ?, 'RECONCILED')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`);
}

function insTurn(
  messageId: string,
  sessionId: string,
  workspaceId: string,
  tsIso: string,
  cacheReadTokens: number,
): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        cache_read_tokens, pricing_snapshot_id, parser_version)
     VALUES (?, ?, ?, ?, 'claude-opus', 0, ?, 'snap-sonnet', 'test-v1')`,
  ).run(messageId, sessionId, workspaceId, tsIso, cacheReadTokens);
}

describe("d1ClaimProducer — deterministic recId and as-of inventory pricing", () => {
  it("claims with the deterministic recId, prefix:<probe> slice, and round(raw × 0.5) — no recommendations row exists", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    insSession("sess-noRec", "ws-alpha");
    insTurn("msg-noRec", "sess-noRec", "ws-alpha", "2026-01-03T00:00:00.000Z", 20_000);

    // No runDetectors() call: recommendations is empty. The producer must still claim.
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual({ n: 0 });

    const ledger = buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]);
    const claims = ledger.claims.filter((claim) => claim.sessionId === "sess-noRec");
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    if (claim === undefined) throw new Error("expected a claim");

    const probeId = (
      db
        .prepare(
          "SELECT probe_id FROM context_inventory WHERE workspace_id = ? AND component = 'CLAUDE_MD'",
        )
        .get(GLOBAL_WORKSPACE_ID) as { probe_id: string }
    ).probe_id;
    expect(claim.slice).toBe(`prefix:${probeId}`);
    expect(claim.recId).toBe(recId("D1", null, "D1|global|CLAUDE_MD|CLAUDE.md"));
    expect(claim.assumed).toBe(true);
    expect(claim.fraction).toBe(0.5);
    expect(claim.fractionRange).toEqual(D1_FRACTION_RANGE);
    // raw delta = 5000 - 2000 = 3000; ledger claims round(3000 × 0.5) = 1500.
    expect(claim.tokens).toBe(1500);
    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("as-of: prices a turn before any history row at current size, and turns either side of a mid-window trim at old vs new size", () => {
    // Current (trimmed) size.
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    // Production shape (context-probe.ts upsertInventoryRow): one history row per distinct
    // version — the pre-trim size recorded when it was probed, then the post-trim size
    // recorded when the file shrank.
    insHistory(
      GLOBAL_WORKSPACE_ID,
      "CLAUDE_MD",
      "/home/.claude/CLAUDE.md",
      9000, // OLD size
      "chars4-v1",
      "2026-01-02T00:00:00.000Z",
    );
    insHistory(
      GLOBAL_WORKSPACE_ID,
      "CLAUDE_MD",
      "/home/.claude/CLAUDE.md",
      5000, // NEW size (matches current)
      "chars4-v1",
      "2026-01-05T00:00:00.000Z",
    );
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-gamma-asof', 'ws-gamma-asof', '2026-01-01T00:00:00.000Z')`,
    ).run();
    insSession("sess-asof", "ws-gamma-asof");
    insTurn("msg-early", "sess-asof", "ws-gamma-asof", "2026-01-01T12:00:00.000Z", 20_000);
    insTurn("msg-mid", "sess-asof", "ws-gamma-asof", "2026-01-03T00:00:00.000Z", 20_000);
    insTurn("msg-late", "sess-asof", "ws-gamma-asof", "2026-01-06T00:00:00.000Z", 20_000);

    const ledger = buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]);
    const bySessionClaims = new Map(
      ledger.claims
        .filter((claim) => claim.sessionId === "sess-asof")
        .map((claim) => [claim.turnKey.split("|")[1], claim]),
    );
    // Before the earliest history row: falls back to the current (5000) size.
    // delta = 5000 - 2000 = 3000 → round(3000 × 0.5) = 1500.
    expect(bySessionClaims.get("msg-early")?.tokens).toBe(1500);
    // Between the two history rows: prices at the OLD (9000) size.
    // delta = 9000 - 2000 = 7000 → round(7000 × 0.5) = 3500.
    expect(bySessionClaims.get("msg-mid")?.tokens).toBe(3500);
    // After the trim's history row: prices at the NEW (5000, current) size.
    expect(bySessionClaims.get("msg-late")?.tokens).toBe(1500);
    expect(conservationReport(ledger)).toEqual({ doubleOwned: [], overbilled: [], overvalued: [] });
  });

  it("ignores context_inventory_history rows whose attribution_version does not match the current row's (spec amendment 1)", () => {
    insInventory(GLOBAL_WORKSPACE_ID, "CLAUDE_MD", "/home/.claude/CLAUDE.md", 5000);
    // Matches the current row's attribution_version — must be used.
    insHistory(
      GLOBAL_WORKSPACE_ID,
      "CLAUDE_MD",
      "/home/.claude/CLAUDE.md",
      9000,
      "chars4-v1",
      "2026-01-02T00:00:00.000Z",
    );
    // Chronologically later, but a DIFFERENT attribution basis (mixed measured/chars4 rows
    // interleave in live data) — must be ignored even though it is the latest by timestamp.
    insHistory(
      GLOBAL_WORKSPACE_ID,
      "CLAUDE_MD",
      "/home/.claude/CLAUDE.md",
      99_999,
      "measured-pair-v1:2.1.280/claude-opus-5-5",
      "2026-01-03T00:00:00.000Z",
    );
    insSession("sess-avmix", "ws-alpha");
    insTurn("msg-avmix", "sess-avmix", "ws-alpha", "2026-01-04T00:00:00.000Z", 200_000);

    const ledger = buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]);
    const claim = ledger.claims.find((c) => c.sessionId === "sess-avmix");
    if (claim === undefined) throw new Error("expected a claim");
    // asOf = 9000 (the matching-attribution row), not 99,999 (the mismatched, later row).
    // delta = 9000 - 2000 = 7000 → round(7000 × 0.5) = 3500.
    expect(claim.tokens).toBe(3500);
  });

  it("MEMORY: ignores context_inventory_history rows observed before D1_MEMORY_BASIS_SINCE (spec amendment 2)", () => {
    // Window anchored so D1_MEMORY_BASIS_SINCE (2026-09-23T23:08:00Z) falls just before it.
    const laterNow = new Date("2026-10-01T00:00:00.000Z");
    insInventory("ws-alpha", "MEMORY", "/home/.claude/projects/project-alpha/memory", 500);
    // Recorded before the U0.1 probe-fix cutoff — measures a different quantity (all memory
    // files, not MEMORY.md only) and must be ignored even though nothing else qualifies.
    const beforeCutoff = new Date(D1_MEMORY_BASIS_SINCE);
    beforeCutoff.setUTCDate(beforeCutoff.getUTCDate() - 3);
    insHistory(
      "ws-alpha",
      "MEMORY",
      "/home/.claude/projects/project-alpha/memory",
      50_000,
      "chars4-v1",
      beforeCutoff.toISOString(),
    );
    insSession("sess-membasis", "ws-alpha");
    insTurn("msg-membasis", "sess-membasis", "ws-alpha", "2026-09-24T12:00:00.000Z", 200_000);

    const ledger = buildClaimLedger(db, buildContext(laterNow), [d1ClaimProducer]);
    // With the pre-cutoff row correctly ignored, asOf falls back to the current 500 tokens,
    // which is below the 1,000 MEMORY target — no claim. Without the fix this would instead
    // price the turn off the stale 50,000-token row and produce a large spurious claim.
    expect(ledger.claims.some((claim) => claim.sessionId === "sess-membasis")).toBe(false);
  });
});
