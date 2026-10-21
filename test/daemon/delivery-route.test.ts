/**
 * test/daemon/delivery-route.test.ts — P1-U8: GET /api/delivery and
 * /api/workspaces/:id/delivery are served from a worker-built snapshot.
 *
 * Oracle: the pre-U8 synchronous handler (`oldDelivery`: the copied window
 * resolution + getDeliveryMetrics on the same DB at the same pinned clock).
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpDataVersion } from "../../src/daemon/data-version.js";
import {
  type RouteSnapshotService,
  buildRouteSnapshot,
  createRouteSnapshotService,
} from "../../src/daemon/route-snapshot.js";
import type { Db } from "../../src/db/open.js";
import { getDeliveryMetrics } from "../../src/query/api/delivery.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb } from "../fixtures/seed.js";
import { asJson, busyWorker, close, listen, oldWindow, request } from "./route-snapshot-oracle.js";

// The seed's turns are 2026-01-01 00:00–05:05Z.
const NOW = "2026-01-01T12:00:00.000Z";

const URLS = [
  "/api/delivery",
  "/api/delivery?preset=24h",
  "/api/delivery?preset=7d",
  "/api/delivery?preset=30d",
  "/api/delivery?from=2026-01-01T01:00:00.000Z&to=2026-01-01T03:00:00.000Z",
  "/api/delivery?to=2026-01-01T02:00:00.000Z",
  "/api/delivery?from=2026-01-01T03:00:00.000Z",
  "/api/workspaces/ws-alpha/delivery",
  "/api/workspaces/ws-alpha/delivery?preset=30d",
  "/api/workspaces/ws-beta/delivery?preset=24h",
  "/api/workspaces/ws%20none/delivery",
];

let root: string;
let dbPath: string;
let db: Db;
let service: RouteSnapshotService;
let server: http.Server;
let port: number;

function oldDelivery(url: string): unknown {
  const pathname = url.split("?")[0] ?? url;
  const match = pathname.match(/^\/api\/workspaces\/([^/]+)\/delivery$/);
  const { from, to } = oldWindow(url);
  return asJson(
    getDeliveryMetrics(db, {
      workspaceId: match?.[1] ? decodeURIComponent(match[1]) : null,
      from,
      to,
    }),
  );
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-delivery-route-"));
  dbPath = path.join(root, "seed.sqlite");
  db = createFixtureDb(dbPath);
  const ins = db.prepare(
    "INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha) VALUES (?,?,?,?,?)",
  );
  ins.run("u8-a1", "sess-a1", "2026-01-01T00:10:00.000Z", "Bash", "abc123");
  ins.run("u8-a2", "sess-a2", "2026-01-01T01:10:00.000Z", "Edit", null);
  ins.run("u8-b1", "sess-b1", "2026-01-01T03:30:00.000Z", "Write", null);
  ins.run("u8-b2", "sess-b2", "2026-01-01T05:01:00.000Z", "Edit", null);
  service = createRouteSnapshotService({ dbPath });
  ({ server, port } = await listen(db, service));
}, 30_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  setQueryDb(db);
});

afterEach(() => {
  vi.useRealTimers();
  resetQueryDb();
});

afterAll(async () => {
  service?.stop();
  if (server) await close(server);
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("P1-U8 delivery snapshot", () => {
  it("serves the old synchronous body for every window spelling (real worker build)", async () => {
    // The oracle is not vacuous: the seed has commit and no-commit sessions in the window.
    const all = oldDelivery("/api/delivery") as { data: Record<string, number> };
    expect(all.data.commit_session_count).toBe(1);
    expect(all.data.no_commit_activity_session_count).toBe(2);
    // Concurrent cold keys: one worker each, so the test waits for the slowest spawn, not the sum.
    const responses = await Promise.all(URLS.map((url) => request(port, url)));
    URLS.forEach((url, i) => {
      expect(responses[i]?.status, url).toBe(200);
      expect(responses[i]?.body, url).toEqual(oldDelivery(url));
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
        return buildRouteSnapshot(db, spec);
      },
    });
    const stub = await listen(db, slow);
    try {
      const url = "/api/workspaces/ws-alpha/delivery?preset=7d";
      const cold = request(stub.port, url);
      await pending;
      const t0 = performance.now();
      const status = await request(stub.port, "/api/status");
      expect(status.status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(1_000);
      const res = await cold;
      expect(res.status).toBe(200);
      expect(res.body).toEqual(oldDelivery(url));
      expect(builds).toBe(1);
    } finally {
      slow.stop();
      await close(stub.server);
    }
  }, 20_000);

  it("answers 500 when a cold build fails", async () => {
    const failing = createRouteSnapshotService({
      builder: () => Promise.reject(new Error("build failed")),
    });
    const stub = await listen(db, failing);
    try {
      expect((await request(stub.port, "/api/delivery")).status).toBe(500);
    } finally {
      failing.stop();
      await close(stub.server);
    }
  });

  it("serves the last snapshot after a data change, then the rebuilt one", async () => {
    const url = "/api/workspaces/ws-alpha/delivery?preset=24h";
    const before = (await request(port, url)).body;
    expect(before).toEqual(oldDelivery(url));
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha) VALUES (?,?,?,?,?)",
    ).run("u8-a2-commit", "sess-a2", "2026-01-01T01:20:00.000Z", "Bash", "def456");
    bumpDataVersion();
    const after = oldDelivery(url);
    expect(after).not.toEqual(before);
    // Stale-while-revalidate: this GET answers from the old snapshot and starts one rebuild.
    expect((await request(port, url)).body).toEqual(before);
    const deadline = performance.now() + 15_000;
    let body = before;
    while (performance.now() < deadline) {
      body = (await request(port, url)).body;
      if (JSON.stringify(body) === JSON.stringify(after)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(body).toEqual(after);
  }, 30_000);
});
