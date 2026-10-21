import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  c5Detector,
  c5FindingDescriptor,
} from "../../src/detector/detectors/c5_same_error_loop.js";
import { recommendationTemplate } from "../../src/detector/privacy-contract.js";
import { createEffectEngine, createSqlObservationProvider } from "../../src/effects/index.js";
import { directionFor, findHandler } from "../../src/effects/registry.js";
import { capabilityForRecommendation } from "../../src/query/api/effect-service.js";
import { adoptRecommendation } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/effects/gate.js", () => ({ ESF_EFFECT_WRITER_ENABLED: true }));
const APPLIED = "2026-10-01T00:00:00.000Z";
const BEFORE = "2026-09-29T00:00:00.000Z";
const AFTER = "2026-10-05T00:00:00.000Z";
let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

function session(
  id: string,
  at: string,
  sidechain = 0,
  state = "RECONCILED",
  workspace = "ws-alpha",
  provisional = 0,
) {
  db.prepare(`INSERT INTO sessions(session_id,workspace_id,file_path,first_turn_at,last_turn_at,state,turn_count,cost_equiv_u,hygiene_flags)
    VALUES(?,?,?,?,?,?,1,0,'[]')`).run(id, workspace, `/fixture/${id}`, at, at, state);
  db.prepare(`INSERT INTO turns(message_id,session_id,workspace_id,ts,model,is_sidechain,input_tokens,output_tokens,cache_read_tokens,cache_write_5m,cache_write_1h,cache_write_other,cost_claim,provisional,parser_version)
    VALUES(?,?,?,?,'claude-sonnet',?,10,0,10,0,0,0,'LIST_EQUIV',?,'parser-v1')`).run(
    `${id}-owner`,
    id,
    workspace,
    at,
    sidechain,
    provisional,
  );
}
/** F32: a shell call that ran reports "Exit code N"; without it the call never ran and is no C5 loop. */
const RAN_BOOM = "Exit code 1\nboom";
function event(
  id: string,
  sid: string,
  at: string,
  tool = "Bash",
  exit = "ERROR",
  text?: string,
  owner = text === undefined ? `${sid}-owner` : `${id}-owner`,
) {
  // U7: C5 counts distinct owner turns, so each event gets its own turn, a copy of the session's.
  if (text !== undefined && owner === `${id}-owner`)
    db.prepare(`INSERT INTO turns(message_id,session_id,workspace_id,ts,model,is_sidechain,input_tokens,output_tokens,cache_read_tokens,cache_write_5m,cache_write_1h,cache_write_other,cost_claim,provisional,parser_version)
      SELECT ?,session_id,workspace_id,ts,model,is_sidechain,input_tokens,output_tokens,cache_read_tokens,cache_write_5m,cache_write_1h,cache_write_other,cost_claim,provisional,parser_version
      FROM turns WHERE message_id = ?`).run(owner, `${sid}-owner`);
  db.prepare(`INSERT INTO tool_events(event_id,session_id,ts,tool_name,input_bytes,result_bytes,input_hash,exit_class,tool_error_class,tool_error_classifier_version)
    VALUES(?,?,?,?,1,1,?,?, 'NOT_FOUND','tool-error-1')`).run(id, sid, at, tool, null, exit);
  db.prepare(
    "INSERT INTO tool_event_metadata(event_id,owner_message_id,block_index,is_test_command) VALUES(?,?,0,0)",
  ).run(id, owner);
  if (text !== undefined)
    db.prepare("INSERT INTO tool_event_content(event_id,content_json) VALUES(?,?)").run(
      id,
      JSON.stringify({ error: text }),
    );
}
function recommendation(detector: "D11" | "C5") {
  const d11 = recommendationTemplate("D11_TOOL_ERROR_RATE");
  const descriptor = c5FindingDescriptor;
  const payload =
    detector === "D11"
      ? {
          version: 1,
          template_id: "D11_TOOL_ERROR_RATE",
          facts: {
            bash_error_ratio: 0.5,
            powershell_error_ratio: 0.1,
            bash_call_count: 100,
            powershell_call_count: 100,
            bash_error_count: 50,
            powershell_error_count: 10,
            preferred_tool: "PowerShell",
            higher_error_tool: "Bash",
          },
        }
      : c5Detector.evaluate(db, {
          now: new Date(APPLIED),
          fromIso: "2026-09-25T00:00:00.000Z",
          toIso: APPLIED,
        }).fired[0]?.payload;
  if (!payload) throw new Error("missing C5 fixture finding");
  db.prepare(`INSERT INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at,contract_version,contract_status,template_id,rule_id)
    VALUES(?,'RULE',?,'TOOLING','ws-alpha',?,'{}',?,?,'PROPOSED',?,?,?,?,?)`).run(
    detector,
    detector,
    detector === "D11" ? d11.lever : descriptor.presentation.lever,
    JSON.stringify(payload),
    detector === "D11" ? d11.target_metric : descriptor.presentation.target_metric,
    BEFORE,
    detector === "D11" ? 1 : 2,
    detector === "D11" ? "V1_VALIDATED" : "V2_VALIDATED",
    detector === "D11" ? "D11_TOOL_ERROR_RATE" : null,
    detector === "C5" ? descriptor.rule_id : null,
  );
}
function measureCycle(detector: "D11" | "C5") {
  recommendation(detector);
  const engine = createEffectEngine(db, {
    observer: createSqlObservationProvider(),
    idFactory: () => `${detector}-cycle`,
    now: () => new Date(APPLIED),
  });
  engine.track({
    recId: detector,
    detectorId: detector,
    targetMetric: detector === "D11" ? "shell_error_rate" : "same_error_loop_count",
    scope: { workspaceId: "ws-alpha" },
    cohort: {},
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED",
    idempotencyKey: "track",
  });
  engine.runPass(new Date("2026-10-15T00:00:00.000Z"));
  return engine.getCycle(`${detector}-cycle`);
}

