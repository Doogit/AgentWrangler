/**
 * P2-U8 engine slice: per-detector isolation + quarantine (R-6), the W0 dirty gate,
 * and the R-1 extension (a cached walk equals a from-scratch walk on the shared seed).
 *
 * SEC-101: fixtures carry synthetic ids, timestamps and counts only.
 *
 * NOW = 2026-09-22T12:00Z; W0 = [09-15T12:00Z, 09-22T12:00Z). Every fixture turn sits
 * in W0 (on or after W1.end = 09-14T00:00Z), so the walk is W0 only.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDetectorCountingHook,
  wrapDbForCounting,
} from "../../src/daemon/detector-counters.js";
import { openDb } from "../../src/db/open.js";
import { d9Detector } from "../../src/detector/detectors/d9_idle_background_session.js";
import { buildContext, runDetectors, runHistoryWalk } from "../../src/detector/engine.js";
import type { AnyDetector, Detector } from "../../src/detector/types.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const MIN = 60_000;

let db: Database.Database;

beforeEach(() => {
  db = migratedMemDb();
});

afterEach(() => db.close());

function session(id: string, ws: string, ts: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run(ws, ws, "2026-01-01T00:00:00.000Z");
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
     VALUES (?, ?, ?, ?, 'synthetic', 'engine-test')`,
  ).run(id, sessionId, ws, ts);
}

function fork(agentId: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO subagent_meta
       (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
     VALUES (?, ?, 'fork', NULL, 1, 0)`,
  ).run(agentId, sessionId);
}

function forkSession(id: string, ws: string, ts: string, forks: number): void {
  session(id, ws, ts);
  turn(`turn-${id}`, id, ws, ts);
  for (let i = 0; i < forks; i++) fork(`agent-${id}-${i}`, id);
}

function recs(detectorId: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM recommendations WHERE detector_id = ? ORDER BY rec_id")
    .all(detectorId) as Array<Record<string, unknown>>;
}

describe("P2-U8 isolation + quarantine (R-6)", () => {
  class SyntheticFailure extends Error {}

  /** Throws whenever session s-bad has a turn in the window; counts evaluate calls. */
  function thrower(calls: { n: number }, version = "ZZ@1"): Detector {
    return {
      contractVersion: 1,
      id: "ZZ",
      name: "SYNTHETIC_THROWER",
      version,
      scope: "session",
      inputs: { tables: ["turns", "sessions"] },
      evaluate(evalDb, ctx) {
        calls.n++;
        const bad = evalDb
          .prepare("SELECT 1 FROM turns WHERE session_id = 's-bad' AND ts >= ? AND ts < ?")
          .get(ctx.fromIso, ctx.toIso);
        if (bad !== undefined) throw new SyntheticFailure("synthetic failure");
        return { fired: [], status: "INACTIVE", note: "ok" };
      },
    };
  }

  const quarantine = () =>
    db
      .prepare(
        "SELECT detector_id, version, scope_key, fail_count, last_error_class FROM detector_quarantine",
      )
      .all();

  it("a throwing detector does not abort the walk, is quarantined after 3 errors, and a version bump retries it", async () => {
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1);
    forkSession("s-bad", "ws-bad", "2026-09-20T11:00:00.000Z", 0);
    const calls = { n: 0 };
    const detectors: AnyDetector[] = [thrower(calls), d9Detector];

    for (const failCount of [1, 2, 3]) {
      const result = await runHistoryWalk(db, NOW, { detectors });
      expect(result.failed_detectors).toBe(1);
      expect(quarantine()).toEqual([
        {
          detector_id: "ZZ",
          version: "ZZ@1",
          scope_key: "W0",
          fail_count: failCount,
          last_error_class: "SyntheticFailure",
        },
      ]);
      // The other detector's rec is unaffected.
      expect(recs("D9").map((r) => [r.scope_workspace_id, r.state])).toEqual([
        ["ws-b", "PROPOSED"],
      ]);
    }
    expect(calls.n).toBe(3);

    const fourth = await runHistoryWalk(db, NOW, { detectors });
    expect(calls.n).toBe(3); // skipped
    expect(fourth.statuses.find((s) => s.detector_id === "ZZ")).toMatchObject({
      status: "BLOCKED",
      note: "quarantined after 3 errors (SyntheticFailure)",
    });
    expect(recs("D9")).toHaveLength(1);

    // A new version starts a fresh quarantine row and evaluates again.
    await runHistoryWalk(db, NOW, { detectors: [thrower(calls, "ZZ@2"), d9Detector] });
    expect(calls.n).toBe(4);

    // A success clears the (detector, window) rows of every version.
    db.prepare("DELETE FROM turns WHERE session_id = 's-bad'").run();
    await runHistoryWalk(db, NOW, { detectors: [thrower(calls, "ZZ@2"), d9Detector] });
    expect(quarantine()).toEqual([]);
  });

  it("a quarantined detector is re-probed 24 h after its last failure; a success clears it", async () => {
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1);
    let calls = 0;
    const flaky: Detector = {
      contractVersion: 1,
      id: "ZZ",
      name: "SYNTHETIC_FLAKY",
      version: "ZZ@1",
      scope: "session",
      inputs: { tables: ["turns", "sessions"] },
      evaluate() {
        calls++;
        if (calls <= 3) throw new SyntheticFailure("transient failure");
        return { fired: [], status: "INACTIVE", note: "ok" };
      },
    };
    const at = (hours: number) => new Date(NOW.getTime() + hours * 60 * MIN);

    for (const h of [0, 1, 2]) await runHistoryWalk(db, at(h), { detectors: [flaky] });
    expect(calls).toBe(3);

    // Under 24 h since the last failure (h = 2): still skipped.
    const early = await runHistoryWalk(db, at(25), { detectors: [flaky] });
    expect(calls).toBe(3);
    expect(early.statuses.find((s) => s.detector_id === "ZZ")).toMatchObject({ status: "BLOCKED" });

    // 24 h after the last failure: evaluated again, and the success clears the row.
    const retry = await runHistoryWalk(db, at(26), { detectors: [flaky] });
    expect(calls).toBe(4);
    expect(retry.failed_detectors).toBe(0);
    expect(quarantine()).toEqual([]);
  });

  it("a re-probe that throws again restarts the 24 h clock", async () => {
    forkSession("s-bad", "ws-bad", "2026-09-20T11:00:00.000Z", 0);
    const calls = { n: 0 };
    const at = (hours: number) => new Date(NOW.getTime() + hours * 60 * MIN);
    for (const h of [0, 1, 2]) await runHistoryWalk(db, at(h), { detectors: [thrower(calls)] });

    await runHistoryWalk(db, at(26), { detectors: [thrower(calls)] });
    expect(calls.n).toBe(4);
    expect(quarantine()).toMatchObject([{ fail_count: 4 }]);

    await runHistoryWalk(db, at(49), { detectors: [thrower(calls)] });
    expect(calls.n).toBe(4); // 23 h after the re-probe failure
    await runHistoryWalk(db, at(50), { detectors: [thrower(calls)] });
    expect(calls.n).toBe(5);
  });

  it("runDetectors isolates a throwing detector: BLOCKED status, others still upsert", () => {
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1);
    forkSession("s-bad", "ws-bad", "2026-09-20T11:00:00.000Z", 0);
    const statuses = runDetectors(db, buildContext(NOW), [thrower({ n: 0 }), d9Detector]);
    expect(statuses.find((s) => s.detector_id === "ZZ")).toMatchObject({ status: "BLOCKED" });
    expect(recs("D9")).toHaveLength(1);
  });
});

