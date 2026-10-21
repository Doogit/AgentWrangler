import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  A2_TASK_OUTPUT_BYTES_THRESHOLD,
  a2Detector,
} from "../../../src/detector/detectors/a2_task_output_bloat.js";
import { buildContext, runDetectors } from "../../../src/detector/engine.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
let sequence = 0;
/** Per-turn spend (µ$): small enough that one result's carry clears the 0.1% gate. */
const TURN_COST_U = 100_000;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  for (const workspaceId of ["ws-a2", "ws-a2-other"]) {
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
    ).run(workspaceId, workspaceId, CTX.fromIso);
  }
});

afterEach(() => db.close());

function addTaskOutput(options: {
  workspace?: string;
  bytes: number;
  sidechain?: boolean;
  provisional?: boolean;
  owned?: boolean;
  ts?: string;
  model?: string;
  cacheWrite5m?: number;
}) {
  const index = sequence++;
  const workspace = options.workspace ?? "ws-a2";
  const sessionId = `a2-session-${index}`;
  const messageId = `a2-message-${index}`;
  const eventId = `a2-event-${index}`;
  const ts = options.ts ?? "2027-01-02T00:00:00.000Z";
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 1, 0, '[]')`,
  ).run(sessionId, workspace, `/fixture/${sessionId}.jsonl`, ts, ts);
  const insertTurn = db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, 0, ?, 'LIST_EQUIV', ?, 'test')`,
  );
  const model = options.model ?? "claude-sonnet-4-6";
  insertTurn.run(
    messageId,
    sessionId,
    workspace,
    ts,
    model,
    options.sidechain ? 1 : 0,
    options.cacheWrite5m ?? 0,
    TURN_COST_U,
    options.provisional ? 1 : 0,
  );
  // U7: A2 prices each result along its owner chain, so the result needs a later same-chain
  // turn that sends it (the write); the turns' cost is the workspace spend the % gate reads.
  insertTurn.run(
    `${messageId}-next`,
    sessionId,
    workspace,
    new Date(Date.parse(ts) + 60_000).toISOString(),
    model,
    options.sidechain ? 1 : 0,
    0,
    TURN_COST_U,
    options.provisional ? 1 : 0,
  );
  db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha)
     VALUES (?, ?, ?, 'TaskOutput', 0, ?, NULL, 'OK', NULL)`,
  ).run(eventId, sessionId, ts, options.bytes);
  if (options.owned !== false) {
    db.prepare(
      `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
       VALUES (?, NULL, ?, 0, 0)`,
    ).run(eventId, messageId);
  }
  return { eventId, sessionId };
}

describe("A2 BACKGROUND_AGENT_TRANSCRIPT_BLOAT V2", () => {
  it("uses a strict 10 KiB boundary, excludes sidechain/provisional/unowned events, and aggregates by workspace", () => {
    addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD });
    const first = addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 1 });
    addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 9 });
    addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 20, sidechain: true });
    addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 30, provisional: true });
    addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 40, owned: false });
    addTaskOutput({ workspace: "ws-a2-other", bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 2 });

    const outcome = a2Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, a2Detector);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(2);
    const primary = outcome.fired.find(
      (finding) => finding.scope_workspace_id === "ws-a2",
    )?.payload;
    expect(primary?.metrics).toMatchObject({
      EVENT_COUNT: { kind: "COUNT", value: 2 },
      RESULT_BYTES_TOTAL: { kind: "BYTES", value: A2_TASK_OUTPUT_BYTES_THRESHOLD * 2 + 10 },
      MAX_RESULT_BYTES: { kind: "BYTES", value: A2_TASK_OUTPUT_BYTES_THRESHOLD + 9 },
    });
    expect(primary?.anchors.map((anchor) => anchor.event_id)).toContain(
      findingIds.event(first.eventId),
    );
  });

  it("keeps the five largest structural anchors without raw tool names", () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      addTaskOutput({
        bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + index + 1,
        ts: `2027-01-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const finding = a2Detector
      .evaluate(db, CTX)
      .fired.find((item) => item.scope_workspace_id === "ws-a2")?.payload;
    expect(finding?.anchors).toHaveLength(5);
    expect(finding?.anchors.map((anchor) => anchor.event_id)).toEqual(
      events
        .slice(1)
        .reverse()
        .map((event) => findingIds.event(event.eventId)),
    );
    expect(JSON.stringify(finding)).not.toContain("TaskOutput");
  });

  it("persists raw contributing sessions and the A2 estimate", () => {
    const { sessionId } = addTaskOutput({
      bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_700,
      model: "claude-sonnet-4-6",
      cacheWrite5m: 1_000,
    });

    runDetectors(db, CTX, [a2Detector]);
    const row = db
      .prepare(
        "SELECT evidence_json, modeled_formula_json FROM recommendations WHERE detector_id = 'A2'",
      )
      .get() as { evidence_json: string; modeled_formula_json: string };
    const evidence = JSON.parse(row.evidence_json) as { session_ids?: string[] };
    expect(evidence.session_ids).toEqual([sessionId]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(sessionId),
    ).toEqual({ n: 1 });
    const formula = JSON.parse(row.modeled_formula_json) as {
      estimate?: { basis: string; rank_value_u_per_wk: number | null };
    };
    // 2,700 / 2.7 × 0.5 × 3.75 = 1,875 µUSD/wk.
    expect(formula.estimate).toEqual(
      expect.objectContaining({ basis: "P", rank_value_u_per_wk: 1_875 }),
    );
  });

  function addLaterTurns(sessionId: string, fromTs: string, count: number, costU = TURN_COST_U) {
    const stmt = db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_equiv_u, cost_claim, provisional, parser_version)
       VALUES (?, ?, 'ws-a2', ?, 'claude-sonnet-4-6', 0, 0, 0, 0, 0, 0, 0, ?, 'LIST_EQUIV', 0, 'test')`,
    );
    for (let i = 0; i < count; i++) {
      stmt.run(
        `${sessionId}-later-${i}`,
        sessionId,
        new Date(Date.parse(fromTs) + (i + 2) * 60_000).toISOString(),
        costU,
      );
    }
  }

  it("prices the result's carry: one write plus a read on each later main turn (U7)", () => {
    // Audit evidence: a TaskOutput result stays in context for 9-75 later turns.
    const ts = "2027-01-02T00:00:00.000Z";
    const { sessionId } = addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_700, ts });
    addLaterTurns(sessionId, ts, 9); // 10 later turns in all: 1 write + 9 reads.

    runDetectors(db, CTX, [a2Detector]);
    const row = db
      .prepare("SELECT modeled_formula_json FROM recommendations WHERE detector_id = 'A2'")
      .get() as { modeled_formula_json: string };
    const formula = JSON.parse(row.modeled_formula_json) as {
      estimate?: { rank_value_u_per_wk: number | null };
    };
    // 2,700 / 2.7 × 0.5 × (3.75 + 9 × 0.30) = 3,225 µUSD/wk (the write-only price was 1,875).
    expect(formula.estimate?.rank_value_u_per_wk).toBe(3_225);
  });

  it("holds the card back when the results' carry cost is under 0.1% of workspace spend (U7)", () => {
    const ts = "2027-01-02T00:00:00.000Z";
    const { sessionId } = addTaskOutput({ bytes: A2_TASK_OUTPUT_BYTES_THRESHOLD + 2_700, ts });
    // Carry ≈ 12,900 B / 2.7 × 3.75 ≈ 17,900 µ$; workspace spend $100 → 0.018%.
    addLaterTurns(sessionId, ts, 1, 100_000_000);

    const fired = a2Detector.evaluate(db, CTX).fired;
    expect(fired.find((f) => f.scope_workspace_id === "ws-a2")).toBeUndefined();
  });
});
