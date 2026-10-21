/**
 * test/daemon/token-enforcement.test.ts — P3-U8 (S-1): every state-changing route needs the token.
 *
 * The routes are enumerated from router.ts's source (every `method === "POST"|"PUT"|"PATCH"|"DELETE"`
 * guard), so a new mutating route is covered without editing this file. Each one must answer 401
 * without the token, before its handler runs. A write to a path no handler knows must too: the
 * gate is default-deny, not an allow-list.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const TOKEN = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
const ROUTER = path.resolve(__dirname, "../../src/daemon/router.ts");

/** Concrete paths for the routes router.ts matches by regex or variable, keyed by their source line. */
const DYNAMIC: Array<[RegExp, string[]]> = [
  [/effectAction/, ["/api/esf/effects/track"]],
  [/applyRecId/, ["/api/recommendations/rec-1/apply"]],
  [/openTerminalRecId/, ["/api/recommendations/rec-1/open-terminal"]],
  [/job\.action === "confirm"/, ["/api/recommendations/jobs/job-1/confirm"]],
  [/job\.action === "rollback"/, ["/api/recommendations/jobs/job-1/rollback"]],
  [/statuslineApply/, ["/api/statusline-limits/install"]],
];

/** Every [method, path] a write guard in router.ts can match. */
function enumerateWriteRoutes(): Array<[string, string]> {
  const src = fs.readFileSync(ROUTER, "utf8");
  const out: Array<[string, string]> = [];
  const guard = /method === "(POST|PUT|PATCH|DELETE)"([^{]*)/g;
  for (const m of src.matchAll(guard)) {
    const method = m[1] as string;
    const rest = m[2] as string;
    const literals = [...rest.matchAll(/pathname === "([^"]+)"/g)].map((x) => x[1] as string);
    if (literals.length > 0) {
      for (const p of literals) out.push([method, p]);
      continue;
    }
    const dyn = DYNAMIC.find(([re]) => re.test(rest));
    if (!dyn) throw new Error(`write guard with no known path: ${m[0].slice(0, 120)}`);
    for (const p of dyn[1]) out.push([method, p]);
  }
  return out;
}

function post(port: number, method: string, p: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };
    if (token !== undefined) headers["X-AgentWrangler-Token"] = token;
    // agent: false — a fresh socket per request; an early 401 can close a kept-alive one.
    const req = http.request(
      { hostname: "127.0.0.1", port, path: p, method, headers, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

let server: http.Server;
let port: number;
let db: Database.Database;

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  server = createServer(db, 0, null, TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("P3-U8 S-1: token on every state-changing route", () => {
  const routes = enumerateWriteRoutes();

  it("enumerates the router's write routes", () => {
    // Sanity floor: the router had 41 write guards when this test was written.
    expect(routes.length).toBeGreaterThanOrEqual(35);
  });

  it.each(routes)("%s %s without a token → 401", async (method, p) => {
    expect(await post(port, method, p)).toBe(401);
  });

  it.each(routes)("%s %s with a stale token → 401", async (method, p) => {
    expect(await post(port, method, p, "stale-token-from-an-old-daemon")).toBe(401);
  });

  it("a write to a path no handler knows → 401 (default-deny, not an allow-list)", async () => {
    expect(await post(port, "POST", "/api/some-future-route")).toBe(401);
  });
});
