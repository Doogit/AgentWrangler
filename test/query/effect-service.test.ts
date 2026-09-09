import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EffectRequestError,
  capabilityForRecommendation,
  effectEngineForDb,
  listEffectEvidence,
  mutateEffectCycle,
  opaqueD1SourceIdentity,
  trackCompletedChange,
} from "../../src/query/api/effect-service.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../src/effects/gate.js", () => ({
  get ESF_EFFECT_WRITER_ENABLED() {
    return gate.enabled;
  },
}));

let db: Database.Database;
const T0 = new Date("2026-01-10T00:00:00.000Z");

beforeEach(() => {
  gate.enabled = true;
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

function rec(id: string, fileRef = `/project/${id}.md`, workspace = "ws-alpha"): void {
  db.prepare(`INSERT INTO recommendations
    (rec_id,provenance,detector_id,category,scope_workspace_id,lever,modeled_formula_json,evidence_json,target_metric,state,created_at)
    VALUES (?,'RULE','D1','CONTEXT',?,'x','{}',?,'avg_context_per_turn','PROPOSED',?)`).run(
    id,
    workspace,
    JSON.stringify({ component: "CLAUDE_MD", file_ref: fileRef }),
    T0.toISOString(),
  );
  if (workspace !== "ws-alpha") return;
  db.prepare(`INSERT INTO context_inventory_history
    (workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at)
    VALUES (?,'CLAUDE_MD',?,'h',100,'chars4-v1',?)`).run(
    workspace,
    fileRef,
    new Date(T0.getTime() - 86_400_000).toISOString(),
  );
}

describe("ESF2 effect service", () => {
  it("replays frozen tracking after recommendation drift while rejecting changed caller intent", () => {
    rec("rec-retry");
    const request = { rec_id: "rec-retry", idempotency_key: "retry", completed_change: true };
    const first = trackCompletedChange(db, request, T0);
    db.prepare(
      "UPDATE recommendations SET evidence_json='{}', detector_id='DX', state='DISMISSED' WHERE rec_id='rec-retry'",
    ).run();
    expect(trackCompletedChange(db, request, new Date(T0.getTime() + 1000))).toEqual({
      ...first,
      replayed: true,
    });
    expect(() => trackCompletedChange(db, { ...request, concurrent_change: true }, T0)).toThrow(
      /different request/,
    );
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id='rec-retry'").get()).toEqual({
      state: "DISMISSED",
    });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id='rec-retry'").all()).toHaveLength(
      1,
    );
  });

  it("makes existing cycle mutations read-only when the writer gate is disabled", () => {
    rec("rec-disabled");
    const tracked = trackCompletedChange(
      db,
      { rec_id: "rec-disabled", idempotency_key: "track", completed_change: true },
      T0,
    );
    if (!tracked.supported) throw new Error("missing supported cycle");
    const before = db.prepare("SELECT * FROM effect_cycles").all();
    gate.enabled = false;
    for (const action of ["stop", "close", "rollback", "attest-rollback"]) {
      expect(() =>
        mutateEffectCycle(
          db,
          action,
          { cycle_id: tracked.cycle.cycleId, idempotency_key: action, actual_time_known: false },
          T0,
        ),
      ).toThrow(/disabled/);
    }
    expect(db.prepare("SELECT * FROM effect_cycles").all()).toEqual(before);
    expect(listEffectEvidence(db, null, "rec-disabled").writer_enabled).toBe(false);
  });

  it("uses a stable D1 source identity across recommendation IDs and adopts once", () => {
    rec("rec-a", "/project/shared.md");
    rec("rec-b", "/project/shared.md");
    expect(opaqueD1SourceIdentity(db, "rec-a")).toBe(opaqueD1SourceIdentity(db, "rec-b"));
    const first = trackCompletedChange(
      db,
      { rec_id: "rec-a", idempotency_key: "a", completed_change: true },
      T0,
    );
    const replay = trackCompletedChange(
      db,
      { rec_id: "rec-a", idempotency_key: "a", completed_change: true },
      new Date(T0.getTime() + 1),
    );
    expect(first).toMatchObject({ supported: true, replayed: false });
    expect(replay).toMatchObject({ supported: true, replayed: true });
    expect(replay.supported && first.supported && replay.cycle.appliedAt).toBe(
      first.supported && first.cycle.appliedAt,
    );
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id='rec-a'").get()).toEqual({
      state: "ADOPTED",
    });
  });

  it("finalizes without attributing a replacement D1 source to the frozen cycle", () => {
    rec("rec-drift");
    const before = opaqueD1SourceIdentity(db, "rec-drift");
    const tracked = trackCompletedChange(
      db,
      { rec_id: "rec-drift", idempotency_key: "drift", completed_change: true },
      T0,
    );
    if (!tracked.supported) throw new Error("missing supported cycle");
    expect(tracked.cycle.baselineEvidence.value).toBe(100);
    db.prepare(`INSERT INTO context_inventory_history
      (workspace_id,component,file_ref,file_hash,tokens,attribution_version,observed_at)
      VALUES ('ws-alpha','CLAUDE_MD','/changed.md','replacement',1,'chars4-v1',?)`).run(
      new Date(T0.getTime() + 7 * 86_400_000).toISOString(),
    );
    db.prepare("UPDATE recommendations SET evidence_json=? WHERE rec_id=?").run(
      JSON.stringify({ component: "CLAUDE_MD", file_ref: "/changed.md" }),
      "rec-drift",
    );
    expect(opaqueD1SourceIdentity(db, "rec-drift")).not.toBe(before);
    expect(capabilityForRecommendation(db, "rec-drift")).toEqual({
      mode: "TRACKABLE",
      reason: null,
    });
    const engine = effectEngineForDb(db);
    expect(engine.runPass(new Date(tracked.cycle.scheduledObservationTo)).finalized).toBe(1);
    const finalized = engine.getCycle(tracked.cycle.cycleId);
    expect(finalized).toMatchObject({
      state: "FINALIZED",
      targetDirection: "INSUFFICIENT_DATA",
      baselineEvidence: { value: 100 },
      finalEvidence: {
        before: { value: 100 },
        after: { value: null, excluded: { SOURCE_UNRESOLVED: 1 } },
      },
    });
    expect(finalized?.scope.sourceIdentity).toBe(before);
    expect(JSON.stringify(finalized)).not.toContain("/changed.md");
  });

  it("rejects injected tracking fields and reports unsupported recommendations without writing", () => {
    rec("rec-injected");
    expect(() =>
      trackCompletedChange(
        db,
        {
          rec_id: "rec-injected",
          idempotency_key: "x",
          completed_change: true,
          applied_at: "forged",
        },
        T0,
      ),
    ).toThrow(EffectRequestError);
    db.prepare("UPDATE recommendations SET detector_id='DX' WHERE rec_id='rec-injected'").run();
    expect(
      trackCompletedChange(
        db,
        { rec_id: "rec-injected", idempotency_key: "x", completed_change: true },
        T0,
      ),
    ).toEqual({ supported: false, reason: "HANDLER_UNAVAILABLE" });
  });

  it("pages scoped legacy evidence by timestamp and rec ID without losing tied rows", () => {
    rec("rec-page-a", "/a.md");
    rec("rec-page-b", "/b.md");
    rec("rec-other", "/other.md", "ws-other");
    const at = T0.toISOString();
    for (const id of ["rec-page-a", "rec-page-b", "rec-other"])
      db.prepare(`INSERT INTO recommendation_effects (rec_id,measured_at,before_from,before_to,after_from,after_to,before_value,after_value,before_n,after_n,delta_pct,verdict)
        VALUES (?, ?, 'a','b','c','d',1,2,1,1,0,'INCONCLUSIVE')`).run(id, at);
    const one = listEffectEvidence(db, "ws-alpha", undefined, "1");
    const two = listEffectEvidence(
      db,
      "ws-alpha",
      undefined,
      "1",
      undefined,
      one.next_legacy_cursor ?? undefined,
    );
    expect(one.legacy[0]?.verdict).toBe("INCONCLUSIVE");
    expect([one.legacy[0]?.recId, two.legacy[0]?.recId].sort()).toEqual([
      "rec-page-a",
      "rec-page-b",
    ]);
    expect(() => listEffectEvidence(db, "ws-alpha", undefined, "1", "eyJub3BlIjp0cnVlfQ")).toThrow(
      EffectRequestError,
    );
  });
});
