/**
 * src/oauth/judge-g2-client.ts — Claude client for blinded G2 adjudication.
 *
 * Calls Anthropic Messages using the local Claude Code OAuth credential. The
 * displayed evidence is sent only for the adjudication request and is never
 * logged (SEC-101).
 */

import type { CredentialSource } from "./credentials.js";
import { fileCredentialSource } from "./credentials.js";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

// Pilot-review artifact: a human reviews this fixed rubric before any live run.
export const G2_JUDGE_RUBRIC: string = `You adjudicate one blinded G2 DEFERRAL finding. Given only the displayed evidence object and its evidenceKind, decide whether that displayed evidence supports that the item is a genuine deferral.

Return CONFIRMED only when the displayed evidence supports the finding. Return REJECTED when it does not support the finding, is insufficient, or is unrelated. Do not infer facts that are not displayed. Use a confidence number from 0 through 1 inclusive. Choose a short, lowercase snake_case rationale_tag that identifies the main reason.

Respond with strict JSON only, with exactly these fields and no markdown or additional text:
{"verdict":"CONFIRMED"|"REJECTED","confidence":<number 0..1>,"rationale_tag":"<short snake_case tag>"}`;

export interface JudgeInput {
  findingAlias: string;
  evidenceKind: string;
  evidence: unknown;
}

export type JudgeResult =
  | { ok: true; verdict: "CONFIRMED" | "REJECTED"; confidence: number; rationaleTag: string }
  | { ok: false; reason: string; status?: number };

export type JudgeClient = (input: JudgeInput) => Promise<JudgeResult>;

function parseJudgeResult(raw: unknown): JudgeResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "Judge returned an invalid response shape." };
  }

  // Require the three rubric fields to be present and valid; ignore any extra
  // keys the model volunteers (e.g. a spontaneous "reasoning") rather than
  // discarding the whole verdict.
  const candidate = raw as Record<string, unknown>;
  if (
    (candidate.verdict !== "CONFIRMED" && candidate.verdict !== "REJECTED") ||
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1 ||
    typeof candidate.rationale_tag !== "string" ||
    candidate.rationale_tag.length === 0
  ) {
    return { ok: false, reason: "Judge response did not match the G2 rubric." };
  }

  return {
    ok: true,
    verdict: candidate.verdict,
    confidence: candidate.confidence,
    rationaleTag: candidate.rationale_tag,
  };
}

/**
 * Anthropic marks a 429/overload as retryable via `x-should-retry: true` and,
 * for hard quota walls, an `anthropic-ratelimit-*`/`retry-after` header. Retry
 * transient throttles with bounded exponential backoff + full jitter so a
 * single blip among the sequential judge calls does not abort the whole run.
 */
function isRetryableStatus(status: number, headers?: Headers): boolean {
  if (headers?.get("x-should-retry") === "true") return true;
  return status === 429 || status === 529 || status >= 500;
}

/** Delay before the next attempt: honor `retry-after` (seconds) else exp backoff. */
function backoffDelayMs(attempt: number, baseDelayMs: number, headers?: Headers): number {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter !== undefined && retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  const ceiling = Math.min(baseDelayMs * 2 ** attempt, 30_000);
  return Math.round(Math.random() * ceiling);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function claudeJudgeClient(
  opts: {
    credSource?: CredentialSource;
    fetchFn?: typeof fetch;
    model?: string;
    /**
     * When set, authenticate with a raw Anthropic API key (`x-api-key`) instead
     * of the Claude Code subscription OAuth token. Draws on a separate rate-limit
     * pool, so the judge no longer competes with live Claude Code generation.
     */
    apiKey?: string;
    /** Max retry attempts after the first try on a transient 429/5xx. */
    maxRetries?: number;
    baseDelayMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): JudgeClient {
  const credSource = opts.credSource ?? fileCredentialSource;
  const fetchFn = opts.fetchFn ?? fetch;
  const model = opts.model ?? "claude-opus-4-8";
  const apiKey = opts.apiKey;
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleepFn = opts.sleepFn ?? defaultSleep;

  return async ({ evidenceKind, evidence }): Promise<JudgeResult> => {
    // API-key auth uses `x-api-key`; OAuth (subscription) auth uses a Bearer
    // token + the oauth beta header. Resolve one set of auth headers up front.
    let authHeaders: Record<string, string>;
    if (apiKey !== undefined) {
      authHeaders = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      };
    } else {
      const credResult = credSource.read();
      if (!credResult.ok) {
        return { ok: false, reason: credResult.reason };
      }
      authHeaders = {
        Authorization: `Bearer ${credResult.credential.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      };
    }

    for (let attempt = 0; ; attempt++) {
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetchFn(MESSAGES_URL, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            model,
            max_tokens: 512,
            system: G2_JUDGE_RUBRIC,
            messages: [{ role: "user", content: JSON.stringify({ evidenceKind, evidence }) }],
          }),
        });
      } catch (error: unknown) {
        // Network-level failure — retry with backoff, then give up.
        if (attempt < maxRetries) {
          await sleepFn(backoffDelayMs(attempt, baseDelayMs));
          continue;
        }
        return {
          ok: false,
          reason: `Could not reach ${MESSAGES_URL}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (!response.ok) {
        if (attempt < maxRetries && isRetryableStatus(response.status, response.headers)) {
          await sleepFn(backoffDelayMs(attempt, baseDelayMs, response.headers));
          continue;
        }
        return {
          ok: false,
          reason: `HTTP ${response.status} from Messages API`,
          status: response.status,
        };
      }

      const raw: unknown = await response.json();
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ok: false, reason: "Messages API returned an invalid response shape." };
      }

      const content = (raw as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        return { ok: false, reason: "Messages API response is missing content." };
      }

      const textBlock = content.find(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      );
      if (textBlock === undefined) {
        return { ok: false, reason: "Messages API response is missing a text block." };
      }

      try {
        return parseJudgeResult(JSON.parse(textBlock.text));
      } catch {
        return { ok: false, reason: "Judge response was not valid JSON." };
      }
    }
  };
}
