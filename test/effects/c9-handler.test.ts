import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  c9Detector,
  c9FindingDescriptor,
} from "../../src/detector/detectors/c9_denial_friction.js";
import {
  EffectValidationError,
  createEffectEngine,
  createSqlObservationProvider,
} from "../../src/effects/index.js";
import { findHandler } from "../../src/effects/registry.js";
import type { EffectScope } from "../../src/effects/types.js";
import { capabilityForRecommendation } from "../../src/query/api/effect-service.js";
import { c9WatchedShapes } from "../../src/query/api/rec-actions/trigger.js";
import { adoptRecommendation } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/effects/gate.js", () => ({ ESF_EFFECT_WRITER_ENABLED: true }));
const APPLIED = "2026-10-01T00:00:00.000Z";
const BEFORE = "2026-09-29T00:00:00.000Z";
const AFTER = "2026-10-05T00:00:00.000Z";
const PYTHON_READ = `python -c "import json; print(1)"`;
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
/** A shell call; `command` null stores no content, so the command cannot be read back. */
function call(id: string, sid: string, at: string, command: string | null, tool = "Bash") {
  db.prepare(`INSERT INTO tool_events(event_id,session_id,ts,tool_name,input_bytes,result_bytes,input_hash,exit_class)
    VALUES(?,?,?,?,1,1,NULL,'OK')`).run(id, sid, at, tool);
  db.prepare(
    "INSERT INTO tool_event_metadata(event_id,owner_message_id,block_index,is_test_command) VALUES(?,?,0,0)",
  ).run(id, `${sid}-owner`);
  if (command !== null)
    db.prepare("INSERT INTO tool_event_content(event_id,content_json) VALUES(?,?)").run(
      id,
      JSON.stringify({ command }),
    );
}
function denial(id: string, sid: string, at: string, label: string, sidechain = 0, interrupt = 0) {
  db.prepare(`INSERT INTO ingest_metric_events
      (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
       classifier_label, destructive_op, event_ts, is_sidechain)
    VALUES (?, ?, 0, 0, 0, ?, ?, NULL, ?, ?)`).run(id, sid, interrupt, label, at, sidechain);
}

function measureCycle(scope: EffectScope) {
  db.prepare(`INSERT OR IGNORE INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at,contract_version,contract_status,template_id,rule_id)
    VALUES('C9','RULE','C9','TOOLING','ws-alpha','lever','{}','{}','denial_friction_count','PROPOSED',?,2,'V2_VALIDATED',NULL,'C9_DENIAL_FRICTION')`).run(
    BEFORE,
  );
  const engine = createEffectEngine(db, {
    observer: createSqlObservationProvider(),
    idFactory: () => "c9-cycle",
    now: () => new Date(APPLIED),
  });
  engine.track({
    recId: "C9",
    detectorId: "C9",
    targetMetric: "denial_friction_count",
    scope,
    cohort: {},
    trackingRequestedAt: APPLIED,
    appliedAt: APPLIED,
    applicationSource: "USER_ATTESTED",
    idempotencyKey: "track",
  });
  engine.runPass(new Date("2026-10-15T00:00:00.000Z"));
  return engine.getCycle("c9-cycle");
}

const GUARD_SCOPE: EffectScope = {
  workspaceId: "ws-alpha",
  denialClass: "HOOK_BLOCK",
  guardShapes: ["PYTHON_READ"],
};

/** Ten sessions a side; each before session makes two harmless `python -c` reads, blocked. */
function guardFixture(after: (sid: string, i: number) => void) {
  for (let i = 0; i < 10; i++) {
    const before = `before-${i}`;
    session(before, BEFORE);
    call(`${before}-read-a`, before, BEFORE, PYTHON_READ);
    call(`${before}-read-b`, before, BEFORE, PYTHON_READ);
    call(`${before}-ls`, before, BEFORE, "ls src");
    denial(`${before}-block-a`, before, BEFORE, "hook-block");
    denial(`${before}-block-b`, before, BEFORE, "hook-block");
    const sid = `after-${i}`;
    session(sid, AFTER);
    call(`${sid}-ls`, sid, AFTER, "ls src");
    after(sid, i);
  }
}

