/**
 * test/daemon/token-gate.test.ts — CSRF session-token gate (DECISION D from T3 track).
 *
 * Covers:
 *   - GET /api/token returns { token } as JSON
 *   - POST /api/recommendations/adopt without X-AgentWrangler-Token → 401
 *   - POST /api/recommendations/adopt with correct token → 200 (or 400 if rec not found)
 *   - POST /api/recommendations/dismiss without token → 401
 *   - POST /api/recommendations/dismiss with correct token → 200 (or 400 if rec not found)
 *   - Wrong token → 401
 *
 * The server is created WITH an explicit session token to activate the gate.
 * The existing csrfCheck (Sec-Fetch-Site) remains in place as defense-in-depth.
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
// Setup — server started WITH an explicit token so the gate is active
// ---------------------------------------------------------------------------

const FIXED_TOKEN = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";

const REC_ID = "rec-token-gate-01";
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

let server: http.Server;
let port: number;
let db: Database.Database;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  // Pass FIXED_TOKEN to activate the session-token gate.
  server = createServer(db, 0, null, FIXED_TOKEN);
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
  // W4: adopted recs now carry a child recommendation_effects row (FK to
  // recommendations) — clear it before deleting the parent row.
  db.prepare("DELETE FROM recommendation_effects WHERE rec_id=?").run(REC_ID);
  db.prepare("DELETE FROM effect_cycles WHERE rec_id=?").run(REC_ID);
  db.prepare("DELETE FROM recommendations WHERE rec_id=?").run(REC_ID);
  db.prepare(PROPOSED_REC_SQL).run(REC_ID);
});

afterEach(() => {
  resetQueryDb();
});

// ---------------------------------------------------------------------------
// GET /api/token
// ---------------------------------------------------------------------------

describe("GET /api/token", () => {
  it("returns 200 with { token } as JSON", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/token",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { token?: string };
    expect(typeof body.token).toBe("string");
    expect(body.token).toBe(FIXED_TOKEN);
  });

  it("does not require any authentication header", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/token",
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/adopt — token gate
// ---------------------------------------------------------------------------

describe("POST /api/recommendations/adopt — token gate", () => {
  it("no X-AgentWrangler-Token → 401", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("wrong X-AgentWrangler-Token → 401", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": "totally-wrong-token",
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("same-length wrong X-AgentWrangler-Token (36 chars, wrong bytes) → 401 (exercises timingSafeEqual)", async () => {
    // This token is the same CHARACTER length as FIXED_TOKEN (36) but has different bytes,
    // so it exercises the constant-time compare branch rather than short-circuiting on length.
    const sameLengthWrongToken = "aaaabbbb-cccc-dddd-eeee-000000000000";
    expect(sameLengthWrongToken.length).toBe(FIXED_TOKEN.length); // sanity-check
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": sameLengthWrongToken,
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("non-ASCII X-AgentWrangler-Token → 401 and no crash (guards F1 byte-length bug)", async () => {
    // 36-char string where the last char (é = U+00E9) encodes to 2 UTF-8 bytes.
    // Char-length: 36 (same as FIXED_TOKEN). UTF-8 byte-length: 37 (≠ 36).
    // Before the F1 fix, the char-length guard passed and timingSafeEqual received
    // unequal-length Buffers → ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH → daemon crash.
    // After the fix, byte-length mismatch is caught → clean 401, no throw.
    // "aaaabbbb-cccc-dddd-eeee-fffffffffff" (35 ASCII) + "é" = 36 chars, 37 bytes.
    const nonAscii36 = "aaaabbbb-cccc-dddd-eeee-fffffffffffé";
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": nonAscii36,
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    // Must return 401 (not crash the server, not 500)
    expect(res.status).toBe(401);
  });

  it("correct X-AgentWrangler-Token → 200 (reaches handler)", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/adopt",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": FIXED_TOKEN,
      },
      body: JSON.stringify({ rec_id: REC_ID, completed_change: true }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { data?: { ok: boolean } };
    expect(body.data?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/dismiss — token gate
// ---------------------------------------------------------------------------

describe("POST /api/recommendations/dismiss — token gate", () => {
  it("no X-AgentWrangler-Token → 401", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("wrong X-AgentWrangler-Token → 401", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": "totally-wrong-token",
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("correct X-AgentWrangler-Token → 200 (reaches handler)", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": FIXED_TOKEN,
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { data?: { ok: boolean } };
    expect(body.data?.ok).toBe(true);
  });

  it("csrfCheck still fires before token gate (forged Origin with correct token → 403)", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/dismiss",
      headers: {
        host: `127.0.0.1:${port}`,
        Origin: "http://evil.example",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": FIXED_TOKEN,
      },
      body: JSON.stringify({ rec_id: REC_ID }),
    });
    // CSRF gate fires before token gate → 403
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// W3-A dynamic apply routes — token gate
// ---------------------------------------------------------------------------

describe("W3-A apply routes — token gate", () => {
  it("POST /api/recommendations/:id/apply without token returns 401 before handler validation", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: `/api/recommendations/${REC_ID}/apply`,
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspace_cwd: "C:\\fake" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/recommendations/:id/open-terminal without token returns 401 before handler validation", async () => {
    // O11 Option B — the open-terminal route mutates (spawns a terminal), so it
    // is token-gated like /apply. Without the token the request is rejected
    // before any launcher runs.
    const res = await makeRequest(port, {
      method: "POST",
      path: `/api/recommendations/${REC_ID}/open-terminal`,
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "should never launch" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/recommendations/jobs/:id/confirm without token returns 401 before handler validation", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/jobs/job-token-test/confirm",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/recommendations/jobs/:id/rollback without token returns 401 before handler validation", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/recommendations/jobs/job-token-test/rollback",
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe("enabled ESF2 HTTP contract", () => {
  function post(action: string, body: unknown) {
    return makeRequest(port, {
      method: "POST",
      path: `/api/esf/effects/${action}`,
      headers: {
        host: `127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-AgentWrangler-Token": FIXED_TOKEN,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const request = () => ({ rec_id: REC_ID, idempotency_key: "http-track", completed_change: true });

  it("tracks once, returns server provenance, and replays the same cycle", async () => {
    const first = await post("track", request());
    expect(first.status).toBe(200);
    const tracked = JSON.parse(first.body);
    expect(tracked).toMatchObject({
      supported: true,
      replayed: false,
      cycle: { recId: REC_ID, applicationSource: "USER_ATTESTED" },
    });
    const replay = await post("track", request());
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({ replayed: true, cycle: tracked.cycle });
    expect(db.prepare("SELECT adopted_at FROM recommendations WHERE rec_id=?").get(REC_ID)).toEqual(
      { adopted_at: tracked.cycle.appliedAt },
    );
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id=?").all(REC_ID)).toHaveLength(1);
    expect(
      db.prepare("SELECT * FROM recommendation_effects WHERE rec_id=?").all(REC_ID),
    ).toHaveLength(0);
  });

  it.each([
    ["applied_at", "2020-01-01"],
    ["scope", { workspaceId: "forged" }],
    ["application_source", "MACHINE_CONFIRMED"],
    ["action_revision", "forged-job"],
  ])("rejects injected %s without writing", async (field, value) => {
    const response = await post("track", { ...request(), [field as string]: value });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Unknown request field." });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id=?").all(REC_ID)).toHaveLength(0);
  });

  it("requires completed-change attestation", async () => {
    const response = await post("track", { ...request(), completed_change: false });
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT state FROM recommendations WHERE rec_id=?").get(REC_ID)).toEqual({
      state: "PROPOSED",
    });
  });

  it("rejects malformed JSON and oversized bodies before writing", async () => {
    const malformed = await post("track", "{");
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: "Invalid JSON body." });
    const oversized = await post("track", { ...request(), padding: "x".repeat(4096) });
    expect(oversized.status).toBe(400);
    expect(JSON.parse(oversized.body)).toEqual({ error: "Request body is too large." });
    expect(db.prepare("SELECT * FROM effect_cycles WHERE rec_id=?").all(REC_ID)).toHaveLength(0);
  });

  it("returns 404 for missing cycles and 409 for an open-cycle close", async () => {
    const missing = await post("stop", { cycle_id: "missing", idempotency_key: "stop" });
    expect(missing.status).toBe(404);
    const tracked = JSON.parse((await post("track", request())).body);
    const conflict = await post("close", {
      cycle_id: tracked.cycle.cycleId,
      idempotency_key: "close",
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({
      error: "Effect request conflicts with the current cycle.",
    });
    const stopped = await post("stop", {
      cycle_id: tracked.cycle.cycleId,
      idempotency_key: "stop",
    });
    expect(stopped.status).toBe(200);
    expect(JSON.parse(stopped.body)).toMatchObject({ state: "STOPPED" });
  });

  it("returns validation errors for invalid history cursors and page sizes", async () => {
    for (const query of ["cycle_cursor=invalid", "legacy_cursor=invalid", "limit=101"]) {
      const response = await makeRequest(port, {
        path: `/api/esf/effects?${query}`,
        headers: { host: `127.0.0.1:${port}` },
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("POST /api/esf/effects token gate", () => {
  for (const action of ["track", "stop", "close", "rollback", "attest-rollback"]) {
    it(`${action} requires the daemon session token`, async () => {
      const res = await makeRequest(port, {
        method: "POST",
        path: `/api/esf/effects/${action}`,
        headers: {
          host: `127.0.0.1:${port}`,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });
  }
});
