import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getEsfObservations,
  getSessionEsfObservations,
} from "../../src/query/api/esf-observations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2026-08-01T00:00:00.000Z";
const TO = "2026-08-15T00:00:00.000Z";
const IN = "2026-08-05T12:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

function workspace(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  ).run(id, id, FROM);
}

function session(
  id: string,
  workspaceId: string,
  state: "LIVE" | "RECONCILED" = "RECONCILED",
): void {
  workspace(workspaceId);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,?,1,0,'[]')`,
  ).run(id, workspaceId, "private.jsonl", IN, IN, state);
}

function turn(
  id: string,
  sessionId: string,
  workspaceId: string,
  cost: number | null,
  ts = IN,
  provisional = 0,
  parser = "parser-a",
  claim = "LIST_EQUIV",
): void {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
       input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
       cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
       provisional, parser_version)
     VALUES (?,?,?,?,'test',0,0,0,0,0,0,0,NULL,NULL,?,?,?,?)`,
  ).run(id, sessionId, workspaceId, ts, cost, claim, provisional, parser);
}

function tool(
  id: string,
  sessionId: string,
  ts = IN,
  exitClass: string | null = null,
  test = false,
  resultBytes: number | null = null,
  sha: string | null = null,
): void {
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes, exit_class, commit_sha)
     VALUES (?,?,?,'Bash',?,?,?)`,
  ).run(id, sessionId, ts, resultBytes, exitClass, sha);
  if (test) {
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, block_index, is_test_command) VALUES (?,?,1)",
    ).run(id, 0);
  }
}

function cohort() {
  const response = getEsfObservations(db, { workspaceId: "ws-alpha", from: FROM, to: TO });
  if (response.data === null) throw new Error("expected cohort");
  return response.data;
}

describe("getEsfObservations", () => {
  it("reads the complete session cohort without pagination, provisional cost or sibling leakage", () => {
    session("session-complete", "ws-complete");
    session("session-sibling", "ws-complete");
    for (let i = 0; i < 205; i++)
      turn(`complete-${i}`, "session-complete", "ws-complete", i < 202 ? 10 : null);
    turn("provisional", "session-complete", "ws-complete", null, IN, 1);
    turn("sibling", "session-sibling", "ws-complete", null);
    tool("fail-one", "session-complete", IN, "TEST_FAIL", true, 1);
    tool("fail-two", "session-complete", IN, "TEST_FAIL", true, 1);
    tool("pass-last", "session-complete", "2026-08-05T12:01:00.000Z", "OK", true, 1);
    const response = getSessionEsfObservations(db, "session-complete");
    expect(response.data?.resource).toMatchObject({
      selected_session_count: 1,
      priced_cost_u: 2020,
      priced_turn_count: 202,
      unpriced_turn_count: 3,
    });
    expect(response.data?.observed_test_recovery.recovered_session_ids).toEqual([
      "session-complete",
    ]);
    expect(response.meta).toMatchObject({
      claim_kind: "OBS_PROXY",
      metric_definition_version: "esf-1",
      drilldown_ids: { session_id: "session-complete" },
      qualification: { unpriced_turns: 3, provisional_excluded: true },
      window: { from: IN, to: "2026-08-05T12:01:00.001Z" },
    });
  });

  it("keeps missing sessions distinct from existing empty and LIVE sessions", () => {
    expect(getSessionEsfObservations(db, "missing")).toMatchObject({
      data: null,
      meta: { n: 0, claim_kind: "N_A" },
    });
    session("empty", "ws-empty");
    expect(getSessionEsfObservations(db, "empty").data?.resource.selected_session_count).toBe(0);
    session("live", "ws-empty", "LIVE");
    turn("live-priced", "live", "ws-empty", 50);
    turn("live-unknown", "live", "ws-empty", null);
    tool("live-tool", "live");
    const live = getSessionEsfObservations(db, "live").data;
    if (live === null) throw new Error("Expected live cohort");
    expect(live.resource).toMatchObject({
      priced_cost_u: 50,
      unpriced_turn_count: 1,
      live_priced_session_count: 1,
    });
    expect(live.no_commit_activity).toMatchObject({
      session_ids: [],
      live_session_excluded_count: 1,
    });
  });

  it("keeps FX-RECOVER-18 resource accounting exact while excluding LIVE from activity", () => {
    for (let n = 1; n <= 18; n++) {
      const id = `ses-a${String(n).padStart(2, "0")}`;
      session(id, "ws-alpha");
      turn(
        `turn-${id}`,
        id,
        "ws-alpha",
        n <= 15 ? 50_000 : n === 16 ? 80_000 : null,
        IN,
        0,
        n === 16 ? "parser-b" : "parser-a",
        n === 16 ? "BILLED" : "LIST_EQUIV",
      );
      tool(`tool-${id}`, id);
    }
    for (let n = 1; n <= 3; n++) {
      const id = `ses-al0${n}`;
      session(id, "ws-alpha", "LIVE");
      turn(`turn-${id}`, id, "ws-alpha", 10_000);
      tool(`tool-${id}`, id);
    }
    // Each affected session has two completed failures. a01..a03 recover; a03
    // fails again after the pass and remains an observed recovery sequence.
    for (let n = 1; n <= 6; n++) {
      const id = `ses-a${String(n).padStart(2, "0")}`;
      tool(`fail-1-${id}`, id, "2026-08-06T10:00:00.000Z", "TEST_FAIL", true, 1);
      tool(`fail-2-${id}`, id, "2026-08-06T11:00:00.000Z", "TEST_FAIL", true, 1);
      if (n <= 3) tool(`pass-${id}`, id, "2026-08-06T12:00:00.000Z", "OK", true, 1);
    }
    tool("refail-a03", "ses-a03", "2026-08-06T13:00:00.000Z", "TEST_FAIL", true, 1);

    const data = cohort();
    expect(data.resource).toMatchObject({
      selected_session_count: 21,
      priced_cost_u: 860_000,
      priced_turn_count: 19,
      unpriced_turn_count: 2,
      unpriced_session_count: 2,
      reconciled_priced_session_count: 16,
      live_priced_session_count: 3,
    });
    expect(data.no_commit_activity).toMatchObject({
      session_count: 18,
      live_session_excluded_count: 3,
    });
    expect(data.no_commit_activity.session_ids).not.toContain("ses-al01");
    expect(data.observed_test_recovery).toMatchObject({
      affected_session_ids: ["ses-a01", "ses-a02", "ses-a03", "ses-a04", "ses-a05", "ses-a06"],
      recovered_session_ids: ["ses-a01", "ses-a02", "ses-a03"],
      eligible_reconciled_qualifying_tool_session_count: 18,
    });
    expect(data.allocation_sessions).toHaveLength(18);
    expect(data.allocation_sessions.reduce((sum, row) => sum + row.priced_cost_u, 0)).toBe(830_000);
    expect(data.allocation_sessions.find((row) => row.session_id === "ses-a16")).toMatchObject({
      priced_cost_u: 80_000,
      cost_claim_counts: [{ value: "BILLED", count: 1 }],
      parser_version_counts: [{ value: "parser-b", count: 1 }],
    });
  });

  it("deduplicates sessions, respects [from,to), excludes no-tool research, and scopes workspace", () => {
    session("dup", "ws-alpha");
    turn("dup-a", "dup", "ws-alpha", 100);
    turn("dup-b", "dup", "ws-alpha", 200, "2026-08-06T00:00:00.000Z", 0, "parser-b");
    tool("dup-tool", "dup");
    session("research", "ws-alpha");
    turn("research-turn", "research", "ws-alpha", 10);
    session("at-to", "ws-alpha");
    turn("at-to-turn", "at-to", "ws-alpha", 999, TO);
    session("other", "ws-other");
    turn("other-turn", "other", "ws-other", 777);
    // A pass tied to a failure is not recovery, and incomplete test metadata is ignored.
    tool("tie-fail-1", "dup", "2026-08-07T10:00:00.000Z", "TEST_FAIL", true, 1);
    tool("tie-fail-2", "dup", "2026-08-07T10:00:00.000Z", "TEST_FAIL", true, 1);
    tool("tie-pass", "dup", "2026-08-07T10:00:00.000Z", "OK", true, 1);
    tool("incomplete", "dup", "2026-08-07T11:00:00.000Z", "TEST_FAIL", true, null);

    const data = cohort();
    expect(data.resource).toMatchObject({
      selected_session_count: 2,
      priced_cost_u: 310,
      priced_turn_count: 3,
    });
    expect(data.no_commit_activity.session_ids).toEqual(["dup"]);
    expect(data.allocation_sessions).toHaveLength(2);
    expect(data.allocation_sessions.find((row) => row.session_id === "dup")).toMatchObject({
      priced_cost_u: 300,
      priced_turn_count: 2,
      parser_version_counts: [
        { value: "parser-a", count: 1 },
        { value: "parser-b", count: 1 },
      ],
    });
    expect(data.observed_test_recovery).toMatchObject({
      affected_session_ids: ["dup"],
      recovered_session_ids: [],
      eligible_reconciled_qualifying_tool_session_count: 1,
    });
    expect(data.watermark).toMatchObject({ selected_session_count: 2, selected_turn_count: 3 });
    expect(cohort().watermark.source_fingerprint).toBe(data.watermark.source_fingerprint);

    db.prepare("UPDATE sessions SET state = 'LIVE' WHERE session_id = 'dup'").run();
    const stateChanged = cohort();
    expect(stateChanged.watermark.source_fingerprint).not.toBe(data.watermark.source_fingerprint);
    expect(stateChanged.allocation_sessions.map((row) => row.session_id)).toEqual(["research"]);

    db.prepare("UPDATE sessions SET state = 'RECONCILED' WHERE session_id = 'dup'").run();
    db.prepare("UPDATE turns SET cost_equiv_u = 201 WHERE message_id = 'dup-b'").run();
    const costChanged = cohort();
    expect(costChanged.watermark.source_fingerprint).not.toBe(data.watermark.source_fingerprint);
    expect(costChanged.resource.priced_cost_u).toBe(311);
  });
});
