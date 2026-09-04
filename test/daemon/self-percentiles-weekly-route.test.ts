/**
 * test/daemon/self-percentiles-weekly-route.test.ts — GET /api/self-percentiles/weekly (BM3).
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

describe("GET /api/self-percentiles/weekly", () => {
  it("serves the plain per-week self-percentile shape (no envelope)", async () => {
    const res = await request(port, "/api/self-percentiles/weekly");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      week_start: string;
      trailing_weeks: number;
      min_weeks_with_data: number;
      spend: { this_week: number | null; percentile: number | null; n: number };
      cache_write_share: { this_week: number | null; percentile: number | null; n: number };
    };
    expect(body.trailing_weeks).toBe(8);
    expect(body.min_weeks_with_data).toBe(4);
    expect(typeof body.week_start).toBe("string");
    // Plain observed numbers — no response envelope.
    expect(res.body).not.toContain("claim_kind");
    // INT-5: no dollar-headline copy.
    expect(res.body.toLowerCase()).not.toContain("wasted");
    // Fixture has only 2026-01 data → no trailing weeks vs "now" → percentile withheld.
    expect(body.spend.percentile).toBeNull();
  });
});
