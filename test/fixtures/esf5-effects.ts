import type Database from "better-sqlite3";
import {
  type ObservationProvider,
  createEffectEngine,
  createSqlObservationProvider,
  effectEventSourceIdentity,
  effectToolIdentity,
} from "../../src/effects/index.js";

/** Fixed synthetic replay clock. This corpus contains aggregate-safe values only. */
export const ESF5_EVIDENCE_AS_OF = "2026-08-15T00:00:00.000Z";
export const ESF5_APPLIED_AT = "2026-08-01T00:00:00.000Z";
export const ESF5_BEFORE_FROM = "2026-07-18T00:00:00.000Z";
export const ESF5_AFTER_TO = ESF5_EVIDENCE_AS_OF;
export const ESF5_SCOPED_APPLIED_AT = "2026-08-03T00:00:00.000Z";
const ESF5_SCOPED_SOURCE_HASH = "esf5-scoped-source-hash-14d";
const ESF5_SCOPED_TOOL = "Bash";
export const ESF5_SCOPED_SOURCE_IDENTITY = effectEventSourceIdentity(
  "ws-esf5-overlap-scoped",
  ESF5_SCOPED_SOURCE_HASH,
);
export const ESF5_SCOPED_TOOL_IDENTITY = effectToolIdentity(ESF5_SCOPED_TOOL);

export const esf5EffectManifest = {
  evidenceAsOf: ESF5_EVIDENCE_AS_OF,
  cycles: {
    lowCostRepair: "cycle-d4-01",
    rollbackMid: "cycle-d2-02",
    mixDrift: "cycle-d8-03",
    overlapControlD2: "cycle-d2-06",
    overlapControlD4: "cycle-d4-06",
    overlapScopedD7: "cycle-d7-04",
    overlapScopedD2: "cycle-d2-05",
    thresholds: {
      d2Nine: "cycle-threshold-d2-09",
      d2Ten: "cycle-threshold-d2-10",
      d4Nine: "cycle-threshold-d4-09",
      d4Ten: "cycle-threshold-d4-10",
      d8Nine: "cycle-threshold-d8-09",
      d8Ten: "cycle-threshold-d8-10",
      d4TurnTrap: "cycle-threshold-d4-turn-trap",
    },
  },
  variants: {
    lowCostRepair: "FX-LOWCOST-REPAIR",
    rollbackMid: "FX-ROLLBACK-MID",
    mixDrift: "FX-MIX-DRIFT",
    overlapControl: "FX-OVERLAP-14D: supported D2/D4 control",
    overlapScoped: "FX-OVERLAP-SCOPED-14D: opaque D7/D2 overlap",
    thresholds: "FX-THRESHOLD-9-10",
  },
} as const;

/** Deterministic cycle IDs for a harness that tracks the manifest's primary cycles in order. */
export function createEsf5IdFactory(): () => string {
  const ids = [
    esf5EffectManifest.cycles.lowCostRepair,
    esf5EffectManifest.cycles.rollbackMid,
    esf5EffectManifest.cycles.mixDrift,
    esf5EffectManifest.cycles.overlapControlD2,
    esf5EffectManifest.cycles.overlapControlD4,
    esf5EffectManifest.cycles.overlapScopedD7,
    esf5EffectManifest.cycles.overlapScopedD2,
    ...Object.values(esf5EffectManifest.cycles.thresholds),
  ];
  let index = 0;
  return () => ids[index++] ?? `cycle-esf5-extra-${index}`;
}

