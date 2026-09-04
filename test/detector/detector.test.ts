/**
 * test/detector/detector.test.ts — DetectorEngine unit + determinism suite.
 *
 * Seeds the shared fixture DB and drives the detectors under a FROZEN `now`
 * (never new Date()). Covers D2 fire / not-fire / below-threshold, D1
 * NOT_EVALUATED, D5 BLOCKED / INACTIVE / WARNING, and NFR-107-style determinism
 * (two passes over a frozen DB → byte-identical recommendation rows).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d2Detector } from "../../src/detector/detectors/d2_session_long_full_context.js";
import { buildContext } from "../../src/detector/engine.js";
import { runDetectors } from "../../src/detector/index.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Frozen now: 7 days after the fixture base (2026-01-01) — the trailing-7d
// window is [2026-01-01, 2026-01-08).
const NOW = new Date("2026-01-08T00:00:00.000Z");

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});
afterEach(() => db.close());

const insSession = (id: string, turnCount: number, lastTurnAt: string) =>
  db
    .prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, 'ws-alpha', ?, ?, ?, 'RECONCILED', ?, 0, '[]')`,
    )
    .run(id, `/fake/${id}.jsonl`, lastTurnAt, lastTurnAt, turnCount);

const insTurn = (msgId: string, sessionId: string, ts: string, cacheRead: number, input = 0) =>
  db
    .prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
         cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
         provisional, parser_version)
       VALUES (?, ?, 'ws-alpha', ?, 'claude-sonnet', 0, ?, 0, ?, 0, 0, 0, NULL,
         'snap-sonnet', 0, 'LIST_EQUIV', 0, 'test-v1')`,
    )
    .run(msgId, sessionId, ts, input, cacheRead);

/** Insert a qualifying long-context session: turn_count>150, avg context>180k. */
function insQualifying(n: number, ts = "2026-01-02T00:00:00.000Z"): void {
  insSession(`sess-long-${n}`, 200, ts);
  for (let turn = 0; turn <= 150; turn++) {
    insTurn(`msg-long-${n}-${turn}`, `sess-long-${n}`, ts, 200_000);
  }
}

function recRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM recommendations ORDER BY rec_id").all() as Array<
    Record<string, unknown>
  >;
}

describe("D2 — SESSION_LONG_FULL_CONTEXT", () => {
  it("fires with a cache-read-derived modeled figure when ≥3 sessions qualify", () => {
    insQualifying(1);
    insQualifying(2);
    insQualifying(3);

    const statuses = runDetectors(db, { now: NOW });
    const d2Status = statuses.find((s) => s.detector_id === "D2");
    expect(d2Status?.status).toBe("ACTIVE");

    const rows = db
      .prepare("SELECT * FROM recommendations WHERE detector_id = 'D2'")
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const r = rows[0];
    if (r === undefined) throw new Error("missing D2 row");

    expect(r.provenance).toBe("RULE");
    expect(r.category).toBe("CONTEXT");
    expect(r.scope_workspace_id).toBeNull();
    expect(r.state).toBe("PROPOSED");
    expect(r.created_at).toBe(NOW.toISOString());

    // 3 sessions × 151 turns × cache_read 200k × sonnet cache-read price 0.3.
    expect(r.modeled_savings_u_per_wk).toBe(8_969_400);

    const formula = JSON.parse(r.modeled_formula_json as string);
    expect(formula.model).toBe("D2_LONG_CONTEXT_CACHE_READ_V1");
    expect(formula.inputs.cache_read_tokens_per_week).toBe(90_600_000);
    expect(formula.inputs.reduction_fraction).toBe(0.33);
    expect(formula.inputs.cache_read_price_usd_per_mtok).toBeCloseTo(0.3, 6);

    // Reproduce the figure from the stored expression + inputs (within rounding).
    const reproduced =
      (formula.inputs.cache_read_tokens_per_week / 1e6) *
      formula.inputs.cache_read_price_usd_per_mtok *
      formula.inputs.reduction_fraction;
    expect(Math.round(reproduced * 1e6)).toBe(8_969_400);

    const evidence = JSON.parse(r.evidence_json as string);
    expect(evidence.qualifying_session_count).toBe(3);
    expect(evidence.session_ids).toEqual(["sess-long-1", "sess-long-2", "sess-long-3"]);
  });

  it("does NOT fire below the trigger (only 2 qualifying sessions)", () => {
    insQualifying(1);
    insQualifying(2);
    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D2")?.status).toBe("INACTIVE");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id='D2'").get(),
    ).toEqual({ n: 0 });
  });

  it("does NOT count sessions below the context threshold even at high turn_count", () => {
    // 3 sessions, turn_count > 150 but avg context (cache_read 10k) < 180k.
    for (let i = 1; i <= 3; i++) {
      insSession(`sess-small-${i}`, 200, "2026-01-02T00:00:00.000Z");
      for (let turn = 0; turn <= 150; turn++) {
        insTurn(`msg-small-${i}-${turn}`, `sess-small-${i}`, "2026-01-02T00:00:00.000Z", 10_000);
      }
    }
    const out = d2Detector.evaluate(db, buildContext(NOW));
    expect(out.status).toBe("INACTIVE");
    expect(out.fired.length).toBe(0);
  });
});

