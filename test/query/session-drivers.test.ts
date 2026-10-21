import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d8Detector } from "../../src/detector/detectors/d8_cache_write_churn.js";
import type { RecommendationTemplateId } from "../../src/detector/privacy-contract.js";
import { getSessionDrivers } from "../../src/query/api/index.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const REFERENCE = "2027-06-20T12:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

function insWs(workspaceId: string): void {
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  ).run(workspaceId, workspaceId, REFERENCE);
}

function insSess(sessionId: string, workspaceId: string, costEquivU: number, ts = REFERENCE): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',1,?,'[]')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`, ts, ts, costEquivU);
}

function insRec({
  recId,
  detectorId,
  workspaceId,
  evidence,
  modeledSavings = null,
}: {
  recId: string;
  detectorId: string;
  workspaceId: string | null;
  evidence: Record<string, unknown>;
  modeledSavings?: number | null;
}): void {
  const templates: Record<string, RecommendationTemplateId> = {
    D2: "D2_LONG_FULL_CONTEXT",
    D4: "D4_MODEL_MISMATCH",
    D6: "D6_TOOL_RESULT_BLOAT",
    D7: "D7_RETRY_LOOP",
    D8: "D8_CACHE_WRITE_CHURN",
  };
  const templateId = templates[detectorId];
  if (templateId === undefined) throw new Error(`missing fixture template for ${detectorId}`);
  seedValidatedRecommendation(db, {
    recId,
    templateId,
    scope: workspaceId,
    savings: modeledSavings,
    createdAt: REFERENCE,
    facts: evidence,
  });
}

function dataFor(sessionId: string) {
  const data = getSessionDrivers(db, sessionId).data;
  if (data === null) throw new Error("expected session drivers");
  return data;
}