describe("P2-U8 W0 dirty gate", () => {
  /** Walk with the P0-U10 counters; returns the per-detector statements of this walk. */
  async function countedWalk(
    at: Date,
    detectors: readonly AnyDetector[] = [d9Detector],
  ): Promise<Record<string, { stmts: number }>> {
    const counter = createDetectorCountingHook(counts);
    await runHistoryWalk(db, at, { detectors, detectorHook: counter.hook });
    return counter.buildSnapshot().perDetector;
  }
  let counts: { stmts: number; rows: number };

  it("serves an unchanged W0 from cache and re-evaluates on each kind of input change", async () => {
    counts = wrapDbForCounting(db);
    forkSession("s-b", "ws-b", "2026-09-20T10:00:00.000Z", 1);
    expect(await countedWalk(NOW)).toHaveProperty("D9");
    const evidence = recs("D9").map((r) => r.evidence_json);

    expect(await countedWalk(NOW)).not.toHaveProperty("D9");
    expect(await countedWalk(new Date(NOW.getTime() + MIN))).not.toHaveProperty("D9");
    expect(recs("D9").map((r) => r.evidence_json)).not.toEqual([]); // replayed, still one rec
    expect(recs("D9")).toHaveLength(evidence.length);

    // A new turn in the window.
    turn("t-new", "s-b", "ws-b", "2026-09-21T10:00:00.000Z");
    expect(await countedWalk(new Date(NOW.getTime() + MIN))).toHaveProperty("D9");
    expect(await countedWalk(new Date(NOW.getTime() + MIN))).not.toHaveProperty("D9");

    // A turn ageing out of the window: in W0 at NOW+1min, out of it at NOW+3min.
    turn(
      "t-edge",
      "s-b",
      "ws-b",
      new Date(NOW.getTime() - 7 * 24 * 60 * MIN + 2 * MIN).toISOString(),
    );
    expect(await countedWalk(new Date(NOW.getTime() + MIN))).toHaveProperty("D9");
    expect(await countedWalk(new Date(NOW.getTime() + MIN))).not.toHaveProperty("D9");
    expect(await countedWalk(new Date(NOW.getTime() + 3 * MIN))).toHaveProperty("D9");

    // A coupled-table insert with no new turn.
    const at = new Date(NOW.getTime() + 3 * MIN);
    expect(await countedWalk(at)).not.toHaveProperty("D9");
    fork("agent-late", "s-b");
    expect(await countedWalk(at)).toHaveProperty("D9");

    // A version bump.
    expect(await countedWalk(at)).not.toHaveProperty("D9");
    expect(await countedWalk(at, [{ ...d9Detector, version: "D9@test-2" }])).toHaveProperty("D9");

    // A clock detector is always evaluated.
    const clocked: AnyDetector = {
      ...d9Detector,
      inputs: { tables: d9Detector.inputs?.tables ?? [], clock: true },
    };
    expect(await countedWalk(at, [clocked])).toHaveProperty("D9");
    expect(await countedWalk(at, [clocked])).toHaveProperty("D9");
  });
});

