import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c9Detector } from "../../../src/detector/detectors/c9_denial_friction.js";
import { buildContext } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { __resetToolCallTargets } from "../../../src/query/api/tool-calls.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-c9', 'ws-c9', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-c9', 'ws-c9', '/fixture/c9.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.toIso);
});

afterEach(() => db.close());

function addDenial(
  eventId: string,
  classifierLabel: "hook-block" | "deny-rule" | "user-rejected" | "interrupt-cancel",
  commandShape: string | null,
  isInterrupt = 0,
  isSidechain = 0,
  sessionId = "session-c9",
): void {
  const timestamp = `2027-01-02T00:00:${String(sequence++).padStart(2, "0")}.000Z`;
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
        classifier_label, command_shape, event_ts, is_sidechain)
     VALUES (?, ?, NULL, 0, 0, 0, ?, ?, ?, ?, ?)`,
  ).run(eventId, sessionId, isInterrupt, classifierLabel, commandShape, timestamp, isSidechain);
}

function addSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, 'ws-c9', '/fixture/other.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, CTX.fromIso, CTX.toIso);
}

function addTurn(messageId: string, ts: string, costEquivU: number): void {
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, cost_equiv_u, provisional, parser_version)
     VALUES (?, 'session-c9', 'ws-c9', ?, 'claude-sonnet', 0, ?, 0, 'test')`,
  ).run(messageId, ts, costEquivU);
}

