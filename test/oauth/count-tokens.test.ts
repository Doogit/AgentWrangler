/**
 * test/oauth/count-tokens.test.ts — countTokens unit tests.
 *
 * All HTTP is stubbed via vi.stubGlobal("fetch", ...); credentials are injected
 * via the CredentialSource parameter. No real network or file I/O.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { countTokens } from "../../src/oauth/count-tokens.js";
import type { CredentialSource } from "../../src/oauth/credentials.js";

// ---------------------------------------------------------------------------
// Stub credential sources
// ---------------------------------------------------------------------------

const VALID_EXPIRY = Date.now() + 3_600_000;

const validCredSource: CredentialSource = {
  read: () => ({
    ok: true,
    credential: {
      accessToken: "tok_test",
      expiresAt: VALID_EXPIRY,
      subscriptionType: "max",
      rateLimitTier: "max_5x",
    },
  }),
};

const missingCredSource: CredentialSource = {
  read: () => ({ ok: false, reason: "Credentials file not found — re-login to Claude Code." }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("countTokens — success", () => {
  it("POSTs to the count_tokens endpoint and returns input_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ input_tokens: 42 }),
      }),
    );

    const result = await countTokens("hello world", "claude-sonnet-4-6", validCredSource);
    expect(result).toEqual({ ok: true, input_tokens: 42 });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_test");
    expect((init.headers as Record<string, string>)["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.messages).toEqual([{ role: "user", content: "hello world" }]);
  });
});

// ---------------------------------------------------------------------------
// Missing/expired credentials — no fetch call
// ---------------------------------------------------------------------------

describe("countTokens — credential failures", () => {
  it("returns ok:false without calling fetch when credentials are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await countTokens("text", "claude-sonnet-4-6", missingCredSource);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Credentials file not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-200 status codes — degrade gracefully
// ---------------------------------------------------------------------------

describe("countTokens — HTTP error codes", () => {
  it("returns ok:false with reason on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    const result = await countTokens("text", "claude-sonnet-4-6", validCredSource);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toContain("401");
    }
  });

  it("returns ok:false with reason on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    );
    const result = await countTokens("text", "claude-sonnet-4-6", validCredSource);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.reason).toContain("429");
    }
  });

  it("returns ok:false on 404 (old model id)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    const result = await countTokens("text", "claude-3-5-sonnet-20241022", validCredSource);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("returns ok:false on any other non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const result = await countTokens("text", "claude-sonnet-4-6", validCredSource);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Network error — degrade gracefully
// ---------------------------------------------------------------------------

describe("countTokens — network failure", () => {
  it("returns ok:false when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await countTokens("text", "claude-sonnet-4-6", validCredSource);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Malformed response
// ---------------------------------------------------------------------------

describe("countTokens — malformed response", () => {
  it("returns ok:false when response is missing input_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: "shape" }) }),
    );
    const result = await countTokens("text", "claude-sonnet-4-6", validCredSource);
    expect(result.ok).toBe(false);
  });
});
