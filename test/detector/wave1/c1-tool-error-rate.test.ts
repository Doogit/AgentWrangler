import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  C1_BASELINE_MULTIPLIER,
  c1Detector,
  c1FindingDescriptor,
} from "../../../src/detector/detectors/c1_tool_error_rate.js";
import { buildContext } from "../../../src/detector/engine.js";
import {
  type FindingEnvelopeV2,
  assertFindingEnvelopeV2,
  createFindingEnvelopeV2,
  findingIds,
  serializeModeledFormulaV2,
} from "../../../src/detector/privacy-contract.js";
import { wastedTurnClaims } from "../../../src/detector/turn-claim.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-c1', 'ws-c1', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-c1', 'ws-c1', '/fixture/c1.jsonl', ?, ?,
             'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.toIso);
});

afterEach(() => db.close());

function addToolEvent(
  toolName: string,
  exitClass: "OK" | "ERROR" | "TEST_FAIL",
  options: {
    sidechain?: boolean;
    provisional?: boolean;
    costEquivU?: number;
    content?: { command?: string; error: string };
  } = {},
): void {
  const id = `c1-event-${sequence++}`;
  const messageId = `c1-message-${sequence}`;
  const ts = new Date(Date.parse("2027-01-02T00:00:00.000Z") + sequence * 1_000).toISOString();
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
        cache_write_1h, cache_write_other, tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, 'session-c1', 'ws-c1', ?, 'claude-sonnet', ?,
             0, 0, 0, 0, 0, 0, NULL, NULL, ?, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    messageId,
    ts,
    options.sidechain ? 1 : 0,
    options.costEquivU ?? 100,
    options.provisional ? 1 : 0,
  );
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
        input_hash, exit_class, commit_sha)
     VALUES (?, 'session-c1', ?, ?, 1, 1, NULL, ?, NULL)`,
  ).run(id, ts, toolName, exitClass);
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, NULL, ?, 0, ?)`,
  ).run(id, messageId, exitClass === "TEST_FAIL" ? 1 : 0);
  if (options.content !== undefined) {
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      id,
      JSON.stringify(options.content),
    );
  }
}

/** Successful calls appended after a test's own events, so its event ids and error runs keep. */
function pad(toolName: string, count: number): void {
  for (let index = 0; index < count; index++) addToolEvent(toolName, "OK");
}

/** Three PrivateMcpTool errors in 20 calls, 60 calls in all. */
function threeOutlierErrors(): void {
  for (let index = 0; index < 3; index++) addToolEvent("PrivateMcpTool", "ERROR");
  for (let index = 0; index < 9; index++) addToolEvent("Read", "OK");
  pad("PrivateMcpTool", 17);
  pad("Read", 31);
}

