/**
 * test/daemon/headroom-memo.test.ts — P1-U6a test 6: the `/api/efficiency-headroom` memo.
 *
 * - Key: the recs-snapshot revision (bumped by afterRecWrite) + the analysis_runs max rowid +
 *   the 10-min bucket, not the 18-table state hash. An ingest write to `workspaces` keeps the
 *   key; a rec write changes it.
 * - On a miss with an older body present, the route serves the older body at once and runs
 *   exactly one rebuild after the response.
 *
 * Oracle: build counts on a spy over the real `getEfficiencyHeadroom`, and wall-clock time of
 * the response against a stub build that holds the loop for 2 s.
 *
 * Synthetic fixture data only (SEC-101).
 */

import type * as http from "node:http";
import * as nodeHttp from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import {
  type RecsSnapshotService,
  createRecsSnapshotService,
} from "../../src/daemon/recs-snapshot.js";
import type { Db } from "../../src/db/open.js";
import { getEfficiencyHeadroom } from "../../src/query/api/efficiency-headroom.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/query/api/efficiency-headroom.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/query/api/efficiency-headroom.js")>();
  return { ...m, getEfficiencyHeadroom: vi.fn(m.getEfficiencyHeadroom) };
});
const buildFn = vi.mocked(getEfficiencyHeadroom);

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; appMs: number }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = nodeHttp.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
            appMs: Number(/app;dur=([\d.]+)/.exec(String(res.headers["server-timing"]))?.[1]),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const URL_7D = "/api/efficiency-headroom?preset=7d";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

let db: Database.Database;
let server: http.Server;
let port: number;
let recs: RecsSnapshotService;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  setQueryDb(db as unknown as Db);
  recs = createRecsSnapshotService({
    builder: async () => {
      throw new Error("not used");
    },
  });
  server = createServer(db as unknown as Db, 0, null, null, null, null, recs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  // Let any deferred rebuild finish before the next test swaps the stub.
  await flush();
  await flush();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  recs.stop();
  resetQueryDb();
  db.close();
});

/** A stub build whose body says which build produced it. */
function stubBuilds(holdMs = 0): { count: () => number } {
  let n = 0;
  buildFn.mockImplementation((() => {
    const end = performance.now() + holdMs;
    while (performance.now() < end) {
      // spin: the real build holds the loop the same way
    }
    n += 1;
    return { build: n } as never;
  }) as typeof getEfficiencyHeadroom);
  return { count: () => n };
}

describe("headroom memo (P1-U6a test 6)", () => {
  it("an ingest write to workspaces keeps the key; a rec write changes it", async () => {
    const builds = stubBuilds();
    // A fresh revision so earlier tests' bodies do not count.
    recs.invalidate();
    await request(port, "GET", URL_7D);
    await flush();
    const afterFirst = builds.count();
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Ingest-style write: workspaces (and context_inventory) change during backfill.
    db.prepare(
      "UPDATE workspaces SET repo_path = COALESCE(repo_path, '') || 'x' WHERE rowid = (SELECT MIN(rowid) FROM workspaces)",
    ).run();
    await request(port, "GET", URL_7D);
    await flush();
    await flush();
    expect(builds.count()).toBe(afterFirst);

    // A rec write through the real route runs afterRecWrite.
    const write = await request(port, "POST", "/api/recommendations/goal", {
      scope_key: "GLOBAL",
      goal: "PRESERVE_QUALITY",
    });
    expect(write.status).toBe(200);
    await request(port, "GET", URL_7D);
    await flush();
    await flush();
    expect(builds.count()).toBe(afterFirst + 1);
  });

  it("an analysis_runs insert changes the key", async () => {
    const builds = stubBuilds();
    recs.invalidate();
    await request(port, "GET", URL_7D);
    await flush();
    const before = builds.count();
    db.prepare(
      "INSERT INTO analysis_runs (run_id, scope, model, prompt_version, evidence_pack_hash, ran_at) VALUES (?, 'GLOBAL', 'm', 'v', 'h', ?)",
    ).run(`run-${Date.now()}`, new Date().toISOString());
    await request(port, "GET", URL_7D);
    await flush();
    await flush();
    expect(builds.count()).toBe(before + 1);
  });

  it("a miss with an older body serves the older body in < 100 ms and runs exactly one rebuild", async () => {
    const fast = stubBuilds();
    recs.invalidate();
    await request(port, "GET", URL_7D);
    await flush();
    await flush();
    expect(fast.count()).toBe(1);
    const older = (await request(port, "GET", URL_7D)).body; // a memo hit on this revision
    // P3-U5: the body now carries the optional A-17 meta.freshness block.
    expect(older).toMatchObject({ build: 1 });
    expect(fast.count()).toBe(1);

    const slow = stubBuilds(2_000);
    recs.invalidate(); // what afterRecWrite does
    const stale = await request(port, "GET", URL_7D);
    expect(stale.body).toMatchObject({ build: 1 });
    // Server-side time to the response (Server-Timing app;dur). Wall time on the client would
    // include the deferred 2 s rebuild, because this test's client shares the server's loop.
    expect(stale.appMs).toBeLessThan(100);
    // A second GET while the rebuild is pending is also served stale and starts no second build.
    await request(port, "GET", URL_7D);
    // Let the deferred rebuild run (it holds the loop 2 s), then settle.
    await new Promise((r) => setTimeout(r, 2_300));
    expect(slow.count()).toBe(1);
    const fresh = await request(port, "GET", URL_7D);
    expect(fresh.body).toMatchObject({ build: 1 });
    await flush();
    expect(slow.count()).toBe(1);
  }, 15_000);

  it("a cold miss (no body for the URL) still builds inline", async () => {
    const builds = stubBuilds();
    recs.invalidate();
    const reply = await request(port, "GET", "/api/efficiency-headroom?preset=30d");
    expect(reply.body).toMatchObject({ build: 1 });
    expect(builds.count()).toBe(1);
  });
});
