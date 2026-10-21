/**
 * P2-U4: the history walk's completeness floor (`completeThroughMs`).
 *
 * While the slice loop runs, only history at or after the floor is fully ingested. A
 * floored walk evaluates no week that starts before the floor, adds no new rec whose
 * detector reads before the floor (decision D5: suppress), and retires nothing. It
 * leaves the closed-week cache of an earlier full walk alone.
 *
 * Grid (NOW = 2026-09-22T12:00Z, Tuesday; Monday 00:00 UTC grid):
 *   W0 = [09-15T12:00, 09-22T12:00)  W1 = [09-07, 09-14)  W2 = [08-31, 09-07)  W3 = [08-24, 08-31)
 *
 * SEC-101: synthetic ids, timestamps and counts only.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHistoryWalk } from "../../src/detector/engine.js";
import type { RecommendationPayloadV1 } from "../../src/detector/privacy-contract.js";
import type { Detector } from "../../src/detector/types.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const W0_START = "2026-09-15T12:00:00.000Z";
const W3_START = "2026-08-24T00:00:00.000Z";
const FLOOR = Date.parse(W0_START);

let db: Database.Database;
beforeEach(() => {
  db = migratedMemDb();
});
afterEach(() => db.close());

function turn(id: string, ts: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-a', 'ws-a', ?)",
  ).run("2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
     VALUES (?, 'ws-a', ?, ?, ?, 'RECONCILED', 1, 0, '[]', 0)`,
  ).run(`s-${id}`, `/fixture/${id}.jsonl`, ts, ts);
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
     VALUES (?, ?, 'ws-a', ?, 'synthetic', 'floor-test')`,
  ).run(id, `s-${id}`, ts);
}

/** A payload the privacy contract accepts for `id` (D9 template as in history-walk.test.ts). */
function payload(id: string, n: number): RecommendationPayloadV1 {
  if (id === "D5") {
    return {
      version: 1 as const,
      template_id: "D5_LIMIT_BURN_DEGRADED" as const,
      facts: {
        forecast_state: "OFF",
        session_ids: [],
        tokens_used: n,
        burn_trend: "FLAT",
        recent_cap_weighted_tokens: n,
        recent_cap_weighted_tokens_per_day: n,
        baseline_cap_weighted_tokens: n,
        baseline_cap_weighted_tokens_per_day: n,
        baseline_window_days: 7,
      },
    };
  }
  return {
    version: 1 as const,
    template_id: "D9_BACKGROUND_SESSION" as const,
    facts: { workspace_id: "ws-a", fork_count: n, session_ids: [] },
  };
}

/** Fires with the window's turn count. */
function counter(id: string): Detector {
  return {
    contractVersion: 1,
    id,
    name: `SYNTHETIC_${id}`,
    evaluate(evalDb, ctx) {
      const { n } = evalDb
        .prepare("SELECT COUNT(*) AS n FROM turns WHERE ts >= ? AND ts < ?")
        .get(ctx.fromIso, ctx.toIso) as { n: number };
      if (n === 0) return { fired: [], status: "INACTIVE", note: "no turns" };
      return {
        fired: [
          {
            scopeKey: `${id}|ws-a`,
            scope_workspace_id: "ws-a",
            modeled_savings_u_per_wk: n * 1000,
            payload: payload(id, n),
          },
        ],
        status: "ACTIVE",
        note: `${n} turns`,
      };
    },
  };
}

const recIds = () =>
  (
    db.prepare("SELECT rec_id FROM recommendations ORDER BY rec_id").all() as { rec_id: string }[]
  ).map((r) => r.rec_id);
const marks = () =>
  (
    db.prepare("SELECT week_start FROM detector_week_marks ORDER BY week_start DESC").all() as {
      week_start: string;
    }[]
  ).map((r) => r.week_start);

describe("P2-U4 completeness floor", () => {
  it("evaluates no week before the floor, and its recs are a subset of the full walk's", async () => {
    turn("t-w0", "2026-09-20T10:00:00.000Z");
    turn("t-w3", "2026-08-26T10:00:00.000Z");
    const detectors = [counter("D9")];

    const floored = await runHistoryWalk(db, NOW, { detectors, completeThroughMs: FLOOR });
    expect(floored.evaluated_weeks).toEqual([W0_START]);
    expect(marks()).toEqual([W0_START]);
    const interim = recIds();
    const anchors = db
      .prepare(
        "SELECT json_extract(evidence_json, '$.facts.last_seen_week_start') AS a FROM recommendations",
      )
      .all() as { a: string }[];
    for (const { a } of anchors) expect(Date.parse(a)).toBeGreaterThanOrEqual(FLOOR);

    const full = await runHistoryWalk(db, NOW, { detectors });
    expect(full.evaluated_weeks).toContain(W3_START);
    for (const id of interim) expect(recIds()).toContain(id);
  });

  it("leaves an earlier full walk's closed-week cache in place", async () => {
    turn("t-w0", "2026-09-20T10:00:00.000Z");
    turn("t-w3", "2026-08-26T10:00:00.000Z");
    const detectors = [counter("D9")];
    await runHistoryWalk(db, NOW, { detectors });
    const before = marks();
    const results = db.prepare("SELECT COUNT(*) AS n FROM detector_week_results").get();

    await runHistoryWalk(db, NOW, { detectors, completeThroughMs: FLOOR });

    expect(marks()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM detector_week_results").get()).toEqual(results);
    // The cache is still valid: the next full walk re-evaluates W0 only.
    expect((await runHistoryWalk(db, NOW, { detectors })).evaluated_weeks).toEqual([W0_START]);
  });

  it("adds no new rec from a detector that reads before the floor (D5), but keeps updating an existing one", async () => {
    turn("t-w0", "2026-09-20T10:00:00.000Z");
    // D5 (limit-burn forecast) reads 8 days back from W0's end: past a W0-start floor.
    const detectors = [counter("D5"), counter("D9")];

    await runHistoryWalk(db, NOW, { detectors, completeThroughMs: FLOOR });
    expect(recIds().some((id) => id.includes("D5"))).toBe(false);
    expect(recIds().some((id) => id.includes("D9"))).toBe(true);

    await runHistoryWalk(db, NOW, { detectors });
    const d5 = recIds().filter((id) => id.includes("D5"));
    expect(d5).toHaveLength(1);
    turn("t-w0b", "2026-09-21T10:00:00.000Z");
    await runHistoryWalk(db, NOW, { detectors, completeThroughMs: FLOOR });
    const figure = db
      .prepare("SELECT modeled_savings_u_per_wk AS u FROM recommendations WHERE rec_id = ?")
      .get(d5[0]) as { u: number };
    expect(figure.u).toBe(2000);
  });

  it("retires nothing", async () => {
    turn("t-w3", "2026-08-26T10:00:00.000Z");
    const detectors = [counter("D9")];
    await runHistoryWalk(db, NOW, { detectors });
    expect(db.prepare("SELECT state FROM recommendations").all()).toEqual([{ state: "PROPOSED" }]);

    // Two weeks later the W3 anchor is ≥ 4 weeks old: only a full walk may retire it.
    const later = new Date(NOW.getTime() + 14 * 86_400_000);
    await runHistoryWalk(db, later, {
      detectors,
      completeThroughMs: later.getTime() - 7 * 86_400_000,
    });
    expect(db.prepare("SELECT state FROM recommendations").all()).toEqual([{ state: "PROPOSED" }]);
    await runHistoryWalk(db, later, { detectors });
    expect(db.prepare("SELECT state FROM recommendations").all()).toEqual([{ state: "RETIRED" }]);
  });
});
