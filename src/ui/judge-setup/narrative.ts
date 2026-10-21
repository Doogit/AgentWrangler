// Rendering rules for the AI-written review (JMS-P2 U10, plan R24). Model text is untrusted: it is shown as plain
// text only (React escapes it), never parsed as markdown or HTML, and never auto-linked. The only links the review
// shows are ones the app builds itself, checked here by exact match.

/** Bidi overrides/isolates, zero-width characters, BOM and other C0/C1 controls (newline and tab kept). */
const CONTROL_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁩﻿]/g;

/** Per-field display caps (characters); the daemon already caps, this is the UI's own backstop. */
export const FIELD_CAP = {
  verdict: 1200,
  title: 120,
  evidence: 600,
  why: 800,
  change: 800,
  reason: 600,
  item: 200,
} as const;

export function cleanText(text: string, max: number): string {
  const s = text.replace(CONTROL_CHARS, "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** In-app routes the review may link to. */
const ALLOWED_ROUTE = /^#\/judge-setup(?:\?check=[a-z0-9_]+)?$/;

/** `href` if it exactly equals an allowed citation URL or an allow-listed `#/` route, else null. */
export function safeLink(href: string, citationUrls: readonly string[]): string | null {
  if (ALLOWED_ROUTE.test(href)) return href;
  return citationUrls.includes(href) && href.startsWith("https://") ? href : null;
}

export function checkHref(checkId: string): string | null {
  return safeLink(`#/judge-setup?check=${checkId}`, []);
}

/** Redaction placeholders the payload scrubber writes (`judge-payload-scrub.ts`); `split` keeps them at odd indices. */
export const REDACTION_SPLIT = /(\[(?:URL|EMAIL|UNC|IP|HOST|USER)\])/;

/** What a blocked secret looks like, by the scrubber's match class. */
export const BLOCK_CLASS_LABEL: Record<string, string> = {
  "private-key": "a private key",
  "provider-key": "an API key or access token",
  jwt: "a signed login token (JWT)",
  "bearer-token": "an authorization header",
  "url-credential": "a password inside a URL",
  "named-secret": "a value named like a password or secret",
};

export const STANCE_LABEL: Record<string, string> = {
  too_harsh: "AI says too harsh",
  too_lenient: "AI says too lenient",
  misleading: "AI says misleading",
};

/** Daemon error codes → reader copy. Every one offers Retry. */
export const FAILURE_COPY: Record<string, string> = {
  payload_too_large:
    "Your setup is too large to send (over 10 MB). Untick some repos on the consent screen and try again.",
  cli_missing:
    "Claude Code's command-line tool (claude) was not found. Install Claude Code and sign in, then retry.",
  cli_outdated:
    "Your Claude Code is too old for the privacy flags this review needs. Update Claude Code, then retry.",
  cli_failed: "Claude Code could not be started on this machine. Retry, or restart the app.",
  cli_error:
    "Claude Code returned an error. Usually you are not signed in or hit a usage limit. Open Claude Code, sign in, then retry.",
  bad_output: "Claude's reply could not be read. Nothing was saved. Retry.",
  invalid_verdict: "Claude's reply did not follow the expected format, so it was not shown. Retry.",
  cancelled: "Cancelled. Nothing was saved.",
  in_flight: "A review is already running. Wait for it to finish, then retry.",
  network: "Could not reach the app's local service. Retry.",
};
