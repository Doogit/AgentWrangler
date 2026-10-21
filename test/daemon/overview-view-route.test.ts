/**
 * test/daemon/overview-view-route.test.ts — P1-U2 `GET /api/overview-view`.
 *
 * Oracle for section content: the legacy routes the Overview calls today, on the
 * shared seed (`scripts/build-shared-seed.ts`, the DB verify:app uses), served by
 * the same HTTP handler. Each section also passes its P1-U1 schema.
 *
 * Synthetic fixture data only (SEC-101).
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bumpDataVersion } from "../../src/daemon/data-version.js";
import { createServer } from "../../src/daemon/http.js";
import { createRecsSnapshotService } from "../../src/daemon/recs-snapshot.js";
import { ROUTE_BUDGETS } from "../../src/daemon/route-budgets.js";
import { runQueryOffThread, stopScanWorkers } from "../../src/daemon/scan-offload.js";
import { type Db, openDb } from "../../src/db/open.js";
import {
  type OverviewSection,
  type SectionFn,
  composeSections,
  topRecsSection,
} from "../../src/query/api/overview-view.js";
import { getFlavorDecomposition } from "../../src/query/api/spend-flavor.js";
import { getCacheWriteTrend } from "../../src/query/api/trends.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import {
  type OverviewSectionName,
  overviewSectionSchemas,
} from "../../src/shared/schemas/overview-view.js";

// PERF P3-F3: the DB sections run on a scan worker, where a main-thread mock of the section's
// query function never runs. The route's hand-off to the worker is the observation point instead.
vi.mock("../../src/daemon/scan-offload.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/daemon/scan-offload.js")>();
  return { ...m, runQueryOffThread: vi.fn(m.runQueryOffThread) };
});
const offloadFn = vi.mocked(runQueryOffThread);
const realOffload = offloadFn.getMockImplementation() as typeof runQueryOffThread;
const isFlavor = (args: unknown[]) => args[1] === "overviewSection" && args[2] === "flavor";
const flavorRuns = () => offloadFn.mock.calls.filter((args) => isFlavor(args)).length;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

function get(port: number, urlPath: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
          }),
        );
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function data(port: number, urlPath: string): Promise<Record<string, unknown>> {
  return ((await get(port, urlPath)).body as { data: Record<string, unknown> }).data;
}

interface View {
  data_version: number;
  consistent: boolean;
  window: { from: string; to: string };
  sections: Partial<Record<OverviewSectionName, OverviewSection>>;
}

async function view(port: number, query = "?preset=7d"): Promise<View> {
  const reply = await get(port, `/api/overview-view${query}`);
  expect(reply.status).toBe(200);
  return reply.body as View;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin: a synchronous section holding the loop
  }
}

let scratchRoot: string;
let server: http.Server;
let port: number;
let db: Db;
const servers: http.Server[] = [];

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as { port: number }).port;
}

beforeAll(async () => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-overview-view-"));
  const dbPath = path.join(scratchRoot, "shared-seed.sqlite");
  childProcess.execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "scripts/build-shared-seed.ts", dbPath],
    { cwd: path.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
  );
  db = openDb(dbPath);
  setQueryDb(db);
  server = createServer(db, 0, null);
  port = await listen(server);
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await stopScanWorkers();
  for (const s of [server, ...servers]) {
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
  resetQueryDb();
  db.close();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe("GET /api/overview-view (P1-U2)", () => {
  it("1. every section equals its legacy route on the seed and passes its schema", async () => {
    const kpis = await data(port, "/api/overview?preset=7d");
    const trends = (await get(port, "/api/trends?preset=7d&bucket=day")).body as {
      data: Record<string, unknown>;
      meta: { window: { from: string; to: string } };
    };
    const { from, to } = trends.meta.window;
    const priorFrom = new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from)));
    const prior = new URLSearchParams({ from: priorFrom.toISOString(), to: from, bucket: "day" });
    const week = await data(port, "/api/overview?preset=7d");
    const hot = (await get(port, "/api/hot-sessions?preset=7d")).body as unknown[];
    const recs = await data(port, "/api/recommendations");
    const legacy: Record<OverviewSectionName, unknown> = {
      kpis,
      workspaces: await data(port, "/api/workspaces?preset=7d"),
      trends: trends.data,
      trends_prior: await data(port, `/api/trends?${prior.toString()}`),
      // The standalone routes were removed (PZ); call the query functions directly.
      flavor: getFlavorDecomposition({ preset: "7d" }).data,
      cache_write: getCacheWriteTrend({ preset: "7d" }, "day").data,
      weekly_sessions: { rows: hot.slice(0, 5), cost_equiv_u: week.cost_equiv_u },
      live: await data(port, "/api/live"),
      status: (await get(port, "/api/status")).body,
      top_recs: { active: recs.active, adopted: recs.adopted, active_groups: recs.active_groups },
      linkage: await data(port, "/api/outcomes/linkage"),
      hook_config: await data(port, "/api/hook-config"),
    };

    const body = await view(port);
    expect(Object.keys(body.sections).sort()).toEqual(Object.keys(overviewSectionSchemas).sort());
    expect(Date.parse(body.window.to) - Date.parse(body.window.from)).toBe(7 * 86_400_000);
    expect(body.consistent).toBe(true);
    expect(typeof body.data_version).toBe("number");
    for (const name of Object.keys(legacy) as OverviewSectionName[]) {
      const section = body.sections[name];
      expect({ name, status: section?.status }).toEqual({ name, status: "ok" });
      expect(typeof section?.ms).toBe("number");
      // loop_lag is a live in-memory sample; every other status field must match.
      const expected =
        name === "status"
          ? { ...(legacy.status as object), loop_lag: expect.anything() }
          : legacy[name];
      expect(section?.data).toEqual(expected);
      const parsed = overviewSectionSchemas[name].safeParse(section?.data);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    }
    // Not vacuous: the seed has spend and recs.
    expect((body.sections.top_recs?.data as { active: unknown[] }).active.length).toBeGreaterThan(
      0,
    );
    expect((body.sections.kpis?.data as { cost_equiv_u: number }).cost_equiv_u).toBeGreaterThan(0);
  }, 30_000);

  it("preset=all spans every turn: window from the epoch, kpis equal the from-epoch route", async () => {
    const body = await view(port, "?preset=all&sections=kpis");
    expect(body.window.from).toBe("1970-01-01T00:00:00.000Z");
    const kpis = body.sections.kpis?.data as { turns: number };
    expect(kpis).toEqual(await data(port, "/api/overview?from=1970-01-01T00:00:00.000Z"));
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number };
    expect(kpis.turns).toBe(n);
    const week = (await view(port, "?preset=7d&sections=kpis")).sections.kpis?.data as {
      turns: number;
    };
    expect(kpis.turns).toBeGreaterThan(week.turns);
  });

  it("2. a section that throws is `error`; the others stay `ok`; HTTP 200", async () => {
    bumpDataVersion(); // defeat the section memo
    const real = realOffload as (...args: unknown[]) => Promise<string>;
    offloadFn.mockImplementation(((...args: unknown[]) =>
      isFlavor(args)
        ? Promise.reject(new Error("flavor exploded"))
        : real(...args)) as typeof runQueryOffThread);
    let body: Awaited<ReturnType<typeof view>>;
    try {
      body = await view(port);
    } finally {
      offloadFn.mockImplementation(realOffload);
    }
    expect(body.sections.flavor?.status).toBe("error");
    expect(body.sections.flavor?.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("flavor exploded");
    for (const [name, section] of Object.entries(body.sections)) {
      if (name !== "flavor")
        expect({ name, status: section.status }).toEqual({ name, status: "ok" });
    }
  });

  it("3. a cold recs snapshot → `top_recs: pending` within 300 ms", async () => {
    const coldRecs = createRecsSnapshotService({ builder: () => new Promise(() => {}) });
    const cold = createServer(db, 0, null, null, null, null, coldRecs);
    servers.push(cold);
    const coldPort = await listen(cold);
    const started = performance.now();
    const body = await view(coldPort, "?preset=7d&sections=top_recs");
    expect(performance.now() - started).toBeLessThan(300);
    expect(Object.keys(body.sections)).toEqual(["top_recs"]);
    expect(body.sections.top_recs?.status).toBe("pending");
    coldRecs.stop();
  });

  it("3b. OV-13: `/api/status` lists a cold recs build in `jobs`, and omits `jobs` once built", async () => {
    let finish!: () => void;
    const recs = createRecsSnapshotService({
      builder: () =>
        new Promise((resolve) => {
          finish = () => resolve({ result: { data: null } as never, builtAtMs: Date.now() });
        }),
    });
    const s = createServer(db, 0, null, null, null, null, recs);
    servers.push(s);
    const statusPort = await listen(s);
    void recs.get();
    const during = (await get(statusPort, "/api/status")).body as { jobs?: unknown };
    expect(during.jobs).toEqual([
      { kind: "recommendations", started_at: expect.any(String), expected_ms: null },
    ]);
    finish();
    await recs.get();
    const after = (await get(statusPort, "/api/status")).body as Record<string, unknown>;
    expect(after).not.toHaveProperty("jobs");
    recs.stop();
  });

  it("4. M1: the loop is never held longer than the largest section + 20 ms", async () => {
    const section: SectionFn = () => busy(40);
    const fns: Partial<Record<OverviewSectionName, SectionFn>> = {
      kpis: section,
      workspaces: section,
      trends: section,
      flavor: section,
    };
    let last = performance.now();
    let maxGap = 0;
    let ticking = true;
    const tick = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    await composeSections(fns);
    ticking = false;
    tick(); // the gap since the ticker last ran (all of it, if the composer never yielded)
    expect(maxGap).toBeLessThanOrEqual(40 + 20);
  });

  describe("5. top_recs reaches a terminal state", () => {
    it("a failed snapshot build → `error`, not `pending`", async () => {
      const recs = createRecsSnapshotService({
        builder: () => Promise.reject(new Error("build failed")),
      });
      const first = await composeSections({ top_recs: () => topRecsSection(recs) });
      expect(first.sections.top_recs?.status).toBe("pending");
      await flush();
      await flush();
      const second = await composeSections({ top_recs: () => topRecsSection(recs) });
      expect(second.sections.top_recs?.status).toBe("error");
      recs.stop();
    });

    // OV-13: the old 60 s limit turned a slow but healthy build into an error; 10 min is a hang ceiling.
    it("a 90 s build is still `pending` with progress; past 10 min → `error`", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const recs = createRecsSnapshotService({ builder: () => new Promise(() => {}) });
      const first = await composeSections({ top_recs: () => topRecsSection(recs) });
      expect(first.sections.top_recs?.status).toBe("pending");
      expect(first.sections.top_recs?.progress).toBeUndefined(); // cold: not started yet
      await flush();
      expect(recs.peek().state).toBe("building");
      vi.setSystemTime(Date.now() + 90_000);
      const mid = await composeSections({ top_recs: () => topRecsSection(recs) });
      expect(mid.sections.top_recs?.status).toBe("pending");
      expect(mid.sections.top_recs?.progress).toEqual({
        started_at: expect.any(String),
        expected_ms: null,
      });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const late = await composeSections({ top_recs: () => topRecsSection(recs) });
      expect(late.sections.top_recs?.status).toBe("error");
      recs.stop();
    });
  });

  describe("6. consistency across an ingest commit", () => {
    it("a commit between sections recomputes the earlier sections once", async () => {
      const calls = { kpis: 0, workspaces: 0, trends: 0 };
      const result = await composeSections({
        kpis: () => ++calls.kpis,
        workspaces: () => {
          calls.workspaces += 1;
          if (calls.workspaces === 1) bumpDataVersion();
          return calls.workspaces;
        },
        trends: () => ++calls.trends,
      });
      expect(calls).toEqual({ kpis: 2, workspaces: 2, trends: 1 });
      expect(result.consistent).toBe(true);
      expect(result.sections.kpis?.data).toBe(2);
    });

    it("a second commit during the recompute → `consistent: false`", async () => {
      const result = await composeSections({
        kpis: () => 1,
        workspaces: () => {
          bumpDataVersion();
          return 2;
        },
      });
      expect(result.consistent).toBe(false);
      expect(result.sections.workspaces?.status).toBe("ok");
    });
  });

  it("7. two identical requests at one data_version run the DB sections once", async () => {
    bumpDataVersion();
    offloadFn.mockClear();
    const a = await view(port);
    const b = await view(port);
    expect(flavorRuns()).toBe(1);
    expect(b.sections.flavor?.data).toEqual(a.sections.flavor?.data);
    expect(b.data_version).toBe(a.data_version);
    bumpDataVersion();
    await view(port);
    expect(flavorRuns()).toBe(2);
  });

  it("is registered with a budget and kept out of the whole-body GET memo", () => {
    expect(ROUTE_BUDGETS["/api/overview-view"]?.nomemo).toBeTruthy();
  });

  it("an unknown `sections` name → 400", async () => {
    const reply = await get(port, "/api/overview-view?sections=live,nope");
    expect(reply.status).toBe(400);
  });

  it("Server-Timing lists each computed section", async () => {
    const reply = await get(port, "/api/overview-view?preset=7d&sections=live,status");
    expect(reply.headers["server-timing"]).toMatch(/live;dur=[\d.]+/);
    expect(reply.headers["server-timing"]).toMatch(/status;dur=[\d.]+/);
  });
});
