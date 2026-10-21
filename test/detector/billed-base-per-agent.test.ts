/**
 * Billed base counts every non-provisional turn; D1 eligibility is keyed on the turn's own agent
 * (spec: docs/plans/Archive/2026-09-30-billed-base-explore-plan-spec.md).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimLedger } from "../../src/detector/claim-ledger.js";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import { d1ClaimProducer } from "../../src/detector/detectors/d1_ctx_always_loaded.js";
import { buildContext } from "../../src/detector/engine.js";
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
  // Move the shared fixture outside the window so the cohort below is the whole base.
  db.prepare("UPDATE turns SET ts = '2025-01-01T00:00:00.000Z'").run();
});
afterEach(() => db.close());

function addSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, state)
     VALUES (?, 'ws-alpha', ?, 'RECONCILED')`,
  ).run(sessionId, `/${sessionId}.jsonl`);
}

function addAgent(sessionId: string, agentId: string, agentType: string, turns: number): void {
  db.prepare("INSERT INTO subagent_meta (agent_id, session_id, agent_type) VALUES (?, ?, ?)").run(
    agentId,
    sessionId,
    agentType,
  );
  addTurns(sessionId, agentId, 1, turns);
}

function addTurns(sessionId: string, agentId: string | null, side: number, count: number): void {
  const insert = db.prepare(`INSERT INTO turns
    (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
     cache_read_tokens, pricing_snapshot_id, parser_version)
    VALUES (?, ?, 'ws-alpha', '2026-01-07T00:00:00.000Z', 'claude-opus', ?, ?,
      5000, 'snap-sonnet', 'test-v1')`);
  for (let i = 0; i < count; i++) insert.run(`${agentId ?? "main"}-${i}`, sessionId, side, agentId);
}

function addInventory(component: "MEMORY" | "CLAUDE_MD"): void {
  db.prepare(
    `INSERT INTO context_inventory
       (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
     VALUES (?, ?, '2026-01-07T00:00:00.000Z', ?, ?, 'abc123', ?, 'chars4-v1')`,
  ).run(
    `probe-${component}`,
    GLOBAL_WORKSPACE_ID,
    component,
    `/home/.claude/${component}.md`,
    5000,
  );
}

function d1Ledger() {
  runDetectors(db, { now: NOW });
  return buildClaimLedger(db, buildContext(NOW), [d1ClaimProducer]);
}

const isBilled = (ledger: { billed: ReadonlyMap<string, number> }, turnKey: string): boolean =>
  [...ledger.billed.keys()].some((cell) => (JSON.parse(cell) as [string, string])[0] === turnKey);

describe("billed base and D1 eligibility are per agent", () => {
  it("(a) a non-Explore sidechain turn in an Explore session is billed and D1-claimable", () => {
    addSession("s-exp");
    addTurns("s-exp", null, 0, 10);
    addAgent("s-exp", "agent-explore", "Explore", 1);
    addAgent("s-exp", "agent-gp", "general-purpose", 10);
    addInventory("CLAUDE_MD");
    const ledger = d1Ledger();
    expect(isBilled(ledger, "s-exp|agent-gp-0")).toBe(true);
    const claimedSidechain = ledger.claims.filter(
      (claim) => claim.sessionId === "s-exp" && claim.turnKey.startsWith("s-exp|agent-gp-"),
    );
    expect(claimedSidechain.length).toBeGreaterThan(0);
  });

  it("(b) an Explore agent's own turn is billed but not D1-CLAUDE.md-eligible", () => {
    addSession("s-exp");
    addTurns("s-exp", null, 0, 10);
    addAgent("s-exp", "agent-explore", "Explore", 1);
    addAgent("s-exp", "agent-plan", "Plan", 1);
    addInventory("CLAUDE_MD");
    const ledger = d1Ledger();
    expect(isBilled(ledger, "s-exp|agent-explore-0")).toBe(true);
    expect(isBilled(ledger, "s-exp|agent-plan-0")).toBe(true);
    expect(ledger.claims.some((claim) => claim.turnKey.startsWith("s-exp|agent-explore-"))).toBe(
      false,
    );
    expect(ledger.claims.some((claim) => claim.turnKey.startsWith("s-exp|agent-plan-"))).toBe(
      false,
    );
    expect(ledger.claims.some((claim) => claim.turnKey.startsWith("s-exp|main-"))).toBe(true);
  });

  it("(c) a non-fork sidechain turn in a fork session is not D1-MEMORY-eligible; the fork's own is", () => {
    addSession("s-fork");
    addTurns("s-fork", null, 0, 10);
    addAgent("s-fork", "agent-fork", "fork", 2);
    addAgent("s-fork", "agent-gp", "general-purpose", 5);
    addInventory("MEMORY");
    const ledger = d1Ledger();
    expect(isBilled(ledger, "s-fork|agent-gp-0")).toBe(true);
    expect(ledger.claims.some((claim) => claim.turnKey.startsWith("s-fork|agent-gp-"))).toBe(false);
    expect(ledger.claims.some((claim) => claim.turnKey.startsWith("s-fork|agent-fork-"))).toBe(
      true,
    );
  });
});
