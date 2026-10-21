import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d7Detector } from "../../src/detector/detectors/d7_loop_retry_waste.js";
import { wastedTurnCensus, wastedTurnClaims } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { buildReliabilityCensus } from "../../src/query/api/diagnostics-census.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

/**
 * Identity pin for `wastedTurnClaims` (P4 U3a). The expected value below was captured from the
 * function before `wastedTurnCensus` existed. `wastedTurnClaims` now delegates to the census, and
 * its output must stay byte-identical: same families, same turn keys, same iteration order.
 */

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};
const WS = "ws-identity";
const S1 = "session-identity-1";
const S2 = "session-identity-2";
const BASE_MS = new Date("2027-01-02T10:00:00.000Z").getTime();

let db: Database.Database;
let sequence = 0;

const at = (offsetSeconds: number): string =>
  new Date(BASE_MS + offsetSeconds * 1_000).toISOString();

function addTurn(ts: string, sessionId = S1): string {
  const messageId = `turn-${sequence++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet', 0, 0, 0, 0, 0, 0, 0, 0, NULL,
             100, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, WS, ts);
  return messageId;
}

interface EventOptions {
  exitClass?: "ERROR" | "OK" | "TEST_FAIL";
  errorClass?: string;
  interruptKind?: "PURE_INTERRUPT" | "KILLED_NO_PROMPT" | "HUMAN_DENY";
  family?: string;
  filePathHash?: string;
  command?: string;
  error?: string;
  sessionId?: string;
  /** Put the event in an existing turn instead of a new one. */
  turn?: string;
}

function addEvent(toolName: string, ts: string, options: EventOptions = {}): string {
  const eventId = `event-${sequence++}`;
  const sessionId = options.sessionId ?? S1;
  const messageId = options.turn ?? addTurn(ts, sessionId);
  db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash,
        exit_class, commit_sha, tool_error_class, tool_error_classifier_version,
        bash_command_family, interrupt_kind, interrupt_classifier_version)
     VALUES (?, ?, ?, ?, 1, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    sessionId,
    ts,
    toolName,
    `hash-${eventId}`,
    options.exitClass ?? "OK",
    options.errorClass ?? null,
    options.errorClass === undefined ? null : "tool-error-1",
    options.family ?? null,
    options.interruptKind ?? null,
    options.interruptKind === undefined ? null : "interrupt-1",
  );
  db.prepare(
    `INSERT INTO tool_event_metadata
       (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(eventId, options.filePathHash ?? null, messageId, sequence);
  if (options.command !== undefined || options.error !== undefined)
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      eventId,
      JSON.stringify({ command: options.command, error: options.error }),
    );
  return messageId;
}

