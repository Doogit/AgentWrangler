/**
 * P2H history walk (docs/plans/Archive/spec-rec-page-history-walk.md) — per-week
 * evaluation, anchor merge, week cache, rec-GC after merge.
 *
 * SEC-101: fixtures carry synthetic ids, timestamps and counts only.
 *
 * Grid arithmetic used throughout (NOW = 2026-09-22T12:00Z, a Tuesday; no
 * limit_resets_at → Monday 00:00 UTC grid):
 *   W0 = [NOW − 7d, NOW)            = [2026-09-15T12:00Z, 2026-09-22T12:00Z)
 *   now − 7d = Tue 09-15T12:00Z → newest Monday 00:00 at or before it = 09-14T00:00Z = W1.end
 *   W1 = [09-07, 09-14)  W2 = [08-31, 09-07)  W3 = [08-24, 08-31)
 *   W4 = [08-17, 08-24)  W5 = [08-10, 08-17)  W6 = [08-03, 08-10)
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { a1Detector } from "../../src/detector/detectors/a1_tool_result_bloat.js";
import { d9Detector } from "../../src/detector/detectors/d9_idle_background_session.js";
import { d11Detector } from "../../src/detector/detectors/d11_tool_error_rate.js";
import {
  G11_MIN_COMPARISON_WORK_ITEMS,
  g11Detector,
} from "../../src/detector/detectors/g11_high_spend_failure.js";
import {
  buildContext,
  historyWeeks,
  runDetectors,
  runHistoryWalk,
} from "../../src/detector/engine.js";
import type { Detector, DetectorContext } from "../../src/detector/types.js";
import { withV1R2Facets } from "../../src/query/api/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const W0_START = "2026-09-15T12:00:00.000Z";
const W2_START = "2026-08-31T00:00:00.000Z";
const W3_START = "2026-08-24T00:00:00.000Z";
const W4_START = "2026-08-17T00:00:00.000Z";
const W5_START = "2026-08-10T00:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = migratedMemDb();
});

describe("D11 workspace history transition", () => {
  it("re-evaluates old global closed-week cache and retires only unadopted global history", async () => {
    const ts = "2026-08-25T10:00:00.000Z";
    session("d11-legacy-session", "ws-d11-legacy", ts);
    turn("d11-legacy-turn", "d11-legacy-session", "ws-d11-legacy", ts);
    const insertEvent = db.prepare(
      `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, exit_class)
       VALUES (?, 'd11-legacy-session', ?, ?, 1, ?)`,
    );
    for (let i = 0; i < 50; i++) {
      insertEvent.run(`d11-bash-${i}`, ts, "Bash", i < 3 ? "ERROR" : "OK");
      insertEvent.run(`d11-ps-${i}`, ts, "PowerShell", "OK");
      // D11 counts only failures the shell caused (review 3 B3).
      if (i < 3)
        db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
          `d11-bash-${i}`,
          JSON.stringify({ error: "Exit code 127\n/usr/bin/bash: line 1: rev: command not found" }),
        );
    }
    await runHistoryWalk(db, NOW, { detectors: [d11Detector] });
    const scoped = recs("D11")[0];
    expect(scoped?.scope_workspace_id).toBe("ws-d11-legacy");
    const legacyId = `rec-D11-global-${createHash("sha1")
      .update("D11|tool-error-rate")
      .digest("hex")
      .slice(0, 16)}`;
    db.prepare(
      `INSERT INTO recommendations
       SELECT ?, provenance, detector_id, analysis_run_id, category, NULL,
              lever, modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
              target_metric, 'PROPOSED', created_at, adopted_at, dismissed_until,
              contract_version, template_id, contract_status, rule_id
         FROM recommendations WHERE rec_id = ?`,
    ).run(legacyId, scoped?.rec_id);
    db.prepare(
      `UPDATE detector_week_results SET scope_key = 'D11|tool-error-rate',
              scope_workspace_id = NULL WHERE detector_id = 'D11' AND week_start = ?`,
    ).run(W3_START);
    // Stored by the pre-workspace code version (P2-U8: per-detector eval marks).
    db.prepare(
      "UPDATE detector_eval_marks SET version = 'D11' WHERE window_key = ? AND detector_id = 'D11'",
    ).run(W3_START);

    const result = await runHistoryWalk(db, NOW, { detectors: [d11Detector] });
    expect(result.evaluated_weeks).toContain(W3_START);
    expect(
      db
        .prepare(
          "SELECT scope_key, scope_workspace_id FROM detector_week_results WHERE detector_id = 'D11' AND week_start = ?",
        )
        .all(W3_START),
    ).toEqual([
      {
        scope_key: "D11|tool-error-rate|ws-d11-legacy",
        scope_workspace_id: "ws-d11-legacy",
      },
    ]);
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id = ?").get(legacyId)).toEqual({
      state: "RETIRED",
    });
    expect(recs("D11").find((row) => row.scope_workspace_id === "ws-d11-legacy")?.state).toBe(
      "PROPOSED",
    );

    db.prepare("UPDATE recommendations SET state = 'ADOPTED' WHERE rec_id = ?").run(legacyId);
    await runHistoryWalk(db, NOW, { detectors: [d11Detector] });
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id = ?").get(legacyId)).toEqual({
      state: "ADOPTED",
    });
  });
});

afterEach(() => db.close());

function workspace(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(id, id, "2026-01-01T00:00:00.000Z");
}

function session(id: string, ws: string, ts: string): void {
  workspace(ws);
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags, user_turn_count)
     VALUES (?, ?, ?, ?, ?, 'RECONCILED', 1, 0, '[]', 0)`,
  ).run(id, ws, `/fixture/${id}.jsonl`, ts, ts);
}

function turn(id: string, sessionId: string, ws: string, ts: string): void {
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version)
     VALUES (?, ?, ?, ?, 'synthetic', 'history-walk-test')`,
  ).run(id, sessionId, ws, ts);
}

function fork(agentId: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO subagent_meta
       (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
     VALUES (?, ?, 'fork', NULL, 1, 0)`,
  ).run(agentId, sessionId);
}

/** A session at `ts` with one turn and `forks` fork subagents. */
function forkSession(id: string, ws: string, ts: string, forks: number): void {
  session(id, ws, ts);
  turn(`turn-${id}`, id, ws, ts);
  for (let i = 0; i < forks; i++) fork(`agent-${id}-${i}`, id);
}

