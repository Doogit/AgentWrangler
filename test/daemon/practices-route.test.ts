/**
 * test/daemon/practices-route.test.ts — GET /api/practices (BM1).
 *
 * Exercises the route end-to-end over the seeded fixture DB: it serves the 8
 * cited practice statuses and a window, computed on request.
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

describe("GET /api/practices", () => {
  it("serves 8 cited practices and a window", async () => {
    const res = await request(port, "/api/practices?preset=7d");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      practices: Array<{
        practice_id: string;
        source_url: string;
        source_date: string;
        status: string;
      }>;
      window: { from: string; to: string };
    };
    expect(body.practices).toHaveLength(8);
    expect(body.practices.map((p) => p.practice_id)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
    ]);
    for (const p of body.practices) {
      expect(p.source_url).toMatch(/^https?:\/\//);
      expect(p.source_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["PASS", "ATTENTION", "NO_DATA"]).toContain(p.status);
    }
    expect(typeof body.window.from).toBe("string");
    expect(typeof body.window.to).toBe("string");
  });
});
