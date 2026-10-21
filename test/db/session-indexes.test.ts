/**
 * test/db/session-indexes.test.ts — P0-U5 indexes for measured `SCAN sessions` statements.
 *
 * EXPLAIN QUERY PLAN evidence (scratch capture, 107 statements behind Overview, Sessions,
 * Workspaces and the Appendix A detail routes) showed `sessions` has no secondary index, and
 * nine statements scan it. `turns` windowed queries already SEARCH idx_turns_ts_provisional_session,
 * so no turns index is added.
 *
 * Oracle for parity: the pre-index database (same data, the new indexes dropped).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContextComposition } from "../../src/query/api/context-composition.js";
import { getHotSessions, getHotSessionsPage } from "../../src/query/api/hot-sessions.js";
import {
  getGlobalOverview,
  getSession,
  getWorkspace,
  listLiveSessions,
  listSessions,
  listWorkspaces,
} from "../../src/query/api/overview.js";
import { getSessionSpendPercentile } from "../../src/query/api/self-percentiles.js";
import { getSessionDrivers } from "../../src/query/api/session-drivers.js";
import { getTrends } from "../../src/query/api/trends.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NEW_INDEXES = [
  "idx_sessions_state_last",
  "idx_sessions_ws_last",
  "idx_sessions_last",
  "idx_sessions_state_first",
];

interface Captured {
  sql: string;
  args: unknown[];
}

const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** Record every SELECT a callback runs on `db` (instance-level spy; no global patching). */
function capture(db: Database.Database, fn: () => void): Captured[] {
  const out = new Map<string, Captured>();
  const orig = db.prepare.bind(db) as (sql: string) => Database.Statement;
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = orig(sql);
    for (const m of ["get", "all", "run", "iterate"] as const) {
      const real = (stmt[m] as (...a: unknown[]) => unknown).bind(stmt);
      (stmt as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        const key = norm(sql);
        if (!out.has(key) && /^\s*(SELECT|WITH)/i.test(sql)) out.set(key, { sql, args });
        return real(...args);
      };
    }
    return stmt;
  };
  try {
    fn();
  } finally {
    (db as { prepare: unknown }).prepare = orig;
  }
  return [...out.values()];
}

function plan(db: Database.Database, c: Captured): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...(c.args as unknown[])) as Array<{
      detail: string;
    }>
  ).map((r) => r.detail);
}

