/**
 * test/query/perf.test.ts — NFR-105 dashboard p95 <= 250 ms.
 *
 * Generates a realistic-scale synthetic dataset (20k recent turns across 5
 * workspaces / 100 sessions, 5 of them LIVE), then measures the p95 latency of a
 * full Overview load (getGlobalOverview + listWorkspaces + listLiveSessions).
 * Prints the measured numbers so they can be recorded in the PR.
 *
 * Note: data is placed in the trailing 24h/7d so the window/cutoff predicates
 * actually scan rows (an empty window would measure nothing). Statements are
 * prepared per call (the production code path), so this reflects real cost.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGlobalOverview,
  listLiveSessions,
  listWorkspaces,
} from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const N_WORKSPACES = 5;
const N_SESSIONS = 100;
const N_LIVE = 5;
const TURNS_PER_SESSION = 200; // 100 * 200 = 20_000 turns
const ITERATIONS = 300;
const DAY_MS = 86_400_000;

const nowMs = Date.now();

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  seedPerf(db);
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

function seedPerf(d: Database.Database): void {
  const insWs = d.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  );
  const insSess = d.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
       state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?,?,?,?,?,?,?,?,'[]')`,
  );
  const insTurn = d.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
       input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
       cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
       provisional, parser_version)
     VALUES (?,?,?,?,?,0,?,?,?,?,0,0,NULL,?,?,'LIST_EQUIV',?,'perf-v1')`,
  );

  d.transaction(() => {
    for (let w = 0; w < N_WORKSPACES; w++) {
      insWs.run(`ws-p${w}`, `project-p${w}`, new Date(nowMs - 30 * DAY_MS).toISOString());
    }
    let turnCounter = 0;
    for (let s = 0; s < N_SESSIONS; s++) {
      const w = s % N_WORKSPACES;
      const isLive = s >= N_SESSIONS - N_LIVE;
      const model = s % 2 === 0 ? "claude-sonnet" : "claude-haiku";
      const snap = s % 2 === 0 ? "snap-sonnet" : "snap-haiku";
      const lastTs = isLive ? nowMs - 30_000 : nowMs - 10 * 60_000;
      insSess.run(
        `sess-p${s}`,
        `ws-p${w}`,
        `/perf/sess-p${s}.jsonl`,
        new Date(nowMs - DAY_MS).toISOString(),
        new Date(lastTs).toISOString(),
        isLive ? "LIVE" : "RECONCILED",
        TURNS_PER_SESSION,
        TURNS_PER_SESSION * 100,
      );
      for (let t = 0; t < TURNS_PER_SESSION; t++) {
        // Spread reconciled turns across the last 24h; LIVE turns in the last ~2 min.
        const tsMs = isLive
          ? nowMs - 120_000 + t * 500
          : nowMs - DAY_MS + Math.floor((t / TURNS_PER_SESSION) * (DAY_MS - 20 * 60_000));
        insTurn.run(
          `msg-p${turnCounter++}`,
          `sess-p${s}`,
          `ws-p${w}`,
          new Date(tsMs).toISOString(),
          model,
          400,
          80,
          200,
          100,
          snap,
          100,
          isLive ? 1 : 0,
        );
      }
    }
  })();
}

describe("NFR-105 dashboard p95", () => {
  it("Overview load p95 <= 250 ms at ~20k-turn scale", () => {
    const window = {
      from: new Date(nowMs - 7 * DAY_MS).toISOString(),
      to: new Date(nowMs + 60_000).toISOString(),
    };

    // Warm up (JIT + first-compile).
    for (let i = 0; i < 20; i++) {
      getGlobalOverview(window);
      listWorkspaces(window);
      listLiveSessions();
    }

    const overview: number[] = [];
    const workspaces: number[] = [];
    const live: number[] = [];
    const combined: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const ov = getGlobalOverview(window);
      const t1 = performance.now();
      const ws = listWorkspaces(window);
      const t2 = performance.now();
      const lv = listLiveSessions();
      const t3 = performance.now();

      // Sanity: the queries actually scanned data.
      expect(ov.data?.turns).toBeGreaterThan(0);
      expect((ws.data?.items ?? []).length).toBe(N_WORKSPACES);
      expect((lv.data?.items ?? []).length).toBe(N_LIVE);

      overview.push(t1 - t0);
      workspaces.push(t2 - t1);
      live.push(t3 - t2);
      combined.push(t3 - t0);
    }

    const pOverview = p95(overview);
    const pWorkspaces = p95(workspaces);
    const pLive = p95(live);
    const pCombined = p95(combined);

    const totalTurns = N_SESSIONS * TURNS_PER_SESSION;
    const report = [
      `\n[NFR-105] scale: ${N_WORKSPACES} ws / ${N_SESSIONS} sessions / ${totalTurns} turns (${N_LIVE} LIVE), ${ITERATIONS} iters`,
      `  getGlobalOverview p95 = ${pOverview.toFixed(2)} ms`,
      `  listWorkspaces    p95 = ${pWorkspaces.toFixed(2)} ms`,
      `  listLiveSessions  p95 = ${pLive.toFixed(2)} ms`,
      `  Overview COMBINED p95 = ${pCombined.toFixed(2)} ms (budget 250 ms)`,
    ].join("\n");
    console.log(report);

    expect(pCombined).toBeLessThanOrEqual(250);
  });
});
