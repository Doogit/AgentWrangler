import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d14Detector } from "../../../src/detector/detectors/d14_interrupt_cancel.js";
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
    VALUES ('ws-d14', 'ws-d14', '${CTX.fromIso}');
    INSERT INTO sessions
      (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES
      ('session-d14-main', 'ws-d14', '/fixture/d14-main.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'RECONCILED', 0, 0, '[]'),
      ('session-d14-live', 'ws-d14', '/fixture/d14-live.jsonl', '${CTX.fromIso}', '${CTX.toIso}', 'LIVE', 0, 0, '[]');
  `);
});

afterEach(() => db.close());

function addEvent(
  sessionId: string,
  kind: "PURE_INTERRUPT" | "KILLED_NO_PROMPT" | "HUMAN_DENY" | null,
  options: { sidechain?: number; provisional?: number } = {},
): void {
  const suffix = sequence++;
  const eventId = `d14-event-${suffix}`;
  const messageId = `d14-message-${suffix}`;
  const ts = `2027-01-02T00:00:${String(suffix).padStart(2, "0")}.000Z`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, 'ws-d14', ?, 'claude-sonnet', ?, 0, 0, 0, 0, 0, 0, 0,
             'LIST_EQUIV', ?, 'test-v1')`,
  ).run(messageId, sessionId, ts, options.sidechain ?? 0, options.provisional ?? 0);
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, exit_class, interrupt_kind, interrupt_classifier_version)
     VALUES (?, ?, ?, 'PrivateTool', ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    ts,
    kind === null ? "OK" : "ERROR",
    kind,
    kind === null ? null : "interrupt-1",
  );
  db.prepare(
    "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, 0, 0)",
  ).run(eventId, messageId);
}

