/** D9 FORK_SUBAGENT detector tests. SEC-101 fixtures contain ids and counts only. */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const TS = "2027-01-02T00:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-a', 'ws-a', ?)`,
  ).run(TS);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
     VALUES (?, 'ws-a', ?, ?, ?, 'RECONCILED', 0, 0, '[]', 0)`,
  ).run("parent-a-1", "/fixture/parent-a-1.jsonl", TS, TS);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
     VALUES (?, 'ws-a', ?, ?, ?, 'RECONCILED', 0, 0, '[]', 0)`,
  ).run("parent-a-2", "/fixture/parent-a-2.jsonl", TS, TS);
});

afterEach(() => db.close());

function insertSubagent(agentId: string, sessionId: string, agentType: string | null): void {
  db.prepare(
    `INSERT INTO subagent_meta
       (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
     VALUES (?, ?, ?, NULL, 1, 0)`,
  ).run(agentId, sessionId, agentType);
}

/** A priced turn of the parent session; a fork turn when `agentId` is set. */
function insertForkTurn(
  messageId: string,
  agentId: string | null,
  sessionId: string,
  ts: string,
  cacheRead: number,
  costU = 0,
): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, cache_read_tokens,
        pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version, agent_id)
     VALUES (?, ?, 'ws-a', ?, 'claude-sonnet', ?, ?, 'snap-sonnet', ?, 'LIST_EQUIV', 0, 'test-v1', ?)`,
  ).run(messageId, sessionId, ts, agentId === null ? 0 : 1, cacheRead, costU, agentId);
}

function d9Recs(): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id = 'D9' ORDER BY rec_id")
    .all() as Array<Record<string, unknown>>;
}

describe("D9 — fork subagents", () => {
  it("fires once for a workspace with the fork count and parent session ids", () => {
    insertSubagent("agent-a-1", "parent-a-1", "fork");
    insertSubagent("agent-a-2", "parent-a-2", "fork");

    const statuses = runDetectors(db, { now: NOW });

    expect(statuses.find((status) => status.detector_id === "D9")?.status).toBe("ACTIVE");
    const recs = d9Recs();
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    if (!rec) throw new Error("expected D9 finding");
    expect(rec.scope_workspace_id).toBe("ws-a");
    expect(rec.modeled_savings_u_per_wk).toBeNull();

    const facts = JSON.parse(rec.evidence_json as string).facts as Record<string, unknown>;
    expect(facts.fork_count).toBe(2);
    expect(facts.session_ids).toEqual(["parent-a-1", "parent-a-2"]);

    // U7: these forks have no ingested turns, so their cost is unknown. The estimate used to be
    // hard-wired to 0 (basis "E", rank 0); it now says "cost not measured" with no rank value.
    const formula = JSON.parse(rec.modeled_formula_json as string) as Record<string, unknown>;
    const estimate = formula.estimate as Record<string, unknown>;
    expect(estimate.basis).toBe("X");
    expect(estimate.rank_value_u_per_wk).toBeNull();
    expect(estimate.label).toBe("cost not measured");
    expect(facts.cost_basis).toBe("not_measured");
  });

  it("estimates the fork's cache reads, priced from each turn's snapshot", () => {
    insertSubagent("agent-a-1", "parent-a-1", "fork");
    for (const id of ["m1", "m2"]) insertForkTurn(id, "agent-a-1", "parent-a-1", TS, 100_000);

    runDetectors(db, { now: NOW });
    const rec = d9Recs()[0];
    if (!rec) throw new Error("expected D9 finding");
    const facts = JSON.parse(rec.evidence_json as string).facts as Record<string, unknown>;
    const estimate = (JSON.parse(rec.modeled_formula_json as string) as Record<string, unknown>)
      .estimate as Record<string, unknown>;
    // 200,000 cache-read tokens at the fixture snapshot's $0.30/MTok = 60,000 µUSD.
    expect(facts.fork_cache_read_tokens).toBe(200_000);
    expect(facts.cost_basis).toBe("measured");
    expect(estimate.basis).toBe("E");
    expect(estimate.rank_value_u_per_wk).toBe(60_000);
  });

  it("windows a fork by its own turn times, not its parent session's last turn", () => {
    insertSubagent("agent-a-1", "parent-a-1", "fork");
    // The parent session ended inside the window, but every fork turn is weeks older.
    insertForkTurn("old1", "agent-a-1", "parent-a-1", "2026-11-01T00:00:00.000Z", 100_000);

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((status) => status.detector_id === "D9")?.status).toBe("INACTIVE");
    expect(d9Recs()).toHaveLength(0);
  });

  it("stays quiet when the estimate is under 0.25% of the workspace's 7-day spend", () => {
    insertSubagent("agent-a-1", "parent-a-1", "fork");
    insertForkTurn("m1", "agent-a-1", "parent-a-1", TS, 100_000);
    insertForkTurn("big", null, "parent-a-1", TS, 0, 100_000_000_000);

    runDetectors(db, { now: NOW });
    expect(d9Recs()).toHaveLength(0);
  });

  it("does not fire for non-fork subagents", () => {
    insertSubagent("agent-a-1", "parent-a-1", "general-purpose");
    insertSubagent("agent-a-2", "parent-a-2", null);

    const statuses = runDetectors(db, { now: NOW });

    expect(statuses.find((status) => status.detector_id === "D9")?.status).toBe("INACTIVE");
    expect(d9Recs()).toHaveLength(0);
  });
});

describe("D9 — determinism", () => {
  it("two passes over the same frozen DB yield identical rows", () => {
    insertSubagent("agent-a-1", "parent-a-1", "fork");
    insertSubagent("agent-a-2", "parent-a-2", "fork");

    runDetectors(db, { now: NOW });
    const first = d9Recs().map((r) => r.evidence_json);
    runDetectors(db, { now: NOW });
    const second = d9Recs().map((r) => r.evidence_json);

    expect(second).toEqual(first);
  });
});