/** SQL target evidence plus the expressly synthetic ESF3 repair guardrail seam. */
export function createEsf5ObservationProvider(): ObservationProvider {
  const sql = createSqlObservationProvider();
  return {
    observe(db, cycle, before, after) {
      const observed = sql.observe(db, cycle, before, after);
      if (cycle.recId !== esf5EffectManifest.cycles.lowCostRepair) return observed;
      return {
        ...observed,
        guardrails: observed.guardrails.map((guardrail) =>
          guardrail.guardrailId !== "reported-useful-completion-repair"
            ? guardrail
            : {
                ...guardrail,
                availability: "SUPPORTED" as const,
                before: { value: 2, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
                after: { value: 5, denominator: 10, exposureN: 10, sessionN: 10, excluded: {} },
                // The engine derives ADVERSE from this supplied evidence.
                direction: "INSUFFICIENT_DATA" as const,
                reasonCodes: ["SYNTHETIC_SUPPLIED_GUARDRAIL_SEAM"],
                evidence: { source: "synthetic supplied guardrail seam; not SQL-derived" },
              },
        ),
      };
    },
  };
}

function workspace(db: Database.Database, id: string) {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces(workspace_id,project_slug,registered_at) VALUES(?,?,?)",
  ).run(id, id, ESF5_BEFORE_FROM);
}

function session(db: Database.Database, id: string, ws: string, at: string, cost = 0) {
  db.prepare(`INSERT INTO sessions(session_id,workspace_id,file_path,first_turn_at,last_turn_at,state,turn_count,cost_equiv_u,hygiene_flags)
    VALUES(?,?,?,?,?,'RECONCILED',1,?,'[]')`).run(id, ws, `/synthetic/${id}`, at, at, cost);
}

function turn(
  db: Database.Database,
  id: string,
  sid: string,
  ws: string,
  at: string,
  model = "claude-sonnet",
  cacheRead = 10,
  cacheWrite = 100,
) {
  db.prepare(`INSERT INTO turns(message_id,session_id,workspace_id,ts,model,is_sidechain,input_tokens,output_tokens,cache_read_tokens,cache_write_5m,cache_write_1h,cache_write_other,cost_claim,provisional,parser_version)
    VALUES(?,?,?,?,?,0,100,0,?,?,0,0,'LIST_EQUIV',0,'esf5-parser')`).run(
    id,
    sid,
    ws,
    at,
    model,
    cacheRead,
    cacheWrite,
  );
}

function recommendation(
  db: Database.Database,
  id: string,
  detector: "D2" | "D4" | "D7" | "D8",
  workspaceId: string,
) {
  const metrics = {
    D2: "d2-floor-context",
    D4: "d4-premium-share",
    D7: "d7-loop-flagged-turn-share",
    D8: "d8-cache-ratio",
  } as const;
  db.prepare(`INSERT INTO recommendations(rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at)
    VALUES(?,'RULE',?,'CONTEXT',?,'synthetic','{"model":"synthetic-no-savings","inputs":{},"kind":"ADVISORY"}','{}',?,'PROPOSED',?)`).run(
    id,
    detector,
    workspaceId,
    metrics[detector],
    ESF5_BEFORE_FROM,
  );
}

function scopedEvent(
  db: Database.Database,
  id: string,
  sid: string,
  ownerId: string,
  at: string,
  options: {
    sourceHash?: string;
    tool?: string;
    inputHash?: string;
    exitClass?: string;
    resultBytes?: number | null;
    test?: boolean;
  } = {},
) {
  db.prepare(`INSERT INTO tool_events(event_id,session_id,ts,tool_name,input_bytes,result_bytes,input_hash,exit_class)
    VALUES(?,?,?,?,1,?,?,?)`).run(
    id,
    sid,
    at,
    options.tool ?? ESF5_SCOPED_TOOL,
    options.resultBytes ?? 1,
    options.inputHash ?? "esf5-scoped-repeat",
    options.exitClass ?? "OK",
  );
  db.prepare(`INSERT INTO tool_event_metadata(event_id,file_path_hash,owner_message_id,block_index,is_test_command)
    VALUES(?,?,?,?,?)`).run(
    id,
    options.sourceHash ?? ESF5_SCOPED_SOURCE_HASH,
    ownerId,
    0,
    options.test ? 1 : 0,
  );
}

