import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c11Detector } from "../../../src/detector/detectors/c11_mcp_output_cap.js";
import { buildContext } from "../../../src/detector/engine.js";
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
    VALUES ('ws-c11', 'ws-c11', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES
      ('session-c11-a', 'ws-c11', '/fixture/c11-a.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]'),
      ('session-c11-b', 'ws-c11', '/fixture/c11-b.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]'),
      ('session-c11-live', 'ws-c11', '/fixture/c11-live.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'LIVE', 0, 0, '[]');
  `);
});

afterEach(() => db.close());

function addEvent(
  sessionId: string,
  errorClass: string | null,
  options: { sidechain?: number; provisional?: number } = {},
): void {
  const suffix = sequence++;
  const eventId = `c11-event-${suffix}`;
  const messageId = `c11-message-${suffix}`;
  const ts = `2027-01-02T00:00:${String(suffix).padStart(2, "0")}.000Z`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, 'ws-c11', ?, 'claude-sonnet', ?, 0, 0, 0, 0, 0, 0, 0,
             'LIST_EQUIV', ?, 'test-v1')`,
  ).run(messageId, sessionId, ts, options.sidechain ?? 0, options.provisional ?? 0);
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, exit_class, tool_error_class, tool_error_classifier_version)
     VALUES (?, ?, ?, 'PrivateMcpTool', ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    ts,
    errorClass === null ? "OK" : "ERROR",
    errorClass,
    errorClass === null ? null : "tool-error-1",
  );
  db.prepare(
    "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, 0, 0)",
  ).run(eventId, messageId);
}

describe("C11 MCP_OUTPUT_CAP V2", () => {
  it("emits one bounded, per-session finding with the classified error count", () => {
    for (let index = 0; index < 6; index++) addEvent("session-c11-a", "MCP_CONTENT_TOO_LARGE");
    addEvent("session-c11-b", "MCP_CONTENT_TOO_LARGE");

    const outcome = c11Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c11Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(2);
    expect(outcome.fired.map((finding) => finding.payload.metrics)).toEqual([
      { ERROR_COUNT: { kind: "COUNT", value: 6 } },
      { ERROR_COUNT: { kind: "COUNT", value: 1 } },
    ]);
    expect(outcome.fired[0]?.payload).toMatchObject({
      version: 2,
      rule_id: "C11_MCP_OUTPUT_CAP",
      label: "MCP_OUTPUT_CAP",
      routing: { tier: "T3" },
    });
    expect(outcome.fired[0]?.payload.anchors).toHaveLength(5);
    expect(JSON.stringify(outcome.fired)).not.toContain("PrivateMcpTool");
  });

  it("uses the five newest anchors in deterministic chronological order", () => {
    for (let index = 0; index < 7; index++) addEvent("session-c11-a", "MCP_CONTENT_TOO_LARGE");

    const outcome = c11Detector.evaluate(db, CTX);

    // The selected final five are emitted oldest-to-newest because the detector's
    // timestamp/event-ID ordering is stable and privacy-safe.
    expect(outcome.fired[0]?.payload.anchors.map((anchor) => anchor.timestamp)).toEqual([
      "2027-01-02T00:00:02.000Z",
      "2027-01-02T00:00:03.000Z",
      "2027-01-02T00:00:04.000Z",
      "2027-01-02T00:00:05.000Z",
      "2027-01-02T00:00:06.000Z",
    ]);
  });

  it("fails closed for other labels, unclassified rows, sidechains, provisional turns, and live sessions", () => {
    addEvent("session-c11-a", "NOT_FOUND");
    addEvent("session-c11-a", null);
    addEvent("session-c11-a", "MCP_CONTENT_TOO_LARGE", { sidechain: 1 });
    addEvent("session-c11-a", "MCP_CONTENT_TOO_LARGE", { provisional: 1 });
    addEvent("session-c11-live", "MCP_CONTENT_TOO_LARGE");

    expect(c11Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("U7: fires on Read over-cap errors and counts them separately from MCP ones", () => {
    addEvent("session-c11-a", "READ_OUTPUT_TOO_LARGE");
    addEvent("session-c11-a", "READ_OUTPUT_TOO_LARGE");
    addEvent("session-c11-b", "READ_OUTPUT_TOO_LARGE");
    addEvent("session-c11-b", "MCP_CONTENT_TOO_LARGE");

    const outcome = c11Detector.evaluate(db, CTX);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired.map((finding) => finding.payload.metrics)).toEqual([
      { ERROR_COUNT: { kind: "COUNT", value: 0 }, READ_ERROR_COUNT: { kind: "COUNT", value: 2 } },
      { ERROR_COUNT: { kind: "COUNT", value: 1 }, READ_ERROR_COUNT: { kind: "COUNT", value: 1 } },
    ]);
  });

  it("stays inactive without qualifying rows", () => {
    addEvent("session-c11-a", "NOT_FOUND");

    expect(c11Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("emits session_ids and an X-basis unranked estimate", () => {
    addEvent("session-c11-a", "MCP_CONTENT_TOO_LARGE");

    const outcome = c11Detector.evaluate(db, CTX);
    const payload = outcome.fired[0]?.payload;

    expect(payload?.session_ids).toEqual(["session-c11-a"]);
    // c11Estimate({}) = unranked: X-basis, MCP output cap is not priced
    expect(payload?.estimate).toMatchObject({
      basis: "X",
      rank_value_u_per_wk: null,
      summable: false,
    });
  });
});
