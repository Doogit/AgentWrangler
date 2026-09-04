/**
 * test/query/self-churn.test.ts — self-churn query (L2b).
 *
 * The session_churn table comes from migration 014 (createInMemoryFixtureDb runs
 * all migrations); the suite seeds rows into it directly.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSelfChurn } from "../../src/query/api/self-churn.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2027-06-01T00:00:00.000Z";
const TO = "2027-07-01T00:00:00.000Z";
const TS_IN = "2027-06-15T12:00:00.000Z";

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

function insSession(sessionId: string, workspaceId: string, ts = TS_IN): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',1,0,'[]')`,
  ).run(sessionId, workspaceId, "private.jsonl", ts, ts);
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
        cache_write_1h, cache_write_other, tool_result_bytes,
        pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?,?,?,?,'claude-sonnet',0,100,10,0,0,0,0,NULL,NULL,0,'LIST_EQUIV',0,'test-v1')`,
  ).run(`msg-${sessionId}`, sessionId, workspaceId, ts);
}

function insChurn(
  sessionId: string,
  status: "MEASURED" | "PARTIAL" | "NO_REPO",
  authoredLines: number,
  churnedLines: number,
  commitShas: string[],
): void {
  db.prepare(
    `INSERT INTO session_churn
       (session_id, status, window_days, authored_lines, churned_lines, churn_ratio,
        commit_count, commit_shas, measured_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    sessionId,
    status,
    14,
    authoredLines,
    churnedLines,
    authoredLines === 0 ? null : churnedLines / authoredLines,
    commitShas.length,
    JSON.stringify(commitShas),
    TO,
  );
}

describe("getSelfChurn", () => {
  it("aggregates in-window sessions globally and unions measured commit SHAs", () => {
    insWs("ws-a");
    insWs("ws-b");
    insSession("session-a", "ws-a");
    insSession("session-b", "ws-b");
    insSession("session-no-repo", "ws-b");
    insChurn("session-a", "MEASURED", 100, 25, ["sha-a", "shared-sha"]);
    insChurn("session-b", "PARTIAL", 50, 10, ["shared-sha", "sha-b"]);
    insChurn("session-no-repo", "NO_REPO", 0, 0, []);

    const response = getSelfChurn(db, { workspaceId: null, from: FROM, to: TO });
    const data = response.data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 3,
      measured_session_count: 2,
      authored_lines_total: 150,
      churned_lines_total: 35,
      churn_ratio: 35 / 150,
      commit_shas: ["sha-a", "sha-b", "shared-sha"],
      from: FROM,
      to: TO,
      workspace_id: null,
    });
    expect(response.meta.claim_kind).toBe("OBS_PROXY");
    expect(response.meta.n).toBe(2);
    expect(response.meta.qualification.note).toBe(
      "14-day self-churn of session-authored commits (structural proxy).",
    );
  });

  it("counts in-window sessions with no churn row yet (LEFT JOIN) without inflating measured", () => {
    insWs("ws-a");
    insSession("session-measured", "ws-a");
    insSession("session-uncollected", "ws-a"); // in-window turn, but collector hasn't run for it
    insChurn("session-measured", "MEASURED", 40, 10, ["sha-m"]);

    const data = getSelfChurn(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 2,
      measured_session_count: 1,
      authored_lines_total: 40,
      churned_lines_total: 10,
      churn_ratio: 0.25,
      commit_shas: ["sha-m"],
    });
  });

  it("isolates sessions in the selected workspace", () => {
    insWs("ws-a");
    insWs("ws-b");
    insSession("session-a", "ws-a");
    insSession("session-b", "ws-b");
    insChurn("session-a", "MEASURED", 80, 20, ["sha-a"]);
    insChurn("session-b", "MEASURED", 40, 20, ["sha-b"]);

    const data = getSelfChurn(db, { workspaceId: "ws-a", from: FROM, to: TO }).data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 1,
      measured_session_count: 1,
      authored_lines_total: 80,
      churned_lines_total: 20,
      churn_ratio: 0.25,
      commit_shas: ["sha-a"],
      workspace_id: "ws-a",
    });
  });

  it("excludes sessions whose turns fall outside the half-open window", () => {
    insWs("ws-window");
    insSession("session-in", "ws-window", TS_IN);
    insSession("session-before", "ws-window", "2027-05-31T23:59:59.999Z");
    insSession("session-at-to", "ws-window", TO);
    insChurn("session-in", "MEASURED", 20, 5, ["sha-in"]);
    insChurn("session-before", "MEASURED", 100, 100, ["sha-before"]);
    insChurn("session-at-to", "MEASURED", 100, 100, ["sha-at-to"]);

    const data = getSelfChurn(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 1,
      measured_session_count: 1,
      authored_lines_total: 20,
      churned_lines_total: 5,
      churn_ratio: 0.25,
      commit_shas: ["sha-in"],
    });
  });

  it("returns zero metrics, null ratio, and no SHAs with no in-window sessions", () => {
    const response = getSelfChurn(db, { workspaceId: null, from: FROM, to: TO });
    const data = response.data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 0,
      measured_session_count: 0,
      authored_lines_total: 0,
      churned_lines_total: 0,
      churn_ratio: null,
      commit_shas: [],
      from: FROM,
      to: TO,
      workspace_id: null,
    });
    expect(response.meta.claim_kind).toBe("OBS_PROXY");
    expect(response.meta.n).toBe(0);
    expect(response.meta.qualification.note).toBe(
      "14-day self-churn of session-authored commits (structural proxy).",
    );
  });
});