function measure(detector: "D11" | "C5") {
  return measureCycle(detector)?.finalEvidence;
}

describe("D11 and C5 effect handlers", () => {
  it.each([
    [false, "COMPARABLE"],
    [true, "CONFOUNDED"],
  ] as const)(
    "D11 shell substitution with unrelated tool shift=%s is %s",
    (unrelatedToolShift, expectedStatus) => {
      for (let i = 0; i < 10; i++) {
        const before = `before-${i}`;
        const after = `after-${i}`;
        session(before, BEFORE);
        event(`${before}-bash`, before, BEFORE);
        event(`${before}-powershell`, before, BEFORE, "PowerShell", "OK");
        session(after, AFTER);
        event(`${after}-bash`, after, AFTER);
        for (let j = 0; j < 9; j++)
          event(`${after}-powershell-${j}`, after, AFTER, "PowerShell", "OK");
        if (unrelatedToolShift)
          for (let j = 0; j < 10; j++) event(`${after}-read-${j}`, after, AFTER, "Read", "OK");
      }
      const cycle = measureCycle("D11");
      expect(cycle?.targetDirection).toBe("IMPROVED");
      expect(cycle?.comparisonStatus).toBe(expectedStatus);
      expect(cycle?.comparisonReasons.includes("TOOL_MIX_SHIFT")).toBe(unrelatedToolShift);
    },
  );

  it("continues to confound C5 when Bash shifts to PowerShell", () => {
    for (let i = 0; i < 10; i++) {
      const before = `before-${i}`;
      const after = `after-${i}`;
      session(before, BEFORE);
      session(after, AFTER);
      for (let j = 0; j < 3; j++) {
        event(`${before}-${j}`, before, BEFORE, "Bash", "ERROR", RAN_BOOM);
        event(`${after}-${j}`, after, AFTER, "PowerShell", "ERROR", RAN_BOOM);
      }
    }
    const cycle = measureCycle("C5");
    expect(cycle?.comparisonStatus).toBe("CONFOUNDED");
    expect(cycle?.comparisonReasons).toContain("TOOL_MIX_SHIFT");
  });

  it("measures both shells, excluding sidechains, provisional, live, foreign, orphan and boundary events", () => {
    session("before", BEFORE);
    event("before-error", "before", BEFORE);
    event("before-ok", "before", BEFORE, "PowerShell", "OK");
    session("after", AFTER);
    event("after-error", "after", AFTER);
    for (let i = 0; i < 3; i++) event(`after-ok-${i}`, "after", AFTER, "PowerShell", "OK");
    event("read", "after", AFTER, "Read");
    event("orphan", "after", AFTER, "Bash", "ERROR", undefined, "missing");
    event("boundary", "after", "2026-10-15T00:00:00.000Z");
    for (const [id, side, state, ws, provisional] of [
      ["side", 1, "RECONCILED", "ws-alpha", 0],
      ["live", 0, "LIVE", "ws-alpha", 0],
      ["foreign", 0, "RECONCILED", "ws-beta", 0],
      ["provisional", 0, "RECONCILED", "ws-alpha", 1],
    ] as const) {
      session(id, AFTER, side, state, ws, provisional);
      event(id, id, AFTER);
    }
    const evidence = measure("D11");
    expect(evidence?.before).toMatchObject({ value: 0.5, denominator: 2, sessionN: 1 });
    expect(evidence?.after).toMatchObject({ value: 0.25, denominator: 4, sessionN: 1 });
    const handler = findHandler("D11", "shell_error_rate");
    expect(handler?.target.improvementThreshold).toBe(-20);
    if (!handler) throw new Error("missing handler");
    expect(directionFor(handler, 0.5, 0.25).direction).toBe("IMPROVED");
    expect(directionFor(handler, 0, 0).direction).toBe("INSUFFICIENT_DATA");
  });
  it("counts identical-error clusters per 100 sessions, including quiet sessions, without persisting text", () => {
    session("before", BEFORE);
    for (let i = 0; i < 3; i++) event(`before-${i}`, "before", BEFORE, "Bash", "ERROR", RAN_BOOM);
    session("active", AFTER);
    session("quiet", AFTER);
    session("side", AFTER, 1);
    for (let i = 0; i < 6; i++)
      event(
        `same-${i}`,
        "active",
        AFTER,
        "Bash",
        "ERROR",
        i % 2 ? "Exit code 1\n Synthetic   Failure " : "Exit code 1\nsynthetic failure",
      );
    for (let i = 0; i < 3; i++) event(`legacy-${i}`, "active", AFTER, "Read");
    for (let i = 0; i < 2; i++)
      event(`short-${i}`, "active", AFTER, "Bash", "ERROR", "Exit code 1\ndifferent failure");
    for (let i = 0; i < 3; i++) event(`side-${i}`, "side", AFTER);
    const evidence = measure("C5");
    expect(evidence?.before).toMatchObject({ value: 100, denominator: 1 });
    // U7: the three text-less Read errors ("legacy") no longer form a loop, so one loop in two sessions.
    expect(evidence?.after).toMatchObject({ value: 50, denominator: 2, sessionN: 2 });
    expect(JSON.stringify(evidence)).not.toContain("synthetic failure");
    expect(
      JSON.stringify(db.prepare("SELECT * FROM effect_cycles WHERE rec_id='C5'").get()),
    ).not.toContain("different failure");
  });
  it("distinguishes an empty shell denominator from zero errors", () => {
    session("quiet", AFTER);
    const evidence = measure("D11");
    expect(evidence?.after).toMatchObject({ value: null, denominator: 0, sessionN: 0 });
  });
  it("records zero C5 loops and zero shell errors when eligible exposure exists", () => {
    session("before", BEFORE);
    for (let i = 0; i < 3; i++) event(`before-${i}`, "before", BEFORE, "Bash", "ERROR", RAN_BOOM);
    session("quiet", AFTER);
    event("success", "quiet", AFTER, "PowerShell", "OK");
    expect(measure("C5")?.after).toMatchObject({ value: 0, denominator: 1, sessionN: 1 });
    expect(measure("D11")?.after).toMatchObject({ value: 0, denominator: 1, sessionN: 1 });
  });

  it.each(["D11", "C5"] as const)(
    "%s is TRACKABLE and adoption persists action_revision",
    (detector) => {
      session("before", BEFORE);
      for (let i = 0; i < 3; i++) event(`before-${i}`, "before", BEFORE, "Bash", "ERROR", RAN_BOOM);
      recommendation(detector);
      expect(capabilityForRecommendation(db, detector)).toEqual({
        mode: "TRACKABLE",
        reason: null,
      });
      // Exercise the existing owned-apply bridge; action-family acceptance belongs to integration.
      expect(
        adoptRecommendation(detector, Date.parse(APPLIED), {
          machineConfirmed: true,
          actionRevision: `${detector}-revision`,
        }).data,
      ).toEqual({ ok: true });
      expect(
        db.prepare("SELECT action_revision,state FROM effect_cycles WHERE rec_id=?").get(detector),
      ).toEqual({ action_revision: `${detector}-revision`, state: "OPEN_SETTLING" });
    },
  );
});
