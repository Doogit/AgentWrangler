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
import { getRecommendationCard } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
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
beforeAll(async () => {
  db = createInMemoryFixtureDb();
  // null uiRoot (no-UI test mode, like the other route tests): a real path makes
  // sirv crawl the whole tree at construction — "." from the repo root can
  // exceed the 10 s hook timeout as .worktrees/ grows.
  server = createServer(db, 0, null);
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
  db.prepare("DELETE FROM recommendation_lifecycle_actions WHERE rec_id=?").run(REC_ID);
  db.prepare("DELETE FROM effect_cycles WHERE rec_id=?").run(REC_ID);
  db.prepare("DELETE FROM recommendations WHERE rec_id=?").run(REC_ID);
  seedValidatedRecommendation(db, {
    recId: REC_ID,
    templateId: "D2_LONG_FULL_CONTEXT",
    scope: null,
  });
});

afterEach(() => {
  resetQueryDb();
});

describe("POST recommendation lifecycle decisions", () => {
  it("rejects a forged origin and invalid states, then persists an Undo adopt replay", async () => {
    const body = JSON.stringify({ rec_id: REC_ID, idempotency_key: "route-undo" });
    const forged = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/undo-adopt",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body,
    });
    expect(forged.status).toBe(403);
    const headers = { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
    expect(
      (
        await makeRequest(port, {
          method: "POST",
          path: "/api/recommendations/undo-adopt",
          headers,
          body,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await makeRequest(port, {
          method: "POST",
          path: "/api/recommendations/reopen",
          headers,
          body: JSON.stringify({ rec_id: REC_ID, idempotency_key: "route-reopen" }),
        })
      ).status,
    ).toBe(409);
    const adopted = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers,
      body: JSON.stringify({ rec_id: REC_ID, completed_change: true }),
    });
    expect(adopted.status).toBe(200);
    for (const replay of [false, true]) {
      const response = await makeRequest(port, {
        method: "POST",
        path: "/api/recommendations/undo-adopt",
        headers,
        body,
      });
      expect(response.status).toBe(200);
    }
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(REC_ID)).toEqual({
      state: "PROPOSED",
    });
  });
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
      body: JSON.stringify({ rec_id: REC_ID, completed_change: true }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { data: { ok: boolean }; meta: { claim_kind: string } };
    expect(body.data.ok).toBe(true);
    expect(body.meta.claim_kind).toBe("EXPERIMENTAL");
  });

  it("passes a selected option_id into the effect cycle", async () => {
    // D2 offers one change; the always-loaded-file card still offers alternatives.
    db.prepare("DELETE FROM recommendations WHERE rec_id=?").run(REC_ID);
    seedValidatedRecommendation(db, { recId: REC_ID });
    const alternative = getRecommendationCard(REC_ID, true)?.actions?.alternatives[0];
    if (!alternative) throw new Error("no alternative action");
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({
        rec_id: REC_ID,
        completed_change: true,
        option_id: alternative.option_id,
      }),
    });
    expect(res.status).toBe(200);
    expect(
      db.prepare("SELECT action_revision FROM effect_cycles WHERE rec_id=?").get(REC_ID),
    ).toEqual({
      action_revision: alternative.option_id,
    });
  });

  it("adopts a rec with no effect handler (200, effect not measured) and undoes it", async () => {
    db.prepare("DELETE FROM recommendations WHERE rec_id=?").run(REC_ID);
    seedValidatedRecommendation(db, { recId: REC_ID, templateId: "D6_TOOL_RESULT_BLOAT" });
    const headers = { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers,
      body: JSON.stringify({ rec_id: REC_ID, completed_change: true }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({ ok: true, effect_measured: false });
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(REC_ID)).toEqual({
      state: "ADOPTED",
    });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id=?").all(REC_ID)).toEqual([]);
    const undo = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/undo-adopt",
      headers,
      body: JSON.stringify({ rec_id: REC_ID, idempotency_key: "route-undo-untracked" }),
    });
    expect(undo.status).toBe(200);
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(REC_ID)).toEqual({
      state: "PROPOSED",
    });
  });

  it("rejects an invalid option_id before writing", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: REC_ID, completed_change: true, option_id: "unknown" }),
    });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(REC_ID)).toEqual({
      state: "PROPOSED",
    });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id=?").all(REC_ID)).toEqual([]);
  });

  it.each([123, ""])("rejects non-string or empty option_id (%s)", async (option_id) => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ rec_id: REC_ID, completed_change: true, option_id }),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "option_id must be a non-empty string" });
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(REC_ID)).toEqual({
      state: "PROPOSED",
    });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id=?").all(REC_ID)).toEqual([]);
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
