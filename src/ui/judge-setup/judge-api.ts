// Client for the "Judge me" routes (JMS-P2 U9/U10). Writes carry the session token; the run POST uses plain
// `fetch` because a review takes ~45 s, past `daemonFetch`'s 15 s timeout.
import type { ConsentView, StoredVerdict } from "../../judge/judge-service";
import { daemonFetch } from "../api/daemon-fetch";
import { withSessionToken } from "../api/session-token";

export type { ConsentView, StoredVerdict };
export type ReadyConsent = Extract<ConsentView, { state: "ready" }>;

const BASE = "/api/judge-setup";

export async function fetchConsent(): Promise<ConsentView> {
  const res = await daemonFetch(`${BASE}/consent`);
  if (!res.ok) throw new Error(`consent ${res.status}`);
  return (await res.json()) as ConsentView;
}

export async function fetchStoredVerdict(): Promise<{
  verdict: StoredVerdict | null;
  remembered: boolean;
}> {
  const res = await daemonFetch(`${BASE}/verdict`);
  if (!res.ok) throw new Error(`verdict ${res.status}`);
  return (await res.json()) as { verdict: StoredVerdict | null; remembered: boolean };
}

export interface PostResult {
  status: number;
  body: Record<string, unknown>;
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<PostResult> {
  const res = await withSessionToken((token) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": token },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
  );
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {}
  return { status: res.status, body: json };
}

export const approveConsent = (shapeHash: string, remember: boolean) =>
  post("/consent/approve", { shapeHash, remember });
export const revokeConsent = () => post("/consent/revoke", {});
export const saveSources = (extraNames: string[], includedRepos: string[] | null) =>
  post("/consent/sources", { extraNames, includedRepos });
export const runJudge = (shapeHash: string, consentNonce: string | null, signal?: AbortSignal) =>
  post("/judge", { shapeHash, consentNonce }, signal);
export const cancelJudge = () => post("/judge/cancel", {});