describe("C9 DENIAL_FRICTION V2", () => {
  it("includes closed denial outcomes, excludes interrupts, and reduces command shape to argument count", () => {
    addDenial("c9-hook", "hook-block", "bash:args-4+");
    addDenial("c9-deny", "deny-rule", null);
    addDenial("c9-rejected", "user-rejected", "bash:args-1");
    addDenial("c9-interrupt", "interrupt-cancel", "bash:args-4+", 1);
    addDenial("c9-sidechain", "deny-rule", null, 0, 1);

    const outcome = c9Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c9Detector);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(3);
    expect(outcome.fired.every((finding) => finding.payload.routing.tier === "T3")).toBe(true);
    const byLabel = new Map(
      outcome.fired.map((finding) => [finding.payload.label, finding.payload]),
    );
    expect(byLabel.get("HOOK_BLOCK")?.metrics).toMatchObject({
      COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: "ARGS_4_PLUS" },
      DENIAL_COUNT: { kind: "COUNT", value: 1 },
    });
    expect(byLabel.get("DENY_RULE")?.metrics?.COMMAND_ARGUMENT_COUNT_CLASS).toEqual({
      kind: "ENUM",
      value: "NONE",
    });
    expect(JSON.stringify(outcome.fired)).not.toContain("interrupt-cancel");
    expect(JSON.stringify(outcome.fired)).not.toContain("c9-sidechain");
    expect(JSON.stringify(outcome.fired)).not.toContain("bash:args");
  });

  it("keeps the five newest anchors when one denial group exceeds five rows", () => {
    for (let index = 0; index < 7; index++) addDenial(`c9-denial-${index}`, "deny-rule", null);

    expect(c9Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c9"),
        timestamp: `2027-01-02T00:00:0${index}.000Z`,
        event_id: findingIds.event(`c9-denial-${index}`),
      })),
    );
  });

  it("emits session_ids and an E-basis estimate from claimed denial turns", () => {
    // Denial at 2027-01-02T00:00:05.000Z (sequence=5 → ts position 05)
    // Owner turn: last turn at ts ≤ event_ts → 2027-01-02T00:00:04.000Z, cost=2000
    // Re-plan turn: first turn at ts > event_ts → 2027-01-02T00:00:06.000Z, cost=3000
    addTurn("c9-t-owner", "2027-01-02T00:00:04.000Z", 2000);
    addTurn("c9-t-replan", "2027-01-02T00:00:06.000Z", 3000);
    sequence = 5;
    // Not a guard block: those are priced only when harmless (R6-01, below).
    addDenial("c9-e5", "user-rejected", null);

    const outcome = c9Detector.evaluate(db, CTX);
    const payload = outcome.fired[0]?.payload;

    expect(payload?.session_ids).toEqual(["session-c9"]);
    // C9 claimed: owner (cost=2000) + re-plan (cost=3000) → sumCostU=5000
    // c9Estimate({ costEquivU: 5000 }) = rank = round(5000 × 0.5) = 2500
    expect(payload?.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 2500, // round(5000 × 0.5) = 2500
      summable: true,
    });
  });

  it("emits one finding per workspace and denial kind across sessions", () => {
    addSession("session-c9-b");
    addDenial("c9-a1", "user-rejected", "bash:args-1");
    addDenial("c9-b1", "user-rejected", "bash:args-1", 0, 0, "session-c9-b");
    addDenial("c9-b2", "user-rejected", "bash:args-2-3", 0, 0, "session-c9-b");

    const outcome = c9Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    const finding = outcome.fired[0];
    expect(finding?.scopeKey).toBe("C9|ws-c9|USER_REJECTED");
    expect(finding?.payload.session_ids).toEqual(["session-c9-b", "session-c9"]);
    expect(finding?.payload.metrics).toMatchObject({
      DENIAL_COUNT: { kind: "COUNT", value: 3 },
      COMMAND_ARGUMENT_COUNT_CLASS: { kind: "ENUM", value: "ARGS_1" },
    });
  });

  it("ignores AskUserQuestion rejections (the user answers in chat instead)", () => {
    const addRejectedTool = (eventId: string, toolName: string, ts: string): void => {
      db.prepare(
        `INSERT INTO tool_events
           (event_id, session_id, ts, tool_name, interrupt_kind, interrupt_classifier_version)
         VALUES (?, 'session-c9', ?, ?, 'HUMAN_DENY', 'interrupt-1')`,
      ).run(eventId, ts, toolName);
    };
    sequence = 1;
    addRejectedTool("tu-ask", "AskUserQuestion", "2027-01-02T00:00:00.500Z");
    addDenial("c9-ask", "user-rejected", null); // :01
    addRejectedTool("tu-bash", "Bash", "2027-01-02T00:00:01.500Z");
    addDenial("c9-bash", "user-rejected", "bash:args-1"); // :02
    addDenial("c9-unlinked", "user-rejected", null); // :03, latest HUMAN_DENY is Bash

    const outcome = c9Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.metrics?.DENIAL_COUNT).toEqual({ kind: "COUNT", value: 2 });
    expect(JSON.stringify(outcome.fired)).not.toContain(findingIds.event("c9-ask"));
  });

  it("shares a session's claimed cost across its denial kinds instead of pricing it twice", () => {
    addTurn("c9-t-owner", "2027-01-02T00:00:04.000Z", 2000);
    addTurn("c9-t-replan", "2027-01-02T00:00:06.000Z", 3000);
    sequence = 5;
    addDenial("c9-deny", "deny-rule", null);
    sequence = 5;
    addDenial("c9-rejected", "user-rejected", null);

    const ranks = c9Detector
      .evaluate(db, CTX)
      .fired.map((finding) => finding.payload.estimate?.rank_value_u_per_wk);
    // One session, 5000 claimed: each kind carries half, so the total stays round(5000 × 0.5).
    expect(ranks).toEqual([1250, 1250]);
  });

  it("review 6 R6-01: prices only the guard blocks that were harmless", () => {
    __resetToolCallTargets();
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-c9-"));
    const transcript = path.join(dir, "c9.jsonl");
    db.prepare("UPDATE sessions SET file_path = ? WHERE session_id = 'session-c9'").run(transcript);
    const T = (minute: number) => `2027-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`;
    const guard = "Blocked: no cd&&-prefix, no python -c, no /tmp writes.";
    // Blocks at minutes 1, 3, 5, 7: one harmless read-only `python -c`, three `cd … &&` prefixes.
    const commands = ['python -c "print(1)"', "cd a && ls", "cd b && ls", "cd c && ls"];
    const lines: string[] = [];
    commands.forEach((command, i) => {
      const id = `tu-${i}`;
      const ts = T(2 * i + 1);
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: ts,
          message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
        }),
        JSON.stringify({
          type: "user",
          timestamp: ts,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: `PreToolUse:Bash hook error: ${guard}`,
              },
            ],
          },
        }),
      );
      db.prepare(
        `INSERT INTO ingest_metric_events
           (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
            classifier_label, command_shape, event_ts, is_sidechain)
         VALUES (?, 'session-c9', NULL, 0, 0, 0, 0, 'hook-block', 'bash:args-1', ?, 0)`,
      ).run(`c9-block-${i}`, ts);
    });
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    // Turns at minutes 0, 2, 4, 6, 8 (1000 each): every one is an owner or re-plan turn → 5000.
    for (let minute = 0; minute <= 8; minute += 2) addTurn(`c9-t-${minute}`, T(minute), 1000);

    try {
      const payload = c9Detector.evaluate(db, CTX).fired[0]?.payload;
      expect(payload?.metrics?.DENIAL_COUNT).toEqual({ kind: "COUNT", value: 4 });
      // All four would be round(5000 × 0.5) = 2500; one of four was harmless → 625.
      expect(payload?.estimate?.rank_value_u_per_wk).toBe(625);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("U9: prices every harmless block the card says to fix, including an earlier message of a rule the guard still has", () => {
    __resetToolCallTargets();
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-c9-"));
    const transcript = path.join(dir, "c9.jsonl");
    db.prepare("UPDATE sessions SET file_path = ? WHERE session_id = 'session-c9'").run(transcript);
    const T = (minute: number) => `2027-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`;
    // Same guard rule (same first three words), reworded between the first block and the rest.
    const older = "Blocked: no cd&&-prefix, no python -c.";
    const current = "Blocked: no cd&&-prefix, no python -c, no /tmp writes.";
    const blocks: Array<[string, string]> = [
      ['python -c "print(1)"', older],
      ['python -c "print(2)"', current],
      ["cd a && ls", current],
      ["cd b && ls", current],
    ];
    const lines: string[] = [];
    blocks.forEach(([command, guard], i) => {
      const id = `tu-${i}`;
      const ts = T(2 * i + 1);
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: ts,
          message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
        }),
        JSON.stringify({
          type: "user",
          timestamp: ts,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: `PreToolUse:Bash hook error: ${guard}`,
              },
            ],
          },
        }),
      );
      db.prepare(
        `INSERT INTO ingest_metric_events
           (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
            classifier_label, command_shape, event_ts, is_sidechain)
         VALUES (?, 'session-c9', NULL, 0, 0, 0, 0, 'hook-block', 'bash:args-1', ?, 0)`,
      ).run(`c9-block-${i}`, ts);
    });
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    for (let minute = 0; minute <= 8; minute += 2) addTurn(`c9-t-${minute}`, T(minute), 1000);

    try {
      const payload = c9Detector.evaluate(db, CTX).fired[0]?.payload;
      expect(payload?.metrics?.DENIAL_COUNT).toEqual({ kind: "COUNT", value: 4 });
      // Two harmless blocks (one under the older message, one under the current one): 2500 × 2/4.
      expect(payload?.estimate?.rank_value_u_per_wk).toBe(1250);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("review 6 R6-01: a guard block whose call cannot be read back is not priced", () => {
    addTurn("c9-t-owner", "2027-01-02T00:00:04.000Z", 2000);
    addTurn("c9-t-replan", "2027-01-02T00:00:06.000Z", 3000);
    sequence = 5;
    addDenial("c9-unread", "hook-block", null);
    // /fixture/c9.jsonl does not exist: the block is unclassified, so nothing is shown as harmless.
    expect(c9Detector.evaluate(db, CTX).fired[0]?.payload.estimate?.rank_value_u_per_wk).toBe(0);
  });
});
