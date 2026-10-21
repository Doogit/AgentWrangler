import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";
import { findingIds } from "../../../src/detector/privacy-contract.js";
import {
  type CensusRow,
  type ReliabilityCensus,
  buildReliabilityCensus,
  trendOf,
} from "../../../src/query/api/diagnostics-census.js";

const AS_OF = new Date("2027-01-08T00:00:00.000Z");
const WS = "ws-census";
const IN_WINDOW_MS = new Date("2027-01-03T10:00:00.000Z").getTime();
const PREVIOUS_MS = new Date("2026-12-28T10:00:00.000Z").getTime();

let db: Database.Database;
let sequence = 0;

const at = (offsetSeconds: number, base = IN_WINDOW_MS): string =>
  new Date(base + offsetSeconds * 1_000).toISOString();

function addSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, '/fixture/census.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(sessionId, WS, "2026-12-01T00:00:00.000Z", AS_OF.toISOString());
}

function addTurn(sessionId: string, ts: string, costU = 100): string {
  const messageId = `turn-${sequence++}`;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id,
        cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?, ?, ?, ?, 'claude-sonnet', 0, 0, 0, 0, 0, 0, 0, 0, NULL,
             ?, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(messageId, sessionId, WS, ts, costU);
  return messageId;
}

function addEvent(
  sessionId: string,
  toolName: string,
  ts: string,
  options: {
    exitClass?: "ERROR" | "OK";
    errorClass?: string;
    interruptKind?: "HUMAN_DENY";
    family?: string;
    command?: string;
    error?: string;
    turn?: string;
  } = {},
): string {
  const eventId = `event-${sequence++}`;
  const messageId = options.turn ?? addTurn(sessionId, ts);
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
     VALUES (?, NULL, ?, ?, 0)`,
  ).run(eventId, messageId, sequence);
  if (options.command !== undefined || options.error !== undefined)
    db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
      eventId,
      JSON.stringify({ command: options.command, error: options.error }),
    );
  return messageId;
}

function addIngest(
  sessionId: string,
  ts: string,
  options: { label?: string; destructiveOp?: string; sidechain?: boolean },
): void {
  db.prepare(
    `INSERT INTO ingest_metric_events
       (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error,
        is_interrupt, classifier_label, command_shape, event_ts, is_sidechain, destructive_op)
     VALUES (?, ?, NULL, 0, 0, 0, 0, ?, NULL, ?, ?, ?)`,
  ).run(
    `metric-${sequence++}`,
    sessionId,
    options.label ?? null,
    ts,
    options.sidechain === true ? 1 : 0,
    options.destructiveOp ?? null,
  );
}

function addFinding(detectorId: string, anchors: Array<{ session: string; ts: string }>): void {
  const evidence = {
    anchors: anchors.map((a, i) => ({
      event_id: `eid-${i}`,
      session_id: findingIds.session(a.session),
      timestamp: a.ts,
    })),
  };
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_formula_json, evidence_json, target_metric, state, created_at)
     VALUES (?, 'RULE', ?, 'RELIABILITY', ?, 'x', '{}', ?, 'x', 'DISMISSED', '2027-01-01')`,
  ).run(`rec-${sequence++}`, detectorId, WS, JSON.stringify(evidence));
}

const cause = (census: ReliabilityCensus, causeId: string): CensusRow => {
  const row = census.causes.find((c) => c.cause_id === causeId);
  if (row === undefined) throw new Error(`no row ${causeId}`);
  return row;
};

beforeEach(() => {
  // Migrated but unseeded: the history rule reads the DB's first turn, so every row is the test's.
  db = new Database(":memory:");
  runMigrations(db);
  sequence = 0;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(WS, WS, "2026-12-01T00:00:00.000Z");
  for (const s of ["s1", "s2", "s3", "s4"]) addSession(s);
});
afterEach(() => db.close());

