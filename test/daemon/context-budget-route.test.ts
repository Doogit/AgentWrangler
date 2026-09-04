import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function request(
  port: number,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined
            ? {}
            : { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
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

describe("context budget and hook config routes", () => {
  it("serves the fail-open budget endpoint", async () => {
    const res = await request(port, "/api/context-budget?session_id=missing");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      data: { stage: "ok", reason: "unknown_session" },
    });
  });

  it("gets and updates hook config", async () => {
    expect((await request(port, "/api/hook-config")).status).toBe(200);
    const res = await request(port, "/api/hook-config", JSON.stringify({ stale_s: 60 }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ data: { stale_s: 60 } });
  });

  it("returns 400 for malformed hook-config input", async () => {
    const res = await request(port, "/api/hook-config", "not-json");
    expect(res.status).toBe(400);
  });
});
