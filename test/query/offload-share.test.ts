/**
 * test/query/offload-share.test.ts — subagent offload-share query (L2c).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOffloadShare } from "../../src/query/api/offload-share.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2027-06-01T00:00:00.000Z";
const TO = "2027-07-01T00:00:00.000Z";
const TS_IN = "2027-06-15T12:00:00.000Z";

let db: Database.Database;
let nextMessageId = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  nextMessageId = 0;
});

afterEach(() => {
  db.close();
});

function insWs(workspaceId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run(workspaceId, workspaceId, FROM);
}

function insSession(
  sessionId: string,
  workspaceId: string,
  turns: Array<{ isSidechain: 0 | 1; provisional: 0 | 1; ts?: string }>,
): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',?,0,'[]')`,
  ).run(sessionId, workspaceId, "private.jsonl", TS_IN, TS_IN, turns.length);

  const insertTurn = db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
        cache_write_1h, cache_write_other, tool_result_bytes,
        pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?,?,?,?,'claude-sonnet',?,100,10,0,0,0,0,NULL,NULL,0,'LIST_EQUIV',?,'test-v1')`,
  );

  for (const turn of turns) {
    nextMessageId += 1;
    insertTurn.run(
      `msg-${sessionId}-${nextMessageId}`,
      sessionId,
      workspaceId,
      turn.ts ?? TS_IN,
      turn.isSidechain,
      turn.provisional,
    );
  }
}

describe("getOffloadShare", () => {
  it("aggregates the structural offload share across sessions globally", () => {
    insWs("ws-a");
    insWs("ws-b");
    insSession("session-a", "ws-a", [
      { isSidechain: 0, provisional: 0 },
      { isSidechain: 0, provisional: 0 },
      { isSidechain: 0, provisional: 0 },
      { isSidechain: 1, provisional: 0 },
    ]);
    insSession("session-b", "ws-b", [
      { isSidechain: 1, provisional: 0 },
      { isSidechain: 1, provisional: 0 },
      { isSidechain: 0, provisional: 0 },
      { isSidechain: 0, provisional: 0 },
    ]);

    const response = getOffloadShare(db, { workspaceId: null, from: FROM, to: TO });
    const data = response.data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 2,
      sidechain_session_count: 2,
      total_turns: 8,
      sidechain_turns: 3,
      offload_share: 3 / 8,
      from: FROM,
      to: TO,
      workspace_id: null,
    });
    expect(response.meta.claim_kind).toBe("OBS_PROXY");
    expect(response.meta.n).toBe(8);
    expect(response.meta.qualification.note).toBe(
      "Within-session subagent offload share: is_sidechain turns / all turns (structural).",
    );
  });

  it("excludes provisional turns from both the numerator and denominator", () => {
    insWs("ws-a");
    insSession("session-a", "ws-a", [
      { isSidechain: 1, provisional: 0 },
      { isSidechain: 0, provisional: 0 },
      { isSidechain: 1, provisional: 1 },
      { isSidechain: 0, provisional: 1 },
    ]);

    const data = getOffloadShare(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 1,
      sidechain_session_count: 1,
      total_turns: 2,
      sidechain_turns: 1,
      offload_share: 0.5,
    });
  });

  it("isolates turns in the selected workspace", () => {
    insWs("ws-a");
    insWs("ws-b");
    insSession("session-a", "ws-a", [
      { isSidechain: 1, provisional: 0 },
      { isSidechain: 0, provisional: 0 },
    ]);
    insSession("session-b", "ws-b", [
      { isSidechain: 1, provisional: 0 },
      { isSidechain: 1, provisional: 0 },
    ]);

    const data = getOffloadShare(db, { workspaceId: "ws-a", from: FROM, to: TO }).data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 1,
      sidechain_session_count: 1,
      total_turns: 2,
      sidechain_turns: 1,
      offload_share: 0.5,
      workspace_id: "ws-a",
    });
  });

  it("uses a half-open time window", () => {
    insWs("ws-window");
    insSession("session-in", "ws-window", [
      { isSidechain: 1, provisional: 0, ts: TS_IN },
      { isSidechain: 0, provisional: 0, ts: TS_IN },
    ]);
    insSession("session-before", "ws-window", [
      { isSidechain: 1, provisional: 0, ts: "2027-05-31T23:59:59.999Z" },
    ]);
    insSession("session-at-to", "ws-window", [{ isSidechain: 0, provisional: 0, ts: TO }]);

    const data = getOffloadShare(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 1,
      sidechain_session_count: 1,
      total_turns: 2,
      sidechain_turns: 1,
      offload_share: 0.5,
    });
  });

  it("returns zero metrics and a null share with no in-window turns", () => {
    const response = getOffloadShare(db, { workspaceId: null, from: FROM, to: TO });
    const data = response.data;
    if (data === null) throw new Error("expected data");

    expect(data).toMatchObject({
      session_count: 0,
      sidechain_session_count: 0,
      total_turns: 0,
      sidechain_turns: 0,
      offload_share: null,
      from: FROM,
      to: TO,
      workspace_id: null,
    });
    expect(response.meta.n).toBe(0);
    expect(response.meta.qualification.note).toBe(
      "Within-session subagent offload share: is_sidechain turns / all turns (structural).",
    );
  });
});
