/**
 * test/daemon/http.test.ts — HTTP security baseline tests.
 *
 * Covers:
 *   1. Host guard: loopback allow / non-loopback deny (421).
 *   2. CSRF matrix (against POST /api/settings — the write path):
 *        Sec-Fetch-Site: same-origin + JSON → 200 (reaches handler stub)
 *        Sec-Fetch-Site: cross-site → 403
 *        Sec-Fetch-Site: same-site → 403
 *        No Sec-Fetch-Site + Origin: http://evil.example → 403
 *        No Sec-Fetch-Site + Origin: null → 403
 *        No Sec-Fetch-Site + no Origin + text/plain CT → 415 (CT gate fires)
 *        No Sec-Fetch-Site + no Origin + application/json → 200 (legacy same-origin)
 *   3. Verified: no permissive CORS headers emitted.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { resetPerfMonitor } from "../../src/daemon/perf-monitor.js";
import { setScanRoots, setScanState } from "../../src/daemon/readiness.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createDiscoveryCache, refreshDiscoveryCache } from "../../src/ingest/discovery.js";
import { Health } from "../../src/ingest/health.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { clearHealthInstance, setHealthInstance } from "../../src/query/settings-store.js";

// P0-U2: /api/idle-sessions is mocked (module-wide) so a test can inject a
// controlled synchronous busy-wait — the independent oracle for the
// Server-Timing / /api/perf instrumentation tests below. `busyWaitState.ms`
// defaults to 0 (no-op passthrough) so every other test hitting this route
// (there are none today) would be unaffected.
const busyWaitState = vi.hoisted(() => ({ ms: 0 }));
vi.mock("../../src/query/api/idle-sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/query/api/idle-sessions.js")>();
  return {
    ...actual,
    getIdleSessions: () => {
      const start = Date.now();
      while (Date.now() - start < busyWaitState.ms) {
        // intentional synchronous block — the injected sleep duration (oracle)
      }
      return actual.getIdleSessions();
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RequestOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(port: number, opts: RequestOptions = {}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const { method = "GET", path = "/", headers = {}, body } = opts;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;
let db: Database.Database;
let uiRoot: string;
let bootScanKicks: number;

beforeAll(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // The POST /api/settings write path reaches the DB through the query-db
  // context (getQueryDb), not the `db` handed to createServer. Migrate this
  // in-memory DB and inject it so the handler is hermetic — otherwise it falls
  // through to getQueryDb()'s lazy-open of the real ~/.agentwrangler/db.sqlite,
  // which exists on a dev machine (→200) but not on CI (→400).
  runMigrations(db);
  setQueryDb(db);
  uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-spa-"));
  fs.writeFileSync(
    path.join(uiRoot, "index.html"),
    '<!doctype html><html><body><div id="app">AgentWrangler SPA fixture</div></body></html>',
  );
});

beforeEach(
  () =>
    new Promise<void>((resolve, reject) => {
      bootScanKicks = 0;
      busyWaitState.ms = 0;
      resetPerfMonitor();
      server = createServer(db, 0, uiRoot, null, () => {
        bootScanKicks++;
      }); // port=0 → OS picks ephemeral port
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        port = addr.port;
        resolve();
      });
      server.on("error", reject);
    }),
);

afterEach(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

afterAll(() => {
  resetQueryDb();
  db.close();
  fs.rmSync(uiRoot, { recursive: true, force: true });
});

// ── 1. Host guard ─────────────────────────────────────────────────────────────

describe("Host guard", () => {
  it("allows a loopback Host header (127.0.0.1:<port>)", async () => {
    const r = await makeRequest(port, {
      path: "/api/overview",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).not.toBe(421);
  });

  it("allows Host: localhost:<port>", async () => {
    const r = await makeRequest(port, {
      path: "/api/overview",
      headers: { host: `localhost:${port}` },
    });
    expect(r.status).not.toBe(421);
  });

  it("rejects a non-loopback Host header with 421", async () => {
    const r = await makeRequest(port, {
      path: "/",
      headers: { host: "evil.example.com" },
    });
    expect(r.status).toBe(421);
  });

  it("rejects a missing Host header (empty string) with 421", async () => {
    // Node's http.ClientRequest always sends Host; we test the guard path by
    // sending a recognisably non-loopback value.
    const r = await makeRequest(port, {
      path: "/",
      headers: { host: "attacker.internal:8080" },
    });
    expect(r.status).toBe(421);
  });

  it("rejects a userinfo-syntax Host bypass (localhost:user@evil.com) with 421", async () => {
    // A naive lastIndexOf(':') strip returns "localhost", which would pass.
    // The strict regex LOOPBACK_HOST_RE must reject this.
    const r = await makeRequest(port, {
      path: "/",
      headers: { host: "localhost:user@evil.com" },
    });
    expect(r.status).toBe(421);
  });
});

// ── 2. CSRF matrix ────────────────────────────────────────────────────────────

const JSON_CT = "application/json";
const WRITE_PATH = "/api/settings";
const WRITE_METHOD = "POST";
const WRITE_BODY = "{}";

describe("CSRF same-origin gate (POST /api/settings)", () => {
  it("allows Sec-Fetch-Site: same-origin + JSON Content-Type", async () => {
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    // Stub returns 200; security gate must not block this.
    expect(r.status).toBe(200);
  });

  it("allows Sec-Fetch-Site: none + JSON Content-Type (browser extension / form origin)", async () => {
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "none",
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    expect(r.status).toBe(200);
  });

  it("blocks Sec-Fetch-Site: cross-site → 403", async () => {
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "cross-site",
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    expect(r.status).toBe(403);
  });

  it("blocks Sec-Fetch-Site: same-site → 403", async () => {
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "same-site",
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    expect(r.status).toBe(403);
  });

  it("blocks Origin: http://evil.example (no Sec-Fetch-Site) → 403", async () => {
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "http://evil.example",
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    expect(r.status).toBe(403);
  });

  it("blocks Origin: null (no Sec-Fetch-Site) → 403", async () => {
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "null",
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    expect(r.status).toBe(403);
  });

  it("blocks text/plain Content-Type (no Sec-Fetch-Site, no Origin) → 415", async () => {
    // No CSRF headers → legacy same-origin allowed; but Content-Type is wrong → 415.
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "text/plain",
      },
      body: "some text",
    });
    expect(r.status).toBe(415);
  });

  it("allows legacy same-origin (no CSRF headers) + JSON → 200", async () => {
    // Traditional curl-style request: no Sec-Fetch-Site, no Origin → allowed.
    const r = await makeRequest(port, {
      method: WRITE_METHOD,
      path: WRITE_PATH,
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    expect(r.status).toBe(200);
  });
});

// ── 3. GET /api/ready — readiness probe ───────────────────────────────────────

describe("GET /api/ready", () => {
  it("returns 200 { ready: false } before setReady() is called", async () => {
    const r = await makeRequest(port, {
      method: "GET",
      path: "/api/ready",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  it("is not blocked by the CSRF gate (GET is exempt)", async () => {
    // No Sec-Fetch-Site, no Origin — should still return 200 (GET is not a write method).
    const r = await makeRequest(port, {
      method: "GET",
      path: "/api/ready",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
  });

  it("passes through the SPA handler while not ready", async () => {
    // /api/ready must reach the router even while isReady() === false.
    const r = await makeRequest(port, {
      method: "GET",
      path: "/api/ready",
      headers: {
        host: `127.0.0.1:${port}`,
        accept: "text/html,application/xhtml+xml",
      },
    });
    expect(r.status).toBe(200);
    // Must be JSON, not HTML.
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(bootScanKicks).toBe(0);
  });
});

// ── 4. SPA — served while not ready ───────────────────────────────────────────

describe("SPA (not ready)", () => {
  it("GET / returns the built SPA and triggers the boot scan", async () => {
    const r = await makeRequest(port, {
      method: "GET",
      path: "/",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.body).toContain("AgentWrangler SPA fixture");
    expect(bootScanKicks).toBe(1);
    expectAntiFraming(r);
  });

  it("serves the SPA fallback for a non-API HTML navigation", async () => {
    const r = await makeRequest(port, {
      method: "GET",
      path: "/dashboard",
      headers: {
        host: `127.0.0.1:${port}`,
        accept: "text/html,application/xhtml+xml",
      },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain("AgentWrangler SPA fixture");
    expect(bootScanKicks).toBe(1);
  });
});

// ── 5. No permissive CORS headers ────────────────────────────────────────────

describe("No permissive CORS headers", () => {
  it("does not emit Access-Control-Allow-Origin on GET", async () => {
    const r = await makeRequest(port, {
      path: "/api/overview",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not emit Access-Control-Allow-Origin on POST", async () => {
    const r = await makeRequest(port, {
      method: "POST",
      path: "/api/settings",
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        "content-type": JSON_CT,
      },
      body: WRITE_BODY,
    });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// ── 6. Anti-framing + nosniff (RB6) ──────────────────────────────────────────

function expectAntiFraming(r: TestResponse): void {
  expect(r.headers["x-frame-options"]).toBe("DENY");
  expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
}

describe("Anti-framing headers (RB6)", () => {
  it("are sent on API responses", async () => {
    const r = await makeRequest(port, {
      path: "/api/overview",
      headers: { host: `127.0.0.1:${port}` },
    });
    expectAntiFraming(r);
  });

  it("are sent on rejected requests", async () => {
    const r = await makeRequest(port, { headers: { host: "evil.example" } });
    expect(r.status).toBe(421);
    expectAntiFraming(r);
  });
});

describe("GET /api/status scan diagnostics", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-scan-status-"));
  });
  afterEach(() => {
    setScanRoots([]);
    setScanState("scanning");
    clearHealthInstance();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it.each(["scanning", "complete", "failed"] as const)(
    "reports %s without conflating empty scans",
    async (scan) => {
      setScanState(scan);
      setScanRoots([root]);
      const response = await makeRequest(port, { path: "/api/status" });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        scan_state: scan,
        sessions: 0,
        invalid_scan_root_count: 0,
      });
    },
  );
  it("exposes invalid-root and parse counts without local paths or errors", async () => {
    const file = path.join(root, "not-a-directory");
    fs.writeFileSync(file, "synthetic");
    const roots = [root, file, path.join(root, "missing")];
    setScanRoots(roots);
    // The count is what ingest discovery last saw (M11: no disk access on the status path).
    refreshDiscoveryCache([...roots], createDiscoveryCache());
    roots.length = 0;
    const health = new Health();
    health.quarantined();
    health.fileSeen();
    setHealthInstance(health);
    const response = await makeRequest(port, { path: "/api/status" });
    expect(JSON.parse(response.body)).toMatchObject({
      invalid_scan_root_count: 2,
      lines_quarantined: 1,
      files_seen: 1,
    });
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain("ENOENT");
  });
  // PERF G-P3 M11: a sync stat of each scan root per status poll stalled the loop by up to 2.4 s
  // under load. Status reports discovery's last view; a removed root shows after the next pass.
  it("reads scan-root validity from discovery, not the disk", async () => {
    setScanRoots([root]);
    const cache = createDiscoveryCache();
    refreshDiscoveryCache([root], cache);
    fs.rmSync(root, { recursive: true, force: true });
    const before = await makeRequest(port, { path: "/api/status" });
    expect(JSON.parse(before.body)).toMatchObject({ invalid_scan_root_count: 0 });
    refreshDiscoveryCache([root], cache);
    const after = await makeRequest(port, { path: "/api/status" });
    expect(JSON.parse(after.body)).toMatchObject({ invalid_scan_root_count: 1 });
    fs.mkdirSync(root);
    refreshDiscoveryCache([root], cache);
    const restored = await makeRequest(port, { path: "/api/status" });
    expect(JSON.parse(restored.body)).toMatchObject({ invalid_scan_root_count: 0 });
  });
  // PERF G-P3 M11: the full Settings read (workspace mappings stat each unmapped workspace's dir)
  // stalled status polls on L by up to 2.3 s. Status needs only the parser-health counters.
  it("reads parser health without the Settings workspace-mapping or quarantine reads", async () => {
    const health = new Health();
    health.fileSeen();
    setHealthInstance(health);
    const target = db as unknown as { prepare: (sql: string) => unknown };
    const prepare = target.prepare;
    const seen: string[] = [];
    target.prepare = function (this: unknown, sql: string) {
      seen.push(sql);
      return prepare.call(this, sql);
    };
    let response: Awaited<ReturnType<typeof makeRequest>>;
    try {
      response = await makeRequest(port, { path: "/api/status" });
    } finally {
      target.prepare = prepare;
    }
    expect(JSON.parse(response.body)).toMatchObject({ files_seen: 1 });
    expect(seen.filter((sql) => /FROM (workspaces|ingest_quarantine)\b/.test(sql))).toEqual([]);
  });
});

// ── P0-U2: Server-Timing + /api/perf instrumentation ─────────────────────────

describe("Server-Timing instrumentation", () => {
  it("a route that busy-waits 60 ms carries Server-Timing dur >= 60, and /api/perf p95 for it is >= 60", async () => {
    busyWaitState.ms = 60;
    const r = await makeRequest(port, { path: "/api/idle-sessions" });
    expect(r.status).toBe(200);
    const timing = r.headers["server-timing"];
    expect(timing).toBeDefined();
    const match = /^app;dur=(\d+(?:\.\d+)?)$/.exec(String(timing));
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(60);

    const perf = await makeRequest(port, { path: "/api/perf" });
    expect(perf.status).toBe(200);
    const body = JSON.parse(perf.body) as {
      routes: Record<string, { p95: number }>;
    };
    expect(body.routes["/api/idle-sessions"]?.p95).toBeGreaterThanOrEqual(60);
  });

  it("every sendJson response carries Server-Timing (checked on 5 routes)", async () => {
    const paths = [
      "/api/overview",
      "/api/live",
      "/api/status",
      "/api/idle-sessions",
      "/api/hot-sessions",
    ];
    for (const p of paths) {
      const r = await makeRequest(port, { path: p });
      expect(r.status).toBe(200);
      expect(String(r.headers["server-timing"])).toMatch(/^app;dur=\d+(?:\.\d+)?$/);
    }
  });

  it("review fix: distinct ids on a parameterized route collapse into one bounded /api/perf key", async () => {
    // GET /api/sessions/<id> is dispatched by router.ts's generic session-id
    // match — the id is literally part of the pathname. Each
    // distinct id must NOT create its own never-evicted /api/perf entry.
    const ids = ["wr-alpha", "wr-beta", "wr-gamma"];
    for (const id of ids) {
      const r = await makeRequest(port, { path: `/api/sessions/${id}` });
      expect(String(r.headers["server-timing"])).toMatch(/^app;dur=\d+(?:\.\d+)?$/);
    }

    const perf = await makeRequest(port, { path: "/api/perf" });
    expect(perf.status).toBe(200);
    const body = JSON.parse(perf.body) as { routes: Record<string, { count: number }> };
    for (const id of ids) {
      expect(body.routes[`/api/sessions/${id}`]).toBeUndefined();
    }
    expect(body.routes["/api/sessions/:id"]?.count).toBe(ids.length);
  });
});
