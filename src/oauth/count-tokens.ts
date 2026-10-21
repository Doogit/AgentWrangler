/**
 * src/oauth/count-tokens.ts — Anthropic count_tokens API client.
 *
 * Calls POST https://api.anthropic.com/v1/messages/count_tokens with the user's
 * own Anthropic API key. The endpoint is free (no generation) and returns
 * {input_tokens: N} for a given model + message text.
 *
 * OAUTH-1 (2026-10-13): never the Claude Code OAuth token — Anthropic's terms bar
 * third-party apps from using it (.claude/audits/2026-10-13-jms-p2-terms.md).
 *
 * Used by the bytes→token calibration path (R12). Text passes through this
 * call only; nothing is persisted or logged (SEC-101).
 */

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

export type CountTokensResult =
  | { ok: true; input_tokens: number }
  | { ok: false; reason: string; status?: number };

/**
 * Count the tokens in `text` for the given `model` using Anthropic's free
 * count_tokens endpoint, authenticated with `apiKey` (`x-api-key`).
 *
 * Treats any non-200 (including 404 from an old model id) as ok:false.
 * Never throws.
 *
 * @param text   The text to count tokens for (tool-result sample).
 * @param model  A current model id (e.g. "claude-sonnet-4-6").
 * @param apiKey The user's Anthropic API key (src/oauth/anthropic-api-key.ts).
 */
export async function countTokens(
  text: string,
  model: string,
  apiKey: string,
): Promise<CountTokensResult> {
  // Text lives in memory only for this call — SEC-101.
  try {
    const res = await fetch(COUNT_TOKENS_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
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
          reason: "API key rejected (401) — check ANTHROPIC_API_KEY.",
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