function addUserCorrection(sessionId: string): void {
  const suffix = sequence++;
  const timestamp = `2027-01-02T00:00:${String(suffix).padStart(2, "0")}.000Z`;
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
        is_interrupt, event_ts, is_sidechain)
     VALUES (?, ?, ?, 1, 0, 0, 0, ?, 0)`,
  ).run(`d14-user-turn-${suffix}`, sessionId, timestamp, timestamp);
}

describe("D14 library-D2 interrupt/cancel classification V2", () => {
  it("keeps the library rule ID distinct from the runtime ID and emits only owned classifications", () => {
    addEvent("session-d14-main", "PURE_INTERRUPT");
    addEvent("session-d14-main", "KILLED_NO_PROMPT");
    addEvent("session-d14-main", "HUMAN_DENY");

    const outcome = d14Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, d14Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(2);
    expect(outcome.fired.map((finding) => finding.payload.rule_id)).toEqual(["D2", "D2"]);
    expect(outcome.fired.map((finding) => finding.scopeKey)).toEqual([
      "D14|ws-d14|session-d14-main|KILLED_NO_PROMPT",
      "D14|ws-d14|session-d14-main|PURE_INTERRUPT",
    ]);
    expect(outcome.fired.every((finding) => finding.payload.routing.tier === "T2")).toBe(true);
    expect(outcome.fired.map((finding) => finding.payload.metrics)).toEqual([
      {
        INTERRUPT_KIND: { kind: "ENUM", value: "KILLED_NO_PROMPT" },
        INTERRUPT_COUNT: { kind: "COUNT", value: 1 },
      },
      {
        INTERRUPT_KIND: { kind: "ENUM", value: "PURE_INTERRUPT" },
        INTERRUPT_COUNT: { kind: "COUNT", value: 1 },
      },
    ]);
    expect(JSON.stringify(outcome.fired)).not.toContain("PrivateTool");
  });

  it("leaves HUMAN_DENY to C9", () => {
    addEvent("session-d14-main", "HUMAN_DENY");

    expect(d14Detector.evaluate(db, CTX)).toMatchObject({
      status: "INACTIVE",
      fired: [],
      note: "no persisted interrupt or cancellation classifications",
    });
  });

  it("suppresses a completed-session interrupt corrected within two turns", () => {
    addEvent("session-d14-main", "PURE_INTERRUPT");
    addUserCorrection("session-d14-main");

    const outcome = d14Detector.evaluate(db, CTX);
    expect(outcome).toMatchObject({ status: "INACTIVE", fired: [] });
    // The INACTIVE note must not claim there were no classifications when one was excluded.
    expect(outcome.note).toMatch(
      /^1 interrupt or cancellation classification\(s\) in window, all excluded/,
    );
  });

  it("ignores a call cut off because the session ended, not by the user (R2.12)", () => {
    addEvent("session-d14-main", "KILLED_NO_PROMPT");
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      "d14-event-0",
      JSON.stringify({
        error:
          "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]",
      }),
    );

    expect(d14Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("keeps a bare interrupt and emits its raw session id", () => {
    addEvent("session-d14-main", "PURE_INTERRUPT");

    const outcome = d14Detector.evaluate(db, CTX);

    expect(outcome.fired).toHaveLength(1);
    // session_ids: raw, non-empty, present in fixture sessions table
    expect(outcome.fired[0]?.payload.session_ids).toEqual(["session-d14-main"]);
    // addEvent turns have cost_equiv_u=0; rank = 0 × 0.5 = 0, basis "E" (not human-deny)
    expect(outcome.fired[0]?.payload.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 0,
      summable: true,
    });
  });

  it("prices only the D14-claimed turns (owner + next same-chain turn)", () => {
    const addTurn = (messageId: string, ts: string, costU: number): void => {
      db.prepare(
        `INSERT INTO turns
           (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
            cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
            cost_claim, provisional, parser_version)
         VALUES (?, 'session-d14-main', 'ws-d14', ?, 'claude-sonnet', 0, 0, 0, 0, 0, 0, 0, ?,
                 'LIST_EQUIV', 0, 'test-v1')`,
      ).run(messageId, ts, costU);
    };
    addTurn("d14-before", "2027-01-01T23:59:00.000Z", 50_000); // earlier turn: not claimed
    addEvent("session-d14-main", "PURE_INTERRUPT"); // owner turn d14-message-0 @ 00:00:00, cost 0
    db.prepare("UPDATE turns SET cost_equiv_u = 1000 WHERE message_id = 'd14-message-0'").run();
    addTurn("d14-replan", "2027-01-02T00:01:00.000Z", 3000); // next same-chain turn: claimed
    addTurn("d14-later", "2027-01-02T00:02:00.000Z", 70_000); // later turn: not claimed

    const outcome = d14Detector.evaluate(db, CTX);

    // 0.5 × (owner 1000 + re-plan 3000) = 2000; the 50,000 and 70,000 turns are excluded.
    expect(outcome.fired[0]?.payload.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 2000,
      summable: true,
    });
  });

  it("uses five newest anchors in deterministic chronological order", () => {
    for (let index = 0; index < 7; index++) addEvent("session-d14-main", "PURE_INTERRUPT");

    const outcome = d14Detector.evaluate(db, CTX);

    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.anchors.map((anchor) => anchor.timestamp)).toEqual([
      "2027-01-02T00:00:02.000Z",
      "2027-01-02T00:00:03.000Z",
      "2027-01-02T00:00:04.000Z",
      "2027-01-02T00:00:05.000Z",
      "2027-01-02T00:00:06.000Z",
    ]);
  });

  it("fails closed for missing classification evidence and excluded source chains", () => {
    addEvent("session-d14-main", null);
    addEvent("session-d14-main", "PURE_INTERRUPT", { sidechain: 1 });
    addEvent("session-d14-main", "PURE_INTERRUPT", { provisional: 1 });
    addEvent("session-d14-live", "PURE_INTERRUPT");

    expect(d14Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });
});

/** RC-D14: a user Esc record in ingest_metric_events (classifier-2), the source real data has. */
function addEsc(
  sessionId: string,
  options: {
    variant?: "plain" | "tool-use";
    version?: string;
    sidechain?: number;
    ownerCostU?: number;
  } = {},
): string {
  const suffix = sequence++;
  const ts = (s: number) => `2027-01-02T00:00:${String(s).padStart(2, "0")}.000Z`;
  // The response the user stopped: a main-chain turn just before the Esc.
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, 'ws-d14', ?, 'claude-sonnet', 0, 0, 0, 0, 0, 0, 0, ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(`d14-owner-${suffix}`, sessionId, ts(suffix), options.ownerCostU ?? 0);
  const escSuffix = sequence++;
  const eventId = `d14-esc-${escSuffix}`;
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
        is_interrupt, classifier_label, classifier_version, event_ts, is_sidechain)
     VALUES (?, ?, NULL, 0, 0, 0, 1, ?, ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    options.variant === "tool-use" ? null : "interrupt-cancel",
    options.version ?? "classifier-2",
    ts(escSuffix),
    options.sidechain ?? 0,
  );
  return eventId;
}

describe("D14 user Esc source (RC-D14)", () => {
  it("fires on an Esc with no prompt correction within two turns", () => {
    const eventId = addEsc("session-d14-main");

    const outcome = d14Detector.evaluate(db, CTX);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired.map((f) => f.scopeKey)).toEqual([
      "D14|ws-d14|session-d14-main|PURE_INTERRUPT",
    ]);
    expect(outcome.fired[0]?.payload.anchors).toHaveLength(1);
    expect(outcome.fired[0]?.payload.anchors[0]?.timestamp).toBe("2027-01-02T00:00:01.000Z");
    expect(eventId).toBe("d14-esc-1");
  });

  it("prices the stopped turn and the next one", () => {
    addEsc("session-d14-main", { ownerCostU: 1000 });
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
          cost_claim, provisional, parser_version)
       VALUES ('d14-replan', 'session-d14-main', 'ws-d14', '2027-01-02T00:01:00.000Z', 'claude-sonnet',
               0, 0, 0, 0, 0, 0, 0, 3000, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run();

    const outcome = d14Detector.evaluate(db, CTX);
    expect(outcome.fired[0]?.payload.estimate).toMatchObject({ rank_value_u_per_wk: 2000 });
  });

  it("does not price the previous prompt's answer when the stopped stream left no turn", () => {
    // Answer to an earlier prompt, then a new prompt, then Esc before any usage record.
    const turn = db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
          cost_claim, provisional, parser_version)
       VALUES (?, 'session-d14-main', 'ws-d14', ?, 'claude-sonnet', 0, 0, 0, 0, 0, 0, 0, ?,
               'LIST_EQUIV', 0, 'test-v1')`,
    );
    turn.run("d14-prior-answer", "2027-01-02T00:00:01.000Z", 1000);
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
          is_interrupt, event_ts, is_sidechain)
       VALUES ('d14-prompt', 'session-d14-main', '2027-01-02T00:00:02.000Z', 1, 0, 0, 0,
               '2027-01-02T00:00:02.000Z', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
          is_interrupt, classifier_label, classifier_version, event_ts, is_sidechain)
       VALUES ('d14-esc-x', 'session-d14-main', NULL, 0, 0, 0, 1, 'interrupt-cancel',
               'classifier-2', '2027-01-02T00:00:03.000Z', 0)`,
    ).run();
    turn.run("d14-replan", "2027-01-02T00:01:00.000Z", 3000);

    const outcome = d14Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    // 0.5 × the re-plan turn only; the prior answer (1000) is not the stopped response.
    expect(outcome.fired[0]?.payload.estimate).toMatchObject({ rank_value_u_per_wk: 1500 });
  });

  it("near-miss: an Esc corrected by the next prompt is a good interrupt", () => {
    addEsc("session-d14-main");
    addUserCorrection("session-d14-main");

    const outcome = d14Detector.evaluate(db, CTX);
    expect(outcome).toMatchObject({ status: "INACTIVE", fired: [] });
    expect(outcome.note).toMatch(
      /^1 interrupt or cancellation classification\(s\) in window, all excluded/,
    );
  });

  it("leaves the 'for tool use' variant to the tool denial, and skips classifier-1, sidechain and live rows", () => {
    addEsc("session-d14-main", { variant: "tool-use" });
    addEsc("session-d14-main", { version: "classifier-1" });
    addEsc("session-d14-main", { sidechain: 1 });
    addEsc("session-d14-live");

    const outcome = d14Detector.evaluate(db, CTX);
    expect(outcome).toMatchObject({ status: "INACTIVE", fired: [] });
    // The note counts the user Esc records it saw (main chain, classifier-2), not the stale ones.
    expect(outcome.note).toMatch(/^2 interrupt or cancellation classification\(s\) in window/);
  });
});
