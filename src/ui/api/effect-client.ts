/** Browser client for the versioned recommendation-effect lifecycle. */

import type { EffectEvidencePage } from "../../effects/api-contract";
import type { EffectCycle, RollbackOperation } from "../../effects/types";

export interface TrackResult {
  supported: boolean;
  state?: "UNSUPPORTED";
  reason?: string;
  cycle?: EffectCycle;
  replayed?: boolean;
}

async function token(): Promise<string> {
  const response = await fetch("/api/token", { signal: AbortSignal.timeout(8_000) });
  const body = response.ok ? ((await response.json()) as { token?: unknown }) : {};
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("Unable to authorize this change. Check the daemon and retry.");
  }
  return body.token;
}

async function mutate(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": await token() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: unknown;
    reason?: string;
    error?: string;
  };
  if (!response.ok)
    throw new Error(
      payload.reason ?? payload.error ?? `Change was not saved (HTTP ${response.status}).`,
    );
  return payload.data ?? payload;
}

export async function fetchEffectEvidence(
  recId: string,
  cursors: { cycle?: string | null; legacy?: string | null } = {},
): Promise<EffectEvidencePage> {
  const params = new URLSearchParams({ rec_id: recId, limit: "10" });
  if (cursors.cycle !== undefined && cursors.cycle !== null)
    params.set("cycle_cursor", cursors.cycle);
  if (cursors.legacy !== undefined && cursors.legacy !== null)
    params.set("legacy_cursor", cursors.legacy);
  const response = await fetch(`/api/esf/effects?${params.toString()}`, {
    signal: AbortSignal.timeout(8_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<EffectEvidencePage> & {
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "Could not load measurement history.",
    );
  }
  if (
    typeof payload.writer_enabled !== "boolean" ||
    !Array.isArray(payload.cycles) ||
    !Array.isArray(payload.legacy) ||
    (payload.next_cycle_cursor !== null && typeof payload.next_cycle_cursor !== "string") ||
    (payload.next_legacy_cursor !== null && typeof payload.next_legacy_cursor !== "string")
  ) {
    throw new Error("Measurement history response was malformed.");
  }
  return payload as EffectEvidencePage;
}

export function createEffectIdempotencyKey(recId: string, intent: string): string {
  return `${recId}:${intent}:${crypto.randomUUID()}`;
}

export async function trackEffect(recId: string, idempotencyKey: string): Promise<TrackResult> {
  return (await mutate("/api/esf/effects/track", {
    rec_id: recId,
    idempotency_key: idempotencyKey,
    completed_change: true,
  })) as TrackResult;
}

export async function stopEffect(cycleId: string, idempotencyKey: string): Promise<EffectCycle> {
  return (await mutate("/api/esf/effects/stop", {
    cycle_id: cycleId,
    idempotency_key: idempotencyKey,
  })) as EffectCycle;
}

export async function closeEffect(cycleId: string, idempotencyKey: string): Promise<EffectCycle> {
  return (await mutate("/api/esf/effects/close", {
    cycle_id: cycleId,
    idempotency_key: idempotencyKey,
  })) as EffectCycle;
}

export async function rollbackEffect(
  cycleId: string,
  idempotencyKey: string,
): Promise<RollbackOperation> {
  return (await mutate("/api/esf/effects/rollback", {
    cycle_id: cycleId,
    idempotency_key: idempotencyKey,
  })) as RollbackOperation;
}

export async function attestRollbackEffect(
  cycleId: string,
  idempotencyKey: string,
): Promise<RollbackOperation> {
  return (await mutate("/api/esf/effects/attest-rollback", {
    cycle_id: cycleId,
    idempotency_key: idempotencyKey,
    actual_time_known: false,
  })) as RollbackOperation;
}
