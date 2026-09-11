/**
 * test/daemon/workspace-names-route.test.ts — GET /api/workspace-names (UIR-8).
 *
 * Verifies the route returns a bare unwindowed array (no ApiResponse envelope)
 * of identity rows for every registered workspace.
 */

import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

let server: http.Server;
let port: number;
let db: Database.Database;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  // null uiRoot (no-UI test mode): a real path makes sirv crawl the tree.
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  resetQueryDb();
  db.close();
});

describe("GET /api/workspace-names", () => {
  it("returns a bare array of identity rows for all registered workspaces", async () => {
    const res = await get(port, "/api/workspace-names");
    expect(res.status).toBe(200);

    const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true); // bare array, no { data, meta } envelope
    expect(rows.map((r) => r.workspace_id)).toEqual(["ws-alpha", "ws-beta"]);
    expect(rows[0]).toEqual({
      workspace_id: "ws-alpha",
      project_slug: "project-alpha",
      repo_path: null,
      repo_owner: null,
      repo_name: null,
    });
  });
});
