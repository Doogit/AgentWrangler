/**
 * test/daemon/integration.test.ts — Integration tests.
 *
 * Proves the setQueryDb-bound router returns real fixture rows AND
 * the CSRF gate rejects forged cross-origin writes.
 *
 * Fixture aggregates (from test/fixtures/seed.ts):
 *   global reconciled cost_equiv_u = 99_125 μUSD across 9 turns
 *   2 workspaces: ws-alpha (project-alpha), ws-beta (project-beta)
 *   1 LIVE session: sess-b2 (ws-beta) — provisional, excluded from reconciled totals
 */

import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import {
  clearRuntimeResetHook,
  resetDatabase,
  setRuntimeResetHook,
} from "../../src/query/settings-store.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

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

// Wide date range covering the fixture data (all at 2026-01-01)
const WIDE_WINDOW = "from=2025-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z";

// ── Read paths + CSRF ─────────────────────────────────────────────────────────

describe("read paths + CSRF", () => {
  let server: http.Server;
  let port: number;

  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        const db = createInMemoryFixtureDb();
        setQueryDb(db);
        server = createServer(db, 0, null);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          port = addr.port;
          resolve();
        });
        server.on("error", reject);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resetQueryDb();
          resolve();
        });
      }),
  );

  // ── 1. GET /api/overview — seeded fixture data ──────────────────────────────

  it("GET /api/overview returns 200 with seeded fixture aggregates", async () => {
    const r = await makeRequest(port, {
      path: `/api/overview?${WIDE_WINDOW}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      data: { cost_equiv_u: number; turns: number; turns_total: number } | null;
      meta: { metric_definition_version: string };
    };
    expect(body.data).not.toBeNull();
    expect(body.meta.metric_definition_version).toBe("observe-1");
    // 9 reconciled turns (alpha 7 + beta 2; provisional sess-b2 excluded)
    expect(body.data?.turns).toBe(9);
    // Global reconciled cost: 99_125 μUSD
    expect(body.data?.cost_equiv_u).toBe(99_125);
  });

  // ── 2. GET /api/workspaces — two workspace rows ─────────────────────────────

  it("GET /api/workspaces returns 200 with ws-alpha and ws-beta", async () => {
    const r = await makeRequest(port, {
      path: `/api/workspaces?${WIDE_WINDOW}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      data: { items: Array<{ workspace_id: string }> } | null;
    };
    expect(body.data).not.toBeNull();
    const ids = body.data?.items.map((w) => w.workspace_id) ?? [];
    expect(ids).toContain("ws-alpha");
    expect(ids).toContain("ws-beta");
    expect(ids.length).toBe(2);
  });

  // ── 3. Forged cross-origin POST /api/settings → 403 ────────────────────────

  it("POST /api/settings with sec-fetch-site: cross-site is rejected with 403", async () => {
    const r = await makeRequest(port, {
      method: "POST",
      path: "/api/settings",
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(r.status).toBe(403);
  });

  // ── 4. Forged cross-origin POST /api/reset → 403 ───────────────────────────

  it("POST /api/reset with sec-fetch-site: cross-site is rejected with 403", async () => {
    const r = await makeRequest(port, {
      method: "POST",
      path: "/api/reset",
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(r.status).toBe(403);
  });

  // ── 5. Same-origin POST /api/settings with invalid scan_roots → 400 ─────────

  it("same-origin POST /api/settings with a relative scan_roots path → 400 with error message", async () => {
    const r = await makeRequest(port, {
      method: "POST",
      path: "/api/settings",
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scan_roots: ["relative/not/absolute"] }),
    });
    expect(r.status).toBe(400);
    const body = JSON.parse(r.body) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  // ── 6. Preset e2e: fixture rows are at 2026-01-01, 7d window excludes them ──

  it("GET /api/overview?preset=7d excludes 2026-01-01 fixture rows (turns === 0)", async () => {
    const r = await makeRequest(port, {
      path: "/api/overview?preset=7d",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      data: { turns: number | null } | null;
    };
    // 7d window relative to current date excludes the 2026-01-01 fixture rows
    expect((body.data?.turns ?? 0) === 0).toBe(true);
  });

  // ── 7. Malformed date in query string → 200 (DoS fix: invalid `to` is dropped) ──

  it("GET /api/overview?to=not-a-date returns 200 (malformed date dropped)", async () => {
    const r = await makeRequest(port, {
      path: "/api/overview?to=not-a-date",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { data: unknown };
    expect(body.data).not.toBeUndefined();
  });

  // ── 8. Parsable-but-out-of-range date → 200 (overflow guard: extreme `to` is dropped) ──

  it("GET /api/overview?to=<JS_DATE_MIN> returns 200 (out-of-range date dropped, not 500)", async () => {
    const minIso = new Date(-8640000000000000).toISOString();
    const r = await makeRequest(port, {
      path: `/api/overview?to=${encodeURIComponent(minIso)}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { data: unknown };
    expect(body.data).not.toBeNull();
  });
});

// ── Destructive reset ─────────────────────────────────────────────────────────

describe("destructive reset", () => {
  let server: http.Server;
  let port: number;

  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        const db = createInMemoryFixtureDb();
        setQueryDb(db);
        server = createServer(db, 0, null);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          port = addr.port;
          resolve();
        });
        server.on("error", reject);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resetQueryDb();
          resolve();
        });
      }),
  );

  it("same-origin POST /api/reset → 200; subsequent GET /api/overview shows zeroed data", async () => {
    const resetR = await makeRequest(port, {
      method: "POST",
      path: "/api/reset",
      headers: {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: "",
    });
    expect(resetR.status).toBe(200);

    const r = await makeRequest(port, {
      path: `/api/overview?${WIDE_WINDOW}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      data: { cost_equiv_u: number | null; turns: number | null } | null;
    };
    // After wipe, aggregates are 0 or null (SQLite SUM of empty set returns NULL)
    expect(body.data?.cost_equiv_u ?? 0).toBe(0);
    expect(body.data?.turns ?? 0).toBe(0);
  });
});

// ── Reset-hook coordination (unit) ────────────────────────────────────────────

describe("reset-hook coordination", () => {
  afterAll(() => {
    clearRuntimeResetHook();
    resetQueryDb();
  });

  it("resetDatabase invokes the wired runtime-reset hook", () => {
    const db = createInMemoryFixtureDb();
    setQueryDb(db);

    let hookCalled = false;
    setRuntimeResetHook(() => {
      hookCalled = true;
    });

    resetDatabase(db);

    expect(hookCalled).toBe(true);

    clearRuntimeResetHook();
    resetQueryDb();
  });
});
