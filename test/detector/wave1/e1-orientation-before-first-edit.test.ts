import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { e1Detector } from "../../../src/detector/detectors/e1_orientation_before_first_edit.js";
import { buildContext } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
const TURN_U = 1_000;
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
});

afterEach(() => db.close());

function addSession(workspaceId: string, sessionId: string, state = "RECONCILED"): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(workspaceId, workspaceId, CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, '[]')`,
  ).run(sessionId, workspaceId, `/fixture/${sessionId}.jsonl`, CTX.fromIso, CTX.toIso, state);
}

/** One turn, optionally issuing one tool call. Turns get strictly increasing timestamps. */
function addTurn(
  workspaceId: string,
  sessionId: string,
  options: {
    tool?: string;
    sidechain?: number;
    provisional?: number;
    costU?: number;
    /** The tool event lands this many ms after its turn's first line (real JSONL does). */
    eventLagMs?: number;
    /** Base for the turn's timestamp; defaults to inside the window. */
    baseIso?: string;
  } = {},
): string {
  const suffix = sequence++;
  const messageId = `e1-message-${suffix}`;
  const tsMs = Date.parse(options.baseIso ?? "2027-01-02T00:00:00.000Z") + suffix * 1_000;
  const ts = new Date(tsMs).toISOString();
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u,
        cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-opus', ?, 0, 0, 0, 0, 0, 0, ?, 'LIST_EQUIV', ?, 'test-v1')`,
  ).run(
    messageId,
    sessionId,
    workspaceId,
    ts,
    options.sidechain ?? 0,
    options.costU ?? TURN_U,
    options.provisional ?? 0,
  );
  if (options.tool !== undefined) {
    const eventId = `e1-event-${suffix}`;
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class)
       VALUES (?, ?, ?, ?, 'OK')`,
    ).run(
      eventId,
      sessionId,
      new Date(tsMs + (options.eventLagMs ?? 0)).toISOString(),
      options.tool,
    );
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, 0, 0)",
    ).run(eventId, messageId);
  }
  return messageId;
}

/** A session with `preEdit` Read turns, then one Edit turn, then one trailing Bash turn. */
function addEditingSession(
  workspaceId: string,
  sessionId: string,
  preEdit: number,
  eventLagMs = 0,
): void {
  addSession(workspaceId, sessionId);
  for (let index = 0; index < preEdit; index++) {
    addTurn(workspaceId, sessionId, { tool: "Read", eventLagMs });
  }
  addTurn(workspaceId, sessionId, { tool: "Edit", eventLagMs });
  addTurn(workspaceId, sessionId, { tool: "Bash", eventLagMs });
}

/** 8 editing sessions, pre-edit counts 2,2,3,3,4,4,10,12: p50 = 3, p75 = 4 (nearest rank). */
function seedFiringWorkspace(workspaceId = "ws-e1", eventLagMs = 0): void {
  [2, 2, 3, 3, 4, 4, 10, 12].forEach((preEdit, index) =>
    addEditingSession(workspaceId, `${workspaceId}-s${index}`, preEdit, eventLagMs),
  );
}

describe("E1 ORIENTATION_BEFORE_FIRST_EDIT", () => {
  it("fires once per workspace with the excess past p50 in sessions over p75", () => {
    seedFiringWorkspace();

    const outcome = e1Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, e1Detector);

    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    const finding = outcome.fired[0];
    expect(finding?.scopeKey).toBe("E1|ws-e1");
    expect(finding?.scope_workspace_id).toBe("ws-e1");
    // Sessions with 10 and 12 pre-edit turns are over p75 = 4; excess = (10-3) + (12-3) = 16 turns.
    expect(finding?.payload.metrics).toEqual({
      EDITING_SESSIONS: { kind: "COUNT", value: 8 },
      SESSIONS_OVER_P75: { kind: "COUNT", value: 2 },
      EXCESS_TURNS: { kind: "COUNT", value: 16 },
      EXCESS_COST_U: { kind: "NUMBER", value: 16 * TURN_U },
      PRE_EDIT_P50: { kind: "COUNT", value: 3 },
      PRE_EDIT_P75: { kind: "COUNT", value: 4 },
    });
    expect(finding?.payload).toMatchObject({
      version: 2,
      rule_id: "E1_ORIENTATION_BEFORE_FIRST_EDIT",
      label: "ORIENTATION_BEFORE_FIRST_EDIT",
      assessment: { posture: "REVIEW" },
      // Longest first, the same order as the anchors.
      session_ids: ["ws-e1-s7", "ws-e1-s6"],
    });
    // Anchors: the top sessions by excess, largest first, at their first edit.
    expect(finding?.payload.anchors.map((anchor) => anchor.session_id)).toEqual([
      findingIds.session("ws-e1-s7"),
      findingIds.session("ws-e1-s6"),
    ]);
    // Assumed realizable fraction 0.5; non-summable (D6/A1 carry the same reads later).
    expect(finding?.payload.estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 8 * TURN_U,
      summable: false,
    });
    expect(finding?.modeled_savings_u_per_wk).toBe(8 * TURN_U);
  });

  it("does not count the editing turn itself when its edit event lands after the turn", () => {
    // Real JSONL: the Edit block is a later line than the turn's first line, so event.ts > turn.ts.
    seedFiringWorkspace("ws-e1", 1);

    expect(e1Detector.evaluate(db, CTX).fired[0]?.payload.metrics).toEqual({
      EDITING_SESSIONS: { kind: "COUNT", value: 8 },
      SESSIONS_OVER_P75: { kind: "COUNT", value: 2 },
      EXCESS_TURNS: { kind: "COUNT", value: 16 },
      EXCESS_COST_U: { kind: "NUMBER", value: 16 * TURN_U },
      PRE_EDIT_P50: { kind: "COUNT", value: 3 },
      PRE_EDIT_P75: { kind: "COUNT", value: 4 },
    });
  });

  it("counts pre-edit turns from session start when the session began before the window", () => {
    seedFiringWorkspace();
    // 10 turns before the window, 1 inside it, then the first edit inside it: 11 pre-edit turns.
    addSession("ws-e1", "ws-e1-straddle");
    const beforeWindow = new Date(Date.parse(CTX.fromIso) - 3_600_000).toISOString();
    for (let index = 0; index < 10; index++) {
      addTurn("ws-e1", "ws-e1-straddle", { tool: "Read", baseIso: beforeWindow });
    }
    addTurn("ws-e1", "ws-e1-straddle", { tool: "Read" });
    addTurn("ws-e1", "ws-e1-straddle", { tool: "Edit" });

    // 9 sessions: 2,2,3,3,4,4,10,11,12 -> p50 = 4 (5th), p75 = 10 (7th); over p75: 11 and 12.
    expect(e1Detector.evaluate(db, CTX).fired[0]?.payload.metrics).toMatchObject({
      EDITING_SESSIONS: { kind: "COUNT", value: 9 },
      SESSIONS_OVER_P75: { kind: "COUNT", value: 2 },
      EXCESS_TURNS: { kind: "COUNT", value: 15 },
      PRE_EDIT_P50: { kind: "COUNT", value: 4 },
      PRE_EDIT_P75: { kind: "COUNT", value: 10 },
    });
  });

  it("stays silent when the excess is under 1% of the workspace's window spend", () => {
    seedFiringWorkspace();
    // A no-edit session carries most of the spend: 16,000 / (56,000 + 2,000,000) < 1%.
    addSession("ws-e1", "ws-e1-research");
    addTurn("ws-e1", "ws-e1-research", { tool: "Read", costU: 2_000_000 });

    expect(e1Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("ignores sidechain and provisional turns, LIVE sessions and no-edit sessions", () => {
    seedFiringWorkspace();
    // Sidechain and provisional turns before s0's edit do not lengthen its pre-edit run.
    const s0 = "ws-e1-s0-extra";
    addSession("ws-e1", s0);
    for (let index = 0; index < 30; index++) addTurn("ws-e1", s0, { tool: "Read", sidechain: 1 });
    for (let index = 0; index < 30; index++) addTurn("ws-e1", s0, { tool: "Read", provisional: 1 });
    addTurn("ws-e1", s0, { tool: "Read" });
    addTurn("ws-e1", s0, { tool: "Read" });
    addTurn("ws-e1", s0, { tool: "Edit" });
    // A session whose only edit is in a sidechain is not an editing session.
    addSession("ws-e1", "ws-e1-side-edit");
    for (let index = 0; index < 20; index++) addTurn("ws-e1", "ws-e1-side-edit", { tool: "Read" });
    addTurn("ws-e1", "ws-e1-side-edit", { tool: "Edit", sidechain: 1, costU: 0 });
    // A LIVE session with a long run is skipped.
    addSession("ws-e1", "ws-e1-live", "LIVE");
    for (let index = 0; index < 40; index++) addTurn("ws-e1", "ws-e1-live", { tool: "Read" });
    addTurn("ws-e1", "ws-e1-live", { tool: "Edit" });

    const outcome = e1Detector.evaluate(db, CTX);

    expect(outcome.status).toBe("ACTIVE");
    // 9 editing sessions: 2,2,2,3,3,4,4,10,12 -> p50 = 3 (5th), p75 = 4 (7th). Same two over p75.
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      EDITING_SESSIONS: { kind: "COUNT", value: 9 },
      SESSIONS_OVER_P75: { kind: "COUNT", value: 2 },
      EXCESS_TURNS: { kind: "COUNT", value: 16 },
      PRE_EDIT_P50: { kind: "COUNT", value: 3 },
      PRE_EDIT_P75: { kind: "COUNT", value: 4 },
    });
  });

  it("is inactive for a workspace with fewer than 8 editing sessions", () => {
    [2, 2, 3, 3, 4, 10, 12].forEach((preEdit, index) =>
      addEditingSession("ws-small", `ws-small-s${index}`, preEdit),
    );

    expect(e1Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("counts Write, MultiEdit and NotebookEdit as the first edit", () => {
    seedFiringWorkspace();
    addSession("ws-e1", "ws-e1-write");
    for (let index = 0; index < 3; index++) addTurn("ws-e1", "ws-e1-write", { tool: "Grep" });
    addTurn("ws-e1", "ws-e1-write", { tool: "Write" });
    addSession("ws-e1", "ws-e1-multi");
    addTurn("ws-e1", "ws-e1-multi", { tool: "MultiEdit" });
    addSession("ws-e1", "ws-e1-nb");
    addTurn("ws-e1", "ws-e1-nb", { tool: "NotebookEdit" });

    expect(e1Detector.evaluate(db, CTX).fired[0]?.payload.metrics).toMatchObject({
      EDITING_SESSIONS: { kind: "COUNT", value: 11 },
    });
  });
});
