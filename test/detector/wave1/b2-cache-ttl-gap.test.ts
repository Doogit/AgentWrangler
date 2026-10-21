import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  B2_CONSERVATIVE_TTL_GAP_MS,
  b2Detector,
} from "../../../src/detector/detectors/b2_cache_ttl_gap.js";
import { buildContext, runDetectors } from "../../../src/detector/engine.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-b2', 'ws-b2', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags) VALUES ('session-b2', 'ws-b2', '/fixture/b2.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')",
  ).run(CTX.fromIso, CTX.toIso);
});
afterEach(() => db.close());
function turn(id: string, ts: string, reads: number, cacheWrite5m = 0, cacheWrite1h = 0) {
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_claim, provisional, parser_version) VALUES (?, 'session-b2', 'ws-b2', ?, 'claude-sonnet-4-6', 0, 0, 0, ?, ?, ?, 0, 'LIST_EQUIV', 0, 'test')",
  ).run(id, ts, reads, cacheWrite5m, cacheWrite1h);
}
describe("B2 TTL_GAP_MISS V2", () => {
  it("requires a collapse after a strictly greater-than-one-hour gap on a 1h thread and never claims a plan", () => {
    turn("previous", "2027-01-02T00:00:00.000Z", 30_000, 0, 1);
    turn("current", "2027-01-02T01:00:00.001Z", 2_000, 60_001);
    const outcome = b2Detector.evaluate(db, CTX);
    assertV2ProducerBoundary(db, CTX, b2Detector);
    expect(outcome.fired).toHaveLength(1);
    expect(outcome.fired[0]?.payload.label).toBe("UNKNOWN_CONSERVATIVE_1H");
    expect(outcome.fired[0]?.payload.metrics).toMatchObject({
      GAP_DURATION_MS: { value: B2_CONSERVATIVE_TTL_GAP_MS + 1 },
    });

    runDetectors(db, CTX, [b2Detector]);
    const row = db
      .prepare(
        "SELECT modeled_formula_json, evidence_json FROM recommendations WHERE detector_id = 'B2'",
      )
      .get() as {
      modeled_formula_json: string;
      evidence_json: string;
    };
    const formula = JSON.parse(row.modeled_formula_json) as { estimate: Record<string, unknown> };
    // The resume turn's creation (60,001) above the base prefix (this session's own first turn,
    // 30,001) = 30,000 * (3.75 - 0.3) * 0.5 = 51,750 µUSD/wk; B2 remains rank-only.
    expect(formula.estimate).toMatchObject({
      basis: "O",
      rank_value_u_per_wk: 51_750,
      summable: false,
    });
    const evidence = JSON.parse(row.evidence_json).session_ids as string[];
    expect(evidence).toEqual(["session-b2"]);
    expect(
      db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(evidence[0]),
    ).toBeDefined();
  });
  it("F29: RESUME_COUNT counts the qualifying resumes the sums run over", () => {
    turn("previous", "2027-01-02T00:00:00.000Z", 30_000, 0, 1);
    turn("resume-1", "2027-01-02T01:00:00.001Z", 2_000, 60_001);
    turn("warm", "2027-01-02T01:01:00.000Z", 60_000, 1_000);
    turn("resume-2", "2027-01-02T03:01:00.000Z", 2_000, 70_000);
    const fired = b2Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload.metrics).toMatchObject({
      RESUME_COUNT: { value: 2 },
      PREVIOUS_CACHE_READ_TOKENS: { value: 90_000 },
      CURRENT_CACHE_READ_TOKENS: { value: 4_000 },
    });
  });
  it("is strict at the TTL boundary", () => {
    turn("previous", "2027-01-03T00:00:00.000Z", 30_000, 0, 1);
    turn("ttl-exact", "2027-01-03T01:00:00.000Z", 2_000, 60_001);
    expect(b2Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });

  it("uses the thread's own TTL: a 10-minute break on a 5m-tier thread is idle expiry", () => {
    turn("previous", "2027-01-03T00:00:00.000Z", 30_000, 1);
    turn("ten-minutes", "2027-01-03T00:10:00.000Z", 2_000, 60_001);
    const fired = b2Detector.evaluate(db, CTX).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload.metrics).toMatchObject({
      GAP_DURATION_MS: { value: 10 * 60_000 },
      CONSERVATIVE_TTL_DURATION_MS: { value: 5 * 60_000 },
    });
  });

  it("prices the resume at the thread's 1h write tier, not the 5m price", () => {
    turn("previous", "2027-01-03T00:00:00.000Z", 30_000, 0, 1);
    turn("resume", "2027-01-03T02:00:00.000Z", 2_000, 0, 60_001);
    runDetectors(db, CTX, [b2Detector]);
    const row = db
      .prepare("SELECT modeled_formula_json FROM recommendations WHERE detector_id = 'B2'")
      .get() as { modeled_formula_json: string };
    const formula = JSON.parse(row.modeled_formula_json) as {
      estimate: { rank_value_u_per_wk: number };
    };
    // 30,000 above base * (6 - 0.3) * 0.5 = 85,500 µUSD/wk (the 1h write price is $6/MTok).
    expect(formula.estimate.rank_value_u_per_wk).toBe(85_500);
  });
});
