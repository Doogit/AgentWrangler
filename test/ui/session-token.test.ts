/**
 * test/ui/session-token.test.ts — P1-U6a tests 1 and 2: one `/api/token` per page.
 *
 * Oracle: request counts on a fetch mock that plays the daemon's token gate (a POST with the
 * current token → 200; a stale token → 401; a cross-origin rejection → 403). The daemon mints
 * a new token at every start, which the "restart" case simulates by rotating the token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSessionToken,
  resetSessionToken,
  withSessionToken,
} from "../../src/ui/api/session-token";

let daemonToken = "tok-1";
let tokenRequests = 0;
let forced: number[] = [];
const posts: Array<{ url: string; token: string | null }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/token") {
    tokenRequests += 1;
    return json(200, { token: daemonToken });
  }
  const headers = new Headers(init?.headers);
  const token = headers.get("X-AgentWrangler-Token");
  posts.push({ url, token });
  const status = forced.shift();
  if (status !== undefined) return json(status, { error: "x", code: "FORCED" });
  if (token !== daemonToken) return json(401, { error: "stale token" });
  return json(200, { data: {}, meta: {} });
});

beforeEach(() => {
  resetSessionToken();
  daemonToken = "tok-1";
  tokenRequests = 0;
  forced = [];
  posts.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const post = (url: string) => (token: string) =>
  fetch(url, { method: "POST", headers: { "X-AgentWrangler-Token": token } });

describe("getSessionToken / withSessionToken (P1-U6a test 1)", () => {
  it("two concurrent callers → 1 /api/token request; the token is kept for the page", async () => {
    const [a, b] = await Promise.all([getSessionToken(), getSessionToken()]);
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(await getSessionToken()).toBe("tok-1");
    expect(tokenRequests).toBe(1);
  });

  it("a daemon restart (new token): 401 → refetch /api/token → the retry succeeds", async () => {
    await getSessionToken();
    daemonToken = "tok-2"; // the daemon restarted
    const res = await withSessionToken(post("/api/x"));
    expect(res.status).toBe(200);
    expect(tokenRequests).toBe(2);
    expect(posts.map((p) => p.token)).toEqual(["tok-1", "tok-2"]);
  });

  it("two 401s in a row → the 401 is surfaced and /api/token is requested exactly 2 times", async () => {
    forced = [401, 401];
    const res = await withSessionToken(post("/api/x"));
    expect(res.status).toBe(401);
    expect(tokenRequests).toBe(2);
    expect(posts).toHaveLength(2);
  });

  it("a 403 is not retried", async () => {
    forced = [403];
    const res = await withSessionToken(post("/api/x"));
    expect(res.status).toBe(403);
    expect(tokenRequests).toBe(1);
    expect(posts).toHaveLength(1);
  });

  it("a failed /api/token fetch is not cached: the next call fetches again", async () => {
    fetchMock.mockImplementationOnce(async () => json(500, {}));
    await expect(getSessionToken()).rejects.toThrow();
    expect(await getSessionToken()).toBe("tok-1");
  });
});

describe("P3-U8: every client.ts write sends the token (the daemon gate is default-deny)", () => {
  it("settings, hook config, reset, calibrate ×2, link, unlink and pipeline retry", async () => {
    // client.ts returns mock data when MODE is "test"; load it fresh outside test mode.
    vi.stubEnv("MODE", "development");
    vi.resetModules();
    try {
      const c = await import("../../src/ui/api/client");
      const st = await import("../../src/ui/api/session-token");
      st.resetSessionToken();
      await c.saveSettings({} as never);
      await c.saveHookConfig({} as never);
      await c.resetDatabase();
      await c.calibrateLimitApi();
      await c.calibrateBytesPerTokenApi();
      await c.linkSession("s-1", "w-1");
      await c.unlinkSession("s-1", "w-1");
      await c.retryPipeline();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    expect(posts.map((p) => p.url)).toEqual([
      "/api/settings",
      "/api/hook-config",
      "/api/reset",
      "/api/calibrate",
      "/api/calibrate-bytes-per-token",
      "/api/outcomes/link",
      "/api/outcomes/unlink",
      "/api/pipeline/retry",
    ]);
    expect(posts.every((p) => p.token === "tok-1")).toBe(true);
  });
});

describe("non-rec writes share one token (P1-U6a test 2)", () => {
  it("a feedback write and a client.ts write on one page → 1 /api/token request", async () => {
    // client.ts returns mock data when MODE is "test"; load both modules fresh outside test mode
    // so they share one session-token module, as on a real page.
    vi.stubEnv("MODE", "development");
    vi.resetModules();
    try {
      const st = await import("../../src/ui/api/session-token");
      st.resetSessionToken();
      const feedback = await import("../../src/ui/api/feedback-client");
      const c = await import("../../src/ui/api/client");
      await feedback.setGoal("GLOBAL", "PRESERVE_QUALITY");
      await c.saveSettings({} as never);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    expect(posts.map((p) => p.url)).toContain("/api/settings");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.every((p) => p.token === "tok-1")).toBe(true);
    expect(tokenRequests).toBe(1);
  });
});
