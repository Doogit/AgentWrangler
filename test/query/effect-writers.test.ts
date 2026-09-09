import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEffectMeasurementPass } from "../../src/daemon/effect-pass.js";
import {
  compactContextHistory,
  inspectContextHistoryRetention,
} from "../../src/detector/context-history-retention.js";
import { runMeasurementPass } from "../../src/detector/measurement.js";
import { effectEngineForDb } from "../../src/query/api/effect-service.js";
import { listLedger } from "../../src/query/api/recommendations-ledger.js";
import {
  adoptRecommendation,
  getRecommendationCard,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../src/effects/gate.js", () => ({
  get ESF_EFFECT_WRITER_ENABLED() {
    return gate.enabled;
  },
}));

const NOW = new Date("2026-06-15T00:00:00.000Z");
const DAY = 86_400_000;
let db: ReturnType<typeof createInMemoryFixtureDb>;

function rec(id: string, detector = "D2", metric = "avg_context_per_turn") {
  db.prepare(`INSERT INTO recommendations
    (rec_id,provenance,detector_id,category,scope_workspace_id,lever,
     modeled_formula_json,evidence_json,target_metric,state,created_at)
    VALUES(?,'RULE',?,'CONTEXT','ws-alpha','test','{}','{}',?,'PROPOSED',?)`).run(
    id,
    detector,
    metric,
    NOW.toISOString(),
  );
}

