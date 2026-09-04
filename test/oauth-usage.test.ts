/**
 * test/oauth-usage.test.ts — fetchOAuthUsage unit tests.
 *
 * All HTTP is stubbed via vi.stubGlobal("fetch", ...); credentials are injected
 * via the CredentialSource parameter. No real network or file I/O.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSource } from "../src/oauth/credentials.js";
import { fetchOAuthUsage } from "../src/oauth/usage.js";

// ---------------------------------------------------------------------------
// Stub credential sources
// ---------------------------------------------------------------------------

const VALID_EXPIRY = Date.now() + 3_600_000;

/** A credential source that always returns a valid credential. */
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

/** A credential source that returns ok:false (missing file). */
const missingCredSource: CredentialSource = {
  read: () => ({ ok: false, reason: "Credentials file not found — re-login to Claude Code." }),
};

/** A credential source that returns ok:false (expired). */
const expiredCredSource: CredentialSource = {
  read: () => ({ ok: false, reason: "OAuth token has expired — re-login to Claude Code." }),
};

// The live endpoint reports utilization as a PERCENT (0–100), confirmed against
// the real oauth/usage endpoint 2026-09-01. fetchOAuthUsage normalizes it to a
// fraction (0–1) at the boundary, so the request body and the expected result
// differ: body carries percent, result carries the /100 fraction.
const validBody = {
  five_hour: { utilization: 25, resets_at: "2026-08-27T12:00:00.000Z" },
  seven_day: { utilization: 50, resets_at: "2026-09-01T12:00:00.000Z" },
};

/** Expected normalized (fraction 0–1) result for validBody. */
const validData = {
  five_hour: { utilization: 0.25, resets_at: "2026-08-27T12:00:00.000Z" },
  seven_day: { utilization: 0.5, resets_at: "2026-09-01T12:00:00.000Z" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Missing / expired credential — no fetch called
// ---------------------------------------------------------------------------

describe("fetchOAuthUsage — missing credential", () => {
  it("returns ok:false without calling fetch when credentials are missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchOAuthUsage(missingCredSource);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/not found/i);
    expect(result.reason).toMatch(/re-login/i);
  });

  it("returns ok:false without calling fetch when token is expired", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchOAuthUsage(expiredCredSource);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/expired/i);
    expect(result.reason).toMatch(/re-login/i);
  });
});

// ---------------------------------------------------------------------------
// HTTP status distinguishing — 401 vs 429
// ---------------------------------------------------------------------------

describe("fetchOAuthUsage — HTTP error distinguishing", () => {
  it("distinguishes 401 (auth failure) with a re-login reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    const result = await fetchOAuthUsage(validCredSource);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(401);
    expect(result.reason).toMatch(/401/);
    expect(result.reason).toMatch(/re-login/i);
  });

  it("distinguishes 429 (rate limited) without re-login reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too Many Requests", { status: 429 })),
    );
    const result = await fetchOAuthUsage(validCredSource);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(429);
    expect(result.reason).toMatch(/429/);
    // 429 must NOT say "re-login" — it's a rate limit, not an auth failure
    expect(result.reason).not.toMatch(/re-login/i);
  });
});

// ---------------------------------------------------------------------------
// Response validation — extra keys tolerated; missing seven_day rejected
// ---------------------------------------------------------------------------

describe("fetchOAuthUsage runtime validation", () => {
  it("accepts a complete bounded response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(validBody))),
    );
    await expect(fetchOAuthUsage(validCredSource)).resolves.toEqual({ ok: true, data: validData });
  });

  it("accepts a response with extra unknown keys (e.g. per-model / extra_usage)", async () => {
    const bodyWithExtras = {
      ...validBody,
      extra_usage: { some_model: { utilization: 10 } },
      unknown_field: "tolerated",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(bodyWithExtras))),
    );
    const result = await fetchOAuthUsage(validCredSource);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    // Only the two bounded fields are present in the typed result, normalized.
    expect(result.data.five_hour).toEqual(validData.five_hour);
    expect(result.data.seven_day).toEqual(validData.seven_day);
  });

  it("fails closed when seven_day is missing", async () => {
    const bodyMissingSevenDay = { five_hour: validBody.five_hour };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(bodyMissingSevenDay))),
    );
    const result = await fetchOAuthUsage(validCredSource);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toMatch(/invalid response shape/i);
  });

  it.each([
    null,
    {},
    { ...validBody, seven_day: undefined },
    { ...validBody, seven_day: { utilization: Number.NaN, resets_at: "2026-09-01" } },
    { ...validBody, seven_day: { utilization: Number.POSITIVE_INFINITY, resets_at: "2026-09-01" } },
    { ...validBody, seven_day: { utilization: 100.01, resets_at: "2026-09-01" } },
    { ...validBody, seven_day: { utilization: -1, resets_at: "2026-09-01" } },
    { ...validBody, seven_day: { utilization: 50, resets_at: "not-a-date" } },
  ])("fails closed for malformed body %#", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body))),
    );
    const result = await fetchOAuthUsage(validCredSource);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid response failure");
    expect(result.reason).toMatch(/invalid response shape/i);
  });
});

// ---------------------------------------------------------------------------
// Optional per-model utilization â€” malformed detail never affects periods
// ---------------------------------------------------------------------------

describe("fetchOAuthUsage per-model utilization", () => {
  it("normalizes array-form per_model utilization from percent to fraction", async () => {
    const body = {
      ...validBody,
      per_model: [
        { model: "sonnet", utilization: 82, resets_at: "2026-09-01T12:00:00.000Z" },
        { model_key: "opus", utilization: 25 },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body))),
    );

    await expect(fetchOAuthUsage(validCredSource)).resolves.toEqual({
      ok: true,
      data: {
        ...validData,
        per_model: [
          { model: "sonnet", utilization: 0.82 },
          { model: "opus", utilization: 0.25 },
        ],
      },
    });
  });

  it("uses object-map keys as model ids and normalizes utilization", async () => {
    const body = {
      ...validBody,
      per_model: {
        sonnet: { utilization: 82, resets_at: "2026-09-01T12:00:00.000Z" },
        opus: { utilization: 25 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body))),
    );

    const result = await fetchOAuthUsage(validCredSource);
    expect(result).toEqual({
      ok: true,
      data: {
        ...validData,
        per_model: [
          { model: "sonnet", utilization: 0.82 },
          { model: "opus", utilization: 0.25 },
        ],
      },
    });
  });

  it("drops malformed per-model entries while retaining valid entries", async () => {
    const body = {
      ...validBody,
      per_model: [
        { model: "sonnet", utilization: 82 },
        { model: "opus", utilization: 101 },
        { tier: "haiku", utilization: "10" },
        { utilization: 10 },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body))),
    );

    const result = await fetchOAuthUsage(validCredSource);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.per_model).toEqual([{ model: "sonnet", utilization: 0.82 }]);
  });

  it("omits per_model when it is absent without changing the core usage data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(validBody))),
    );

    const result = await fetchOAuthUsage(validCredSource);
    expect(result).toEqual({ ok: true, data: validData });
    if (!result.ok) throw new Error("expected success");
    expect(result.data).not.toHaveProperty("per_model");
  });

  it("omits entirely malformed per_model data while preserving valid core periods", async () => {
    const body = { ...validBody, per_model: "not-a-model-breakdown" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body))),
    );

    const result = await fetchOAuthUsage(validCredSource);
    expect(result).toEqual({ ok: true, data: validData });
    if (!result.ok) throw new Error("expected success");
    expect(result.data).not.toHaveProperty("per_model");
  });
});
