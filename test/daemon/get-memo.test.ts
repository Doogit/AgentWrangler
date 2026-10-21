/**
 * test/daemon/get-memo.test.ts — P1-U0 `data_version` GET memo.
 *
 * A memo-safe `direct` GET body is reused while (path + query, data_version,
 * minute bucket) is unchanged. Handler calls are counted by wrapping the query
 * function the router calls; the oracle for a data change is a direct DB write.
 *
 * Synthetic fixture data only (SEC-101).
 */

import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpDataVersion, getDataVersion } from "../../src/daemon/data-version.js";
import { createServer } from "../../src/daemon/http.js";
import * as api from "../../src/query/api/index.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/query/api/index.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/query/api/index.js")>();
  return {
    ...m,
    listWorkspaceNames: vi.fn(m.listWorkspaceNames),
    getHookConfig: vi.fn(m.getHookConfig),
  };
});

const names = vi.mocked(api.listWorkspaceNames);
const hookConfig = vi.mocked(api.getHookConfig);

function request(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders =
      method === "GET"
        ? {}
        : { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

let server: http.Server;
let port: number;
let db: Database.Database;
const T0 = new Date("2026-09-30T12:00:05.000Z");

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  // Each test starts from a fresh version, so no memo entry carries over.
  bumpDataVersion();
  names.mockClear();
  hookConfig.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("P1-U0 GET memo", () => {
  it("1. two identical GETs at the same data_version and minute run the handler once", async () => {
    const a = await request(port, "/api/workspace-names");
    const b = await request(port, "/api/workspace-names");
    expect(a.status).toBe(200);
    expect(b.body).toBe(a.body);
    expect(names).toHaveBeenCalledTimes(1);
  });

  it("2. a bumped data_version re-runs the handler and the body reflects the DB write", async () => {
    const before = await request(port, "/api/workspace-names");
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
    ).run("ws-memo", "project-memo", T0.toISOString());
    try {
      bumpDataVersion();
      const after = await request(port, "/api/workspace-names");
      expect(names).toHaveBeenCalledTimes(2);
      const ids = (JSON.parse(after.body) as Array<{ workspace_id: string }>).map(
        (r) => r.workspace_id,
      );
      expect(ids).toContain("ws-memo");
      expect(after.body).not.toBe(before.body);
    } finally {
      db.prepare("DELETE FROM workspaces WHERE workspace_id = 'ws-memo'").run();
    }
  });

  it("3. crossing a minute boundary with no data change re-runs the handler", async () => {
    await request(port, "/api/workspace-names");
    vi.setSystemTime(new Date(T0.getTime() + 55_000)); // 12:01:00 — next bucket
    await request(port, "/api/workspace-names");
    expect(names).toHaveBeenCalledTimes(2);
  });

  it("4. AW_DISABLE_GET_MEMO=1 runs the handler on every call", async () => {
    vi.stubEnv("AW_DISABLE_GET_MEMO", "1");
    await request(port, "/api/workspace-names");
    await request(port, "/api/workspace-names");
    await request(port, "/api/workspace-names");
    expect(names).toHaveBeenCalledTimes(3);
  });

  it("keys on the full path + query: a different query string is a different entry", async () => {
    await request(port, "/api/workspace-names?a=1");
    await request(port, "/api/workspace-names?a=2");
    await request(port, "/api/workspace-names?a=1");
    expect(names).toHaveBeenCalledTimes(2);
  });

  it("never memoizes a route that reads the home dir (hook-config)", async () => {
    await request(port, "/api/hook-config");
    await request(port, "/api/hook-config");
    expect(hookConfig).toHaveBeenCalledTimes(2);
  });

  it("a non-GET API request bumps data_version, so the next GET recomputes", async () => {
    await request(port, "/api/workspace-names");
    const v = getDataVersion();
    await request(port, "/api/no-such-write", "POST");
    expect(getDataVersion()).toBeGreaterThan(v);
    await request(port, "/api/workspace-names");
    expect(names).toHaveBeenCalledTimes(2);
  });
});
