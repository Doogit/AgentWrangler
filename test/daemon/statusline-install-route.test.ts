/**
 * OV-7b: statusline install/uninstall endpoints write the user's Claude Code config, so they get the
 * same guards as /api/hook/install: loopback Host, same-origin CSRF, JSON content-type, session token.
 * HOME is redirected to a temp dir — the real ~/.claude is never touched.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const homedir = () => home.dir;
  return { ...real, homedir, default: { ...real, homedir } };
});

import { createServer } from "../../src/daemon/http.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const TOKEN = "test-session-token";
const OLD = "bash ~/.claude/statusline-command.sh";

let db: Database.Database;
let server: http.Server;
let port: number;
let settings: string;

interface Reply {
  error: string;
  installed: boolean;
  changed: boolean;
  before: string;
  after: string;
}

function call(
  method: "GET" | "POST",
  pathname: string,
  o: { headers?: Record<string, string | null>; body?: unknown; token?: boolean } = {},
): Promise<{ status: number; json: () => Reply; text: string }> {
  const headers: Record<string, string | null> = {
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
    ...(o.token === false ? {} : { "X-AgentWrangler-Token": TOKEN }),
    ...o.headers,
  };
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: headers as Record<string, string>,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end(o.body === undefined ? undefined : JSON.stringify(o.body));
  });
}

beforeAll(async () => {
  db = createInMemoryFixtureDb();
  server = createServer(db, 0, null, TOKEN);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
beforeEach(() => {
  home.dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-sl-route-"));
  fs.mkdirSync(path.join(home.dir, ".claude"), { recursive: true });
  settings = path.join(home.dir, ".claude", "settings.json");
  setQueryDb(db);
});
afterEach(() => {
  resetQueryDb();
  fs.rmSync(home.dir, { recursive: true, force: true });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

const ORIGINAL = `{\n  "statusLine": {\n    "type": "command",\n    "command": "${OLD}"\n  }\n}\n`;

describe("statusline install routes: guards", () => {
  for (const p of ["/api/statusline-limits/install", "/api/statusline-limits/uninstall"]) {
    it(`${p}: cross-origin POST is rejected and settings.json is untouched`, async () => {
      fs.writeFileSync(settings, ORIGINAL);
      for (const headers of [
        { "Sec-Fetch-Site": "cross-site" },
        { "Sec-Fetch-Site": "same-site" },
        { "Sec-Fetch-Site": null, Origin: "https://evil.example" },
        { "Sec-Fetch-Site": null, Origin: "null" },
      ]) {
        const r = await call("POST", p, { headers, body: {} });
        expect(r.status).toBe(403);
      }
      expect(fs.readFileSync(settings, "utf8")).toBe(ORIGINAL);
    });

    it(`${p}: requires the session token`, async () => {
      fs.writeFileSync(settings, ORIGINAL);
      expect((await call("POST", p, { token: false, body: {} })).status).toBe(401);
      expect(
        (await call("POST", p, { headers: { "X-AgentWrangler-Token": "wrong" }, body: {} })).status,
      ).toBe(401);
      expect(fs.readFileSync(settings, "utf8")).toBe(ORIGINAL);
    });

    it(`${p}: rejects a non-loopback Host (DNS rebinding) and non-JSON content type`, async () => {
      expect((await call("POST", p, { headers: { Host: "evil.example" }, body: {} })).status).toBe(
        421,
      );
      expect(
        (await call("POST", p, { headers: { "Content-Type": "text/plain" }, body: {} })).status,
      ).toBe(415);
    });
  }
});

describe("statusline install routes: flow", () => {
  it("preview shows before/after; install writes; status reports installed; uninstall restores bytes", async () => {
    fs.writeFileSync(settings, ORIGINAL);

    const pv = await call("GET", "/api/statusline-limits/preview?action=install");
    expect(pv.status).toBe(200);
    const plan = pv.json();
    expect(plan.changed).toBe(true);
    expect(JSON.parse(plan.before).command).toBe(OLD);
    expect(JSON.parse(plan.after).command).toContain(`--wrap '${OLD}'`);
    expect(fs.readFileSync(settings, "utf8")).toBe(ORIGINAL);

    expect((await call("GET", "/api/statusline-limits/status")).json().installed).toBe(false);

    const inst = await call("POST", "/api/statusline-limits/install", {
      body: { expectBefore: plan.before },
    });
    expect(inst.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command).toBe(
      JSON.parse(plan.after).command,
    );
    expect((await call("GET", "/api/statusline-limits/status")).json().installed).toBe(true);

    const un = await call("POST", "/api/statusline-limits/uninstall", { body: {} });
    expect(un.status).toBe(200);
    expect(fs.readFileSync(settings, "utf8")).toBe(ORIGINAL);
  });

  it("install refuses (409) when the entry changed after the preview", async () => {
    fs.writeFileSync(settings, ORIGINAL);
    const r = await call("POST", "/api/statusline-limits/install", {
      body: { expectBefore: "null" },
    });
    expect(r.status).toBe(409);
    expect(fs.readFileSync(settings, "utf8")).toBe(ORIGINAL);
  });

  it("unparseable settings.json: preview and install answer 422 with the reason", async () => {
    fs.writeFileSync(settings, "{ broken");
    const pv = await call("GET", "/api/statusline-limits/preview?action=install");
    expect(pv.status).toBe(422);
    expect(pv.json().error).toMatch(/settings\.json/);
    const r = await call("POST", "/api/statusline-limits/install", { body: {} });
    expect(r.status).toBe(422);
    expect(fs.readFileSync(settings, "utf8")).toBe("{ broken");
  });

  it("bad preview action is a 400", async () => {
    expect((await call("GET", "/api/statusline-limits/preview?action=nope")).status).toBe(400);
  });
});