/** Ten exact-scope sessions per side; decoys exercise source/tool exclusion without affecting scalars. */
function scopedPopulation(
  db: Database.Database,
  prefix: string,
  at: string,
  contextInput: number,
  flagged: boolean,
) {
  for (let i = 1; i <= 10; i++) {
    const sid = `${prefix}-s${i}`;
    const ownerId = `${prefix}-owner${i}`;
    session(db, sid, "ws-esf5-overlap-scoped", at);
    turn(db, ownerId, sid, "ws-esf5-overlap-scoped", at, "claude-sonnet", 0, 0);
    db.prepare("UPDATE turns SET input_tokens=? WHERE message_id=?").run(contextInput, ownerId);
    if (flagged) {
      for (let event = 1; event <= 3; event++)
        scopedEvent(db, `${prefix}-event${i}-${event}`, sid, ownerId, at, {
          inputHash: `esf5-repeat-${i}`,
          exitClass: event === 1 ? "TEST_FAIL" : "OK",
          test: true,
        });
    } else {
      scopedEvent(db, `${prefix}-event${i}`, sid, ownerId, at, { inputHash: `esf5-quiet-${i}` });
    }
  }
}

function d4Population(
  db: Database.Database,
  ws: string,
  prefix: string,
  at: string,
  premium: number,
  sessions = 10,
) {
  for (let i = 0; i < sessions; i++) session(db, `${prefix}-s${i + 1}`, ws, at);
  for (let i = 0; i < 50; i++)
    turn(
      db,
      `${prefix}-t${i + 1}`,
      `${prefix}-s${(i % sessions) + 1}`,
      ws,
      at,
      i < premium ? "claude-opus" : "claude-sonnet",
    );
}

function d2Population(
  db: Database.Database,
  ws: string,
  prefix: string,
  at: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    const sid = `${prefix}-s${i + 1}`;
    session(db, sid, ws, at);
    turn(db, `${prefix}-t${i + 1}`, sid, ws, at);
  }
}

