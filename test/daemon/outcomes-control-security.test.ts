import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const token = "synthetic-session-token";
const db = createInMemoryFixtureDb();
let server: http.Server;
let port: number;

function request(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

beforeAll(async () => {
  vi.stubEnv("AW_GITHUB_TOKEN", "synthetic-secret-never-return");
  server = createServer(db, 0, null, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  vi.unstubAllEnvs();
});

describe.each(["token-refresh", "connection-test", "sync-retry"])("%s write gates", (control) => {
  const path = `/api/outcomes/${control}`;
  it("rejects missing or wrong session tokens", async () => {
    expect((await request(path, { "Content-Type": "application/json" })).status).toBe(401);
    expect(
      (
        await request(path, {
          "Content-Type": "application/json",
          "X-AgentWrangler-Token": "wrong",
        })
      ).status,
    ).toBe(401);
  });
  it("rejects cross-origin and non-JSON writes", async () => {
    expect(
      (
        await request(path, {
          "Content-Type": "application/json",
          "X-AgentWrangler-Token": token,
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(path, { "Content-Type": "text/plain", "X-AgentWrangler-Token": token }))
        .status,
    ).toBe(415);
  });
});

it("refresh response contains status only", async () => {
  const result = await request("/api/outcomes/token-refresh", {
    "Content-Type": "application/json",
    "X-AgentWrangler-Token": token,
  });
  expect(result.status).toBe(200);
  expect(result.body).toContain('"source":"env"');
  expect(result.body).not.toContain("synthetic-secret-never-return");
});
