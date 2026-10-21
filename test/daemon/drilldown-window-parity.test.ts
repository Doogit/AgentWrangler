/**
 * test/daemon/drilldown-window-parity.test.ts — P1-U6a test 4 (server half).
 *
 * WorkspaceDetailPage now fires sessions, cost-per-success and delivery with the same `preset`
 * as `/api/workspaces` instead of waiting for its `meta.window`. Each route resolves the preset
 * itself, so at a fixed clock the window each detail route reports must equal the list route's
 * `meta.window` (the oracle: the list route's existing field), for every preset the page sends,
 * at a mid-day time and on a UTC day boundary.
 *
 * Synthetic fixture data only (SEC-101).
 */

import type * as http from "node:http";
import * as nodeHttp from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import type { Db } from "../../src/db/open.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function get(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    nodeHttp
      .get({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
          }),
        );
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

type Windowed = { meta: { window: { from: string; to: string } } };

let db: Database.Database;
let server: http.Server;
let port: number;
let workspaceId: string;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  setQueryDb(db as unknown as Db);
  server = createServer(db as unknown as Db, 0, null);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  workspaceId = (
    db.prepare("SELECT workspace_id FROM workspaces ORDER BY workspace_id LIMIT 1").get() as {
      workspace_id: string;
    }
  ).workspace_id;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  resetQueryDb();
  db.close();
});

describe("drilldown window parity (P1-U6a test 4, server)", () => {
  // What WorkspaceDetailPage sends per scope (workspace-scope.ts scopeFilter).
  const scopes = ["preset=24h", "preset=7d", "preset=30d", "from=1970-01-01T00:00:00.000Z"];
  for (const now of ["2026-09-15T13:37:21.123Z", "2026-09-16T00:00:00.000Z"]) {
    for (const scope of scopes) {
      it(`${scope} at ${now}: every detail route's window equals /api/workspaces meta.window`, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(now));
        const id = encodeURIComponent(workspaceId);
        const list = (await get(port, `/api/workspaces?${scope}`)).body as Windowed;
        for (const route of [
          `/api/workspaces/${id}/sessions?${scope}`,
          `/api/workspaces/${id}/cost-per-success?${scope}`,
          `/api/workspaces/${id}/delivery?${scope}`,
        ]) {
          const reply = await get(port, route);
          expect(reply.status, route).toBe(200);
          const w = (reply.body as Windowed).meta.window;
          expect({ from: w.from, to: w.to }, route).toEqual({
            from: list.meta.window.from,
            to: list.meta.window.to,
          });
        }
      });
    }
  }
});
