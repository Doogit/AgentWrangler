import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  a1Detector,
  a1FindingDescriptor,
} from "../../src/detector/detectors/a1_tool_result_bloat.js";
import {
  EffectValidationError,
  createEffectEngine,
  createSqlObservationProvider,
} from "../../src/effects/index.js";
import { findHandler } from "../../src/effects/registry.js";
import { effectEventSourceIdentity } from "../../src/effects/scope-identity.js";
import type { EffectScope } from "../../src/effects/types.js";
import { capabilityForRecommendation } from "../../src/query/api/effect-service.js";
import { adoptRecommendation } from "../../src/query/api/recommendations.js";
import { __resetToolCallTargets, seedToolCallTargets } from "../../src/query/api/tool-calls.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/effects/gate.js", () => ({ ESF_EFFECT_WRITER_ENABLED: true }));
const APPLIED = "2026-10-01T00:00:00.000Z";
const BEFORE = "2026-09-29T00:00:00.000Z";
const AFTER = "2026-10-05T00:00:00.000Z";
const WS = "ws-alpha";
const FILE = "hash-plan-md";
const OTHER = "hash-other-md";
const SCOPE: EffectScope = { workspaceId: WS, files: [effectEventSourceIdentity(WS, FILE)] };
let db: Database.Database;
beforeEach(() => {
  __resetToolCallTargets();
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

function session(id: string, at: string, sidechain = 0, state = "RECONCILED", ws = WS) {
  db.prepare(`INSERT INTO sessions(session_id,workspace_id,file_path,first_turn_at,last_turn_at,state,turn_count,cost_equiv_u,hygiene_flags)
    VALUES(?,?,?,?,?,?,1,0,'[]')`).run(id, ws, `/fixture/${id}`, at, at, state);
  db.prepare(`INSERT INTO turns(message_id,session_id,workspace_id,ts,model,is_sidechain,input_tokens,output_tokens,cache_read_tokens,cache_write_5m,cache_write_1h,cache_write_other,cost_claim,provisional,parser_version)
    VALUES(?,?,?,?,'claude-sonnet',?,10,0,10,0,0,0,'LIST_EQUIV',0,'parser-v1')`).run(
    `${id}-owner`,
    id,
    ws,
    at,
    sidechain,
  );
}
/** A call on the file with path hash `hash` that returned `bytes` (null: not recorded). */
function call(
  id: string,
  sid: string,
  at: string,
  hash: string | null,
  bytes: number | null,
  tool = "Read",
) {
  db.prepare(`INSERT INTO tool_events(event_id,session_id,ts,tool_name,input_bytes,result_bytes,input_hash,exit_class)
    VALUES(?,?,?,?,1,?,NULL,'OK')`).run(id, sid, at, tool, bytes);
  db.prepare(
    "INSERT INTO tool_event_metadata(event_id,file_path_hash,owner_message_id,block_index,is_test_command) VALUES(?,?,?,0,0)",
  ).run(id, hash, `${sid}-owner`);
}

function measureCycle(scope: EffectScope) {
  db.prepare(`INSERT OR IGNORE INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at,contract_version,contract_status,template_id,rule_id)
    VALUES('A1','RULE','A1','TOOLING',?,'lever','{}','{}','tool_result_bytes','PROPOSED',?,2,'V2_VALIDATED',NULL,'A1_TOOL_RESULT_BLOAT')`).run(
    WS,
    BEFORE,
  );
  const engine = createEffectEngine(db, {
    observer: createSqlObservationProvider(),
    idFactory: () => "a1-cycle",
    now: () => new Date(APPLIED),
  });
  engine.track({
    recId: "A1",
    detectorId: "A1",
    targetMetric: "tool_result_bytes",
    scope,
    cohort: {},
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED",
    idempotencyKey: "track",
  });
  engine.runPass(new Date("2026-10-15T00:00:00.000Z"));
  return engine.getCycle("a1-cycle");
}

/** Ten sessions a side; each before session reads the file three times, 10 KB each. */
function fixture(after: (sid: string, i: number) => void, beforeReads = 3) {
  for (let i = 0; i < 10; i++) {
    const before = `before-${i}`;
    session(before, BEFORE);
    for (let n = 0; n < beforeReads; n++) call(`${before}-${n}`, before, BEFORE, FILE, 10_000);
    const sid = `after-${i}`;
    session(sid, AFTER);
    after(sid, i);
  }
}

describe("A1 effect handler", () => {
  it("registers one frozen method for the A1 target metric", () => {
    expect(findHandler("A1", "tool_result_bytes")?.target).toMatchObject({
      metricId: "a1-file-result-bytes",
      methodVersion: "a1-file-result-bytes-v1",
      unit: "result bytes per session",
      improvementThreshold: -20,
      worseningThreshold: 20,
      minimumSessions: 10,
      minimumBaselineCalls: 20,
    });
  });

  it("smaller reads of the pinned file are IMPROVED", () => {
    fixture((sid) => call(`${sid}-range`, sid, AFTER, FILE, 10_000));
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.before).toMatchObject({
      value: 30_000,
      denominator: 10,
      exposureN: 30,
      sessionN: 10,
    });
    expect(cycle?.finalEvidence?.after).toMatchObject({ value: 10_000, exposureN: 10 });
    expect(cycle?.targetDirection).toBe("IMPROVED");
  });

  it("(metamorphic) more bytes from another file leave it UNCHANGED", () => {
    fixture((sid) => {
      for (let n = 0; n < 3; n++) call(`${sid}-${n}`, sid, AFTER, FILE, 10_000);
      for (let n = 0; n < 5; n++) call(`${sid}-other-${n}`, sid, AFTER, OTHER, 50_000);
      call(`${sid}-bash`, sid, AFTER, null, 80_000, "Bash");
    });
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.after?.value).toBe(30_000);
    expect(cycle?.targetDirection).toBe("UNCHANGED");
  });

  it("no longer reading the file at all is IMPROVED, not missing data", () => {
    fixture((sid) => call(`${sid}-other`, sid, AFTER, OTHER, 10_000));
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.after).toMatchObject({ value: 0, exposureN: 0, sessionN: 10 });
    expect(cycle?.targetDirection).toBe("IMPROVED");
  });

  it("fewer than 20 calls on the file before is not enough data", () => {
    fixture(() => {}, 1);
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.before).toMatchObject({ exposureN: 10 });
    expect(cycle?.targetDirection).toBe("INSUFFICIENT_DATA");
    expect(cycle?.comparisonReasons).toContain("INSUFFICIENT_CALLS");
  });

  it("counts main-thread reconciled calls in the card's workspace, any tool", () => {
    session("s", AFTER);
    call("read", "s", AFTER, FILE, 1_000);
    call("edit", "s", AFTER, FILE, 200, "Edit");
    call("unrecorded", "s", AFTER, FILE, null);
    call("other", "s", AFTER, OTHER, 9_000);
    session("quiet", AFTER);
    session("side", AFTER, 1);
    call("side-read", "side", AFTER, FILE, 9_000);
    session("live", AFTER, 0, "LIVE");
    call("live-read", "live", AFTER, FILE, 9_000);
    // Same path hash in another workspace is another file identity.
    session("foreign", AFTER, 0, "RECONCILED", "ws-beta");
    call("foreign-read", "foreign", AFTER, FILE, 9_000);
    const after = measureCycle(SCOPE)?.finalEvidence?.after;
    // read + edit over the two eligible main-thread sessions (s, quiet).
    expect(after).toMatchObject({
      value: 600,
      denominator: 2,
      exposureN: 2,
      sessionN: 2,
      excluded: { RESULT_BYTES_UNAVAILABLE: 1 },
    });
  });

  it.each([
    [{ workspaceId: WS }, "files"],
    [{ workspaceId: WS, files: [] }, "files"],
  ])("rejects an invalid A1 scope %j", (scope, message) => {
    expect(() => measureCycle(scope as EffectScope)).toThrow(EffectValidationError);
    expect(() => measureCycle(scope as EffectScope)).toThrow(message);
  });

  it("rejects the files scope on other detectors", () => {
    const engine = createEffectEngine(db, { observer: createSqlObservationProvider() });
    expect(() =>
      engine.track({
        recId: "D11",
        detectorId: "D11",
        targetMetric: "shell_error_rate",
        scope: { workspaceId: WS, files: [effectEventSourceIdentity(WS, FILE)] },
        cohort: {},
        trackingRequestedAt: APPLIED,
        appliedAt: APPLIED,
        applicationSource: "USER_ATTESTED",
        idempotencyKey: "track",
      }),
    ).toThrow(EffectValidationError);
  });
});

