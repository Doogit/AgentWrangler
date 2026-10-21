/**
 * test/daemon/practices-route.test.ts — GET /api/practices (BM1).
 *
 * Exercises the route end-to-end over the seeded fixture DB: it serves the 8
 * cited practice statuses and a window, computed on request.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import {
  type RouteSnapshotService,
  buildRouteSnapshot,
  createRouteSnapshotService,
} from "../../src/daemon/route-snapshot.js";
import type { Db } from "../../src/db/open.js";
import { getPractices } from "../../src/detector/practice-registry.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb, createInMemoryFixtureDb } from "../fixtures/seed.js";
import {
  asJson,
  busyWorker,
  close,
  request as getJson,
  listen,
  oldWindow,
} from "./route-snapshot-oracle.js";

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
beforeEach(() => setQueryDb(db));
afterEach(() => resetQueryDb());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("GET /api/practices", () => {
  it("serves 8 cited practices and a window", async () => {
    const res = await request(port, "/api/practices?preset=7d");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      practices: Array<{
        practice_id: string;
        source_url: string;
        source_date: string;
        status: string;
      }>;
      window: { from: string; to: string };
    };
    expect(body.practices).toHaveLength(8);
    expect(body.practices.map((p) => p.practice_id)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
    ]);
    for (const p of body.practices) {
      expect(p.source_url).toMatch(/^https?:\/\//);
      expect(p.source_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["PASS", "ATTENTION", "NO_DATA"]).toContain(p.status);
    }
    expect(typeof body.window.from).toBe("string");
    expect(typeof body.window.to).toBe("string");
  });
});

describe("GET /api/practices detector strip source", () => {
  const DETECTOR_PRACTICES = ["P3", "P4", "P6", "P8"];

  function persistStrip(status: "ACTIVE" | "INACTIVE"): void {
    db.prepare("DELETE FROM detector_status_live").run();
    const ins = db.prepare(
      `INSERT INTO detector_status_live (detector_id, ordinal, name, status, note, evaluated_at)
       VALUES (?, ?, ?, ?, '', '2026-09-25T00:00:00.000Z')`,
    );
    ["D2", "D4", "D8", "D10"].forEach((id, i) => ins.run(id, i, id, status));
  }

  async function detectorStatuses(path: string): Promise<string[]> {
    const body = JSON.parse((await request(port, path)).body) as {
      practices: Array<{ practice_id: string; status: string }>;
    };
    return body.practices
      .filter((p) => DETECTOR_PRACTICES.includes(p.practice_id))
      .map((p) => p.status);
  }

  afterEach(() => {
    db.prepare("DELETE FROM detector_status_live").run();
  });

  it("reads the persisted W0 strip instead of re-evaluating detectors when the window ends now", async () => {
    persistStrip("ACTIVE");
    expect(await detectorStatuses("/api/practices")).toEqual(Array(4).fill("ATTENTION"));
    persistStrip("INACTIVE");
    expect(await detectorStatuses("/api/practices?preset=30d")).toEqual(Array(4).fill("PASS"));
  });

  it("evaluates detectors live for an explicit historical window", async () => {
    const path = "/api/practices?from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z";
    persistStrip("ACTIVE");
    const whenActive = await detectorStatuses(path);
    persistStrip("INACTIVE");
    expect(await detectorStatuses(path)).toEqual(whenActive);
  });
});

/**
 * P1-U8: the route is served from a worker-built snapshot. Oracle: the pre-U8 synchronous
 * handler (`oldPractices`: the copied window resolution + getPractices at the same pinned clock).
 */
describe("P1-U8 practices snapshot", () => {
  const NOW = "2026-01-01T12:00:00.000Z";
  const URLS = [
    "/api/practices",
    "/api/practices?preset=7d",
    "/api/practices?preset=30d",
    "/api/practices?from=2026-01-01T01:00:00.000Z&to=2026-01-01T03:00:00.000Z",
    "/api/practices?to=2026-01-01T02:00:00.000Z",
    "/api/practices?from=2026-01-01T03:00:00.000Z",
  ];
  let root: string;
  let diskDb: Db;
  let service: RouteSnapshotService;
  let snap: { server: http.Server; port: number };

  function oldPractices(url: string): unknown {
    return asJson(getPractices(diskDb, oldWindow(url)));
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-practices-route-"));
    const dbPath = path.join(root, "seed.sqlite");
    diskDb = createFixtureDb(dbPath);
    const ins = diskDb.prepare(
      `INSERT INTO detector_status_live (detector_id, ordinal, name, status, note, evaluated_at)
       VALUES (?, ?, ?, 'ACTIVE', '', '2026-01-01T06:00:00.000Z')`,
    );
    ["D2", "D4", "D8", "D10"].forEach((id, i) => ins.run(id, i, id));
    service = createRouteSnapshotService({ dbPath });
    snap = await listen(diskDb, service);
  }, 30_000);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    setQueryDb(diskDb);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    service?.stop();
    if (snap) await close(snap.server);
    diskDb?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves the old synchronous body for every window spelling (real worker build)", async () => {
    // The oracle is not vacuous: window-ends-now reads the persisted strip, explicit windows do not.
    const status = (url: string) =>
      (oldPractices(url) as { practices: Array<{ practice_id: string; status: string }> }).practices
        .filter((p) => ["P3", "P4", "P6", "P8"].includes(p.practice_id))
        .map((p) => p.status);
    expect(status("/api/practices")).toEqual(Array(4).fill("ATTENTION"));
    // Concurrent cold keys: one worker each, so the test waits for the slowest spawn, not the sum.
    const responses = await Promise.all(URLS.map((url) => getJson(snap.port, url)));
    URLS.forEach((url, i) => {
      expect(responses[i]?.status, url).toBe(200);
      expect(responses[i]?.body, url).toEqual(oldPractices(url));
    });
  }, 60_000);

  it("keeps /api/status under 1 s while a five-second build runs off the loop", async () => {
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let builds = 0;
    const slow = createRouteSnapshotService({
      builder: async (spec) => {
        builds += 1;
        started();
        await busyWorker(5_100);
        return buildRouteSnapshot(diskDb, spec);
      },
    });
    const stub = await listen(diskDb, slow);
    try {
      const url = "/api/practices?preset=7d";
      const cold = getJson(stub.port, url);
      await pending;
      const t0 = performance.now();
      const statusRes = await getJson(stub.port, "/api/status");
      expect(statusRes.status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(1_000);
      const res = await cold;
      expect(res.status).toBe(200);
      expect(res.body).toEqual(oldPractices(url));
      expect(builds).toBe(1);
    } finally {
      slow.stop();
      await close(stub.server);
    }
  }, 20_000);
});
