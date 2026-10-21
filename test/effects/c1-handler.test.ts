import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  c1Detector,
  c1FindingDescriptor,
} from "../../src/detector/detectors/c1_tool_error_rate.js";
import {
  EffectValidationError,
  createEffectEngine,
  createSqlObservationProvider,
} from "../../src/effects/index.js";
import { findHandler } from "../../src/effects/registry.js";
import type { EffectScope } from "../../src/effects/types.js";
import { capabilityForRecommendation } from "../../src/query/api/effect-service.js";
import { adoptRecommendation } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/effects/gate.js", () => ({ ESF_EFFECT_WRITER_ENABLED: true }));
const APPLIED = "2026-10-01T00:00:00.000Z";
const BEFORE = "2026-09-29T00:00:00.000Z";
const AFTER = "2026-10-05T00:00:00.000Z";
const CHROME = "mcp__claude-in-chrome__computer";
const SCOPE: EffectScope = { workspaceId: null, tools: [CHROME, "PowerShell"] };
// U7: C1 counts a shell call as an error only when the shell itself failed (like D11); a script that
// ran and exited non-zero ("Exit code 2", "Timed out") is not one.
const SHELL_FAIL = "Exit code 127\nfoo: command not found";
let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

function session(id: string, at: string, sidechain = 0, state = "RECONCILED", ws = "ws-alpha") {
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
/** A tool call; `error` set makes it an ERROR with that retained error text. */
function call(
  id: string,
  sid: string,
  at: string,
  tool: string,
  error: string | null = null,
  command = "echo",
) {
  db.prepare(`INSERT INTO tool_events(event_id,session_id,ts,tool_name,input_bytes,result_bytes,input_hash,exit_class)
    VALUES(?,?,?,?,1,1,NULL,?)`).run(id, sid, at, tool, error === null ? "OK" : "ERROR");
  db.prepare(
    "INSERT INTO tool_event_metadata(event_id,owner_message_id,block_index,is_test_command) VALUES(?,?,0,0)",
  ).run(id, `${sid}-owner`);
  db.prepare("INSERT INTO tool_event_content(event_id,content_json) VALUES(?,?)").run(
    id,
    JSON.stringify({ command, ...(error === null ? {} : { error }) }),
  );
}

function measureCycle(scope: EffectScope) {
  db.prepare(`INSERT OR IGNORE INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at,contract_version,contract_status,template_id,rule_id)
    VALUES('C1','RULE','C1','TOOLING',NULL,'lever','{}','{}','tool_error_rate','PROPOSED',?,2,'V2_VALIDATED',NULL,'C1_TOOL_ERROR_RATE')`).run(
    BEFORE,
  );
  const engine = createEffectEngine(db, {
    observer: createSqlObservationProvider(),
    idFactory: () => "c1-cycle",
    now: () => new Date(APPLIED),
  });
  engine.track({
    recId: "C1",
    detectorId: "C1",
    targetMetric: "tool_error_rate",
    scope,
    cohort: {},
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED",
    idempotencyKey: "track",
  });
  engine.runPass(new Date("2026-10-15T00:00:00.000Z"));
  return engine.getCycle("c1-cycle");
}

/**
 * Ten sessions a side. Each before session makes three browser calls (one fails) and three
 * PowerShell calls (one fails): 60 frozen-tool calls, 20 errors. `after` fills each after session.
 */
function fixture(after: (sid: string, i: number) => void) {
  for (let i = 0; i < 10; i++) {
    const before = `before-${i}`;
    session(before, BEFORE);
    for (const tool of [CHROME, "PowerShell"]) {
      call(
        `${before}-${tool}-fail`,
        before,
        BEFORE,
        tool,
        tool === CHROME ? "Timed out" : SHELL_FAIL,
      );
      call(`${before}-${tool}-a`, before, BEFORE, tool);
      call(`${before}-${tool}-b`, before, BEFORE, tool);
    }
    const sid = `after-${i}`;
    session(sid, AFTER);
    after(sid, i);
  }
}

/** Six clean frozen-tool calls in one after session. */
function cleanAfter(sid: string) {
  for (const tool of [CHROME, "PowerShell"])
    for (const n of [1, 2, 3]) call(`${sid}-${tool}-${n}`, sid, AFTER, tool);
}

describe("C1 effect handler", () => {
  it("registers one frozen method for the C1 target metric", () => {
    expect(findHandler("C1", "tool_error_rate")?.target).toMatchObject({
      metricId: "c1-tool-error-rate",
      methodVersion: "c1-tool-error-rate-v1",
      unit: "errors per 100 calls",
      improvementThreshold: -20,
      worseningThreshold: 20,
      minimumSessions: 10,
      minimumCalls: 50,
    });
  });

  it("fewer errors on the frozen tools is IMPROVED", () => {
    fixture((sid, i) => {
      cleanAfter(sid);
      if (i < 3) call(`${sid}-fail`, sid, AFTER, "PowerShell", SHELL_FAIL);
    });
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.before).toMatchObject({ denominator: 60, exposureN: 60 });
    expect(cycle?.finalEvidence?.before?.value).toBeCloseTo(100 / 3);
    expect(cycle?.finalEvidence?.after?.value).toBeCloseTo((100 * 3) / 63);
    expect(cycle?.targetDirection).toBe("IMPROVED");
  });

  it("(metamorphic) more errors in a tool outside the frozen set leaves it UNCHANGED", () => {
    fixture((sid) => {
      call(`${sid}-${CHROME}-fail`, sid, AFTER, CHROME, "Timed out");
      call(`${sid}-${CHROME}-a`, sid, AFTER, CHROME);
      call(`${sid}-${CHROME}-b`, sid, AFTER, CHROME);
      call(`${sid}-ps-fail`, sid, AFTER, "PowerShell", SHELL_FAIL);
      call(`${sid}-ps-a`, sid, AFTER, "PowerShell");
      call(`${sid}-ps-b`, sid, AFTER, "PowerShell");
      call(`${sid}-glob-fail`, sid, AFTER, "Glob", "No such file");
    });
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.after?.value).toBeCloseTo(100 / 3);
    expect(cycle?.targetDirection).toBe("UNCHANGED");
  });

  it("(metamorphic) dropping the frozen tools is not enough data, never IMPROVED", () => {
    fixture((sid) => {
      for (const n of [1, 2, 3, 4, 5, 6]) call(`${sid}-read-${n}`, sid, AFTER, "Read");
    });
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.after).toMatchObject({ exposureN: 0 });
    expect(cycle?.targetDirection).toBe("INSUFFICIENT_DATA");
    expect(cycle?.comparisonReasons).toContain("INSUFFICIENT_CALLS");
  });

  it("fewer than 50 frozen-tool calls in a window is not enough data", () => {
    fixture((sid, i) => {
      // 40 clean calls after: an 'improvement' on too few calls.
      for (const n of [1, 2, 3, 4]) call(`${sid}-ps-${n}-${i}`, sid, AFTER, "PowerShell");
    });
    const cycle = measureCycle(SCOPE);
    expect(cycle?.finalEvidence?.after).toMatchObject({ exposureN: 40, value: 0 });
    expect(cycle?.targetDirection).toBe("INSUFFICIENT_DATA");
    expect(cycle?.comparisonReasons).toContain("INSUFFICIENT_CALLS");
  });

  it("counts main-thread reconciled calls in every workspace and skips benign failures", () => {
    session("s", AFTER);
    call("fail", "s", AFTER, "PowerShell", SHELL_FAIL);
    call("benign", "s", AFTER, "PowerShell", "Exit code 1", "git diff --quiet");
    call("ok", "s", AFTER, CHROME);
    call("other-tool", "s", AFTER, "Glob", "No such file");
    session("foreign", AFTER, 0, "RECONCILED", "ws-beta");
    call("foreign-fail", "foreign", AFTER, CHROME, "Timed out");
    session("side", AFTER, 1);
    call("side-fail", "side", AFTER, "PowerShell", SHELL_FAIL);
    session("live", AFTER, 0, "LIVE");
    call("live-fail", "live", AFTER, "PowerShell", SHELL_FAIL);
    const after = measureCycle(SCOPE)?.finalEvidence?.after;
    // fail + foreign-fail errors over fail, benign, ok, foreign-fail calls.
    expect(after).toMatchObject({ value: 50, denominator: 4, exposureN: 4, sessionN: 2 });
  });

  it("counts a call as C1 does: a script that exited non-zero is no error, a hook block is no call", () => {
    session("s", AFTER);
    call("shell-fail", "s", AFTER, "PowerShell", SHELL_FAIL);
    call("script-exit", "s", AFTER, "PowerShell", "Exit code 2\nTests failed");
    call("blocked", "s", AFTER, "PowerShell", "PreToolUse:Bash hook error: blocked");
    call("ok", "s", AFTER, CHROME);
    const after = measureCycle(SCOPE)?.finalEvidence?.after;
    // 1 error over shell-fail, script-exit, ok; the hook-blocked call never ran.
    expect(after).toMatchObject({ denominator: 3, exposureN: 3 });
    expect(after?.value).toBeCloseTo(100 / 3);
  });

  it("does not persist command or error text in effect evidence", () => {
    session("s", AFTER);
    call(
      "fail",
      "s",
      AFTER,
      "PowerShell",
      "Exit code 127\nsecret-error-text: command not found",
      "secret-command-text",
    );
    measureCycle(SCOPE);
    const stored = JSON.stringify(db.prepare("SELECT * FROM effect_cycles").all());
    expect(stored).not.toContain("secret-error-text");
    expect(stored).not.toContain("secret-command-text");
  });

  it.each([
    [{ workspaceId: null }, "tools"],
    [{ workspaceId: null, tools: [] }, "tools"],
  ])("rejects an invalid C1 scope %j", (scope, message) => {
    expect(() => measureCycle(scope as EffectScope)).toThrow(EffectValidationError);
    expect(() => measureCycle(scope as EffectScope)).toThrow(message);
  });

  it("rejects the tools scope on other detectors", () => {
    const engine = createEffectEngine(db, { observer: createSqlObservationProvider() });
    expect(() =>
      engine.track({
        recId: "D11",
        detectorId: "D11",
        targetMetric: "shell_error_rate",
        scope: { workspaceId: "ws-alpha", tools: ["PowerShell"] },
        cohort: {},
        trackingRequestedAt: APPLIED,
        appliedAt: APPLIED,
        applicationSource: "USER_ATTESTED",
        idempotencyKey: "track",
      }),
    ).toThrow(EffectValidationError);
  });
});

