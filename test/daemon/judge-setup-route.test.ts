import fs from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import type { JudgeSpawn } from "../../src/judge/claude-cli.js";
import { createJudgeService, judgeServiceFor } from "../../src/judge/judge-service.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const TOKEN = "test-session-token";

const MODEL_OUTPUT = {
  verdict: "Mostly solid.",
  findings: [
    {
      title: "Stale CLAUDE.md claim",
      evidence: "Run tests.",
      why: "w",
      change: "c",
      check_id: null,
      source: "claude_md:user",
    },
  ],
  disagreements: [],
  cannot_judge: [],
};
const OK_STDOUT = JSON.stringify({ structured_output: MODEL_OUTPUT, total_cost_usd: 0.4 });

function request(
  port: number,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          ...(token === null ? {} : { "X-AgentWrangler-Token": token }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {}
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

let root: string;
let db: Database.Database;
let server: http.Server;
let port: number;
// Each test swaps the behaviour; the service registered for `db` calls through this.
let spawnImpl: JudgeSpawn;
const spawn = vi.fn<JudgeSpawn>((cmd, argv, opts) => spawnImpl(cmd, argv, opts));

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-judge-route-"));
  const claudeDir = path.join(root, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# Global\n- Run tests.");
  db = createInMemoryFixtureDb();
  // Pre-register before the router's lazy factory runs, so no real `claude` is ever spawned.
  judgeServiceFor(db, () =>
    createJudgeService({
      db,
      spawn,
      env: { PATH: "/bin" },
      identity: () => ({ home: "/home/nobody", usernames: ["nobody"] }),
      scan: { claudeDir, claudeJsonPath: path.join(root, "claude.json") },
      model: "m-test",
    }),
  );
  server = createServer(db, 0, null, TOKEN);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
beforeEach(() => {
  setQueryDb(db);
  spawn.mockClear();
  spawnImpl = async () => ({ code: 0, stdout: OK_STDOUT });
});
afterEach(async () => {
  resetQueryDb();
  await request(port, "POST", "/api/judge-setup/consent/revoke", {});
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function shapeHash(): Promise<string> {
  const r = await request(port, "GET", "/api/judge-setup/consent");
  expect(r.status).toBe(200);
  expect(r.json.state).toBe("ready");
  return r.json.shapeHash as string;
}

async function approve(hash: string, remember = false): Promise<string> {
  const r = await request(port, "POST", "/api/judge-setup/consent/approve", {
    shapeHash: hash,
    remember,
  });
  expect(r.status).toBe(200);
  return r.json.consentNonce as string;
}

describe("judge-setup routes (JMS-P2 U9)", () => {
  it("write gate: POSTs without the session token are rejected and never spawn", async () => {
    const hash = await shapeHash();
    const approveNoToken = await request(
      port,
      "POST",
      "/api/judge-setup/consent/approve",
      { shapeHash: hash },
      null,
    );
    expect(approveNoToken.status).toBe(401);
    const judgeNoToken = await request(
      port,
      "POST",
      "/api/judge-setup/judge",
      { shapeHash: hash, consentNonce: "x" },
      null,
    );
    expect(judgeNoToken.status).toBe(401);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("400 when shapeHash is missing", async () => {
    expect((await request(port, "POST", "/api/judge-setup/judge", {})).status).toBe(400);
    expect((await request(port, "POST", "/api/judge-setup/consent/approve", {})).status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("403 consent_required with no nonce and no standing consent", async () => {
    const r = await request(port, "POST", "/api/judge-setup/judge", {
      shapeHash: await shapeHash(),
    });
    expect(r).toEqual({ status: 403, json: { error: "consent_required" } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("409 needs_consent when the hash doesn't match the current payload", async () => {
    const hash = await shapeHash();
    const nonce = await approve(hash);
    const stale = "0".repeat(64);
    expect(
      (await request(port, "POST", "/api/judge-setup/consent/approve", { shapeHash: stale }))
        .status,
    ).toBe(409);
    const r = await request(port, "POST", "/api/judge-setup/judge", {
      shapeHash: stale,
      consentNonce: nonce,
    });
    expect(r).toEqual({ status: 409, json: { error: "needs_consent" } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("nonce runs once and stores the verdict; a replayed nonce is 403", async () => {
    const hash = await shapeHash();
    const nonce = await approve(hash);
    const first = await request(port, "POST", "/api/judge-setup/judge", {
      shapeHash: hash,
      consentNonce: nonce,
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ payload_hash: hash, model: "m-test", outdated: false });
    const stored = await request(port, "GET", "/api/judge-setup/verdict");
    expect(stored.json.verdict).toMatchObject({ verdict_id: first.json.verdict_id });

    const replay = await request(port, "POST", "/api/judge-setup/judge", {
      shapeHash: hash,
      consentNonce: nonce,
    });
    expect(replay).toEqual({ status: 403, json: { error: "consent_required" } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("extra body fields are ignored: a client-sent payload never reaches the CLI's stdin", async () => {
    const consent = await request(port, "GET", "/api/judge-setup/consent");
    const hash = consent.json.shapeHash as string;
    const nonce = await approve(hash);
    const r = await request(port, "POST", "/api/judge-setup/judge", {
      shapeHash: hash,
      consentNonce: nonce,
      payload: "INJECTED-PAYLOAD",
      model: "evil-model",
    });
    expect(r.status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, argv, opts] = spawn.mock.calls[0] ?? [];
    expect(opts?.input).toBe(consent.json.payload);
    expect(opts?.input).not.toContain("INJECTED-PAYLOAD");
    expect(argv).not.toContain("evil-model");
    expect(argv).toContain("m-test");
  });

  it("single-flight: two concurrent POSTs → one spawn, the other 409 in_flight", async () => {
    const hash = await shapeHash();
    await approve(hash, true); // standing consent authorises both requests
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started: () => void = () => {};
    const spawned = new Promise<void>((r) => {
      started = r;
    });
    spawnImpl = async () => {
      started();
      await gate;
      return { code: 0, stdout: OK_STDOUT };
    };
    const a = request(port, "POST", "/api/judge-setup/judge", { shapeHash: hash });
    await spawned;
    const b = await request(port, "POST", "/api/judge-setup/judge", { shapeHash: hash });
    expect(b).toEqual({ status: 409, json: { error: "in_flight" } });
    release();
    expect((await a).status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("judge-setup consent sources (JMS-P2 U10)", () => {
  const SOURCES = "/api/judge-setup/consent/sources";
  afterEach(async () => {
    await request(port, "POST", SOURCES, { extraNames: [], includedRepos: null });
  });

  it("is behind the write gate", async () => {
    const r = await request(port, "POST", SOURCES, { extraNames: ["tests"] }, null);
    expect(r.status).toBe(401);
    const consent = await request(port, "GET", "/api/judge-setup/consent");
    expect(consent.json.extra_names).toEqual([]);
  });

  it("saves names to scrub; the next consent payload has them replaced", async () => {
    const before = await request(port, "GET", "/api/judge-setup/consent");
    expect(before.json.payload as string).toContain("Run tests");
    const r = await request(port, "POST", SOURCES, {
      extraNames: [" tests "],
      includedRepos: null,
    });
    expect(r).toEqual({ status: 200, json: { ok: true } });
    const after = await request(port, "GET", "/api/judge-setup/consent");
    expect(after.json.extra_names).toEqual(["tests"]);
    expect(after.json.payload as string).not.toContain("Run tests");
    expect(after.json.payload as string).toContain("Run [USER]");
    expect(after.json.shapeHash).not.toBe(before.json.shapeHash);
  });

  it("rejects malformed lists", async () => {
    for (const body of [
      { extraNames: "tests" },
      { extraNames: [1] },
      { extraNames: ["x".repeat(65)] },
      { extraNames: Array.from({ length: 51 }, (_, i) => `name${i}`) },
      { extraNames: [], includedRepos: "all" },
    ]) {
      expect((await request(port, "POST", SOURCES, body)).status).toBe(400);
    }
  });

  it("verdict GET reports whether don't-ask-again is on", async () => {
    expect((await request(port, "GET", "/api/judge-setup/verdict")).json.remembered).toBe(false);
    await approve(await shapeHash(), true);
    expect((await request(port, "GET", "/api/judge-setup/verdict")).json.remembered).toBe(true);
    await request(port, "POST", "/api/judge-setup/consent/revoke", {});
    expect((await request(port, "GET", "/api/judge-setup/verdict")).json.remembered).toBe(false);
  });
});