function addDenial(ts: string, label: string, sessionId = S1): void {
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
        is_interrupt, classifier_label, command_shape, event_ts, is_sidechain)
     VALUES (?, ?, NULL, 0, 0, 0, 0, ?, NULL, ?, 0)`,
  ).run(`metric-${sequence++}`, sessionId, label, ts);
}

/** Every family and the D7 loop exclusion non-empty, across two sessions. */
function buildFixture(): void {
  const shellError = (n: number) =>
    `Exit code 127\n/usr/bin/bash: line 1: tool-${n}: command not found`;
  // D7 loop: the same failing command three times in a row (two repeat-excess calls).
  for (const offset of [0, 20, 40])
    addEvent("Bash", at(offset), {
      exitClass: "ERROR",
      family: "BASH_OTHER",
      command: "synthetic-loop --flag",
      error: "Exit code 2\nsynthetic loop failure",
    });
  // C7: three failures of one family with one error signature, spaced past D7's run gap.
  for (const offset of [400, 700, 1000])
    addEvent("Bash", at(offset), {
      exitClass: "ERROR",
      family: "BASH_GIT",
      command: `synthetic-git step-${offset}`,
      error: "Exit code 1\nsynthetic git refusal",
    });
  // A C2 miss in a C7 turn: the turn is counted once, in C7.
  const c7Turn = addEvent("Bash", at(1300), {
    exitClass: "ERROR",
    family: "BASH_GIT",
    command: "synthetic-git step-final",
    error: "Exit code 1\nsynthetic git refusal",
  });
  addEvent("Read", at(1300), { exitClass: "ERROR", errorClass: "NOT_FOUND", turn: c7Turn });
  // C3: an edit before reading.
  addEvent("Edit", at(1600), { exitClass: "ERROR", errorClass: "NOT_READ" });
  // C4: five failed edit recoveries on one file.
  const fileHash = "a".repeat(64);
  for (const offset of [1900, 2200, 2500, 2800, 3100])
    addEvent("Edit", at(offset), {
      exitClass: "ERROR",
      errorClass: offset % 600 === 100 ? "PATCH_FAILED" : "STALE_STRING",
      filePathHash: fileHash,
      error: `synthetic stale string ${offset}`,
    });
  // C1: a tool whose error rate is far above the corpus rate.
  for (const offset of [3400, 3700, 4000])
    addEvent("WebFetch", at(offset), { exitClass: "ERROR", error: `synthetic fetch ${offset}` });
  // C2: searches for missing content in the second session.
  for (const offset of [4300, 4600])
    addEvent("Grep", at(offset), { exitClass: "ERROR", errorClass: "NOT_FOUND", sessionId: S2 });
  // C9: a hook block and a user rejection (owner + re-plan turns).
  addEvent("Glob", at(4900), { sessionId: S2 });
  addDenial(at(4901), "hook-block", S2);
  addEvent("Glob", at(4950), { sessionId: S2 });
  addEvent("Write", at(5000), { interruptKind: "HUMAN_DENY", sessionId: S2 });
  addDenial(at(5001), "user-rejected", S2);
  addEvent("Glob", at(5050), { sessionId: S2 });
  // D14: an uncorrected interrupt claims its turn and the next.
  addEvent("PrivateTool", at(5200), { interruptKind: "PURE_INTERRUPT", sessionId: S2 });
  addEvent("Glob", at(5260), { sessionId: S2 });
  // D11: PowerShell fails in the shell itself far more than Bash in this workspace.
  for (const offset of [5600, 5900, 6200])
    addEvent("PowerShell", at(offset), {
      exitClass: "ERROR",
      command: `synthetic-ps ${offset}`,
      error: shellError(offset),
      sessionId: S2,
    });
  for (let i = 0; i < 60; i++) addEvent("PowerShell", at(6500 + i), { sessionId: S2 });
  for (let i = 0; i < 60; i++) addEvent("Bash", at(6700 + i), { command: `synthetic-ok ${i}` });
  // Plenty of successful reads and searches keep the corpus and Grep error rates low.
  for (let i = 0; i < 80; i++) addEvent("Read", at(7000 + i));
  for (let i = 0; i < 40; i++) addEvent("Grep", at(7200 + i), { sessionId: S2 });
  // C1 needs 20 WebFetch calls (card review F4); more reads keep Bash's 8/68 under 2× corpus.
  for (let i = 0; i < 17; i++) addEvent("WebFetch", at(7400 + i));
  for (let i = 0; i < 80; i++) addEvent("Read", at(7500 + i));
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(WS, WS, CTX.fromIso);
  for (const sessionId of [S1, S2])
    db.prepare(
      `INSERT INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, ?, '/fixture/identity.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
    ).run(sessionId, WS, CTX.fromIso, CTX.toIso);
});
afterEach(() => db.close());

const serialize = (claims: Map<string, Set<string>>): string =>
  JSON.stringify([...claims].map(([family, turns]) => [family, [...turns]]));

