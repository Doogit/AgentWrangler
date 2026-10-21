import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getEsfObservations,
  getSessionEsfObservations,
} from "../../src/query/api/esf-observations.js";
import { getSessionDrivers } from "../../src/query/api/session-drivers.js";
import { ESF5_AS_OF, ESF5_FROM, ESF5_IDS, createEsf5Db } from "../fixtures/esf5-corpus.js";

describe("ESF5 fixed resource/activity/allocation corpus", () => {
  let db: ReturnType<typeof createEsf5Db>;
  beforeEach(() => {
    db = createEsf5Db();
  });
  afterEach(() => db.close());
  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
  function cohort(workspaceId: string) {
    const response = getEsfObservations(db, { workspaceId, from: ESF5_FROM, to: ESF5_AS_OF });
    expect(response.meta.window).toEqual({ from: ESF5_FROM, to: ESF5_AS_OF });
    if (!response.data) throw new Error("Missing fixture cohort");
    return response.data;
  }
  it("includes the distinct scoped overlap fixture in the stable corpus inventory", () => {
    expect(ESF5_IDS).toContain("FX-OVERLAP-SCOPED-14D");
    expect(ESF5_IDS.filter((id) => id.startsWith("FX-OVERLAP"))).toEqual([
      "FX-OVERLAP-14D",
      "FX-OVERLAP-SCOPED-14D",
    ]);
  });
  it("FX-RECOVER-18 conserves exact costs and links only six native D7 matches", () => {
    const c = cohort("ws-alpha");
    expect(c.resource).toEqual({
      selected_session_count: 21,
      priced_cost_u: 860_000,
      priced_turn_count: 19,
      unpriced_turn_count: 2,
      unpriced_session_count: 2,
      reconciled_priced_session_count: 16,
      live_priced_session_count: 3,
    });
    expect(c.observed_test_recovery).toMatchObject({
      affected_session_ids: ids("ses-a", 6),
      recovered_session_ids: ids("ses-a", 3),
      eligible_reconciled_qualifying_tool_session_count: 18,
    });
    expect(c.no_commit_activity.session_ids).toEqual(ids("ses-a", 18));
    expect(c.allocation_sessions.reduce((sum, row) => sum + row.priced_cost_u, 0)).toBe(830_000);
    for (const [index, id] of ids("ses-a", 18).entries()) {
      const drivers = getSessionDrivers(db, id).data?.drivers.filter(
        (row) => row.detector_id === "D7",
      );
      expect(drivers).toHaveLength(index < 6 ? 1 : 0);
      if (index < 6) {
        const row = db
          .prepare("SELECT evidence_json FROM recommendations WHERE rec_id = ?")
          .get(drivers?.[0]?.rec_id) as { evidence_json: string };
        // PP2: D7 rolls up per-workspace — the six native ws-alpha matches now
        // resolve to ONE rec whose session_ids link all six; test_fail_event_count
        // is summed across them (6 × 3). getSessionDrivers still attributes it to
        // each session via session_ids, so the toHaveLength(1) check above holds.
        const payload = JSON.parse(row.evidence_json) as {
          template_id: string;
          facts: Record<string, unknown>;
        };
        expect(payload.template_id).toBe("D7_RETRY_LOOP");
        expect(payload.facts).toMatchObject({
          session_ids: ids("ses-a", 6),
          session_count: 6,
          test_fail_event_count: 18,
          owner_turn_metadata_coverage: 1,
        });
      }
      expect(getSessionEsfObservations(db, id).data?.resource.selected_session_count).toBe(1);
    }
  });
  it("FX-RESEARCH-NC preserves the excluded research session without inventing intent", () => {
    expect(cohort("ws-research").no_commit_activity.session_ids).toEqual(ids("ses-r", 4));
    for (let n = 1; n <= 5; n++) {
      const c = getSessionEsfObservations(db, `ses-r0${n}`).data;
      expect(c?.resource.selected_session_count).toBe(1);
      expect(c?.no_commit_activity.session_count).toBe(n < 5 ? 1 : 0);
    }
  });
  it("FX-LIVE-SPARSE keeps LIVE money, unknown cost and skipped feedback distinct", () => {
    const c = cohort("ws-live");
    expect(c.resource).toMatchObject({
      priced_cost_u: 30_000,
      live_priced_session_count: 3,
      unpriced_turn_count: 1,
    });
    expect(c.no_commit_activity).toEqual({
      session_ids: ["ses-l04"],
      session_count: 1,
      live_session_excluded_count: 3,
    });
  });
});