/**
 * A merged PR in ws-g11 linked to one reconciled session with one turn of
 * `tokens` input tokens at `terminalAt` (shape from the G11 suite). `outcome`
 * null = the outcomes pass has not written its observed_outcomes row yet.
 */
function addWorkItem(
  id: string,
  number: number,
  tokens: number,
  terminalAt: string,
  outcome: "OBSERVED_SUCCESS" | "OBSERVED_FAILURE" | null = "OBSERVED_SUCCESS",
): void {
  const sessionId = `g11-session-${id}`;
  session(sessionId, "ws-g11", terminalAt);
  db.prepare(
    `INSERT INTO work_items
       (work_item_id, workspace_id, number, state, final_commit, checks_conclusion, opened_at, merged_at, closed_at, synced_at)
     VALUES (?, 'ws-g11', ?, 'MERGED', 'commit', 'SUCCESS', ?, ?, NULL, ?)`,
  ).run(id, number, terminalAt, terminalAt, terminalAt);
  if (outcome !== null) {
    db.prepare(
      `INSERT INTO observed_outcomes (work_item_id, outcome, derived_at, methodology_version)
       VALUES (?, ?, ?, 'test')`,
    ).run(id, outcome, terminalAt);
  }
  db.prepare(
    `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
     VALUES (?, ?, 1, 'MANUAL')`,
  ).run(sessionId, id);
  db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, input_tokens, parser_version)
     VALUES (?, ?, 'ws-g11', ?, 'test', ?, 'history-walk-test')`,
  ).run(`g11-message-${id}`, sessionId, terminalAt, tokens);
}

type Row = Record<string, unknown>;

function recs(detectorId: string): Row[] {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id = ? ORDER BY rec_id")
    .all(detectorId) as Row[];
}

function facts(rec: Row | undefined): Record<string, unknown> {
  if (rec === undefined) throw new Error("expected a rec");
  return JSON.parse(rec.evidence_json as string).facts as Record<string, unknown>;
}

/**
 * Synthetic V1 detector on the D9 template whose figure depends on the window:
 * it counts turns of ws-a in [fromIso, toIso) and fires with
 * modeled_savings_u_per_wk = count × 1000 and fork_count = count.
 */
function turnCounter(onEvaluate?: (ctx: DetectorContext) => void): Detector {
  return {
    contractVersion: 1,
    id: "D9",
    name: "SYNTHETIC_TURN_COUNTER",
    evaluate(evalDb, ctx) {
      onEvaluate?.(ctx);
      const { n } = evalDb
        .prepare(
          "SELECT COUNT(*) AS n FROM turns WHERE workspace_id = 'ws-a' AND ts >= ? AND ts < ?",
        )
        .get(ctx.fromIso, ctx.toIso) as { n: number };
      if (n === 0) return { fired: [], status: "INACTIVE", note: "no turns" };
      return {
        fired: [
          {
            scopeKey: "D9|ws-a",
            scope_workspace_id: "ws-a",
            modeled_savings_u_per_wk: n * 1000,
            payload: {
              version: 1,
              template_id: "D9_BACKGROUND_SESSION",
              facts: { workspace_id: "ws-a", fork_count: n, session_ids: [] },
            },
          },
        ],
        status: "ACTIVE",
        note: `${n} turns`,
      };
    },
  };
}

describe("history week grid", () => {
  it("falls back to the Monday 00:00 UTC grid when limit_resets_at is unset", () => {
    forkSession("s-old", "ws-a", "2026-08-12T10:00:00.000Z", 0);

    const weeks = historyWeeks(db, NOW);

    // Oldest turn 08-12 lies in W5 = [08-10, 08-17); W6 would end 08-10 ≤ 08-12 → excluded.
    expect(weeks.map((w) => [w.index, w.start, w.end])).toEqual([
      [0, W0_START, "2026-09-22T12:00:00.000Z"],
      [1, "2026-09-07T00:00:00.000Z", "2026-09-14T00:00:00.000Z"],
      [2, W2_START, "2026-09-07T00:00:00.000Z"],
      [3, W3_START, W2_START],
      [4, W4_START, W3_START],
      [5, W5_START, W4_START],
    ]);
    // W0 is exactly the trailing window runDetectors evaluates (P2 oracle).
    expect(weeks[0]?.ctx).toEqual(buildContext(NOW));
    // A closed week is evaluated "as of" its end.
    expect(weeks[3]?.ctx).toEqual({
      now: new Date(W2_START),
      fromIso: W3_START,
      toIso: W2_START,
    });
  });

  it("phases closed weeks on user_config.limit_resets_at mod 7d", () => {
    forkSession("s-old", "ws-a", "2026-08-30T10:00:00.000Z", 0);
    // Reset instant Fri 2026-09-25T15:30Z → grid points every Friday 15:30Z.
    db.prepare(
      "INSERT OR REPLACE INTO user_config (key, value, updated_at) VALUES ('limit_resets_at', ?, ?)",
    ).run("2026-09-25T15:30:00.000Z", NOW.toISOString());

    const weeks = historyWeeks(db, NOW);

    // now − 7d = Tue 09-15T12:00Z → newest Friday 15:30 at or before it = 09-11T15:30Z.
    // Oldest turn 08-30T10:00 lies in [08-28T15:30, 09-04T15:30) = W2.
    expect(weeks.map((w) => [w.index, w.start, w.end])).toEqual([
      [0, W0_START, "2026-09-22T12:00:00.000Z"],
      [1, "2026-09-04T15:30:00.000Z", "2026-09-11T15:30:00.000Z"],
      [2, "2026-08-28T15:30:00.000Z", "2026-09-04T15:30:00.000Z"],
    ]);
  });

  it("walks only W0 when every turn is inside W0", () => {
    forkSession("s-new", "ws-a", "2026-09-20T10:00:00.000Z", 0);
    expect(historyWeeks(db, NOW).map((w) => w.index)).toEqual([0]);
  });
});

describe("runHistoryWalk — anchor merge", () => {
  it("lets the event loop serve work between W0 detectors", async () => {
    const order: string[] = [];
    const first: Detector = {
      ...d9Detector,
      id: "SYNTHETIC_FIRST",
      evaluate(evalDb, ctx) {
        order.push("first");
        return d9Detector.evaluate(evalDb, ctx);
      },
    };
    const second: Detector = {
      ...d9Detector,
      id: "SYNTHETIC_SECOND",
      evaluate(evalDb, ctx) {
        order.push("second");
        return d9Detector.evaluate(evalDb, ctx);
      },
    };
    const tick = new Promise<void>((resolve) =>
      setImmediate(() => {
        order.push("tick");
        resolve();
      }),
    );
    await runHistoryWalk(db, NOW, { detectors: [first, second] });
    await tick;
    expect(order.slice(0, 3)).toEqual(["first", "tick", "second"]);
  });

  it("(a) a D9 fork in reset-grid window W5 yields exactly one rec with weeks_ago = 5", async () => {
    forkSession("s-old", "ws-a", "2026-08-12T10:00:00.000Z", 2);

    const result = await runHistoryWalk(db, NOW);

    // Weeks W0..W5 → 6 weeks, all evaluated on a cold cache.
    expect(result.weeks_total).toBe(6);
    expect(result.evaluated_weeks).toHaveLength(6);
    // (D5's uncalibrated-limit warning also fires on this sparse DB; it is not a fork finding.)
    const d9 = recs("D9");
    expect(d9).toHaveLength(1);
    const f = facts(d9[0]);
    expect(f).toMatchObject({
      workspace_id: "ws-a",
      fork_count: 2,
      last_seen_week_start: W5_START,
      weeks_ago: 5,
      weeks_fired: 1,
      weeks_evaluated: 6,
    });
  });

  it("(b) a finding firing in W0 and W3 anchors on W0 with weeks_fired = 2 and W0's figure", async () => {
    // W0: 2 turns; W3: 5 turns → figures 2 × 1000 = 2000 (W0) vs 5 × 1000 = 5000 (W3).
    session("s-w0", "ws-a", "2026-09-20T10:00:00.000Z");
    turn("t-w0-1", "s-w0", "ws-a", "2026-09-20T10:00:00.000Z");
    turn("t-w0-2", "s-w0", "ws-a", "2026-09-20T11:00:00.000Z");
    session("s-w3", "ws-a", "2026-08-25T10:00:00.000Z");
    for (let i = 0; i < 5; i++) turn(`t-w3-${i}`, "s-w3", "ws-a", `2026-08-25T1${i}:00:00.000Z`);

    const result = await runHistoryWalk(db, NOW, { detectors: [turnCounter()] });

    expect(result.weeks_total).toBe(4); // W0..W3 (oldest turn 08-25 ∈ W3)
    const rows = recs("D9");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.modeled_savings_u_per_wk).toBe(2000);
    expect(facts(rows[0])).toMatchObject({
      fork_count: 2,
      last_seen_week_start: W0_START,
      weeks_ago: 0,
      weeks_fired: 2,
      weeks_evaluated: 4,
    });
  });

  it("(c) an ADOPTED rec whose anchor moves to an older week keeps rec_id, state and adopted_at", async () => {
    session("s-w0", "ws-a", "2026-09-20T10:00:00.000Z");
    turn("t-w0-1", "s-w0", "ws-a", "2026-09-20T10:00:00.000Z");
    turn("t-w0-2", "s-w0", "ws-a", "2026-09-20T11:00:00.000Z");
    session("s-w3", "ws-a", "2026-08-25T10:00:00.000Z");
    for (let i = 0; i < 5; i++) turn(`t-w3-${i}`, "s-w3", "ws-a", `2026-08-25T1${i}:00:00.000Z`);
    const detectors = [turnCounter()];
    await runHistoryWalk(db, NOW, { detectors });
    const [before] = recs("D9");
    db.prepare(
      "UPDATE recommendations SET state = 'ADOPTED', adopted_at = '2026-09-21T00:00:00.000Z'",
    ).run();

    // W0's finding stops (its turns go away) — no new turns anywhere.
    db.prepare("DELETE FROM turns WHERE ts >= ?").run(W0_START);
    const second = await runHistoryWalk(db, NOW, { detectors });

    const after = recs("D9");
    expect(after).toHaveLength(1);
    expect(after[0]?.rec_id).toBe(before?.rec_id);
    expect(after[0]?.state).toBe("ADOPTED");
    expect(after[0]?.adopted_at).toBe("2026-09-21T00:00:00.000Z");
    // Anchor moved to W3: figure = 5 × 1000 = 5000, W3's evidence.
    expect(after[0]?.modeled_savings_u_per_wk).toBe(5000);
    expect(facts(after[0])).toMatchObject({
      fork_count: 5,
      last_seen_week_start: W3_START,
      weeks_ago: 3,
      weeks_fired: 1,
    });
    // W0 always; W3 re-evaluated because its cached result lacked stored evidence.
    expect(second.evaluated_weeks).toEqual([W0_START, W3_START]);
  });

  it("trap #1: a PROPOSED rec anchored in W0 is rewritten from its cached older anchor week", async () => {
    forkSession("s-w0", "ws-a", "2026-09-20T10:00:00.000Z", 1);
    forkSession("s-w2", "ws-a", "2026-09-01T10:00:00.000Z", 3);
    await runHistoryWalk(db, NOW);
    expect(facts(recs("D9")[0])).toMatchObject({
      fork_count: 1,
      last_seen_week_start: W0_START,
      weeks_fired: 2,
    });

    // The W0 fork stops being a fork; no turn is written, so W2 stays cached.
    db.prepare(
      "UPDATE subagent_meta SET agent_type = 'general-purpose' WHERE session_id = 's-w0'",
    ).run();
    const second = await runHistoryWalk(db, NOW);

    expect(second.evaluated_weeks).toEqual([W0_START, W2_START]);
    const rows = recs("D9");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("PROPOSED");
    expect(facts(rows[0])).toMatchObject({
      fork_count: 3,
      session_ids: ["s-w2"],
      last_seen_week_start: W2_START,
      weeks_ago: 2,
      weeks_fired: 1,
    });
  });
});

describe("runHistoryWalk — week cache", () => {
  it("(d) a second walk with no new turns evaluates only W0; a new turn re-opens its week", async () => {
    forkSession("s-old", "ws-a", "2026-08-12T10:00:00.000Z", 2);
    const evaluatedWindows: string[] = [];
    const detectors = [turnCounter((ctx) => evaluatedWindows.push(ctx.fromIso))];

    const first = await runHistoryWalk(db, NOW, { detectors });
    expect(first.evaluated_weeks).toHaveLength(6);

    evaluatedWindows.length = 0;
    const second = await runHistoryWalk(db, NOW, { detectors });
    expect(second.evaluated_weeks).toEqual([W0_START]);
    expect(evaluatedWindows).toEqual([W0_START]);

    // A late-ingested turn in W4 invalidates exactly that closed week.
    turn("t-late", "s-old", "ws-a", "2026-08-20T09:00:00.000Z");
    const third = await runHistoryWalk(db, NOW, { detectors });
    expect(third.evaluated_weeks).toEqual([W0_START, W4_START]);
  });

  it("reports per-week progress with the final call at weeks_done === weeks_total", async () => {
    forkSession("s-old", "ws-a", "2026-08-25T10:00:00.000Z", 1);
    const progress: Array<[number, number, number]> = [];

    await runHistoryWalk(db, NOW, {
      detectors: [d9Detector],
      onWeek: (p) => progress.push([p.weeks_done, p.weeks_total, p.new_findings]),
    });

    // W0..W3; the only D9 finding anchors in W3 (index 3 → 4th call).
    expect(progress).toEqual([
      [1, 4, 0],
      [2, 4, 0],
      [3, 4, 0],
      [4, 4, 1],
    ]);

    // F8: a repeat walk re-upserts but inserts nothing → every week reports 0 new.
    progress.length = 0;
    const again = await runHistoryWalk(db, NOW, {
      detectors: [d9Detector],
      onWeek: (p) => progress.push([p.weeks_done, p.weeks_total, p.new_findings]),
    });
    expect(progress.map((p) => p[2])).toEqual([0, 0, 0, 0]);
    expect(again.new_findings).toBe(0);
  });

  it("F8: new_findings counts only inserted recs, not W0 re-upserts", async () => {
    forkSession("s-w0", "ws-b", "2026-09-20T10:00:00.000Z", 1);
    const first = await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const second = await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    // 1 D9 rec (ws-b) inserted on the first walk; the second walk updates it in place.
    expect([first.new_findings, second.new_findings]).toEqual([1, 0]);
  });

  it("F1: a G11 outcome row landing after its closed week was cached re-opens that week", async () => {
    // 20 comparison PRs (G11 floor) merged 08-01..08-20, tokens 100..2000 (index × 100),
    // plus a 2000-token failure merged 08-25 (W3) whose outcome row is not synced yet.
    for (let i = 1; i <= G11_MIN_COMPARISON_WORK_ITEMS; i++) {
      addWorkItem(`cmp-${i}`, i, i * 100, `2026-08-${String(i).padStart(2, "0")}T00:00:00.000Z`);
    }
    addWorkItem("fail", 25, 2_000, "2026-08-25T00:00:00.000Z", null);

    // Oldest turn 08-01 ∈ W7 = [07-27, 08-03) → W0..W7 = 8 weeks.
    const first = await runHistoryWalk(db, NOW, { detectors: [g11Detector] });
    expect(first.weeks_total).toBe(8);
    expect(recs("G11")).toHaveLength(0);

    // The outcomes pass writes only observed_outcomes — no turn lands anywhere.
    db.prepare(
      `INSERT INTO observed_outcomes (work_item_id, outcome, derived_at, methodology_version)
       VALUES ('fail', 'OBSERVED_FAILURE', ?, 'test')`,
    ).run(NOW.toISOString());
    const second = await runHistoryWalk(db, NOW, { detectors: [g11Detector] });

    // Input signature changed → every closed week re-evaluates (8 weeks).
    expect(second.evaluated_weeks).toHaveLength(8);
    const rows = recs("G11");
    expect(rows).toHaveLength(1);
    // p90 of the other 20 = sorted[ceil(20 × 0.9) − 1] = sorted[17] = 1800 ≤ 2000 → fires in W3.
    const recency = JSON.parse(rows[0]?.evidence_json as string).recency;
    expect(recency).toMatchObject({ last_seen_week_start: W3_START, weeks_ago: 3, weeks_fired: 1 });

    // Unchanged inputs → back to W0 only.
    const third = await runHistoryWalk(db, NOW, { detectors: [g11Detector] });
    expect(third.evaluated_weeks).toEqual([W0_START]);
  });
});

describe("runHistoryWalk — recommendation lifecycle after merge", () => {
  it("keeps an older cached rec and retains a newly silent rec for its retirement window", async () => {
    forkSession("s-a", "ws-a", "2026-08-26T10:00:00.000Z", 1); // W3
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1); // W0
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    expect(recs("D9").map((r) => r.scope_workspace_id)).toEqual(
      expect.arrayContaining(["ws-a", "ws-b"]),
    );

    db.prepare(
      "UPDATE subagent_meta SET agent_type = 'general-purpose' WHERE session_id = 's-b'",
    ).run();
    const second = await runHistoryWalk(db, NOW, { detectors: [d9Detector] });

    expect(second.evaluated_weeks).toEqual([W0_START]); // W3 served from cache
    const rows = recs("D9");
    expect(rows.map((r) => r.scope_workspace_id)).toEqual(["ws-a", "ws-b"]);
    expect(facts(rows[0])).toMatchObject({ last_seen_week_start: W3_START, weeks_ago: 3 });
    expect(facts(rows[1])).toMatchObject({ last_seen_week_start: W0_START, weeks_fired: 0 });
    expect(rows[1]?.state).toBe("PROPOSED");
  });

  it("does not change a recommendation when its detector fails in W0", async () => {
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1); // fork in W0
    forkSession("s-plain", "ws-a", "2026-08-26T10:00:00.000Z", 0); // extends the walk to W3
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    expect(recs("D9")).toHaveLength(1);
    const before = recs("D9")[0];

    // The finding disappears everywhere, and the detector throws in W0. P2-U8 (R-6): the
    // walk no longer aborts — it resolves, counts the failure and leaves the rec alone.
    db.prepare("UPDATE subagent_meta SET agent_type = 'general-purpose'").run();
    const failing: Detector = {
      ...d9Detector,
      evaluate(evalDb, ctx) {
        if (ctx.fromIso === W0_START) throw new Error("synthetic W0 failure");
        return d9Detector.evaluate(evalDb, ctx);
      },
    };
    const failed = await runHistoryWalk(db, NOW, { detectors: [failing] });
    expect(failed.failed_detectors).toBe(1);
    expect(recs("D9")).toEqual([before]);

    // A completed walk records the silent week but keeps the rec until retirement.
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    expect(recs("D9")).toHaveLength(1);
    expect(facts(recs("D9")[0])).toMatchObject({ weeks_ago: 0, weeks_fired: 0 });
  });

  it("F4: a failing closed week is skipped and counted; older weeks and the merge still run", async () => {
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1); // fork in W0
    forkSession("s-plain", "ws-a", "2026-08-26T10:00:00.000Z", 0); // extends the walk to W3
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });

    // ws-b stops forking; a new ws-a fork session lands
    // in W3 (turn → W3 stale) and a new turn lands in W2 (W2 stale), where the walk throws.
    db.prepare(
      "UPDATE subagent_meta SET agent_type = 'general-purpose' WHERE session_id = 's-b'",
    ).run();
    forkSession("s-c", "ws-a", "2026-08-27T10:00:00.000Z", 1);
    turn("t-w2", "s-plain", "ws-a", "2026-09-02T10:00:00.000Z");
    const failing: Detector = {
      ...d9Detector,
      evaluate(evalDb, ctx) {
        if (ctx.fromIso === W2_START) throw new Error("synthetic W2 failure");
        return d9Detector.evaluate(evalDb, ctx);
      },
    };
    const second = await runHistoryWalk(db, NOW, { detectors: [failing] });

    expect(second.failed_weeks).toBe(1);
    // W0 always; W1 cached; W2 failed (not recorded); W3 still evaluated.
    expect(second.evaluated_weeks).toEqual([W0_START, W3_START]);
    const byWs = new Map(recs("D9").map((r) => [r.scope_workspace_id, r]));
    expect(facts(byWs.get("ws-a"))).toMatchObject({ last_seen_week_start: W3_START, weeks_ago: 3 });
    expect(byWs.has("ws-b")).toBe(true);

    // Next healthy walk retries W2 (its mark was rolled back) and records ws-b as silent.
    const third = await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    expect(third.failed_weeks).toBe(0);
    // P2-U8: nothing in W0 changed since the second walk, so D9 replays its W0 outcome.
    expect(third.evaluated_weeks).toEqual([W2_START]);
    const after = recs("D9");
    expect(after.map((r) => r.scope_workspace_id)).toEqual(["ws-a", "ws-b"]);
    expect(facts(after[1])).toMatchObject({ weeks_ago: 0, weeks_fired: 0 });
  });

  it("P0-U10 review fix: detectorHook.onEnd still fires for a closed week whose detector throws (F4)", async () => {
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1); // fork in W0
    forkSession("s-plain", "ws-a", "2026-08-26T10:00:00.000Z", 0); // extends the walk to W3
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });

    db.prepare(
      "UPDATE subagent_meta SET agent_type = 'general-purpose' WHERE session_id = 's-b'",
    ).run();
    forkSession("s-c", "ws-a", "2026-08-27T10:00:00.000Z", 1);
    turn("t-w2", "s-plain", "ws-a", "2026-09-02T10:00:00.000Z");
    const failing: Detector = {
      ...d9Detector,
      evaluate(evalDb, ctx) {
        if (ctx.fromIso === W2_START) throw new Error("synthetic W2 failure");
        return d9Detector.evaluate(evalDb, ctx);
      },
    };
    const starts: string[] = [];
    const ends: string[] = [];
    const result = await runHistoryWalk(db, NOW, {
      detectors: [failing],
      detectorHook: {
        onStart: (id) => starts.push(id),
        onEnd: (id) => ends.push(id),
      },
    });

    expect(result.failed_weeks).toBe(1);
    // Every onStart (including the W2 week whose evaluate() threw) is matched
    // by an onEnd — without the fix, the thrown week's onEnd never fired.
    expect(ends).toEqual(starts);
    expect(starts.length).toBeGreaterThan(0);
  });

  it("F2: a PROPOSED rec whose W0 evidence slides into the un-evaluated sliver survives the GC", async () => {
    forkSession("s-sl", "ws-a", "2026-09-15T13:00:00.000Z", 1); // inside W0 at NOW
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    const [before] = recs("D9");
    expect(facts(before)).toMatchObject({ last_seen_week_start: W0_START });

    // NOW2 = Thu 09-24T12:00Z: W0 = [09-17T12:00, 09-24T12:00); now2 − 7d = 09-17T12:00 →
    // W1.end = Mon 09-14T00:00, W1 = [09-07, 09-14). The fork (09-15T13:00) sits in the
    // sliver [09-14, 09-17T12:00): no week fires it, but its anchor 09-15T12:00 lies in
    // (W1.start 09-07, W0.start 09-17T12:00) → kept.
    const now2 = new Date("2026-09-24T12:00:00.000Z");
    const second = await runHistoryWalk(db, now2, { detectors: [d9Detector] });
    expect(second.weeks_total).toBe(1); // oldest turn 09-15T13 ≥ W1.end 09-14 → W0 only
    const [kept] = recs("D9");
    expect(kept?.rec_id).toBe(before?.rec_id);
    expect(kept?.state).toBe("PROPOSED");
    // weeks_ago = floor((09-17T12:00 − 09-15T12:00) / 7d) = floor(2d / 7d) = 0;
    // fired in no grid week; 1 mark (this walk's W0; the old W0 mark was pruned).
    expect(facts(kept)).toMatchObject({
      last_seen_week_start: W0_START,
      weeks_ago: 0,
      weeks_fired: 0,
      weeks_evaluated: 1,
    });

    // NOW3 = Tue 09-29T12:00Z: now3 − 7d = 09-22T12:00 → W1.end = Mon 09-21T00:00,
    // W1 = [09-14, 09-21) now covers the fork → it re-anchors on W1 (weeks_ago 1).
    const now3 = new Date("2026-09-29T12:00:00.000Z");
    await runHistoryWalk(db, now3, { detectors: [d9Detector] });
    const [rolled] = recs("D9");
    expect(rolled?.rec_id).toBe(before?.rec_id);
    expect(facts(rolled)).toMatchObject({
      last_seen_week_start: "2026-09-14T00:00:00.000Z",
      weeks_ago: 1,
      weeks_fired: 1,
      weeks_evaluated: 2,
    });
  });

  it("F5: an ADOPTED rec that fires in no week keeps its anchor but gets fresh weeks_ago/evaluated", async () => {
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1); // W0 at NOW
    await runHistoryWalk(db, NOW, { detectors: [d9Detector] });
    db.prepare("UPDATE recommendations SET state = 'ADOPTED'").run();
    db.prepare("UPDATE subagent_meta SET agent_type = 'general-purpose'").run();

    // NOW + 14d = Tue 10-06T12:00Z: W0.start = 09-29T12:00; now − 7d = 09-29T12:00 →
    // W1.end = Mon 09-28, W1 = [09-21, 09-28), W2 = [09-14, 09-21) holds the 09-20 turn
    // → 3 weeks evaluated. weeks_ago = floor((09-29T12:00 − 09-15T12:00) / 7d) = 14d / 7d = 2.
    const later = new Date("2026-10-06T12:00:00.000Z");
    await runHistoryWalk(db, later, { detectors: [d9Detector] });
    const [rec] = recs("D9");
    expect(rec?.state).toBe("ADOPTED");
    expect(facts(rec)).toMatchObject({
      last_seen_week_start: W0_START,
      weeks_ago: 2,
      weeks_fired: 0,
      weeks_evaluated: 3,
    });
  });

  it("a stored V2 rec whose metrics predate its descriptor gets fresh recency instead of failing the walk", async () => {
    // P3.1-T4 dropped TOOL_CLASS from A1/C2 and added SESSION_COUNT to C2; recs written
    // before it fail the current contract (the live daemon's history walk died on them).
    const ts = "2026-08-26T10:00:00.000Z"; // W3
    session("s-a1", "ws-a1", ts);
    turn("t-a1", "s-a1", "ws-a1", ts);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, exit_class)
       VALUES ('a1-read', 's-a1', ?, 'Read', 1, 30000, 'OK')`,
    ).run(ts);
    await runHistoryWalk(db, NOW, { detectors: [a1Detector] });
    const [live] = recs("A1");
    // A legacy digest covers the legacy metrics (canonical JSON = keys sorted at every level).
    const canonical = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(canonical)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
            )
          : v;
    const legacyRec = (
      recId: string,
      state: string,
      edit: (m: Record<string, unknown>) => void,
    ) => {
      const {
        evidence_digest: _digest,
        recency,
        ...body
      } = JSON.parse(live?.evidence_json as string);
      edit(body.metrics);
      const evidence = {
        ...body,
        recency,
        evidence_digest: createHash("sha256")
          .update(JSON.stringify(canonical(body)))
          .digest("hex"),
      };
      db.prepare(
        `INSERT INTO recommendations
         SELECT ?, provenance, detector_id, analysis_run_id, category, scope_workspace_id,
                lever, modeled_savings_u_per_wk, modeled_formula_json, ?, target_metric, ?,
                created_at, adopted_at, dismissed_until, contract_version, template_id,
                contract_status, rule_id
           FROM recommendations WHERE rec_id = ?`,
      ).run(recId, JSON.stringify(evidence), state, live?.rec_id);
      return evidence;
    };
    const extra = legacyRec("rec-A1-legacy-extra", "RETIRED", (m) => {
      m.TOOL_CLASS = { kind: "ENUM", value: "FILE_READ" };
    });
    const missing = legacyRec("rec-A1-legacy-missing", "PROPOSED", (m) => {
      Reflect.deleteProperty(m, "MAX_RESULT_BYTES");
    });

    // Two weeks later neither legacy rec fires in any week:
    // weeks_ago = floor((W0.start 09-29T12:00 − 08-24T00:00) / 7d) = floor(36.5d / 7d) = 5.
    await runHistoryWalk(db, new Date("2026-10-06T12:00:00.000Z"), { detectors: [a1Detector] });
    const stored = (recId: string) =>
      db
        .prepare("SELECT state, evidence_json FROM recommendations WHERE rec_id = ?")
        .get(recId) as { state: string; evidence_json: string };
    for (const [recId, before] of [
      ["rec-A1-legacy-extra", extra],
      ["rec-A1-legacy-missing", missing],
    ] as const) {
      const { recency, ...body } = JSON.parse(stored(recId).evidence_json);
      const { recency: _old, ...bodyBefore } = before;
      expect(body).toEqual(bodyBefore); // metrics and digest left as stored
      expect(recency).toMatchObject({
        last_seen_week_start: W3_START,
        weeks_ago: 5,
        weeks_fired: 0,
      });
    }
    // Fresh weeks_ago lets a legacy PROPOSED rec age out (retire at weeks_ago >= 4).
    expect(stored("rec-A1-legacy-missing").state).toBe("RETIRED");
  });
});

