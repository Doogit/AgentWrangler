/**
 * src/ui/api/session-token.ts — one `/api/token` per page (P1-U6a).
 *
 * Every write needs the daemon's session token. It is fetched once (one in-flight promise,
 * kept for the page's life) instead of before every write. The daemon mints a new token at each
 * start, so a 401 clears it, refetches once and retries the write once; a second 401 is the
 * caller's to surface. A 403 (cross-origin rejection) is never retried.
 */

import { daemonFetch } from "./daemon-fetch";

export class SessionTokenUnavailableError extends Error {
  constructor() {
    super("Unable to authorize the request.");
    this.name = "SessionTokenUnavailableError";
  }
}

let token: Promise<string> | null = null;

export function getSessionToken(): Promise<string> {
  if (token !== null) return token;
  const request = daemonFetch("/api/token").then(async (response) => {
    const payload = response.ok ? ((await response.json()) as { token?: unknown }) : {};
    if (typeof payload.token !== "string" || payload.token.length === 0) {
      throw new SessionTokenUnavailableError();
    }
    return payload.token;
  });
  token = request;
  // A failed fetch is not kept: the next caller tries again.
  request.catch(() => {
    if (token === request) token = null;
  });
  return request;
}

/** Forget the token (tests; a 401 does this itself). */
export function resetSessionToken(): void {
  token = null;
}

/** Run a write with the session token; on a 401, refetch the token and retry once. */
export async function withSessionToken(
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  const first = await getSessionToken();
  const response = await send(first);
  if (response.status !== 401) return response;
  // Another caller may already have refreshed it.
  if (token !== null && (await token.catch(() => null)) === first) token = null;
  return send(await getSessionToken());
}
