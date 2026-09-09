import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createEffectEngine, createSqlObservationProvider } from "../../src/effects/index.js";
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

describe("SQLite effect observations", () => {
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
});
