import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCostPerSuccess } from "../../src/query/api/cost-per-success.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2027-06-01T00:00:00.000Z";
const TO = "2027-07-01T00:00:00.000Z";
const TS_IN = "2027-06-15T12:00:00.000Z";

interface CostPerSuccessContract {
  merged_pr_count: number;
  closed_unmerged_count: number;
  cost_per_merged_pr_u: number | null;
  commit_session_count: number;
  cost_per_commit_session_u: number | null;
  linkage_coverage_pct: number | null;
  n: number;
  window: { from: string; to: string };
}

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

function insWs(workspaceId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run(workspaceId, workspaceId, FROM);
}

function insSession(sessionId: string, workspaceId: string, costEquivU: number, ts = TS_IN): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',1,?,'[]')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`, ts, ts, costEquivU);
}

function insWorkItem(
  workItemId: string,
  workspaceId: string,
  number: number,
  state: "OPEN" | "MERGED" | "CLOSED",
  lifecycleTs: string | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO work_items
       (work_item_id, workspace_id, number, state, checks_conclusion, opened_at,
        merged_at, closed_at, synced_at)
     VALUES (?,?,?,?,?, ?,?,?,?)`,
  ).run(
    workItemId,
    workspaceId,
    number,
    state,
    "SUCCESS",
    FROM,
    state === "MERGED" ? lifecycleTs : null,
    state === "CLOSED" ? lifecycleTs : null,
    TS_IN,
  );
}

function insLink(sessionId: string, workItemId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO session_work_links (session_id, work_item_id, confidence, method)
     VALUES (?,?,1.0,'SHA_OVERLAP')`,
  ).run(sessionId, workItemId);
}

