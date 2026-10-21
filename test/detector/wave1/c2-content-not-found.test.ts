import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  c2Detector,
  c2FindingDescriptor,
} from "../../../src/detector/detectors/c2_content_not_found.js";
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
    VALUES ('ws-c2', 'ws-c2', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('session-c2', 'ws-c2', '/fixture/c2.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
  `);
});

afterEach(() => db.close());

function addEvent(
  tool: string,
  errorClass: string | null,
  sidechain = 0,
  costEquivU = 100,
  session = "session-c2",
): void {
  const suffix = sequence++;
  const eventId = `c2-event-${suffix}`;
  const messageId = `c2-message-${suffix}`;
  const ts = `2027-01-02T00:00:0${suffix}.000Z`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, (SELECT workspace_id FROM sessions WHERE session_id = ?), ?, 'claude-sonnet', ?, 0, 0, 0, 0, 0, 0, ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, session, session, ts, sidechain === 0 ? 0 : 1, costEquivU);
  // 1 = a subagent turn; 2 = a sidechain turn with no agent id (never priced, never counted).
  if (sidechain === 1) {
    db.prepare("UPDATE turns SET agent_id = 'agent-a' WHERE message_id = ?").run(messageId);
  }
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

describe("C2 CONTENT_NOT_FOUND V2", () => {
  it("emits grouped closed-label findings for Read/Grep/Glob not-found errors", () => {
    addEvent("Read", "NOT_FOUND");
    addEvent("Read", "NOT_FOUND");
    addEvent("Glob", "NOT_FOUND");
    addEvent("Edit", "NOT_FOUND");
    addEvent("Grep", "NOT_READ");
    addEvent("Grep", "NOT_FOUND", 1);
    addEvent("Grep", "NOT_FOUND", 2);

    const outcome = c2Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c2Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.scopeKey).toBe("C2|ws-c2");
    // U7: the subagent lookup counts (3 main-chain + 1 subagent); the agent-less sidechain row does not.
    expect(outcome.fired[0]?.payload.metrics).toEqual({
      ERROR_COUNT: { kind: "COUNT", value: 4 },
      SESSION_COUNT: { kind: "COUNT", value: 1 },
    });
    expect(outcome.fired[0]?.payload.routing.tier).toBe("T3");
    expect(outcome.fired[0]?.payload.session_ids).toEqual(["session-c2"]);
    // 4 distinct C2 claims (one is a subagent turn) × 100 × 0.5 = 200.
    expect(
      JSON.parse(
        serializeModeledFormulaV2(
          outcome.fired[0]?.payload as Parameters<typeof serializeModeledFormulaV2>[0],
          c2FindingDescriptor,
        ),
      ).estimate,
    ).toMatchObject({ basis: "E", rank_value_u_per_wk: 200 });
    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBe(200);
    expect(JSON.stringify(outcome.fired)).not.toContain("Edit");
  });

  it("fires one finding per workspace across sessions and tools", () => {
    db.exec(`
      INSERT INTO sessions
        (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
      VALUES ('session-c2-b', 'ws-c2', '/fixture/c2b.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
      INSERT INTO workspaces (workspace_id, project_slug, registered_at)
      VALUES ('ws-other', 'ws-other', '${CTX.fromIso}');
      INSERT INTO sessions
        (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
      VALUES ('session-other', 'ws-other', '/fixture/other.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
    `);
    addEvent("Read", "NOT_FOUND");
    addEvent("Grep", "NOT_FOUND", 0, 100, "session-c2-b");
    addEvent("Glob", "NOT_FOUND", 0, 100, "session-c2-b");
    addEvent("Read", "NOT_FOUND", 0, 100, "session-other");

    const outcome = c2Detector.evaluate(db, CTX);

    expect(outcome.fired.map((finding) => finding.scopeKey)).toEqual(["C2|ws-c2", "C2|ws-other"]);
    expect(outcome.fired[0]?.payload.metrics).toEqual({
      ERROR_COUNT: { kind: "COUNT", value: 3 },
      SESSION_COUNT: { kind: "COUNT", value: 2 },
    });
    expect(outcome.fired[0]?.payload.session_ids).toEqual(["session-c2", "session-c2-b"]);
    expect(outcome.fired[1]?.payload.metrics).toEqual({
      ERROR_COUNT: { kind: "COUNT", value: 1 },
      SESSION_COUNT: { kind: "COUNT", value: 1 },
    });
  });

  it("fires on a single lookup in a subagent", () => {
    addEvent("Read", "NOT_FOUND", 1, 100, "session-c2");

    const outcome = c2Detector.evaluate(db, CTX);

    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      ERROR_COUNT: { kind: "COUNT", value: 1 },
    });
  });

  // RC-B (operator 2026-10-14): the emit-time 0.1% floor is gone; the recs view's de-minimis
  // floor routes small cards to below_floor instead of the detector hiding them.
  it("RC-B: still fires when the lookups cost under 0.1% of the workspace's week", () => {
    // 2 lookups at 100 u against ~1,000,000 u of other spend in the same workspace: 0.02%.
    addEvent("Read", "NOT_FOUND");
    addEvent("Read", "NOT_FOUND");
    addEvent("Read", null, 0, 1_000_000);

    const outcome = c2Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBeLessThan(1000);
  });

  it("stays inactive without qualifying main-chain classifier evidence", () => {
    addEvent("Read", null);
    addEvent("Edit", "NOT_FOUND");

    expect(c2Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("keeps the five newest anchors when more than five errors qualify", () => {
    for (let index = 0; index < 7; index++) addEvent("Read", "NOT_FOUND");

    expect(c2Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c2"),
        timestamp: `2027-01-02T00:00:0${index}.000Z`,
        event_id: findingIds.event(`c2-event-${index}`),
      })),
    );
  });
});