/** Seed the ESF5 effect corpus into an already migrated test database. */
export function seedEsf5Effects(db: Database.Database): typeof esf5EffectManifest {
  // FX-LOWCOST-REPAIR: D4 target is 50% -> 68%, exactly +18 percentage points.
  workspace(db, "ws-esf5-d4");
  recommendation(db, esf5EffectManifest.cycles.lowCostRepair, "D4", "ws-esf5-d4");
  d4Population(db, "ws-esf5-d4", "d4-before", "2026-07-25T12:00:00.000Z", 25);
  d4Population(db, "ws-esf5-d4", "d4-after", "2026-08-08T12:00:00.000Z", 16);

  // FX-ROLLBACK-MID: enough D2 evidence exists before the exact in-window rollback.
  workspace(db, "ws-esf5-d2");
  recommendation(db, esf5EffectManifest.cycles.rollbackMid, "D2", "ws-esf5-d2");
  d2Population(db, "ws-esf5-d2", "d2-before", "2026-07-25T12:00:00.000Z", 10);
  d2Population(db, "ws-esf5-d2", "d2-after", "2026-08-08T12:00:00.000Z", 10);

  // FX-MIX-DRIFT: 20 turns per side, class A (opus) 6/20 -> 11/20, nonzero cache creation.
  workspace(db, "ws-esf5-d8");
  recommendation(db, esf5EffectManifest.cycles.mixDrift, "D8", "ws-esf5-d8");
  for (const [prefix, at, opus] of [
    ["d8-before", "2026-07-25T12:00:00.000Z", 6],
    ["d8-after", "2026-08-08T12:00:00.000Z", 11],
  ] as const) {
    for (let i = 0; i < 20; i++) {
      const sid = `${prefix}-s${(i % 10) + 1}`;
      if (i < 10) session(db, sid, "ws-esf5-d8", at);
      turn(
        db,
        `${prefix}-t${i + 1}`,
        sid,
        "ws-esf5-d8",
        at,
        i < opus ? "claude-opus" : "claude-sonnet",
        i < opus ? 20 : 10,
        100,
      );
    }
  }

  // Threshold corpus: 9 and 10 distinct sessions per side, plus a 10-turn one-session trap.
  for (const detector of ["D2", "D4", "D8"] as const) {
    for (const count of [9, 10] as const) {
      const ws = `ws-esf5-${detector.toLowerCase()}-${count}`;
      workspace(db, ws);
      recommendation(db, `threshold-${detector.toLowerCase()}-${count}`, detector, ws);
      if (detector === "D4") {
        d4Population(db, ws, `${detector}-${count}-b`, "2026-07-25T12:00:00.000Z", 25, count);
        d4Population(db, ws, `${detector}-${count}-a`, "2026-08-08T12:00:00.000Z", 16, count);
      } else if (detector === "D8") {
        d2Population(db, ws, `${detector}-${count}-b`, "2026-07-25T12:00:00.000Z", count);
        d2Population(db, ws, `${detector}-${count}-a`, "2026-08-08T12:00:00.000Z", count);
      } else {
        d2Population(db, ws, `${detector}-${count}-b`, "2026-07-25T12:00:00.000Z", count);
        d2Population(db, ws, `${detector}-${count}-a`, "2026-08-08T12:00:00.000Z", count);
      }
    }
  }
  workspace(db, "ws-esf5-turn-trap");
  recommendation(db, "threshold-d4-turn-trap", "D4", "ws-esf5-turn-trap");
  for (const [prefix, at] of [
    ["trap-b", "2026-07-25T12:00:00.000Z"],
    ["trap-a", "2026-08-08T12:00:00.000Z"],
  ] as const) {
    session(db, `${prefix}-s1`, "ws-esf5-turn-trap", at);
    for (let i = 0; i < 10; i++)
      turn(
        db,
        `${prefix}-t${i}`,
        `${prefix}-s1`,
        "ws-esf5-turn-trap",
        at,
        i < 5 ? "claude-opus" : "claude-sonnet",
      );
  }
  workspace(db, "ws-esf5-overlap");
  recommendation(db, esf5EffectManifest.cycles.overlapControlD2, "D2", "ws-esf5-overlap");
  recommendation(db, esf5EffectManifest.cycles.overlapControlD4, "D4", "ws-esf5-overlap");
  d4Population(db, "ws-esf5-overlap", "overlap-before", "2026-07-25T12:00:00.000Z", 25);
  d4Population(db, "ws-esf5-overlap", "overlap-after", "2026-08-08T12:00:00.000Z", 16);

  // FX-OVERLAP-SCOPED-14D: exact opaque source/tool cohort.  D7 improves 1 -> 0;
  // scoped D2 improves 1000 -> 800. Both intentionally overlap from Aug 3 through Aug 17.
  workspace(db, "ws-esf5-overlap-scoped");
  recommendation(db, esf5EffectManifest.cycles.overlapScopedD7, "D7", "ws-esf5-overlap-scoped");
  recommendation(db, esf5EffectManifest.cycles.overlapScopedD2, "D2", "ws-esf5-overlap-scoped");
  scopedPopulation(db, "scoped-before", "2026-07-25T12:00:00.000Z", 1000, true);
  scopedPopulation(db, "scoped-after", "2026-08-08T12:00:00.000Z", 800, false);
  // Same workspace but distinct source and tool identities: both are excluded from the bounded cohort.
  const decoyOwner = "scoped-decoy-owner";
  session(db, "scoped-decoy", "ws-esf5-overlap-scoped", "2026-08-08T12:00:00.000Z");
  turn(
    db,
    decoyOwner,
    "scoped-decoy",
    "ws-esf5-overlap-scoped",
    "2026-08-08T12:00:00.000Z",
    "claude-sonnet",
    0,
    0,
  );
  scopedEvent(db, "scoped-decoy-source", "scoped-decoy", decoyOwner, "2026-08-08T12:00:00.000Z", {
    sourceHash: "esf5-decoy-source",
  });
  scopedEvent(db, "scoped-decoy-tool", "scoped-decoy", decoyOwner, "2026-08-08T12:01:00.000Z", {
    tool: "Read",
  });

  const ids = [
    esf5EffectManifest.cycles.lowCostRepair,
    esf5EffectManifest.cycles.rollbackMid,
    esf5EffectManifest.cycles.mixDrift,
    esf5EffectManifest.cycles.overlapControlD2,
    esf5EffectManifest.cycles.overlapControlD4,
    esf5EffectManifest.cycles.overlapScopedD7,
    esf5EffectManifest.cycles.overlapScopedD2,
    ...Object.values(esf5EffectManifest.cycles.thresholds),
  ];
  let index = 0;
  const effects = createEffectEngine(db, {
    observer: createEsf5ObservationProvider(),
    now: () => new Date(ESF5_EVIDENCE_AS_OF),
    idFactory: () => ids[index++] ?? `cycle-esf5-extra-${index}`,
  });
  const track = (
    recId: string,
    detector: "D2" | "D4" | "D7" | "D8",
    workspaceId: string,
    appliedAt = ESF5_APPLIED_AT,
  ) =>
    effects.track({
      recId,
      detectorId: detector,
      targetMetric: {
        D2: "d2-floor-context",
        D4: "d4-premium-share",
        D7: "d7-loop-flagged-turn-share",
        D8: "d8-cache-ratio",
      }[detector],
      scope: { workspaceId },
      cohort: { state: "RECONCILED" },
      trackingRequestedAt: appliedAt,
      appliedAt,
      applicationSource: "USER_ATTESTED",
      idempotencyKey: `seed-${recId}`,
    });
  track(esf5EffectManifest.cycles.lowCostRepair, "D4", "ws-esf5-d4");
  track(esf5EffectManifest.cycles.rollbackMid, "D2", "ws-esf5-d2");
  track(esf5EffectManifest.cycles.mixDrift, "D8", "ws-esf5-d8");
  const overlapApplied = "2026-08-03T00:00:00.000Z";
  track(esf5EffectManifest.cycles.overlapControlD2, "D2", "ws-esf5-overlap", overlapApplied);
  track(esf5EffectManifest.cycles.overlapControlD4, "D4", "ws-esf5-overlap", overlapApplied);
  const scopedScope = {
    workspaceId: "ws-esf5-overlap-scoped",
    sourceIdentity: ESF5_SCOPED_SOURCE_IDENTITY,
    tool: ESF5_SCOPED_TOOL_IDENTITY,
  };
  for (const [recId, detector, targetMetric] of [
    [esf5EffectManifest.cycles.overlapScopedD7, "D7", "d7-loop-flagged-turn-share"],
    [esf5EffectManifest.cycles.overlapScopedD2, "D2", "d2-floor-context-scoped"],
  ] as const)
    effects.track({
      recId,
      detectorId: detector,
      targetMetric,
      scope: scopedScope,
      cohort: { state: "RECONCILED" },
      trackingRequestedAt: ESF5_SCOPED_APPLIED_AT,
      appliedAt: ESF5_SCOPED_APPLIED_AT,
      applicationSource: "USER_ATTESTED",
      idempotencyKey: `seed-${recId}`,
    });
  for (const detector of ["D2", "D4", "D8"] as const)
    for (const count of [9, 10] as const)
      track(
        `threshold-${detector.toLowerCase()}-${count}`,
        detector,
        `ws-esf5-${detector.toLowerCase()}-${count}`,
      );
  track("threshold-d4-turn-trap", "D4", "ws-esf5-turn-trap");
  effects.attestExternalRollback(esf5EffectManifest.cycles.rollbackMid, {
    idempotencyKey: "seed-rollback",
    attestationSource: "USER",
    attestedAt: "2026-08-10T12:00:00.000Z",
    actualRollbackAt: "2026-08-10T12:00:00.000Z",
  });
  effects.runPass(new Date(ESF5_EVIDENCE_AS_OF));
  for (const cycleId of [
    esf5EffectManifest.cycles.overlapControlD2,
    esf5EffectManifest.cycles.overlapControlD4,
    esf5EffectManifest.cycles.overlapScopedD7,
    esf5EffectManifest.cycles.overlapScopedD2,
  ])
    effects.stop(cycleId, {
      idempotencyKey: `seed-stop-${cycleId}`,
      reason: "SYNTHETIC_OVERLAP",
      at: ESF5_EVIDENCE_AS_OF,
    });
  db.prepare(
    "UPDATE recommendations SET state='ADOPTED', adopted_at=? WHERE rec_id IN (SELECT rec_id FROM effect_cycles)",
  ).run(ESF5_APPLIED_AT);
  return esf5EffectManifest;
}