function seedExtra(db: Database.Database, now: number): void {
  const ins = db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
       state, turn_count, cost_equiv_u, hygiene_flags) VALUES (?,?,?,?,?,?,?,?,'[]')`,
  );
  for (let i = 0; i < 12; i++) {
    const ws = i % 2 === 0 ? "ws-alpha" : "ws-beta";
    const live = i % 4 === 0;
    const last = new Date(now - (live ? 20_000 : (i + 1) * 3_600_000)).toISOString();
    const first = new Date(now - (i + 2) * 3_600_000).toISOString();
    ins.run(
      `sess-x${i}`,
      ws,
      `/synthetic/x${i}.jsonl`,
      first,
      last,
      live ? "LIVE" : "RECONCILED",
      3 + i,
      1_000 * (i + 1),
    );
  }
}

/** Run every route function behind the flagged statements; returns the captured SELECTs. */
function runRoutes(db: Database.Database): Captured[] {
  const wf = { preset: "30d" } as never;
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
  return capture(db, () => {
    getGlobalOverview(wf);
    listLiveSessions();
    listWorkspaces(wf);
    getWorkspace("ws-alpha");
    listSessions("ws-alpha", wf);
    getContextComposition("ws-alpha");
    getHotSessions({ from, to }, 20, {} as never);
    getHotSessions(undefined, 20, {} as never);
    getHotSessionsPage({} as never);
    getTrends(wf, "day");
    getSession("sess-a1");
    getSessionDrivers(db, "sess-a1");
    getSessionSpendPercentile(db, "sess-a1");
  });
}

interface Flagged {
  name: string;
  match: RegExp;
  index: RegExp;
}

// Each entry is a statement that SCANs `sessions` before the migration.
const FLAGGED: Flagged[] = [
  {
    name: "overview LIVE count",
    match: /^SELECT COUNT\(\*\) AS n FROM sessions WHERE state = 'LIVE' AND last_turn_at >= \?$/,
    index: /SEARCH sessions USING (COVERING )?INDEX idx_sessions_state_last/,
  },
  {
    name: "live strip list",
    match: /FROM sessions s JOIN workspaces w USING \(workspace_id\) WHERE s\.state = 'LIVE'/,
    index: /SEARCH s USING INDEX idx_sessions_state_last/,
  },
  {
    name: "workspaces LIVE ids",
    match: /^SELECT DISTINCT workspace_id AS id FROM sessions WHERE state = 'LIVE'/,
    index: /SEARCH sessions USING (COVERING )?INDEX idx_sessions_state_last/,
  },
  {
    name: "workspace LIVE probe",
    match: /^SELECT 1 FROM sessions WHERE workspace_id = \? AND state = 'LIVE'/,
    index: /SEARCH sessions USING (COVERING )?INDEX idx_sessions_(ws_last|state_last)/,
  },
  {
    name: "workspace sessions count",
    match:
      /^SELECT COUNT\(\*\) AS n FROM sessions WHERE workspace_id = \? AND last_turn_at >= \? AND last_turn_at < \?$/,
    index: /SEARCH sessions USING (COVERING )?INDEX idx_sessions_ws_last/,
  },
  {
    name: "workspace sessions page",
    match: /FROM sessions s JOIN workspaces w USING \(workspace_id\) WHERE s\.workspace_id = \?/,
    index: /SEARCH s USING INDEX idx_sessions_ws_last/,
  },
  {
    name: "spend percentile population (workspace)",
    match:
      /FROM sessions WHERE workspace_id = \? AND last_turn_at >= \? AND last_turn_at <= \? AND cost_equiv_u IS NOT NULL/,
    index: /SEARCH sessions USING INDEX idx_sessions_ws_last/,
  },
  {
    name: "drivers population (global)",
    match: /FROM sessions WHERE last_turn_at >= \? AND last_turn_at <= \?$/,
    index: /SEARCH sessions USING INDEX idx_sessions_last/,
  },
  {
    name: "trends RECONCILED sessions",
    match: /WHERE s\.state = 'RECONCILED' AND s\.first_turn_at >= \? AND s\.first_turn_at < \?/,
    index: /SEARCH s USING INDEX idx_sessions_state_first/,
  },
];

let db: Database.Database;
let oracle: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  const now = Date.now();
  seedExtra(db, now);
  oracle = createInMemoryFixtureDb();
  seedExtra(oracle, now);
  for (const idx of NEW_INDEXES) oracle.exec(`DROP INDEX IF EXISTS ${idx}`);
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
  oracle.close();
});

describe("P0-U5 test 3: flagged statements SEARCH an index", () => {
  it("creates the four session indexes", () => {
    const have = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
        .all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const idx of NEW_INDEXES) expect(have).toContain(idx);
  });

  it("every flagged statement was captured and now plans as SEARCH ... USING INDEX", () => {
    const stmts = runRoutes(db);
    for (const f of FLAGGED) {
      const hit = stmts.find((s) => f.match.test(norm(s.sql)));
      expect(hit, `${f.name}: statement not captured`).toBeDefined();
      if (hit === undefined) continue;
      const lines = plan(db, hit);
      expect(lines.join("\n"), f.name).toMatch(f.index);
      expect(lines.join("\n"), f.name).not.toMatch(/^SCAN (sessions|s)$/m);
    }
  });

  it("NFR-105 statements (overview, workspaces list, live strip) plan no worse than pre-index", () => {
    const wf = { preset: "30d" } as never;
    const run = (d: Database.Database) => {
      setQueryDb(d);
      return capture(d, () => {
        getGlobalOverview(wf);
        listWorkspaces(wf);
        listLiveSessions();
      });
    };
    const withIdx = run(db);
    const without = run(oracle);
    setQueryDb(db);
    expect(withIdx.map((s) => norm(s.sql))).toEqual(without.map((s) => norm(s.sql)));
    const unindexedScans = (lines: string[]) => lines.filter((l) => /^SCAN \S+$/.test(l)).length;
    const turnsLines = (lines: string[]) => lines.filter((l) => /\bturns\b/.test(l));
    withIdx.forEach((s, i) => {
      const before = plan(oracle, without[i] as Captured);
      const after = plan(db, s);
      expect(unindexedScans(after), norm(s.sql).slice(0, 80)).toBeLessThanOrEqual(
        unindexedScans(before),
      );
      expect(turnsLines(after), norm(s.sql).slice(0, 80)).toEqual(turnsLines(before));
    });
  });
});

describe("P0-U5 test 4: result parity, indexed vs pre-index oracle", () => {
  it("every captured statement returns identical rows with and without the indexes", () => {
    const stmts = runRoutes(db);
    expect(stmts.length).toBeGreaterThan(40);
    for (const s of stmts) {
      const a = db.prepare(s.sql).all(...(s.args as unknown[]));
      const b = oracle.prepare(s.sql).all(...(s.args as unknown[]));
      expect(JSON.stringify(a), norm(s.sql).slice(0, 100)).toBe(JSON.stringify(b));
    }
  });

  it("the synthetic data actually exercises the flagged predicates (LIVE rows, windows)", () => {
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE state = 'LIVE' AND last_turn_at >= ?")
      .get(new Date(Date.now() - 60_000).toISOString()) as { n: number };
    expect(live.n).toBeGreaterThan(0);
  });
});
