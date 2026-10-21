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
  it("serves addressable spend bounded by actual spend", async () => {
    const res = await request(port, "/api/efficiency-headroom?preset=7d");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      data: {
        headroom_u_per_wk: number;
        actual_u_per_wk: number;
        headroom_pct: number | null;
        unclaimed_rec_count: number;
      };
      meta: {
        claim_kind: string;
        metric_definition_version: string;
        qualification: { note: string };
      };
    };
    expect(typeof body.data.headroom_u_per_wk).toBe("number");
    expect(typeof body.data.actual_u_per_wk).toBe("number");
    expect(typeof body.data.unclaimed_rec_count).toBe("number");
    expect(body.data.headroom_u_per_wk).toBeLessThanOrEqual(body.data.actual_u_per_wk);
    // P3.L L6: the ledger already prices net of overlaps (each token counted once), so
    // headroom/actual is a safe combined percentage — null only when actual spend is 0.
    expect(body.data.headroom_pct === null || typeof body.data.headroom_pct === "number").toBe(
      true,
    );
    expect(body.meta.metric_definition_version).toBe("esf-1");
    expect(body.meta.claim_kind).toBe("EXPERIMENTAL");
    expect(body.meta.qualification.note).toMatch(/Addressable spend: the whole spend lane/);
    // INT-5: no "$X wasted" headline copy.
    expect(res.body.toLowerCase()).not.toContain("wasted");
  });

  it("reuses the result until a rec write; then serves it once more while it rebuilds", async () => {
    const windowTo = async (): Promise<string> =>
      (
        JSON.parse((await request(port, "/api/efficiency-headroom")).body) as {
          data: { to: string };
        }
      ).data.to;
    const first = await windowTo();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await windowTo()).toBe(first);

    // P1-U6a: an ingest write to workspaces no longer forces a rebuild.
    db.prepare(
      "UPDATE workspaces SET registered_at = '2099-01-01T00:00:00.000Z' WHERE rowid = (SELECT MIN(rowid) FROM workspaces)",
    ).run();
    expect(await windowTo()).toBe(first);

    // A rec write does: the next GET is served the older body, the rebuild runs after it.
    const write = await new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify({ scope_key: "GLOBAL", goal: "PRESERVE_QUALITY" });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/recommendations/goal",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": payload.length },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    expect(write).toBe(200);
    expect(await windowTo()).toBe(first);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await windowTo()).not.toBe(first);
  });
});
