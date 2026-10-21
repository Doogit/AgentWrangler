import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  c3Detector,
  c3FindingDescriptor,
} from "../../../src/detector/detectors/c3_edit_before_read.js";
import { buildContext } from "../../../src/detector/engine.js";
import { findingIds, serializeModeledFormulaV2 } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.exec(`
    INSERT INTO workspaces (workspace_id, project_slug, registered_at)
    VALUES ('ws-c3', 'ws-c3', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('session-c3', 'ws-c3', '/fixture/c3.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
  `);
});

afterEach(() => db.close());

/** `sidechain`: 0 main chain; 1 a subagent turn; 2 a sidechain turn with no agent id (never counted). */
function addEvent(
  tool: string,
  errorClass: string | null,
  sidechain = 0,
  costEquivU = 100,
  session = "session-c3",
): void {
  const suffix = sequence++;
  const eventId = `c3-event-${suffix}`;
  const messageId = `c3-message-${suffix}`;
  const ts = `2027-01-02T00:00:0${suffix}.000Z`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, 'ws-c3', ?, 'claude-sonnet', ?, ?, 0, 0, 0, 0, 0, 0, ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(
    messageId,
    session,
    ts,
    sidechain === 0 ? 0 : 1,
    sidechain === 1 ? "agent-a" : null,
    costEquivU,
  );
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, exit_class, tool_error_class, tool_error_classifier_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    session,
    ts,
    tool,
    errorClass === null ? "OK" : "ERROR",
    errorClass,
    errorClass === null ? null : "tool-error-1",
  );
  db.prepare(
    "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, 0, 0)",
  ).run(eventId, messageId);
}

describe("C3 EDIT_BEFORE_READ V2", () => {
  it("emits one workspace finding for Edit and Write NOT_READ errors, subagents included", () => {
    addEvent("Edit", "NOT_READ");
    addEvent("Edit", "NOT_READ");
    addEvent("Read", "NOT_READ");
    addEvent("Edit", "NOT_FOUND");
    addEvent("Edit", "NOT_READ", 1);
    addEvent("Write", "NOT_READ", 1);
    addEvent("Write", "NOT_READ", 2);

    const outcome = c3Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c3Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    // U7: Write and subagent calls count (2 main Edits + 1 subagent Edit + 1 subagent Write);
    // a sidechain row with no agent id does not.
    expect(outcome.fired[0]?.payload.metrics).toEqual({
      ERROR_COUNT: { kind: "COUNT", value: 4 },
      WRITE_ERROR_COUNT: { kind: "COUNT", value: 1 },
      SUBAGENT_ERROR_COUNT: { kind: "COUNT", value: 2 },
      SUBAGENT_WRITE_ERROR_COUNT: { kind: "COUNT", value: 1 },
      SESSION_COUNT: { kind: "COUNT", value: 1 },
    });
    expect(outcome.fired[0]?.payload.routing.tier).toBe("T3");
    expect(outcome.fired[0]?.payload.session_ids).toEqual(["session-c3"]);
    expect(
      db
        .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .get(outcome.fired[0]?.payload.session_ids?.[0]),
    ).toBeDefined();
    // 4 distinct C3-claimed turns × 100 µUSD/turn × 0.5 = 200 µUSD/week.
    expect(
      JSON.parse(serializeModeledFormulaV2(outcome.fired[0]?.payload, c3FindingDescriptor))
        .estimate,
    ).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 200,
    });
    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBe(200);
  });

  it("fires one card per workspace, not one per session", () => {
    db.exec(`
      INSERT INTO sessions
        (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
      VALUES ('session-c3-b', 'ws-c3', '/fixture/c3b.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]'),
             ('session-c3-c', 'ws-c3', '/fixture/c3c.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
    `);
    addEvent("Edit", "NOT_READ", 0, 100, "session-c3");
    addEvent("Edit", "NOT_READ", 1, 100, "session-c3-b");
    addEvent("Write", "NOT_READ", 1, 100, "session-c3-c");

    const outcome = c3Detector.evaluate(db, CTX);

    expect(outcome.fired.map((finding) => finding.scopeKey)).toEqual(["C3|ws-c3"]);
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      ERROR_COUNT: { kind: "COUNT", value: 3 },
      SESSION_COUNT: { kind: "COUNT", value: 3 },
    });
    expect(outcome.fired[0]?.payload.session_ids).toEqual([
      "session-c3",
      "session-c3-b",
      "session-c3-c",
    ]);
  });

  it("stays inactive without qualifying classifier evidence", () => {
    addEvent("Edit", null);
    addEvent("Read", "NOT_READ");

    expect(c3Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("keeps the five newest anchors when more than five errors qualify", () => {
    for (let index = 0; index < 7; index++) addEvent("Edit", "NOT_READ");

    expect(c3Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c3"),
        timestamp: `2027-01-02T00:00:0${index}.000Z`,
        event_id: findingIds.event(`c3-event-${index}`),
      })),
    );
  });
});
