import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionDrivers } from "../../src/query/api/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const REFERENCE = "2027-06-20T12:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

function insWs(workspaceId: string): void {
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  ).run(workspaceId, workspaceId, REFERENCE);
}

function insSess(sessionId: string, workspaceId: string, costEquivU: number, ts = REFERENCE): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',1,?,'[]')`,
  ).run(sessionId, workspaceId, `/fake/${sessionId}.jsonl`, ts, ts, costEquivU);
}

function insRec({
  recId,
  detectorId,
  workspaceId,
  evidence,
  modeledSavings = null,
}: {
  recId: string;
  detectorId: string;
  workspaceId: string | null;
  evidence: Record<string, unknown>;
  modeledSavings?: number | null;
}): void {
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
        state, created_at)
     VALUES (?,'RULE',?,'TEST',?,'test lever',?,'{}',?,'test_metric','PROPOSED',?)`,
  ).run(recId, detectorId, workspaceId, modeledSavings, JSON.stringify(evidence), REFERENCE);
}

function dataFor(sessionId: string) {
  const data = getSessionDrivers(db, sessionId).data;
  if (data === null) throw new Error("expected session drivers");
  return data;
}

describe("getSessionDrivers", () => {
  it("returns D6 and D8 drivers with only whitelisted measurements", () => {
    insWs("ws-drivers");
    insSess("sess-drivers", "ws-drivers", 100);
    insRec({
      recId: "rec-d6",
      detectorId: "D6",
      workspaceId: "ws-drivers",
      evidence: {
        session_id: "sess-drivers",
        tool_result_bytes: 1024,
        bloat_share: 0.6,
        attributed_tool: "Bash",
        turn_count: 4,
        raw_content: "must not leave the database",
      },
    });
    insRec({
      recId: "rec-d8",
      detectorId: "D8",
      workspaceId: "ws-drivers",
      evidence: {
        session_id: "sess-drivers",
        churn_event_count: 3,
        total_churn_creation_tokens: 400,
        creation_share: 0.4,
        regime: "high_churn",
      },
    });

    const drivers = dataFor("sess-drivers").drivers;
    expect(drivers).toHaveLength(2);
    const d6 = drivers.find((driver) => driver.detector_id === "D6");
    const d8 = drivers.find((driver) => driver.detector_id === "D8");
    expect(d6).toMatchObject({ rec_id: "rec-d6", routing: "rec_card", share: 0.6 });
    expect(d8).toMatchObject({ rec_id: "rec-d8", routing: "hook", share: 0.4 });
    expect(Object.keys(d6?.measured ?? {}).sort()).toEqual([
      "attributed_tool",
      "bloat_share",
      "tool_result_bytes",
      "turn_count",
    ]);
    expect(Object.keys(d8?.measured ?? {}).sort()).toEqual([
      "churn_event_count",
      "creation_share",
      "regime",
      "total_churn_creation_tokens",
    ]);
  });

  it("includes D2 only through its session_ids membership", () => {
    insWs("ws-d2");
    insSess("sess-d2", "ws-d2", 100);
    insRec({
      recId: "rec-d2",
      detectorId: "D2",
      workspaceId: null,
      evidence: { session_ids: ["sess-d2"] },
    });

    expect(dataFor("sess-d2").drivers).toEqual([
      expect.objectContaining({
        detector_id: "D2",
        measured: { in_long_context_group: true },
        share: null,
        routing: "hook",
      }),
    ]);
  });

  it("excludes D4 recommendations", () => {
    insWs("ws-d4");
    insSess("sess-d4", "ws-d4", 100);
    insRec({
      recId: "rec-d4",
      detectorId: "D4",
      workspaceId: "ws-d4",
      evidence: { session_id: "sess-d4" },
    });

    expect(dataFor("sess-d4").drivers).toEqual([]);
  });

  it("converts modeled micro-USD savings and omits unmodeled savings", () => {
    insWs("ws-savings");
    insSess("sess-savings", "ws-savings", 100);
    insRec({
      recId: "rec-priced",
      detectorId: "D8",
      workspaceId: "ws-savings",
      modeledSavings: 1_250_000,
      evidence: { session_id: "sess-savings", creation_share: 0.5 },
    });
    insRec({
      recId: "rec-unpriced",
      detectorId: "D6",
      workspaceId: "ws-savings",
      evidence: { session_id: "sess-savings", bloat_share: 0.7 },
    });

    const drivers = dataFor("sess-savings").drivers;
    expect(drivers.find((driver) => driver.rec_id === "rec-priced")?.approx_usd).toBe(1.25);
    const unpriced = drivers.find((driver) => driver.rec_id === "rec-unpriced");
    expect(unpriced).toBeDefined();
    expect("approx_usd" in (unpriced ?? {})).toBe(false);
  });

  it("computes a 30-day percentile from sessions at or below the target cost", () => {
    insWs("ws-percentile");
    insSess("sess-100", "ws-percentile", 100);
    insSess("sess-200", "ws-percentile", 200);
    insSess("sess-300", "ws-percentile", 300);
    insSess("sess-400", "ws-percentile", 400);

    expect(dataFor("sess-300").percentile).toBe(75);
  });

  it("returns no drivers and a low percentile for a cheap session", () => {
    insWs("ws-cheap");
    insSess("sess-cheap", "ws-cheap", 100);
    insSess("sess-mid", "ws-cheap", 200);
    insSess("sess-high", "ws-cheap", 300);
    insSess("sess-higher", "ws-cheap", 400);

    const data = dataFor("sess-cheap");
    expect(data.drivers).toEqual([]);
    expect(data.percentile).toBeLessThan(75);
  });

  it("returns null data for an unknown session", () => {
    expect(getSessionDrivers(db, "nope").data).toBeNull();
  });
});