describe("A1 tracking through the recommendation", () => {
  /** An A1 finding whose lead is `lead`: two large reads of it, one large read of another file. */
  function recommendation(lead: "file" | "command") {
    session("before", BEFORE);
    call(
      "lead-1",
      "before",
      BEFORE,
      lead === "file" ? FILE : null,
      40_000,
      lead === "file" ? "Read" : "Bash",
    );
    call(
      "lead-2",
      "before",
      BEFORE,
      lead === "file" ? FILE : null,
      40_000,
      lead === "file" ? "Read" : "Bash",
    );
    call("one-off", "before", BEFORE, OTHER, 30_000);
    const target =
      lead === "file"
        ? { target: "~/repo/docs/plan.md", kind: "file" as const, whole_file: true }
        : { target: "git diff", kind: "command" as const, whole_file: false };
    seedToolCallTargets([
      ["lead-1", target],
      ["lead-2", target],
      ["one-off", { target: "~/repo/other.md", kind: "file", whole_file: true }],
    ]);
    const payload = a1Detector.evaluate(db, {
      now: new Date(APPLIED),
      fromIso: "2026-09-25T00:00:00.000Z",
      toIso: APPLIED,
    }).fired[0]?.payload;
    if (!payload) throw new Error("missing A1 fixture finding");
    db.prepare(`INSERT INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at,contract_version,contract_status,template_id,rule_id)
      VALUES('A1','RULE','A1',?,?,?,'{}',?,?,'PROPOSED',?,2,'V2_VALIDATED',NULL,?)`).run(
      a1FindingDescriptor.presentation.category,
      WS,
      a1FindingDescriptor.presentation.lever,
      JSON.stringify(payload),
      a1FindingDescriptor.presentation.target_metric,
      BEFORE,
      a1FindingDescriptor.rule_id,
    );
  }

  it("is TRACKABLE and adoption pins the card's lead file into the scope", () => {
    recommendation("file");
    expect(capabilityForRecommendation(db, "A1")).toEqual({ mode: "TRACKABLE", reason: null });
    expect(
      adoptRecommendation("A1", Date.parse(APPLIED), {
        machineConfirmed: true,
        actionRevision: "A1-revision",
      }).data,
    ).toEqual({ ok: true });
    const row = db
      .prepare("SELECT scope_json,metric_id FROM effect_cycles WHERE rec_id='A1'")
      .get();
    expect(row).toEqual({
      scope_json: JSON.stringify({
        workspaceId: WS,
        files: [effectEventSourceIdentity(WS, FILE)],
      }),
      metric_id: "a1-file-result-bytes",
    });
  });

  it("is not trackable when the lead is a shell command", () => {
    recommendation("command");
    expect(capabilityForRecommendation(db, "A1")).toEqual({
      mode: "MANUAL",
      reason: "SOURCE_UNAVAILABLE",
    });
  });
});
