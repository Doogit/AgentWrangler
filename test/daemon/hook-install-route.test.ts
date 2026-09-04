import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { install, uninstall } = vi.hoisted(() => ({
  install: vi.fn(() => ({
    changed: true,
    settingsPath: "C:\\Users\\test\\.claude\\settings.json",
  })),
  uninstall: vi.fn(() => ({
    changed: true,
    settingsPath: "C:\\Users\\test\\.claude\\settings.json",
  })),
}));
vi.mock("../../src/hook/install.js", () => ({ installHook: install, uninstallHook: uninstall }));

import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

function request(
  port: number,
  pathname: "/api/hook/install" | "/api/hook/uninstall",
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          ...(token === undefined ? {} : { "X-AgentWrangler-Token": token }),
        },
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
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  server = createServer(db, 0, null, "test-session-token");
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
beforeEach(() => {
  setQueryDb(db);
  install.mockClear();
});
afterEach(() => resetQueryDb());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("hook installer route", () => {
  it("requires the daemon session token before changing local settings", async () => {
    expect((await request(port, "/api/hook/install")).status).toBe(401);
    expect(install).not.toHaveBeenCalled();

    const allowed = await request(port, "/api/hook/install", "test-session-token");
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({ changed: true });
    expect(install).toHaveBeenCalledTimes(1);

    expect((await request(port, "/api/hook/uninstall")).status).toBe(401);
    expect(uninstall).not.toHaveBeenCalled();

    expect((await request(port, "/api/hook/uninstall", "test-session-token")).status).toBe(200);
    expect(uninstall).toHaveBeenCalledTimes(1);
  });
});