describe("buildReliabilityCensus (P4 U3a)", () => {
  it("counts blocks as events, with sessions and the label breakdown", () => {
    for (const s of ["s1", "s2", "s3"]) addTurn(s, at(0));
    addIngest("s1", at(10), { label: "hook-block" });
    addIngest("s1", at(20), { label: "hook-block" });
    addEvent("s1", "Write", at(25), { interruptKind: "HUMAN_DENY" });
    addIngest("s1", at(30), { label: "user-rejected" });

    const census = buildReliabilityCensus(db, 7, AS_OF);
    const blocked = cause(census, "BLOCKED_BY_PERMISSIONS");
    expect(blocked.occurrences).toBe(3);
    expect(blocked.sessions_affected).toBe(1);
    expect(blocked.share).toBeCloseTo(1 / 3);
    expect(blocked.breakdown).toEqual([
      { label: "hook-block", count: 2 },
      { label: "user-rejected", count: 1 },
    ]);
    expect(blocked.sessions).toEqual([{ session_id: "s1", occurrences: 3 }]);
    expect(blocked.event_ids).toEqual(["metric-3", "metric-4", "metric-7"]);
  });

  it("does not count a rejected AskUserQuestion, which is an answer", () => {
    addTurn("s1", at(0));
    addEvent("s1", "AskUserQuestion", at(5), { interruptKind: "HUMAN_DENY" });
    addIngest("s1", at(6), { label: "user-rejected" });

    expect(cause(buildReliabilityCensus(db, 7, AS_OF), "BLOCKED_BY_PERMISSIONS").occurrences).toBe(
      0,
    );
  });

  it("does not count a destructive command on a sidechain", () => {
    addTurn("s1", at(0));
    addIngest("s1", at(5), { destructiveOp: "rm-rf" });
    addIngest("s1", at(6), { destructiveOp: "git-reset-hard", sidechain: true });

    const risk = buildReliabilityCensus(db, 7, AS_OF).risk;
    expect(risk.cause_id).toBe("DESTRUCTIVE_COMMANDS_RAN");
    expect(risk.occurrences).toBe(1);
    expect(risk.breakdown).toEqual([{ label: "rm-rf", count: 1 }]);
  });

  it("counts a turn holding both a C7 and a C2 event once, in C7", () => {
    let lastTurn = "";
    for (const offset of [0, 300, 600])
      lastTurn = addEvent("s1", "Bash", at(offset), {
        exitClass: "ERROR",
        family: "BASH_GIT",
        command: `synthetic-git step-${offset}`,
        error: "Exit code 1\nsynthetic refusal",
      });
    addEvent("s1", "Read", at(600), {
      exitClass: "ERROR",
      errorClass: "NOT_FOUND",
      turn: lastTurn,
    });
    for (let i = 0; i < 40; i++) addEvent("s1", "Read", at(900 + i));

    const census = buildReliabilityCensus(db, 7, AS_OF);
    expect(cause(census, "SHELL_FAILS_IN_BURSTS").occurrences).toBe(3);
    expect(cause(census, "SHELL_FAILS_IN_BURSTS").event_ids).toEqual([
      "event-0",
      "event-2",
      "event-4",
    ]);
    expect(cause(census, "SEARCHES_FOR_MISSING_CONTENT").occurrences).toBe(0);
    expect(cause(census, "SEARCHES_FOR_MISSING_CONTENT").event_ids).toEqual([]);
  });

  it("counts the loop pool's repeated calls", () => {
    for (const offset of [0, 20, 40])
      addEvent("s1", "Bash", at(offset), {
        exitClass: "ERROR",
        family: "BASH_OTHER",
        command: "synthetic-loop --flag",
        error: "Exit code 2\nsynthetic loop failure",
      });

    const loop = cause(buildReliabilityCensus(db, 7, AS_OF), "AGENT_REPEATS_SAME_ERROR");
    expect(loop.occurrences).toBe(2);
    expect(loop.sessions_affected).toBe(1);
    // The first call of the run is not an excess call.
    expect(loop.event_ids).toEqual(["event-2", "event-4"]);
  });

  it("uses an end-exclusive window", () => {
    addTurn("s1", at(0));
    addIngest("s1", "2027-01-01T00:00:00.000Z", { label: "hook-block" });
    addIngest("s1", AS_OF.toISOString(), { label: "hook-block" });

    expect(cause(buildReliabilityCensus(db, 7, AS_OF), "BLOCKED_BY_PERMISSIONS").occurrences).toBe(
      1,
    );
  });

  it("counts friction sessions across Reliability causes only, not the risk row", () => {
    addTurn("s1", at(0));
    addTurn("s2", at(0));
    addIngest("s1", at(5), { label: "deny-rule" });
    addIngest("s2", at(5), { destructiveOp: "rm-rf" });

    const census = buildReliabilityCensus(db, 7, AS_OF);
    expect(census.tiles.session_count).toBe(2);
    expect(census.tiles.friction_sessions).toBe(1);
    expect(census.tiles.friction_share).toBe(0.5);
    expect(census.risk.sessions_affected).toBe(1);
  });

  it("counts a session in two Reliability causes once in friction", () => {
    addTurn("s1", at(0));
    addTurn("s2", at(0));
    addIngest("s1", at(5), { label: "deny-rule" });
    addFinding("C6", [{ session: "s1", ts: at(10) }]);

    const census = buildReliabilityCensus(db, 7, AS_OF);
    expect(cause(census, "BLOCKED_BY_PERMISSIONS").sessions_affected).toBe(1);
    expect(cause(census, "EDITS_FAIL_OR_UNDONE").sessions_affected).toBe(1);
    expect(census.tiles.friction_sessions).toBe(1);
  });

  it("counts C6 and G11 from in-window anchors, a lower bound when a list is at the cap", () => {
    addTurn("s1", at(0));
    addFinding("C6", [
      { session: "s1", ts: at(10) },
      { session: "s1", ts: at(20) },
      { session: "s2", ts: at(30) },
      { session: "s2", ts: "2026-12-01T00:00:00.000Z" },
      { session: "s3", ts: "2026-12-02T00:00:00.000Z" },
    ]);
    addFinding("G11", [{ session: "s3", ts: at(40) }]);

    const census = buildReliabilityCensus(db, 7, AS_OF);
    const edits = cause(census, "EDITS_FAIL_OR_UNDONE");
    expect(edits.patterns).toEqual([
      { code: "C3", count: 0 },
      { code: "C4", count: 0 },
      { code: "C6", count: 3 },
    ]);
    expect(edits.sessions_affected_is_lower_bound).toBe(true);
    expect(edits.sessions).toEqual([
      { session_id: "s1", occurrences: 2 },
      { session_id: "s2", occurrences: 1 },
    ]);
    const tools = cause(census, "TOOLS_FAIL_MORE_THAN_USUAL");
    expect(tools.occurrences).toBe(1);
    expect(tools.sessions_affected_is_lower_bound).toBe(false);
  });

  it("keeps an anchor with no session row hashed", () => {
    addTurn("s1", at(0));
    addFinding("C6", [{ session: "ghost", ts: at(10) }]);

    expect(cause(buildReliabilityCensus(db, 7, AS_OF), "EDITS_FAIL_OR_UNDONE").sessions).toEqual([
      { session_id: findingIds.session("ghost"), occurrences: 1 },
    ]);
  });

  it("is not a lower bound when a capped anchor list has no in-window anchor", () => {
    addTurn("s1", at(0));
    addFinding(
      "C6",
      ["s1", "s2", "s3", "s4", "s1"].map((session, i) => ({
        session,
        ts: `2026-12-0${i + 1}T00:00:00.000Z`,
      })),
    );

    const edits = cause(buildReliabilityCensus(db, 7, AS_OF), "EDITS_FAIL_OR_UNDONE");
    expect(edits.occurrences).toBe(0);
    expect(edits.sessions_affected_is_lower_bound).toBe(false);
  });

  it("gives null shares when the window has no sessions", () => {
    const census = buildReliabilityCensus(db, 7, AS_OF);
    expect(census.tiles.session_count).toBe(0);
    expect(census.tiles.friction_share).toBeNull();
    expect(census.causes.every((c) => c.share === null)).toBe(true);
    expect(census.risk.share).toBeNull();
  });

  it("gives null shares when the window's sessions have no spend", () => {
    addTurn("s1", at(0), 0);
    addTurn("s2", at(0), 0);
    addIngest("s1", at(5), { label: "hook-block" });
    addIngest("s2", at(5), { destructiveOp: "rm-rf" });

    const census = buildReliabilityCensus(db, 7, AS_OF);
    expect(census.tiles.session_count).toBe(2);
    expect(census.tiles.friction_sessions).toBe(1);
    expect(census.tiles.friction_share).toBeNull();
    expect(cause(census, "BLOCKED_BY_PERMISSIONS").share).toBeNull();
    expect(census.risk.share).toBeNull();
  });

  describe("trend", () => {
    const HISTORY = "2026-12-20T00:00:00.000Z";
    const ALL = ["s1", "s2", "s3", "s4"];
    /**
     * All four sessions have turns in the current window, `previousSessions` in the previous one;
     * blocks spread as given. `firstTurn` adds an earlier turn, which sets the DB's history.
     */
    function blocks(
      current: string[],
      previous: string[],
      options: { firstTurn?: string; previousSessions?: string[] } = {},
    ): CensusRow {
      if (options.firstTurn !== undefined) addTurn("s1", options.firstTurn);
      for (const s of ALL) addTurn(s, at(0));
      for (const s of options.previousSessions ?? ALL) addTurn(s, at(0, PREVIOUS_MS));
      current.forEach((s, i) => addIngest(s, at(10 + i), { label: "hook-block" }));
      previous.forEach((s, i) => addIngest(s, at(10 + i, PREVIOUS_MS), { label: "hook-block" }));
      return cause(buildReliabilityCensus(db, 7, AS_OF), "BLOCKED_BY_PERMISSIONS");
    }
    const ten = ["s1", "s2", "s3", "s4", "s1", "s2", "s3", "s4", "s1", "s2"];
    const tenInTwo = ["s1", "s2", "s1", "s2", "s1", "s2", "s1", "s2", "s1", "s2"];
    const five = ["s1", "s2", "s1", "s2", "s1"];

    it("rises on 10 vs 5 at equal session counts", () => {
      const row = blocks(ten, five, { firstTurn: HISTORY });
      expect(row.previous).toEqual({ occurrences: 5, sessions_affected: 2, rate: 0.5 });
      expect(row.trend).toBe("rising");
    });

    it("reads steady when occurrences double but the affected-session rate is flat", () => {
      expect(blocks(tenInTwo, five, { firstTurn: HISTORY }).trend).toBe("steady");
    });

    it("falls on session rates when the windows have different session counts", () => {
      // Current 2 of 4 sessions affected; previous 2 of 2.
      const row = blocks(tenInTwo, five, { firstTurn: HISTORY, previousSessions: ["s1", "s2"] });
      expect(row.previous).toEqual({ occurrences: 5, sessions_affected: 2, rate: 1 });
      expect(row.trend).toBe("falling");
    });

    it("reads steady when the previous window has blocks but no sessions", () => {
      const row = blocks(ten, five, { firstTurn: HISTORY, previousSessions: [] });
      expect(row.previous).toEqual({ occurrences: 5, sessions_affected: 2, rate: null });
      expect(row.trend).toBe("steady");
    });

    it("reads steady when the previous window starts before the first turn", () => {
      expect(blocks(ten, five).trend).toBe("steady");
    });

    it("has history when the first turn is exactly at the previous window's start", () => {
      expect(blocks(ten, five, { firstTurn: "2026-12-25T00:00:00.000Z" }).trend).toBe("rising");
    });

    it("reads steady below the floor of 5 in either window", () => {
      expect(trendOf({ occurrences: 4, rate: 0.1 }, { occurrences: 40, rate: 0.9 }, true)).toBe(
        "steady",
      );
      expect(trendOf({ occurrences: 5, rate: 0.1 }, { occurrences: 40, rate: 0.9 }, true)).toBe(
        "falling",
      );
    });

    it("rises at a ratio of 1.25 and falls at 0.8, inclusive", () => {
      const vs = (rate: number) =>
        trendOf({ occurrences: 5, rate }, { occurrences: 5, rate: 1 }, true);
      expect(vs(1.25)).toBe("rising");
      expect(vs(1.24)).toBe("steady");
      expect(vs(0.81)).toBe("steady");
      expect(vs(0.8)).toBe("falling");
    });
  });
});
