import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directionFor, findHandler } from "../../src/effects/index.js";
import {
  decisionCycleDispositions,
  decisionTrackability,
  latestCycleForDecision,
  recIdForDecision,
  trackDecision,
} from "../../src/query/api/decision-track.js";
import {
  EffectRequestError,
  listEffectEvidence,
  mutateEffectCycle,
} from "../../src/query/api/effect-service.js";
import { getFeedback } from "../../src/query/api/feedback-store.js";
import { listRecommendations } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { trustedDecisionContract } from "../../src/query/decision-contract.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../src/effects/gate.js", () => ({
  get ESF_EFFECT_WRITER_ENABLED() {
    return gate.enabled;
  },
}));

let db: Database.Database;
const T0 = new Date("2026-06-10T00:00:00.000Z");
// A CONTEXT_CACHE_BEHAVIOR decision identity (family + sorted opaque evidence ids).
const CACHE_ID = "CONTEXT_CACHE_BEHAVIOR:ev_cache_001";

beforeEach(() => {
  gate.enabled = true;
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

function recRow(recId: string) {
  return db
    .prepare(
      "SELECT rec_id, provenance, detector_id, target_metric, category, state, evidence_json FROM recommendations WHERE rec_id=?",
    )
    .get(recId) as
    | {
        rec_id: string;
        provenance: string;
        detector_id: string;
        target_metric: string;
        category: string;
        state: string;
        evidence_json: string;
      }
    | undefined;
}

describe("RIQ5 decision trackability", () => {
  it("maps only CONTEXT_CACHE_BEHAVIOR to a validated method; other families are MANUAL", () => {
    expect(decisionTrackability("CONTEXT_CACHE_BEHAVIOR")).toEqual({
      mode: "TRACKABLE",
      reason: null,
    });
    expect(decisionTrackability("EXPLAIN_USAGE_CHANGE")).toEqual({
      mode: "MANUAL",
      reason: "NO_VALIDATED_METHOD",
    });
    expect(decisionTrackability("TOOL_OUTPUT_RETRY_CONCENTRATION")).toEqual({
      mode: "MANUAL",
      reason: "NO_VALIDATED_METHOD",
    });
  });

  it("falls back to MANUAL when the effect writer is disabled", () => {
    gate.enabled = false;
    expect(decisionTrackability("CONTEXT_CACHE_BEHAVIOR")).toEqual({
      mode: "MANUAL",
      reason: "WRITER_DISABLED",
    });
  });
});

describe("RIQ5 D8 measured-mapping validation", () => {
  // Proves the D8 handler measures the CONTEXT_CACHE_BEHAVIOR effect: a rise in
  // the cache-read/creation ratio past the +15% threshold reads as IMPROVED, a
  // fall past -15% as WORSENED, small moves as UNCHANGED. This is the synthetic
  // test that gates the family→D8 mapping (spec §RIQ5: no silent inheritance).
  it("classifies a cache-ratio change as the family's projected effect", () => {
    const d8 = findHandler("D8", "d8-cache-ratio");
    if (d8 === null) throw new Error("D8 handler missing");
    expect(directionFor(d8, 0.5, 0.65).direction).toBe("IMPROVED");
    expect(directionFor(d8, 0.5, 0.45).direction).toBe("UNCHANGED");
    expect(directionFor(d8, 0.5, 0.4).direction).toBe("WORSENED");
  });
});

describe("RIQ5 trackDecision — measured path", () => {
  it("requires explicit completed-change confirmation", () => {
    expect(() =>
      trackDecision(
        db,
        {
          decision_identity: CACHE_ID,
          family: "CONTEXT_CACHE_BEHAVIOR",
          workspace_id: null,
          completed_change: false,
        },
        T0,
      ),
    ).toThrow(EffectRequestError);
  });

  it("upserts a riq- rec and opens exactly one real cycle, adopting the rec", () => {
    const result = trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    if (result.mode !== "TRACKABLE" || !result.supported)
      throw new Error("expected a tracked cycle");
    expect(result.cycle.state).toBe("OPEN_SETTLING");
    expect(result.cycle.metricId).toBe("d8-cache-ratio");

    const recId = recIdForDecision(null, CACHE_ID);
    expect(recId).toMatch(/^riq-global-/);
    const row = recRow(recId);
    expect(row).toMatchObject({
      provenance: "RULE",
      detector_id: "D8",
      state: "ADOPTED",
      category: "CACHE",
    });
    // SEC-101: evidence_json carries only the identity + family.
    expect(JSON.parse(row?.evidence_json ?? "{}")).toEqual({
      decision_identity: CACHE_ID,
      riq_family: "CONTEXT_CACHE_BEHAVIOR",
    });
    expect(latestCycleForDecision(db, null, CACHE_ID)?.cycleId).toBe(result.cycle.cycleId);
  });

  it("replays on the same intent and never opens a second concurrent cycle", () => {
    const first = trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    const second = trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    if (first.mode !== "TRACKABLE" || !first.supported) throw new Error();
    if (second.mode !== "TRACKABLE" || !second.supported) throw new Error();
    expect(second.replayed).toBe(true);
    expect(second.cycle.cycleId).toBe(first.cycle.cycleId);
    const cycleCount = db
      .prepare("SELECT COUNT(*) AS c FROM effect_cycles WHERE rec_id=?")
      .get(recIdForDecision(null, CACHE_ID)) as { c: number };
    expect(cycleCount.c).toBe(1);
  });

  it("rejects opening a second cycle under a different intent while one is open (exclusive scope)", () => {
    trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    expect(() =>
      trackDecision(
        db,
        {
          decision_identity: CACHE_ID,
          family: "CONTEXT_CACHE_BEHAVIOR",
          workspace_id: null,
          completed_change: true,
          intent: "retrack",
        },
        T0,
      ),
    ).toThrow(/open effect cycle/);
  });

  it("allows a fresh cycle after the open one is stopped (stop → retrack happy path)", () => {
    const first = trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    if (first.mode !== "TRACKABLE" || !first.supported) throw new Error("expected first cycle");

    // Stop the open cycle — the exclusive-scope guard only blocks while a cycle is OPEN.
    mutateEffectCycle(db, "stop", { cycle_id: first.cycle.cycleId, idempotency_key: "stop-1" }, T0);

    // Retrack under a new intent → a second cycle opens (no `open effect cycle` conflict).
    const second = trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
        intent: "retrack",
      },
      T0,
    );
    if (second.mode !== "TRACKABLE" || !second.supported)
      throw new Error("expected retracked cycle");
    expect(second.replayed).toBe(false);
    expect(second.cycle.cycleId).not.toBe(first.cycle.cycleId);
    expect(second.cycle.state).toBe("OPEN_SETTLING");

    const recId = recIdForDecision(null, CACHE_ID);
    const total = db
      .prepare("SELECT COUNT(*) AS c FROM effect_cycles WHERE rec_id=?")
      .get(recId) as { c: number };
    expect(total.c).toBe(2);
    // The decision is being measured again (open), and the latest cycle is the retrack.
    expect(decisionCycleDispositions(db, null).open).toEqual(new Set([CACHE_ID]));
    expect(latestCycleForDecision(db, null, CACHE_ID)?.cycleId).toBe(second.cycle.cycleId);
  });

  it("groups an open cycle as `open` and a finalized one as `terminal`", () => {
    trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    expect(decisionCycleDispositions(db, null).open).toEqual(new Set([CACHE_ID]));
    db.prepare("UPDATE effect_cycles SET state='FINALIZED' WHERE rec_id=?").run(
      recIdForDecision(null, CACHE_ID),
    );
    const after = decisionCycleDispositions(db, null);
    expect(after.open.size).toBe(0);
    expect(after.terminal).toEqual(new Set([CACHE_ID]));
  });

  it("keeps the synthesized riq- rec out of the recommendation card lists", () => {
    trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    const view = listRecommendations().data;
    if (view === null) throw new Error("no recommendations view");
    const all = [...view.active, ...view.adopted, ...view.dismissed, ...view.limit_warnings];
    expect(all.some((card) => card.rec_id.startsWith("riq-"))).toBe(false);
  });

  it("matches workspace scope exactly when the identifier contains LIKE metacharacters", () => {
    const otherIdentity = "CONTEXT_CACHE_BEHAVIOR:ev_cache_002";
    trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: "ws_",
        completed_change: true,
      },
      T0,
    );
    trackDecision(
      db,
      {
        decision_identity: otherIdentity,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: "ws-other",
        completed_change: true,
      },
      T0,
    );

    expect(decisionCycleDispositions(db, "ws_").open).toEqual(new Set([CACHE_ID]));
  });

  it("fails closed when a synthesized decision contract is tampered", () => {
    trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    const recId = recIdForDecision(null, CACHE_ID);
    db.prepare("UPDATE recommendations SET evidence_json=? WHERE rec_id=?").run(
      JSON.stringify({
        decision_identity: "CONTEXT_CACHE_BEHAVIOR:ev_cache_001,../../secret",
        riq_family: "CONTEXT_CACHE_BEHAVIOR",
      }),
      recId,
    );
    expect(decisionCycleDispositions(db, null)).toEqual({
      open: new Set(),
      terminal: new Set(),
    });
    expect(() => latestCycleForDecision(db, null, CACHE_ID)).toThrow(/contract is not trusted/);
    expect(listEffectEvidence(db, null, recId).cycles).toEqual([]);
    const cycleId = (
      db.prepare("SELECT cycle_id FROM effect_cycles WHERE rec_id=?").get(recId) as {
        cycle_id: string;
      }
    ).cycle_id;
    expect(() =>
      mutateEffectCycle(db, "stop", { cycle_id: cycleId, idempotency_key: "tampered-stop" }, T0),
    ).toThrow(/contract is not trusted/);
    expect(() =>
      trackDecision(
        db,
        {
          decision_identity: CACHE_ID,
          family: "CONTEXT_CACHE_BEHAVIOR",
          workspace_id: null,
          completed_change: true,
        },
        T0,
      ),
    ).toThrow(/contract is not trusted/);
  });
});