describe("C1 tracking through the recommendation", () => {
  function recommendation() {
    session("before", BEFORE);
    for (let n = 0; n < 20; n++) call(`read-${n}`, "before", BEFORE, "Read");
    for (let n = 0; n < 4; n++)
      call(`glob-${n}`, "before", BEFORE, "Glob", n < 3 ? "No match" : null);
    for (let n = 0; n < 4; n++)
      call(`chrome-${n}`, "before", BEFORE, CHROME, n < 3 ? "Timed out" : null);
    // C1 needs 20 calls per outlier tool (card review F4).
    for (let n = 4; n < 20; n++) call(`glob-${n}`, "before", BEFORE, "Glob");
    for (let n = 4; n < 20; n++) call(`chrome-${n}`, "before", BEFORE, CHROME);
    for (let n = 20; n < 80; n++) call(`read-${n}`, "before", BEFORE, "Read");
    const payload = c1Detector.evaluate(db, {
      now: new Date(APPLIED),
      fromIso: "2026-09-25T00:00:00.000Z",
      toIso: APPLIED,
    }).fired[0]?.payload;
    if (!payload) throw new Error("missing C1 fixture finding");
    db.prepare(`INSERT INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at,contract_version,contract_status,template_id,rule_id)
      VALUES('C1','RULE','C1','TOOLING',NULL,?,'{}',?,?,'PROPOSED',?,2,'V2_VALIDATED',NULL,?)`).run(
      c1FindingDescriptor.presentation.lever,
      JSON.stringify(payload),
      c1FindingDescriptor.presentation.target_metric,
      BEFORE,
      c1FindingDescriptor.rule_id,
    );
  }

  // U7: C1 emits one card per outlier tool (Glob and the chrome tool both qualify here, with 3
  // errors each), so the first card's scope holds its one tool.
  it("is TRACKABLE and adoption freezes the card's outlier tool into the scope", () => {
    recommendation();
    expect(capabilityForRecommendation(db, "C1")).toEqual({ mode: "TRACKABLE", reason: null });
    expect(
      adoptRecommendation("C1", Date.parse(APPLIED), {
        machineConfirmed: true,
        actionRevision: "C1-revision",
      }).data,
    ).toEqual({ ok: true });
    const row = db
      .prepare("SELECT scope_json,metric_id FROM effect_cycles WHERE rec_id='C1'")
      .get();
    expect(row).toEqual({
      scope_json: JSON.stringify({ workspaceId: null, tools: ["Glob"] }),
      metric_id: "c1-tool-error-rate",
    });
  });
});
