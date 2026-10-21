import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c5Detector } from "../../src/detector/detectors/c5_same_error_loop.js";
import { turnKey, wastedTurnClaims } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};
const WS = "ws-turn-claims";
const SESSION = "session-turn-claims";
const BASE_MS = new Date("2027-01-02T10:00:00.000Z").getTime();

let db: Database.Database;
let sequence = 0;

function timestamp(offsetSeconds: number): string {
  return new Date(BASE_MS + offsetSeconds * 1_000).toISOString();
}

function addTurn(ts: string, workspaceId = WS, sessionId = SESSION): string {
  const messageId = `turn-${sequence++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet', 0,
             0, 0, 0, 0, 0, 0, 0, NULL,
             100, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, workspaceId, ts);
  return messageId;
}

function addToolEvent(
  toolName: string,
  ts: string,
  options: {
    exitClass?: "ERROR" | "OK";
    errorClass?: string | null;
    interruptKind?: "PURE_INTERRUPT" | "KILLED_NO_PROMPT" | null;
    workspaceId?: string;
    sessionId?: string;
  } = {},
): string {
  const eventId = `event-${sequence++}`;
  const workspaceId = options.workspaceId ?? WS;
  const sessionId = options.sessionId ?? SESSION;
  const messageId = addTurn(ts, workspaceId, sessionId);
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash,
        exit_class, commit_sha, tool_error_class, tool_error_classifier_version,
        interrupt_kind, interrupt_classifier_version)
     VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    ts,
    toolName,
    options.exitClass ?? "ERROR",
    options.errorClass ?? null,
    options.errorClass === undefined || options.errorClass === null ? null : "tool-error-1",
    options.interruptKind ?? null,
    options.interruptKind === undefined || options.interruptKind === null ? null : "interrupt-1",
  );
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, NULL, ?, ?, 0)`,
  ).run(eventId, messageId, sequence);
  // A failed shell call failed in the shell itself, which D11 counts (review 3 B3). Each names
  // a different command in letters: C7 masks digits, so `event-1`, `event-2`, … would be one
  // C7 cluster (C7@rcb-2 no longer skips rows with no command family).
  if (
    (options.exitClass ?? "ERROR") === "ERROR" &&
    (toolName === "Bash" || toolName === "PowerShell")
  )
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      eventId,
      JSON.stringify({
        error: `Exit code 127\n/usr/bin/bash: line 1: ${eventId.replace(/\d/g, (d) => "abcdefghij"[Number(d)] ?? "")}: command not found`,
      }),
    );
  // U7: C5 groups by retained error text, so a classified failure keeps text naming its class.
  else if (options.errorClass !== undefined && options.errorClass !== null)
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      eventId,
      JSON.stringify({ error: `${options.errorClass.toLowerCase()} error` }),
    );
  return messageId;
}

