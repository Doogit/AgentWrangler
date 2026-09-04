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

import * as http from "node:http";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

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
});

beforeEach(
  () =>
    new Promise<void>((resolve, reject) => {
      server = createServer(db, 0, null); // port=0 → OS picks ephemeral port
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

  it("is not shadowed by the loading page (even though not ready)", async () => {
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
  });
});

// ── 4. Loading page — served while not ready ──────────────────────────────────

describe("Loading page (not ready)", () => {
  it("GET / returns the loading page HTML while not ready", async () => {
    const r = await makeRequest(port, {
      method: "GET",
      path: "/",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.body).toContain("Starting up");
    expect(r.body).toContain("/api/ready");
  });

  it("polls /api/status and renders live scan progress (NU2)", async () => {
    // The loading page must fetch /api/status and render "N of M files" so a
    // large first scan shows live progress instead of a bare spinner.
    const r = await makeRequest(port, {
      method: "GET",
      path: "/",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain("/api/status");
    expect(r.body).toContain("Scanning transcripts — ");
    expect(r.body).toContain("files_parsed");
    expect(r.body).toContain("files_seen");
    // Mirrors the Overview first-run counter wording: "N of M files".
    expect(r.body).toContain(" of ");
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