describe("C9 effect handler", () => {
  it("registers one frozen method for the C9 target metric", () => {
    const handler = findHandler("C9", "denial_friction_count");
    expect(handler?.target).toMatchObject({
      metricId: "c9-denial-friction",
      methodVersion: "c9-denial-friction-v1",
      unit: "calls per 100 sessions",
      improvementThreshold: -20,
      worseningThreshold: 20,
      minimumSessions: 10,
    });
  });

  it("guard: fewer calls in the watched shape is IMPROVED", () => {
    guardFixture((sid, i) => {
      // One session still makes one read (and is still blocked); the rest use a script file.
      if (i === 0) {
        call(`${sid}-read`, sid, AFTER, PYTHON_READ);
        denial(`${sid}-block`, sid, AFTER, "hook-block");
      } else call(`${sid}-script`, sid, AFTER, "node scratchpad/read.mjs");
    });
    const cycle = measureCycle(GUARD_SCOPE);
    expect(cycle?.finalEvidence?.before).toMatchObject({ value: 200, denominator: 10 });
    expect(cycle?.finalEvidence?.after).toMatchObject({ value: 10, denominator: 10 });
    expect(cycle?.targetDirection).toBe("IMPROVED");
  });

  it("guard (metamorphic): loosening the guard so the same calls run unblocked is UNCHANGED", () => {
    guardFixture((sid) => {
      // Same calls, same shape, but no block events: the guard no longer stops them.
      call(`${sid}-read-a`, sid, AFTER, PYTHON_READ);
      call(`${sid}-read-b`, sid, AFTER, PYTHON_READ);
    });
    const cycle = measureCycle(GUARD_SCOPE);
    expect(cycle?.finalEvidence?.before?.value).toBe(200);
    expect(cycle?.finalEvidence?.after?.value).toBe(200);
    expect(cycle?.targetDirection).toBe("UNCHANGED");
  });

  it("guard: counts only watched shapes, main-thread eligible calls, and reports unreadable commands", () => {
    session("s", AFTER);
    call("read", "s", AFTER, PYTHON_READ);
    call("ps-read", "s", AFTER, PYTHON_READ, "PowerShell");
    call("cd", "s", AFTER, "cd src && ls"); // a shape the guard exists to stop, not watched
    call("stash", "s", AFTER, "git stash list"); // a false positive, but not watched here
    call("read-tool", "s", AFTER, PYTHON_READ, "Read"); // not a shell call
    call("unreadable", "s", AFTER, null);
    session("side", AFTER, 1);
    call("side-read", "side", AFTER, PYTHON_READ);
    session("live", AFTER, 0, "LIVE");
    call("live-read", "live", AFTER, PYTHON_READ);
    session("foreign", AFTER, 0, "RECONCILED", "ws-beta");
    call("foreign-read", "foreign", AFTER, PYTHON_READ);
    const after = measureCycle(GUARD_SCOPE)?.finalEvidence?.after;
    expect(after).toMatchObject({
      value: 200,
      denominator: 1,
      sessionN: 1,
      excluded: { COMMAND_UNREADABLE: 1 },
    });
  });

  it("guard: no watched shapes gives no value rather than zero", () => {
    session("s", AFTER);
    call("read", "s", AFTER, PYTHON_READ);
    const after = measureCycle({ ...GUARD_SCOPE, guardShapes: [] })?.finalEvidence?.after;
    expect(after).toMatchObject({ value: null, excluded: { NO_WATCHED_SHAPES: 1 } });
  });

  it.each([
    ["DENY_RULE", "deny-rule"],
    ["USER_REJECTED", "user-rejected"],
  ] as const)("%s counts its own denials per 100 eligible sessions", (denialClass, label) => {
    session("before", BEFORE);
    for (let i = 0; i < 4; i++) denial(`before-${i}`, "before", BEFORE, label);
    session("a", AFTER);
    session("quiet", AFTER);
    denial("mine", "a", AFTER, label);
    denial("other-kind", "a", AFTER, "hook-block");
    denial("side", "a", AFTER, label, 1);
    denial("interrupt", "a", AFTER, label, 0, 1);
    session("live", AFTER, 0, "LIVE");
    denial("live", "live", AFTER, label);
    const evidence = measureCycle({ workspaceId: "ws-alpha", denialClass })?.finalEvidence;
    expect(evidence?.before).toMatchObject({ value: 400, denominator: 1 });
    expect(evidence?.after).toMatchObject({ value: 50, denominator: 2, sessionN: 2 });
  });

  it("does not persist command text in effect evidence", () => {
    session("s", AFTER);
    call("read", "s", AFTER, PYTHON_READ);
    measureCycle(GUARD_SCOPE);
    expect(JSON.stringify(db.prepare("SELECT * FROM effect_cycles").all())).not.toContain(
      "import json",
    );
  });

  it.each([
    [{ workspaceId: "ws-alpha" }, "denial class"],
    [{ workspaceId: "ws-alpha", denialClass: "BOGUS" }, "denial class"],
    [{ workspaceId: "ws-alpha", denialClass: "HOOK_BLOCK" }, "guard shapes"],
    [{ workspaceId: "ws-alpha", denialClass: "DENY_RULE", guardShapes: [] }, "guard shapes"],
    [
      { workspaceId: "ws-alpha", denialClass: "HOOK_BLOCK", guardShapes: ["OTHER"] },
      "guard shapes",
    ],
  ])("rejects an invalid C9 scope %j", (scope, message) => {
    expect(() => measureCycle(scope as EffectScope)).toThrow(EffectValidationError);
    expect(() => measureCycle(scope as EffectScope)).toThrow(message);
  });

  it("rejects C9 scope fields on other detectors", () => {
    const engine = createEffectEngine(db, { observer: createSqlObservationProvider() });
    expect(() =>
      engine.track({
        recId: "D11",
        detectorId: "D11",
        targetMetric: "shell_error_rate",
        scope: { workspaceId: "ws-alpha", denialClass: "DENY_RULE" },
        cohort: {},
        trackingRequestedAt: APPLIED,
        appliedAt: APPLIED,
        applicationSource: "USER_ATTESTED",
        idempotencyKey: "track",
      }),
    ).toThrow(EffectValidationError);
  });
});

