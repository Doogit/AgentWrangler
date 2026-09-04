/**
 * test/daemon/efficiency-headroom-route.test.ts — GET /api/efficiency-headroom (BM2).
 */

import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
beforeEach(() => setQueryDb(db));
afterEach(() => resetQueryDb());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("GET /api/efficiency-headroom", () => {
  it("serves the modeled-headroom envelope with a caveat note", async () => {
    const res = await request(port, "/api/efficiency-headroom?preset=7d");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { headroom_u_per_wk: number; actual_u_per_wk: number; headroom_pct: number | null };
      meta: { claim_kind: string; qualification: { note: string } };
    };
    expect(typeof body.data.headroom_u_per_wk).toBe("number");
    expect(typeof body.data.actual_u_per_wk).toBe("number");
    // pct is a number or null — never NaN/∞.
    if (body.data.headroom_pct !== null) {
      expect(Number.isFinite(body.data.headroom_pct)).toBe(true);
    }
    expect(body.meta.claim_kind).toBe("EXPERIMENTAL");
    expect(body.meta.qualification.note).toMatch(/modeled headroom/i);
    // INT-5: no "$X wasted" headline copy.
    expect(res.body.toLowerCase()).not.toContain("wasted");
  });
});