describe("RIQ5 trackDecision — manual path", () => {
  it("rejects a decision identity belonging to a different family", () => {
    const mismatched = "CONTEXT_CACHE_BEHAVIOR:ev_cache_001";
    expect(() =>
      trackDecision(
        db,
        {
          decision_identity: mismatched,
          family: "EXPLAIN_USAGE_CHANGE",
          workspace_id: null,
          completed_change: true,
        },
        T0,
      ),
    ).toThrow(/does not match family/);
    expect(getFeedback(db, "__global__", mismatched)).toBeNull();
  });

  it("rejects unbounded or reserved workspace scopes without global collisions", () => {
    expect(recIdForDecision(null, CACHE_ID)).not.toBe(recIdForDecision("global", CACHE_ID));
    for (const workspaceId of ["global", "__global__", "x".repeat(161), "private/workspace"]) {
      expect(() =>
        trackDecision(
          db,
          {
            decision_identity: CACHE_ID,
            family: "CONTEXT_CACHE_BEHAVIOR",
            workspace_id: workspaceId,
            completed_change: true,
          },
          T0,
        ),
      ).toThrow(/bounded opaque identifier/);
    }
    expect(db.prepare("SELECT * FROM recommendations WHERE rec_id LIKE 'riq-%'").all()).toEqual([]);
  });

  it("rejects a persisted decision row with a reserved workspace scope", () => {
    trackDecision(
      db,
      {
        decision_identity: CACHE_ID,
        family: "CONTEXT_CACHE_BEHAVIOR",
        workspace_id: "ws-valid",
        completed_change: true,
      },
      T0,
    );
    const stored = db
      .prepare(
        `SELECT rec_id, provenance, detector_id, category, scope_workspace_id, lever,
                target_metric, evidence_json, contract_version, template_id,
                contract_status, rule_id
           FROM recommendations WHERE rec_id = ?`,
      )
      .get(recIdForDecision("ws-valid", CACHE_ID));
    expect(
      trustedDecisionContract({
        ...(stored as Parameters<typeof trustedDecisionContract>[0]),
        rec_id: recIdForDecision("global", CACHE_ID),
        scope_workspace_id: "global",
      }),
    ).toBeNull();
  });

  it("records an ALREADY_DONE attestation and opens no cycle for an unmapped family", () => {
    const id = "EXPLAIN_USAGE_CHANGE:ev_usage_001";
    const result = trackDecision(
      db,
      {
        decision_identity: id,
        family: "EXPLAIN_USAGE_CHANGE",
        workspace_id: null,
        completed_change: true,
      },
      T0,
    );
    expect(result).toEqual({ mode: "MANUAL", recorded: true });
    expect(getFeedback(db, "__global__", id)?.feedback).toBe("ALREADY_DONE");
    expect(latestCycleForDecision(db, null, id)).toBeNull();
    expect(recRow(recIdForDecision(null, id))).toBeUndefined();
  });
});