describe("getSessionDrivers", () => {
  it("sums only detector-flagged turns within a synthetic session", () => {
    insWs("ws-cost");
    insSess("sess-cost", "ws-cost", 10_000_000);
    const common = { workspace_id: "ws-cost", session_ids: ["sess-cost"], session_count: 1 };
    const evidenceByDetector = {
      D2: {
        session_ids: ["sess-cost"],
        qualifying_session_count: 1,
        qualifying_turn_count: 1,
        raw_context_average_tokens_per_turn: 190_000,
        cap_weighted_burn_tokens_per_week: 1,
        cache_read_tokens_per_week: 0,
        cap_read_coefficient: 0,
      },
      D6: {
        ...common,
        tool_result_bytes: 1_000,
        session_cap_weighted_tokens: 1_000,
        bloat_share: 0.5,
        turn_count: 4,
        bytes_per_token: 4,
      },
      D7: {
        ...common,
        loop_flagged_event_count: 3,
        loop_flagged_turn_count: 3,
        repeat_excess_event_count: 2,
        repeat_excess_turn_count: 2,
        total_turn_count: 4,
        loop_flagged_turn_share: 0.75,
        owner_turn_metadata_coverage: 1,
        owner_turn_metadata_covered_event_count: 3,
        owner_turn_metadata_denominator_event_count: 3,
        identical_call_event_count: 3,
        test_fail_event_count: 0,
        redundant_read_event_count: 0,
        three_gram_loop_event_count: 0,
        error_loop_event_count: 0,
        edit_without_prior_read_event_count: 0,
        owner_turn_metadata_coverage_floor: 0.8,
        friction_signals_suppressed_below_coverage_floor: false,
        repeat_excess_turn_cap_weighted_tokens: 1,
      },
      D8: {
        ...common,
        churn_event_count: 1,
        total_churn_creation_tokens: 60_000,
        session_cap_weighted_tokens: 1_000,
        creation_share: 0.5,
        cache_read_to_creation_ratio: 0,
        regime: "5m",
      },
    };
    for (const detectorId of ["D2", "D6", "D7", "D8"] as const) {
      insRec({
        recId: `rec-${detectorId.toLowerCase()}-cost`,
        detectorId,
        workspaceId: "ws-cost",
        evidence: evidenceByDetector[detectorId],
      });
    }
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, input_tokens,
          cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_equiv_u, parser_version)
       VALUES (?, 'sess-cost', 'ws-cost', ?, 'synthetic-model', ?, ?, ?, ?, 0, ?, 'test')`,
    );
    insertTurn.run("turn-1", "2027-06-20T10:00:00.000Z", 1_000, 0, 0, 0, 1_000_000);
    insertTurn.run("turn-2", "2027-06-20T10:10:00.000Z", 1_000, 0, 60_000, 0, 2_000_000);
    insertTurn.run("turn-3", "2027-06-20T10:20:00.000Z", 190_000, 0, 0, 0, 3_000_000);
    insertTurn.run("turn-4", "2027-06-20T10:30:00.000Z", 1_000, 0, 0, 0, 4_000_000);
    const insertEvent = db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_hash)
       VALUES (?, 'sess-cost', ?, 'Glob', 'synthetic-hash')`,
    );
    const insertOwner = db.prepare(
      `INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command)
       VALUES (?, ?, 0, 0)`,
    );
    for (const [eventId, owner, ts] of [
      ["event-1", "turn-1", "2027-06-20T10:01:00.000Z"],
      ["event-2", "turn-2", "2027-06-20T10:11:00.000Z"],
      ["event-3", "turn-3", "2027-06-20T10:21:00.000Z"],
    ]) {
      insertEvent.run(eventId, ts);
      insertOwner.run(eventId, owner);
    }

    const drivers = dataFor("sess-cost").drivers;
    const costs = Object.fromEntries(
      drivers.map((driver) => [driver.detector_id, driver.session_cost_u]),
    );
    expect(costs).toEqual({ D2: 3_000_000, D6: undefined, D7: 6_000_000, D8: 2_000_000 });
    expect("session_cost_u" in (drivers.find((driver) => driver.detector_id === "D6") ?? {})).toBe(
      false,
    );
    for (const cost of Object.values(costs)) {
      if (cost !== undefined) expect(cost).toBeLessThanOrEqual(10_000_000);
    }
  });

  it("routes only the affected D7 session to its matching recommendation", () => {
    insWs("ws-loop");
    insSess("sess-loop", "ws-loop", 100);
    insSess("sess-quiet", "ws-loop", 100);
    insRec({
      recId: "rec-loop",
      detectorId: "D7",
      workspaceId: "ws-loop",
      evidence: {
        workspace_id: "ws-loop",
        session_ids: ["sess-loop"],
        session_count: 1,
        loop_flagged_turn_share: 0.5,
      },
    });
    expect(dataFor("sess-loop").drivers).toEqual([
      expect.objectContaining({ detector_id: "D7", rec_id: "rec-loop", routing: "rec_card" }),
    ]);
    expect(dataFor("sess-quiet").drivers).toEqual([]);
  });

  it("keeps the highest-ranked D7 recommendation for a shared session", () => {
    insWs("ws-duplicate");
    insSess("sess-duplicate", "ws-duplicate", 100);
    for (const [recId, savings, share] of [
      ["rec-lower", 1_000_000, 0.9],
      ["rec-higher", 2_000_000, 0.2],
    ] as const) {
      insRec({
        recId,
        detectorId: "D7",
        workspaceId: "ws-duplicate",
        modeledSavings: savings,
        evidence: {
          workspace_id: "ws-duplicate",
          session_ids: ["sess-duplicate"],
          session_count: 1,
          loop_flagged_turn_share: share,
        },
      });
    }

    expect(dataFor("sess-duplicate").drivers).toEqual([
      expect.objectContaining({ detector_id: "D7", rec_id: "rec-higher" }),
    ]);
  });

  it("groups classified tool errors for only the requested session", () => {
    insWs("ws-errors");
    insSess("sess-errors", "ws-errors", 100);
    insSess("sess-other", "ws-errors", 100);
    const insert = db.prepare(
      `INSERT INTO tool_events
         (event_id, session_id, ts, tool_name, tool_error_class,
          tool_error_classifier_version, bash_command_family)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const events = [
      ["event-1", "sess-errors", "Bash", "NOT_FOUND", "BASH_GIT"],
      ["event-2", "sess-errors", "Bash", "NOT_FOUND", "BASH_GIT"],
      ["event-3", "sess-errors", "Edit", "STALE_STRING", null],
      ["event-4", "sess-errors", "Bash", "NOT_FOUND", "BASH_NPM"],
      ["event-5", "sess-errors", "Bash", null, "BASH_GIT"],
      ["event-6", "sess-other", "Bash", "NOT_FOUND", "BASH_GIT"],
    ] as const;
    for (const [id, sessionId, tool, errorClass, family] of events) {
      insert.run(id, sessionId, REFERENCE, tool, errorClass, errorClass && "tool-error-1", family);
    }

    expect(dataFor("sess-errors").tool_error_breakdown).toEqual([
      {
        tool_name: "Bash",
        tool_error_class: "NOT_FOUND",
        bash_command_family: "BASH_GIT",
        count: 2,
      },
      {
        tool_name: "Bash",
        tool_error_class: "NOT_FOUND",
        bash_command_family: "BASH_NPM",
        count: 1,
      },
      { tool_name: "Edit", tool_error_class: "STALE_STRING", bash_command_family: null, count: 1 },
    ]);
    expect(dataFor("sess-other").tool_error_breakdown).toEqual([
      {
        tool_name: "Bash",
        tool_error_class: "NOT_FOUND",
        bash_command_family: "BASH_GIT",
        count: 1,
      },
    ]);
  });

  it("returns D6 and D8 drivers with only whitelisted measurements", () => {
    insWs("ws-drivers");
    insSess("sess-drivers", "ws-drivers", 100);
    insRec({
      recId: "rec-d6",
      detectorId: "D6",
      workspaceId: "ws-drivers",
      evidence: {
        workspace_id: "ws-drivers",
        session_ids: ["sess-drivers"],
        session_count: 1,
        tool_result_bytes: 1024,
        bloat_share: 0.6,
        turn_count: 4,
      },
    });
    insRec({
      recId: "rec-d8",
      detectorId: "D8",
      workspaceId: "ws-drivers",
      evidence: {
        workspace_id: "ws-drivers",
        session_ids: ["sess-drivers"],
        session_count: 1,
        churn_event_count: 3,
        total_churn_creation_tokens: 400,
        creation_share: 0.4,
        regime: "5m",
      },
    });

    const drivers = dataFor("sess-drivers").drivers;
    expect(drivers).toHaveLength(2);
    const d6 = drivers.find((driver) => driver.detector_id === "D6");
    const d8 = drivers.find((driver) => driver.detector_id === "D8");
    expect(d6).toMatchObject({ rec_id: "rec-d6", routing: "rec_card", share: 0.6 });
    expect(d8).toMatchObject({ rec_id: "rec-d8", routing: "hook", share: 0.4 });
    expect(Object.keys(d6?.measured ?? {}).sort()).toEqual([
      "bloat_share",
      "tool_result_bytes",
      "turn_count",
    ]);
    expect(Object.keys(d8?.measured ?? {}).sort()).toEqual([
      "churn_event_count",
      "creation_share",
      "regime",
      "total_churn_creation_tokens",
    ]);
  });

  it("includes D2 only through its session_ids membership", () => {
    insWs("ws-d2");
    insSess("sess-d2", "ws-d2", 100);
    insRec({
      recId: "rec-d2",
      detectorId: "D2",
      workspaceId: null,
      evidence: { session_ids: ["sess-d2"], qualifying_session_count: 1 },
    });

    expect(dataFor("sess-d2").drivers).toEqual([
      expect.objectContaining({
        detector_id: "D2",
        measured: { in_long_context_group: true },
        share: null,
        routing: "hook",
      }),
    ]);
  });

  it("excludes D4 recommendations", () => {
    insWs("ws-d4");
    insSess("sess-d4", "ws-d4", 100);
    insRec({
      recId: "rec-d4",
      detectorId: "D4",
      workspaceId: "ws-d4",
      evidence: { workspace_id: "ws-d4" },
    });

    expect(dataFor("sess-d4").drivers).toEqual([]);
  });

  it("converts modeled micro-USD savings and omits unmodeled savings", () => {
    insWs("ws-savings");
    insSess("sess-savings", "ws-savings", 100);
    insRec({
      recId: "rec-priced",
      detectorId: "D8",
      workspaceId: "ws-savings",
      modeledSavings: 1_250_000,
      evidence: {
        workspace_id: "ws-savings",
        session_ids: ["sess-savings"],
        session_count: 1,
        creation_share: 0.5,
      },
    });
    insRec({
      recId: "rec-unpriced",
      detectorId: "D6",
      workspaceId: "ws-savings",
      evidence: {
        workspace_id: "ws-savings",
        session_ids: ["sess-savings"],
        session_count: 1,
        bloat_share: 0.7,
      },
    });

    const drivers = dataFor("sess-savings").drivers;
    expect(drivers.find((driver) => driver.rec_id === "rec-priced")?.approx_usd).toBe(1.25);
    const unpriced = drivers.find((driver) => driver.rec_id === "rec-unpriced");
    expect(unpriced).toBeDefined();
    expect("approx_usd" in (unpriced ?? {})).toBe(false);
  });

  it("computes a 30-day percentile from sessions at or below the target cost", () => {
    insWs("ws-percentile");
    insSess("sess-100", "ws-percentile", 100);
    insSess("sess-200", "ws-percentile", 200);
    insSess("sess-300", "ws-percentile", 300);
    insSess("sess-400", "ws-percentile", 400);

    expect(dataFor("sess-300").percentile).toBe(75);
  });

  it("returns no drivers and a low percentile for a cheap session", () => {
    insWs("ws-cheap");
    insSess("sess-cheap", "ws-cheap", 100);
    insSess("sess-mid", "ws-cheap", 200);
    insSess("sess-high", "ws-cheap", 300);
    insSess("sess-higher", "ws-cheap", 400);

    const data = dataFor("sess-cheap");
    expect(data.drivers).toEqual([]);
    expect(data.tool_error_breakdown).toEqual([]);
    expect(data.percentile).toBeLessThan(75);
  });

  it("returns null data for an unknown session", () => {
    expect(getSessionDrivers(db, "nope").data).toBeNull();
  });
});

describe("D8 driver cost uses the detector's per-thread TTL walk (P3.2-F5)", () => {
  type Thread = { sidechain: 0 | 1; agent: string | null };
  const MAIN: Thread = { sidechain: 0, agent: null };
  const AGENT_A: Thread = { sidechain: 1, agent: "agent-a" };

  function setUp(sessionId: string): void {
    insWs(`ws-${sessionId}`);
    insSess(sessionId, `ws-${sessionId}`, 10_000_000);
  }

  function insTurn(
    sessionId: string,
    id: string,
    hhmm: string,
    thread: Thread,
    write5m: number,
    write1h: number,
    cost: number,
  ): void {
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, agent_id,
          input_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_equiv_u, parser_version)
       VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', ?, ?, 0, 0, ?, ?, 0, ?, 'test')`,
    ).run(
      id,
      sessionId,
      `ws-${sessionId}`,
      `2027-06-20T${hhmm}:00.000Z`,
      thread.sidechain,
      thread.agent,
      write5m,
      write1h,
      cost,
    );
  }

  function d8Cost(sessionId: string, facts?: Record<string, unknown>): number | undefined {
    insRec({
      recId: `rec-d8-${sessionId}`,
      detectorId: "D8",
      workspaceId: `ws-${sessionId}`,
      evidence: facts ?? {
        workspace_id: `ws-${sessionId}`,
        session_ids: [sessionId],
        session_count: 1,
        creation_share: 0.5,
      },
    });
    return dataFor(sessionId).drivers.find((d) => d.detector_id === "D8")?.session_cost_u;
  }

  it("(a) takes the TTL from the thread's prior write tier, not the current turn's", () => {
    setUp("sess-tier");
    insTurn("sess-tier", "t-1", "10:00", MAIN, 0, 1_000, 1);
    // 10 min later, mostly 5m: the thread's 1h tier keeps this inside its 60-min TTL.
    insTurn("sess-tier", "t-2", "10:10", MAIN, 60_000, 0, 100);
    expect(d8Cost("sess-tier")).toBe(0);
  });

  it("(b) leaves subagent resumes out", () => {
    setUp("sess-sub");
    insTurn("sess-sub", "t-1", "10:00", MAIN, 0, 0, 1);
    insTurn("sess-sub", "t-2", "10:20", AGENT_A, 1_000, 0, 10);
    insTurn("sess-sub", "t-3", "10:28", AGENT_A, 60_000, 0, 100);
    expect(d8Cost("sess-sub")).toBe(0);
  });

  it("(c) measures the gap to the previous turn of the same thread", () => {
    setUp("sess-mix");
    insTurn("sess-mix", "t-1", "10:00", MAIN, 0, 1_000, 1);
    insTurn("sess-mix", "t-2", "11:08", AGENT_A, 1_000, 0, 10);
    // 2 min after the subagent turn, but 70 min after the previous main turn.
    insTurn("sess-mix", "t-3", "11:10", MAIN, 0, 60_000, 100);
    expect(d8Cost("sess-mix")).toBe(100);
  });

  it("flags the same turns the D8 detector reports for the session", () => {
    const sid = "sess-oracle";
    setUp(sid);
    // cost = 1_000_000 + creation, so the D8 sum encodes both the count and the creation of
    // the flagged turns, which the detector reports as churn_event_count and total creation.
    const turns: [string, string, Thread, number, number][] = [
      ["o-0", "06:00", MAIN, 0, 0],
      ["o-1", "06:01", MAIN, 0, 1_000],
      ["o-2", "06:11", MAIN, 61_000, 0], // shape (a)
      ["o-3", "06:20", AGENT_A, 1_000, 0],
      ["o-4", "06:28", AGENT_A, 62_000, 0], // shape (b)
      ["o-5", "07:19", AGENT_A, 1_000, 0],
      ["o-6", "07:21", MAIN, 0, 63_000], // shape (c)
      ["o-7", "08:40", MAIN, 0, 64_000],
      ["o-8", "10:00", MAIN, 0, 65_000],
    ];
    for (const [id, hhmm, thread, w5m, w1h] of turns) {
      insTurn(sid, id, hhmm, thread, w5m, w1h, 1_000_000 + w5m + w1h);
    }

    const fired = d8Detector.evaluate(db, {
      now: new Date(REFERENCE),
      fromIso: "2027-06-20T00:00:00.000Z",
      toIso: REFERENCE,
    }).fired;
    expect(fired).toHaveLength(1);
    const facts = fired[0]?.payload.facts as Record<string, unknown>;
    expect(facts.churn_event_count).toBeGreaterThan(0);

    expect(d8Cost(sid, facts)).toBe(
      (facts.churn_event_count as number) * 1_000_000 +
        (facts.total_churn_creation_tokens as number),
    );
  });
});
