import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  destructiveRuns,
  h1Detector,
  h1FindingDescriptor,
  neverRan,
} from "../../../src/detector/detectors/h1_destructive_operations.js";
import { buildContext } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-h1', 'ws-h1', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-h1', 'ws-h1', '/fixture/h1.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.toIso);
});

afterEach(() => db.close());

function addOperation(
  eventId: string,
  operation: string,
  isSidechain = 0,
  call?: { command: string; error?: string; interruptKind?: string },
): void {
  const timestamp = `2027-01-02T00:00:${String(sequence++).padStart(2, "0")}.000Z`;
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
        destructive_op, event_ts, is_sidechain)
     VALUES (?, 'session-h1', NULL, 0, 0, 0, 0, ?, ?, ?)`,
  ).run(eventId, operation, timestamp, isSidechain);
  if (call === undefined) return;
  // The Bash call behind the event: same session and time, with its stored command and result.
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, interrupt_kind, interrupt_classifier_version)
     VALUES (?, 'session-h1', ?, 'Bash', ?, ?)`,
  ).run(
    `toolu-${eventId}`,
    timestamp,
    call.interruptKind ?? null,
    call.interruptKind ? "interrupt-1" : null,
  );
  db.prepare(
    "INSERT INTO tool_event_content (event_id, content_json, content_included) VALUES (?, ?, 1)",
  ).run(
    `toolu-${eventId}`,
    JSON.stringify({ command: call.command, ...(call.error ? { error: call.error } : {}) }),
  );
}

describe("H1 DESTRUCTIVE_OPERATION_REPORT V2", () => {
  it("reports only persisted operation enums with report-only Investigate routing", () => {
    addOperation("h1-rm-1", "rm-rf");
    addOperation("h1-rm-2", "rm-rf");
    addOperation("h1-clean", "git-clean");
    addOperation("h1-sidechain", "truncate", 1);

    const outcome = h1Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, h1Detector);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(2);
    expect(h1FindingDescriptor.metrics.DESTRUCTIVE_OPERATION?.values).toEqual([
      "RM_RF",
      "GIT_RESET_HARD",
      "GIT_CLEAN",
      "SQL_DROP",
      "TRUNCATE",
    ]);
    expect(outcome.fired[0]?.payload.assessment.posture).toBe("REPORT_ONLY");
    expect(outcome.fired[0]?.payload.routing).toEqual({ tier: "T3" });
    expect(JSON.stringify(outcome.fired)).not.toContain("redirection");
    expect(JSON.stringify(outcome.fired)).not.toContain("git-diff");
    expect(JSON.stringify(outcome.fired)).not.toContain("h1-sidechain");
    // Groups are sorted by destructive_op asc; git-clean < rm-rf.
    // session_ids: raw, non-empty, present in fixture sessions table.
    expect(outcome.fired[0]?.payload.session_ids).toEqual(["session-h1"]);
    expect(outcome.fired[1]?.payload.session_ids).toEqual(["session-h1"]);
    // No turns in fixture → cost_equiv_u=0; rm-rf p_harm=0.05, git-clean p_harm=0.05.
    // rank = 0 × 0.05 = 0 for both groups; basis "R", summable false.
    expect(outcome.fired[0]?.payload.estimate).toMatchObject({
      basis: "R",
      rank_value_u_per_wk: 0,
      summable: false,
    });
    expect(outcome.fired[1]?.payload.estimate).toMatchObject({
      basis: "R",
      rank_value_u_per_wk: 0,
      summable: false,
    });
  });

  // Card review F6: 0 of 7 flagged runs were harmful.
  it("drops calls that never ran: rejected, guard-blocked or denied", () => {
    addOperation("rejected", "rm-rf", 0, {
      command: "rm -rf src",
      error: "The user doesn't want to proceed with this tool use. The tool use was rejected",
      interruptKind: "HUMAN_DENY",
    });
    addOperation("blocked", "rm-rf", 0, {
      command: "rm -rf src",
      error: "PreToolUse:Bash hook error: [guard]: blocked",
    });
    addOperation("denied", "rm-rf", 0, {
      command: "rm -rf src",
      error: "Permission to use Bash has been denied.",
    });
    addOperation("failed", "rm-rf", 0, {
      command: "rm -rf src",
      error: "rm: cannot remove 'src/x': Device or resource busy",
    });
    // The label is the ingest classifier's: a redacted stored command does not change it.
    addOperation("redacted", "rm-rf", 0, { command: "rm -rf [REDACTED:secret]" });
    addOperation("no-call", "git-clean");

    const runs = destructiveRuns(db, CTX.fromIso, CTX.toIso);
    expect(runs.map((run) => [run.event_id, run.destructive_op])).toEqual([
      ["no-call", "git-clean"],
      ["failed", "rm-rf"],
      ["redacted", "rm-rf"],
    ]);
    const counts = h1Detector
      .evaluate(db, CTX)
      .fired.map((fired) => fired.payload.metrics?.OPERATION_COUNT);
    expect(counts).toEqual([
      { kind: "COUNT", value: 1 },
      { kind: "COUNT", value: 2 },
    ]);
  });

  it("is inactive when every destructive call never ran", () => {
    addOperation("rejected", "rm-rf", 0, {
      command: "rm -rf src",
      error: "The user doesn't want to proceed with this tool use. The tool use was rejected",
      interruptKind: "HUMAN_DENY",
    });
    addOperation("blocked", "git-clean", 0, {
      command: "git clean -fdx",
      error: "PreToolUse:Bash hook error: [guard]: blocked",
    });

    expect(destructiveRuns(db, CTX.fromIso, CTX.toIso)).toEqual([]);
    const outcome = h1Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toEqual([]);
  });

  it("does not fire on subagent runs alone, and counts them apart on a card a main run fires", () => {
    addOperation("sub-1", "rm-rf", 1);
    addOperation("sub-2", "rm-rf", 1);
    expect(h1Detector.evaluate(db, CTX).status).toBe("INACTIVE");
    expect(destructiveRuns(db, CTX.fromIso, CTX.toIso, true)).toHaveLength(2);

    addOperation("main-1", "rm-rf");
    const outcome = h1Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      OPERATION_COUNT: { kind: "COUNT", value: 1 },
      SIDECHAIN_OPERATION_COUNT: { kind: "COUNT", value: 2 },
    });
  });

  it("neverRan: rejected, guard-blocked or denied calls; a failed run still ran", () => {
    expect(neverRan("HUMAN_DENY", null)).toBe(true);
    expect(neverRan(null, "PreToolUse:Bash hook error: no")).toBe(true);
    expect(neverRan(null, "Permission to use Bash has been denied.")).toBe(true);
    expect(neverRan(null, "rm: cannot remove 'x': Permission denied")).toBe(false);
    expect(neverRan(null, null)).toBe(false);
  });

  it("keeps the five newest anchors when an operation group exceeds five rows", () => {
    for (let index = 0; index < 7; index++) addOperation(`h1-rm-${index}`, "rm-rf");

    expect(h1Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-h1"),
        timestamp: `2027-01-02T00:00:0${index}.000Z`,
        event_id: findingIds.event(`h1-rm-${index}`),
      })),
    );
  });
});