describe("history walk — residual guards", () => {
  it("ignores a turn whose ts does not parse when finding the oldest week", () => {
    forkSession("s-old", "ws-a", "2026-08-26T10:00:00.000Z", 0); // W3
    // Sorts before every valid ISO string, but month 13 does not parse.
    turn("t-bad", "s-old", "ws-a", "1999-13-45T00:00:00.000Z");
    expect(historyWeeks(db, NOW).map((w) => w.index)).toEqual([0, 1, 2, 3]);
  });

  it("F6: D7/D8 R2 facets drop recency keys from metrics and use the anchor week's window", () => {
    const trailing = { from: W0_START, to: NOW.toISOString() };
    const stale = withV1R2Facets(
      "D7",
      {
        repeat_count: 4,
        last_seen_week_start: W3_START,
        weeks_ago: 3,
        weeks_fired: 2,
        weeks_evaluated: 6,
      },
      trailing,
    );
    expect(stale.metrics).toEqual({ REPEAT_COUNT: { kind: "COUNT", value: 4 } });
    // Anchor window = [W3.start, W3.start + 7d) = [08-24, 08-31) = [W3_START, W2_START).
    expect(stale.window).toEqual({ from: W3_START, to: W2_START });

    const current = withV1R2Facets(
      "D7",
      {
        repeat_count: 4,
        last_seen_week_start: W0_START,
        weeks_ago: 0,
        weeks_fired: 1,
        weeks_evaluated: 6,
      },
      trailing,
    );
    expect(current.window).toEqual(trailing);
  });
});

