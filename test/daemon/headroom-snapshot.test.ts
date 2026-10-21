/**
 * test/daemon/headroom-snapshot.test.ts — P3-U5: `/api/efficiency-headroom` served from a
 * worker-built snapshot (unified snapshot service), not computed inline on the main thread.
 *
 * - T1 parity: the route / worker body equals the old inline `getEfficiencyHeadroom` body.
 * - T2 non-blocking: /api/status answers while a 5 s headroom build runs.
 * - T3 stale-while-rebuild: after a rec write the next GET serves the old body ("recomputing")
 *   and exactly one rebuild runs; a later GET returns the new body.
 * - T4 freshness parity: every input the old memo key tracked still triggers a rebuild.
 * - T5 the worker runs through the heavy-job gate.
 *
 * Synthetic fixture data only (SEC-101).
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as nodeHttp from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHeadroomSnapshotService } from "../../src/daemon/headroom-snapshot.js";
import { createHeadroomWorkerRunner } from "../../src/daemon/headroom-worker-runner.js";
import { createHeavyJobGate } from "../../src/daemon/heavy-job-gate.js";
import { createServer } from "../../src/daemon/http.js";
import {
  type RecsSnapshotService,
  createRecsSnapshotService,
} from "../../src/daemon/recs-snapshot.js";
import type { Db } from "../../src/db/open.js";
import { getEfficiencyHeadroom } from "../../src/query/api/efficiency-headroom.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createFixtureDb, createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/query/api/efficiency-headroom.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/query/api/efficiency-headroom.js")>();
  return { ...m, getEfficiencyHeadroom: vi.fn(m.getEfficiencyHeadroom) };
});
const inlineBuild = vi.mocked(getEfficiencyHeadroom);
const realBuild = inlineBuild.getMockImplementation() as typeof getEfficiencyHeadroom;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: Record<string, unknown>; ms: number }> {
  const started = performance.now();
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
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          resolve({
            status: res.statusCode ?? 0,
            text,
            body: JSON.parse(text) as Record<string, unknown>,
            ms: performance.now() - started,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Strip the optional A-17 block so a body can be compared with the old inline one. */
function withoutFreshness(text: string): string {
  const parsed = JSON.parse(text) as { meta: Record<string, unknown> };
  const { freshness: _freshness, ...meta } = parsed.meta;
  return JSON.stringify({ ...parsed, meta });
}

/** A builder whose body says which build produced it; `hold()` makes the next builds wait. */
function stubBuilder() {
  let n = 0;
  let gate: Promise<void> | null = null;
  let release = () => {};
  return {
    count: () => n,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release();
      gate = null;
    },
    build: async () => {
      n += 1;
      const mine = n;
      if (gate) await gate;
      return { data: { build: mine }, meta: {} } as never;
    },
  };
}

function recsStub() {
  return createRecsSnapshotService({
    builder: async () => {
      throw new Error("not used");
    },
  });
}

