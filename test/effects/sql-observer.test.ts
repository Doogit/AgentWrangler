import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createEffectEngine,
  createSqlObservationProvider,
  effectEventSourceIdentity,
  effectToolIdentity,
} from "../../src/effects/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const APPLIED = "2026-02-01T00:00:00.000Z";

function rec(db: Database.Database, id: string, detector: string, metric: string) {
  db.prepare(
    `INSERT INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at) VALUES(?, 'RULE',?,'CONTEXT','ws-alpha','x','{}','{}',?,'PROPOSED','2026-01-01')`,
  ).run(id, detector, metric);
}

function sample(
  db: Database.Database,
  prefix: string,
  count: number,
  lastTurn: string,
  model = "claude-sonnet",
  state = "RECONCILED",
) {
  for (let i = 0; i < count; i++) {
    const sid = `${prefix}-s-${i}`;
    const mid = `${prefix}-m-${i}`;
    db.prepare(
      `INSERT INTO sessions(session_id,workspace_id,file_path,first_turn_at,last_turn_at,state,turn_count,cost_equiv_u,hygiene_flags) VALUES(?,?,?,?,?,?,1,0,'[]')`,
    ).run(sid, "ws-alpha", `/fixture/${sid}`, lastTurn, lastTurn, state);
    db.prepare(
      `INSERT INTO turns(message_id,session_id,workspace_id,ts,model,is_sidechain,input_tokens,output_tokens,cache_read_tokens,cache_write_5m,cache_write_1h,cache_write_other,cost_claim,provisional,parser_version) VALUES(?,?,?,?,?,0,100,0,100,10,0,0,'LIST_EQUIV',?, 'parser-v1')`,
    ).run(mid, sid, "ws-alpha", lastTurn, model, state === "LIVE" ? 1 : 0);
  }
}

function track(db: Database.Database, id: string, detector: string, metric: string) {
  let seq = 0;
  const engine = createEffectEngine(db, {
    observer: createSqlObservationProvider(),
    idFactory: () => `${id}-${++seq}`,
    now: () => new Date(APPLIED),
  });
  engine.track({
    recId: id,
    detectorId: detector,
    targetMetric: metric,
    scope: { workspaceId: "ws-alpha" },
    cohort: { state: "RECONCILED" },
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED",
    idempotencyKey: "track",
  });
  return engine;
}