describe("runHistoryWalk — P2 regression guard", () => {
  it("(e) on a single-week DB, walk recs equal runDetectors recs (modulo the 4 recency facts)", async () => {
    // Seed fixture turns all sit on 2026-01-01; NOW_E = 2026-01-02 puts them in W0 only.
    const nowE = new Date("2026-01-02T00:00:00.000Z");
    const extra = (target: Database.Database) => {
      db = target;
      forkSession("s-fork-1", "ws-alpha", "2026-01-01T06:00:00.000Z", 2);
      forkSession("s-fork-2", "ws-beta", "2026-01-01T07:00:00.000Z", 1);
      // Two main-chain Edit NOT_READ errors → one V2 C3 finding (fixture shape from the C3 suite).
      session("s-c3", "ws-c3", "2026-01-01T08:00:00.000Z");
      for (const i of [0, 1]) {
        const ts = `2026-01-01T08:00:0${i}.000Z`;
        db.prepare(
          `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, parser_version)
           VALUES (?, 's-c3', 'ws-c3', ?, 'claude-sonnet', 100, 'history-walk-test')`,
        ).run(`c3-message-${i}`, ts);
        db.prepare(
          `INSERT INTO tool_events
             (event_id, session_id, ts, tool_name, exit_class, tool_error_class, tool_error_classifier_version)
           VALUES (?, 's-c3', ?, 'Edit', 'ERROR', 'NOT_READ', 'tool-error-1')`,
        ).run(`c3-event-${i}`, ts);
        db.prepare(
          "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, 0, 0)",
        ).run(`c3-event-${i}`, `c3-message-${i}`);
      }
    };
    const own = db;
    const walkDb = createInMemoryFixtureDb();
    const baseDb = createInMemoryFixtureDb();
    try {
      extra(walkDb);
      extra(baseDb);
      expect(historyWeeks(walkDb, nowE)).toHaveLength(1);

      const walked = await runHistoryWalk(walkDb, nowE);
      const base = runDetectors(baseDb, buildContext(nowE));
      expect(walked.statuses).toEqual(base);

      const select =
        "SELECT rec_id, state, modeled_savings_u_per_wk, modeled_formula_json, evidence_json FROM recommendations ORDER BY rec_id";
      const walkRows = walkDb.prepare(select).all() as Row[];
      const baseRows = baseDb.prepare(select).all() as Row[];
      expect(baseRows.length).toBeGreaterThan(0);
      // V1 (D5, D9 ×2) and V2 (C3) contracts are both covered.
      expect(baseRows.map((r) => (r.rec_id as string).split("-")[1])).toEqual([
        "C3",
        "D5",
        "D9",
        "D9",
      ]);
      expect(walkRows.map((r) => r.rec_id)).toEqual(baseRows.map((r) => r.rec_id));
      for (const [i, w] of walkRows.entries()) {
        const b = baseRows[i] as Row;
        expect(w.state).toBe(b.state);
        expect(w.modeled_savings_u_per_wk).toBe(b.modeled_savings_u_per_wk);
        expect(w.modeled_formula_json).toBe(b.modeled_formula_json);
        const evidence = JSON.parse(w.evidence_json as string) as Record<string, unknown>;
        const recency = (evidence.facts ?? evidence.recency) as Record<string, unknown>;
        // Single week: anchored in W0 = [2025-12-26, 2026-01-02), fired 1 of 1 weeks.
        expect(recency).toMatchObject({
          last_seen_week_start: "2025-12-26T00:00:00.000Z",
          weeks_ago: 0,
          weeks_fired: 1,
          weeks_evaluated: 1,
        });
        const recencyKeys = new Set([
          "last_seen_week_start",
          "weeks_ago",
          "weeks_fired",
          "weeks_evaluated",
        ]);
        const without = (o: Record<string, unknown>, keys: Set<string>) =>
          Object.fromEntries(Object.entries(o).filter(([k]) => !keys.has(k)));
        const stripped =
          evidence.facts !== undefined
            ? {
                ...evidence,
                facts: without(evidence.facts as Record<string, unknown>, recencyKeys),
              }
            : without(evidence, new Set(["recency"]));
        expect(JSON.stringify(stripped)).toBe(b.evidence_json);
      }
    } finally {
      walkDb.close();
      baseDb.close();
      db = own;
    }
  });
});
