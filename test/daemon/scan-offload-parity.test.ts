/**
 * PERF P3-F3: the heavy direct GET routes are served by a scan worker. Expected behavior, written
 * before the router change: on a file-backed DB each response is the same status and the same JSON
 * the inline query function produces (byte for byte, once "now" timestamps are masked), and the
 * daemon's own connection runs none of the route's SQL while serving it.
 */
import fs from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import type { RecsSnapshotService } from "../../src/daemon/recs-snapshot.js";
import { stopScanWorkers } from "../../src/daemon/scan-offload.js";
import { getContextComposition } from "../../src/query/api/context-composition.js";
import { getCostPerSuccess } from "../../src/query/api/cost-per-success.js";
import { getSessionDiagnostics } from "../../src/query/api/diagnostics.js";
import { getClosureProxy } from "../../src/query/api/effectiveness.js";
import {
  getEsfObservations,
  getSessionEsfObservations,
} from "../../src/query/api/esf-observations.js";
import { getHeadroomTrend } from "../../src/query/api/headroom-trend.js";
import {
  getHotSessionModels,
  getHotSessions,
  getHotSessionsPage,
  parseHotSessionsPageQuery,
} from "../../src/query/api/hot-sessions.js";
import { listWorkspaceOutcomes } from "../../src/query/api/outcomes.js";
import { overviewSectionFns } from "../../src/query/api/overview-view.js";
import {
  getGlobalOverview,
  getTurnTimeline,
  getTurnTimelineThrough,
  listSessions,
  listWorkspaces,
} from "../../src/query/api/overview.js";
import { getSelfChurn } from "../../src/query/api/self-churn.js";
import { getWeeklySelfPercentile } from "../../src/query/api/self-percentiles.js";
import { getSessionDrivers } from "../../src/query/api/session-drivers.js";
import { getTrends } from "../../src/query/api/trends.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb } from "../fixtures/seed.js";

const FROM = "2025-12-01T00:00:00.000Z";
const TO = "2026-02-01T00:00:00.000Z";
const WINDOW = `from=${FROM}&to=${TO}`;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

let dir: string;
let db: Database.Database;
let server: http.Server;
let port: number;
let session: string;
let workspace: string;
let anchor: string;

function get(pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Masks timestamps within 10 min of now minus whole days (each call resolves its own "now", and
 * default windows are now minus N days); the fixture's January 2026 dates stay.
 */
function maskNow(json: string): string {
  const now = Date.now();
  return json.replace(ISO, (iso) => {
    const days = (now - Date.parse(iso)) / 86_400_000;
    const offDay = Math.abs(days - Math.round(days)) * 86_400_000;
    return days >= -0.01 && days < 60 && offDay < 600_000 ? "<now>" : iso;
  });
}

/** Runs `fn` while recording every SQL statement the daemon's own connection prepares. */
async function mainThreadSql(fn: () => Promise<unknown>): Promise<string[]> {
  const target = db as unknown as { prepare: (sql: string) => unknown };
  const prepare = target.prepare;
  const seen: string[] = [];
  target.prepare = function (this: unknown, sql: string) {
    seen.push(sql);
    return prepare.call(this, sql);
  };
  try {
    await fn();
  } finally {
    target.prepare = prepare;
  }
  return seen;
}

const OVERVIEW_SECTIONS = [
  "kpis",
  "workspaces",
  "trends",
  "trends_prior",
  "flavor",
  "cache_write",
  "weekly_sessions",
  "live",
  "linkage",
] as const;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-scan-parity-"));
  db = createFixtureDb(path.join(dir, "db.sqlite"));
  const row = db
    .prepare(
      `SELECT session_id, workspace_id, message_id FROM turns
        WHERE session_id = (SELECT session_id FROM turns GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 1)
        ORDER BY ts DESC, message_id DESC LIMIT 1`,
    )
    .get() as { session_id: string; workspace_id: string; message_id: string };
  session = row.session_id;
  workspace = row.workspace_id;
  anchor = row.message_id;
  setQueryDb(db);
  const recsStub = {
    peek: () => ({ state: "cold" }),
    get: () => new Promise(() => {}),
    coldBuild: () => null,
    stop() {},
  } as unknown as RecsSnapshotService;
  server = createServer(db, 0, null, null, null, null, recsStub);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
}, 60_000);