describe("wastedTurnClaims identity (P4 U3a)", () => {
  it("returns the pinned partition, in order, on a fixture where every family fires", () => {
    buildFixture();
    expect(serialize(wastedTurnClaims(db, CTX))).toBe(PINNED);
  });

  it("attributes each family's events to its claimed turns only", () => {
    buildFixture();
    const census = wastedTurnCensus(db, CTX);
    const ids = (prefix: string, ns: number[]) => ns.map((n) => `${prefix}-${n}`);
    // Derived from the fixture's id sequence: an event takes N, its own turn N + 1.
    expect(
      Object.fromEntries([...census.claimEventIds].map(([f, events]) => [f, [...events].sort()])),
    ).toEqual({
      C7: ids("event", [0, 10, 12, 6, 8]),
      C3: ids("event", [15]),
      C4: ids("event", [17, 19, 21, 23, 25]),
      C1: ids("event", [27, 29, 31]),
      // event-14, the NOT_FOUND read in C7's turn-13, stays out of C2.
      C2: ids("event", [33, 35]),
      C9: ids("metric", [39, 44]),
      // turn-50 is D14's re-plan turn and adds no event.
      D14: ids("event", [47]),
      D11: ids("event", [51, 53, 55]),
    });
    expect([...census.loopExcessEvents]).toEqual([
      ["event-2", `${S1}|turn-3`],
      ["event-4", `${S1}|turn-5`],
    ]);
  });

  it("maps every family onto its census cause and pattern code", () => {
    buildFixture();
    const census = buildReliabilityCensus(db, 7, NOW);
    const patterns = Object.fromEntries(census.causes.map((c) => [c.cause_id, c.patterns]));
    expect(patterns).toEqual({
      BLOCKED_BY_PERMISSIONS: [{ code: "C9", count: 2 }],
      INTERRUPTED_OR_CANCELLED: [{ code: "D2", count: 2 }],
      SHELL_FAILS_IN_BURSTS: [{ code: "C7", count: 5 }],
      TOOLS_FAIL_MORE_THAN_USUAL: [
        { code: "C1", count: 3 },
        { code: "D11", count: 3 },
        { code: "G11", count: 0 },
      ],
      AGENT_REPEATS_SAME_ERROR: [{ code: "D7_RETRY_LOOP+C5", count: 2 }],
      EDITS_FAIL_OR_UNDONE: [
        { code: "C3", count: 1 },
        { code: "C4", count: 5 },
        { code: "C6", count: 0 },
      ],
      SEARCHES_FOR_MISSING_CONTENT: [{ code: "C2", count: 2 }],
    });
  });
});

/** Captured from `wastedTurnClaims` on `main` (dee76445), before the census existed. */
const turns = (session: string, ids: number[]) => ids.map((id) => `${session}|turn-${id}`);
const PINNED = JSON.stringify([
  // turn-3 and turn-5 are the D7 loop's repeat-excess calls, so no family claims them.
  ["C7", turns(S1, [1, 7, 9, 11, 13])],
  ["C3", turns(S1, [16])],
  ["C4", turns(S1, [18, 20, 22, 24, 26])],
  ["C1", turns(S1, [28, 30, 32])],
  ["C2", turns(S2, [34, 36])],
  ["C9", turns(S2, [38, 41, 43, 46])],
  ["D14", turns(S2, [48, 50])],
  ["D11", turns(S2, [52, 54, 56])],
]);

/**
 * Review 5 U1: a turn that is both a D7 repeat-excess turn and a C1 error turn is priced by D7
 * only. Known divergences, not fixed here: this ledger runs `includeFrictionSignals: true` while
 * D7 gates friction signals by session coverage (that can only lower C1's $, never inflate it);
 * D7's SQL does not filter `is_sidechain`, the ledger does.
 */
describe("D7 loops and C1 do not price the same turn (review 5 U1)", () => {
  it("leaves D7's repeat-excess error turns out of C1's claimed set", () => {
    // Three WebFetch errors with the same error text within 120 s: a repeated-error run (U9 r4: a
    // different error text is not a repeat), so D7 prices calls 2 and 3.
    const first = addEvent("WebFetch", at(0), { exitClass: "ERROR", error: "fetch failed" });
    const second = addEvent("WebFetch", at(20), { exitClass: "ERROR", error: "fetch failed" });
    const third = addEvent("WebFetch", at(40), { exitClass: "ERROR", error: "fetch failed" });
    // Successful reads keep the corpus rate low, so WebFetch is over twice it (C1 fires).
    for (let i = 0; i < 40; i++) addEvent("Read", at(1000 + i));
    // C1 needs 20 WebFetch calls (card review F4).
    for (let i = 0; i < 17; i++) addEvent("WebFetch", at(2000 + i));
    for (let i = 0; i < 20; i++) addEvent("Read", at(3000 + i));

    const d7 = d7Detector
      .evaluate(db, CTX)
      .fired.find((fired) => fired.payload.template_id === "D7_RETRY_LOOP");
    const facts = d7?.payload.facts as Record<string, unknown>;
    expect(facts.repeat_excess_turn_count).toBe(2);
    // Each fixture turn is stored at 100 µUSD: D7 prices the two repeat turns, 200.
    expect(facts.repeat_excess_cost_u).toBe(200);

    const c1 = wastedTurnClaims(db, CTX).get("C1") ?? new Set();
    expect([...c1]).toEqual([`${S1}|${first}`]);
    expect(c1.has(`${S1}|${second}`)).toBe(false);
    expect(c1.has(`${S1}|${third}`)).toBe(false);
  });
});
