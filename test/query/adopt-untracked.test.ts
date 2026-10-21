/**
 * REL-FIX bug 2 — Adopt on a recommendation with no effect handler (B1/HABIT-shaped).
 * Operator decision 2026-10-19 (option b): Adopt saves the adoption without effect
 * tracking — state ADOPTED, no effect cycle, response says the effect is not measured.
 * Real tracking failures (overlap, bad binding) still refuse with their reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptRecommendation,
  getRecommendationCard,
  undoAdoptRecommendation,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const forced = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock("../../src/query/api/effect-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/query/api/effect-service.js")>();
  return {
    ...actual,
    trackCompletedChange: (...args: Parameters<typeof actual.trackCompletedChange>) =>
      forced.reason === null
        ? actual.trackCompletedChange(...args)
        : { supported: false, state: "UNAVAILABLE", reason: forced.reason },
  };
});

const NOW = new Date("2026-06-15T00:00:00.000Z");
let db: ReturnType<typeof createInMemoryFixtureDb>;

function state(id: string) {
  return db.prepare("SELECT state, adopted_at FROM recommendations WHERE rec_id=?").get(id);
}

beforeEach(() => {
  forced.reason = null;
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  // D6 has no effect handler: capability MANUAL / HANDLER_UNAVAILABLE, same path as B1.
  seedValidatedRecommendation(db, {
    recId: "no-handler",
    templateId: "D6_TOOL_RESULT_BLOAT",
    createdAt: NOW.toISOString(),
  });
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("adopt without an effect handler", () => {
  it("saves the adoption, writes no effect rows, and reports the effect as not measured", () => {
    expect(getRecommendationCard("no-handler")?.effect_capability).toEqual({
      mode: "MANUAL",
      reason: "HANDLER_UNAVAILABLE",
    });
    const response = adoptRecommendation("no-handler", NOW.getTime(), { completedChange: true });
    expect(response.data).toEqual({ ok: true, effect_measured: false });
    expect(state("no-handler")).toEqual({ state: "ADOPTED", adopted_at: NOW.toISOString() });
    expect(db.prepare("SELECT * FROM effect_cycles").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM recommendation_effects").all()).toHaveLength(0);
    expect(getRecommendationCard("no-handler")?.effect_cycle ?? null).toBeNull();
  });

  it("still requires the completed-change confirmation", () => {
    expect(() => adoptRecommendation("no-handler", NOW.getTime())).toThrow(/complete/);
    expect(state("no-handler")).toEqual({ state: "PROPOSED", adopted_at: null });
  });

  it("undo-adopt returns an un-tracked adoption to PROPOSED", () => {
    adoptRecommendation("no-handler", NOW.getTime(), { completedChange: true });
    expect(undoAdoptRecommendation("no-handler", "undo-untracked", NOW.getTime() + 1).data).toEqual(
      { ok: true },
    );
    expect(state("no-handler")).toEqual({ state: "PROPOSED", adopted_at: null });
    expect(db.prepare("SELECT * FROM effect_cycles").all()).toHaveLength(0);
  });

  it("keeps a measured adoption's response unchanged", () => {
    seedValidatedRecommendation(db, {
      recId: "tracked",
      templateId: "D2_LONG_FULL_CONTEXT",
      createdAt: NOW.toISOString(),
    });
    const response = adoptRecommendation("tracked", NOW.getTime(), { completedChange: true });
    expect(response.data).toEqual({ ok: true });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id='tracked'").all()).toHaveLength(1);
  });

  it.each(["OVERLAPPING_INTERVENTION", "INVALID_ARTIFACT_BINDING"])(
    "refuses a real tracking failure (%s) and names it",
    (reason) => {
      forced.reason = reason;
      expect(() =>
        adoptRecommendation("no-handler", NOW.getTime(), { completedChange: true }),
      ).toThrow(new RegExp(reason));
      expect(state("no-handler")).toEqual({ state: "PROPOSED", adopted_at: null });
      expect(db.prepare("SELECT * FROM effect_cycles").all()).toHaveLength(0);
    },
  );
});