function insToolEvent(eventId: string, sessionId: string, commitSha: string | null): void {
  db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
     VALUES (?,?,?,?,?)`,
  ).run(eventId, sessionId, TS_IN, "Bash", commitSha);
}

function metric(workspaceId: string | null): CostPerSuccessContract {
  const response = getCostPerSuccess(db, workspaceId, FROM, TO);
  expect(response.meta.claim_kind).toBe("OBS_PROXY");
  if (response.data === null) throw new Error("expected data");
  return response.data as unknown as CostPerSuccessContract;
}

describe("getCostPerSuccess", () => {
  it("computes the exact cost per merged PR from distinct linked sessions", () => {
    insWs("ws-cost");
    insSession("sess-cost-1", "ws-cost", 1000);
    insSession("sess-cost-2", "ws-cost", 3000);
    insWorkItem("wi-cost-1", "ws-cost", 1, "MERGED", TS_IN);
    insWorkItem("wi-cost-2", "ws-cost", 2, "MERGED", TS_IN);
    insLink("sess-cost-1", "wi-cost-1");
    insLink("sess-cost-2", "wi-cost-2");

    const result = metric("ws-cost");

    expect(result.merged_pr_count).toBe(2);
    expect(result.cost_per_merged_pr_u).toBe(2000);
    expect(result.n).toBe(2);
    expect(result.window).toEqual({ from: FROM, to: TO });
  });

  it("excludes unlinked session cost from cost per merged PR", () => {
    insWs("ws-unlinked");
    insSession("sess-linked", "ws-unlinked", 1000);
    insSession("sess-unlinked", "ws-unlinked", 9000);
    insWorkItem("wi-unlinked", "ws-unlinked", 1, "MERGED", TS_IN);
    insLink("sess-linked", "wi-unlinked");

    const result = metric("ws-unlinked");

    expect(result.merged_pr_count).toBe(1);
    expect(result.cost_per_merged_pr_u).toBe(1000);
  });

  it("returns null ratios when there are no merged PRs or commit sessions", () => {
    insWs("ws-empty");

    const result = metric("ws-empty");

    expect(result.merged_pr_count).toBe(0);
    expect(result.cost_per_merged_pr_u).toBeNull();
    expect(result.commit_session_count).toBe(0);
    expect(result.cost_per_commit_session_u).toBeNull();
  });

  it("computes linkage coverage from in-window linked sessions", () => {
    insWs("ws-coverage");
    insSession("sess-covered-1", "ws-coverage", 1000);
    insSession("sess-covered-2", "ws-coverage", 1000);
    insSession("sess-uncovered-1", "ws-coverage", 1000);
    insSession("sess-uncovered-2", "ws-coverage", 1000);
    insWorkItem("wi-covered-1", "ws-coverage", 1, "OPEN", null);
    insWorkItem("wi-covered-2", "ws-coverage", 2, "OPEN", null);
    insLink("sess-covered-1", "wi-covered-1");
    insLink("sess-covered-2", "wi-covered-2");

    expect(metric("ws-coverage").linkage_coverage_pct).toBe(50);
  });

  it("aggregates globally while workspace calls remain isolated", () => {
    insWs("ws-global-a");
    insSession("sess-global-a", "ws-global-a", 1000);
    insWorkItem("wi-global-a", "ws-global-a", 1, "MERGED", TS_IN);
    insLink("sess-global-a", "wi-global-a");

    insWs("ws-global-b");
    insSession("sess-global-b", "ws-global-b", 3000);
    insWorkItem("wi-global-b", "ws-global-b", 1, "MERGED", TS_IN);
    insLink("sess-global-b", "wi-global-b");

    const global = metric(null);
    const workspaceA = metric("ws-global-a");

    expect(global.merged_pr_count).toBe(2);
    expect(global.cost_per_merged_pr_u).toBe(2000);
    expect(workspaceA.merged_pr_count).toBe(1);
    expect(workspaceA.cost_per_merged_pr_u).toBe(1000);
  });

  it("counts commit sessions and computes cost_per_commit_session_u", () => {
    insWs("ws-commit");
    // Two sessions in window: one with a commit_sha tool event, one without
    insSession("sess-commit-1", "ws-commit", 2000);
    insSession("sess-commit-2", "ws-commit", 4000);
    insSession("sess-no-commit", "ws-commit", 9000);
    // Seed tool_events: sess-commit-1 and sess-commit-2 have commit_sha, sess-no-commit does not
    insToolEvent("evt-1", "sess-commit-1", "abc123");
    insToolEvent("evt-2", "sess-commit-2", "def456");
    insToolEvent("evt-3", "sess-no-commit", null);

    const result = metric("ws-commit");

    // commit_session_count should be 2 (only sessions with a non-null commit_sha)
    expect(result.commit_session_count).toBe(2);
    // cost_per_commit_session_u = (2000 + 4000) / 2 = 3000
    expect(result.cost_per_commit_session_u).toBe(3000);
  });

  it("counts a session linked to two merged PRs only once (DISTINCT dedup)", () => {
    insWs("ws-dedup");
    insSession("sess-dedup", "ws-dedup", 1000);
    insWorkItem("wi-dedup-1", "ws-dedup", 1, "MERGED", TS_IN);
    insWorkItem("wi-dedup-2", "ws-dedup", 2, "MERGED", TS_IN);
    insLink("sess-dedup", "wi-dedup-1");
    insLink("sess-dedup", "wi-dedup-2");

    const result = metric("ws-dedup");

    // Two merged PRs, one session (cost 1000) linked to both.
    // Numerator counts the session once: 1000 / 2 = 500, NOT 2000 / 2 = 1000.
    expect(result.merged_pr_count).toBe(2);
    expect(result.cost_per_merged_pr_u).toBe(500);
  });

  it("does not count cross-workspace links toward workspace-scoped coverage", () => {
    insWs("ws-iso-a");
    insWs("ws-iso-b");
    // One in-window session in ws-A, linked only to a work item in ws-B.
    insSession("sess-iso-a", "ws-iso-a", 1000);
    insWorkItem("wi-iso-b", "ws-iso-b", 1, "OPEN", null);
    insLink("sess-iso-a", "wi-iso-b");

    // ws-A has one session, linked only across the boundary -> 0% coverage, not 100%.
    expect(metric("ws-iso-a").linkage_coverage_pct).toBe(0);
  });
});
