/**
 * PERF: the judge-setup, judge-setup/consent and idle-sessions scans must not block the event loop.
 * The oracle is loop lag sampled by a timer in this process while the request is served; the
 * workload is first timed inline so the test fails loudly if it ever stops being heavy.
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
import { gradeSetup } from "../../src/detector/setup-grade.js";
import { getEsfObservations } from "../../src/query/api/esf-observations.js";
import { getIdleSessions } from "../../src/query/api/idle-sessions.js";
import { getGlobalOverview } from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { scanEnvironment } from "../../src/scanner/env-scan.js";
import { createFixtureDb } from "../fixtures/seed.js";

const SKILLS = 2_000;
const TURNS = 160_000;
const RECENT_TURNS = 1_200_000;
/** A free loop shows a few ms of lag; the inline scans below each block for far longer. */
const MAX_LAG_MS = 40;
const MIN_INLINE_MS = 60;

let dir: string;
let db: Database.Database;
let server: http.Server;
let port: number;
let prevEnv: { dir: string | undefined; json: string | undefined };

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

/** Max gap beyond the 2 ms tick while `work` runs. */
async function maxLagDuring(work: () => Promise<unknown>): Promise<number> {
  let max = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 2);
    last = now;
  }, 2);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return max;
}

function inlineMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-scan-lag-"));
  const claudeDir = path.join(dir, "claude");
  for (let i = 0; i < SKILLS; i++) {
    const skill = path.join(claudeDir, "skills", `skill-${i}`);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), `---\nname: s${i}\n---\nbody\n`);
  }
  fs.writeFileSync(path.join(dir, "claude.json"), "{}");
  prevEnv = { dir: process.env.AW_CLAUDE_DIR, json: process.env.AW_CLAUDE_JSON };
  process.env.AW_CLAUDE_DIR = claudeDir;
  process.env.AW_CLAUDE_JSON = path.join(dir, "claude.json");

  db = createFixtureDb(path.join(dir, "db.sqlite"));
  const one = db.prepare("SELECT session_id, workspace_id, model FROM turns LIMIT 1").get() as {
    session_id: string;
    workspace_id: string;
    model: string;
  };
  db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TURNS})
     INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
                        input_tokens, output_tokens, cache_read_tokens, parser_version)
     SELECT 'lag-' || i, ?, ?, '2020-01-01T00:00:00.000Z', ?, 1, 10, 10, 100, 'test' FROM n`,
  ).run(one.session_id, one.workspace_id, one.model);
  // Recent turns inside the 30-day window, so the setup grade (SQL checks) has real work to do.
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('lag-recent', ?, 'lag-recent.jsonl', 'RECONCILED')",
  ).run(one.workspace_id);
  db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${RECENT_TURNS})
     INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
                        input_tokens, output_tokens, cache_read_tokens, parser_version)
     SELECT 'lag-r-' || i, 'lag-recent', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (i % 20) || ' days'),
            ?, 0, 10, 10, 100, 'test' FROM n`,
  ).run(one.workspace_id, one.model);
  // Recent editing sessions that ran no test: verify_test_loop FAILs, so judge-setup has "where" rows.
  for (let i = 0; i < 8; i++) {
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, ?, ?, 'RECONCILED')",
    ).run(`lag-edit-${i}`, one.workspace_id, `lag-edit-${i}.jsonl`);
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days'), 'Edit')",
    ).run(`lag-edit-${i}-e`, `lag-edit-${i}`);
  }
  setQueryDb(db);

  // Production builds recs on a worker; the in-process default would add its own lag to the measure.
  const recsStub = {
    peek: () => ({ state: "cold" }),
    get: () => new Promise(() => {}),
    stop() {},
  } as unknown as RecsSnapshotService;
  server = createServer(db, 0, null, null, null, null, recsStub);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
}, 300_000);