function scopedEvent(
  db: Database.Database,
  eventId: string,
  sessionId: string,
  ownerMessageId: string,
  at: string,
  blockIndex: number,
  options: {
    path?: string;
    tool?: string;
    inputHash?: string;
    resultBytes?: number | null;
    exit?: string | null;
    test?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO tool_events(event_id,session_id,ts,tool_name,input_bytes,result_bytes,input_hash,exit_class,commit_sha)
     VALUES(?,?,?,?,1,?,?,?,NULL)`,
  ).run(
    eventId,
    sessionId,
    at,
    options.tool ?? "Bash",
    options.resultBytes === undefined ? 1 : options.resultBytes,
    options.inputHash ?? eventId,
    options.exit ?? "OK",
  );
  db.prepare(
    `INSERT INTO tool_event_metadata(event_id,file_path_hash,owner_message_id,block_index,is_test_command)
     VALUES(?,?,?,?,?)`,
  ).run(eventId, options.path ?? "path-scoped", ownerMessageId, blockIndex, options.test ?? 0);
}

function trackScoped(
  db: Database.Database,
  id: string,
  detector: "D2" | "D7",
  metric: string,
  scope: { sourceIdentity: string; tool: string },
) {
  let seq = 0;
  const engine = createEffectEngine(db, {
    observer: createSqlObservationProvider(),
    idFactory: () => `${id}-${++seq}`,
    now: () => new Date(APPLIED),
  });
  engine.track({
    recId: id,
    detectorId: detector,
    targetMetric: metric,
    scope: { workspaceId: "ws-alpha", ...scope },
    cohort: { state: "RECONCILED" },
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED",
    idempotencyKey: "track",
  });
  return engine;
}

describe("SQLite effect observations", () => {
  it("preserves a qualifying read region before an invalid-owner boundary", () => {
    const db = createInMemoryFixtureDb();
    const at = "2026-02-05T00:00:00.000Z";
    sample(db, "completed-reads", 1, at);
    for (let index = 0; index < 6; index++) {
      const read = index % 2 === 0;
      scopedEvent(
        db,
        `completed-reads-${index}`,
        "completed-reads-s-0",
        index === 5 ? "missing-owner" : "completed-reads-m-0",
        at,
        index,
        { tool: read ? "Read" : "Bash", inputHash: read ? "same-read" : `bash-${index}` },
      );
    }
    rec(db, "completed-reads", "D7", "loop_flagged_turn_share");
    const engine = track(db, "completed-reads", "D7", "loop_flagged_turn_share");
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(engine.getCycle("completed-reads-1")?.finalEvidence?.after).toMatchObject({
      value: 1,
      sessionN: 1,
      exposureN: 1,
      excluded: { OWNER_ROW_COUNT_INVALID: 1 },
    });
    db.close();
  });

  it.each(["stop", "rollback", "attest"] as const)(
    "keeps the frozen deadline when %s reaches an overdue cycle before the scheduled pass",
    (action) => {
      const db = createInMemoryFixtureDb();
      sample(db, "before", 10, "2026-01-25T00:00:00.000Z");
      sample(db, "after", 10, "2026-02-05T00:00:00.000Z");
      sample(db, "past-deadline", 10, "2026-02-15T00:10:00.000Z");
      db.prepare("UPDATE turns SET cache_read_tokens=120 WHERE session_id LIKE 'after-%'").run();
      db.prepare(
        "UPDATE turns SET cache_read_tokens=0 WHERE session_id LIKE 'past-deadline-%'",
      ).run();
      rec(db, "d8", "D8", "d8-cache-ratio");
      const engine = track(db, "d8", "D8", "d8-cache-ratio");
      const at = "2026-02-15T00:30:00.000Z";
      if (action === "stop")
        engine.stop("d8-1", { idempotencyKey: "stop", reason: "USER_STOPPED", at });
      else if (action === "rollback")
        engine.rollback("d8-1", { idempotencyKey: "rollback", requestedAt: at });
      else
        engine.attestExternalRollback("d8-1", {
          idempotencyKey: "attest",
          attestationSource: "USER_ATTESTED",
          attestedAt: at,
        });
      expect(engine.getCycle("d8-1")).toMatchObject({
        state: "STOPPED",
        observationTo: "2026-02-15T00:00:00.000Z",
        terminalAt: at,
        targetDirection: "IMPROVED",
        finalEvidence: { after: { value: 12, sessionN: 10 } },
      });
      expect(engine.getCycle("d8-1")?.comparisonReasons).not.toContain("WINDOW_STOPPED_EARLY");
      db.close();
    },
  );

  it("freezes the 9-session baseline and does not promote it after late historical insertion", () => {
    const db = createInMemoryFixtureDb();
    sample(db, "before", 9, "2026-01-25T00:00:00Z");
    sample(db, "after", 10, "2026-02-05T00:00:00Z");
    sample(db, "live", 1, "2026-02-05T00:00:00Z", "claude-sonnet", "LIVE");
    rec(db, "d2", "D2", "d2-floor-context");
    const engine = track(db, "d2", "D2", "d2-floor-context");
    expect(engine.getCycle("d2-1")?.baselineEvidence.sessionN).toBe(9);
    sample(db, "late-before", 1, "2026-01-26T00:00:00Z");
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    const cycle = engine.getCycle("d2-1");
    expect(cycle?.finalEvidence?.before.sessionN).toBe(9);
    expect(cycle?.finalEvidence?.after.sessionN).toBe(10);
    expect(cycle).toMatchObject({
      comparisonStatus: "DESCRIPTIVE",
      comparisonReasons: ["INSUFFICIENT_SESSIONS", "MIX_UNASSESSED"],
    });
    db.close();
  });

  it("keeps turn exposure distinct from 10 contributing sessions and uses unrounded D4 points", () => {
    const db = createInMemoryFixtureDb();
    sample(db, "b", 10, "2026-01-25T00:00:00Z", "claude-opus");
    sample(db, "a", 10, "2026-02-05T00:00:00Z", "claude-sonnet");
    db.prepare(
      `INSERT INTO turns(message_id,session_id,workspace_id,ts,model,is_sidechain,input_tokens,output_tokens,cache_read_tokens,cache_write_5m,cache_write_1h,cache_write_other,cost_claim,provisional,parser_version) VALUES('extra','a-s-0','ws-alpha','2026-02-06','claude-opus',0,1,0,0,1,0,0,'LIST_EQUIV',0,'parser-v1')`,
    ).run();
    rec(db, "d4", "D4", "d4-premium-share");
    const engine = track(db, "d4", "D4", "d4-premium-share");
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    const after = engine.getCycle("d4-1")?.finalEvidence?.after;
    expect(after?.sessionN).toBe(10);
    expect(after?.exposureN).toBe(11);
    expect(after?.value).toBeCloseTo(100 * (1 - 1 / 11), 10);
    db.close();
  });

  it("computes D8 from cache-read and nonzero creation totals with the 10-session gate", () => {
    const db = createInMemoryFixtureDb();
    sample(db, "d8-before", 10, "2026-01-25T00:00:00Z");
    sample(db, "d8-after", 10, "2026-02-05T00:00:00Z");
    db.prepare("UPDATE turns SET cache_read_tokens=120 WHERE session_id LIKE 'd8-after-%'").run();
    rec(db, "d8", "D8", "d8-cache-ratio");
    const engine = track(db, "d8", "D8", "d8-cache-ratio");
    engine.runPass(new Date("2026-02-15T00:00:00Z"));
    expect(engine.getCycle("d8-1")).toMatchObject({
      state: "FINALIZED",
      targetDirection: "IMPROVED",
      comparisonStatus: "COMPARABLE",
      baselineEvidence: { value: 10, denominator: 100, sessionN: 10 },
      finalEvidence: { after: { value: 12, denominator: 100, sessionN: 10 } },
    });

    rec(db, "d8-zero", "D8", "d8-cache-ratio");
    db.prepare("UPDATE turns SET cache_write_5m=0 WHERE session_id LIKE 'd8-before-%'").run();
    const zero = track(db, "d8-zero", "D8", "d8-cache-ratio");
    zero.runPass(new Date("2026-02-15T00:00:00Z"));
    expect(zero.getCycle("d8-zero-1")).toMatchObject({
      targetDirection: "INSUFFICIENT_DATA",
    });
    expect(zero.getCycle("d8-zero-1")?.comparisonReasons).toContain("DENOMINATOR_ZERO");
    db.close();
  });

  it("never persists a resolved D1 path in cycle evidence", () => {
    const db = createInMemoryFixtureDb();
    const secret = "C:/secret/CLAUDE.md";
    db.prepare(
      `INSERT INTO context_inventory_history(workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at) VALUES('ws-alpha','CLAUDE_MD',?,'h1',1000,'v1','2026-01-25')`,
    ).run(secret);
    db.prepare(
      `INSERT INTO context_inventory_history(workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at) VALUES('ws-alpha','CLAUDE_MD',?,'h2',900,'v1','2026-02-05')`,
    ).run(secret);
    rec(db, "d1", "D1", "d1-source-tokens");
    let seq = 0;
    const observer = createSqlObservationProvider({
      resolveSourceIdentity: (opaque) =>
        opaque === "src:opaque"
          ? { workspaceId: "ws-alpha", component: "CLAUDE_MD", fileRef: secret }
          : null,
    });
    const engine = createEffectEngine(db, {
      observer,
      idFactory: () => `d1-${++seq}`,
      now: () => new Date(APPLIED),
    });
    engine.track({
      recId: "d1",
      detectorId: "D1",
      targetMetric: "d1-source-tokens",
      scope: { workspaceId: "ws-alpha", sourceIdentity: "src:opaque" },
      cohort: {},
      trackingRequestedAt: APPLIED,
      appliedAt: APPLIED,
      applicationSource: "USER_ATTESTED",
      baselineSnapshotRef: "opaque",
      idempotencyKey: "track",
    });
    engine.runPass(new Date("2026-02-15"));
    const row = db
      .prepare(
        `SELECT scope_json||baseline_evidence_json||COALESCE(final_evidence_json,'') AS persisted FROM effect_cycles WHERE cycle_id='d1-1'`,
      )
      .get() as { persisted: string };
    expect(row.persisted).not.toContain(secret);
    expect(engine.getCycle("d1-1")?.targetDirection).toBe("IMPROVED");
    db.close();
  });

  it("observes D7 from its event-selected cohort, keeps quiet sessions, and separates guardrail sides", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    const tool = effectToolIdentity("Bash");
    for (const [prefix, at, repeats] of [
      ["d7-before", "2026-01-25T00:00:00.000Z", 3],
      ["d7-after", "2026-02-05T00:00:00.000Z", 1],
    ] as const) {
      sample(db, prefix, 10, at);
      for (let i = 0; i < 10; i++) {
        const sid = `${prefix}-s-${i}`;
        const owner = `${prefix}-m-${i}`;
        for (let n = 0; n < repeats; n++)
          scopedEvent(db, `${prefix}-e-${i}-${n}`, sid, owner, at, n, {
            inputHash: repeats === 3 ? "repeat" : `quiet-${i}`,
            exit: prefix === "d7-before" && i === 0 && n === 0 ? "ERROR" : "OK",
          });
      }
    }
    // A decoy event in a selected session must be a boundary and must not alter the scoped cohort.
    scopedEvent(db, "d7-decoy", "d7-after-s-0", "d7-after-m-0", "2026-02-05T00:00:00.000Z", 9, {
      path: "other-path",
      inputHash: "repeat",
    });
    rec(db, "d7", "D7", "loop_flagged_turn_share");
    const engine = trackScoped(db, "d7", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool,
    });
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    const evidence = engine.getCycle("d7-1")?.finalEvidence;
    expect(evidence?.before).toMatchObject({ value: 1, sessionN: 10, exposureN: 10 });
    expect(evidence?.after).toMatchObject({ value: 0, sessionN: 10, exposureN: 10 });
    expect(evidence?.toolMix.after).toEqual({ available: true, total: 10, counts: { Bash: 10 } });
    expect(
      evidence?.guardrails.find((item) => item.guardrailId === "completed-tool-error-rate"),
    ).toMatchObject({
      before: { value: 1 / 30, denominator: 30, sessionN: 10 },
      after: { value: 0, denominator: 10, sessionN: 10 },
      direction: "IMPROVED",
    });
    const persisted = db
      .prepare(
        "SELECT scope_json||baseline_evidence_json||COALESCE(final_evidence_json,'') AS persisted FROM effect_cycles WHERE cycle_id='d7-1'",
      )
      .get() as { persisted: string };
    expect(persisted.persisted).not.toContain("path-scoped");
    db.close();
  });

  it("treats out-of-scope events as D7 sequence boundaries and matching writes as tool-scope flushes", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    const bash = effectToolIdentity("Bash");
    sample(db, "boundary", 1, "2026-02-05T00:00:00.000Z");
    for (const [eventId, path, blockIndex] of [
      ["boundary-a", "path-scoped", 0],
      ["boundary-decoy", "other-path", 1],
      ["boundary-b", "path-scoped", 2],
      ["boundary-c", "path-scoped", 3],
    ] as const)
      scopedEvent(
        db,
        eventId,
        "boundary-s-0",
        "boundary-m-0",
        "2026-02-05T00:00:00.000Z",
        blockIndex,
        {
          path,
          inputHash: "repeat",
        },
      );
    rec(db, "boundary", "D7", "loop_flagged_turn_share");
    const boundary = trackScoped(db, "boundary", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool: bash,
    });
    boundary.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(boundary.getCycle("boundary-1")?.finalEvidence?.after).toMatchObject({
      value: 0,
      sessionN: 1,
      exposureN: 1,
      excluded: { SOURCE_IDENTITY_MISMATCH: 1 },
    });
    db.close();

    const read = effectToolIdentity("Read");
    const flushDb = createInMemoryFixtureDb();
    sample(flushDb, "write-flush", 1, "2026-02-05T00:00:00.000Z");
    for (const [eventId, tool, blockIndex] of [
      ["read-a", "Read", 0],
      ["read-b", "Read", 1],
      ["edit", "Edit", 2],
      ["read-c", "Read", 3],
      ["read-d", "Read", 4],
    ] as const)
      scopedEvent(
        flushDb,
        eventId,
        "write-flush-s-0",
        "write-flush-m-0",
        "2026-02-05T00:00:00.000Z",
        blockIndex,
        {
          tool,
          inputHash: "same-read",
        },
      );
    rec(flushDb, "write-flush", "D7", "loop_flagged_turn_share");
    const flushed = trackScoped(flushDb, "write-flush", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool: read,
    });
    flushed.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(flushed.getCycle("write-flush-1")?.finalEvidence?.after).toMatchObject({
      value: 0,
      sessionN: 1,
      exposureN: 1,
      excluded: { TOOL_IDENTITY_MISMATCH: 1 },
    });
    flushDb.close();
  });

  it("does not join scoped reads across a valid event excluded by the tool scope", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    sample(db, "tool-boundary", 1, "2026-02-05T00:00:00.000Z");
    for (const [eventId, tool, blockIndex] of [
      ["tool-boundary-read-a", "Read", 0],
      ["tool-boundary-read-b", "Read", 1],
      ["tool-boundary-bash", "Bash", 2],
      ["tool-boundary-read-c", "Read", 3],
    ] as const)
      scopedEvent(
        db,
        eventId,
        "tool-boundary-s-0",
        "tool-boundary-m-0",
        "2026-02-05T00:00:00.000Z",
        blockIndex,
        { tool, inputHash: "same-read" },
      );
    rec(db, "tool-boundary", "D7", "loop_flagged_turn_share");
    const engine = trackScoped(db, "tool-boundary", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool: effectToolIdentity("Read"),
    });
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(engine.getCycle("tool-boundary-1")?.finalEvidence?.after).toMatchObject({
      value: 0,
      sessionN: 1,
      exposureN: 1,
      excluded: { TOOL_IDENTITY_MISMATCH: 1 },
    });
    db.close();
  });

  it.each(["Edit", "Write"])(
    "does not join workspace D7 reads across an invalid-owner %s on another path",
    (tool) => {
      const db = createInMemoryFixtureDb();
      sample(db, "invalid-write", 1, "2026-02-05T00:00:00.000Z");
      for (let index = 0; index < 4; index++) {
        const write = index === 2;
        scopedEvent(
          db,
          `invalid-write-${index}`,
          "invalid-write-s-0",
          write ? "missing-owner" : "invalid-write-m-0",
          "2026-02-05T00:00:00.000Z",
          index,
          {
            tool: write ? tool : "Read",
            path: write ? "other-path" : "path-scoped",
            inputHash: "same-read",
          },
        );
      }
      rec(db, "invalid-write", "D7", "loop_flagged_turn_share");
      const engine = track(db, "invalid-write", "D7", "loop_flagged_turn_share");
      engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
      expect(engine.getCycle("invalid-write-1")?.finalEvidence?.after).toMatchObject({
        value: 0,
        sessionN: 1,
        exposureN: 1,
        excluded: { OWNER_ROW_COUNT_INVALID: 1 },
      });
      db.close();
    },
  );

  it("keeps D7's 14-day effect window separate from its seven-day detector horizon", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    const tool = effectToolIdentity("Bash");
    for (const [prefix, at, repeats] of [
      ["fourteen-day-before", "2026-01-20T00:00:00.000Z", 3],
      ["fourteen-day-after", "2026-02-05T00:00:00.000Z", 1],
    ] as const) {
      sample(db, prefix, 10, at);
      for (let i = 0; i < 10; i++)
        for (let n = 0; n < repeats; n++)
          scopedEvent(db, `${prefix}-${i}-${n}`, `${prefix}-s-${i}`, `${prefix}-m-${i}`, at, n, {
            inputHash: repeats === 3 ? "repeat" : `quiet-${i}`,
          });
    }
    rec(db, "fourteen-day", "D7", "loop_flagged_turn_share");
    const engine = trackScoped(db, "fourteen-day", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool,
    });
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(engine.getCycle("fourteen-day-1")).toMatchObject({
      baselineEvidence: { value: 1, sessionN: 10 },
      finalEvidence: { after: { value: 0, sessionN: 10 } },
      targetDirection: "IMPROVED",
    });
    db.close();
  });

  it("reports zero D7 exposure and invalid event ownership without expanding the cohort", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    const tool = effectToolIdentity("Bash");
    sample(db, "invalid-owner", 1, "2026-02-05T00:00:00.000Z");
    scopedEvent(
      db,
      "invalid-owner-event",
      "invalid-owner-s-0",
      "missing-owner",
      "2026-02-05T00:00:00.000Z",
      0,
    );
    rec(db, "invalid-owner", "D7", "loop_flagged_turn_share");
    const engine = trackScoped(db, "invalid-owner", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool,
    });
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(engine.getCycle("invalid-owner-1")?.finalEvidence?.after).toMatchObject({
      value: null,
      denominator: 0,
      exposureN: 0,
      sessionN: 0,
      excluded: { OWNER_ROW_COUNT_INVALID: 1, NO_ELIGIBLE_SESSIONS: 1 },
    });
    db.close();
  });

  it("excludes malformed scoped metadata and timestamps before D7 cohort selection", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    const tool = effectToolIdentity("Bash");
    sample(db, "bad-metadata", 1, "2026-02-05T00:00:00.000Z");
    sample(db, "bad-owner-time", 1, "2026-02-05T00:00:00.000Z");
    sample(db, "bad-session-time", 1, "2026-02-05T00:00:00.000Z");
    scopedEvent(
      db,
      "bad-metadata-event",
      "bad-metadata-s-0",
      "bad-metadata-m-0",
      "2026-02-05T00:00:00.000Z",
      0,
    );
    scopedEvent(
      db,
      "bad-owner-time-event",
      "bad-owner-time-s-0",
      "bad-owner-time-m-0",
      "2026-02-05T00:00:00.000Z",
      0,
    );
    scopedEvent(
      db,
      "bad-session-time-event",
      "bad-session-time-s-0",
      "bad-session-time-m-0",
      "2026-02-05T00:00:00.000Z",
      0,
    );
    db.prepare("DELETE FROM tool_event_metadata WHERE event_id='bad-metadata-event'").run();
    db.prepare("UPDATE turns SET ts='not-a-timestamp' WHERE message_id='bad-owner-time-m-0'").run();
    db.prepare(
      "UPDATE sessions SET last_turn_at='not-a-timestamp' WHERE session_id='bad-session-time-s-0'",
    ).run();
    rec(db, "malformed", "D7", "loop_flagged_turn_share");
    const engine = trackScoped(db, "malformed", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool,
    });
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(engine.getCycle("malformed-1")?.finalEvidence?.after).toMatchObject({
      value: null,
      exposureN: 0,
      sessionN: 0,
      excluded: {
        METADATA_ROW_COUNT_INVALID: 1,
        OWNER_TIMESTAMP_INVALID_OR_OUTSIDE_WINDOW: 1,
        SESSION_END_INVALID_OR_OUTSIDE_WINDOW: 1,
        NO_ELIGIBLE_SESSIONS: 1,
      },
    });
    db.close();
  });

  it("keeps incomplete scoped tool results out of guardrail denominators", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    const tool = effectToolIdentity("Bash");
    sample(db, "incomplete", 1, "2026-02-05T00:00:00.000Z");
    scopedEvent(
      db,
      "incomplete-event",
      "incomplete-s-0",
      "incomplete-m-0",
      "2026-02-05T00:00:00.000Z",
      0,
      { resultBytes: null },
    );
    rec(db, "incomplete", "D7", "loop_flagged_turn_share");
    const engine = trackScoped(db, "incomplete", "D7", "loop_flagged_turn_share", {
      sourceIdentity: source,
      tool,
    });
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(
      engine
        .getCycle("incomplete-1")
        ?.finalEvidence?.guardrails.find(
          (item) => item.guardrailId === "completed-tool-error-rate",
        ),
    ).toMatchObject({
      after: { value: null, denominator: 0, exposureN: 0, sessionN: 0 },
    });
    db.close();
  });

  it("uses only scoped-event sessions for the additive D2 metric and leaves legacy D2 unchanged", () => {
    const db = createInMemoryFixtureDb();
    const source = effectEventSourceIdentity("ws-alpha", "path-scoped");
    const tool = effectToolIdentity("Bash");
    for (const [prefix, at] of [
      ["d2-before", "2026-01-25T00:00:00.000Z"],
      ["d2-after", "2026-02-05T00:00:00.000Z"],
    ] as const) {
      sample(db, prefix, 10, at);
      for (let i = 0; i < 10; i++)
        scopedEvent(db, `${prefix}-e-${i}`, `${prefix}-s-${i}`, `${prefix}-m-${i}`, at, 0);
    }
    sample(db, "d2-decoy", 1, "2026-02-05T00:00:00.000Z");
    scopedEvent(db, "d2-decoy-e", "d2-decoy-s-0", "d2-decoy-m-0", "2026-02-05T00:00:00.000Z", 0, {
      path: "other-path",
    });
    db.prepare("UPDATE turns SET cache_read_tokens=200 WHERE session_id LIKE 'd2-after-%'").run();
    db.prepare("UPDATE turns SET cache_read_tokens=999 WHERE session_id LIKE 'd2-decoy-%'").run();
    rec(db, "d2-scoped", "D2", "floor_context_tokens_scoped");
    const engine = trackScoped(db, "d2-scoped", "D2", "floor_context_tokens_scoped", {
      sourceIdentity: source,
      tool,
    });
    engine.runPass(new Date("2026-02-15T00:00:00.000Z"));
    expect(engine.getCycle("d2-scoped-1")?.finalEvidence).toMatchObject({
      before: { value: 210, sessionN: 10 },
      after: { value: 310, sessionN: 10 },
    });
    db.close();
  });
});