describe("D1 — CTX_ALWAYS_LOADED_OVERSIZE", () => {
  it("reports NOT_EVALUATED when context_inventory is empty (Phase-1a: no probe)", () => {
    const statuses = runDetectors(db, { now: NOW });
    const d1 = statuses.find((s) => s.detector_id === "D1");
    expect(d1?.status).toBe("NOT_EVALUATED");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id='D1'").get(),
    ).toEqual({ n: 0 });
  });
});

describe("D5 — LIMIT_BURN_FORECAST", () => {
  it("emits a degraded burn trend when :limit_tokens is unset but history exists (AU5)", () => {
    // AU5: forecast OFF with burn history no longer bare-BLOCKS; it emits a
    // directional degraded trend + calibrate nudge. (BLOCKED with no history is
    // covered in d5-limit-burn.test.ts.) The base fixture has turns in-window.
    const statuses = runDetectors(db, { now: NOW });
    const d5 = statuses.find((s) => s.detector_id === "D5");
    expect(d5?.status).toBe("ACTIVE");
    expect(d5?.note).toMatch(/degraded burn trend/);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE detector_id='D5'").get(),
    ).toEqual({ n: 1 });
  });

  it("fires (WARNING) when recent burn projects exhaustion within the warn window", () => {
    // limit set; a big recent burn 12h before `now` → rate high → eta ≤ 2d.
    db.prepare("UPDATE user_config SET value = '3000000000' WHERE key = 'limit_tokens'").run();
    insSession("sess-burn", 1, "2026-01-07T12:00:00.000Z");
    insTurn("msg-burn", "sess-burn", "2026-01-07T12:00:00.000Z", 0, 1_000_000_000);

    const statuses = runDetectors(db, { now: NOW });
    expect(statuses.find((s) => s.detector_id === "D5")?.status).toBe("ACTIVE");

    const rows = db.prepare("SELECT * FROM recommendations WHERE detector_id='D5'").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(1);
    const r = rows[0];
    if (r === undefined) throw new Error("missing D5 row");
    expect(r.category).toBe("LIMIT");
    expect(r.modeled_savings_u_per_wk).toBeNull(); // warning-class
    expect(JSON.parse(r.modeled_formula_json as string)).toEqual({
      model: "none",
      inputs: {},
      kind: "WARNING",
    });
    const evidence = JSON.parse(r.evidence_json as string);
    expect(evidence.state).toBe("WARNING");
    expect(evidence.limit_tokens).toBe(3_000_000_000);
  });
});

describe("determinism (NFR-107-style)", () => {
  it("two passes over a frozen DB under a frozen now yield byte-identical rows", () => {
    insQualifying(1);
    insQualifying(2);
    insQualifying(3);

    runDetectors(db, { now: NOW });
    const first = recRows();
    runDetectors(db, { now: NOW });
    const second = recRows();
    expect(second).toEqual(first);
  });

  it("drop → re-run under the same frozen now reproduces the same rows", () => {
    insQualifying(1);
    insQualifying(2);
    insQualifying(3);

    runDetectors(db, { now: NOW });
    const first = recRows();

    db.prepare("DELETE FROM recommendations").run();
    runDetectors(db, { now: NOW });
    expect(recRows()).toEqual(first);
  });
});