function addC9Denial(ts: string): void {
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
        is_interrupt, classifier_label, command_shape, event_ts, is_sidechain)
     VALUES (?, ?, NULL, 0, 0, 0, 0, 'deny-rule', 'bash:args-1', ?, 0)`,
  ).run(`metric-${sequence++}`, SESSION, ts);
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(WS, WS, CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, '/fixture/turn-claims.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(SESSION, WS, CTX.fromIso, CTX.toIso);
});
afterEach(() => db.close());

describe("wasted-turn family claims", () => {
  it("claims C2 closed NOT_FOUND turns", () => {
    const ts = timestamp(0);
    const turn = addToolEvent("Read", ts, { errorClass: "NOT_FOUND" });

    expect(wastedTurnClaims(db, CTX).get("C2")).toEqual(new Set([turnKey(SESSION, turn)]));
  });

  it("claims C9 closed denial turns at the corresponding tool-event timestamp", () => {
    const ts = timestamp(0);
    const turn = addToolEvent("Bash", ts);
    addC9Denial(ts);

    expect(wastedTurnClaims(db, CTX).get("C9")).toEqual(new Set([turnKey(SESSION, turn)]));
  });

  it("D14: bare interrupt claims owner turn and next turn", () => {
    const ownerTurn = addToolEvent("Bash", timestamp(0), { interruptKind: "PURE_INTERRUPT" });
    const nextTurn = addToolEvent("Bash", timestamp(10), { exitClass: "OK" });

    expect(wastedTurnClaims(db, CTX).get("D14")).toEqual(
      new Set([turnKey(SESSION, ownerTurn), turnKey(SESSION, nextTurn)]),
    );
  });

  it("D14: user turn within 2 turns after interrupt prevents claim", () => {
    addToolEvent("Bash", timestamp(0), { interruptKind: "PURE_INTERRUPT" });
    // user turn 1 second after interrupt, with 0 agent turns between them → count ≤ 2 → not claimed
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
          is_interrupt, classifier_label, command_shape, event_ts, is_sidechain)
       VALUES (?, ?, ?, 1, 0, 0, 0, NULL, NULL, ?, 0)`,
    ).run(`metric-user-${sequence++}`, SESSION, timestamp(1), timestamp(1));

    expect(wastedTurnClaims(db, CTX).get("D14")?.size).toBe(0);
  });

  it("claims D14 uncorrected classified interrupt turns", () => {
    const turn = addToolEvent("PrivateTool", timestamp(0), { interruptKind: "PURE_INTERRUPT" });

    expect(wastedTurnClaims(db, CTX).get("D14")).toEqual(new Set([turnKey(SESSION, turn)]));
  });

  it("claims D11 ERROR turns for the workspace's higher-error shell", () => {
    const errorTurns = [0, 180, 360].map((offset) => addToolEvent("Bash", timestamp(offset)));
    for (let index = 0; index < 97; index++)
      addToolEvent("Bash", timestamp(600 + index), { exitClass: "OK" });
    for (let index = 0; index < 100; index++) {
      addToolEvent("PowerShell", timestamp(800 + index), { exitClass: "OK" });
    }

    expect(wastedTurnClaims(db, CTX).get("D11")).toEqual(
      new Set(errorTurns.map((turn) => turnKey(SESSION, turn))),
    );
  });

  it("claims opposite higher-error shells in two workspaces without pooling", () => {
    const otherWorkspace = "ws-turn-claims-other";
    const otherSession = "session-turn-claims-other";
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
    ).run(otherWorkspace, otherWorkspace, CTX.fromIso);
    db.prepare(
      `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, ?, '/fixture/turn-claims-other.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
    ).run(otherSession, otherWorkspace, CTX.fromIso, CTX.toIso);
    const other = { workspaceId: otherWorkspace, sessionId: otherSession };
    const firstErrors = [0, 180, 360].map((offset) => addToolEvent("Bash", timestamp(offset)));
    const secondErrors = [30, 210, 390].map((offset) =>
      addToolEvent("PowerShell", timestamp(offset), other),
    );
    for (let index = 0; index < 97; index++) {
      addToolEvent("Bash", timestamp(600 + index), { exitClass: "OK" });
      addToolEvent("PowerShell", timestamp(800 + index), { ...other, exitClass: "OK" });
    }
    for (let index = 0; index < 100; index++) {
      addToolEvent("PowerShell", timestamp(1000 + index), { exitClass: "OK" });
      addToolEvent("Bash", timestamp(1200 + index), { ...other, exitClass: "OK" });
    }
    expect(wastedTurnClaims(db, CTX).get("D11")).toEqual(
      new Set([
        ...firstErrors.map((turn) => turnKey(SESSION, turn)),
        ...secondErrors.map((turn) => turnKey(otherSession, turn)),
      ]),
    );
  });

  it("C9: denial with event_ts offset from any tool_events.ts claims owner + next turn", () => {
    // denial 500 ms after ownerTs — matches no tool_events.ts (offset anchoring test)
    const ownerTs = timestamp(0);
    const nextTs = timestamp(10);
    const ownerTurn = addToolEvent("Bash", ownerTs, { exitClass: "OK" });
    const nextTurn = addToolEvent("Bash", nextTs, { exitClass: "OK" });
    const denialTs = new Date(new Date(ownerTs).getTime() + 500).toISOString();
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
          is_interrupt, classifier_label, command_shape, event_ts, is_sidechain)
       VALUES (?, ?, NULL, 0, 0, 0, 0, 'deny-rule', NULL, ?, 0)`,
    ).run(`metric-offset-${sequence++}`, SESSION, denialTs);

    expect(wastedTurnClaims(db, CTX).get("C9")).toEqual(
      new Set([turnKey(SESSION, ownerTurn), turnKey(SESSION, nextTurn)]),
    );
  });

  it("C9: denial in a non-RECONCILED (LIVE) session still claims turns", () => {
    const LIVE_SID = "session-live-c9";
    const ts0 = timestamp(0);
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, ?, '/f.jsonl', ?, ?, 'LIVE', 0, 0, '[]')`,
    ).run(LIVE_SID, WS, CTX.fromIso, CTX.toIso);
    const ownerMsgId = `tmsg-live-${sequence++}`;
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
         cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
         provisional, parser_version)
       VALUES (?, ?, ?, ?, 'test', 0, 0, 0, 0, 0, 0, 0, 0, NULL, 10, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(ownerMsgId, LIVE_SID, WS, ts0);
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
          is_interrupt, classifier_label, command_shape, event_ts, is_sidechain)
       VALUES (?, ?, NULL, 0, 0, 0, 0, 'hook-block', NULL, ?, 0)`,
    ).run(`metric-live-${sequence++}`, LIVE_SID, ts0);

    const c9 = wastedTurnClaims(db, CTX).get("C9");
    expect(c9).toEqual(new Set([turnKey(LIVE_SID, ownerMsgId)]));
  });

  it("T9: D11 claims the Bash ERROR turns of the shell it flags; C1 leaves that shell out", () => {
    // Errors spaced >120 s apart to avoid D7 markErrorRuns grouping (MAX_RUN_GAP_SEC=120).
    // Bash rate = 3/50 = 6% would make it a C1 outlier (corpus ≈ 2.7%), but D11 fires on Bash in
    // this workspace, so C1 drops those calls (operator decision 2026-09-26) and D11 owns them.
    const bashErrors = [0, 130, 260].map((o) => addToolEvent("Bash", timestamp(o)));
    for (let i = 0; i < 47; i++) addToolEvent("Bash", timestamp(400 + i), { exitClass: "OK" });
    for (let i = 0; i < 50; i++)
      addToolEvent("PowerShell", timestamp(600 + i), { exitClass: "OK" });
    for (let i = 0; i < 10; i++) addToolEvent("Read", timestamp(800 + i), { exitClass: "OK" });

    const claims = wastedTurnClaims(db, CTX);
    expect(claims.get("C1")?.size).toBe(0);
    expect(claims.get("D11")).toEqual(new Set(bashErrors.map((t) => turnKey(SESSION, t))));
  });

  it("C2 keeps C5-anchored turns: C5 is rank-only (basis O) and claims no turns", () => {
    // Oracle (rec-page-oracle-post-knob.md): the claim pool is D7 loop exclusion +
    // C7/C3/C4/C1 only. C5 is basis O (excluded from Σ), so sharing anchors with C2
    // cannot double-count; C2 keeps every NOT_FOUND owner turn.
    const turns = [0, 180, 360].map((offset) =>
      addToolEvent("Read", timestamp(offset), { errorClass: "NOT_FOUND" }),
    );

    const c5 = c5Detector.evaluate(db, CTX).fired;
    expect(c5).toHaveLength(1);
    const c5Finding = c5[0];
    if (c5Finding === undefined) throw new Error("expected C5 finding");
    expect(c5Finding.payload.metrics?.LOOP_EXCESS_ERROR_COUNT).toEqual({ kind: "COUNT", value: 1 });
    const claims = wastedTurnClaims(db, CTX);
    // U7: C5 groups by retained error text, and three identical texts are also a D7 loop, so D7
    // owns the two repeat turns; C2 keeps the first (the loop-establishing) turn only.
    expect(claims.get("C2")).toEqual(new Set([turnKey(SESSION, turns[0] ?? "")]));
    expect(claims.has("C5" as never)).toBe(false);
  });

  it("C9: provisional turns in a LIVE session are claimed (owner + re-plan)", () => {
    db.prepare("UPDATE sessions SET state = 'LIVE' WHERE session_id = ?").run(SESSION);
    const ownerTurn = addTurn(timestamp(0));
    const replanTurn = addTurn(timestamp(10));
    db.prepare("UPDATE turns SET provisional = 1 WHERE session_id = ?").run(SESSION);
    addC9Denial(timestamp(1));

    expect(wastedTurnClaims(db, CTX).get("C9")).toEqual(
      new Set([turnKey(SESSION, ownerTurn), turnKey(SESSION, replanTurn)]),
    );
  });

  it("keeps every family set pairwise disjoint", () => {
    const sharedTs = timestamp(0);
    addToolEvent("Read", sharedTs, { errorClass: "NOT_FOUND" });
    addC9Denial(sharedTs);
    // exitClass:"OK" prevents C1 from stealing this turn before C9/D14 can claim it.
    // Bash OK at ts(60) is D14's next-turn claim, keeping D14 out of d11Turns.
    addToolEvent("PrivateTool", timestamp(1), {
      exitClass: "OK",
      interruptKind: "KILLED_NO_PROMPT",
    });
    addToolEvent("Bash", timestamp(60), { exitClass: "OK" });
    const d11Turns = [180, 360, 540].map((offset) => addToolEvent("Bash", timestamp(offset)));
    for (let index = 0; index < 97; index++)
      addToolEvent("Bash", timestamp(700 + index), { exitClass: "OK" });
    for (let index = 0; index < 100; index++) {
      addToolEvent("PowerShell", timestamp(900 + index), { exitClass: "OK" });
    }

    const claims = wastedTurnClaims(db, CTX);
    expect(claims.get("C9")?.size).toBe(1);
    expect(claims.get("D14")?.size).toBe(1);
    expect(claims.get("D11")).toEqual(new Set(d11Turns.map((turn) => turnKey(SESSION, turn))));
    const all = [...claims.values()].flatMap((turns) => [...turns]);
    expect(all.length).toBe(new Set(all).size);
  });
});
