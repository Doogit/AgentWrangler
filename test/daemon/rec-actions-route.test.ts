/**
 * test/daemon/rec-actions-route.test.ts — HTTP routes for Adopt/Dismiss.
 *
 * Verifies:
 *   - POST /api/recommendations/dismiss → 200 with EXPERIMENTAL envelope on valid rec_id
 *   - POST /api/recommendations/adopt  → 200 with EXPERIMENTAL envelope on valid rec_id
 *   - Both routes: 400 on missing rec_id, 400 on non-existent rec_id
 *   - Both routes: 403 on forged Origin (CSRF gate)
 */

import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// ---------------------------------------------------------------------------
// Helpers (matches outcomes-route.test.ts pattern)
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

const REC_ID = "rec-route-test-01";
const PROPOSED_REC_SQL = `
  INSERT INTO recommendations
    (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
     modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
     target_metric, state, created_at, dismissed_until)
  VALUES
    (?, 'RULE', 'D2', 'CONTEXT', NULL, 'Test lever', 1000,
     '{"model":"X","inputs":{}}', '{"count":3}',
     'avg_context_per_turn', 'PROPOSED', datetime('now'), NULL)
`;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
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
  // Seed a fresh PROPOSED rec before each test (delete first so it's idempotent).
  // W4: adopted recs now carry a child recommendation_effects row (FK to
  // recommendations) — clear it before deleting the parent row.
  db.prepare("DELETE FROM recommendation_effects WHERE rec_id=?").run(REC_ID);
  db.prepare("DELETE FROM recommendations WHERE rec_id=?").run(REC_ID);
  db.prepare(PROPOSED_REC_SQL).run(REC_ID);
});

afterEach(() => {
  resetQueryDb();
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/dismiss
// ---------------------------------------------------------------------------

describe("POST /api/recommendations/dismiss", () => {
  it("returns 200 with EXPERIMENTAL claim_kind on valid rec_id", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { data: { ok: boolean }; meta: { claim_kind: string } };
    expect(body.data.ok).toBe(true);
    expect(body.meta.claim_kind).toBe("EXPERIMENTAL");
  });

  it("returns 400 when rec_id is missing", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when rec_id is non-existent or not PROPOSED", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: "rec-does-not-exist" }),
    });
    expect(res.status).toBe(400);
  });

  it("forged Origin → 403 (CSRF gate)", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/adopt
// ---------------------------------------------------------------------------

describe("POST /api/recommendations/adopt", () => {
  it("returns 200 with EXPERIMENTAL claim_kind on valid rec_id", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { data: { ok: boolean }; meta: { claim_kind: string } };
    expect(body.data.ok).toBe(true);
    expect(body.meta.claim_kind).toBe("EXPERIMENTAL");
  });

  it("returns 400 when rec_id is missing", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when rec_id is non-existent or not PROPOSED", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: "rec-does-not-exist" }),
    });
    expect(res.status).toBe(400);
  });

  it("forged Origin → 403 (CSRF gate)", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(403);
  });
});
