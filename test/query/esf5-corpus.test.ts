import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getEsfObservations,
  getSessionEsfObservations,
} from "../../src/query/api/esf-observations.js";
import { getSessionDrivers } from "../../src/query/api/session-drivers.js";
import {
  DaemonIdIssuer,
  getWorkAllocation,
  recomputeWorkAllocation,
} from "../../src/work-records/index.js";
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
  function allocation(workspaceId: string) {
    const issuer = new DaemonIdIssuer();
    return recomputeWorkAllocation(
      db,
      issuer,
      {
        mutation_id: issuer.issue("MUTATION").id,
        allocation_revision_id: issuer.issue("ALLOCATION_REVISION").id,
        workspace_id: workspaceId,
        cohort_from: ESF5_FROM,
        cohort_to: ESF5_AS_OF,
        evidence_as_of: ESF5_AS_OF,
      },
      () => new Date(ESF5_AS_OF),
    ).allocation;
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
        expect(JSON.parse(row.evidence_json)).toMatchObject({
          session_id: id,
          test_fail_event_count: 3,
          owner_turn_metadata_coverage: 1,
          workspace_context_from: ESF5_FROM,
          workspace_context_to: ESF5_AS_OF,
          workspace_affected_session_ids: c.observed_test_recovery.affected_session_ids,
          workspace_recovered_session_ids: c.observed_test_recovery.recovered_session_ids,
          workspace_qualifying_session_count: 18,
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
  it("FX-SHARED-COST allocates neither record and freezes once-only unallocated cost", () => {
    const a = allocation("ws-shared");
    expect(a).toMatchObject({
      eligible_priced_cost_u: 110_000,
      allocated_priced_cost_u: 0,
      unallocated_priced_cost_u: 110_000,
      unallocated_shared_count: 1,
      records_total: 2,
    });
    expect(a.sessions).toEqual([
      expect.objectContaining({
        session_id: "ses-s01",
        disposition: "UNALLOCATED_SHARED",
        owner_snapshot_id: null,
        priced_cost_u: 110_000,
      }),
    ]);
    db.prepare("UPDATE turns SET cost_equiv_u = 999999 WHERE session_id = 'ses-s01'").run();
    expect(getWorkAllocation(db, a.allocation_revision_id)).toEqual(a);
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
    expect(allocation("ws-live")).toMatchObject({
      eligible_priced_cost_u: 0,
      unpriced_turn_count: 1,
      outcome_counts: { UNREPORTED: 1, UNKNOWN: 0 },
      useful_work_rate: { numerator: 0, denominator: 0, value: null },
    });
  });
  it.each(["ws-alpha", "ws-research", "ws-shared", "ws-live"])(
    "conserves integer microUSD for %s",
    (ws) => {
      const a = allocation(ws);
      expect(a.allocated_priced_cost_u + a.unallocated_priced_cost_u).toBe(
        a.eligible_priced_cost_u,
      );
      expect(a.eligible_priced_cost_u).toBe(
        cohort(ws).allocation_sessions.reduce((n, row) => n + row.priced_cost_u, 0),
      );
    },
  );
});
