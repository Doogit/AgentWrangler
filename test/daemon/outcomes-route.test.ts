/**
 * test/daemon/outcomes-route.test.ts — outcomes HTTP routes.
 *
 * Verifies:
 *   - GET /api/outcomes/success-rate → 200
 *   - GET /api/outcomes/workspaces → 200
 *   - GET /api/outcomes/linkage → 200
 *   - POST /api/outcomes/link with forged Origin → 403
 *   - POST /api/outcomes/link with malformed body → 400
 */

import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function makeRequest(
  port: number,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const { method = "GET", path = "/", headers = {}, body } = opts;
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers,
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;
let db: Database.Database;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  // The HTTP server uses a fixed no-UI root for tests
  server = createServer(db, 0, ".");
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

beforeEach(() => {
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/outcomes/success-rate", () => {
  it("returns 200 with EXPERIMENTAL claim_kind", async () => {
    const res = await makeRequest(port, { path: "/api/outcomes/success-rate" });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { meta: { claim_kind: string } };
    expect(body.meta.claim_kind).toBe("EXPERIMENTAL");
  });
});

describe("GET /api/outcomes/workspaces", () => {
  it("returns 200", async () => {
    const res = await makeRequest(port, { path: "/api/outcomes/workspaces" });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/outcomes/linkage", () => {
  it("returns 200", async () => {
    const res = await makeRequest(port, { path: "/api/outcomes/linkage" });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/workspaces/:id/context", () => {
  it("returns the two-row context-composition contract without assuming the current window", async () => {
    const res = await makeRequest(port, { path: "/api/workspaces/ws-alpha/context" });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      data: {
        workspace_id: string;
        observed_context_tokens: number | null;
        observed_turns: number;
        inventory_rows: number;
        rows: Array<{ key: string; label: string; tokens: number; share: number | null }>;
      };
    };
    expect(body.data.workspace_id).toBe("ws-alpha");
    expect(
      body.data.observed_context_tokens === null ||
        typeof body.data.observed_context_tokens === "number",
    ).toBe(true);
    expect(body.data.observed_turns).toEqual(expect.any(Number));
    expect(body.data.inventory_rows).toEqual(expect.any(Number));
    expect(body.data.rows).toEqual([
      expect.objectContaining({
        key: "always_loaded",
        label: "always loaded",
        tokens: expect.any(Number),
      }),
      expect.objectContaining({
        key: "session_residual",
        label: "session history + tool outputs (not itemized in v1)",
        tokens: expect.any(Number),
      }),
    ]);
    expect(body.data.rows.every((row) => row.share === null || typeof row.share === "number")).toBe(
      true,
    );
  });
});

describe("session-detail routes", () => {
  it("returns detail plus oldest-first paginated turns and stable not-found envelopes", async () => {
    const [detail, turns] = await Promise.all([
      makeRequest(port, { path: "/api/sessions/sess-a1" }),
      makeRequest(port, { path: "/api/sessions/sess-a1/turns?limit=2" }),
    ]);
    expect(detail.status).toBe(200);
    expect(turns.status).toBe(200);
    const detailBody = JSON.parse(detail.body) as {
      data: { session_id: string; workspace_id: string };
    };
    expect(detailBody.data).toMatchObject({ session_id: "sess-a1", workspace_id: "ws-alpha" });

    const firstPage = JSON.parse(turns.body) as {
      data: { items: Array<{ message_id: string; ts: string }>; next_cursor: string | null };
    };
    expect(firstPage.data.items.map((turn) => turn.message_id)).toEqual(["msg-a1-1", "msg-a1-2"]);
    expect(firstPage.data.items.map((turn) => turn.ts)).toEqual(
      [...firstPage.data.items.map((turn) => turn.ts)].sort(),
    );
    expect(firstPage.data.next_cursor).toEqual(expect.any(String));

    const secondPage = await makeRequest(port, {
      path: `/api/sessions/sess-a1/turns?limit=2&after=${encodeURIComponent(firstPage.data.next_cursor ?? "")}`,
    });
    expect(secondPage.status).toBe(200);
    expect(JSON.parse(secondPage.body).data).toMatchObject({
      items: [expect.objectContaining({ message_id: "msg-a1-3" })],
      next_cursor: null,
    });

    const [missingDetail, missingTurns] = await Promise.all([
      makeRequest(port, { path: "/api/sessions/missing" }),
      makeRequest(port, { path: "/api/sessions/missing/turns?limit=2" }),
    ]);
    expect(JSON.parse(missingDetail.body)).toMatchObject({
      data: null,
      meta: { n: 0, claim_kind: "N_A", drilldown_ids: { session_id: "missing" } },
    });
    expect(JSON.parse(missingTurns.body)).toMatchObject({
      data: { items: [], next_cursor: null },
      meta: { n: 0, drilldown_ids: { session_id: "missing" } },
    });
  });
});

describe("POST /api/outcomes/link — CSRF gate", () => {
  it("forged Origin → 403", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/outcomes/link",
      headers: {
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: "sess-a1", work_item_id: "gh:x/y#1" }),
    });
    expect(res.status).toBe(403);
  });

  it("malformed body → 400", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/outcomes/link",
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/outcomes/unlink — CSRF gate", () => {
  it("forged Origin → 403", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/outcomes/unlink",
      headers: {
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: "sess-a1", work_item_id: "gh:x/y#1" }),
    });
    expect(res.status).toBe(403);
  });
});