describe("headroom route (T1-T3)", () => {
  let db: Database.Database;
  let server: http.Server;
  let port: number;
  let recs: RecsSnapshotService;
  const stub = stubBuilder();

  beforeAll(async () => {
    db = createInMemoryFixtureDb();
    setQueryDb(db as unknown as Db);
    recs = recsStub();
    const headroom = createHeadroomSnapshotService({
      db: db as unknown as Db,
      recs,
      builder: stub.build,
    });
    server = createServer(
      db as unknown as Db,
      0,
      null,
      null,
      null,
      null,
      recs,
      undefined,
      undefined,
      headroom,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    recs.stop();
    resetQueryDb();
    db.close();
  });

  it("T2: /api/status answers < 1 s while a 5 s headroom build runs", async () => {
    // What the old route does inline on the loop; the new route must never call it.
    inlineBuild.mockImplementation((() => {
      const end = performance.now() + 5_000;
      while (performance.now() < end) {
        // spin: the real build holds the loop the same way
      }
      return { data: {}, meta: {} } as never;
    }) as typeof getEfficiencyHeadroom);
    stub.hold();
    try {
      const headroom = request(port, "GET", "/api/efficiency-headroom?preset=7d");
      const status = await request(port, "GET", "/api/status");
      expect(status.status).toBe(200);
      expect(status.ms).toBeLessThan(1_000);
      stub.release();
      expect((await headroom).status).toBe(200);
    } finally {
      stub.release();
      inlineBuild.mockImplementation(realBuild);
    }
  }, 20_000);

  it("T3: after a rec write the next GET serves the old body (recomputing); one rebuild; then the new body", async () => {
    const url = "/api/efficiency-headroom?preset=30d";
    const first = await request(port, "GET", url);
    const builtFirst = stub.count();
    expect((first.body.data as { build: number }).build).toBe(builtFirst);

    stub.hold();
    try {
      const write = await request(port, "POST", "/api/recommendations/goal", {
        scope_key: "GLOBAL",
        goal: "PRESERVE_QUALITY",
      });
      expect(write.status).toBe(200);

      const stale = await request(port, "GET", url);
      expect(stale.ms).toBeLessThan(500);
      expect((stale.body.data as { build: number }).build).toBe(builtFirst);
      expect((stale.body.meta as { freshness: { status: string } }).freshness.status).toBe(
        "recomputing",
      );
      // A second GET while the rebuild runs is also stale and starts no second build.
      await request(port, "GET", url);
      expect(stub.count()).toBe(builtFirst + 1);
    } finally {
      stub.release();
    }
    await sleep(20);
    await flush();
    const fresh = await request(port, "GET", url);
    expect((fresh.body.data as { build: number }).build).toBe(builtFirst + 1);
    expect((fresh.body.meta as { freshness: { status: string } }).freshness.status).toBe("ready");
    expect(stub.count()).toBe(builtFirst + 1);
  }, 20_000);
});

describe("headroom snapshot inputs (T4)", () => {
  let db: Database.Database;
  beforeAll(() => {
    db = createInMemoryFixtureDb();
  });
  afterAll(() => db.close());

  function setup() {
    let revision = 0;
    let clock = Date.parse("2026-01-02T00:00:00.000Z");
    const stub = stubBuilder();
    const service = createHeadroomSnapshotService({
      db: db as unknown as Db,
      recs: { revision: () => revision },
      builder: stub.build,
      now: () => clock,
    });
    const win = () => ({ from: "2025-12-26T00:00:00.000Z", to: new Date(clock).toISOString() });
    return {
      service,
      stub,
      win,
      bumpRecs: () => {
        revision += 1;
      },
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  /** GET, then let any rebuild it started settle. */
  async function get(s: ReturnType<typeof setup>) {
    const reply = await s.service.get("7d|", s.win);
    await sleep(10);
    return reply;
  }

  it("a cold GET waits for the build and returns its body", async () => {
    const s = setup();
    const reply = await s.service.get("7d|", s.win);
    expect(s.stub.count()).toBe(1);
    expect((reply.response.data as unknown as { build: number }).build).toBe(1);
    expect(reply.freshness?.status).toBe("ready");
    s.service.stop();
  });

  it("an unchanged state is a hit; an ingest-style workspaces write does not rebuild", async () => {
    const s = setup();
    await get(s);
    db.prepare(
      "UPDATE workspaces SET repo_path = COALESCE(repo_path, '') || 'x' WHERE rowid = (SELECT MIN(rowid) FROM workspaces)",
    ).run();
    await get(s);
    await get(s);
    expect(s.stub.count()).toBe(1);
    s.service.stop();
  });

  it("a recs-snapshot revision change rebuilds (old body served first)", async () => {
    const s = setup();
    await get(s);
    s.bumpRecs();
    const stale = await s.service.get("7d|", s.win);
    expect((stale.response.data as unknown as { build: number }).build).toBe(1);
    await sleep(10);
    expect(s.stub.count()).toBe(2);
    s.service.stop();
  });

  it("a new analysis_runs row rebuilds", async () => {
    const s = setup();
    await get(s);
    db.prepare(
      "INSERT INTO analysis_runs (run_id, scope, model, prompt_version, evidence_pack_hash, ran_at) VALUES (?, 'GLOBAL', 'm', 'v', 'h', ?)",
    ).run(`run-${Date.now()}`, new Date().toISOString());
    await get(s);
    expect(s.stub.count()).toBe(2);
    s.service.stop();
  });

  it("a new 10-minute bucket rebuilds", async () => {
    const s = setup();
    await get(s);
    s.advance(60_000 * 4);
    await get(s);
    const sameBucket = s.stub.count();
    s.advance(600_000);
    await get(s);
    expect(s.stub.count()).toBe(sameBucket + 1);
    s.service.stop();
  });

  it("an explicit from+to range is built on every call and never cached", async () => {
    const s = setup();
    await s.service.compute("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    await s.service.compute("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    expect(s.stub.count()).toBe(2);
    s.service.stop();
  });

  it("F4: distinct window keys are capped like the old memo (500), so old ones are rebuilt", async () => {
    const s = setup();
    await s.service.get("k0", s.win);
    for (let i = 1; i <= 500; i += 1) await s.service.get(`k${i}`, s.win);
    expect(s.stub.count()).toBe(501);
    await s.service.get("k0", s.win);
    expect(s.stub.count()).toBe(502);
    s.service.stop();
  });

  it("a failed cold build rejects, and the next GET builds again", async () => {
    let calls = 0;
    const service = createHeadroomSnapshotService({
      db: db as unknown as Db,
      recs: { revision: () => 0 },
      builder: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { data: {}, meta: {} } as never;
      },
    });
    const win = () => ({ from: "2025-12-26T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" });
    await expect(service.get("7d|", win)).rejects.toThrow("boom");
    await expect(service.get("7d|", win)).resolves.toBeDefined();
    service.stop();
  });
});

describe("headroom worker and parity (T1, T5)", () => {
  let root: string;
  let dbPath: string;
  let db: ReturnType<typeof createFixtureDb>;
  const FROM = "2025-12-01T00:00:00.000Z";
  const TO = "2026-01-02T00:00:00.000Z";

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-headroom-snapshot-"));
    dbPath = path.join(root, "seed.sqlite");
    db = createFixtureDb(dbPath);
    setQueryDb(db);
  }, 30_000);

  afterAll(() => {
    resetQueryDb();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("T1: the worker body is byte-identical to the inline computation (same key order)", async () => {
    const expected = realBuild(db, { from: FROM, to: TO });
    const runner = createHeadroomWorkerRunner(dbPath);
    try {
      const actual = await runner.run({ from: FROM, to: TO });
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    } finally {
      runner.stop();
    }
  }, 30_000);

  it("T1: the route body equals the inline body for the window it reports, for every window the UI asks", async () => {
    const recs = recsStub();
    const server = createServer(db as unknown as Db, 0, null, null, null, null, recs);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // The UI calls /api/efficiency-headroom with no query (default 7 d); presets and a
      // from+to range are the other shapes the route accepts.
      for (const url of [
        "/api/efficiency-headroom",
        "/api/efficiency-headroom?preset=7d",
        `/api/efficiency-headroom?from=${FROM}&to=${TO}`,
      ]) {
        const reply = await request(port, "GET", url);
        expect(reply.status, url).toBe(200);
        const { from, to } = reply.body.data as { from: string; to: string };
        const expected = realBuild(db, { from, to });
        expect(withoutFreshness(reply.text), url).toBe(JSON.stringify(expected));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      recs.stop();
    }
  }, 30_000);

  it("F1: with { dbPath, gate } (the index.ts wiring) a real worker builds and the loop stays free", async () => {
    const recs = recsStub();
    const headroom = createHeadroomSnapshotService({
      db: db as unknown as Db,
      recs,
      dbPath,
      gate: createHeavyJobGate(),
    });
    const server = createServer(
      db as unknown as Db,
      0,
      null,
      null,
      null,
      null,
      recs,
      undefined,
      undefined,
      headroom,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // A main-thread build would spin here; the worker never touches this mock.
    inlineBuild.mockClear();
    inlineBuild.mockImplementation((() => {
      const end = performance.now() + 5_000;
      while (performance.now() < end) {
        // spin
      }
      return { data: {}, meta: {} } as never;
    }) as typeof getEfficiencyHeadroom);
    try {
      const reply = request(port, "GET", "/api/efficiency-headroom?preset=7d");
      const status = await request(port, "GET", "/api/status");
      expect(status.status).toBe(200);
      expect(status.ms).toBeLessThan(1_000);
      const done = await reply;
      expect(done.status).toBe(200);
      expect(inlineBuild).not.toHaveBeenCalled();
      expect((done.body.data as { from?: string }).from).toBeDefined();
    } finally {
      inlineBuild.mockImplementation(realBuild);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      headroom.stop();
      recs.stop();
    }
  }, 30_000);

  it("F1: index.ts hands the headroom service dbPath and the heavy-job gate", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/daemon/index.ts"), "utf8");
    const call = /createHeadroomSnapshotService\(\{([\s\S]*?)\}\);/.exec(source)?.[1] ?? "";
    expect(call).toContain("dbPath: config.dbPath");
    expect(call).toContain("gate: heavyJobGate");
    expect(call).not.toContain("builder");
  });

  it("F2: the window is resolved when the gated build starts, not when it is queued", async () => {
    let clock = Date.parse("2026-01-02T00:00:00.000Z");
    const gate = createHeavyJobGate();
    let release = () => {};
    const held = gate.run(
      "recs",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const service = createHeadroomSnapshotService({
      db: db as unknown as Db,
      recs: { revision: () => 0 },
      dbPath,
      gate,
      now: () => clock,
    });
    try {
      const reply = service.get("7d|", () => ({
        from: "2025-12-01T00:00:00.000Z",
        to: new Date(clock).toISOString(),
      }));
      await sleep(100);
      clock += 108_000;
      const atStart = new Date(clock).toISOString();
      release();
      await held;
      const { response, freshness } = await reply;
      expect((response.data as { to: string }).to).toBe(atStart);
      expect(freshness?.inputs_as_of).toBe(atStart);
    } finally {
      service.stop();
    }
  }, 30_000);

  it("T5: the worker waits in the heavy-job gate behind another heavy job", async () => {
    const gate = createHeavyJobGate();
    let release = () => {};
    const held = gate.run(
      "recs",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runner = createHeadroomWorkerRunner(dbPath, gate);
    let started = false;
    try {
      const done = runner.run({ from: FROM, to: TO }, () => {
        started = true;
      });
      await sleep(300);
      expect(started).toBe(false);
      release();
      await held;
      await done;
      expect(started).toBe(true);
    } finally {
      runner.stop();
    }
  }, 30_000);
});