describe("C1 TOOL_ERROR_RATE V2", () => {
  it("fires when a tool's error rate is strictly greater than twice the corpus baseline", () => {
    threeOutlierErrors();

    const outcome = c1Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c1Detector);

    expect(C1_BASELINE_MULTIPLIER).toBe(2);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    const finding = outcome.fired[0];
    expect(finding?.payload.routing.tier).toBe("T3");
    expect(finding?.payload.metrics).toMatchObject({
      TOOL_CALL_COUNT: { kind: "COUNT", value: 20 },
      TOOL_ERROR_COUNT: { kind: "COUNT", value: 3 },
      TOOL_ERROR_RATE: { kind: "RATIO", value: 3 / 20 },
      CORPUS_CALL_COUNT: { kind: "COUNT", value: 60 },
      CORPUS_ERROR_COUNT: { kind: "COUNT", value: 3 },
      CORPUS_ERROR_RATE: { kind: "RATIO", value: 3 / 60 },
      RATE_MULTIPLE: { kind: "NUMBER", value: 3 / 20 / (3 / 60) },
    });
    expect(finding?.payload.anchors).toHaveLength(3);
    expect(finding?.payload.session_ids).toEqual(["session-c1"]);
    expect(
      db
        .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .get(finding?.payload.session_ids?.[0]),
    ).toBeDefined();
    // D7 owns the second and third turns of the consecutive error run. The
    // first remaining C1 claim is 1 × 100 µUSD/turn × 0.5 = 50 µUSD/week.
    expect(
      JSON.parse(serializeModeledFormulaV2(finding?.payload, c1FindingDescriptor)).estimate,
    ).toMatchObject({
      basis: "P",
      rank_value_u_per_wk: 50,
    });
    expect(finding?.modeled_savings_u_per_wk).toBe(50);
    // P3.1-T5 (ADR-112 amended): the outlier tools are named so the card can say which they are;
    // tools that are not outliers are not.
    expect(finding?.payload.metrics?.OUTLIER_TOOLS).toEqual({
      kind: "TEXT",
      value: "PrivateMcpTool",
    });
    expect(JSON.stringify(finding?.payload)).not.toContain("Read");
  });

  it("review 5 M10: records how many turns its saving prices", () => {
    threeOutlierErrors();

    // D7 owns the second and third turns of the error run, so C1 prices one turn.
    const finding = c1Detector.evaluate(db, CTX).fired[0];
    expect(finding?.payload.metrics?.CLAIMED_TURN_COUNT).toEqual({ kind: "COUNT", value: 1 });
  });

  it("U9 r6: records the tool's ERROR results it left out (timeouts), beside the ones it counted", () => {
    threeOutlierErrors();
    for (let index = 0; index < 2; index++)
      addToolEvent("PrivateMcpTool", "ERROR", {
        content: {
          error: 'CDP sendCommand "Runtime.evaluate" timed out after 45000ms on tab 1',
        },
      });
    const metrics = c1Detector.evaluate(db, CTX).fired[0]?.payload.metrics;
    expect(metrics?.TOOL_ERROR_COUNT).toEqual({ kind: "COUNT", value: 3 });
    expect(metrics?.EXCLUDED_ERROR_COUNT).toEqual({ kind: "COUNT", value: 2 });
  });

  it("review 5 M10: an envelope written before the turn count still validates", () => {
    threeOutlierErrors();
    const payload = c1Detector.evaluate(db, CTX).fired[0]?.payload;
    const { CLAIMED_TURN_COUNT: _claimed, ...older } = payload?.metrics ?? {};
    const { evidence_digest: _digest, ...body } = {
      ...payload,
      metrics: older,
    } as FindingEnvelopeV2;
    const rebuilt = createFindingEnvelopeV2(body, c1FindingDescriptor);
    expect(() => assertFindingEnvelopeV2(rebuilt, c1FindingDescriptor)).not.toThrow();
    expect(rebuilt.metrics).not.toHaveProperty("CLAIMED_TURN_COUNT");
  });

  it("does not fire at exactly twice the corpus baseline", () => {
    addToolEvent("Edit", "ERROR");
    addToolEvent("Edit", "OK");
    addToolEvent("Read", "OK");
    addToolEvent("Read", "OK");

    const outcome = c1Detector.evaluate(db, CTX);

    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toEqual([]);
  });

  // U7: C1 needs 3 errors per tool, so the fixture carries three counted failures.
  it("excludes sidechain and provisional events", () => {
    for (let index = 0; index < 3; index++) addToolEvent("PrivateMcpTool", "ERROR");
    addToolEvent("PrivateMcpTool", "ERROR", { sidechain: true });
    addToolEvent("PrivateMcpTool", "ERROR", { provisional: true });
    for (let index = 0; index < 5; index++) addToolEvent("Read", "OK");
    pad("PrivateMcpTool", 17);
    pad("Read", 20);

    const outcome = c1Detector.evaluate(db, CTX);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      TOOL_CALL_COUNT: { kind: "COUNT", value: 20 },
      TOOL_ERROR_COUNT: { kind: "COUNT", value: 3 },
      CORPUS_CALL_COUNT: { kind: "COUNT", value: 45 },
      CORPUS_ERROR_COUNT: { kind: "COUNT", value: 3 },
    });
  });

  it("U7: counts a shell call only when the shell itself failed, not a test or program that exited non-zero", () => {
    // Test failures and a program's own non-zero exit are the code's fault, not the shell's.
    for (let index = 0; index < 3; index++) addToolEvent("Bash", "TEST_FAIL");
    for (let index = 0; index < 3; index++) {
      addToolEvent("Bash", "ERROR", {
        content: { command: "git merge x", error: "Exit code 128\nfatal: x" },
      });
    }
    for (let index = 0; index < 3; index++) {
      addToolEvent("Bash", "ERROR", {
        content: {
          command: "frobnicate",
          error: "Exit code 127\nbash: frobnicate: command not found",
        },
      });
    }
    pad("Bash", 14);
    pad("Read", 80);

    const outcome = c1Detector.evaluate(db, CTX);
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      TOOL_CALL_COUNT: { kind: "COUNT", value: 23 },
      TOOL_ERROR_COUNT: { kind: "COUNT", value: 3 },
    });
  });

  it("U7: one error, or two, never makes an outlier however rare the tool", () => {
    addToolEvent("PrivateMcpTool", "ERROR");
    addToolEvent("PrivateMcpTool", "ERROR");
    pad("PrivateMcpTool", 18);
    pad("Read", 200);

    expect(c1Detector.evaluate(db, CTX).status).toBe("INACTIVE");
    expect(wastedTurnClaims(db, CTX).get("C1")?.size ?? 0).toBe(0);
  });

  it("U7: a user rejection, an Artifact guard and a tool timeout are not tool failures", () => {
    for (const error of [
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      "The user doesn't want to take this action right now.",
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit).",
    ])
      addToolEvent("Edit", "ERROR", { content: { error } });
    for (const error of [
      "Nothing was published or removed: this publish touches files whose published content is not what you last saw.",
      "conflict: nothing was published — a newer version is live.",
      "Nothing was published or removed: another stale copy.",
    ])
      addToolEvent("Artifact", "ERROR", { content: { error } });
    for (let index = 0; index < 3; index++) {
      addToolEvent("mcp__claude-in-chrome__javascript_tool", "ERROR", {
        content: {
          error:
            'The "javascript_tool" tool did not respond in time. If Chrome is on another computer, that computer may be closed.',
        },
      });
    }
    pad("Edit", 17);
    pad("Artifact", 17);
    pad("mcp__claude-in-chrome__javascript_tool", 17);
    pad("Read", 80);

    expect(c1Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("counts expected 'nothing there' outcomes as successes (R2.9)", () => {
    // taskkill exits 128 when a process is already gone; a silent port probe exits 1 when free.
    const benign = [
      { command: "taskkill /T /F /PID 123", error: "Exit code 128\nERROR: The process ..." },
      {
        command:
          "Stop-Process -Id 1 -Force; Get-NetTCPConnection -LocalPort 1 -ErrorAction SilentlyContinue",
        error: "Exit code 1",
      },
    ];
    for (const content of benign) addToolEvent("PowerShell", "ERROR", { content });
    // A git exit 128 is a program's own failure: a shell call counts only when the shell itself
    // failed (U7), so it is not counted either. Three shell failures are.
    addToolEvent("Bash", "ERROR", {
      content: { command: "git merge", error: "Exit code 128\nfatal: x" },
    });
    for (let index = 0; index < 3; index++) {
      addToolEvent("Bash", "ERROR", {
        content: { command: "nope", error: "Exit code 127\nbash: nope: command not found" },
      });
    }
    for (let index = 0; index < 5; index++) addToolEvent("Read", "OK");
    pad("Bash", 16);
    pad("Read", 18);

    const metrics = c1Detector.evaluate(db, CTX).fired[0]?.payload.metrics;
    expect(metrics).toMatchObject({
      TOOL_CALL_COUNT: { kind: "COUNT", value: 20 },
      TOOL_ERROR_COUNT: { kind: "COUNT", value: 3 },
      CORPUS_CALL_COUNT: { kind: "COUNT", value: 45 },
      CORPUS_ERROR_COUNT: { kind: "COUNT", value: 3 },
    });
  });

  // Review 3 B7: a batch whose steps all succeeded and a search that found nothing are answers,
  // not failures.
  it("B7: leaves out successful batch steps and search misses", () => {
    const batch = "mcp__claude-in-chrome__browser_batch";
    const find = "mcp__claude-in-chrome__find";
    for (const error of [
      "[navigate] Navigated to http://127.0.0.1:1/#/x",
      "[computer:scroll_to] Scrolled to element with reference: ref_1",
    ])
      addToolEvent(batch, "ERROR", { content: { error } });
    for (let index = 0; index < 3; index++) {
      addToolEvent(batch, "ERROR", {
        content: {
          error: `[navigate] Navigated to x\nactions[${index}] (find) failed: Page still loading`,
        },
      });
    }
    for (const error of [
      'The text "Addressable spend" does not appear anywhere in the accessibility tree provided.',
      'There is no "Loops" section visible in the accessibility tree of this page.',
      'The accessibility tree does not contain any elements matching "summary row".',
    ])
      addToolEvent(find, "ERROR", { content: { error } });
    for (let index = 0; index < 3; index++) {
      addToolEvent(find, "ERROR", {
        content: { error: `Can't interact with browser-internal or unparseable URLs (${index}).` },
      });
    }
    for (let index = 0; index < 45; index++) addToolEvent("Read", "OK");
    pad(batch, 15);
    pad(find, 14);

    // 6 real failures in 85 calls (7.1%); batch 3 of 20 and find 3 of 20 both pass 2× that. One
    // card per tool (U7): batch and find.
    const fired = c1Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(2);
    expect(fired[0]?.payload.metrics).toMatchObject({
      TOOL_CALL_COUNT: { kind: "COUNT", value: 20 },
      TOOL_ERROR_COUNT: { kind: "COUNT", value: 3 },
      CORPUS_CALL_COUNT: { kind: "COUNT", value: 85 },
      CORPUS_ERROR_COUNT: { kind: "COUNT", value: 6 },
    });
  });

  // Review 4 C1: a search answer that mentions an error in its prose is still an answer, and a batch
  // fails only by a step that failed, read per step.
  it("review 4: reads each batch step and every search miss, whatever its prose", () => {
    const batch = "mcp__claude-in-chrome__browser_batch";
    const find = "mcp__claude-in-chrome__find";
    for (const error of [
      'The accessibility tree does not contain any elements matching "row". The page is in a loading/error state.',
      "The page is still loading. The accessibility tree does not contain any recommendation cards yet.",
    ])
      addToolEvent(find, "ERROR", { content: { error } });
    for (const error of [
      "[navigate] Navigated to http://127.0.0.1:1/#/x\n[get_page_text] Error budget: 3 of 5 used",
      "[navigate] Navigated to x\n\nactions[2] (computer:zoom) failed: Error capturing zoomed screenshot",
      "Couldn't determine which page this action targets. Re-read tabs_context_mcp and try again.",
      "[navigate] Navigated to y\nactions[0] (find) failed: Element not found",
    ])
      addToolEvent(batch, "ERROR", { content: { error } });
    for (let index = 0; index < 45; index++) addToolEvent("Read", "OK");
    pad(batch, 16);

    // 3 real failures (the zoom step, the lost tab, the find step), all batches; no find failure.
    const metrics = c1Detector.evaluate(db, CTX).fired[0]?.payload.metrics;
    expect(metrics).toMatchObject({
      TOOL_CALL_COUNT: { kind: "COUNT", value: 20 },
      TOOL_ERROR_COUNT: { kind: "COUNT", value: 3 },
      CORPUS_ERROR_COUNT: { kind: "COUNT", value: 3 },
    });
  });

  it("stays inactive when the corpus has no errors", () => {
    addToolEvent("Read", "OK");
    addToolEvent("Edit", "OK");

    expect(c1Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("keeps the five newest error anchors when more than five qualify", () => {
    for (let index = 0; index < 7; index++) addToolEvent("PrivateMcpTool", "ERROR");
    for (let index = 0; index < 21; index++) addToolEvent("Read", "OK");
    pad("PrivateMcpTool", 13);
    pad("Read", 10);

    const anchors = c1Detector.evaluate(db, CTX).fired[0]?.payload.anchors;

    expect(anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c1"),
        timestamp: `2027-01-02T00:00:0${index + 1}.000Z`,
        event_id: findingIds.event(`c1-event-${index}`),
      })),
    );
  });

  it("T9: leaves out the shell D11 flags in its workspace, and D11 claims its failed turns", () => {
    // A failure the shell itself caused, which D11 counts (review 3 B3).
    const failed = {
      command: "git push && x",
      error: "Exit code 1\nThe token '&&' is not a valid statement separator.",
    };
    // D11 fires on PowerShell here: 20 of 50 failed, Bash 0 of 50.
    for (let index = 0; index < 50; index++) {
      addToolEvent("PowerShell", index < 40 && index % 2 === 0 ? "ERROR" : "OK", {
        content: failed,
      });
      addToolEvent("Bash", "OK");
    }
    for (let index = 0; index < 3; index++) addToolEvent("PrivateMcpTool", "ERROR");
    for (let index = 0; index < 150; index++) addToolEvent("Read", "OK");
    pad("PrivateMcpTool", 17);

    const metrics = c1Detector.evaluate(db, CTX).fired[0]?.payload.metrics;
    expect(metrics).toMatchObject({
      TOOL_CALL_COUNT: { kind: "COUNT", value: 20 },
      TOOL_ERROR_COUNT: { kind: "COUNT", value: 3 },
      CORPUS_CALL_COUNT: { kind: "COUNT", value: 220 },
      OUTLIER_TOOLS: { kind: "TEXT", value: "PrivateMcpTool" },
    });
    const claims = wastedTurnClaims(db, CTX);
    // D7 owns the second and third turns of the PrivateMcpTool error run.
    expect(claims.get("C1")?.size).toBe(1);
    expect(claims.get("D11")?.size).toBe(20);
  });

  it("card review F4: a hook block or a CDP timeout is not a tool failure", () => {
    for (const error of [
      "PreToolUse:Bash hook error: Blocked command shape (rules 1-3)",
      "PreToolUse:TaskCreate hook error: Agent dispatch omitted `model`",
    ])
      addToolEvent("Bash", "ERROR", { content: { command: "x", error } });
    addToolEvent("mcp__claude-in-chrome__computer", "ERROR", {
      content: {
        error:
          'Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms',
      },
    });
    pad("Bash", 18);
    pad("mcp__claude-in-chrome__computer", 19);
    pad("Read", 40);

    expect(c1Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
    expect(wastedTurnClaims(db, CTX).get("C1")?.size ?? 0).toBe(0);
  });

  it("card review F4: a tool needs 20 calls before its rate can make it an outlier", () => {
    for (let index = 0; index < 3; index++) addToolEvent("PrivateMcpTool", "ERROR");
    pad("PrivateMcpTool", 16);
    pad("Read", 80);
    expect(c1Detector.evaluate(db, CTX).status).toBe("INACTIVE");
    expect(wastedTurnClaims(db, CTX).get("C1")?.size ?? 0).toBe(0);

    pad("PrivateMcpTool", 1);
    expect(c1Detector.evaluate(db, CTX).fired[0]?.payload.metrics?.TOOL_CALL_COUNT).toEqual({
      kind: "COUNT",
      value: 20,
    });
    expect(wastedTurnClaims(db, CTX).get("C1")?.size).toBeGreaterThan(0);
  });

  // U7: one card per outlier tool replaces the one-example-per-tool rollup; each card's anchors
  // are that tool's own newest errors.
  it("U7: emits one finding per outlier tool, busiest first, anchored on its own errors", () => {
    for (let index = 0; index < 3; index++) addToolEvent("OtherMcpTool", "ERROR");
    for (let index = 0; index < 7; index++) addToolEvent("PrivateMcpTool", "ERROR");
    for (let index = 0; index < 40; index++) addToolEvent("Read", "OK");
    pad("OtherMcpTool", 17);
    pad("PrivateMcpTool", 13);
    pad("Read", 260);

    const fired = c1Detector.evaluate(db, CTX).fired;

    expect(fired.map((f) => f.scopeKey)).toEqual(["C1|PrivateMcpTool", "C1|OtherMcpTool"]);
    expect(fired[0]?.payload.anchors?.map((anchor) => anchor.event_id)).toEqual(
      [5, 6, 7, 8, 9].map((index) => findingIds.event(`c1-event-${index}`)),
    );
    expect(fired[1]?.payload.anchors?.map((anchor) => anchor.event_id)).toEqual(
      [0, 1, 2].map((index) => findingIds.event(`c1-event-${index}`)),
    );
    expect(fired[1]?.payload.metrics?.OUTLIER_TOOLS).toEqual({
      kind: "TEXT",
      value: "OtherMcpTool",
    });
  });
});