afterAll(async () => {
  await stopScanWorkers();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetQueryDb();
  db.close();
  for (const [key, value] of [
    ["AW_CLAUDE_DIR", prevEnv.dir],
    ["AW_CLAUDE_JSON", prevEnv.json],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scan routes do not block the event loop", () => {
  it("the workloads really are heavy when run inline", () => {
    const claudeDir = path.join(dir, "claude");
    expect(inlineMs(() => scanEnvironment(db, { claudeDir }))).toBeGreaterThan(MIN_INLINE_MS);
    expect(inlineMs(() => getIdleSessions())).toBeGreaterThan(MIN_INLINE_MS);
  }, 120_000);

  it("the post-scan grading is heavy when run inline (so it must stay on the worker)", () => {
    const scan = scanEnvironment(db, { claudeDir: path.join(dir, "claude") });
    expect(inlineMs(() => gradeSetup({ db, scan, now: new Date() }))).toBeGreaterThan(
      MIN_INLINE_MS,
    );
  }, 120_000);

  it('/api/judge-setup: the grade\'s "where" SQL runs on the worker, not the daemon connection', async () => {
    await get("/api/judge-setup"); // starts the scan worker
    const target = db as unknown as { prepare: (sql: string) => unknown };
    const prepare = target.prepare;
    const seen: string[] = [];
    target.prepare = function (this: unknown, sql: string) {
      seen.push(sql);
      return prepare.call(this, sql);
    };
    let json: { where?: Record<string, unknown[]> };
    try {
      const res = await get("/api/judge-setup");
      expect(res.status).toBe(200);
      json = JSON.parse(res.body);
    } finally {
      target.prepare = prepare;
    }
    expect(json.where?.verify_test_loop?.length).toBeGreaterThan(0);
    expect(seen.filter((sql) => sql.includes("WITH edits AS"))).toEqual([]);
  }, 120_000);

  it("PERF P3-F3: the offloaded direct-route reads are heavy when run inline", () => {
    const now = Date.now();
    const from = new Date(now - 86_400_000).toISOString();
    const to = new Date(now).toISOString();
    expect(inlineMs(() => getGlobalOverview({ preset: "24h" }))).toBeGreaterThan(MIN_INLINE_MS);
    expect(inlineMs(() => getEsfObservations(db, { workspaceId: null, from, to }))).toBeGreaterThan(
      MIN_INLINE_MS,
    );
  }, 120_000);

  // Each request gets its own `n` so the GET memo cannot answer the measured one.
  for (const route of ["/api/overview?preset=24h", "/api/esf/observations?preset=24h"]) {
    it(
      `${route}: served off the loop (lag under ${MAX_LAG_MS} ms) with a full body`,
      { timeout: 120_000, retry: 2 },
      async () => {
        const warm = await get("/api/outcomes/workspaces"); // starts a scan worker
        expect(warm.status).toBe(200);
        const lag = await maxLagDuring(async () => {
          const res = await get(`${route}&n=${Date.now()}`);
          expect(res.status).toBe(200);
          const json = JSON.parse(res.body) as { meta: { n: number } };
          expect(json.meta.n).toBeGreaterThan(0);
        });
        expect(lag).toBeLessThan(MAX_LAG_MS);
      },
    );
  }

  it("a long offloaded query does not queue a short one (second pool worker)", async () => {
    // Two concurrent warm-ups reach both pool workers, so both have booted.
    await Promise.all([
      get(`/api/outcomes/workspaces?n=a-${Date.now()}`),
      get(`/api/outcomes/workspaces?n=b-${Date.now()}`),
    ]);
    let heavyDone = false;
    const heavy = get(`/api/esf/observations?preset=7d&n=${Date.now()}`).then((res) => {
      heavyDone = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const light = await get(`/api/outcomes/workspaces?n=${Date.now()}`);
    expect(light.status).toBe(200);
    expect(heavyDone).toBe(false);
    expect((await heavy).status).toBe(200);
  }, 120_000);

  for (const route of [
    "/api/judge-setup",
    "/api/judge-setup/consent",
    "/api/idle-sessions",
    "/api/agents-liveness",
  ]) {
    it(
      `${route}: loop lag stays under ${MAX_LAG_MS} ms and the body is complete`,
      { timeout: 120_000, retry: 2 },
      async () => {
        const warm = await get(route); // starts the scan worker
        expect(warm.status).toBe(200);
        const lag = await maxLagDuring(async () => {
          const res = await get(route);
          expect(res.status).toBe(200);
          const json = JSON.parse(res.body) as Record<string, unknown>;
          if (route === "/api/judge-setup") {
            expect((json.grade as { checks: unknown[] }).checks.length).toBeGreaterThan(0);
          } else if (route === "/api/idle-sessions") {
            expect((json.data as unknown[]).length).toBeGreaterThanOrEqual(1);
          } else if (route === "/api/agents-liveness") {
            expect(typeof (json.data as { available: unknown }).available).toBe("boolean");
          } else {
            expect(["ready", "blocked"]).toContain(json.state);
          }
        });
        expect(lag).toBeLessThan(MAX_LAG_MS);
      },
    );
  }
});
