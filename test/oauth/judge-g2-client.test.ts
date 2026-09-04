import { describe, expect, it, vi } from "vitest";
import type { CredentialSource } from "../../src/oauth/credentials.js";
import { claudeJudgeClient } from "../../src/oauth/judge-g2-client.js";

const validCredSource: CredentialSource = {
  read: () => ({
    ok: true,
    credential: {
      accessToken: "t",
      expiresAt: Date.now() + 1_000_000,
      subscriptionType: null,
      rateLimitTier: null,
    },
  }),
};

describe("claudeJudgeClient", () => {
  it("returns a validated G2 verdict from the first text block", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ verdict: "CONFIRMED", confidence: 0.9, rationale_tag: "clear" }),
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const judge = claudeJudgeClient({ credSource: validCredSource, fetchFn });

    await expect(
      judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} }),
    ).resolves.toEqual({
      ok: true,
      verdict: "CONFIRMED",
      confidence: 0.9,
      rationaleTag: "clear",
    });
  });

  it("accepts a valid verdict even when the model adds extra keys", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              verdict: "REJECTED",
              confidence: 0.4,
              rationale_tag: "insufficient",
              reasoning: "the model volunteered this field",
            }),
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const judge = claudeJudgeClient({ credSource: validCredSource, fetchFn });

    await expect(
      judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} }),
    ).resolves.toEqual({
      ok: true,
      verdict: "REJECTED",
      confidence: 0.4,
      rationaleTag: "insufficient",
    });
  });

  it("returns ok:false when the text does not match the rubric JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "not rubric JSON" }] }),
    }) as unknown as typeof fetch;
    const judge = claudeJudgeClient({ credSource: validCredSource, fetchFn });

    const result = await judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} });
    expect(result.ok).toBe(false);
  });

  it("retries a transient 429 and returns the verdict once it clears", async () => {
    const throttled = {
      ok: false,
      status: 429,
      headers: new Headers({ "x-should-retry": "true" }),
    };
    const success = {
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ verdict: "CONFIRMED", confidence: 0.8, rationale_tag: "ok" }),
          },
        ],
      }),
    };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValue(success) as unknown as typeof fetch;
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const judge = claudeJudgeClient({
      credSource: validCredSource,
      fetchFn,
      sleepFn,
      baseDelayMs: 1,
    });

    const result = await judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} });
    expect(result).toEqual({ ok: true, verdict: "CONFIRMED", confidence: 0.8, rationaleTag: "ok" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries on a sustained 429", async () => {
    const throttled = {
      ok: false,
      status: 429,
      headers: new Headers({ "x-should-retry": "true" }),
    };
    const fetchFn = vi.fn().mockResolvedValue(throttled) as unknown as typeof fetch;
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const judge = claudeJudgeClient({
      credSource: validCredSource,
      fetchFn,
      sleepFn,
      maxRetries: 2,
      baseDelayMs: 1,
    });

    const result = await judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} });
    expect(result).toEqual({ ok: false, reason: "HTTP 429 from Messages API", status: 429 });
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry a non-retryable 4xx", async () => {
    const badRequest = { ok: false, status: 400, headers: new Headers() };
    const fetchFn = vi.fn().mockResolvedValue(badRequest) as unknown as typeof fetch;
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const judge = claudeJudgeClient({ credSource: validCredSource, fetchFn, sleepFn });

    const result = await judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} });
    expect(result).toEqual({ ok: false, reason: "HTTP 400 from Messages API", status: 400 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("fails closed without a network call when credentials are unavailable", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const judge = claudeJudgeClient({
      credSource: { read: () => ({ ok: false, reason: "x" }) },
      fetchFn,
    });

    const result = await judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} });
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses x-api-key auth (no OAuth read) when an apiKey is provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ verdict: "CONFIRMED", confidence: 0.7, rationale_tag: "ok" }),
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const credRead = vi.fn(() => ({ ok: false as const, reason: "should-not-be-read" }));
    const judge = claudeJudgeClient({
      apiKey: "sk-ant-test",
      credSource: { read: credRead },
      fetchFn,
    });

    const result = await judge({ findingAlias: "g2_1", evidenceKind: "message", evidence: {} });
    expect(result.ok).toBe(true);
    expect(credRead).not.toHaveBeenCalled();
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      headers: Record<string, string>;
    };
    const headers = init.headers;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});
