import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b3Detector } from "../../../src/detector/detectors/b3_resume_cache_miss.js";
import { buildContext, runDetectors } from "../../../src/detector/engine.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";
import { assertV2ProducerBoundary } from "../../fixtures/v2-producer-boundary.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-b3', 'ws-b3', ?)",
  ).run(CTX.fromIso);
  for (const id of ["prior", "current"])
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?, 'ws-b3', ?, ?, ?, 'RECONCILED', 0, 0, '[]')",
    ).run(id, `/fixture/${id}.jsonl`, CTX.fromIso, CTX.toIso);
});
afterEach(() => db.close());
function turn(id: string, session: string, ts: string, reads: number, write = 0, model = "test") {
  db.prepare(
    "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other, cost_claim, provisional, parser_version) VALUES (?, ?, 'ws-b3', ?, ?, 0, 0, 0, ?, ?, 0, 0, 'LIST_EQUIV', 0, 'test')",
  ).run(id, session, ts, model, reads, write);
}
function link(session: string, work: string) {
  db.prepare(
    "INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at) VALUES (?, 'ws-b3', 1, 'OPEN', ?)",
  ).run(work, CTX.fromIso);
  db.prepare(
    "INSERT INTO session_work_links (session_id, work_item_id, confidence, method) VALUES (?, ?, 1, 'MANUAL')",
  ).run(session, work);
}
describe("B3 RESUME_CACHE_MISS V2", () => {
  it("fires on adjacent cross-session evidence with a short gap, high creation and a context match, with no work-item link", () => {
    // Three fresh sessions set the workspace's base prefix: median first-turn context
    // of [5,000 ×3, 18,000, 22,001] = 5,000.
    for (const fresh of ["fresh-a", "fresh-b", "fresh-c"]) {
      db.prepare(
        "INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?, 'ws-b3', ?, ?, ?, 'RECONCILED', 0, 0, '[]')",
      ).run(fresh, `/fixture/${fresh}.jsonl`, CTX.fromIso, CTX.toIso);
      turn(`${fresh}-turn`, fresh, "2027-01-01T12:00:00.000Z", 0, 5_000, "claude-sonnet-4-6");
    }
    turn("prior-turn", "prior", "2027-01-02T00:00:00.000Z", 18_000, 0, "claude-sonnet-4-6");
    turn("current-turn", "current", "2027-01-02T00:05:00.000Z", 2_000, 20_001, "claude-sonnet-4-6");
    const outcome = b3Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(1);
    assertV2ProducerBoundary(db, CTX, b3Detector);
    runDetectors(db, CTX, [b3Detector]);
    const row = db
      .prepare(
        "SELECT evidence_json, modeled_formula_json FROM recommendations WHERE detector_id = 'B3'",
      )
      .get() as { evidence_json: string; modeled_formula_json: string };
    const evidence = JSON.parse(row.evidence_json) as { session_ids?: string[] };
    expect(evidence.session_ids).toEqual(["current", "prior"]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id IN ('prior', 'current')")
        .get(),
    ).toEqual({ n: 2 });
    const formula = JSON.parse(row.modeled_formula_json) as {
      estimate?: { basis: string; rank_value_u_per_wk: number | null };
    };
    // (20,001 − 5,000 base prefix) × 0.5 × (3.75 − 0.3) = 25,876.7 → 25,877 µUSD/wk.
    expect(formula.estimate).toEqual(
      expect.objectContaining({ basis: "P", rank_value_u_per_wk: 25_877 }),
    );
  });
  it("emits nothing when the resume only re-creates the base prefix", () => {
    // Only two sessions: median first-turn context 21,001 ≥ the 20,001 re-created.
    turn("prior-turn", "prior", "2027-01-02T00:00:00.000Z", 20_000, 0, "claude-sonnet-4-6");
    turn("current-turn", "current", "2027-01-02T00:05:00.000Z", 2_000, 20_001, "claude-sonnet-4-6");
    expect(b3Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });
  it("needs the creation to match the previous context (0.8-1.25x)", () => {
    for (const fresh of ["fresh-a", "fresh-b", "fresh-c"]) {
      db.prepare(
        "INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?, 'ws-b3', ?, ?, ?, 'RECONCILED', 0, 0, '[]')",
      ).run(fresh, `/fixture/${fresh}.jsonl`, CTX.fromIso, CTX.toIso);
      turn(`${fresh}-turn`, fresh, "2027-01-01T12:00:00.000Z", 0, 5_000, "claude-sonnet-4-6");
    }
    // A 60k context followed by a new session that wrote only 30k: not a resume of it.
    turn("prior-turn", "prior", "2027-01-02T00:00:00.000Z", 60_000, 0, "claude-sonnet-4-6");
    turn("current-turn", "current", "2027-01-02T00:03:00.000Z", 2_000, 30_000, "claude-sonnet-4-6");
    expect(b3Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });
  it("rejects an interleaved pair when the current turn is not its session's first eligible turn", () => {
    turn("prior-first", "prior", "2027-01-02T00:00:00.000Z", 30_000);
    turn("current-first", "current", "2027-01-02T00:01:00.000Z", 30_000);
    turn("prior-last", "prior", "2027-01-02T00:02:00.000Z", 30_000);
    turn("current-second", "current", "2027-01-02T00:03:00.000Z", 2_000, 20_001);
    link("prior", "wi-1");
    db.prepare(
      "INSERT INTO session_work_links (session_id, work_item_id, confidence, method) VALUES ('current', 'wi-1', 1, 'MANUAL')",
    ).run();

    expect(b3Detector.evaluate(db, CTX).fired).toHaveLength(0);
  });
  it("does not depend on work-item links (the context match is the signature)", () => {
    // 0 of 40 real pairs shared exactly one link, so the link gate is gone: missing or
    // unequal links make no difference.
    const seed = () => {
      for (const fresh of ["fresh-a", "fresh-b", "fresh-c"]) {
        db.prepare(
          "INSERT OR IGNORE INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?, 'ws-b3', ?, ?, ?, 'RECONCILED', 0, 0, '[]')",
        ).run(fresh, `/fixture/${fresh}.jsonl`, CTX.fromIso, CTX.toIso);
        turn(`${fresh}-turn`, fresh, "2027-01-01T12:00:00.000Z", 0, 5_000, "claude-sonnet-4-6");
      }
      turn("prior-turn", "prior", "2027-01-02T00:00:00.000Z", 18_000, 0, "claude-sonnet-4-6");
      turn(
        "current-turn",
        "current",
        "2027-01-02T00:05:00.000Z",
        2_000,
        20_001,
        "claude-sonnet-4-6",
      );
    };
    seed();
    expect(b3Detector.evaluate(db, CTX).fired).toHaveLength(1);

    link("prior", "wi-1");
    db.prepare(
      "INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at) VALUES ('wi-2', 'ws-b3', 2, 'OPEN', ?)",
    ).run(CTX.fromIso);
    db.prepare(
      "INSERT INTO session_work_links (session_id, work_item_id, confidence, method) VALUES ('current', 'wi-2', 1, 'MANUAL')",
    ).run();
    expect(b3Detector.evaluate(db, CTX).fired).toHaveLength(1);
  });
});