afterAll(async () => {
  await stopScanWorkers(); // their read connections must close before the file can be deleted
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetQueryDb();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** [url, inline status, inline body] — the inline call each route made before P3-F3. */
function cases(): [string, number, () => unknown][] {
  const wsPath = encodeURIComponent(workspace);
  const sPath = encodeURIComponent(session);
  const win = { from: FROM, to: TO };
  return [
    [
      `/api/esf/observations?${WINDOW}`,
      200,
      () => getEsfObservations(db, { workspaceId: null, ...win }),
    ],
    [
      `/api/esf/observations?${WINDOW}&workspace_id=${wsPath}`,
      200,
      () => getEsfObservations(db, { workspaceId: workspace, ...win }),
    ],
    [
      `/api/hot-sessions/page?${WINDOW}&sort=cost`,
      200,
      () =>
        getHotSessionsPage(parseHotSessionsPageQuery(new URLSearchParams(`${WINDOW}&sort=cost`))),
    ],
    [
      "/api/hot-sessions/page?cursor=bogus",
      400,
      () => ({ error: "Invalid cursor", code: "INVALID_QUERY" }),
    ],
    [`/api/hot-sessions?${WINDOW}`, 200, () => getHotSessions(win, 20, {})],
    [`/api/sessions/${sPath}/turns`, 200, () => getTurnTimeline(session, {})],
    [
      `/api/sessions/${sPath}/turns?anchor=${encodeURIComponent(anchor)}&limit=2`,
      200,
      () => getTurnTimelineThrough(session, { anchor }, { limit: 2 }),
    ],
    [
      `/api/sessions/${sPath}/turns?turn_index=3`,
      200,
      () => getTurnTimelineThrough(session, { turn_index: 3 }, {}),
    ],
    [
      `/api/sessions/${sPath}/turns?anchor=not-a-turn`,
      404,
      () => ({ error: "Anchor is not a turn of this session." }),
    ],
    [`/api/esf/session-observations/${sPath}`, 200, () => getSessionEsfObservations(db, session)],
    [
      "/api/esf/session-observations/not-a-session",
      404,
      () => getSessionEsfObservations(db, "not-a-session"),
    ],
    [`/api/workspaces/${wsPath}/context`, 200, () => getContextComposition(workspace)],
    ["/api/hot-sessions/models", 200, () => getHotSessionModels()],
    [`/api/sessions/${sPath}/drivers`, 200, () => getSessionDrivers(db, session)],
    [`/api/sessions/${sPath}/diagnostics`, 200, () => getSessionDiagnostics(session)],
    [`/api/cost-per-success?${WINDOW}`, 200, () => getCostPerSuccess(db, null, FROM, TO)],
    [
      `/api/workspaces/${wsPath}/cost-per-success?${WINDOW}`,
      200,
      () => getCostPerSuccess(db, workspace, FROM, TO),
    ],
    [`/api/workspaces/${wsPath}/sessions?${WINDOW}`, 200, () => listSessions(workspace, win, {})],
    [
      `/api/workspaces/${wsPath}/closure-proxy`,
      200,
      () => getClosureProxy(db, { workspaceId: workspace, now: new Date().toISOString() }),
    ],
    [
      `/api/workspaces/${wsPath}/self-churn?${WINDOW}`,
      200,
      () => getSelfChurn(db, { workspaceId: workspace, ...win }),
    ],
    [`/api/trends?${WINDOW}&bucket=week`, 200, () => getTrends(win, "week", undefined)],
    [`/api/trends/headroom?${WINDOW}`, 200, () => getHeadroomTrend(win, "day", undefined)],
    ["/api/outcomes/workspaces", 200, () => listWorkspaceOutcomes()],
    ["/api/self-percentiles/weekly", 200, () => getWeeklySelfPercentile(db, new Date())],
    [`/api/overview?${WINDOW}`, 200, () => getGlobalOverview(win)],
    [`/api/workspaces?${WINDOW}`, 200, () => listWorkspaces(win, undefined)],
    [`/api/workspaces?${WINDOW}&limit=1`, 200, () => listWorkspaces(win, { limit: 1 })],
  ];
}

describe("offloaded direct routes answer exactly as the inline call", () => {
  it("every case: same status and same JSON, with no route SQL on the daemon connection", async () => {
    const all = cases();
    await get(all[0]?.[0] ?? "/"); // starts the first scan worker
    const served: { status: number; body: string }[] = [];
    const sql = await mainThreadSql(async () => {
      for (const [url] of all) served.push(await get(url));
    });
    expect(sql).toEqual([]);
    // The fixture's sessions reach the bodies, so parity is not just two empty answers agreeing.
    expect(served.filter((r) => r.body.includes(session)).length).toBeGreaterThan(5);
    all.forEach(([url, status, inline], i) => {
      const res = served[i];
      expect({ url, status: res?.status }).toEqual({ url, status });
      expect(maskNow(res?.body ?? "")).toBe(maskNow(JSON.stringify(inline())));
    });
  }, 60_000);

  it("/api/overview-view: each DB section's data is the inline section function's data", async () => {
    const url = `/api/overview-view?${WINDOW}&sections=${OVERVIEW_SECTIONS.join(",")}`;
    let res: { status: number; body: string } = { status: 0, body: "" };
    const sql = await mainThreadSql(async () => {
      res = await get(url);
    });
    expect(sql).toEqual([]);
    expect(res.status).toBe(200);
    const view = JSON.parse(res.body) as {
      sections: Record<string, { status: string; data?: unknown }>;
    };
    const unreachable = () => {
      throw new Error("not used");
    };
    const fns = overviewSectionFns({
      filter: { from: FROM, to: TO },
      window: { from: FROM, to: TO },
      week: {
        from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
      status: unreachable,
      recs: { peek: unreachable, get: unreachable },
    });
    expect(Object.keys(view.sections)).toEqual([...OVERVIEW_SECTIONS]);
    for (const name of OVERVIEW_SECTIONS) {
      let expected: { status: string; data?: unknown };
      try {
        expected = { status: "ok", data: fns[name]() };
      } catch {
        expected = { status: "error" };
      }
      const section = view.sections[name];
      expect({ name, status: section?.status }).toEqual({ name, status: expected.status });
      expect(maskNow(JSON.stringify(section?.data) ?? "")).toBe(
        maskNow(JSON.stringify(expected.data) ?? ""),
      );
    }
  }, 60_000);

  it("/api/overview-view: status (daemon state) still answers on the main thread", async () => {
    const res = await get(`/api/overview-view?${WINDOW}&sections=status,kpis`);
    expect(res.status).toBe(200);
    const view = JSON.parse(res.body) as {
      sections: Record<string, { status: string; data?: { sessions?: number } }>;
    };
    expect(view.sections.status?.status).toBe("ok");
    expect(typeof view.sections.status?.data?.sessions).toBe("number");
    expect(view.sections.kpis?.status).toBe("ok");
  }, 60_000);
});