describe("C9 watched shapes", () => {
  const block = (tool: string, message: string, shape: string, calls = 1) => ({
    target: "x",
    kind: "command" as const,
    whole_file: false,
    tool,
    result: `PreToolUse:Bash hook error: ${message}`,
    guard_shape: shape as never,
    calls,
    session_ids: [],
    session_count: 1,
    total_bytes: 0,
    max_bytes: 0,
  });
  const GUARD = "Blocked command shape: cd&&-prefix / in-place edits (sed -i, python -c)";

  it("watches the open false positives when the card shows them", () => {
    expect(
      c9WatchedShapes([
        block("Bash", GUARD, "CD_PREFIX", 5),
        block("Bash", GUARD, "PYTHON_READ", 2),
        block("Bash", GUARD, "OTHER", 3),
      ]),
    ).toEqual(["PYTHON_READ"]);
  });

  it("else watches every classified shape the guard blocked, never OTHER", () => {
    expect(
      c9WatchedShapes([
        block("Bash", GUARD, "TMP_WRITE"),
        block("Bash", GUARD, "CD_PREFIX", 5),
        block("Bash", GUARD, "OTHER", 3),
      ]),
    ).toEqual(["CD_PREFIX", "TMP_WRITE"]);
    expect(c9WatchedShapes([])).toEqual([]);
  });
});

describe("C9 tracking through the recommendation", () => {
  function recommendation(label: "deny-rule" | "user-rejected") {
    session("before", BEFORE);
    for (let i = 0; i < 3; i++) denial(`before-${i}`, "before", BEFORE, label);
    const payload = c9Detector.evaluate(db, {
      now: new Date(APPLIED),
      fromIso: "2026-09-25T00:00:00.000Z",
      toIso: APPLIED,
    }).fired[0]?.payload;
    if (!payload) throw new Error("missing C9 fixture finding");
    db.prepare(`INSERT INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at,contract_version,contract_status,template_id,rule_id)
      VALUES('C9','RULE','C9','TOOLING','ws-alpha',?,'{}',?,?,'PROPOSED',?,2,'V2_VALIDATED',NULL,?)`).run(
      c9FindingDescriptor.presentation.lever,
      JSON.stringify(payload),
      c9FindingDescriptor.presentation.target_metric,
      BEFORE,
      c9FindingDescriptor.rule_id,
    );
  }

  it("is TRACKABLE and adoption freezes the card's denial class into the scope", () => {
    recommendation("deny-rule");
    expect(capabilityForRecommendation(db, "C9")).toEqual({ mode: "TRACKABLE", reason: null });
    expect(
      adoptRecommendation("C9", Date.parse(APPLIED), {
        machineConfirmed: true,
        actionRevision: "C9-revision",
      }).data,
    ).toEqual({ ok: true });
    const row = db
      .prepare("SELECT scope_json,metric_id FROM effect_cycles WHERE rec_id='C9'")
      .get();
    expect(row).toEqual({
      scope_json: JSON.stringify({ workspaceId: "ws-alpha", denialClass: "DENY_RULE" }),
      metric_id: "c9-denial-friction",
    });
  });
});