beforeEach(() => {
  gate.enabled = true;
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("ESF2 writer switch", () => {
  it("protects active D1 history and releases terminal windows without treating v2 adoption as malformed W4", () => {
    rec("retention", "D1");
    db.prepare("UPDATE recommendations SET evidence_json=? WHERE rec_id='retention'").run(
      JSON.stringify({ component: "CLAUDE_MD", file_ref: "/synthetic/esf.md" }),
    );
    const history = (days: number) =>
      Number(
        db
          .prepare(`INSERT INTO context_inventory_history
      (workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at)
      VALUES('ws-alpha','CLAUDE_MD','/synthetic/esf.md',?,100,'chars4-v1',?)`)
          .run(`hash-${days}`, new Date(NOW.getTime() + days * DAY).toISOString()).lastInsertRowid,
      );
    const baseline = history(-1);
    adoptRecommendation("retention", NOW.getTime(), { completedChange: true });
    const after = history(1);
    const latest = history(20);
    const policy = { maxAgeDays: 1, maxUnprotectedRowsPerSource: 0 };
    const inspect = () =>
      inspectContextHistoryRetention(db, new Date(NOW.getTime() + 100 * DAY), policy);
    const open = inspect();
    expect(open.ok).toBe(true);
    expect(open.candidate_ids).not.toContain(baseline);
    expect(open.candidate_ids).not.toContain(after);
    expect(open.candidate_ids).not.toContain(latest);
    const cycle = getRecommendationCard("retention")?.effect_cycle;
    if (!cycle) throw new Error("missing cycle");
    effectEngineForDb(db).stop(cycle.cycleId, {
      idempotencyKey: "retain-stop",
      reason: "USER_STOPPED",
      at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    });
    const frozen = effectEngineForDb(db).getCycle(cycle.cycleId);
    expect(inspect().candidate_ids).toEqual(expect.arrayContaining([baseline, after]));
    expect(compactContextHistory(db, new Date(NOW.getTime() + 100 * DAY), policy).ok).toBe(true);
    expect(effectEngineForDb(db).getCycle(cycle.cycleId)).toEqual(frozen);
  });

  it("requires completed-change confirmation and writes only a versioned cycle", () => {
    rec("writer-new");
    expect(() => adoptRecommendation("writer-new", NOW.getTime())).toThrow(/complete/);
    expect(db.prepare("SELECT * FROM effect_cycles").all()).toHaveLength(0);
    adoptRecommendation("writer-new", NOW.getTime(), { completedChange: true });
    expect(db.prepare("SELECT * FROM recommendation_effects").all()).toHaveLength(0);
    const card = getRecommendationCard("writer-new");
    expect(card?.effect_cycle).toMatchObject({
      recId: "writer-new",
      state: "OPEN_SETTLING",
      applicationSource: "USER_ATTESTED",
    });
    expect(card?.effect_capability?.mode).toBe("TRACKABLE");
    expect(
      listRecommendations().data?.adopted.find((r) => r.rec_id === "writer-new")?.effect_cycle,
    ).toEqual(card?.effect_cycle);
    expect(listLedger().data?.entries.find((r) => r.rec_id === "writer-new")?.effect_cycle).toEqual(
      card?.effect_cycle,
    );
  });

  it("acknowledges warnings without a cycle and refuses unsupported measurement", () => {
    rec("warning", "D5", "limit_burn_forecast");
    rec("manual", "D6", "tool_result_bytes");
    adoptRecommendation("warning", NOW.getTime());
    expect(getRecommendationCard("warning")?.effect_capability?.mode).toBe("ACKNOWLEDGEMENT");
    expect(() => adoptRecommendation("manual", NOW.getTime(), { completedChange: true })).toThrow(
      /Manual measurement/,
    );
    expect(getRecommendationCard("manual")?.effect_capability?.mode).toBe("MANUAL");
    expect(getRecommendationCard("manual")?.state).toBe("PROPOSED");
    expect(db.prepare("SELECT * FROM effect_cycles").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM recommendation_effects").all()).toHaveLength(0);
  });

  it("preserves exact W4 rows while the probe advances only versioned measurement", () => {
    rec("legacy");
    gate.enabled = false;
    adoptRecommendation("legacy", NOW.getTime());
    const before = db.prepare("SELECT * FROM recommendation_effects").all();
    gate.enabled = true;
    rec("current");
    adoptRecommendation("current", NOW.getTime(), { completedChange: true });
    const end = new Date(NOW.getTime() + 15 * DAY);
    expect(runMeasurementPass(db, end, { force: true })).toEqual({
      to_measuring: 0,
      verdicts: 0,
      skipped: 0,
    });
    runEffectMeasurementPass(db, end);
    expect(getRecommendationCard("current")?.effect_cycle?.state).toBe("FINALIZED");
    expect(getRecommendationCard("current")?.state).toBe("ADOPTED");
    expect(db.prepare("SELECT * FROM recommendation_effects").all()).toEqual(before);
    expect(getRecommendationCard("legacy")?.state).toBe("ADOPTED");
  });

  it("keeps versioned evidence readable and untouched when the new writer is disabled", () => {
    rec("disabled");
    adoptRecommendation("disabled", NOW.getTime(), { completedChange: true });
    const before = db.prepare("SELECT * FROM effect_cycles").all();
    gate.enabled = false;
    runEffectMeasurementPass(db, new Date(NOW.getTime() + 15 * DAY));
    expect(db.prepare("SELECT * FROM effect_cycles").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM recommendation_effects").all()).toHaveLength(0);
    expect(getRecommendationCard("disabled")?.state).toBe("ADOPTED");
    expect(getRecommendationCard("disabled")?.effect_cycle?.state).toBe("OPEN_SETTLING");
    expect(getRecommendationCard("disabled")?.effect_capability?.mode).toBe("READ_ONLY");
  });

  it("keeps an earlier terminal cycle immutable when a later cycle is tracked", () => {
    rec("retrack");
    adoptRecommendation("retrack", NOW.getTime(), { completedChange: true });
    const engine = effectEngineForDb(db);
    const first = getRecommendationCard("retrack")?.effect_cycle;
    if (!first) throw new Error("missing first cycle");
    engine.stop(first.cycleId, {
      idempotencyKey: "stop",
      reason: "USER_STOPPED",
      at: NOW.toISOString(),
    });
    const frozen = engine.getCycle(first.cycleId);
    // The tracking API allows a new cycle; the legacy adoption route remains a one-time action.
    engine.track({
      recId: "retrack",
      detectorId: "D2",
      targetMetric: "avg_context_per_turn",
      scope: { workspaceId: "ws-alpha" },
      cohort: {},
      appliedAt: new Date(NOW.getTime() + DAY).toISOString(),
      trackingRequestedAt: new Date(NOW.getTime() + DAY).toISOString(),
      applicationSource: "USER_ATTESTED",
      idempotencyKey: "again",
    });
    expect(getRecommendationCard("retrack")?.effect_cycle?.cycleNo).toBe(2);
    expect(engine.getCycle(first.cycleId)).toEqual(frozen);
  });
});
