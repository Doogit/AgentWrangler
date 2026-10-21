import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RecommendationPayloadV1,
  recommendationTemplate,
  serializeModeledFormulaV1,
  serializeRecommendationPayloadV1,
} from "../../src/detector/privacy-contract.js";
import { RecEvidenceContext } from "../../src/query/api/rec-evidence.js";
import {
  __recommendationsBuildCount,
  adoptRecommendation,
  dismissRecommendation,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;
const NOW = new Date("2026-01-03T12:01:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  const payload: RecommendationPayloadV1 = {
    version: 1,
    template_id: "D2_LONG_FULL_CONTEXT",
    facts: {
      session_ids: [],
      qualifying_session_count: 0,
      qualifying_turn_count: 0,
      raw_context_average_tokens_per_turn: 0,
      cap_weighted_burn_tokens_per_week: 0,
      cache_read_tokens_per_week: 0,
      cap_read_coefficient: 0.1,
    },
  };
  const definition = recommendationTemplate(payload.template_id);
  db.prepare(`INSERT INTO recommendations
    (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
     modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric,
     state, created_at, contract_version, template_id, contract_status)
    VALUES ('memo-rec', 'RULE', ?, ?, 'ws-alpha', ?, 2000000, ?, ?, ?,
      'PROPOSED', ?, 1, ?, 'V1_VALIDATED')`).run(
    definition.detector_id,
    definition.category,
    definition.lever,
    serializeModeledFormulaV1(payload),
    serializeRecommendationPayloadV1(payload),
    definition.target_metric,
    NOW.toISOString(),
    payload.template_id,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  resetQueryDb();
  db.close();
  vi.useRealTimers();
});

describe("recommendations response memo", () => {
  it("does not cache or count a failed build", () => {
    const before = __recommendationsBuildCount();
    vi.spyOn(RecEvidenceContext.prototype, "enrich").mockImplementationOnce(() => {
      throw new Error("synthetic evidence failure");
    });
    expect(() => listRecommendations()).toThrow("synthetic evidence failure");
    expect(__recommendationsBuildCount()).toBe(before);
    listRecommendations();
    listRecommendations();
    expect(__recommendationsBuildCount()).toBe(before + 1);
  });

  it("does not retain transaction-local results after rollback", () => {
    listRecommendations();
    expect(() =>
      db.transaction(() => {
        db.prepare("UPDATE recommendations SET state='ADOPTED' WHERE rec_id='memo-rec'").run();
        expect(listRecommendations().data?.adopted.map((rec) => rec.rec_id)).toContain("memo-rec");
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(listRecommendations().data?.active.map((rec) => rec.rec_id)).toContain("memo-rec");
  });

  it("fingerprints non-ingest inserts, updates and deletes", () => {
    listRecommendations();
    const before = __recommendationsBuildCount();
    db.prepare(`INSERT INTO detector_status_live
      (detector_id, ordinal, name, status, note, evaluated_at)
      VALUES ('D2', 0, 'memo status', 'ACTIVE', 'before', ?)`).run(NOW.toISOString());
    expect(listRecommendations().data?.detectors.find((d) => d.detector_id === "D2")?.note).toBe(
      "before",
    );
    db.prepare("UPDATE detector_status_live SET note='after' WHERE detector_id='D2'").run();
    expect(listRecommendations().data?.detectors.find((d) => d.detector_id === "D2")?.note).toBe(
      "after",
    );
    db.prepare("DELETE FROM detector_status_live WHERE detector_id='D2'").run();
    expect(
      listRecommendations().data?.detectors.find((d) => d.detector_id === "D2")?.note,
    ).not.toBe("after");
    expect(__recommendationsBuildCount()).toBe(before + 3);
  });

  it("reuses successful builds and keeps global and workspace scopes independently", () => {
    const before = __recommendationsBuildCount();
    const global = listRecommendations();
    expect(listRecommendations()).toEqual(global);
    expect(__recommendationsBuildCount()).toBe(before + 1);
    const scoped = listRecommendations("ws-alpha");
    expect(__recommendationsBuildCount()).toBe(before + 2);
    expect(listRecommendations("ws-alpha")).toEqual(scoped);
    expect(listRecommendations()).toEqual(global);
    expect(__recommendationsBuildCount()).toBe(before + 2);
  });

  const insertIngestTurn = () =>
    db
      .prepare(`INSERT INTO turns
      (message_id, session_id, workspace_id, ts, model, is_sidechain,
       input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
       cache_write_other, pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
      VALUES ('memo-turn', 'sess-a1', 'ws-alpha', ?, 'claude-sonnet', 0,
        1, 1, 0, 0, 0, 0, 'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`)
      .run(NOW.toISOString());

  it("reuses a build across ingest changes for 60 s, then rebuilds", () => {
    listRecommendations();
    const before = __recommendationsBuildCount();
    insertIngestTurn();
    vi.setSystemTime(new Date(NOW.getTime() + 59_000));
    listRecommendations();
    expect(__recommendationsBuildCount()).toBe(before);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    listRecommendations();
    expect(__recommendationsBuildCount()).toBe(before + 1);
  });

  it("rebuilds immediately on adopt even inside the ingest staleness window", () => {
    listRecommendations();
    insertIngestTurn();
    const before = __recommendationsBuildCount();
    adoptRecommendation("memo-rec", NOW.getTime(), { completedChange: true });
    const result = listRecommendations();
    expect(__recommendationsBuildCount()).toBe(before + 1);
    expect(result.data?.adopted.map((rec) => rec.rec_id)).toContain("memo-rec");
  });

  it.each(["dismiss", "adopt", "direct update"])("rebuilds lanes after %s", (action) => {
    expect(listRecommendations().data?.active.map((rec) => rec.rec_id)).toContain("memo-rec");
    const before = __recommendationsBuildCount();
    if (action === "dismiss") dismissRecommendation("memo-rec");
    else if (action === "adopt")
      adoptRecommendation("memo-rec", NOW.getTime(), { completedChange: true });
    else db.prepare("UPDATE recommendations SET state='ADOPTED' WHERE rec_id='memo-rec'").run();
    const result = listRecommendations();
    expect(__recommendationsBuildCount()).toBe(before + 1);
    expect(result.data?.active.map((rec) => rec.rec_id)).not.toContain("memo-rec");
    expect(
      (action === "dismiss" ? result.data?.dismissed : result.data?.adopted)?.map(
        (rec) => rec.rec_id,
      ),
    ).toContain("memo-rec");
  });

  it("expires dismissals before lookup even within the same time bucket", () => {
    dismissRecommendation("memo-rec", NOW.getTime(), "2026-01-03T12:02:00Z");
    listRecommendations();
    const before = __recommendationsBuildCount();
    vi.setSystemTime(new Date("2026-01-03T12:03:00Z"));
    expect(listRecommendations().data?.active.map((rec) => rec.rec_id)).toContain("memo-rec");
    expect(__recommendationsBuildCount()).toBe(before + 1);
  });

  it("rebuilds at the rolling-window time bucket boundary", () => {
    listRecommendations();
    const before = __recommendationsBuildCount();
    vi.setSystemTime(new Date("2026-01-03T12:10:00Z"));
    listRecommendations();
    expect(__recommendationsBuildCount()).toBe(before + 1);
  });
});
