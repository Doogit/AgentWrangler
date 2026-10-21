import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  C4_MIN_CONSECUTIVE_FAILURES,
  c4Detector,
  c4FindingDescriptor,
} from "../../../src/detector/detectors/c4_failed_edit_recovery.js";
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
    VALUES ('ws-c4', 'ws-c4', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES ('session-c4', 'ws-c4', '/fixture/c4.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]');
  `);
});

afterEach(() => db.close());

function addEdit(
  filePathHash: string,
  errorClass: "STALE_STRING" | "PATCH_FAILED" | "MULTI_MATCH" | "NOT_READ" | null,
  options: {
    sidechain?: number;
    provisional?: number;
    costEquivU?: number;
    agentId?: string;
    errorText?: string;
  } = {},
): void {
  const suffix = sequence++;
  const eventId = `c4-event-${suffix}`;
  const messageId = `c4-message-${suffix}`;
  const ts = `2027-01-02T00:00:${String(suffix).padStart(2, "0")}.000Z`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version, agent_id)
     VALUES (?, 'session-c4', 'ws-c4', ?, 'claude-sonnet', ?, 0, 0, 0, 0, 0, 0, ?,
             'LIST_EQUIV', ?, 'test-v1', ?)`,
  ).run(
    messageId,
    ts,
    options.sidechain ?? 0,
    options.costEquivU ?? 100,
    options.provisional ?? 0,
    options.agentId ?? null,
  );
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, exit_class, tool_error_class, tool_error_classifier_version)
     VALUES (?, 'session-c4', ?, 'Edit', ?, ?, ?)`,
  ).run(
    eventId,
    ts,
    errorClass === null ? "OK" : "ERROR",
    errorClass,
    errorClass === null ? null : "tool-error-1",
  );
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(eventId, filePathHash, messageId, suffix);
  if (options.errorText !== undefined) {
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      eventId,
      JSON.stringify({ error: options.errorText }),
    );
  }
}

describe("C4 FAILED_EDIT_RECOVERY_LOOP V2", () => {
  it("emits a contract-conformant finding at three consecutive failed edits", () => {
    for (let index = 0; index < C4_MIN_CONSECUTIVE_FAILURES; index++) {
      addEdit("opaque-file-a", index % 2 === 0 ? "STALE_STRING" : "PATCH_FAILED");
    }

    const outcome = c4Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c4Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload).toMatchObject({
      version: 2,
      rule_id: "C4_FAILED_EDIT_RECOVERY_LOOP",
      label: "FAILED_EDIT_RECOVERY_LOOP",
      routing: { tier: "T3" },
      metrics: {
        RECOVERY_LOOP_COUNT: { kind: "COUNT", value: 1 },
        FAILED_EDIT_COUNT: { kind: "COUNT", value: C4_MIN_CONSECUTIVE_FAILURES },
        AFFECTED_FILE_COUNT: { kind: "COUNT", value: 1 },
      },
    });
    expect(C4_MIN_CONSECUTIVE_FAILURES).toBe(3);
    expect(outcome.fired[0]?.payload.anchors).toHaveLength(C4_MIN_CONSECUTIVE_FAILURES);
    expect(outcome.fired[0]?.payload.session_ids).toEqual(["session-c4"]);
    expect(
      db
        .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .get(outcome.fired[0]?.payload.session_ids?.[0]),
    ).toBeDefined();
    // D7 owns turns two through five of the consecutive error run. The first
    // remaining C4 claim is 1 × 100 µUSD/turn × 0.5 = 50 µUSD/week.
    expect(
      JSON.parse(serializeModeledFormulaV2(outcome.fired[0]?.payload, c4FindingDescriptor))
        .estimate,
    ).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 50,
    });
    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBe(50);
    expect(JSON.stringify(outcome.fired[0]?.payload)).not.toContain("opaque-file-a");
  });

  it("resets a run on success and never combines different file identities", () => {
    // Runs of two (below the 3-failure minimum): a success resets, files never combine.
    for (let index = 0; index < 2; index++) addEdit("opaque-file-a", "PATCH_FAILED");
    addEdit("opaque-file-a", null);
    for (let index = 0; index < 2; index++) addEdit("opaque-file-a", "STALE_STRING");
    for (let index = 0; index < 2; index++) addEdit("opaque-file-b", "PATCH_FAILED");

    expect(c4Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("U7: counts any failed Edit (not only stale-string and patch labels) and skips provisional turns", () => {
    addEdit("opaque-file-a", "MULTI_MATCH");
    addEdit("opaque-file-a", "MULTI_MATCH");
    addEdit("opaque-file-a", "PATCH_FAILED", { provisional: 1 });
    expect(c4Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });

    addEdit("opaque-file-a", "MULTI_MATCH");
    expect(c4Detector.evaluate(db, CTX).fired).toHaveLength(1);
  });

  it("U9: a not-read Edit is C3's, so a run of them is no recovery loop", () => {
    for (let index = 0; index < 4; index++) addEdit("opaque-file-a", "NOT_READ");
    expect(c4Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });

    // Not-read edits neither join nor split a run of real stale-string failures.
    for (let index = 0; index < 3; index++) addEdit("opaque-file-b", "STALE_STRING");
    addEdit("opaque-file-b", "NOT_READ");
    const metrics = c4Detector.evaluate(db, CTX).fired[0]?.payload.metrics;
    expect(metrics).toMatchObject({ FAILED_EDIT_COUNT: { value: 3 } });
  });

  it("U7: runs are keyed by (session, agent): a subagent's failures count, and agents never combine", () => {
    addEdit("opaque-file-a", "STALE_STRING", { sidechain: 1, agentId: "agent-1" });
    addEdit("opaque-file-a", "STALE_STRING", { sidechain: 1, agentId: "agent-2" });
    addEdit("opaque-file-a", "STALE_STRING", { sidechain: 1, agentId: "agent-1" });
    addEdit("opaque-file-a", "STALE_STRING");
    expect(c4Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });

    addEdit("opaque-file-a", "STALE_STRING", { sidechain: 1, agentId: "agent-1" });
    expect(c4Detector.evaluate(db, CTX).fired).toHaveLength(1);
  });

  it("U7: names the commonest failure's first error line, and omits it when no error text was stored", () => {
    addEdit("opaque-file-a", null);
    for (let index = 0; index < 3; index++) addEdit("opaque-file-b", "STALE_STRING");
    expect(c4Detector.evaluate(db, CTX).fired[0]?.payload.metrics).not.toHaveProperty(
      "TOP_FAILURE_ERROR_TEXT",
    );

    const text =
      "<tool_use_error>File has been modified since read, either by the user or by a linter.\nRead it again.";
    addEdit("opaque-file-c", "STALE_STRING", { errorText: "String to replace not found in file." });
    addEdit("opaque-file-c", "STALE_STRING", { errorText: text });
    addEdit("opaque-file-c", "STALE_STRING", { errorText: text });
    expect(c4Detector.evaluate(db, CTX).fired[0]?.payload.metrics).toMatchObject({
      TOP_FAILURE_ERROR_TEXT: {
        kind: "TEXT",
        value: "File has been modified since read, either by the user or by a linter.",
      },
    });
  });

  it("keeps the five newest anchors when a recovery run exceeds five failures", () => {
    for (let index = 0; index < 7; index++) addEdit("opaque-file-a", "STALE_STRING");

    expect(c4Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c4"),
        timestamp: `2027-01-02T00:00:0${index}.000Z`,
        event_id: findingIds.event(`c4-event-${index}`),
      })),
    );
  });
});
