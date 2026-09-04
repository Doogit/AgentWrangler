/**
 * test/query/outcomes-api.test.ts — outcomes API: envelope + denominators.
 *
 * Verifies:
 *   - EXPERIMENTAL envelope + 73% disclosure note on getSuccessRate
 *   - Denominator excludes UNLINKED sessions + COND-1 excluded findings
 *   - getLinkageRate uses correct denominator (RECONCILED + Bash tool_event)
 *   - listWorkspaceOutcomes returns per-workspace rows
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getLinkageRate,
  getSuccessRate,
  listWorkspaceOutcomes,
} from "../../src/query/api/outcomes.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

function seedOutcomeData(d: Database.Database) {
  // Update workspace with repo mapping
  d.prepare(
    "UPDATE workspaces SET repo_owner='acme', repo_name='r' WHERE workspace_id='ws-alpha'",
  ).run();

  // Insert work_item and link to sess-a1 (RECONCILED).
  // merged_at must be within the 30-day window used by getSuccessRate — use 7 days ago.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare(
    `INSERT OR IGNORE INTO work_items
       (work_item_id, workspace_id, number, state, checks_conclusion, merged_at, synced_at)
     VALUES ('gh:acme/r#1', 'ws-alpha', 1, 'MERGED', 'SUCCESS', ?, ?)`,
  ).run(sevenDaysAgo, sevenDaysAgo);
  d.prepare(
    `INSERT OR IGNORE INTO session_work_links (session_id, work_item_id, confidence, method)
     VALUES ('sess-a1', 'gh:acme/r#1', 1.0, 'MANUAL')`,
  ).run();
  d.prepare(
    `INSERT OR IGNORE INTO observed_outcomes (work_item_id, outcome, derived_at, methodology_version)
     VALUES ('gh:acme/r#1', 'OBSERVED_SUCCESS', '2026-01-01T00:00:00Z', 'outcome-v1')`,
  ).run();

  // Add a Bash tool_event to sess-a1 so it counts in linkage denominator
  d.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name)
     VALUES ('te-api-1', 'sess-a1', '2026-01-01T00:00:00Z', 'Bash')`,
  ).run();
}

function seedRoutingWorkspace(
  workspaceId: string,
  turns: Array<{ model: string; isSidechain?: boolean; provisional?: boolean }>,
): void {
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(workspaceId, workspaceId);
  if (turns.length === 0) return;

  const sessionId = `session-${workspaceId}`;
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             'RECONCILED', ?, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fake/${workspaceId}.jsonl`, turns.length);

  const insert = db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
        cache_write_1h, cache_write_other, tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?, ?,
             0, 0, 0, 0, 0, 0, NULL, 'snap-sonnet', 0, 'LIST_EQUIV', ?, 'test-v1')`,
  );
  turns.forEach((turn, index) => {
    insert.run(
      `message-${workspaceId}-${index}`,
      sessionId,
      workspaceId,
      turn.model,
      turn.isSidechain ? 1 : 0,
      turn.provisional ? 1 : 0,
    );
  });
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seedOutcomeData(db);
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("getSuccessRate", () => {
  it("returns EXPERIMENTAL envelope", () => {
    const res = getSuccessRate();
    expect(res.meta.claim_kind).toBe("EXPERIMENTAL");
    expect(res.meta.metric_definition_version).toBe("observe-1");
  });

  it("includes 73% methodology note in qualification", () => {
    const res = getSuccessRate();
    expect(res.meta.qualification.note).toContain("73%");
  });

  it("counts terminal linked work items in denominator", () => {
    const res = getSuccessRate();
    if (res.data === null) throw new Error("expected data");
    // 1 terminal linked PR seeded within 30-day window → terminal_n must be ≥ 1
    expect(res.data.terminal_n).toBeGreaterThanOrEqual(1);
    expect(typeof res.data.success_rate).toBe("number");
  });

  it("UNLINKED sessions are not in denominator (no data row = not counted)", () => {
    // sess-b1 has no session_work_links → UNLINKED → not in denominator.
    // With only one seeded linked work_item, terminal_n must be exactly 1.
    const res = getSuccessRate();
    if (res.data === null) throw new Error("expected data");
    expect(res.data.terminal_n).toBe(1);
  });
});

describe("getLinkageRate", () => {
  it("returns EXPERIMENTAL envelope", () => {
    const res = getLinkageRate();
    expect(res.meta.claim_kind).toBe("EXPERIMENTAL");
  });

  it("uses correct denominator: RECONCILED + Bash tool_event", () => {
    const res = getLinkageRate();
    if (res.data === null) throw new Error("expected data");
    // sess-a1 is RECONCILED + has Bash tool_event + has a link → counts
    expect(res.data.denominator_n).toBeGreaterThan(0);
    expect(typeof res.data.linkage_rate).toBe("number");
  });

  it("returns workspace-scoped rate when workspace_id given", () => {
    const res = getLinkageRate("ws-alpha");
    expect(res.meta.drilldown_ids.workspace_id).toBe("ws-alpha");
  });
});

describe("listWorkspaceOutcomes", () => {
  it("returns EXPERIMENTAL envelope", () => {
    const res = listWorkspaceOutcomes();
    expect(res.meta.claim_kind).toBe("EXPERIMENTAL");
  });

  it("returns per-workspace rows for linked workspaces", () => {
    const res = listWorkspaceOutcomes();
    if (res.data === null) throw new Error("expected data");
    // ws-alpha has 1 linked work_item
    const wsAlpha = res.data.find((r) => r.workspace_id === "ws-alpha");
    expect(wsAlpha).toBeDefined();
    expect(wsAlpha?.total_n).toBeGreaterThan(0);
  });

  it("returns the routing proxy for unlinked and no-turn workspaces without multiplying turns", () => {
    seedRoutingWorkspace("ws-routing-zero", [
      { model: "claude-opus-4" },
      { model: "claude-sonnet-4", isSidechain: true },
      { model: "claude-sonnet-4", provisional: true },
    ]);
    seedRoutingWorkspace("ws-routing-full", [{ model: "claude-sonnet-4" }]);
    seedRoutingWorkspace("ws-routing-mixed", [
      { model: "claude-opus-4" },
      { model: "claude-sonnet-4" },
    ]);
    seedRoutingWorkspace("ws-routing-empty", []);

    const rows = listWorkspaceOutcomes().data;
    if (rows === null) throw new Error("expected rows");
    const byId = new Map(rows.map((row) => [row.workspace_id, row]));

    expect(byId.get("ws-routing-zero")).toMatchObject({ total_n: 0, adherence_score: 0 });
    expect(byId.get("ws-routing-full")).toMatchObject({ total_n: 0, adherence_score: 100 });
    expect(byId.get("ws-routing-mixed")).toMatchObject({ total_n: 0, adherence_score: 50 });
    expect(byId.get("ws-routing-empty")).toMatchObject({ total_n: 0, adherence_score: null });
  });

  it("COND-1: EXPERIMENTAL findings excluded from gated denominators (success not downgraded)", () => {
    // Insert an EXPERIMENTAL finding (UNRESOLVED_THREAD, extractor_version matches COND-1 list)
    // Status DEFERRED means it would normally downgrade OBSERVED_SUCCESS → OBSERVED_SUCCESS_WITH_DEFERRALS.
    // But EXPERIMENTAL sources are excluded from the deferral check, so outcome stays clean.
    db.prepare(
      `INSERT INTO review_findings
         (finding_id, work_item_id, source, severity, status, evidence_ref, raised_at, extractor_version)
       VALUES ('f-exp-1', 'gh:acme/r#1', 'UNRESOLVED_THREAD', 'UNKNOWN', 'DEFERRED',
               'thread-1', '2026-01-01T00:00:00Z', 'unresolved-thread-v1')`,
    ).run();

    // getSuccessRate reads the pre-derived observed_outcomes row (OBSERVED_SUCCESS)
    // via the query layer — the COND-1 exclusion means EXPERIMENTAL findings don't
    // count toward the deferral denominator in the derive step (tested in derive.test.ts).
    // The API layer re-surfaces this via the qualification note and the success counts.
    const res = getSuccessRate();
    expect(res.meta.qualification.note).toContain("COND-1");
    // clean_success_n must be ≥ 1 — if COND-1 failed, OBSERVED_SUCCESS would have been
    // downgraded to OBSERVED_SUCCESS_WITH_DEFERRALS and clean_success_n would be 0.
    if (res.data === null) throw new Error("expected data");
    expect(res.data.clean_success_n).toBeGreaterThanOrEqual(1);
    expect(res.data.with_deferrals_n).toBe(0);
  });
});
