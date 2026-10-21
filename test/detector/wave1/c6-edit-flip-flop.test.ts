import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c6Detector } from "../../../src/detector/detectors/c6_edit_flip_flop.js";
import { buildContext } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-c6', 'ws-c6', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-c6', 'ws-c6', '/fixture/c6.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.toIso);
});

afterEach(() => db.close());

/**
 * One Edit event. `oldHash`/`newHash` stand in for the sha256 of old_string/new_string
 * (synthetic labels; the detector only compares them for equality).
 */
function addEdit(
  eventId: string,
  blockIndex: number,
  oldHash: string,
  newHash: string,
  opts: {
    toolName?: string;
    owner?: { messageId: string | null; isSidechain?: number; provisional?: number };
    filePathHash?: string;
    sessionId?: string;
  } = {},
): void {
  const sessionId = opts.sessionId ?? "session-c6";
  const owner = opts.owner ?? { messageId: `turn-${eventId}` };
  const timestamp = `2027-01-02T00:00:${String(blockIndex).padStart(2, "0")}.000Z`;
  if (owner.messageId !== null) {
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, provisional, parser_version)
       VALUES (?, ?, 'ws-c6', ?, 'claude-sonnet', ?, ?, 'test')`,
    ).run(owner.messageId, sessionId, timestamp, owner.isSidechain ?? 0, owner.provisional ?? 0);
  }
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha)
     VALUES (?, ?, ?, ?, 0, 0, ?, 'OK', NULL)`,
  ).run(eventId, sessionId, timestamp, opts.toolName ?? "Edit", `input-${eventId}`);
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command,
        edit_old_string_hash, edit_new_string_hash)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    eventId,
    opts.filePathHash ?? "private-file-hash",
    owner.messageId,
    blockIndex,
    oldHash,
    newHash,
  );
}

describe("C6 EDIT_FLIP_FLOP V2 (old/new string swap)", () => {
  it("fires when A->B is later reverted by B->A, with opaque anchors and REVIEW posture", () => {
    addEdit("c6-e0", 0, "private-old-a", "private-new-b");
    addEdit("c6-e1", 1, "private-old-x", "private-new-y"); // unrelated edit in between
    addEdit("c6-e2", 2, "private-new-b", "private-old-a");
    addEdit("c6-write", 3, "private-old-a", "private-new-b", { toolName: "Write" });

    const outcome = c6Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, c6Detector);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      FLIP_FLOP_COUNT: { kind: "COUNT", value: 1 },
      AFFECTED_FILE_COUNT: { kind: "COUNT", value: 1 },
    });
    expect(outcome.fired[0]?.payload.assessment).toMatchObject({ posture: "REVIEW" });
    expect(outcome.fired[0]?.payload.anchors).toEqual([
      {
        session_id: findingIds.session("session-c6"),
        timestamp: "2027-01-02T00:00:02.000Z",
        event_id: findingIds.event("c6-e2"),
      },
    ]);
    const serialized = JSON.stringify(outcome.fired);
    expect(serialized).not.toContain("private-file-hash");
    expect(serialized).not.toContain("private-old-a");
    expect(serialized).not.toContain("private-new-b");
  });

  it("does not fire for a forward chain A->B then B->C", () => {
    addEdit("c6-e0", 0, "a", "b");
    addEdit("c6-e1", 1, "b", "c");
    expect(c6Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("does not fire for an identical repeated edit A->B, A->B (the old whole-input A,B,B,A shape)", () => {
    addEdit("c6-e0", 0, "a", "b");
    addEdit("c6-e1", 1, "a", "b");
    addEdit("c6-e2", 2, "c", "d");
    addEdit("c6-e3", 3, "c", "d");
    expect(c6Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("does not fire for a no-op edit A->A repeated", () => {
    addEdit("c6-e0", 0, "a", "a");
    addEdit("c6-e1", 1, "a", "a");
    expect(c6Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("does not pair a swap across different files or sessions", () => {
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('session-c6-b', 'ws-c6', '/fixture/c6b.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
    ).run(CTX.fromIso, CTX.toIso);
    addEdit("c6-e0", 0, "a", "b", { filePathHash: "file-1" });
    addEdit("c6-e1", 1, "b", "a", { filePathHash: "file-2" });
    addEdit("c6-e2", 2, "c", "d");
    addEdit("c6-e3", 3, "d", "c", { sessionId: "session-c6-b" });
    expect(c6Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("ignores edits ingested before migration 044 (no string hashes)", () => {
    addEdit("c6-e0", 0, "a", "b");
    addEdit("c6-e1", 1, "b", "a");
    db.prepare(
      "UPDATE tool_event_metadata SET edit_old_string_hash = NULL, edit_new_string_hash = NULL",
    ).run();
    expect(c6Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("keeps the five newest flip-flop anchors when more than five qualify", () => {
    for (let index = 0; index < 7; index++) {
      const file = `private-file-${index}`;
      addEdit(`c6-${index}-ab`, index * 2, "a", "b", { filePathHash: file });
      addEdit(`c6-${index}-ba`, index * 2 + 1, "b", "a", { filePathHash: file });
    }

    expect(c6Detector.evaluate(db, CTX).fired[0]?.payload.anchors).toEqual(
      [2, 3, 4, 5, 6].map((index) => ({
        session_id: findingIds.session("session-c6"),
        timestamp: `2027-01-02T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
        event_id: findingIds.event(`c6-${index}-ba`),
      })),
    );
  });

  it.each([
    ["unowned", { messageId: null }],
    ["sidechain", { messageId: "turn-sidechain", isSidechain: 1 }],
    ["provisional", { messageId: "turn-provisional", provisional: 1 }],
  ] as const)("excludes %s Edit events from forming a flip-flop", (_kind, excludedOwner) => {
    addEdit("c6-valid-ab", 0, "a", "b");
    addEdit("c6-excluded-ba", 1, "b", "a", { owner: excludedOwner });

    expect(c6Detector.evaluate(db, CTX)).toMatchObject({ status: "INACTIVE", fired: [] });
  });

  it("emits session_ids and an X-basis unranked estimate (savings stay null)", () => {
    addEdit("c6-e0", 0, "a", "b");
    addEdit("c6-e1", 1, "b", "a");

    const outcome = c6Detector.evaluate(db, CTX);
    const payload = outcome.fired[0]?.payload;

    expect(outcome.fired[0]?.modeled_savings_u_per_wk).toBeNull();
    expect(payload?.session_ids).toEqual(["session-c6"]);
    // c6Estimate({}) = unranked: X-basis, no price → rank null, not summable
    expect(payload?.estimate).toMatchObject({
      basis: "X",
      rank_value_u_per_wk: null,
      summable: false,
    });
  });
});
