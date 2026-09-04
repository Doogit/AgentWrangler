/**
 * src/oauth/count-tokens.ts — Anthropic count_tokens API client.
 *
 * Calls POST https://api.anthropic.com/v1/messages/count_tokens using the local
 * Claude Code OAuth token. The endpoint is free (no generation) and returns
 * {input_tokens: N} for a given model + message text.
 *
 * Used by the bytes→token calibration path (R12). Text passes through this
 * call only; nothing is persisted or logged (SEC-101).
 *
 * Mirrors the structure of src/oauth/usage.ts.
 */

import type { CredentialSource } from "./credentials.js";
import { fileCredentialSource } from "./credentials.js";

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

export type CountTokensResult =
  | { ok: true; input_tokens: number }
  | { ok: false; reason: string; status?: number };

/**
 * Count the tokens in `text` for the given `model` using Anthropic's free
 * count_tokens endpoint, authenticated via the local OAuth credential.
 *
 * Returns ok:false (no network call) when credentials are missing or expired.
 * Treats any non-200 (including 404 from an old model id) as ok:false.
 * Never throws.
 *
 * @param text       The text to count tokens for (tool-result sample).
 * @param model      A current model id (e.g. "claude-sonnet-4-6").
 * @param credSource Credential source — injectable for tests.
 */
export async function countTokens(
  text: string,
  model: string,
  credSource: CredentialSource = fileCredentialSource,
): Promise<CountTokensResult> {
  // 1. Read credential; fail closed if unavailable.
  const credResult = credSource.read();
  if (!credResult.ok) {
    return { ok: false, reason: credResult.reason };
  }

  const { accessToken } = credResult.credential;

  // 2. Call count_tokens (text lives in memory only for this call — SEC-101).
  try {
    const res = await fetch(COUNT_TOKENS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return {
          ok: false,
          reason: "OAuth token rejected (401) — re-login to Claude Code.",
          status: 401,
        };
      }
      if (res.status === 429) {
        return {
          ok: false,
          reason: "Rate limited (429) — try again later.",
          status: 429,
        };
      }
      return {
        ok: false,
        reason: `HTTP ${res.status} from count_tokens`,
        status: res.status,
      };
    }

    const raw: unknown = await res.json();
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, reason: "count_tokens returned an invalid response shape." };
    }
    const candidate = raw as { input_tokens?: unknown };
    if (typeof candidate.input_tokens !== "number") {
      return { ok: false, reason: "count_tokens response missing input_tokens." };
    }
    return { ok: true, input_tokens: candidate.input_tokens };
  } catch (e: unknown) {
    return {
      ok: false,
      reason: `Could not reach ${COUNT_TOKENS_URL}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Injectable counter type for tests and calibration. */
export type TokenCounter = (text: string, model: string) => Promise<CountTokensResult>;