describe("P2-U8 R-1 extension: a cached walk equals a from-scratch walk (shared seed)", () => {
  let scratch: string;
  let seed: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p2u8-r1-"));
    seed = path.join(scratch, "seed.sqlite");
    childProcess.execFileSync(
      process.execPath,
      ["--import", "tsx/esm", "scripts/build-shared-seed.ts", seed],
      { cwd: path.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
    );
  }, 120_000);

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function copy(name: string): Database.Database {
    const target = path.join(scratch, name);
    fs.copyFileSync(seed, target);
    return openDb(target);
  }

  /** One new turn + tool event on an existing seed session, at `ts`. */
  function append(target: Database.Database, ts: string): void {
    const s = target
      .prepare("SELECT session_id, workspace_id FROM sessions ORDER BY last_turn_at DESC LIMIT 1")
      .get() as { session_id: string; workspace_id: string };
    target
      .prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, parser_version)
         VALUES ('p2u8-append-turn', ?, ?, ?, 'claude-sonnet', 100, 'engine-test')`,
      )
      .run(s.session_id, s.workspace_id, ts);
    target
      .prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, exit_class)
         VALUES ('p2u8-append-event', ?, ?, 'Read', 10, 40000, 'OK')`,
      )
      .run(s.session_id, ts);
  }

  function state(target: Database.Database): unknown {
    return {
      results: target
        .prepare(
          `SELECT detector_id, scope_key, week_start, scope_workspace_id, fired, rank_value_u
             FROM detector_week_results ORDER BY detector_id, scope_key, week_start`,
        )
        .all(),
      recs: target
        .prepare(
          `SELECT rec_id, state, evidence_json, modeled_savings_u_per_wk, modeled_formula_json
             FROM recommendations ORDER BY rec_id`,
        )
        .all(),
    };
  }

  for (const variant of ["append", "pure replay"] as const) {
    it(`${variant}: walk at T then T+1h on A equals one walk at T+1h on B`, async () => {
      const t = new Date(Math.floor(Date.now() / MIN) * MIN);
      const t1 = new Date(t.getTime() + 60 * MIN);
      const appendTs = new Date(t.getTime() + 30 * MIN).toISOString();
      const a = copy(`a-${variant}.sqlite`);
      const b = copy(`b-${variant}.sqlite`);
      try {
        await runHistoryWalk(a, t);
        if (variant === "append") {
          append(a, appendTs);
          append(b, appendTs);
        }
        await runHistoryWalk(a, t1);
        await runHistoryWalk(b, t1);
        const sa = state(a) as { recs: unknown[] };
        expect(sa.recs.length).toBeGreaterThan(0);
        expect(sa).toEqual(state(b));
      } finally {
        a.close();
        b.close();
      }
    }, 120_000);
  }
});
